/**
 * A30 的 M3 环节：**用真实模型产出的实验**做一次导出 → 另一个安装导入（零费用）。
 *
 * 为什么单独写：M3 的主验收（m3-export-import-check.mjs）用的是模拟模型 + 两个干净数据目录，
 * 证明的是"包机制对不对"。A30 要的是"**两个真实模型**的完整流程里，导出与导入也有可核对证据"。
 * 真实实验已经在 DSH 测试实例（:8902）里跑好了 —— 打开它、导出、导入到另一个干净安装，
 * **全程不发起任何模型调用**，所以不花钱。
 *
 * 用法：node scripts/m3-real-pack-check.mjs [--base http://127.0.0.1:8902] [--title "M2 实时监控验证"]
 */
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchBrowser } from '../src/preview/browser.js';
import { readZip } from '../src/core/zip.js';
import { recipeHash } from '../src/core/recipe.js';
import {
  EVIDENCE_DIR, sleep, freePort, api, postJson, startDevServer, waitHealthy, hardKill, makeChecker, logLines,
} from './lib/devhost.mjs';

const args = process.argv.slice(2);
const getArg = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const REAL_BASE = getArg('--base', 'http://127.0.0.1:8902') + '/configstudio/api';
const TITLE = getArg('--title', 'M2 实时监控验证');

const { add, report, finish } = makeChecker({
  what: 'A30（M3 部分）：真实模型实验的展示包 / 复测包导出与跨安装导入',
  note: '真实实验数据 + 零模型调用（不发起任何新生成）',
});

const workDir = mkdtempSync(join(tmpdir(), 'arena-realpack-'));
const downloadDir = mkdtempSync(join(tmpdir(), 'arena-realpack-dl-'));
let server = null;
let browserHandle = null;

try {
  // ── ① 在真实实例上找一条有作品、还没揭晓的实验 ────────────────────
  const list = await api(REAL_BASE, '/experiments?search=' + encodeURIComponent(TITLE));
  const rows = (list.body.experiments || []).filter((e) => e.withHtml >= 2);
  add('准备', '真实实例上找到可用实验（≥2 个候选有作品）', rows.length > 0,
    rows.map((r) => r.title + '（有作品 ' + r.withHtml + '）'));
  if (rows.length === 0) throw new Error('没有可用实验，先跑一遍 M1/M2 的真实对比');

  // 优先挑一条**未揭晓**的：盲选脱敏只在这种状态下才算测到（揭晓不可逆，不拿已揭晓的凑数）
  const unrevealed = rows.filter((e) => !e.vote || e.vote.revealed === false);
  const target = unrevealed[0] || rows[0];
  const detail = await api(REAL_BASE, '/experiments/' + target.id);
  const attempts = detail.body.attempts;
  add('准备', '这条实验的作品是**真实模型**产出的（记录里有 provider / model 与真实用量）',
    attempts.every((a) => a.recipe && a.recipe.provider && a.recipe.model && a.receipt && a.receipt.usage),
    attempts.map((a) => a.recipe.provider + '/' + a.recipe.model));
  report.realExperiment = {
    id: target.id, title: target.title,
    models: attempts.map((a) => a.recipe.provider + '/' + a.recipe.model),
    revealed: Boolean(target.vote && target.vote.revealed),
  };

  // ── ② 导出复测包与展示包（真实数据，零调用） ──────────────────────
  const callsBefore = 0;   // 真实实例无法读它的调用日志，用"attempt 数不变"作为等效口径
  const attemptsBefore = attempts.length;

  const retestRes = await fetch(REAL_BASE + '/experiments/' + target.id + '/export/retest');
  const retestBuf = Buffer.from(await retestRes.arrayBuffer());
  const retestPath = join(downloadDir, 'real-retest.zip');
  writeFileSync(retestPath, retestBuf);
  add('A30', '从真实实验导出复测包（对方拿到的是同一道题与同一套配方）',
    retestRes.status === 200 && retestBuf.length > 500, { bytes: retestBuf.length });

  const showcaseRes = await fetch(REAL_BASE + '/experiments/' + target.id + '/export/showcase');
  const showcaseBuf = Buffer.from(await showcaseRes.arrayBuffer());
  const showcasePath = join(downloadDir, 'real-showcase.zip');
  writeFileSync(showcasePath, showcaseBuf);
  const showcaseZip = readZip(showcaseBuf);
  const names = showcaseZip.entries.map((e) => e.name);
  add('A30', '从真实实验导出展示包（报告 + 真实作品 + 截图）',
    showcaseRes.status === 200 && names.includes('index.html')
      && names.filter((n) => n.startsWith('works/')).length >= 2
      && names.some((n) => n.startsWith('shots/') && n.endsWith('.png')),
    names);

  const retestZip = readZip(retestBuf);
  const manifest = JSON.parse(retestZip.entries.find((e) => e.name === 'pack.json').data.toString('utf8'));
  const hashPairs = attempts.map((a) => ({
    slot: a.slot,
    source: recipeHash(a.recipe),
    pack: (manifest.candidates.find((c) => c.slot === a.slot) || {}).recipeHash,
  }));
  add('A30', '复测包里的配方 hash 与真实实验的配置逐个一致（导出没有改写内容）',
    hashPairs.every((p) => p.source === p.pack && /^[0-9a-f]{64}$/.test(p.source)),
    hashPairs.map((p) => ({ slot: p.slot, source: p.source.slice(0, 12), pack: String(p.pack).slice(0, 12) })));

  // 私密内容扫描（A27，真实数据这一遍也要过）
  const SENSITIVE = [
    { key: '绝对路径', re: /[A-Za-z]:\\\\[^"'<>\r\n]{3,}/ },
    { key: '疑似密钥', re: /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/ },
    { key: 'Bearer', re: /\bBearer\s+[A-Za-z0-9._-]{16,}/i },
  ];
  const metaEntries = retestZip.entries.filter((e) => e.name !== 'task.json' && e.name !== 'recipes.json');
  const hits = [];
  for (const e of [...metaEntries, ...showcaseZip.entries.filter((x) => x.name === 'pack.json' || x.name === 'index.html')]) {
    const text = e.data.toString('utf8');
    for (const s of SENSITIVE) if (s.re.test(text)) hits.push({ entry: e.name, key: s.key });
  }
  add('A27', '真实数据的包里，**元数据**（清单 / 报告 / 说明）不含绝对路径与密钥',
    hits.length === 0, { hits });

  // ── ③ 展示包报告：真实作品的报告能在另一个目录里离线打开 ───────────
  const unpacked = join(workDir, 'showcase');
  mkdirSync(unpacked, { recursive: true });
  for (const entry of showcaseZip.entries) {
    const p = join(unpacked, entry.name);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, entry.data);
  }
  const b = await launchBrowser();
  if (!b.ok) throw new Error('无法启动浏览器：' + b.reason);
  browserHandle = b.browser;
  const page = await b.browser.newPage();
  const failed = [];
  page.on('requestfailed', (r) => failed.push(r.url().slice(0, 100)));
  await page.goto('file:///' + join(unpacked, 'index.html').replace(/\\/g, '/'), { waitUntil: 'load', timeout: 30000 });
  await page.waitForTimeout(2000);
  const title = await page.title();
  // 真实作品不一定是"文字页"：可能是 canvas / 动画，innerText 只有几个字。
  // 所以判据用"文档真的建起来了"（节点数 + HTML 长度），而不是文字长度 ——
  // 第一版用 innerText > 50 判断，在一条 canvas 作品上假红过。
  const frameProbes = [];
  for (const f of page.frames()) {
    if (f === page.mainFrame()) continue;
    try {
      frameProbes.push(await f.evaluate(() => ({
        docTitle: document.title,
        textLen: document.body ? document.body.innerText.trim().length : -1,
        nodes: document.body ? document.body.querySelectorAll('*').length : -1,
        htmlLen: document.body ? document.body.innerHTML.length : -1,
      })));
    } catch { frameProbes.push({ docTitle: null, textLen: -1, nodes: -1, htmlLen: -1 }); }
  }
  // 判据分两层：
  //  ① 每个 iframe 都真的建起了文档（body 里有东西，不是空白页 / 错误页）；
  //  ② **包里那份作品**的 <title> 能在某个 iframe 的 document.title 里找到 ——
  //     这才叫"渲染的是这份作品"，而不是"随便有个页面"。
  // （不用 innerText 长度当判据：这条真实实验的作品就是"一行大字"，正文只有 5 个字。）
  const workDocs = showcaseZip.entries.filter((x) => /^works\/.*\.html$/.test(x.name));
  const workTitles = workDocs
    .map((w) => (/<title[^>]*>([^<]{1,60})<\/title>/i.exec(w.data.toString('utf8')) || [])[1])
    .filter(Boolean)
    .map((t) => t.trim());
  const builtOk = frameProbes.length >= 2 && frameProbes.every((p) => p.nodes >= 0 && (p.htmlLen > 5 || p.textLen > 0));
  const titlesOk = workTitles.length > 0
    ? workTitles.every((t) => frameProbes.some((p) => String(p.docTitle || '').trim() === t))
    : true;
  add('A30', '真实作品的展示包报告能离线打开，且**包里那两份作品**真的在受限沙箱里渲染出来了',
    /ConfigStudio 展示包/.test(title) && builtOk && titlesOk && failed.length === 0,
    { title, frameProbes, workTitles, failed: failed.slice(0, 3) });
  await page.screenshot({ path: join(EVIDENCE_DIR, 'm3-real-showcase-report.png') });
  report.screenshot = 'docs/evidence/m3-real-showcase-report.png';
  await page.close();

  // ── ④ 导入到另一个干净安装：hash 一致、不自动执行 ─────────────────
  const dataDir = join(workDir, 'clean-install');
  const llmLog = join(workDir, 'llm.jsonl');
  const port = await freePort();
  const base = 'http://127.0.0.1:' + port + '/configstudio/api';
  server = startDevServer({ port, dataDir, llmLog, latencyMs: 20 });
  await waitHealthy(base);
  const inspect = await api(base, '/packs/inspect', {
    method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: retestBuf,
  });
  add('A30', '在干净安装里检视这个真实复测包：题目指纹与候选逐个列出，并说明"不会自动执行"',
    inspect.status === 200 && inspect.body.summary.taskHash === manifest.task.hash
      && inspect.body.willCreate.modelCalls === 0,
    { taskHash: String(inspect.body.summary && inspect.body.summary.taskHash).slice(0, 16), willCreate: inspect.body.willCreate });

  const imported = await api(base, '/packs/import', {
    method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: retestBuf,
  });
  add('A30', '导入成功（201），并且**没有发起任何模型调用**',
    imported.status === 201 && logLines(llmLog) === 0 && imported.body.started.length === 0,
    { status: imported.status, llmCalls: logLines(llmLog) });

  const importedDetail = await api(base, '/experiments/' + imported.body.experimentId);
  add('A30', '导入后题目 hash 与真实实验一致（同一道题，逐字节同一份题目）',
    importedDetail.body.experiment.taskHash === detail.body.experiment.taskHash,
    { real: String(detail.body.experiment.taskHash).slice(0, 16), imported: String(importedDetail.body.experiment.taskHash).slice(0, 16) });
  add('A30', '导入的配方 hash 与真实实验逐个一致（同一套配置）',
    imported.body.links.every((l) => hashPairs.some((p) => p.slot === l.slot && p.source === l.contentHash)),
    imported.body.links.map((l) => ({ slot: l.slot, hash: String(l.contentHash).slice(0, 12) })));
  add('A30', '导入不产生执行记录（0 attempt），要跑得由用户自己点',
    importedDetail.body.attempts.length === 0);

  // 真实实例那边也必须没有任何新记录（导出是只读的）
  const after = await api(REAL_BASE, '/experiments/' + target.id);
  add('A30', '导出是只读的：真实实例上这条实验的 attempt 数没有变化',
    after.body.attempts.length === attemptsBefore, { before: attemptsBefore, after: after.body.attempts.length });

  report.hashPairs = hashPairs.map((p) => ({ slot: p.slot, source: p.source.slice(0, 16), pack: String(p.pack).slice(0, 16) }));
  report.notes = [
    '全程没有发起任何模型调用：真实实验是 M1/M2 已经跑好的，这里只做导出与导入。',
    '导入目标是临时数据目录里的干净开发安装（与真实实例互不影响）。',
  ];

  await b.browser.close();
  browserHandle = null;
  void callsBefore;
  void existsSync;
  void sleep;
  void postJson;
} catch (err) {
  add('执行', '脚本运行没有抛异常', false, String(err && err.stack || err).slice(0, 1200));
} finally {
  try { if (browserHandle) await browserHandle.close(); } catch { /* 已关 */ }
  try { await hardKill(server, '导入用的干净开发服务器'); } catch { /* 已经没了 */ }
  for (const d of [workDir, downloadDir]) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ } }
}

process.exit(finish('m3-real-pack'));
