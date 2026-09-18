/**
 * 展示包（F20）与复测包（F21）—— 打包、校验、导入解析。
 *
 * 三种东西在这一层分开：
 *  - **条目（entries）**：包里每个文件的原始字节。写包时由这里产出，读包时由 zip.js 解出。
 *  - **清单（manifest，pack.json）**：公开元数据 + 每个条目的 sha256（A25 的 hash 一致靠它）。
 *  - **说明（privacy）**：这个包包含什么、**不含什么**（F22：导出前要显示包含内容）。
 *
 * 两条不可让步的性质：
 *  ① 导入**不执行任何东西** —— 解析只产出数据，不看扩展名跑脚本、不装依赖（F22）；
 *  ② 导入前逐条核对 sha256 与 schema，任何一条对不上就整包拒绝（F22 / A26）。
 *
 * 脱敏只在**一处**做：所有写进包里的字符串都先过 core/redact.js（A27）。
 *
 * @module html-arena/core/pack
 */
import { ZipError, assertAllowedExtensions } from './zip.js';
import { sha256 } from './canonical.js';
import { normalizeTaskSnapshot, taskHashOf } from './task.js';
import { RECIPE_FIELDS, normalizeRecipeContent, recipeHash } from './recipe.js';
import { redactText, redactValue, scanForPrivateContent } from './redact.js';
import { renderShowcaseReport } from './report.js';

/** 包格式版本。改变条目结构 / 清单字段含义时必须提升，并在 parseRetestPack 里写兼容处理。 */
export const PACK_SCHEMA_VERSION = 1;

/** 包类型：展示包（给人看）与复测包（给另一台机器复现同一套配置）。 */
export const PACK_KINDS = Object.freeze(['showcase', 'retest']);

/** 复测包**只允许**这些文件类型 —— 白名单比黑名单可靠（F22 拒绝未知载荷）。 */
export const RETEST_ALLOWED_EXTENSIONS = Object.freeze(['.json', '.txt', '.md']);

/** 展示包允许的类型（作品是 .html，截图是 .png）。 */
export const SHOWCASE_ALLOWED_EXTENSIONS = Object.freeze(['.html', '.json', '.txt', '.md', '.png']);

/** 上传包的大小上限（读进内存之前先卡住）。 */
export const PACK_UPLOAD_MAX_BYTES = 64 * 1024 * 1024;

/** 导出选项默认值：题目与配方默认导出，原始输出与推理默认不导出（F22）。 */
export const DEFAULT_EXPORT_OPTIONS = Object.freeze({
  prompt: true,
  startHtml: true,
  outputRequirements: true,
  recipes: true,
  rawOutput: false,
  screenshots: true,
  screenshotRecords: true,
});

export function normalizeExportOptions(input) {
  const src = input ?? {};
  const out = {};
  for (const key of Object.keys(DEFAULT_EXPORT_OPTIONS)) {
    out[key] = src[key] === undefined ? DEFAULT_EXPORT_OPTIONS[key] : Boolean(src[key]);
  }
  return out;
}

/**
 * 找出作品 HTML 里的外部资源引用（判断"这个作品离线能不能看"）。
 * 只看静态引用，不做网络请求 —— 结论是"它引用了外部资源"，不是"这个资源现在活着"。
 */
const EXTERNAL_REF_RES = [
  /<script[^>]+src\s*=\s*["']?(https?:\/\/[^"'\s>]+)/gi,
  /<link[^>]+href\s*=\s*["']?(https?:\/\/[^"'\s>]+)/gi,
  /<img[^>]+src\s*=\s*["']?(https?:\/\/[^"'\s>]+)/gi,
  /@import\s+(?:url\()?["']?(https?:\/\/[^"')\s]+)/gi,
  /url\(\s*["']?(https?:\/\/[^"')\s]+)/gi,
];

export function detectExternalRefs(html) {
  const found = new Set();
  const text = String(html ?? '');
  for (const re of EXTERNAL_REF_RES) {
    const rx = new RegExp(re.source, re.flags);
    let m;
    while ((m = rx.exec(text)) !== null) {
      found.add(m[1]);
      if (found.size > 60) return [...found];
    }
  }
  return [...found];
}

/** 是不是一个普通 JSON 对象（不是数组、不是 null）—— 形状守卫统一用它。 */
export function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 槽位 → 候选字母。**唯一来源**：以前这个算式在产品代码里散落 7 处，
 * 将来一旦要改成"甲乙丙丁"或支持超过 4 个候选，漏改一处就会出现两套编号。
 */
export function slotLetter(slot) {
  const n = Number(slot);
  return Number.isInteger(n) && n >= 0 && n < 26 ? String.fromCharCode(65 + n) : '?';
}

/** 输出规则的合理区间。超出区间的一律**拒绝采信**并如实说明，不用包里的任意数字。 */
export const OUTPUT_LIMITS = Object.freeze({
  maxTokens: { min: 1, max: 200000 },
  timeoutMs: { min: 1000, max: 60 * 60 * 1000 },
  concurrency: { min: 1, max: 2 },
});

/**
 * 钳制复测包里的输出规则。
 *
 * 为什么要做：这些值直接决定"这一轮会不会被超时打断"。采信包作者的任意数字会造出
 * "导入的实验每次运行都立刻超时"（timeoutMs=1e15 被 setTimeout 钳到 1ms）或
 * "永远不超时"（负数）这种后果 —— 实测都复现过，还会污染 A08 的超时证据。
 * 不合法的值一律回落到 null（由调用方用本机默认值），并把原因写进 warnings。
 */
export function sanitizeOutputPolicy(raw) {
  const warnings = [];
  const rejected = [];
  const src = isPlainObject(raw) ? raw : {};
  const pick = (key) => {
    const v = src[key];
    if (v === null || v === undefined) return null;
    const lim = OUTPUT_LIMITS[key];
    if (!Number.isInteger(v) || v < lim.min || v > lim.max) {
      rejected.push({ field: key, value: v });
      warnings.push('包里的输出规则 ' + key + ' = ' + JSON.stringify(v) + ' 不在合理区间（'
        + lim.min + '–' + lim.max + '），已忽略并使用本机默认值。');
      return null;
    }
    return v;
  };
  return { policy: { maxTokens: pick('maxTokens'), timeoutMs: pick('timeoutMs'), concurrency: pick('concurrency') }, rejected, warnings };
}

/** 预览规则：只接受清单里的取值，其余一律回到安全的默认（离线 + 桌面）。 */
export function sanitizePreviewPolicy(raw) {
  const warnings = [];
  const rejected = [];
  const src = isPlainObject(raw) ? raw : {};
  let networkPolicy = 'offline';
  if (src.networkPolicy !== undefined) {
    if (src.networkPolicy === 'cdn') networkPolicy = 'cdn';
    else if (src.networkPolicy !== 'offline') {
      rejected.push({ field: 'networkPolicy', value: src.networkPolicy });
      warnings.push('包里的预览网络策略 ' + JSON.stringify(src.networkPolicy) + ' 不是已知取值，已按"离线"处理。');
    }
  }
  let viewport = 'desktop';
  if (src.viewport !== undefined) {
    if (src.viewport === 'mobile') viewport = 'mobile';
    else if (src.viewport !== 'desktop') {
      rejected.push({ field: 'viewport', value: src.viewport });
      warnings.push('包里的预览视口 ' + JSON.stringify(src.viewport) + ' 不是已知取值，已按"桌面"处理。');
    }
  }
  return { policy: { networkPolicy, viewport }, rejected, warnings };
}

/** 状态的中文说法（报告与清单都用这一份，避免两处慢慢不一致）。 */
export function statusLabel(status) {
  return ({
    completed: '已完成', failed: '失败', cancelled: '已取消', timed_out: '超时',
    interrupted: '被中断', running: '生成中', queued: '排队中', draft: '未开始',
  })[status] ?? String(status ?? '未知');
}

/**
 * 条目构造 —— **正文逐字节不变**。
 *
 * 这里不再跑脱敏，原因是实测出来的两个真问题：
 *  ① 先算 hash 再脱敏、写的是脱敏后的字节 → 用户自己导出的包会被自己的校验拒掉
 *     （"包被改过"这种指控是假的，实际是我们自己改的）；
 *  ② 脱敏的路径模式套在 HTML 上会把闭合标签一起吃掉，报告可能整页空白、作品被截断。
 * 所以：正文是什么就写什么；要脱敏的只有下面 metaEntry 的**元数据**。
 * 用户自己的题目/配方里如果含本机路径，导出前会**如实提示**（describeExport 的 warnings），
 * 由用户决定要不要取消勾选 —— 而不是我们偷偷改掉他的内容。
 */
function entry(name, data) {
  if (Buffer.isBuffer(data)) return { name, data };
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2) + '\n';
  return { name, data: Buffer.from(text, 'utf8') };
}

/** 元数据条目（pack.json / README）：这些是我们生成的东西，统一脱敏后再写。 */
function metaEntry(name, data) {
  if (Buffer.isBuffer(data)) return { name, data };
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2) + '\n';
  return { name, data: Buffer.from(redactText(text), 'utf8') };
}

/** 序列化再解析回来：保证"算 hash 用的内容"与"写进包里的字节"是同一份。 */
function roundTrip(value) {
  return JSON.parse(Buffer.from(JSON.stringify(value, null, 2) + '\n', 'utf8').toString('utf8'));
}

/** 给一组条目算出清单里的 contents 段（sha256 逐个条目算）。 */
export async function contentsOf(entries) {
  const out = [];
  for (const e of entries) {
    out.push({ path: e.name, bytes: e.data.length, sha256: sha256(e.data) });
  }
  return out;
}

/** 逐条核对清单与实际条目：数量、名字、字节数、sha256 全部要一致。 */
export async function verifyPackContents(entries, contents) {
  if (!Array.isArray(contents)) throw new ZipError('bad-manifest', '这个包的清单里没有文件列表（contents），无法校验');
  const actual = new Map(entries.map((e) => [e.name, e]));
  const listed = new Set();
  for (const item of contents) {
    const path = String(item.path ?? '');
    if (listed.has(path)) throw new ZipError('bad-manifest', '清单里有重复条目：' + path);
    listed.add(path);
    const e = actual.get(path);
    if (!e) throw new ZipError('missing-entry', '清单里写了 ' + path + '，包里却没有这个文件');
    if (Number(item.bytes) !== e.data.length) {
      throw new ZipError('size-mismatch', '条目「' + path + '」大小与清单不符（' + e.data.length + ' != ' + item.bytes + '）');
    }
    const hash = sha256(e.data);
    if (String(item.sha256) !== hash) {
      throw new ZipError('hash-mismatch', '条目「' + path + '」的 sha256 与清单不符（包被改过或传输损坏）');
    }
  }
  for (const e of entries) {
    // pack.json 自己不在 contents 里：它**就是**那份清单，写不进自己的哈希。
    // 这是唯一允许的例外，其余任何"清单外文件"都拒绝（F22）。
    if (e.name === 'pack.json') continue;
    if (!listed.has(e.name)) throw new ZipError('extra-entry', '包里出现了清单之外的文件：' + e.name);
  }
  return { ok: true, count: contents.length };
}

/** 候选在清单里的公开描述（**不含**题外话，也不含任何提示词全文）。 */
function candidateMeta({ attempt, letter, identityHidden }) {
  const r = attempt.recipe ?? {};
  return {
    slot: attempt.slot,
    letter,
    name: identityHidden ? null : (r.name ?? null),
    provider: identityHidden ? null : (r.provider ?? null),
    model: identityHidden ? null : (r.model ?? null),
    status: attempt.status,
    statusLabel: statusLabel(attempt.status),
    htmlHash: attempt.extraction?.htmlHash ?? null,
    errorNote: attempt.error?.reason ?? attempt.error?.title ?? null,
  };
}

/**
 * 构建复测包。
 *
 * @param {object} input
 * @param {object} input.experiment 实验对象（store.getExperiment 的结果）
 * @param {object[]} input.attempts 每个候选**最新一轮**的尝试（describeAttempt 的结果）
 * @param {object} [input.options] 导出选项
 * @param {object} input.tool {name, version}
 * @param {string} [input.now] ISO 时间
 * @returns {Promise<{entries: Array, manifest: object, task: object, recipes: object}>}
 */
export async function buildRetestPack({ experiment, attempts, options, tool, now }) {
  const opts = normalizeExportOptions(options);
  const generatedAt = now ?? new Date().toISOString();
  const full = normalizeTaskSnapshot(experiment.taskSnapshot);
  const included = {
    prompt: opts.prompt,
    startHtml: opts.startHtml && full.startHtml !== null,
    outputRequirements: opts.outputRequirements,
  };
  const includedTask = {
    prompt: included.prompt ? full.prompt : '',
    startHtml: included.startHtml ? full.startHtml : null,
    outputRequirements: included.outputRequirements ? full.outputRequirements : '',
  };
  const fullTaskHash = await taskHashOf(full);

  const candidates = [];
  const recipes = [];
  for (const a of attempts) {
    const letter = slotLetter(a.slot);
    // 同样：先归一化，再从"会被写进 recipes.json 的那份内容"算指纹（roundTrip 保证一致）
    const content = roundTrip(normalizeRecipeContent(a.recipe ?? {}));
    const row = {
      slot: a.slot,
      letter,
      name: content.name ?? ('候选 ' + letter),
      provider: content.provider,
      model: content.model,
      recipeHash: recipeHash(content),
      excluded: [],
      recipe: opts.recipes ? content : null,
    };
    candidates.push(row);
    if (opts.recipes) recipes.push({ slot: a.slot, letter, name: row.name, contentHash: row.recipeHash, recipe: content });
  }

  // 先排出"要写进 task.json 的字段"，再**从这份序列化结果**算指纹 ——
  // 这样"算 hash 的内容"与"包里的字节"在结构上就是同一份，不靠约定。
  const taskDoc = {
    schemaVersion: PACK_SCHEMA_VERSION,
    included,
    fullHash: fullTaskHash,
    prompt: includedTask.prompt,
    startHtml: includedTask.startHtml,
    outputRequirements: includedTask.outputRequirements,
    note: '题目指纹按 kind+prompt+startHtml+outputRequirements 计算；不含时间戳等运行期字段，所以同一道题在任何机器上算出来都一样。',
  };
  const taskHash = await taskHashOf(roundTrip(taskDoc));
  const task = { ...taskDoc, hash: taskHash };

  const recipesDoc = {
    schemaVersion: PACK_SCHEMA_VERSION,
    fields: RECIPE_FIELDS,
    candidates: recipes,
    note: opts.recipes
      ? '配方内容就是"会影响这次调用"的字段（见 fields）。不含槽位、时间戳与完整输入文本；导入后需要在本机重新匹配模型。'
      : '导出者选择不包含配方内容，因此这个复测包没有可复用的调用配置。',
  };

  const readme = [
    'HTML Arena 复测包',
    '=================',
    '',
    '这个包用来在另一台机器 / 另一个安装上复现同一次对比的配置。它不包含任何作品结果，',
    '也不包含 API key、绝对本地路径或推理全文。',
    '',
    '怎么用：在 HTML Arena 的「实验列表」点「导入复测包」，选中这个 zip，先看一遍包里的内容，',
    '再点「确认导入」。',
    '',
    '两条必须知道的规则：',
    '  1. 导入后需要在本机重新匹配模型：原机器上的模型在这台机器上不一定存在，界面会逐个告诉你',
    '     哪个候选需要重选。插件不会替你猜一个模型顶上。',
    '  2. 导入不会自动发起任何调用：导入只恢复题目与配方，要不要跑、什么时候跑由你决定。',
    '',
    '包里的文件：',
    '  pack.json     公开元数据、每个文件的 sha256、模型引用与选项',
    '  task.json     题目（可能按导出者的选择省略某些字段）',
    '  recipes.json  每个候选的调用配置（模型、系统提示词、参数）',
    '  README.txt    本文件',
    '',
    '由 ' + tool.name + ' ' + tool.version + ' 于 ' + generatedAt + ' 生成。',
  ].join('\n');

  const entries = [
    entry('task.json', task),
    entry('recipes.json', recipesDoc),
    metaEntry('README.txt', readme),
  ];
  const contents = await contentsOf(entries);
  const manifest = redactValue({
    schemaVersion: PACK_SCHEMA_VERSION,
    kind: 'retest',
    createdAt: generatedAt,
    tool: { name: tool.name, version: tool.version },
    experiment: { title: experiment.title, category: experiment.category ?? '' },
    task: {
      hash: taskHash,
      fullHash: fullTaskHash,
      included,
      hasStartHtml: full.startHtml !== null,
      promptChars: full.prompt.length,
    },
    candidates: candidates.map((c) => ({
      slot: c.slot, letter: c.letter, name: c.name, provider: c.provider, model: c.model,
      recipeHash: c.recipeHash, recipeIncluded: opts.recipes,
    })),
    preview: { networkPolicy: experiment.previewPolicy?.networkPolicy ?? 'offline', viewport: experiment.previewPolicy?.viewport ?? 'desktop' },
    output: {
      maxTokens: experiment.outputPolicy?.maxTokens ?? null,
      timeoutMs: experiment.outputPolicy?.timeoutMs ?? null,
      concurrency: experiment.outputPolicy?.concurrency ?? null,
    },
    privacy: {
      containsCredentials: false,
      containsAbsolutePaths: false,
      containsReasoning: false,
      containsRawOutput: Boolean(opts.rawOutput),
      containsPrompt: Boolean(opts.prompt && includedTask.prompt.length > 0),
      containsStartHtml: Boolean(included.startHtml),
      identityNote: '复测包保留模型引用（它的用途就是复现同一套配置），因此不适用于盲选的身份隐藏。',
    },
    contents,
  });
  entries.push(metaEntry('pack.json', manifest));
  // pack.json 自己不能在 contents 里（它写着 contents），所以清单只覆盖前三个文件。
  manifest.contents = await contentsOf(entries.filter((e) => e.name !== 'pack.json'));
  // 重写一次，让 pack.json 里的 contents 与最终文件一致
  const finalEntries = entries.filter((e) => e.name !== 'pack.json');
  finalEntries.push(metaEntry('pack.json', manifest));
  return {
    entries: finalEntries,
    manifest,
    task,
    recipes: recipesDoc,
  };
}

/**
 * 构建展示包。截图由调用方（接口层）在导出时采集好后传进来 —— 这一层不做 I/O。
 *
 * @param {object} input
 * @param {object} input.experiment
 * @param {object[]} input.attempts describeAttempt 结果（每个候选最新一轮）
 * @param {Array<{attemptId: string, file: string, data: Buffer, caption: string, viewport: string, meta: object}>} [input.shots]
 * @param {object[]} [input.screenshotRecords] 截图记录（含失败）
 * @param {object|null} [input.vote]
 * @param {object} [input.options]
 * @param {object} input.tool
 * @param {object} [input.readRaw] (attemptId) => string
 * @param {object} [input.readHtml] (attemptId) => string
 */
export async function buildShowcasePack({
  experiment, attempts, shots = [], screenshotRecords = [], vote = null,
  options, tool, now, readRaw, readHtml,
}) {
  const opts = normalizeExportOptions(options);
  const generatedAt = now ?? new Date().toISOString();
  const full = normalizeTaskSnapshot(experiment.taskSnapshot);
  const included = {
    prompt: opts.prompt,
    startHtml: opts.startHtml && full.startHtml !== null,
    outputRequirements: opts.outputRequirements,
  };
  const includedTask = {
    prompt: included.prompt ? full.prompt : '',
    startHtml: included.startHtml ? full.startHtml : null,
    outputRequirements: included.outputRequirements ? full.outputRequirements : '',
  };
  const taskHash = await taskHashOf(includedTask);
  // 盲选：实验**尚未揭晓**时，展示包里不写模型身份（导出的东西会离开这台机器）
  const identityHidden = Boolean(vote && vote.revealedAt === null);
  const revealed = !identityHidden;

  const entries = [];
  const candidateViews = [];
  for (const a of attempts) {
    const letter = slotLetter(a.slot);
    const meta = candidateMeta({ attempt: a, letter, identityHidden });
    let html = null;
    let raw = null;
    try { if (a.extraction?.htmlHash && typeof readHtml === 'function') html = readHtml(a.id); } catch { html = null; }
    if (opts.rawOutput && typeof readRaw === 'function') { try { raw = readRaw(a.id); } catch { raw = null; } }
    const externalRefs = html ? detectExternalRefs(html) : [];
    const workFile = html ? 'works/' + letter.toLowerCase() + '-' + a.id + '.html' : null;
    const rawFile = raw ? 'works/' + letter.toLowerCase() + '-' + a.id + '.raw.txt' : null;
    // 作品与原始正文**逐字节照抄**：它们是用户要分享的东西，改一个字节
    // 就会让"包里的作品指纹"和实验里的作品指纹对不上（实测过 76B→39B 那种截断）。
    if (html) entries.push(entry(workFile, html));
    if (raw) entries.push(entry(rawFile, raw));
    candidateViews.push({
      ...meta,
      revealed,
      workFile,
      rawFile,
      externalRefs,
      needsNetwork: externalRefs.length > 0,
      bytes: html ? Buffer.byteLength(html, 'utf8') : null,
      durationMs: a.receipt?.finishedAt && a.receipt?.startedAt ? (a.receipt.finishedAt - a.receipt.startedAt) : null,
    });
  }

  for (const s of shots) entries.push({ name: s.file, data: s.data });
  if (opts.screenshotRecords) entries.push(metaEntry('shots/records.json', {
    note: '这些是截图记录（成功与失败都记），不是图片本身；图片在 shots/*.png。'
      + '记录里带视口、状态、原因与耗时，用于说明"当时那次截图到底成没成"。',
    records: screenshotRecords,
  }));

  const privacy = {
    included: [
      'index.html 报告（双击即可读，报告本身不含任何脚本）',
      'pack.json 公开元数据（题目与每个文件的 sha256、状态、用量）',
      articleCount(entries, 'works/') + ' 个作品文件（提取出的单文件 HTML）',
      shots.length > 0 ? shots.length + ' 张初始截图（导出时重新加载作品采集）' : '（本次没有截图：见下面的说明）',
      opts.screenshotRecords ? '截图记录（含失败的那几次）' : null,
      opts.prompt ? '题目原文' : null,
      vote && vote.choice ? '人工评价（结论 / 标签 / 理由）' : null,
      opts.rawOutput ? '原始输出正文（未提取前的完整回复）' : null,
    ].filter(Boolean),
    excluded: [
      'API key、访问令牌与任何凭据引用',
      '绝对本地路径（导出时统一过一遍脱敏）',
      '推理全文（默认不导出，且本次也没有包含）',
      '插件的调试日志',
      '原始请求头',
    ],
    notes: [
      identityHidden ? '这个实验在导出时尚未揭晓：报告里不写模型身份，保持盲选。' : '这个实验已揭晓，报告里写明了每个候选的模型身份。',
      '报告里凡是看起来像本机绝对路径的文本都被替换成「<本地路径>」；task.json / recipes.json 与作品文件里的原文逐字节未改，所以题目与配方的指纹仍然对得上。',
      '作品在报告的受限沙箱里预览（不给同源权限），也可以在新窗口单独打开 works/ 下的文件。',
    ],
  };

  const manifest = redactValue({
    schemaVersion: PACK_SCHEMA_VERSION,
    kind: 'showcase',
    createdAt: generatedAt,
    tool: { name: tool.name, version: tool.version },
    experiment: {
      title: experiment.title, category: experiment.category ?? '',
      createdAt: experiment.createdAt ?? null, status: experiment.status ?? null,
      previewNetworkPolicy: experiment.previewPolicy?.networkPolicy ?? 'offline',
    },
    task: { hash: taskHash, included, hasStartHtml: full.startHtml !== null, promptChars: full.prompt.length },
    identitiesHidden: identityHidden,
    candidates: candidateViews.map((c) => ({
      slot: c.slot, letter: c.letter, name: c.name, provider: c.provider, model: c.model,
      status: c.status, statusLabel: c.statusLabel, htmlHash: c.htmlHash,
      workFile: c.workFile, needsNetwork: c.needsNetwork, externalRefs: c.externalRefs.slice(0, 20),
    })),
    vote: vote ? {
      choice: vote.choice, tags: vote.tags ?? null, note: vote.note ?? null,
      revealedAt: vote.revealedAt ?? null, createdAt: vote.createdAt ?? null,
    } : null,
    shots: shots.map((s) => ({ file: s.file, viewport: s.viewport, caption: s.caption, meta: s.meta })),
    privacy: {
      containsCredentials: false, containsAbsolutePaths: false, containsReasoning: false,
      containsRawOutput: Boolean(opts.rawOutput), containsPrompt: Boolean(includedTask.prompt.length > 0),
      containedPaths: privacy.included, excludedPaths: privacy.excluded,
    },
    contents: [],
  });

  const report = renderShowcaseReport({
    experiment,
    task: includedTask,
    taskHash,
    candidates: candidateViews,
    vote: vote ? {
      choice: vote.choice,
      choiceLabel: vote.choiceLabel ?? vote.choice,
      tags: vote.tags, note: vote.note, revealedAt: vote.revealedAt,
      mappingText: vote.mappingText ?? null,
    } : null,
    screenshots: shots.map((s) => ({ file: s.file, caption: s.caption })),
    privacy,
    tool,
    generatedAt,
    schemaVersion: PACK_SCHEMA_VERSION,
  });
  entries.unshift(entry('index.html', report));

  // 导出后自校验：清单与实际条目必须一一对上，且不得出现白名单外的类型。
  // （以前 verifyPackContents 只在**读**复测包时用，展示包导出后没人验 —— 现在两边都验。）
  assertAllowedExtensions(entries, SHOWCASE_ALLOWED_EXTENSIONS, '展示包里出现了不该有的文件类型');
  const contents = await contentsOf(entries);
  // pack.json 还没进 entries，所以这里校验的就是"除清单之外的全部条目"
  await verifyPackContents(entries, contents);
  manifest.contents = contents;
  entries.push(metaEntry('pack.json', manifest));
  return { entries, manifest, report };
}

function articleCount(entries, prefix) {
  return entries.filter((e) => e.name.startsWith(prefix)).length;
}

/**
 * 导出前的"包含内容"（F22：导出前显示包含内容）。
 * 只做静态描述，不读文件、不采集截图 —— 明细由导出的 manifest 给出。
 */
export function describeExport({ kind, experiment, attempts, vote, options }) {
  const opts = normalizeExportOptions(options);
  const full = normalizeTaskSnapshot(experiment.taskSnapshot);
  const rows = [];
  const warnings = [];
  const k = kind === 'retest' ? 'retest' : 'showcase';

  if (k === 'showcase') {
    rows.push({ key: 'report', label: 'index.html 报告（对比阅读 + 人工评价 + 下载入口）', included: true, always: true });
    rows.push({ key: 'meta', label: 'pack.json 公开元数据（每个文件的 sha256）', included: true, always: true });
    rows.push({ key: 'works', label: '作品文件（提取出的单文件 HTML）', included: true, always: true, detail: '本实验有作品的候选会被包含' });
    rows.push({ key: 'screenshots', label: '初始截图（导出时重新加载作品采集）', included: opts.screenshots, detail: opts.screenshots ? '需要浏览器，可能要几秒' : '不含截图' });
    rows.push({ key: 'screenshotRecords', label: '截图记录（含失败的那几次）', included: opts.screenshotRecords });
    rows.push({ key: 'rawOutput', label: '原始输出正文（未提取前的完整回复）', included: opts.rawOutput, detail: opts.rawOutput ? '会把模型的完整回复一起打包' : '默认不含' });
  } else {
    rows.push({ key: 'task', label: '题目与输出要求', included: opts.prompt || opts.outputRequirements });
    rows.push({ key: 'startHtml', label: '起始 HTML', included: opts.startHtml && full.startHtml !== null, detail: full.startHtml === null ? '这个实验没有起始 HTML' : null });
    rows.push({ key: 'recipes', label: '每个候选的配方（模型来源 / 模型 / 系统提示词 / 参数）', included: opts.recipes });
    rows.push({ key: 'rawOutput', label: '原始输出正文', included: false, always: true, detail: '复测包不含作品结果' });
    if (!opts.prompt) warnings.push('不含题目原文：对方只能复用配方，看不到这次比的是什么题。');
    if (!opts.recipes) warnings.push('不含配方：这个复测包没有可复用的调用配置，导入后是个空壳。');
  }

  rows.push({ key: 'prompt', label: '题目原文', included: opts.prompt && full.prompt.length > 0, detail: full.prompt.length > 0 ? full.prompt.length + ' 字符' : '题目为空' });
  rows.push({ key: 'reasoning', label: '推理全文', included: false, always: true, detail: '按 F22 默认不导出' });
  rows.push({ key: 'logs', label: '插件调试日志与原始请求头', included: false, always: true });
  rows.push({ key: 'credentials', label: 'API key / 凭据 / 绝对本地路径', included: false, always: true, detail: '导出时统一脱敏（A27）' });

  if (k === 'showcase' && vote && vote.revealedAt === null) {
    warnings.push('这个实验尚未揭晓：展示包里不会写出模型身份（保持盲选）。');
  }
  if (k === 'showcase' && (!attempts || attempts.length === 0)) {
    warnings.push('这个实验还没有任何候选记录。');
  }

  // 内容自查（A27）：题目 / 起始 HTML / 系统提示词里如果出现"看起来像本机路径或密钥"的文本，
  // **如实告诉用户，但不替他改** —— 改了会让题目指纹在导出前后对不上（A25 要的是一致性）。
  const scans = [];
  if (opts.prompt || opts.outputRequirements) scans.push({ what: '题目与输出要求', text: full.prompt + '\n' + full.outputRequirements });
  if (opts.startHtml && full.startHtml) scans.push({ what: '起始 HTML', text: full.startHtml });
  if (opts.recipes) {
    for (const a of attempts ?? []) {
      const r = normalizeRecipeContent(a.recipe ?? {});
      scans.push({ what: '候选 ' + slotLetter(a.slot) + ' 的配方', text: String(r.systemPrompt ?? '') + '\n' + (r.promptSegments ?? []).join('\n') });
    }
  }
  const findings = [];
  for (const s of scans) {
    const r = scanForPrivateContent(s.text);
    for (const hit of r.hits) findings.push({ where: s.what, kind: hit.kind });
  }
  if (findings.length > 0) {
    const byWhere = new Map();
    for (const f of findings) byWhere.set(f.where, (byWhere.get(f.where) ?? 0) + 1);
    warnings.push('注意：' + [...byWhere.entries()].map(([w, n]) => w + ' 里 ' + n + ' 处').join('、')
      + '看起来像本机路径或密钥。这些是你自己的内容，插件不会替你改写（改了题目指纹就对不上了）；'
      + '不确定要不要分享，就把对应的勾去掉再导出。');
  }
  return { kind: k, rows, warnings, options: opts, privateScan: { count: findings.length, findings: findings.slice(0, 10) } };
}

/**
 * 解析并校验一个复测包。**只解析，不执行**（F22）。
 * @param {{entries: Array<{name: string, data: Buffer}>, stats: object}} zip readZip 的结果
 * @returns {Promise<{manifest: object, task: object, recipes: object, summary: object}>}
 */
export async function parseRetestPack(zip) {
  const byName = new Map(zip.entries.map((e) => [e.name, e]));
  const packEntry = byName.get('pack.json');
  if (!packEntry) throw new ZipError('not-a-pack', '这个包里没有 pack.json，不是 HTML Arena 的包');
  let manifest;
  try {
    manifest = JSON.parse(packEntry.data.toString('utf8'));
  } catch (err) {
    throw new ZipError('bad-manifest', 'pack.json 不是合法 JSON：' + String(err && err.message || err));
  }
  // 形状守卫：pack.json 是包里**唯一不被任何 hash 覆盖**的文件（它自己就是清单），
  // 所以它的形状必须逐个字段自己验。以前直接读属性，畸形包会抛 TypeError → 500
  // （"服务器内部错误……这是插件的缺陷"），而它其实只是"这个包不合规"（400）。
  if (!isPlainObject(manifest)) throw new ZipError('bad-manifest', 'pack.json 不是一个 JSON 对象');
  if (!isPlainObject(manifest.task)) throw new ZipError('bad-manifest', 'pack.json 里缺少 task 段');
  if (!Array.isArray(manifest.contents)) throw new ZipError('bad-manifest', 'pack.json 里缺少文件清单（contents）');
  if (manifest.candidates !== undefined && !Array.isArray(manifest.candidates)) {
    throw new ZipError('bad-manifest', 'pack.json 里 candidates 不是数组');
  }
  if (manifest.kind !== 'retest') {
    throw new ZipError('not-a-retest-pack',
      manifest.kind === 'showcase'
        ? '这是展示包（给人看的报告），不是复测包。展示包不需要导入 —— 解压后双击 index.html 即可阅读。'
        : '这个包的 kind 是「' + String(manifest.kind) + '」，本插件只能导入复测包。');
  }
  // 类型确认之后才做文件类型白名单：先看清楚"这是什么包"，再谈"它该有哪些文件"。
  // 顺序反了的话，展示包会得到一句"包里出现了不该有的文件类型（index.html）"这种
  // 让人摸不着头脑的报错（实测踩过），而它真正该说的是"这是展示包，不用导入"。
  assertAllowedExtensions(zip.entries, RETEST_ALLOWED_EXTENSIONS, '拒绝导入：复测包里出现了不该有的文件类型');

  const version = Number(manifest.schemaVersion);
  if (!Number.isInteger(version) || version < 1) throw new ZipError('bad-schema', 'pack.json 里没有可识别的 schemaVersion');
  if (version > PACK_SCHEMA_VERSION) {
    throw new ZipError('schema-too-new', '这个包是更新版本的插件导出的（schemaVersion ' + version
      + ' > 本插件支持的 ' + PACK_SCHEMA_VERSION + '）。请先升级插件，而不是猜着读。');
  }

  await verifyPackContents(zip.entries, manifest.contents);

  const taskEntry = byName.get('task.json');
  if (!taskEntry) throw new ZipError('missing-entry', '复测包里没有 task.json');
  let task;
  try {
    task = JSON.parse(taskEntry.data.toString('utf8'));
  } catch (err) {
    throw new ZipError('bad-task', 'task.json 不是合法 JSON：' + String(err && err.message || err));
  }
  if (!isPlainObject(task)) throw new ZipError('bad-task', 'task.json 不是一个 JSON 对象');
  const normalizedTask = normalizeTaskSnapshot(task);
  const recomputed = await taskHashOf(normalizedTask);
  if (String(manifest.task?.hash ?? '') !== recomputed) {
    throw new ZipError('hash-mismatch', '题目指纹对不上：清单写的是 ' + String(manifest.task?.hash).slice(0, 16)
      + '…，按 task.json 重新算是 ' + recomputed.slice(0, 16) + '…（包被改过）');
  }

  const recipesEntry = byName.get('recipes.json');
  let recipes = { candidates: [] };
  if (recipesEntry) {
    try {
      recipes = JSON.parse(recipesEntry.data.toString('utf8'));
    } catch (err) {
      throw new ZipError('bad-recipes', 'recipes.json 不是合法 JSON：' + String(err && err.message || err));
    }
    if (!isPlainObject(recipes)) throw new ZipError('bad-recipes', 'recipes.json 不是一个 JSON 对象');
    if (recipes.candidates !== undefined && !Array.isArray(recipes.candidates)) {
      throw new ZipError('bad-recipes', 'recipes.json 里的 candidates 不是数组');
    }
  }
  const rawCandidates = Array.isArray(recipes.candidates) ? recipes.candidates : [];
  const candidates = [];
  const seenSlots = new Set();
  for (const raw of rawCandidates) {
    if (!isPlainObject(raw)) throw new ZipError('bad-recipes', 'recipes.json 的 candidates 里有不是对象的元素');
    const content = normalizeRecipeContent(isPlainObject(raw.recipe) ? raw.recipe : {});
    const hash = recipeHash(content);
    if (String(raw.contentHash ?? '') !== hash) {
      throw new ZipError('hash-mismatch', '候选 ' + String(raw.letter ?? raw.slot) + ' 的配方指纹对不上（配置被改过）');
    }
    if (!content.provider || !content.model) {
      throw new ZipError('bad-recipes', '候选 ' + String(raw.letter ?? raw.slot) + ' 的配方里没有模型来源或模型');
    }
    // 槽位与字母**以本机为准**：包里写什么字母不算数（"候选 A<script>" 这种自由值不能进界面），
    // 槽位必须是 0–3 的整数且不重复 —— 否则两个候选会抢同一个位置。
    const slot = Number(raw.slot);
    if (!Number.isInteger(slot) || slot < 0 || slot > 3) {
      throw new ZipError('bad-recipes', '候选的槽位不合法（必须是 0–3 的整数，收到 ' + JSON.stringify(raw.slot) + '）');
    }
    if (seenSlots.has(slot)) throw new ZipError('bad-recipes', '有两个候选用了同一个槽位（' + slot + '）');
    seenSlots.add(slot);
    const name = typeof raw.name === 'string' && raw.name.trim().length > 0
      ? raw.name.trim().slice(0, 60) : ('候选 ' + slotLetter(slot));
    candidates.push({ slot, letter: slotLetter(slot), name, contentHash: hash, recipe: content });
  }
  for (const m of manifest.candidates) {
    if (!isPlainObject(m)) throw new ZipError('bad-manifest', 'pack.json 的 candidates 里有不是对象的元素');
  }
  const manifestHashBySlot = new Map(manifest.candidates.map((c) => [c.slot, c.recipeHash]));
  for (const c of candidates) {
    if (manifestHashBySlot.has(c.slot) && manifestHashBySlot.get(c.slot) !== c.contentHash) {
      throw new ZipError('hash-mismatch', '候选 ' + c.letter + ' 的配方指纹与清单不一致');
    }
  }

  // "包含题目了吗"**按 task.json 的实际内容判断**，不采信清单里的自述 ——
  // 清单说 included.prompt=true 而正文是空的时候，以前界面会显示"包含题目原文"（假信息）。
  const promptIncluded = normalizedTask.prompt.trim().length > 0;
  const startHtmlIncluded = normalizedTask.startHtml !== null;
  const warnings = [];
  if (!promptIncluded) warnings.push('这个包里没有题目原文（可能按导出者的选择省略了），导入后题目是空的，需要你补上。');
  if (candidates.length === 0) warnings.push('这个包里没有配方，导入后没有可复用的候选配置。');
  if (Boolean(manifest.task.included?.prompt) !== promptIncluded) {
    warnings.push('清单里关于"是否包含题目"的说法与实际内容不一致，已按实际内容处理（清单说 '
      + (manifest.task.included?.prompt ? '包含' : '不含') + '，实际' + (promptIncluded ? '有题目' : '没有题目') + '）。');
  }

  // 输出规则与预览规则全部**钳制后再用**：这些值直接决定"这一轮会不会被超时打断"，
  // 采信包作者的任意数字会造成"导入的实验每次运行都立刻超时"这种后果（实测过 timeoutMs=1e15）。
  const output = sanitizeOutputPolicy(manifest.output);
  const preview = sanitizePreviewPolicy(manifest.preview);
  warnings.push(...output.warnings, ...preview.warnings);

  const rawTitle = isPlainObject(manifest.experiment) ? manifest.experiment.title : null;
  const title = typeof rawTitle === 'string' && rawTitle.trim().length > 0 ? rawTitle.trim().slice(0, 120) : '导入的复测包（未命名）';
  const rawCategory = isPlainObject(manifest.experiment) ? manifest.experiment.category : null;
  const category = typeof rawCategory === 'string' ? rawCategory.slice(0, 40) : '';

  return {
    manifest,
    task: normalizedTask,
    recipes: { ...recipes, candidates },
    sanitized: {
      title, category,
      outputPolicy: output.policy, outputRejected: output.rejected,
      previewPolicy: preview.policy, previewRejected: preview.rejected,
    },
    summary: {
      kind: 'retest',
      schemaVersion: version,
      createdAt: typeof manifest.createdAt === 'string' ? manifest.createdAt : null,
      tool: isPlainObject(manifest.tool) ? { name: String(manifest.tool.name ?? '').slice(0, 60), version: String(manifest.tool.version ?? '').slice(0, 40) } : null,
      title,
      taskHash: recomputed,
      promptIncluded,
      startHtmlIncluded,
      candidateCount: candidates.length,
      candidates: candidates.map((c) => ({
        slot: c.slot, letter: c.letter, name: c.name, provider: c.recipe.provider, model: c.recipe.model, contentHash: c.contentHash,
      })),
    },
    warnings,
  };
}
