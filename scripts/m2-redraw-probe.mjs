/**
 * 验证「运行面板每轮轮询都会重建 DOM」——这是"推理过程点开就被自动收回"的根因。
 * 用模拟模型（零费用）：给一个节点打标记，等 1.5 秒再找，标记还在说明节点被复用，不在就是被重建。
 * 用法：node scripts/m2-redraw-probe.mjs [base]
 */
import { launchBrowser } from '../src/preview/browser.js';

const BASE = process.argv[2] || 'http://127.0.0.1:8790';
const b = await launchBrowser();
if (!b.ok) { console.log('无法启动浏览器：' + b.reason); process.exitCode = 1; }
else {
  const browser = b.browser;
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(BASE + '/configstudio/api/ui', { waitUntil: 'load', timeout: 30000 });
  await page.waitForSelector('#mode-badge', { timeout: 20000 });
  await page.waitForTimeout(1500);

  // 起一轮模拟生成
  await page.click('.tab[data-view="new"]');
  await page.waitForTimeout(400);
  await page.fill('#task-prompt', '做一个只有一行字的页面');
  await page.fill('#task-title', 'M2 重绘探针');
  await page.click('#btn-start');
  await page.waitForSelector('#view-run:not([hidden])', { timeout: 30000 });
  await page.waitForTimeout(1500);

  // 在运行面板的候选卡上打标记，并模拟"用户展开了推理过程"
  const before = await page.evaluate(() => {
    const cards = document.querySelectorAll('#run-cards .cand');
    if (!cards.length) return { cards: 0 };
    cards[0].setAttribute('data-probe', 'marked');
    // 造一个 details 并展开，模拟用户点开推理过程
    const d = document.createElement('details');
    d.className = 'more live-reasoning';
    d.open = true;
    d.setAttribute('data-probe-details', '1');
    d.appendChild(document.createElement('summary')).textContent = '推理过程（探针）';
    cards[0].appendChild(d);
    return { cards: cards.length, marked: true, open: d.open };
  });

  await page.waitForTimeout(1600); // 跨过至少两轮 700ms 轮询

  const after = await page.evaluate(() => {
    const cards = document.querySelectorAll('#run-cards .cand');
    const markedEl = cards[0] ? cards[0].getAttribute('data-probe') : null;
    const probeDetails = document.querySelector('[data-probe-details]');
    return {
      cards: cards.length,
      markerSurvived: markedEl === 'marked',
      probeDetailsExists: Boolean(probeDetails),
      probeDetailsOpen: probeDetails ? probeDetails.open : null,
    };
  });

  console.log(JSON.stringify({
    before, after,
    verdict: after.markerSurvived
      ? '节点被复用（轮询是原地更新）'
      : '节点每轮被重建（details 的展开状态必然丢失）',
  }, null, 1));
  await browser.close();
}
