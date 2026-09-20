/**
 * 只读核对：确认真实 DSH 里界面加载的是 0.2.0 的新功能（预设、优化器、实时流接口）。
 * 不发模型调用。用法：node scripts/m2-verify-ui.mjs [base]
 */
import { launchBrowser } from '../src/preview/browser.js';

const BASE = process.argv[2] || 'http://127.0.0.1:8901';
const b = await launchBrowser();
if (!b.ok) { console.log('无法启动浏览器：' + b.reason); process.exitCode = 1; }
else {
  const browser = b.browser;
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 150)));
  await page.goto(BASE + '/configstudio/api/ui', { waitUntil: 'load', timeout: 30000 });
  await page.waitForSelector('#mode-badge', { timeout: 20000 });
  await page.waitForTimeout(1500);
  await page.click('.tab[data-view="new"]');
  await page.waitForTimeout(600);
  await page.evaluate(() => { const d = document.querySelector('#view-new details.more'); if (d) d.open = true; });
  await page.waitForTimeout(900);

  const presets = await page.$$eval('#requirement-presets .chip-btn', (e) => e.map((x) => x.textContent.trim()));
  const optVisible = await page.isVisible('#optimizer-box');
  const optModels = await page.$$eval('#optimizer-model option', (e) => e.length);
  const optCurrent = await page.inputValue('#optimizer-model').catch(() => '');
  const tiers = await page.$$eval('#optimizer-tier option', (e) => e.map((x) => x.value));
  const addBtn = await page.isVisible('#btn-add-candidate-api');
  // 实时流接口可用性
  const liveOk = await page.evaluate(async () => {
    const r = await fetch('/configstudio/api/experiments').then((x) => x.json());
    if (!r.experiments.length) return 'no-experiment';
    const j = await fetch('/configstudio/api/experiments/' + r.experiments[0].id + '/live').then((x) => x.json());
    return typeof j.streams !== 'undefined' ? 'ok' : 'bad-shape';
  });

  console.log(JSON.stringify({
    presets: presets.length, presetLabels: presets,
    optimizerVisible: optVisible, optimizerModels: optModels, optimizerDefault: optCurrent, tiers,
    addCandidateButton: addBtn, liveEndpoint: liveOk, pageErrors: errs,
  }, null, 1));
  await browser.close();
}
