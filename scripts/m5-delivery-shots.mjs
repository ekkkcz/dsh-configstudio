/**
 * 0.7.0 交付截图 —— 用**那次真实对比留下的实验**，拍"缺口修好了"的样子。全部零费用。
 *
 * 为什么要在真实数据上拍：这次修的是"超时提示让用户做一件做不到的事"，
 * 而那个提示**本身就是真实模型跑出来的**（鹈鹕那道题，候选 B 卡在 180 秒上、0 字节）。
 * 用模拟数据拍一张"超时"说明不了问题 —— 得是那条真的记录。
 *
 * 硬规矩沿用 m4-delivery-shots：**只拍插件自己的页面**（URL 必须是 /configstudio/api/ui），
 * 拍之前先自证前置条件，不合格就抛错拒绝出图（绝不拍 DSH 外壳）。
 *
 * 用法：node scripts/m5-delivery-shots.mjs --out "../交付区/v0.7.0/截图" --base http://127.0.0.1:8902
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
mkdirSync(OUT, { recursive: true });

const saved = [];
const b = await launchBrowser();
if (!b.ok) { console.log('无法启动浏览器：' + b.reason); process.exit(1); }

function makeShooter(page, errs) {
  return async (name, assertFn) => {
    const url = page.url();
    if (!url.includes('/configstudio/api/ui')) {
      throw new Error('拒绝出图 ' + name + '：当前不是插件自己的页面（' + url + '）—— 交付截图不拍 DSH 外壳');
    }
    const verdict = await assertFn();
    if (verdict && verdict.ok === false) throw new Error('拒绝出图 ' + name + '：' + (verdict.reason || '前置条件不满足'));
    if (errs.length > 0) throw new Error('拒绝出图 ' + name + '：页面有异常 ' + JSON.stringify(errs.slice(0, 2)));
    writeFileSync(join(OUT, name + '.png'), await page.screenshot({ type: 'png' }));
    console.log('  ✓ ' + name + (verdict && verdict.note ? '  —— ' + verdict.note : ''));
    saved.push(name);
  };
}

try {
  const ctx = await b.browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 200)); });
  page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 200)));
  const shot = makeShooter(page, errs);

  await page.goto(BASE + '/configstudio/api/ui', { waitUntil: 'load', timeout: 45000 });
  await page.waitForSelector('#mode-badge', { timeout: 25000 });
  await page.waitForTimeout(2000);

  // ── 1) 新建对比页：以前这里**没有**运行上限 ────────────────────────────
  await page.click('.tab[data-view="new"]');
  await page.waitForTimeout(800);
  await shot('01-新建对比页多了运行上限下拉', async () => {
    const opts = await page.$$eval('#timeout option', (els) => els.map((e) => e.textContent));
    if (opts.length < 6) return { ok: false, reason: '运行上限下拉没渲染出来：' + JSON.stringify(opts) };
    const note = String(await page.textContent('#timeout-note'));
    if (!/最多等/.test(note)) return { ok: false, reason: '控件边上没有说明：' + note };
    return { ok: true, note: opts.join(' / ') };
  });

  // 顺带拍一张"思考档位开高时默认值自动变大"——这是修法的第 2 条要求。
  //
  // 不去换 provider：交付实例（8902）用的是**真实模型目录**，上面没有模拟 provider；
  // 换 provider 这一下会让出图依赖"这个实例恰好装了模拟模型"。
  // 这里改的是**候选草稿上的档位**（等价于用户在下拉里选 max），
  // 而默认值只由草稿的档位决定 —— 于是任何实例上都能稳定复现同一张图。
  await page.evaluate(() => {
    const s = window.__htmlArena.state;
    s.candidates.forEach((c) => { c.reasoningEffort = 'max'; });
    if (typeof arenaRenderTimeoutRow === 'function') arenaRenderTimeoutRow();
  });
  await page.waitForTimeout(400);
  await shot('02-思考档位开高时默认值自动变大', async () => {
    const note = String(await page.textContent('#timeout-note'));
    const first = await page.$eval('#timeout option', (e) => e.textContent);
    if (!/15 分钟/.test(note + first)) {
      return { ok: false, reason: 'max 档没有把默认值抬到 15 分钟：' + note + ' / ' + first };
    }
    return { ok: true, note: first + ' —— ' + note.slice(0, 60) };
  });

  // ── 2) 真实那次对比：超时提示现在写得清清楚楚 ─────────────────────────
  await page.evaluate(() => { document.querySelector('.tab[data-view="experiments"]').click(); });
  await page.waitForTimeout(1500);
  // 用**实验 id 直接打开**那条真实对比，而不是按标题找：
  // 标题一旦被改（或被复制多份），按文字找就会挑错那一条，出出来的图也就不是"那次真实对比"了。
  // id 来自 docs/evidence/pelican-compare.json（真实模型跑出来的那次，用户上一轮的现场）。
  const PELICAN_ID = 'exp_5da2cf31cc3a43d08826';
  const opened = await page.evaluate((id) => {
    if (typeof window.__htmlArena.openExperiment !== 'function') return false;
    window.__htmlArena.openExperiment(id);
    return true;
  }, PELICAN_ID);
  if (!opened) throw new Error('界面没有暴露 openExperiment，无法直接打开指定的实验');
  await page.waitForTimeout(4500);
  await page.evaluate(() => { const t = document.querySelector('.tab[data-view="compare"]:not([disabled])'); if (t) t.click(); });
  await page.waitForTimeout(5000);

  await shot('03-真实超时现场-提示指路并可就地重跑', async () => {
    const text = await page.evaluate(() => (document.getElementById('compare-grid').innerText || '').replace(/\s+/g, ' '));
    // 前置条件必须钉死是"那条真实的超时现场"，否则这张图说明不了任何事
    if (!/deepseek-v4-pro/.test(text)) {
      return { ok: false, reason: '打开的不是那条真实对比（看不到 deepseek-v4-pro）：' + text.slice(0, 120) };
    }
    if (!/超时|timed_out/.test(text)) return { ok: false, reason: '这一页上没有超时的候选：' + text.slice(0, 120) };
    if (!/运行上限/.test(text)) return { ok: false, reason: '超时提示里没有提到运行上限：' + text.slice(0, 160) };
    const sel = await page.inputValue('#compare-timeout');
    if (!sel) return { ok: false, reason: '对比页头部的运行上限控件没有值' };
    // 控件的值是毫秒（option value 就是 ms），如实换算再写进证据，别把 180000 说成"秒"
    return { ok: true, note: '候选 B 超时；对比页上限=' + sel + ' ms（' + (Number(sel) / 60000) + ' 分钟，即当初那个默认值）；提示含「运行上限」' };
  });

  await b.browser.close().catch(() => {});
} catch (err) {
  console.log('✗ 出图中断：' + String(err && err.message || err));
  process.exitCode = 1;
} finally {
  try { await b.browser.close(); } catch { /* 已关 */ }
}
console.log('');
console.log('已出图 ' + saved.length + ' 张 → ' + OUT);
