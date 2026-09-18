/**
 * M2 四候选对比页实测 —— 确认 3–4 个作品在界面上真的能看、能独立操作。
 * 零模型费用：只打开已经跑完的实验。
 *
 * 用法：node scripts/m2-four-walkthrough.mjs --base http://127.0.0.1:8901 --title "M2 四候选对比"
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from '../src/preview/browser.js';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const getArg = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const BASE = getArg('--base', 'http://127.0.0.1:8901');
const TITLE = getArg('--title', 'M2 四候选对比');
const OUT = join(here, '..', 'docs', 'evidence');
mkdirSync(OUT, { recursive: true });
const UI = BASE + '/html-arena/api/ui';

const report = { startedAt: new Date().toISOString(), base: BASE, title: TITLE, checks: [] };
const add = (name, ok, detail) => {
  report.checks.push({ name, ok: Boolean(ok), detail: detail === undefined ? null : detail });
  console.log((ok ? '  ✓ ' : '  ✗ ') + name + (detail === undefined ? '' : '  ' + JSON.stringify(detail).slice(0, 240)));
};

const b = await launchBrowser();
if (!b.ok) { console.log('无法启动浏览器：' + b.reason); process.exitCode = 1; }
else {
  const browser = b.browser;
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300)); });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e.message).slice(0, 300)));
  const shots = [];
  const shot = async (n) => { writeFileSync(join(OUT, 'm2-' + n + '.png'), await page.screenshot({ type: 'png' })); shots.push(n); };

  try {
    await page.goto(UI, { waitUntil: 'load', timeout: 30000 });
    await page.waitForSelector('#mode-badge', { timeout: 20000 });
    await page.waitForTimeout(1000);
    await page.fill('#search', TITLE);
    await page.waitForTimeout(1200);
    const rows = await page.$$eval('#experiment-list .exp', (e) => e.map((x) => x.innerText.replace(/\s+/g, ' ').trim().slice(0, 130)));
    add('按标题找到四候选实验', rows.length === 1, rows);
    await page.click('#experiment-list .exp:first-child button:has-text("打开")');
    await page.waitForSelector('#view-compare:not([hidden])', { timeout: 20000 });
    await page.waitForTimeout(3000);

    const shape = await page.$$eval('.frame-wrap', (els) => els.map((e) => ({
      head: e.querySelector('.frame-head') ? e.querySelector('.frame-head').innerText.replace(/\s+/g, ' ').trim().slice(0, 70) : '',
      hasIframe: Boolean(e.querySelector('iframe')),
      hasError: Boolean(e.querySelector('.frame-error')),
      x: Math.round(e.getBoundingClientRect().x),
      y: Math.round(e.getBoundingClientRect().y),
      w: Math.round(e.getBoundingClientRect().width),
    })));
    add('四个候选都渲染成卡片', shape.length === 4, { count: shape.length });
    const okCards = shape.filter((s) => s.hasIframe).length;
    const errCards = shape.filter((s) => s.hasError).length;
    add('三个成功的显示作品、一个失败的显示占位', okCards === 3 && errCards === 1, { okCards, errCards });
    add('四候选是两行两列（不是挤成一条）',
      new Set(shape.map((s) => s.y)).size === 2 && new Set(shape.map((s) => s.x)).size === 2,
      shape.map((s) => s.x + ',' + s.y));
    add('同一行的卡片等宽', (() => {
      const row1 = shape.filter((s) => s.y === shape[0].y).map((s) => s.w);
      const row2 = shape.filter((s) => s.y !== shape[0].y).map((s) => s.w);
      const same = (a) => a.every((v) => Math.abs(v - a[0]) <= 2);
      return same(row1) && same(row2);
    })(), shape.map((s) => s.w));
    await shot('four-candidates');

    // 独立重置仍然只影响一个（4 个候选下再确认一次）
    // 只有"有作品"的卡片才有 iframe —— 失败占位没有，所以数量应按 okCards 算，不是固定 4
    const ids = await page.$$eval('.frame-wrap iframe', (els) => els.map((e) => (e.src.match(/\/preview\/([^?]+)/) || [])[1]));
    add('每个作品有独立的预览地址', ids.length === okCards && new Set(ids).size === ids.length, ids);
    const frameFor = (id) => page.frames().find((f) => f.url().includes('/preview/' + id));
    for (const id of ids) await frameFor(id).evaluate(() => { window.__m2 = 'x'; });
    await page.click('.frame-wrap:nth-child(2) .frame-head button:has-text("重置")');
    await page.waitForTimeout(2500);
    const marks = [];
    for (const id of ids) marks.push(await frameFor(id).evaluate(() => window.__m2 ?? null).catch(() => '?'));
    add('四候选下重置只影响被点的那一个',
      marks.filter((m) => m === null).length === 1 && marks.filter((m) => m === 'x').length === ids.length - 1, marks);
    await shot('four-reset');

    // 视口切换对四个都生效
    await page.click('.seg-btn[data-vp="mobile"]');
    await page.waitForTimeout(1500);
    const widths = await page.$$eval('.frame-wrap iframe', (e) => e.map((x) => x.style.width));
    add('切手机视口对全部作品都生效', widths.length === ids.length && widths.every((w) => w === '390px'), widths);
    await shot('four-mobile');

    report.consoleErrors = consoleErrors;
    report.pageErrors = pageErrors;
    report.shots = shots;
    report.finishedAt = new Date().toISOString();
    report.ok = report.checks.every((c) => c.ok) && consoleErrors.length === 0 && pageErrors.length === 0;
  } catch (err) {
    report.error = String(err && err.stack || err).slice(0, 1200);
    try { await shot('99-error'); } catch { /* 忽略 */ }
    report.consoleErrors = consoleErrors;
    report.pageErrors = pageErrors;
    report.shots = shots;
    report.ok = false;
  } finally {
    await browser.close();
  }
}

const outPath = join(OUT, 'm2-four-walkthrough-' + Date.now() + '.json');
writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');
if (report.error) console.log('\n脚本中断：' + report.error.split('\n')[0]);
const passed = report.checks.filter((c) => c.ok).length;
console.log('\n' + passed + '/' + report.checks.length + ' 项通过；控制台错误 ' + (report.consoleErrors || []).length + '；页面异常 ' + (report.pageErrors || []).length);
console.log('证据：' + outPath);
process.exitCode = report.ok ? 0 : 1;
