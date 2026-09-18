/**
 * 交付截图补充：跑一轮模拟生成，抓"运行面板（第 N 轮 + 追加一轮输入框）"。
 * 走开发服务器（模拟模型，零费用）。
 * 用法：node scripts/delivery-shots-run.mjs --base http://127.0.0.1:8790 --out "../交付区/v0.3.0/截图"
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from '../src/preview/browser.js';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const getArg = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const BASE = getArg('--base', 'http://127.0.0.1:8790');
const OUT = join(here, '..', getArg('--out', 'docs/evidence'));
mkdirSync(OUT, { recursive: true });

const b = await launchBrowser();
if (!b.ok) { console.log('无法启动浏览器：' + b.reason); process.exitCode = 1; }
else {
  const browser = b.browser;
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
  const page = await ctx.newPage();
  const shot = async (n) => { writeFileSync(join(OUT, n + '.png'), await page.screenshot({ type: 'png' })); console.log('  ✓ ' + n); };
  try {
    await page.goto(BASE + '/html-arena/api/ui', { waitUntil: 'load', timeout: 30000 });
    await page.waitForSelector('#mode-badge', { timeout: 20000 });
    await page.waitForTimeout(1400);

    await page.click('.tab[data-view="new"]');
    await page.waitForTimeout(500);
    await page.fill('#task-prompt', '做一个只有一行大字的页面');
    await page.fill('#task-title', 'M2 追加轮次（交付截图）');
    // 用会推理的模拟模型，顺带让"推理过程"出现在图上
    await page.selectOption('#candidates .cand:nth-child(1) select[data-role="provider"]', 'sim-reasoning');
    await page.waitForTimeout(900);
    await page.click('#btn-start');
    await page.waitForSelector('#view-run:not([hidden])', { timeout: 30000 });

    // 生成中：实时输出 + 推理过程
    await page.waitForSelector('#run-cards details.live-reasoning', { timeout: 40000 });
    await page.evaluate(() => {
      const d = document.querySelector('#run-cards details.live-reasoning');
      if (d) d.open = true;
    });
    await page.waitForTimeout(900);
    await shot('04-运行面板-实时输出与推理过程');

    // 等第一轮结束，追加一轮
    await page.waitForFunction(() => { const x = document.getElementById('btn-goto-compare'); return x && !x.disabled; }, { timeout: 120000 });
    await page.waitForTimeout(800);
    await page.fill('#round-note', '把那一行大字改成红色，并在下面加一行小字说明。');
    await page.click('#btn-add-round');
    await page.waitForFunction(() => {
      const st = window.__htmlArena.state;
      return st.current && st.current.attempts.some((a) => a.attemptNo >= 2);
    }, { timeout: 60000 });
    await page.waitForTimeout(1000);
    await page.evaluate(() => { document.getElementById('round-box').scrollIntoView({ block: 'center' }); });
    await page.waitForTimeout(500);
    await shot('05-运行面板-追加一轮');

    await page.waitForFunction(() => { const x = document.getElementById('btn-goto-compare'); return x && !x.disabled; }, { timeout: 120000 });
    await page.waitForTimeout(900);
    await page.evaluate(() => { document.querySelector('#view-run details.more').open = true; });
    await page.waitForTimeout(500);
    await page.evaluate(() => { document.querySelector('#view-run details.more').scrollIntoView({ block: 'start' }); });
    await page.waitForTimeout(500);
    await shot('06-运行面板-按轮次列出每次尝试');
  } catch (err) {
    console.log('中断：' + String(err && err.message || err).slice(0, 300));
    process.exitCode = 1;
  } finally { await browser.close(); }
}
