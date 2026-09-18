/**
 * 交付截图：从真实 DSH 实例上抓几张代表图放进去交付目录。
 * 零费用：只打开已有实验与设置页，不发起任何模型调用。
 * 用法：node scripts/delivery-shots.mjs --base http://127.0.0.1:8901 --out "../交付区/v0.3.0/截图"
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from '../src/preview/browser.js';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const getArg = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const BASE = getArg('--base', 'http://127.0.0.1:8901');
const OUT = join(here, '..', getArg('--out', 'docs/evidence'));
mkdirSync(OUT, { recursive: true });

const b = await launchBrowser();
if (!b.ok) { console.log('无法启动浏览器：' + b.reason); process.exitCode = 1; }
else {
  const browser = b.browser;
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await ctx.newPage();
  const shot = async (n) => { writeFileSync(join(OUT, n + '.png'), await page.screenshot({ type: 'png' })); console.log('  ✓ ' + n); };
  const saved = [];
  // 记住进来时的开关状态，结束后恢复
  const orig = await (await fetch(BASE + '/html-arena/api/settings')).json();

  try {
    await page.goto(BASE + '/html-arena/api/ui', { waitUntil: 'load', timeout: 30000 });
    await page.waitForSelector('#mode-badge', { timeout: 20000 });
    await page.waitForTimeout(1500);

    // 1) 设置页：外部能力默认关（反馈 1）
    await page.click('.tab[data-view="settings"]');
    await page.waitForSelector('#view-settings:not([hidden])', { timeout: 15000 });
    await page.waitForTimeout(900);
    await shot('01-设置-外部能力默认关');
    saved.push('01-设置-外部能力默认关');

    // 2) 对比页：展开配置（反馈 4）——用四候选真实实验
    await page.click('.tab[data-view="experiments"]');
    await page.waitForTimeout(700);
    await page.fill('#search', 'M2 四候选对比');
    await page.waitForTimeout(1400);
    await page.click('#experiment-list .exp:first-child button:has-text("打开")');
    await page.waitForSelector('#view-compare:not([hidden])', { timeout: 20000 });
    await page.waitForTimeout(3200);
    await page.evaluate(() => { document.getElementById('compare-config').open = true; });
    await page.waitForTimeout(600);
    // 展开第一个候选的系统提示词折叠块，让"每个候选都能看细节"这件事在图上看得出来
    await page.evaluate(() => {
      const d = document.querySelector('#compare-details details.cfg-long');
      if (d) d.open = true;
      // 滚到面板标题上方一点，别把标题切掉
      const box = document.getElementById('compare-config');
      const y = box.getBoundingClientRect().top + window.scrollY - 70;
      window.scrollTo(0, Math.max(0, y));
    });
    await page.waitForTimeout(700);
    await shot('02-对比页-展开配置');
    saved.push('02-对比页-展开配置');

    // 3) 对比页：盲选状态下展开配置也不泄露身份
    const blindBefore = await page.evaluate(() => window.__htmlArena.state.blind);
    if (blindBefore !== true) { await page.click('#btn-blind'); await page.waitForTimeout(900); }
    await page.evaluate(() => {
      const box = document.getElementById('compare-config');
      box.open = true;
      const y = box.getBoundingClientRect().top + window.scrollY - 70;
      window.scrollTo(0, Math.max(0, y));
    });
    await page.waitForTimeout(800);
    await shot('03-对比页-盲选下配置已脱敏');
    saved.push('03-对比页-盲选下配置已脱敏');
    if ((await page.evaluate(() => window.__htmlArena.state.blind)) === true) {
      await page.click('#btn-blind'); await page.waitForTimeout(700);
    }

    // 4) 运行面板：追加轮次入口（反馈 3）
    await page.evaluate(() => { window.__htmlArena.state.view = 'run'; document.querySelector('.tab[data-view="experiments"]').click(); });
    await page.waitForTimeout(600);
    console.log(JSON.stringify({ saved }, null, 1));
  } catch (err) {
    console.log('中断：' + String(err && err.message || err).slice(0, 300));
    process.exitCode = 1;
  } finally {
    // 恢复开关状态
    try {
      await fetch(BASE + '/html-arena/api/settings', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ capabilities: Object.fromEntries(orig.capabilities.map((c) => [c.key, c.enabled])) }),
      });
    } catch { /* 忽略 */ }
    await browser.close();
  }
}
