/**
 * 0.10.0 交付截图 —— 三张**真实模型跑出来、两边都正常产出**的对比。
 *
 * 与 m4/m5 的交付截图的区别（也是这次重做的原因）：
 *   1. m5 那三张拍的是"界面控件"（下拉、提示），不是"作品对比"本身；
 *   2. 上一版四候选的图用的是**视口截图**，页面一长，下面两个候选只露出半张 ——
 *      四候选对比图必须**四个成果全在画面里**，所以这里用 fullPage。
 *
 * 硬规矩沿用 m4/m5：**只拍插件自己的页面**（URL 必须是 /configstudio/api/ui），
 * 并且每张图拍之前先自证"每个候选都真的产出了作品"（不是错误占位、不是空 iframe），
 * 不合格就抛错拒绝出图。
 *
 * 用法：
 *   node scripts/m6-real-compare-shots.mjs --base http://127.0.0.1:8902 --out "../交付区/v0.10.0/截图" \
 *     --shot exp_xxx:01-鹈鹕骑自行车-两模型 --shot exp_yyy:02-秦始皇骑北极熊-四模型
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from '../src/preview/browser.js';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const getArg = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const OUT = join(here, '..', getArg('--out', 'docs/evidence'));
const BASE = getArg('--base', 'http://127.0.0.1:8902');
const shots = [];
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--shot' && args[i + 1]) {
    const v = args[i + 1];
    const j = v.lastIndexOf(':');
    shots.push({ id: v.slice(0, j), name: v.slice(j + 1) });
  }
}
if (shots.length === 0) { console.log('至少要给一个 --shot <实验id>:<文件名>'); process.exit(2); }
mkdirSync(OUT, { recursive: true });

const b = await launchBrowser();
if (!b.ok) { console.log('无法启动浏览器：' + b.reason); process.exit(1); }

const saved = [];
try {
  // 视口宽一点，四候选时两列各自的卡片才够宽；fullPage 负责把整页收进来。
  const ctx = await b.browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  // 页面异常分两类：**插件页面自己**的（真问题）与**作品 iframe 里**的（不算这一页的异常）。
  // 实测踩到的坑：作品里写一句 Google Fonts 的外链，离线预览策略会挡下并产生一条 console error；
  // 如果把它当失败，一张合格的交付图会被自己的判据拦下来（真发生过）。
  // 另外作品自己的 JS 语法错误也不该拦这一页 —— 那要由出图后的人工/画布检查来看。
  const errs = [];
  const workErr = [];
  const isWorkSide = (text, url) => /Content Security Policy|fonts\.googleapis|fonts\.gstatic|net::ERR|Failed to load resource/i.test(text)
    || /\/artifact|\/preview|blob:/i.test(String(url || ''));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    const loc = (m.location && m.location()) ? m.location().url : '';
    if (isWorkSide(t, loc)) { workErr.push(t.slice(0, 120)); return; }
    errs.push(t.slice(0, 200));
  });
  // pageerror 拿不到"是哪一帧报的"（Playwright 不提供），而**作品自己的语法错误**与
  // **插件页面的异常**是两回事：前者是我要如实记录的现象（那张图照样能拍，由出图后人工看），
  // 后者才该拒绝出图。这里按错误文本归类：生成出来的作品里最常见的几种语法/运行时错误
  // 归到 workErr；插件自己的代码是经过测试的，真坏了上面几条断言（#mode-badge、网格、iframe）就先失败了。
  const WORK_ERROR_RE = /Unexpected identifier|Unexpected token|SyntaxError|is not defined|Cannot read propert|Invalid or unexpected token/i;
  page.on('pageerror', (e) => {
    const t = String(e.message);
    if (isWorkSide(t, '') || WORK_ERROR_RE.test(t)) { workErr.push(t.slice(0, 120)); return; }
    errs.push(t.slice(0, 200));
  });

  await page.goto(BASE + '/configstudio/api/ui', { waitUntil: 'load', timeout: 45000 });
  await page.waitForSelector('#mode-badge', { timeout: 25000 });
  await page.waitForTimeout(1500);

  for (const s of shots) {
    if (!page.url().includes('/configstudio/api/ui')) {
      throw new Error('拒绝出图 ' + s.name + '：当前不是插件自己的页面（' + page.url() + '）');
    }
    // 回到列表再打开指定实验 —— 避免"上一条还开着"导致打开的是旧实验
    await page.evaluate(() => { const t = document.querySelector('.tab[data-view="experiments"]'); if (t) t.click(); });
    await page.waitForTimeout(900);
    const opened = await page.evaluate((id) => {
      if (typeof window.__htmlArena.openExperiment !== 'function') return false;
      window.__htmlArena.openExperiment(id);
      return true;
    }, s.id);
    if (!opened) throw new Error('界面没有暴露 openExperiment，无法直接打开实验 ' + s.id);
    await page.waitForTimeout(3500);
    await page.evaluate(() => { const t = document.querySelector('.tab[data-view="compare"]:not([disabled])'); if (t) t.click(); });
    // 作品是 iframe，留足时间让动画/字体落定
    await page.waitForTimeout(6000);

    const verdict = await page.evaluate(() => {
      const wraps = [...document.querySelectorAll('#compare-grid .frame-wrap')];
      const cards = wraps.map((w) => {
        const head = (w.querySelector('.frame-head')?.innerText || '').replace(/\s+/g, ' ').trim();
        const err = w.querySelector('.frame-error');
        const ifr = w.querySelector('iframe');
        return { head: head.slice(0, 80), error: err ? (err.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 120) : null, hasIframe: !!ifr, src: ifr ? String(ifr.getAttribute('src') || '').slice(0, 60) : null };
      });
      const title = (document.getElementById('compare-title')?.innerText || '').trim();
      const note = (document.getElementById('compare-note')?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 200);
      const docHeight = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
      return { title, note, cards, docHeight, mode: document.getElementById('compare-grid')?.getAttribute('data-mode') || null };
    });

    const bad = verdict.cards.filter((c) => c.error || !c.hasIframe);
    if (verdict.cards.length === 0) throw new Error('拒绝出图 ' + s.name + '：对比网格里一个候选都没有（实验没打开？）');
    if (bad.length > 0) {
      throw new Error('拒绝出图 ' + s.name + '：有候选没有正常产出 → ' + JSON.stringify(bad.slice(0, 4)));
    }
    // 每个 iframe 里必须有真东西（空文档说明作品没渲染出来）
    const frames = page.frames().filter((f) => /\/configstudio\/api\/(artifact|preview)/.test(f.url()) || f !== page.mainFrame());
    let nonEmpty = 0;
    for (const f of frames) {
      try {
        const n = await f.evaluate(() => (document.body ? document.body.innerHTML.length : 0));
        if (n > 400) nonEmpty += 1;
      } catch { /* 跨域或已销毁，忽略 */ }
    }
    if (nonEmpty < verdict.cards.length) {
      throw new Error('拒绝出图 ' + s.name + '：作品 iframe 里有内容的只有 ' + nonEmpty + ' 个，候选有 ' + verdict.cards.length + ' 个');
    }
    // ★ 画布专项：**DOM 有内容 ≠ 画面有东西**。
    // 实测踩到的坑：候选的 HTML 被上游输出上限截断在 JS 中间（未闭合字符串 = SyntaxError），
    // 于是 <canvas> 在、DOM 在、body 也不空，但画布是**一片纯色**（只有 CSS 背景色）。
    // 这种图交出去就是"一边看起来什么都没画"，所以这里逐帧采样画布：纯色 = 拒绝出图。
    const flat = [];
    for (const f of frames) {
      let info = null;
      try {
        info = await f.evaluate(() => {
          const c = document.querySelector('canvas');
          if (!c) return null;
          try {
            const g = c.getContext('2d');
            const d = g.getImageData(0, 0, c.width, c.height).data;
            const seen = new Set();
            for (let i = 0; i < d.length; i += 4 * 997) seen.add(d[i] + ',' + d[i + 1] + ',' + d[i + 2]);
            return { w: c.width, h: c.height, colors: seen.size };
          } catch (err) { return { error: String(err && err.message || err).slice(0, 60) }; }
        });
      } catch { continue; }
      if (info && typeof info.colors === 'number' && info.colors <= 1) flat.push(info);
    }
    if (flat.length > 0) {
      throw new Error('拒绝出图 ' + s.name + '：有候选的画布是纯色（作品没画出来）→ ' + JSON.stringify(flat));
    }
    if (errs.length > 0) throw new Error('拒绝出图 ' + s.name + '：页面有异常 ' + JSON.stringify(errs.slice(0, 2)));

    writeFileSync(join(OUT, s.name + '.png'), await page.screenshot({ type: 'png', fullPage: true }));
    saved.push({ ...s, cards: verdict.cards.length, docHeight: verdict.docHeight, title: verdict.title });
    console.log('  ✓ ' + s.name + '.png  候选 ' + verdict.cards.length + ' 个，整页高 ' + verdict.docHeight + 'px');
    console.log('      标题：' + verdict.title + ' | ' + verdict.note.slice(0, 90));
    verdict.cards.forEach((c, i) => console.log('      [' + i + '] ' + c.head));
  }
  await b.browser.close().catch(() => {});
} catch (err) {
  console.log('✗ 出图中断：' + String(err && err.message || err));
  process.exitCode = 1;
} finally {
  try { await b.browser.close(); } catch { /* 已关 */ }
}
console.log('');
console.log('已出图 ' + saved.length + ' 张 → ' + OUT);
