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
    await page.goto(BASE + '/configstudio/api/ui', { waitUntil: 'load', timeout: 30000 });
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
    // 展开"原始输出与提取结果"并确认它真的开着（第一版没确认，结果截到的是收起状态）
    const rawOpen = await page.evaluate(() => {
      const d = document.querySelector('#run-raw-panel');
      if (!d) return { ok: false, reason: 'no details' };
      d.open = true;
      return { ok: d.open, rows: d.querySelectorAll('.raw-row').length };
    });
    console.log('  原始输出折叠区：open=' + rawOpen.ok + '，轮次行数=' + rawOpen.rows);
    await page.waitForTimeout(700);
    await page.evaluate(() => {
      const d = document.querySelector('#run-raw-panel');
      d.open = true;
      // 这个折叠区是页面最后一个元素，"滚到顶部"滚不动时浏览器会把它留在底部；
      // 直接算一个偏移，保证标题与若干轮次行都在画面里。
      const y = d.getBoundingClientRect().top + window.scrollY - 120;
      window.scrollTo(0, Math.max(0, y));
    });
    await page.waitForTimeout(700);
    const stillOpen = await page.evaluate(() => document.querySelector('#run-raw-panel').open);
    if (!stillOpen) console.log('  ⚠ 折叠区在截图前被收起了（这是个真问题，不是脚本问题）');
    await shot('06-运行面板-按轮次列出每次尝试');
  } catch (err) {
    console.log('中断：' + String(err && err.message || err).slice(0, 300));
    process.exitCode = 1;
  } finally { await browser.close(); }
}
