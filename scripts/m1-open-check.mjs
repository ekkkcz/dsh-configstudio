/**
 * 只读探针：确认 DSH 测试实例（8901）在真实浏览器里能打开、并且「HTML 对比」入口在位。
 * 不发模型调用。用法：node scripts/m1-open-check.mjs [baseUrl]
 */
import { launchBrowser } from '../src/preview/browser.js';

const base = process.argv[2] || 'http://127.0.0.1:8901/?token=<已脱敏>';
const b = await launchBrowser();
if (!b.ok) { console.log('无法启动浏览器：' + b.reason); process.exitCode = 1; }
else {
  const browser = b.browser;
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(String(e.message).slice(0, 150)));
  const r = await p.goto(base, { waitUntil: 'load', timeout: 30000 });
  await p.waitForTimeout(3000);
  const entryCount = await p.locator('text=HTML 对比').count();
  const body = (await p.textContent('body') || '').replace(/\s+/g, ' ').slice(0, 260);
  const cookies = (await ctx.cookies()).map((c) => c.name);
  console.log(JSON.stringify({
    status: r && r.status(), title: await p.title(), url: p.url().replace(/token=[^&]+/, 'token=***'),
    arenaEntry: entryCount, cookies, pageErrors: errs, bodyText: body,
  }, null, 1));

  // 点进插件入口，确认 iframe 真的起来了
  if (entryCount > 0) {
    await p.click('text=HTML 对比');
    await p.waitForTimeout(4000);
    const iframeSrc = await p.evaluate(() => {
      const f = document.querySelector('iframe[src*="html-arena"]');
      return f ? f.getAttribute('src') : null;
    });
    const frames = p.frames().filter((f) => f !== p.mainFrame()).map((f) => f.url().replace(/token=[^&]+/, 'token=***'));
    console.log('点开入口后：iframe=' + iframeSrc + '  frames=' + JSON.stringify(frames));
  }
  await browser.close();
}
