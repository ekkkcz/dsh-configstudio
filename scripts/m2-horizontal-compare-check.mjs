/**
 * 第三轮反馈 1：水平展开比对 —— 零费用布局实测。
 *
 * 用户原话："这个得加一个水平展开比对的功能"。
 * 根因（上一轮已定位）：web/app.css 的 @media (max-width: 900px) 把 .compare-grid 改成单列，
 * 用户截图是 1983 物理像素但 DPR≈2.25 → 约 880 CSS 像素 → 命中断点 → 并排比对被自动关掉。
 *
 * 本脚本断言（全部在真实 Chromium 里量 getBoundingClientRect，不看截图猜）：
 *   1. 900 / 880 / 700 / 480 px 下两个作品**左右并排**（不是上下堆叠），且同行等宽；
 *   2. 1:1 横向展开：卡片内可横向滚动（scrollWidth > clientWidth），作品缩放为 1（没被压小）；
 *   3. 同步滚动：拖动左边，右边的横向位置按比例跟随；
 *   4. 缩小看全：作品完整缩放进卡片（scale < 1 且宽度等于卡片宽度、无需拖动）。
 *
 * 用法：node scripts/m2-horizontal-compare-check.mjs --base http://127.0.0.1:8902 --title "写个秦始皇骑北极熊"
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from '../src/preview/browser.js';
import { writeEvidence } from './lib/redact.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const getArg = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const BASE = getArg('--base', 'http://127.0.0.1:8902');
const TITLE = getArg('--title', '');
const OUT = join(here, '..', 'docs', 'evidence');
mkdirSync(OUT, { recursive: true });
const UI = BASE + '/configstudio/api/ui';

const report = { startedAt: new Date().toISOString(), base: BASE, title: TITLE, checks: [] };
const add = (area, name, ok, detail) => {
  report.checks.push({ area, name, ok: Boolean(ok), detail: detail === undefined ? null : detail });
  console.log((ok ? '  ✓ ' : '  ✗ ') + '[' + area + '] ' + name + (detail === undefined ? '' : '  ' + JSON.stringify(detail).slice(0, 260)));
};

const WIDTHS = [1983, 900, 880, 700, 480];

const b = await launchBrowser();
if (!b.ok) { console.log('无法启动浏览器：' + b.reason); process.exitCode = 1; }
else {
  const browser = b.browser;
  const ctx = await browser.newContext({ viewport: { width: 1983, height: 1100 } });
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300)); });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e.message).slice(0, 300)));
  const shots = [];
  const shot = async (n) => { writeFileSync(join(OUT, 'm2-' + n + '.png'), await page.screenshot({ type: 'png' })); shots.push(n); };

  /** 量当前布局：卡片位置 / 缩放 / 可滚性 */
  const measure = () => page.evaluate(() => {
    const grid = document.getElementById('compare-grid');
    const wraps = [...document.querySelectorAll('.frame-wrap')].filter((e) => !e.hidden);
    return {
      cssWidth: window.innerWidth,
      dpr: window.devicePixelRatio,
      cols: grid ? getComputedStyle(grid).gridTemplateColumns : null,
      mode: grid ? grid.getAttribute('data-mode') : null,
      under900: window.matchMedia('(max-width: 900px)').matches,
      cards: wraps.map((e) => {
        const r = e.getBoundingClientRect();
        const sc = e.querySelector('.scaler');
        return {
          x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width),
          scale: sc ? Number(sc.getAttribute('data-scale')) : null,
          scalerScrollW: sc ? sc.scrollWidth : null,
          scalerClientW: sc ? sc.clientWidth : null,
          // 注意 scrollWidth 量的是**未经 transform 的布局盒**，所以"缩小看全"下它必然大于 clientWidth。
          // 判断"要不要拖"要看 overflow-x：hidden = 不用拖（缩进去了），auto = 要拖。
          overflowX: sc ? getComputedStyle(sc).overflowX : null,
          scrollLeft: sc ? sc.scrollLeft : null,
          // "留没留死白"：作品实际渲染宽度 vs 卡片可视宽度（用户截图指出的就是右边那一条空白）
          renderedW: sc ? Math.round(parseFloat(e.querySelector('iframe').style.width) * Number(sc.getAttribute('data-scale'))) : null,
          blankW: sc ? Math.round(sc.clientWidth - parseFloat(e.querySelector('iframe').style.width) * Number(sc.getAttribute('data-scale'))) : null,
        };
      }),
    };
  });

  const setMode = async (mode) => {
    const cur = await page.evaluate(() => document.getElementById('compare-grid').getAttribute('data-mode'));
    if (cur !== mode) {
      await page.click('.seg-btn[data-mode="' + mode + '"]');
      await page.waitForTimeout(700);
    }
  };

  try {
    await page.goto(UI, { waitUntil: 'load', timeout: 30000 });
    await page.waitForSelector('#mode-badge', { timeout: 20000 });
    await page.waitForTimeout(1200);
    if (TITLE) { await page.fill('#search', TITLE); await page.waitForTimeout(1400); }
    await page.click('#experiment-list .exp:first-child button:has-text("打开")');
    await page.waitForSelector('#view-compare:not([hidden])', { timeout: 20000 });
    await page.waitForTimeout(2500);

    const twoCards = await page.$$eval('.frame-wrap', (e) => e.length);
    add('准备', '打开了有两个候选的实验', twoCards === 2, { cards: twoCards });

    // ── 1) 窄视口必须仍然左右并排 ─────────────────────────────
    for (const w of WIDTHS) {
      await page.setViewportSize({ width: w, height: 1000 });
      await page.waitForTimeout(600);
      const m = await measure();
      const stacked = m.cards.length > 1 ? m.cards[0].y !== m.cards[1].y : null;
      const equalWidth = m.cards.length > 1 ? Math.abs(m.cards[0].w - m.cards[1].w) <= 2 : true;
      add('强制并排',
        w + 'px（' + (m.under900 ? '命中 ≤900 断点' : '未命中断点') + '）下左右并排、同行等宽',
        stacked === false && equalWidth,
        { cards: m.cards.map((c) => 'w' + c.w + '@' + c.x + ',' + c.y), cols: m.cols });
    }

    // ── 2) 1:1 横向展开：可横向滚动且不缩水 ───────────────────
    await page.setViewportSize({ width: 880, height: 1000 });
    await page.waitForTimeout(500);
    await setMode('wide');
    const wide = await measure();
    add('1:1 横向展开', '切到 1:1 后作品不再被缩小（scale = 1）',
      wide.cards.every((c) => c.scale === 1), wide.cards.map((c) => c.scale));
    add('1:1 横向展开', '卡片内容超出可视宽度、可横向拖动',
      wide.cards.every((c) => c.overflowX === 'auto' && c.scalerScrollW > c.scalerClientW + 100),
      wide.cards.map((c) => c.overflowX + ' ' + c.scalerScrollW + '>' + c.scalerClientW));
    add('1:1 横向展开', '仍然左右并排（没有因为切模式变成堆叠）',
      wide.cards[0].y === wide.cards[1].y, wide.cards.map((c) => c.x + ',' + c.y));
    await shot('horizontal-wide-880');

    // ── 3) 同步滚动：拖左边，右边跟随 ─────────────────────────
    const syncOn = await page.evaluate(() => { const b = document.getElementById('sync-scroll'); return b ? b.checked : null; });
    if (syncOn !== true) { await page.click('#sync-scroll'); await page.waitForTimeout(300); }
    const targetRatio = 0.6;
    const scrolled = await page.evaluate((ratio) => {
      const sc = [...document.querySelectorAll('.frame-wrap .scaler')];
      const first = sc[0];
      const max = first.scrollWidth - first.clientWidth;
      first.scrollLeft = Math.round(max * ratio);
      first.dispatchEvent(new Event('scroll', { bubbles: true }));
      return { max, left: first.scrollLeft };
    }, targetRatio);
    await page.waitForTimeout(500);
    const after = await page.$$eval('.frame-wrap .scaler', (els) => els.map((e) => ({
      left: e.scrollLeft, max: e.scrollWidth - e.clientWidth,
    })));
    const ratios = after.map((a) => a.max > 0 ? a.left / a.max : 0);
    add('同步滚动', '拖动左边后右边按同一比例跟随',
      ratios.length === 2 && Math.abs(ratios[0] - ratios[1]) < 0.08,
      { requested: targetRatio, ratios: ratios.map((r) => Math.round(r * 100) / 100), after });
    await shot('horizontal-wide-synced');

    // 反向：拖右边，左边跟随（不能只是单向）
    await page.evaluate(() => {
      const sc = [...document.querySelectorAll('.frame-wrap .scaler')];
      const second = sc[sc.length - 1];
      const max = second.scrollWidth - second.clientWidth;
      second.scrollLeft = Math.round(max * 0.15);
      second.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    await page.waitForTimeout(500);
    const back = await page.$$eval('.frame-wrap .scaler', (els) => els.map((e) => e.scrollWidth - e.clientWidth > 0 ? e.scrollLeft / (e.scrollWidth - e.clientWidth) : 0));
    add('同步滚动', '反向拖动右边，左边也跟随（不是单向）',
      back.length === 2 && Math.abs(back[0] - back[1]) < 0.08,
      back.map((r) => Math.round(r * 100) / 100));

    // 关掉同步滚动后不应再联动
    await page.click('#sync-scroll');
    await page.waitForTimeout(300);
    const noSync = await page.evaluate(() => {
      const sc = [...document.querySelectorAll('.frame-wrap .scaler')];
      const first = sc[0], second = sc[1];
      second.scrollLeft = 0;
      first.scrollLeft = Math.round((first.scrollWidth - first.clientWidth) * 0.9);
      first.dispatchEvent(new Event('scroll', { bubbles: true }));
      return { secondBefore: second.scrollLeft };
    });
    await page.waitForTimeout(400);
    const stillZero = await page.evaluate(() => {
      const sc = [...document.querySelectorAll('.frame-wrap .scaler')];
      return sc[1].scrollLeft;
    });
    add('同步滚动', '关掉开关后左右不再联动（开关真的生效）',
      stillZero === noSync.secondBefore && stillZero === 0, { before: noSync.secondBefore, after: stillZero });
    await page.click('#sync-scroll');   // 还原
    await page.waitForTimeout(250);

    // ── 3.5) 手机逻辑视口：不留死白（用户截图指出的缺陷）───────
    // 手机逻辑视口只有 390px，而卡片通常有 400–490px。若缩放被卡在 1:1，
    // 作品只画 390px 宽、右边剩一条死白。这里在三种窗口宽度下都断言"撑满"。
    await setMode('fit');
    for (const w of [1600, 1024, 880]) {
      await page.setViewportSize({ width: w, height: 1000 });
      await page.waitForTimeout(600);
      await page.click('.seg-btn[data-vp="mobile"]');
      await page.waitForTimeout(900);
      const mm = await measure();
      add('手机视口不留空白',
        w + 'px 窗口下手机视口（390px 逻辑宽）撑满卡片，右侧无死白',
        mm.cards.every((c) => c.blankW !== null && Math.abs(c.blankW) <= 2 && c.renderedW >= c.scalerClientW - 2),
        mm.cards.map((c) => 'card' + c.scalerClientW + ' rendered' + c.renderedW + ' blank' + c.blankW + ' scale' + c.scale));
    }
    // 1:1 模式在手机视口下也没有可滚内容 → 同样不该留白
    await page.click('.seg-btn[data-mode="wide"]');
    await page.waitForTimeout(800);
    const wideMobile = await measure();
    add('手机视口不留空白', '手机视口下切到 1:1 也不留死白（本来就没有可滚内容）',
      wideMobile.cards.every((c) => Math.abs(c.blankW) <= 2),
      wideMobile.cards.map((c) => 'blank' + c.blankW + ' scale' + c.scale));
    await page.click('.seg-btn[data-mode="fit"]');
    await page.waitForTimeout(600);
    await page.click('.seg-btn[data-vp="desktop"]');
    await page.waitForTimeout(700);
    await page.setViewportSize({ width: 880, height: 1000 });
    await page.waitForTimeout(600);

    // ── 4) 缩小看全：完整放进卡片，不用拖 ─────────────────────
    await setMode('fit');
    const fit = await measure();
    add('缩小看全', '作品被等比缩小放进卡片（scale < 1），不需要横向拖动（overflow 藏住溢出）',
      fit.cards.every((c) => c.scale !== null && c.scale < 1 && c.overflowX === 'hidden'),
      fit.cards.map((c) => 'scale=' + c.scale + ' overflowX=' + c.overflowX));
    add('缩小看全', '缩放进卡片后卡片高度跟着缩小（不留大片空白）',
      fit.cards.every((c) => c.scalerClientW > 0) && (await page.evaluate(() => {
        const sc = document.querySelector('.frame-wrap .scaler');
        const vp = document.querySelector('.frame-wrap iframe');
        const want = Math.round(parseFloat(vp.style.height) * Number(sc.getAttribute('data-scale')));
        return Math.abs(parseInt(sc.style.height, 10) - want) <= 2;
      })), fit.cards.map((c) => c.scale));
    add('缩小看全', '切回缩小看全后作品没有被重建（iframe 还在原卡片里）',
      await page.$$eval('.frame-wrap iframe', (e) => e.length) === 2);
    await shot('horizontal-fit-880');

    // ── 5) 全屏不再改网格列数（旧实现会与"始终并排"打架）─────
    await page.click('.frame-wrap:nth-child(1) .frame-head button:has-text("全屏")');
    await page.waitForTimeout(900);
    const fs = await page.evaluate(() => {
      const grid = document.getElementById('compare-grid');
      return {
        cols: getComputedStyle(grid).gridTemplateColumns,
        visible: [...document.querySelectorAll('.frame-wrap')].filter((e) => !e.hidden).length,
      };
    });
    add('全屏', '全屏只隐藏别的卡片，**不把网格改成单列**',
      fs.visible === 1 && (fs.cols.match(/px/g) || []).length === 2, fs);
    await shot('horizontal-fullscreen');
    await page.click('.frame-wrap:not([hidden]) .frame-head button:has-text("退出全屏")');
    await page.waitForTimeout(800);
    add('全屏', '退出全屏后恢复两个作品',
      await page.$$eval('.frame-wrap', (e) => e.filter((x) => !x.hidden).length) === 2);

    // ── 6) 移动端真实 DPR 场景（模拟用户那块屏）──────────────
    const dprCtx = await browser.newContext({ viewport: { width: 880, height: 900 }, deviceScaleFactor: 2.25 });
    const dprPage = await dprCtx.newPage();
    const dprErr = [];
    dprPage.on('console', (m) => { if (m.type() === 'error') dprErr.push(m.text().slice(0, 200)); });
    await dprPage.goto(UI, { waitUntil: 'load', timeout: 30000 });
    await dprPage.waitForSelector('#mode-badge', { timeout: 20000 });
    await dprPage.waitForTimeout(1000);
    if (TITLE) { await dprPage.fill('#search', TITLE); await dprPage.waitForTimeout(1400); }
    await dprPage.click('#experiment-list .exp:first-child button:has-text("打开")');
    await dprPage.waitForSelector('#view-compare:not([hidden])', { timeout: 20000 });
    await dprPage.waitForTimeout(2200);
    const dprShape = await dprPage.evaluate(() => {
      const wraps = [...document.querySelectorAll('.frame-wrap')].filter((e) => !e.hidden);
      return {
        dpr: window.devicePixelRatio, cssWidth: window.innerWidth,
        ys: wraps.map((e) => Math.round(e.getBoundingClientRect().y)),
        xs: wraps.map((e) => Math.round(e.getBoundingClientRect().x)),
      };
    });
    add('高 DPI 复现', 'DPR 2.25 + 880 CSS 像素（= 用户那块屏）下仍然左右并排',
      dprShape.ys.length === 2 && dprShape.ys[0] === dprShape.ys[1] && dprShape.xs[0] !== dprShape.xs[1], dprShape);
    await dprPage.screenshot({ path: join(OUT, 'm2-horizontal-dpr225.png') });
    shots.push('horizontal-dpr225');
    await dprCtx.close();

    report.consoleErrors = consoleErrors;
    report.pageErrors = pageErrors;
    report.dprConsoleErrors = dprErr;
    report.shots = shots;
    report.finishedAt = new Date().toISOString();
    report.ok = report.checks.every((c) => c.ok) && consoleErrors.length === 0 && pageErrors.length === 0 && dprErr.length === 0;
  } catch (err) {
    report.error = String(err && err.stack || err).slice(0, 1500);
    try { await shot('99-horizontal-error'); } catch { /* 忽略 */ }
    report.consoleErrors = consoleErrors;
    report.pageErrors = pageErrors;
    report.ok = false;
  } finally {
    await browser.close();
  }
}

const outPath = join(OUT, 'm2-horizontal-compare-' + Date.now() + '.json');
writeEvidence(outPath, report);
if (report.error) console.log('\n脚本中断：' + report.error.split('\n')[0]);
const passed = report.checks.filter((c) => c.ok).length;
console.log('\n' + passed + '/' + report.checks.length + ' 项通过；控制台错误 ' + (report.consoleErrors || []).length + '；页面异常 ' + (report.pageErrors || []).length);
console.log('证据：' + outPath);
process.exitCode = report.ok ? 0 : 1;
