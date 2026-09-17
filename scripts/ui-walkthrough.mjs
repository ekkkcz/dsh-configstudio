/**
 * 真实浏览器端到端演练 —— 用真 Chromium 点完整个流程，并留下截图证据。
 *
 * 它不是模拟：真的打开我们的 SPA，真的点按钮，真的走 HTTP + 预览 iframe。
 * 只有模型是模拟的（零费用），产物明确标记为模拟结果。
 *
 * 用法：node scripts/ui-walkthrough.mjs [--base http://127.0.0.1:8790] [--out docs/evidence]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from '../src/preview/browser.js';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const getArg = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const BASE = getArg('--base', 'http://127.0.0.1:8790');
const OUT = join(here, '..', getArg('--out', 'docs/evidence'));
const UI = BASE + '/html-arena/api/ui';

const report = { startedAt: new Date().toISOString(), base: BASE, steps: [], findings: [] };
mkdirSync(OUT, { recursive: true });

const b = await launchBrowser();
if (!b.ok) {
  console.log(JSON.stringify({ error: '无法启动浏览器：' + b.reason, attempts: b.attempts }, null, 2));
  process.exit(1);
}
const browser = b.browser;
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();

const consoleErrors = [];
const pageErrors = [];
const badResponses = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 400)); });
page.on('pageerror', (e) => pageErrors.push(String(e.message).slice(0, 400)));
// 记录所有非 2xx 响应及其正文，便于定位界面里的失败点
page.on('response', async (res) => {
  if (res.status() < 400) return;
  let body = '';
  try { body = (await res.text()).slice(0, 800); } catch { body = '(正文不可读)'; }
  badResponses.push({ status: res.status(), url: res.url(), method: res.request().method(), body });
});

let baselineCount = 0;

const shots = [];
async function shot(name) {
  const buf = await page.screenshot({ type: 'png', fullPage: false });
  const file = join(OUT, 'ui-' + name + '.png');
  writeFileSync(file, buf);
  shots.push({ name, file, bytes: buf.length });
  return file;
}
function step(name, detail) { report.steps.push({ name, at: Date.now(), ...detail }); }

try {
  // ── 1) 打开界面 ────────────────────────────────────────────
  await page.goto(UI, { waitUntil: 'load', timeout: 30000 });
  await page.waitForSelector('#mode-badge', { timeout: 15000 });
  await page.waitForTimeout(800);
  const badge = await page.textContent('#mode-badge');
  const envNote = await page.textContent('#env-note');
  const fatalVisible = await page.isVisible('#fatal');
  const baselineCount = await page.$$eval('#experiment-list .exp', (els) => els.length);
  step('打开界面', { badge, envNote, fatalVisible, baselineCount });
  await shot('01-列表');

  // ── 2) 试一个示例 ─────────────────────────────────────────
  await page.click('#btn-sample');
  await page.waitForTimeout(300);
  const prompt = await page.inputValue('#task-prompt');
  step('填入示例题', { promptLength: prompt.length, hasWeather: prompt.includes('天气仪表盘') });
  await shot('02-新建');

  // ── 3) 选两个不同的模拟模型 ────────────────────────────────
  const cardCount = await page.$$eval('#candidates .cand', (els) => els.length);
  const candState = await page.evaluate(() => window.__htmlArena.state.candidates.map((c) => ({ name: c.name, provider: c.provider, model: c.model })));
  step('候选卡渲染', { cardCount, candidates: candState });

  // 把第二个候选换成 sim-fail 来验证"一个失败不影响另一个"
  await page.selectOption('#candidates .cand:nth-child(2) select[data-role="provider"]', 'sim-fail');
  await page.waitForTimeout(1200);
  const afterChange = await page.evaluate(() => window.__htmlArena.state.candidates.map((c) => ({ name: c.name, provider: c.provider, model: c.model })));
  step('切换第二候选为失败模型', { hint: await page.textContent('#candidate-hint'), candidates: afterChange });
  await shot('03-候选配置');

  // 查看实际发送内容
  await page.click('#btn-preview-request');
  await page.waitForSelector('#request-preview:not([hidden])', { timeout: 20000 });
  await page.waitForTimeout(400);
  const reqPreview = (await page.textContent('#request-preview')).slice(0, 600);
  step('请求预览', { preview: reqPreview });
  await shot('04-请求预览');

  // ── 4) 开始生成 ────────────────────────────────────────────
  await page.click('#btn-start');
  await page.waitForSelector('#view-run:not([hidden])', { timeout: 30000 });
  await page.waitForTimeout(700);
  step('进入运行面板', { title: await page.textContent('#run-title') });
  await shot('05-运行中');

  // 等本轮结束（顶部会出现可以进入对比）
  await page.waitForFunction(() => {
    const b = document.getElementById('btn-goto-compare');
    return b && !b.disabled;
  }, { timeout: 90000 });
  await page.waitForTimeout(400);
  step('本轮结束', { runCards: await page.$$eval('#run-cards .cand', (e) => e.length) });
  await shot('06-运行结束');

  // ── 5) 进入对比 ────────────────────────────────────────────
  await page.click('#btn-goto-compare');
  await page.waitForSelector('#view-compare:not([hidden])', { timeout: 15000 });
  await page.waitForTimeout(2500);
  const frameInfo = await page.$$eval('.frame-wrap', (els) => els.map((e) => ({
    head: e.querySelector('.frame-head') ? e.querySelector('.frame-head').innerText.replace(/\s+/g, ' ').trim() : '',
    hasIframe: Boolean(e.querySelector('iframe')),
    hasError: Boolean(e.querySelector('.frame-error')),
    scalerHeight: e.querySelector('.scaler') ? e.querySelector('.scaler').style.height : null,
  })));
  step('对比页', { frames: frameInfo });
  await shot('07-对比桌面');

  // 确认 iframe 真的渲染了内容（读子框架的标题）
  const frameTitles = [];
  for (const f of page.frames()) {
    if (f === page.mainFrame()) continue;
    try { frameTitles.push({ url: f.url().slice(0, 90), title: await f.title() }); } catch { frameTitles.push({ url: f.url().slice(0, 60), title: '(跨源不可读，符合隔离预期)' }); }
  }
  step('预览 iframe 状态', { frameTitles });

  // ── 6) 手机视口 ────────────────────────────────────────────
  await page.click('.seg-btn[data-vp="mobile"]');
  await page.waitForTimeout(1200);
  const mobileScales = await page.$$eval('.scaler', (els) => els.map((e) => e.style.height));
  step('切换手机视口', { scalerHeights: mobileScales, label: await page.textContent('#compare-note') });
  await shot('08-对比手机');

  // ── 7) 隐藏身份 ────────────────────────────────────────────
  await page.click('#btn-blind');
  await page.waitForTimeout(500);
  const blindHeads = await page.$$eval('.frame-head', (els) => els.map((e) => e.innerText.replace(/\s+/g, ' ').trim()));
  step('隐藏配置身份', { heads: blindHeads });
  await shot('09-盲选');

  // ── 8) 投票 ────────────────────────────────────────────────
  const voteButtons = await page.$$eval('#vote-row button', (els) => els.map((e) => e.textContent));
  step('评价按钮', { voteButtons });
  await page.click('#vote-row button:nth-child(1)');
  await page.waitForTimeout(900);
  step('保存评价', { status: await page.textContent('#vote-status') });
  await shot('10-评价');

  // ── 9) 揭晓 ────────────────────────────────────────────────
  if (await page.isVisible('#btn-reveal')) {
    await page.click('#btn-reveal');
    await page.waitForTimeout(900);
    step('揭晓身份', { note: (await page.textContent('#compare-note')).slice(0, 200) });
    await shot('11-揭晓');
  }

  // ── 10) 失败候选仍占位 ─────────────────────────────────────
  const errorFrames = await page.$$eval('.frame-error', (els) => els.map((e) => e.innerText.replace(/\s+/g, ' ').trim().slice(0, 220)));
  step('失败候选占位', { errorFrames });
  await shot('12-失败占位');

  // ── 11) 截图功能 ───────────────────────────────────────────
  await page.click('#btn-screenshots');
  await page.waitForTimeout(9000);
  const imgCount = await page.$$eval('img[src^="data:image/png"]', (els) => els.length);
  step('初始截图', { images: imgCount });
  await shot('13-截图');

  // ── 12) 回到列表看状态汇总 ──────────────────────────────────
  await page.click('.tab[data-view="experiments"]');
  await page.waitForTimeout(1500);
  const listText = await page.$$eval('.exp', (els) => els.map((e) => e.innerText.replace(/\s+/g, ' ').trim()));
  // 断言必须相对基线：开发数据目录会保留上一轮的实验。
  step('实验列表汇总', { rows: listText, count: listText.length, baselineCount });
  if (listText.length !== baselineCount + 1) {
    report.findings.push('本轮应新增 1 条实验：基线 ' + baselineCount + ' → 现在 ' + listText.length);
  }
  const newest = listText[0] || '';
  if (!/成功 1/.test(newest)) report.findings.push('列表未反映成功数：' + newest);
  if (!/失败\/中断 1/.test(newest)) report.findings.push('列表未反映失败数：' + newest);
  await shot('14-列表汇总');

  // ── 13) 搜索与类型筛选 ──────────────────────────────────────
  await page.fill('#search', '不存在的标题');
  await page.waitForTimeout(900);
  const noneSearch = await page.$$eval('#experiment-list .exp', (els) => els.length);
  await page.fill('#search', '');
  await page.waitForTimeout(900);
  const afterClear = await page.$$eval('#experiment-list .exp', (els) => els.length);
  await page.selectOption('#filter-category', 'dashboard');
  await page.waitForTimeout(900);
  const byCategory = await page.$$eval('#experiment-list .exp', (els) => els.length);
  await page.selectOption('#filter-category', '');
  await page.waitForTimeout(700);
  step('搜索与筛选', { noneSearch, afterClear, byCategory });
  if (noneSearch !== 0) report.findings.push('搜索不存在的标题应返回 0 条，实际 ' + noneSearch);

  // ── 14) 打开已有实验 ────────────────────────────────────────
  if (listText.length) {
    await page.click('#experiment-list .exp:first-child button:has-text("打开")');
    await page.waitForTimeout(2600);
    const reopened = {
      compareVisible: await page.isVisible('#view-compare'),
      frames: await page.$$eval('.frame-wrap', (els) => els.length),
      voteStatus: await page.textContent('#vote-status'),
    };
    step('重新打开实验', reopened);
    if (!reopened.compareVisible) report.findings.push('打开已有实验后没有进入对比页');
  }

  report.consoleErrors = consoleErrors;
  report.pageErrors = pageErrors;
  report.badResponses = badResponses;
  report.shots = shots;
  report.finishedAt = new Date().toISOString();
  report.ok = consoleErrors.length === 0 && pageErrors.length === 0 && !fatalVisible;
} catch (err) {
  report.error = String(err && err.stack || err).slice(0, 2000);
  try { await shot('99-失败现场'); } catch { /* 截图失败就算了 */ }
  report.consoleErrors = consoleErrors;
  report.pageErrors = pageErrors;
  report.badResponses = badResponses;
  report.shots = shots;
  report.ok = false;
} finally {
  await browser.close();
}

const outPath = join(OUT, 'ui-walkthrough-' + Date.now() + '.json');
writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');
console.log(JSON.stringify({
  ok: report.ok, error: report.error ?? null,
  steps: report.steps.map((s) => s.name),
  consoleErrors, pageErrors, badResponses,
  shots: shots.map((s) => s.name),
  outPath,
}, null, 2));
