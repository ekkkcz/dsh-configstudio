/**
 * 交付截图（v0.3.1 / 第三轮反馈）—— 从真实 DSH 实例抓代表图，零费用。
 * 只打开已有实验与设置页，**不发起任何模型调用**。
 *
 * 用法：
 *   node scripts/delivery-shots.mjs --base http://127.0.0.1:8902 --out "../交付区/v0.3.1/截图"
 *   （可选 --title 指定要用哪条真实实验；默认 "写个秦始皇骑北极熊"）
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from '../src/preview/browser.js';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const getArg = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
// 默认端口从 8901 改成 8902：8901 已被本机无关程序（本机另一个与本插件无关的程序）占用，
// 不带 --base 跑到别的服务上会得到莫名其妙的失败（2026-09-18 实测）。
const BASE = getArg('--base', 'http://127.0.0.1:8902');
const TITLE = getArg('--title', '写个秦始皇骑北极熊');
// 盲选那张图必须用一条**还没揭晓**的实验（揭晓不可逆）。
// 用户那条真实实验早就在手工试玩时揭晓了，所以单独指定一条。
const BLIND_TITLE = getArg('--blind-title', 'M2 实时监控验证');
const OUT = join(here, '..', getArg('--out', 'docs/evidence'));
mkdirSync(OUT, { recursive: true });

const b = await launchBrowser();
if (!b.ok) { console.log('无法启动浏览器：' + b.reason); process.exitCode = 1; }
else {
  const browser = b.browser;
  const saved = [];
  const skipped = [];
  const orig = await (await fetch(BASE + '/html-arena/api/settings')).json();

  /** 每种读法/尺寸单独开一个上下文，互不影响。 */
  const withPage = async (viewport, fn) => {
    const ctx = await browser.newContext({ viewport });
    const page = await ctx.newPage();
    const shot = async (n) => { writeFileSync(join(OUT, n + '.png'), await page.screenshot({ type: 'png' })); console.log('  ✓ ' + n); saved.push(n); };
    try {
      await page.goto(BASE + '/html-arena/api/ui', { waitUntil: 'load', timeout: 30000 });
      await page.waitForSelector('#mode-badge', { timeout: 20000 });
      await page.waitForTimeout(1400);
      await fn(page, shot);
    } finally { await ctx.close(); }
  };

  const openExperiment = async (page, title) => {
    if (title) { await page.fill('#search', title); await page.waitForTimeout(1400); }
    await page.click('#experiment-list .exp:first-child button:has-text("打开")');
    await page.waitForSelector('#view-compare:not([hidden])', { timeout: 20000 });
    await page.waitForTimeout(2800);
  };

  try {
    // ── 1) 设置页：外部能力的"探测到 / 已启用" ──────────────
    await withPage({ width: 1600, height: 1000 }, async (page, shot) => {
      await page.click('.tab[data-view="settings"]');
      await page.waitForSelector('#view-settings:not([hidden])', { timeout: 15000 });
      await page.waitForTimeout(900);
      await shot('01-设置-外部能力开关');
    });

    // ── 2) 对比页（宽屏）：用量摘要就在卡片上 ────────────────
    await withPage({ width: 1600, height: 1060 }, async (page, shot) => {
      await openExperiment(page, TITLE);
      await shot('02-对比页-用量与速度在卡片上');
      // 展开配置也来一张（反馈 4 的既有能力，本轮在里面补了盲选脱敏）
      await page.evaluate(() => { document.getElementById('compare-config').open = true; });
      await page.waitForTimeout(600);
      await page.evaluate(() => {
        const d = document.querySelector('#compare-details details.cfg-long');
        if (d) d.open = true;
        const box = document.getElementById('compare-config');
        window.scrollTo(0, Math.max(0, box.getBoundingClientRect().top + window.scrollY - 70));
      });
      await page.waitForTimeout(700);
      await shot('03-对比页-展开配置');
    });

    // ── 3) 窄视口（模拟用户那块 DPR 2.25 的屏）：仍然左右并排 ──
    await withPage({ width: 880, height: 1000 }, async (page, shot) => {
      await openExperiment(page, TITLE);
      await shot('04-窄视口880-仍然左右并排');
      // 1:1 横向展开 + 同步滚动
      await page.click('.seg-btn[data-mode="wide"]');
      await page.waitForTimeout(800);
      await page.evaluate(() => {
        const sc = [...document.querySelectorAll('.frame-wrap .scaler')];
        if (sc[0]) { sc[0].scrollLeft = Math.round((sc[0].scrollWidth - sc[0].clientWidth) * 0.45); sc[0].dispatchEvent(new Event('scroll', { bubbles: true })); }
      });
      await page.waitForTimeout(700);
      await shot('05-窄视口880-1比1横向展开与同步滚动');
    });

    // ── 4) 盲选：用量摘要与配置面板一起脱敏 ──────────────────
    // 揭晓不可逆：已揭晓的实验上隐藏开关已被移除，这时**不能**拍一张假装脱敏的图
    //（第一版就是这么拍出一张"标题写着已脱敏、其实全是明文"的交付截图）。
    await withPage({ width: 1600, height: 1060 }, async (page, shot) => {
      await openExperiment(page, BLIND_TITLE);
      const st = await page.evaluate(() => ({
        revealed: window.__htmlArena.state.revealed,
        blindBtnVisible: document.getElementById('btn-blind').hidden === false,
      }));
      if (st.revealed === true || !st.blindBtnVisible) {
        console.log('  · 「' + BLIND_TITLE + '」已揭晓，跳过盲选截图（揭晓不可逆）。'
          + '换一条未揭晓的实验：--blind-title "<标题>"；盲选脱敏的机器证据见 docs/evidence/m2-usage-metrics-*.json');
        skipped.push('06-对比页-盲选时用量与配置都脱敏（「' + BLIND_TITLE + '」已揭晓，跳过）');
        return;
      }
      const blind = await page.evaluate(() => window.__htmlArena.state.blind);
      if (blind !== true) { await page.click('#btn-blind'); await page.waitForTimeout(900); }
      const check = await page.evaluate(() => ({
        blind: window.__htmlArena.state.blind,
        strips: [...document.querySelectorAll('.usage-strip')].map((e) => e.getAttribute('data-blind')),
      }));
      if (check.blind !== true || !check.strips.every((v) => v === '1')) {
        throw new Error('盲选状态没生效，拒绝拍一张"看起来脱敏其实没有"的交付截图：' + JSON.stringify(check));
      }
      await shot('06-对比页-盲选时用量与配置都脱敏');
    });

    console.log(JSON.stringify({ out: OUT, saved, skipped }, null, 1));
  } catch (err) {
    console.log('中断：' + String(err && err.message || err).slice(0, 400));
    process.exitCode = 1;
  } finally {
    try {
      await fetch(BASE + '/html-arena/api/settings', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ capabilities: Object.fromEntries(orig.capabilities.map((c) => [c.key, c.enabled])) }),
      });
    } catch { /* 忽略 */ }
    await browser.close();
  }
}
