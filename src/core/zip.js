/**
 * 最小 ZIP 读写 —— 只做本插件真正需要的事，零依赖、零原生编译。
 *
 * 依据 PRD F20 / F21 / F22：展示包与复测包都是**版本化 ZIP**；导入时必须校验
 * 大小、路径、文件类型、hash 与 schema，并拒绝路径穿越与压缩炸弹。
 *
 * 为什么自己写而不是装一个库：
 *  - 本插件至今没有任何运行时依赖（node:sqlite / node:zlib 都是内置），不想为了"打个包"
 *    引入一棵依赖树；
 *  - **读**这一侧本来就必须自己写校验：任何库的 unzip 默认行为都是"照名字写到磁盘"，
 *    而这里恰恰不能那样用 —— 我们要的是"在内存里按白名单读出来"，写盘是调用方的事。
 *
 * 安全默认（读）：
 *  - 名字必须相对、不含 \\ 与 ..、不是绝对路径或盘符、不是 Windows 保留设备名；
 *  - 拒绝加密条目、拒绝 ZIP64（本插件产不出那么大的包）、拒绝多卷；
 *  - 条目数 / 单条大小 / 总大小 / 压缩比都有上限（压缩炸弹防护）；
 *  - 解压后逐个核对 CRC32 与长度，对不上就拒绝（不返回"可能坏了"的内容）。
 *
 * @module html-arena/core/zip
 */
import { deflateRawSync, inflateRawSync } from 'node:zlib';

/** 读包上限。数值是"人用手传一个作品的包"的量级，远超正常包、又远小于内存风险。 */
export const ZIP_LIMITS = Object.freeze({
  maxEntries: 2000,
  maxEntryBytes: 32 * 1024 * 1024,
  maxTotalBytes: 128 * 1024 * 1024,
  /** 单个条目压缩比上限（只对大于 ratioFloorBytes 的条目生效，避免小文件误判）。 */
  maxRatio: 200,
  ratioFloorBytes: 1024 * 1024,
  maxNameLength: 200,
});

/** ZIP 里明确不允许出现的可执行 / 脚本载荷（F22：拒绝未知可执行载荷）。 */
export const EXECUTABLE_EXTENSIONS = Object.freeze([
  '.exe', '.dll', '.com', '.scr', '.msi', '.bat', '.cmd', '.ps1', '.psm1', '.vbs', '.vbe',
  '.js', '.mjs', '.cjs', '.jar', '.sh', '.bash', '.py', '.rb', '.pl', '.php', '.lnk', '.reg', '.hta', '.wsf',
]);

/** 结构化错误：带机器可读的 code，接口层据此回 400 并给出人能读懂的原因。 */
export class ZipError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = 'ZipError';
    this.code = code;
    this.detail = detail ?? null;
  }
}

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;
/** UTF-8 名字标志位（0x0800）。 */
const FLAG_UTF8 = 0x0800;

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[i] = c;
  }
  return table;
})();

/** 标准 CRC-32（ZIP 用的那个）。 */
export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Date → DOS 时间/日期对。ZIP 的时间精度只有 2 秒，早于 1980 的一律按 1980 记。 */
function dosDateTime(date) {
  const d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date(0);
  const year = Math.max(1980, d.getFullYear());
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const day = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date: day };
}

/**
 * 把条目名归一成"以 / 分隔的相对路径"。
 *
 * 为什么要归一而不是直接拒绝反斜杠：Windows 自带的压缩（资源管理器"发送到 → 压缩文件夹"、
 * PowerShell 的 Compress-Archive）**确实会写出反斜杠分隔的条目名**。这不是攻击特征，
 * 而是历史习惯；直接拒绝会让"用户自己重新打一次包"完全不可用。
 * 归一是安全的：归一之后仍要走同一套校验（.. / 绝对路径 / 盘符 / 保留名一个不少）。
 */
export function normalizeEntryName(name) {
  return String(name).replace(/\\/g, '/');
}

/**
 * 校验一个条目名是否可以安全使用。**这是读包的第一道闸**，不通过就直接拒绝整包。
 * 读包路径请先过 normalizeEntryName（写包路径不需要，写的时候明确要求 / ）。
 * @param {string} name
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function checkEntryName(name) {
  if (typeof name !== 'string' || name.length === 0) return { ok: false, reason: '条目名为空' };
  if (name.length > ZIP_LIMITS.maxNameLength) return { ok: false, reason: '条目名过长（超过 ' + ZIP_LIMITS.maxNameLength + ' 字符）' };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(name)) return { ok: false, reason: '条目名含控制字符' };
  if (name.includes('\\')) return { ok: false, reason: '条目名含反斜杠（ZIP 规定用正斜杠）' };
  if (name.startsWith('/')) return { ok: false, reason: '条目名是绝对路径' };
  if (/^[A-Za-z]:/.test(name)) return { ok: false, reason: '条目名带盘符' };
  if (name.includes('://')) return { ok: false, reason: '条目名是 URL' };
  // 目录条目（以 / 结尾）是 ZIP 的合法形态：校验时把结尾那一个斜杠剥掉，
  // 但要确认它不是"靠结尾斜杠掩盖空段"（a// 、/ 这类仍然拒绝）。
  const core = name.endsWith('/') ? name.slice(0, -1) : name;
  if (core.length === 0) return { ok: false, reason: '条目名是空路径' };
  const parts = core.split('/');
  for (const p of parts) {
    if (p === '') return { ok: false, reason: '条目名含空路径段（连续斜杠）' };
    if (p === '..') return { ok: false, reason: '条目名含 .. （路径穿越）' };
    if (p === '.') return { ok: false, reason: '条目名含 . 路径段' };
    // Windows 语义（这一组是"解压到磁盘才危险"，但本插件也可能把包交给别的工具打开，
    // 所以在这里就挡住，别指望下游每个解压器都懂）：
    //  - 冒号 = NTFS 备用数据流（a.txt:ads 会写到另一个流里）
    //  - 结尾的点或空格会被 Windows 剥掉 → 与已有文件重名、覆盖
    //  - 保留设备名要**逐段**看：con/x.html 同样是保留名目录
    if (p.includes(':')) return { ok: false, reason: '条目名含冒号（Windows 上是备用数据流写法）' };
    if (/[. ]$/.test(p)) return { ok: false, reason: '路径段以点或空格结尾（Windows 上会被剥掉，导致重名覆盖）' };
    const stem = p.split('.')[0].toUpperCase();
    if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem)) {
      return { ok: false, reason: '条目名是 Windows 保留设备名（' + p + '）' };
    }
  }
  return { ok: true };
}

/**
 * 名字的"落盘等价形式"：Windows 会剥掉结尾的点与空格、并且不区分大小写；
 * macOS 的 HFS+/APFS 会把名字做 Unicode 归一化。两处都要能识别出"这其实是同一个文件"。
 */
export function nameCollisionKey(name) {
  return normalizeEntryName(name)
    .split('/')
    .map((p) => p.replace(/[. ]+$/, '').normalize('NFC').toLowerCase())
    .join('/');
}

/**
 * 断言一组条目只包含允许的扩展名 —— 读包与解析包**共用这一份**判断，
 * 不各写一遍（以前 zip.js 与 pack.js 各有一份，语义还不完全一样）。
 */
export function assertAllowedExtensions(entries, allowed, message) {
  for (const item of entries) {
    if (item.name === 'pack.json') continue;
    const lower = item.name.toLowerCase();
    if (!allowed.some((ext) => lower.endsWith(ext))) {
      throw new ZipError('unexpected-file', message + '（' + item.name + '）');
    }
  }
  return true;
}

/**
 * 扩展名是否属于明确拒绝的可执行 / 脚本载荷。
 * 先按 Windows 的落盘语义把结尾的点/空格剥掉再判断 —— 否则 "evil.js." 这种写法
 * 会绕过黑名单，落盘之后却仍然叫 evil.js（实测过）。
 */
export function isExecutableName(name) {
  const lower = String(name).toLowerCase().replace(/[. ]+$/, '');
  return EXECUTABLE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/**
 * 写一个 ZIP。
 *
 * @param {Array<{name: string, data: Buffer|string, mtime?: Date}>} entries
 * @param {{level?: number, mtime?: Date}} [options] level=0 表示只存储不压缩（测试用）
 * @returns {Buffer}
 */
export function writeZip(entries, options = {}) {
  const level = Number.isInteger(options.level) ? options.level : 6;
  const fallbackDate = options.mtime instanceof Date ? options.mtime : new Date();
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const name = String(entry.name);
    const check = checkEntryName(name);
    if (!check.ok) throw new ZipError('bad-name', '不能写入这个条目名：' + name + '（' + check.reason + '）');
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data ?? ''), 'utf8');
    const crc = crc32(data);
    const deflated = level === 0 ? null : deflateRawSync(data, { level });
    // 压不小就别压：小文件（尤其是已经压过的 PNG）反而会变大
    const useDeflate = deflated !== null && deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const method = useDeflate ? METHOD_DEFLATE : METHOD_STORE;
    const { time, date } = dosDateTime(entry.mtime instanceof Date ? entry.mtime : fallbackDate);
    const nameBuf = Buffer.from(name, 'utf8');

    const local = Buffer.alloc(30);
    local.writeUInt32LE(SIG_LOCAL, 0);
    local.writeUInt16LE(20, 4);            // version needed
    local.writeUInt16LE(FLAG_UTF8, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    const header = Buffer.concat([local, nameBuf]);
    chunks.push(header, body);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(SIG_CENTRAL, 0);
    cd.writeUInt16LE(20, 4);               // version made by
    cd.writeUInt16LE(20, 6);               // version needed
    cd.writeUInt16LE(FLAG_UTF8, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(time, 12);
    cd.writeUInt16LE(date, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);               // extra
    cd.writeUInt16LE(0, 32);               // comment
    cd.writeUInt16LE(0, 34);               // disk
    cd.writeUInt16LE(0, 36);               // internal attrs
    cd.writeUInt32LE(0, 38);               // external attrs
    cd.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([cd, nameBuf]));
    offset += header.length + body.length;
  }

  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...chunks, centralBuf, eocd]);
}

/** 从尾部找 EOCD。ZIP 注释最长 65535，所以扫描窗口就那么大。 */
function findEocd(buf) {
  const min = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= min; i -= 1) {
    if (buf.readUInt32LE(i) === SIG_EOCD) return i;
  }
  return -1;
}

/**
 * 读一个 ZIP（**只在内存里**解出来，不写任何文件）。
 *
 * 任一条目不合规就拒绝整包 —— 不做"跳过坏条目继续读"的宽容处理：
 * 导入侧要的是"要么完整可信、要么明确拒绝"。
 *
 * @param {Buffer} buffer
 * @param {{limits?: object, allowExtensions?: string[]|null}} [options]
 *   allowExtensions 给出时按白名单过滤（例如复测包只允许 .json/.txt/.md）
 * @returns {{entries: Array<{name: string, data: Buffer, size: number, method: number, crc: number}>,
 *            stats: {count: number, totalBytes: number, compressedBytes: number, ratio: number}}}
 */
export function readZip(buffer, options = {}) {
  const limits = { ...ZIP_LIMITS, ...(options.limits ?? {}) };
  if (!Buffer.isBuffer(buffer)) throw new ZipError('not-a-buffer', '输入不是二进制内容');
  if (buffer.length < 22) throw new ZipError('too-small', '这不是一个 ZIP（内容太短）');
  const eocdAt = findEocd(buffer);
  if (eocdAt < 0) throw new ZipError('no-eocd', '这不是一个 ZIP（找不到中央目录结尾记录）');

  const count = buffer.readUInt16LE(eocdAt + 10);
  const cdSize = buffer.readUInt32LE(eocdAt + 12);
  const cdOffset = buffer.readUInt32LE(eocdAt + 16);
  const diskEntries = buffer.readUInt16LE(eocdAt + 8);
  const diskNum = buffer.readUInt16LE(eocdAt + 4);
  const cdDisk = buffer.readUInt16LE(eocdAt + 6);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new ZipError('zip64', '这个包用了 ZIP64 格式，本插件不支持（正常导出不会产生这种包）');
  }
  if (diskNum !== 0 || cdDisk !== 0 || diskEntries !== count) {
    throw new ZipError('multi-disk', '这个包是多卷压缩包，本插件不支持');
  }
  if (count > limits.maxEntries) {
    throw new ZipError('too-many-entries', '包里的条目太多（' + count + ' > ' + limits.maxEntries + '），拒绝导入');
  }
  if (cdOffset + cdSize > buffer.length) throw new ZipError('bad-central', '中央目录越界，包已损坏或被改过');

  const entries = [];
  const seen = new Set();
  const ranges = [];
  let totalBytes = 0;
  let compressedBytes = 0;
  let at = cdOffset;
  for (let i = 0; i < count; i += 1) {
    // 中央目录游标必须始终落在自己声明的 [cdOffset, cdOffset+cdSize) 里。
    // 只判"没超出文件末尾"是不够的：那样条目可以读到声明范围之外（实测能构造出来）。
    if (at + 46 > cdOffset + cdSize) throw new ZipError('bad-central', '中央目录条目越出它自己声明的范围');
    if (at + 46 > buffer.length) throw new ZipError('bad-central', '中央目录条目越界');
    if (buffer.readUInt32LE(at) !== SIG_CENTRAL) throw new ZipError('bad-central', '中央目录条目签名不对');
    const flags = buffer.readUInt16LE(at + 8);
    const method = buffer.readUInt16LE(at + 10);
    const crc = buffer.readUInt32LE(at + 16);
    const csize = buffer.readUInt32LE(at + 20);
    const usize = buffer.readUInt32LE(at + 24);
    const nameLen = buffer.readUInt16LE(at + 28);
    const extraLen = buffer.readUInt16LE(at + 30);
    const commentLen = buffer.readUInt16LE(at + 32);
    const startDisk = buffer.readUInt16LE(at + 34);
    const localOffset = buffer.readUInt32LE(at + 42);
    if (localOffset === 0xffffffff || csize === 0xffffffff || usize === 0xffffffff) {
      throw new ZipError('zip64', '这个包里第 ' + (i + 1) + ' 个条目用了 ZIP64 尺寸，本插件不支持');
    }
    if (startDisk !== 0) throw new ZipError('multi-disk', '这个包是多卷压缩包，本插件不支持');
    if (flags & 0x0001) throw new ZipError('encrypted', '这个包是加密的，本插件不能导入加密包');
    if (method !== METHOD_STORE && method !== METHOD_DEFLATE) {
      throw new ZipError('unsupported-method', '第 ' + (i + 1) + ' 个条目用了不支持的压缩方式（method=' + method + '）');
    }
    const name = normalizeEntryName(buffer.subarray(at + 46, at + 46 + nameLen).toString('utf8'));
    at += 46 + nameLen + extraLen + commentLen;

    // 重名判定按"落盘等价形式"：Windows 不区分大小写、会剥结尾点空格，macOS 会做 Unicode 归一化。
    // 都比一遍，否则同一个文件可以用 A.json / a.json / é(NFC) / é(NFD) 塞两次。
    const collisionKey = nameCollisionKey(name);
    if (seen.has(collisionKey)) throw new ZipError('duplicate-name', '拒绝导入：包里有重名条目（' + name + '，与已有条目在落盘后是同一个文件）');
    seen.add(collisionKey);
    const nameCheck = checkEntryName(name);
    if (!nameCheck.ok) throw new ZipError('bad-name', '拒绝导入：条目名不安全（' + name + '：' + nameCheck.reason + '）');
    if (name.endsWith('/')) continue;            // 目录条目：跳过（本插件不还原空目录）
    if (Array.isArray(options.allowExtensions) && options.allowExtensions.length > 0) {
      const lower = name.toLowerCase();
      if (!options.allowExtensions.some((ext) => lower.endsWith(ext))) {
        throw new ZipError('unexpected-file', '拒绝导入：包里出现了不该有的文件类型（' + name + '）');
      }
    } else if (isExecutableName(name)) {
      throw new ZipError('executable-payload', '拒绝导入：包里含可执行 / 脚本载荷（' + name + '）');
    }
    if (usize > limits.maxEntryBytes) {
      throw new ZipError('entry-too-big', '条目「' + name + '」解压后 ' + Math.round(usize / 1024 / 1024) + 'MB，超过单条上限');
    }
    if (usize > limits.ratioFloorBytes && csize > 0 && usize / csize > limits.maxRatio) {
      throw new ZipError('zip-bomb', '条目「' + name + '」压缩比异常（' + Math.round(usize / csize) + ':1），按压缩炸弹拒绝');
    }
    totalBytes += usize;
    compressedBytes += csize;
    if (totalBytes > limits.maxTotalBytes) {
      throw new ZipError('total-too-big', '解压后总大小超过上限 ' + Math.round(limits.maxTotalBytes / 1024 / 1024) + 'MB，拒绝导入');
    }
    if (localOffset + 30 > buffer.length) throw new ZipError('bad-local', '条目「' + name + '」的本地头越界');
    if (buffer.readUInt32LE(localOffset) !== SIG_LOCAL) throw new ZipError('bad-local', '条目「' + name + '」的本地头签名不对');
    const localNameLen = buffer.readUInt16LE(localOffset + 26);
    const localExtraLen = buffer.readUInt16LE(localOffset + 28);
    // 本地头里的名字必须与中央目录一致。只校验中央目录的话，本插件看到的文件
    // （works/xxx.html）与"按本地头解压的工具"看到的文件（可能是 ../../evil.txt）
    // 可以是两个不同的名字 —— 这种"差分解析"是真实的绕过手法（实测构造成功过）。
    const localName = normalizeEntryName(buffer.subarray(localOffset + 30, localOffset + 30 + localNameLen).toString('utf8'));
    if (localName !== name) {
      throw new ZipError('name-mismatch', '拒绝导入：条目「' + name + '」的本地头名字与中央目录不一致（本地头写的是「' + localName + '」）');
    }
    const dataAt = localOffset + 30 + localNameLen + localExtraLen;
    if (dataAt + csize > buffer.length) throw new ZipError('bad-local', '条目「' + name + '」的数据越界');
    if (dataAt + csize > cdOffset) throw new ZipError('bad-local', '条目「' + name + '」的数据压在中央目录上');
    // 条目区间不许互相重叠：重叠意味着两个条目指向同一段字节（实测能构造出来），
    // 那样"包里有几个文件"就说不清了。
    for (const r of ranges) {
      if (localOffset < r.end && dataAt + csize > r.start) {
        throw new ZipError('overlapping-entries', '拒绝导入：条目「' + name + '」与「' + r.name + '」的数据区间重叠');
      }
    }
    ranges.push({ name, start: localOffset, end: dataAt + csize });
    const raw = buffer.subarray(dataAt, dataAt + csize);

    let data;
    try {
      // maxOutputLength 是**真正的**炸弹防护：上面三条闸门读的都是"声明的"大小，
      // 而声明是可以撒谎的（实测：声明 1KB、实际解出 128MB，三条闸门全被绕过）。
      // 这里按"声明的长度 + 一点余量"硬性封顶，超了就当成 size-mismatch 拒掉。
      data = method === METHOD_STORE
        ? Buffer.from(raw)
        : inflateRawSync(raw, { maxOutputLength: usize + 1024 });
    } catch (err) {
      if (err && err.code === 'ERR_BUFFER_TOO_LARGE') {
        throw new ZipError('size-mismatch', '条目「' + name + '」实际内容超过它声明的大小（声明 ' + usize + ' 字节），按坏包拒绝');
      }
      throw new ZipError('inflate-failed', '条目「' + name + '」解压失败：' + String(err && err.message || err));
    }
    if (data.length !== usize) {
      throw new ZipError('size-mismatch', '条目「' + name + '」解压后长度与声明不符（' + data.length + ' != ' + usize + '）');
    }
    if (crc32(data) !== crc) {
      throw new ZipError('crc-mismatch', '条目「' + name + '」校验和不符，包已损坏或被改过');
    }
    entries.push({ name, data, size: usize, method, crc });
  }

  return {
    entries,
    stats: {
      count: entries.length,
      totalBytes,
      compressedBytes,
      ratio: compressedBytes > 0 ? Number((totalBytes / compressedBytes).toFixed(2)) : null,
    },
  };
}
