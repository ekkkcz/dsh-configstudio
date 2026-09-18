/**
 * M3 交付截图 —— 导出 / 导入 / 历史筛选 / 展示包报告，全部零费用（开发服务器 + 模拟模型）。
 *
 * 每张图拍之前都**先自证合格**，不合格就抛错拒绝出图（沿用 M2 的做法）：
 *  - 导出对话框：清单里必须真的有"包含什么"的行，且能看到"不含推理全文 / 凭据"；
 *  - 导入检视：必须显示题目指纹与"模型调用 0 次"；
 *  - 需要重选的候选卡：必须真的出现"原本用 X / Y，必须重选"的提示；
 *  - 历史筛选：列表条数必须与筛选条件一致（不是"恰好只有一条"）；
 *  - 展示包报告：必须确认报告里 0 行脚本、且 iframe 真的渲染出作品。
 *
 * 用法：node scripts/m3-delivery-shots.mjs --out "../交付区/v0.5.0/截图"
 */
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from '../src/preview/browser.js';
import { readZip } from '../src/core/zip.js';
import { buildRetestPack } from '../src/core/pack.js';
import { writeZip } from '../src/core/zip.js';
import { freePort, api, postJson, startDevServer, waitHealthy, hardKill, sleep } from './lib/devhost.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const getArg = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const OUT = join(here, '..', getArg('--out', 'docs/evidence'));
mkdirSync(OUT, { recursive: true });

const workDir = mkdtempSync(join(tmpdir(), 'arena-shots-'));
const dataDir = join(workDir, 'data');
let server = null;
let browserHandle = null;
let port = 0;

async function waitIdle(base, id, timeoutMs = 60000) {
  const t0 = Date.now();
  for (;;) {
    const r = await api(base, '/experiments/' + id);
    const running = r.body.attempts.filter((a) => a.running || a.status === 'running' || a.status === 'queued');
    if (running.length === 0) return r.body;
    if (Date.now() - t0 > timeoutMs) throw new Error('等待生成超时');
    await sleep(120);
  }
}

try {
  port = await freePort();
  const base = 'http://127.0.0.1:' + port + '/html-arena/api';
  const ui = 'http://127.0.0.1:' + port + '/html-arena/api/ui';
  server = startDevServer({ port, dataDir, latencyMs: 60 });
  await waitHealthy(base);

  const b = await launchBrowser();
  if (!b.ok) throw new Error('无法启动浏览器：' + b.reason);
  browserHandle = b.browser;
  const saved = [];

  const ctx = await b.browser.newContext({ viewport: { width: 1600, height: 1060 } });
  const page = await ctx.newPage();
  const shot = async (name) => { writeFileSync(join(OUT, name + '.png'), await page.screenshot({ type: 'png' })); console.log('  ✓ ' + name); saved.push(name); };

  // ── 准备：跑一条两候选实验 + 一条用于"需要重选模型"的包 ──────────────
  const exp = await postJson(base, '/experiments', {
    title: 'M3 交付截图实验', category: 'dashboard',
    prompt: '做一个可切换城市的天气仪表盘，使用内置示例数据，包含折线图与昼夜主题。',
    outputRequirements: '单文件、无外部依赖、窄屏可用',
  });
  const expId = exp.body.experiment.id;
  await postJson(base, '/experiments/' + expId + '/start', {
    candidates: [{ name: '甲', provider: 'sim-ok-a', model: 'sim-fast' }, { name: '乙', provider: 'sim-ok-b', model: 'sim-slow' }],
  });
  await waitIdle(base, expId);
  // 再来一条"不同题材"的，让历史筛选有多行可比
  const exp2 = await postJson(base, '/experiments', { title: '另一个题材的实验', category: 'game', prompt: '做一个小游戏' });
  await postJson(base, '/experiments/' + exp2.body.experiment.id + '/start', {
    candidates: [{ name: '甲', provider: 'sim-ok-a', model: 'sim-fast' }, { name: '乙', provider: 'sim-ok-b', model: 'sim-slow' }],
  });
  await waitIdle(base, exp2.body.experiment.id);
  await postJson(base, '/experiments/' + expId + '/vote', { choice: 'A', tags: ['视觉'], note: '左边那版布局更清楚' });

  await page.goto(ui, { waitUntil: 'load', timeout: 30000 });
  await page.waitForSelector('#mode-badge', { timeout: 20000 });
  await page.waitForTimeout(1000);

  // ── 1) 导出对话框：先看"包含什么"再下载（F22） ─────────────────────
  await page.fill('#search', 'M3 交付截图实验');
  await page.waitForTimeout(900);
  await page.click('#experiment-list .exp:first-child button:has-text("导出")');
  await page.waitForSelector('#export-modal:not([hidden])', { timeout: 10000 });
  await page.waitForTimeout(1200);
  const showText = await page.innerText('#export-contents');
  if (!/index\.html 报告/.test(showText) || !/推理全文/.test(showText) || !/API key/.test(showText)) {
    throw new Error('导出对话框的清单不合格，拒绝出图：' + showText.slice(0, 200));
  }
  await shot('01-导出-展示包清单（先看包含什么）');

  await page.click('#export-kind-seg .seg-btn[data-kind="retest"]');
  await page.waitForTimeout(1200);
  const retestText = await page.innerText('#export-modal');
  if (!/复测包/.test(retestText) || !/不会自动开始生成/.test(retestText)) {
    throw new Error('复测包说明不合格，拒绝出图：' + retestText.slice(0, 200));
  }
  await shot('02-导出-复测包说明（不含作品结果）');
  await page.click('#btn-export-close');
  await page.waitForTimeout(400);

  // ── 2) 导入检视：题目指纹 + 每个候选在本机的匹配结果 ───────────────
  const retestRes = await fetch(base + '/experiments/' + expId + '/export/retest');
  const retestBuf = Buffer.from(await retestRes.arrayBuffer());
  const retestPath = join(workDir, 'retest.zip');
  writeFileSync(retestPath, retestBuf);

  const [chooser] = await Promise.all([page.waitForEvent('filechooser', { timeout: 15000 }), page.click('#btn-import')]);
  await chooser.setFiles(retestPath);
  await page.waitForSelector('#import-panel:not([hidden])', { timeout: 20000 });
  await page.waitForTimeout(1500);
  const inspectText = await page.innerText('#import-panel');
  if (!/题目指纹/.test(inspectText) || !/模型调用 0 次/.test(inspectText)) {
    throw new Error('导入检视面板不合格，拒绝出图：' + inspectText.slice(0, 200));
  }
  await shot('03-导入复测包-检视（题目指纹与匹配结果）');
  await page.click('#import-panel button:has-text("收起")');
  await page.waitForTimeout(300);

  // ── 3) 模型不在这台机器上：候选卡如实要求重选 ──────────────────────
  const ghost = await buildRetestPack({
    experiment: {
      id: 'exp_other', title: '来自另一台机器的复测包', category: 'dashboard',
      taskSnapshot: { prompt: '这道题来自另一台机器。', startHtml: null, outputRequirements: '' },
      outputPolicy: { maxTokens: null, timeoutMs: 120000, concurrency: 2 },
      previewPolicy: { networkPolicy: 'offline', viewport: 'desktop' },
    },
    attempts: [{
      slot: 0,
      recipe: { name: '候选 A', provider: 'provider-not-installed', model: 'ghost-model-1', systemPrompt: '来自别处的提示词', promptSegments: [], temperature: null, maxTokens: null, reasoningEffort: null },
    }],
    options: {}, tool: { name: 'HTML Arena', version: '0.0.0-other-machine' }, now: new Date().toISOString(),
  });
  const ghostPath = join(workDir, 'ghost.zip');
  writeFileSync(ghostPath, writeZip(ghost.entries));
  await page.click('.tab[data-view="experiments"]');
  await page.waitForTimeout(700);
  const [chooser2] = await Promise.all([page.waitForEvent('filechooser', { timeout: 15000 }), page.click('#btn-import')]);
  await chooser2.setFiles(ghostPath);
  await page.waitForTimeout(2000);
  await page.click('#import-panel button:has-text("确认导入")');
  await page.waitForTimeout(2500);
  await page.locator('#candidates .cand').first().locator('details summary').first().click();
  await page.waitForTimeout(500);
  const cardText = await page.innerText('#candidates');
  if (!/原本用 provider-not-installed/.test(cardText) || !/重新选择/.test(cardText)) {
    throw new Error('候选卡的重选提示不合格，拒绝出图：' + cardText.slice(0, 300));
  }
  if (!/来自别处的提示词/.test(await page.inputValue('#candidates .cand textarea'))) {
    throw new Error('配方内容没有填进候选卡，拒绝出图');
  }
  await shot('04-导入后-候选卡要求重新匹配模型');

  // ── 4) 历史：按评价筛选 ───────────────────────────────────────────
  await page.click('.tab[data-view="experiments"]');
  await page.waitForTimeout(800);
  await page.fill('#search', '');
  await page.selectOption('#filter-vote', 'any');
  await page.waitForTimeout(1000);
  const filtered = await page.$$eval('#experiment-list .exp', (els) => els.length);
  if (filtered !== 1) throw new Error('按评价筛选的结果不是 1 条（实际 ' + filtered + '），拒绝出图');
  await shot('05-历史-按评价筛选');

  // ── 5) 展示包报告：解压到另一个目录，file:// 打开 ──────────────────
  const showcaseRes = await fetch(base + '/experiments/' + expId + '/export/showcase');
  const showcaseBuf = Buffer.from(await showcaseRes.arrayBuffer());
  const zip = readZip(showcaseBuf);
  const unpacked = join(workDir, 'showcase');
  mkdirSync(unpacked, { recursive: true });
  for (const entry of zip.entries) {
    const p = join(unpacked, entry.name);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, entry.data);
  }
  const reportHtml = readFileSync(join(unpacked, 'index.html'), 'utf8');
  if (/<script/i.test(reportHtml)) throw new Error('报告主体出现了脚本，拒绝出图');
  const ctx2 = await b.browser.newContext({ viewport: { width: 1400, height: 1100 } });
  const page2 = await ctx2.newPage();
  await page2.goto('file:///' + join(unpacked, 'index.html').replace(/\\/g, '/'), { waitUntil: 'load', timeout: 30000 });
  await page2.waitForTimeout(1800);
  const frameLens = [];
  for (const f of page2.frames()) {
    if (f === page2.mainFrame()) continue;
    try { frameLens.push((await f.evaluate(() => (document.body ? document.body.innerText.trim() : ''))).length); } catch { frameLens.push(-1); }
  }
  if (frameLens.filter((n) => n > 40).length < 2) throw new Error('报告里的作品没有渲染出来，拒绝出图：' + JSON.stringify(frameLens));
  writeFileSync(join(OUT, '06-展示包报告-离线双击打开.png'), await page2.screenshot({ type: 'png' }));
  console.log('  ✓ 06-展示包报告-离线双击打开');
  saved.push('06-展示包报告-离线双击打开');
  await ctx2.close();

  console.log('');
  console.log('已出图 ' + saved.length + ' 张 → ' + OUT);
  await ctx.close();
  await b.browser.close();
  browserHandle = null;
} catch (err) {
  console.error('出图失败（拒绝产出不合格的交付截图）：' + String(err && err.message || err));
  process.exitCode = 1;
} finally {
  try { if (browserHandle) await browserHandle.close(); } catch { /* 已关 */ }
  try { await hardKill(server, '开发服务器'); } catch { /* 已经没了 */ }
  try { rmSync(workDir, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }
}
