/**
 * ZIP 读写与导入校验的单测（M3 / F22 / A26）。
 *
 * 这一层的性质都是"不通过就必须整包拒绝"，所以断言几乎都是**拒绝类**：
 * 路径穿越、压缩炸弹、篡改、截断、不支持的方法、加密、ZIP64、超大。
 * 只有把它们都钉住，"导入包是安全的"才算有依据。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { writeZip, readZip, crc32, checkEntryName, normalizeEntryName, isExecutableName, ZipError } from '../src/core/zip.js';

const FIXED = new Date(2026, 0, 2, 3, 4, 6);

function bytes(buf, from, to) {
  const out = [];
  for (let i = from; i < to; i += 1) out.push(buf[i]);
  return out.join(',');
}

test('ZIP：写入再读出，文本与二进制内容逐字节一致', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5]);
  const buf = writeZip([
    { name: 'pack.json', data: JSON.stringify({ hello: '世界' }) },
    { name: 'works/a.html', data: '<html>' + 'x'.repeat(3000) + '</html>' },
    { name: 'shots/a.png', data: png },
  ], { mtime: FIXED });
  const back = readZip(buf);
  assert.deepEqual(back.entries.map((e) => e.name), ['pack.json', 'works/a.html', 'shots/a.png']);
  assert.equal(back.entries[0].data.toString('utf8'), JSON.stringify({ hello: '世界' }));
  assert.equal(back.entries[1].data.length, 3013);
  assert.deepEqual([...back.entries[2].data], [...png]);
  assert.equal(back.stats.count, 3);
});

test('ZIP：同样的输入两次写出完全相同的字节（导出可复核）', () => {
  const entries = [{ name: 'a.txt', data: '内容' }, { name: 'b/c.txt', data: '更多内容' }];
  assert.ok(writeZip(entries, { mtime: FIXED }).equals(writeZip(entries, { mtime: FIXED })));
});

test('ZIP：CRC32 用标准向量 123456789 -> cbf43926', () => {
  assert.equal(crc32(Buffer.from('123456789', 'utf8')).toString(16), 'cbf43926');
});

test('ZIP：拒绝路径穿越、绝对路径、盘符、保留名与超长名（写入侧）', () => {
  const bad = ['../evil.txt', 'a/../../b.txt', '/abs.txt', 'C:/win.txt', 'dir\\file.txt', 'CON.txt', 'x'.repeat(300) + '.txt'];
  for (const name of bad) {
    assert.throws(() => writeZip([{ name, data: 'x' }]), (err) => err instanceof ZipError && err.code === 'bad-name', name);
  }
  assert.equal(checkEntryName('works/a.html').ok, true);
  assert.equal(checkEntryName('shots/x.png').ok, true);
});

test('ZIP：反斜杠条目名归一化（Windows 压缩工具会这样写），归一后仍走同一套校验', () => {
  // 造一个"Windows 风格"的包：把名字里的 / 换成 \\（字节数相同，可原地替换）
  const buf = writeZip([{ name: 'sub/page.html', data: '<html>ok</html>' }, { name: 'hello.txt', data: 'hi' }], { mtime: FIXED });
  const patched = Buffer.from(buf);
  for (const [from, to] of [['sub/page.html', 'sub\\page.html']]) {
    const a = patched.indexOf(Buffer.from(from));
    patched.write(to, a, 'utf8');
    const b = patched.lastIndexOf(Buffer.from(from));
    if (b !== a && b > 0) patched.write(to, b, 'utf8');
  }
  const back = readZip(patched);
  assert.deepEqual(back.entries.map((e) => e.name), ['sub/page.html', 'hello.txt']);
  assert.equal(back.entries[0].data.toString('utf8'), '<html>ok</html>');
  // 但穿越写法仍然要被拒（归一之后再校验）
  // 注意：补丁必须**等长**替换，否则会盖掉后面的字节（第一次写这个测试就踩过：
  // 多写一个字节把 EOCD 签名的首字节盖掉，于是报的是"这不是一个 ZIP"，看起来像解析器坏了）。
  const evil = Buffer.from(writeZip([{ name: 'ab/evil.txt', data: 'x' }], { mtime: FIXED }));
  const at1 = evil.indexOf(Buffer.from('ab/evil.txt'));
  evil.write('..\\evil.txt', at1, 'utf8');
  const at2 = evil.lastIndexOf(Buffer.from('ab/evil.txt'));
  if (at2 > 0 && at2 !== at1) evil.write('..\\evil.txt', at2, 'utf8');
  assert.throws(() => readZip(evil), (err) => err instanceof ZipError && err.code === 'bad-name');
  assert.equal(normalizeEntryName('a\\b'), 'a/b');
});

test('ZIP：归一化后重名的包被拒绝（两个条目指向同一个文件）', () => {
  const buf = writeZip([{ name: 'a/b.txt', data: 'one' }, { name: 'a/c.txt', data: 'two' }], { mtime: FIXED });
  const patched = Buffer.from(buf);
  let at = patched.indexOf(Buffer.from('a/c.txt'));
  while (at > 0) { patched.write('a\\b.txt', at, 'utf8'); at = patched.indexOf(Buffer.from('a/c.txt'), at + 1); }
  assert.throws(() => readZip(patched), (err) => err instanceof ZipError && err.code === 'duplicate-name');
});

test('ZIP：压缩炸弹按压缩比拒绝，正常大文件不误判', async () => {
  const bomb = writeZip([{ name: 'bomb.txt', data: 'A'.repeat(4 * 1024 * 1024) }], { mtime: FIXED });
  assert.ok(bomb.length < 64 * 1024, '炸弹本身应该很小：' + bomb.length);
  assert.throws(() => readZip(bomb), (err) => err instanceof ZipError && err.code === 'zip-bomb');
  // 正常内容（高熵）不会被误判。用真随机而不是"看起来乱的算式"：
  // (i*37)%251 这种序列 deflate 能压到 248:1，会被正确地判成炸弹
  // （第一次写这个测试时我把"可压"当成了"正常"，断言方向写反了）。
  const { randomBytes } = await import('node:crypto');
  const normal = writeZip([{ name: 'ok.bin', data: randomBytes(2 * 1024 * 1024) }], { mtime: FIXED });
  assert.equal(readZip(normal).entries[0].data.length, 2 * 1024 * 1024);
});

test('ZIP：条目数与单条 / 总大小上限可配置，超限即拒绝', () => {
  const buf = writeZip([{ name: 'a.txt', data: 'x'.repeat(100) }, { name: 'b.txt', data: 'y'.repeat(100) }], { mtime: FIXED });
  assert.throws(() => readZip(buf, { limits: { maxEntries: 1 } }), (err) => err.code === 'too-many-entries');
  assert.throws(() => readZip(buf, { limits: { maxEntryBytes: 50 } }), (err) => err.code === 'entry-too-big');
  assert.throws(() => readZip(buf, { limits: { maxTotalBytes: 150 } }), (err) => err.code === 'total-too-big');
});

test('ZIP：内容被改过（CRC 对不上）就拒绝，不返回"可能坏了"的内容', () => {
  const buf = Buffer.from(writeZip([{ name: 'a.txt', data: 'hello world hello world' }], { level: 0, mtime: FIXED }));
  const at = buf.indexOf(Buffer.from('world'));
  buf[at] = 0x57;
  assert.throws(() => readZip(buf), (err) => err instanceof ZipError && err.code === 'crc-mismatch');
});

test('ZIP：截断与乱码都被拒绝', () => {
  const buf = writeZip([{ name: 'a.txt', data: 'x'.repeat(500) }], { mtime: FIXED });
  assert.throws(() => readZip(buf.subarray(0, buf.length - 10)), (err) => err.code === 'no-eocd');
  assert.throws(() => readZip(Buffer.from('这不是一个 zip 文件，只是普通文本内容而已。')), (err) => err.code === 'no-eocd');
});

test('ZIP：白名单之外的文件类型被拒绝（拒绝未知载荷）', () => {
  const buf = writeZip([{ name: 'pack.json', data: '{}' }, { name: 'evil.exe', data: 'MZ' }], { mtime: FIXED });
  assert.throws(() => readZip(buf), (err) => err.code === 'executable-payload');
  const buf2 = writeZip([{ name: 'pack.json', data: '{}' }, { name: 'index.html', data: '<html></html>' }], { mtime: FIXED });
  assert.throws(() => readZip(buf2, { allowExtensions: ['.json', '.txt'] }), (err) => err.code === 'unexpected-file');
  assert.equal(readZip(buf2).entries.length, 2, '不给白名单时只要能读就读（类型判断交给上层）');
  assert.equal(isExecutableName('a/b.PS1'), true);
  assert.equal(isExecutableName('a/b.json'), false);
});

test('ZIP：不支持的方法 / 加密 / ZIP64 / 多卷都被拒绝', () => {
  const base = writeZip([{ name: 'a.txt', data: 'hello' }], { mtime: FIXED });
  // 方法改成 12（bzip2）
  const m = Buffer.from(base);
  const centralAt = m.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  m.writeUInt16LE(12, centralAt + 10);
  assert.throws(() => readZip(m), (err) => err.code === 'unsupported-method');
  // 加密位
  const enc = Buffer.from(base);
  const encAt = enc.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  enc.writeUInt16LE(enc.readUInt16LE(encAt + 8) | 0x0001, encAt + 8);
  assert.throws(() => readZip(enc), (err) => err.code === 'encrypted');
  // ZIP64：EOCD 里写 0xffff 条目数
  const z64 = Buffer.from(base);
  const eocdAt = z64.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  z64.writeUInt16LE(0xffff, eocdAt + 10);
  assert.throws(() => readZip(z64), (err) => err.code === 'zip64');
  // 多卷：EOCD 的"起始磁盘号"非 0
  const multi = Buffer.from(base);
  const e2 = multi.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  multi.writeUInt16LE(1, e2 + 4);
  assert.throws(() => readZip(multi), (err) => err.code === 'multi-disk');
});

test('ZIP：目录条目被跳过，不还原空目录', () => {
  const withDir = Buffer.concat([
    writeZip([{ name: 'dir/', data: '' }], { mtime: FIXED }),
  ]);
  assert.equal(readZip(withDir).entries.length, 0, '只有目录条目时应读出 0 个文件');
});

test('ZIP：写入侧也拒绝不安全的名字（导出不会产出坏包）', () => {
  assert.throws(() => writeZip([{ name: '../x', data: 'y' }]), (err) => err.code === 'bad-name');
  assert.throws(() => writeZip([{ name: '', data: 'y' }]), (err) => err.code === 'bad-name');
});

test('ZIP：能读别的工具造的包（PowerShell Compress-Archive 造不出，但标准包必须能读）', () => {
  // 用 deflate 手工造一个"标准工具风格"的包：本地头 + 数据 + 中央目录 + EOCD
  const name = Buffer.from('hello.txt', 'utf8');
  const data = Buffer.from('from another tool', 'utf8');
  const deflated = deflateRawSync(data);
  const crc = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(deflated.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(deflated.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(name.length, 28);
  const centralBuf = Buffer.concat([central, name]);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(local.length + name.length + deflated.length, 16);
  const zip = Buffer.concat([local, name, deflated, centralBuf, eocd]);
  const back = readZip(zip);
  assert.equal(back.entries[0].name, 'hello.txt');
  assert.equal(back.entries[0].data.toString('utf8'), 'from another tool');
  void bytes;
});
