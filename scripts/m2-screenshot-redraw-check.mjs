/**
 * 反馈 2 的第二组回归：**截图不能重置用户正在操作的作品**。
 *
 * 这条是审查发现的同类缺陷：takeScreenshots() 以前每完成一张截图就调一次 renderCompare()，
 * 而 renderCompare() 会 clear(compare-grid) 并重建 iframe —— 四候选就是四次重置。
 * 用户看到的现象与"推理过程被收回"同一类：我没点重置，作品却回到初始状态。
 *
 * 用已存在的四候选实验（零模型费用）：在三个作品里各打一个运行态标记，
 * 点"截图"，等全部完成，标记必须都还在。
 *
 * 用法：node scripts/m2-screenshot-redraw-check.mjs --base http://127.0.0.1:8901 --title "M2 四候选对比"
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from '../src/preview/browser.js';
import { writeEvidence } from './lib/redact.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const getArg = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const BASE = getArg('--base', 'http://127.0.0.1:8901');
const TITLE = getArg('--title', 'M2 四候选对比');
const OUT = join(here, '..', 'docs', 'evidence');
mkdirSync(OUT, { recursive: true });

const report = { startedAt: new Date().toISOString(), base: BASE, title: TITLE, checks: [] };
const add = (area, name, ok, detail) => {
  report.checks.push({ area, name, ok: Boolean(ok), detail: detail === undefined ? null : detail });
  console.log((ok ? '  ✓ ' : '  ✗ ') + '[' + area + '] ' + name + (detail === undefined ? '' : '  ' + JSON.stringify(detail).slice(0, 240)));
};

const b = await launchBrowser();
if (!b.ok) { console.log('无法启动浏览器：' + b.reason); process.exitCode = 1; }
else {
  const browser = b.browser;
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300)); });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e.message).slice(0, 300)));
  const shots = [];
  const shot = async (n) => { writeFileSync(join(OUT, 'm2shot-' + n + '.png'), await page.screenshot({ type: 'png' })); shots.push(n); };

  try {
    await page.goto(BASE + '/html-arena/api/ui', { waitUntil: 'load', timeout: 30000 });
    await page.waitForSelector('#mode-badge', { timeout: 20000 });
    await page.waitForTimeout(1000);
    await page.fill('#search', TITLE);
    await page.waitForTimeout(1400);
    await page.click('#experiment-list .exp:first-child button:has-text("打开")');
    await page.waitForSelector('#view-compare:not([hidden])', { timeout: 20000 });
    await page.waitForTimeout(3200);

    const ids = await page.$$eval('.frame-wrap iframe', (els) => els.map((e) => (e.src.match(/\/preview\/([^?]+)/) || [])[1]));
    add('准备', '有可预览的作品', ids.length >= 2, { ids });

    // 在每个作品里写一个运行态标记 + 在页面上做一次真实交互
    const frameFor = (id) => page.frames().find((f) => f.url().includes('/preview/' + id));
    for (const id of ids) {
      const f = frameFor(id);
      await f.evaluate(() => { window.__shotProbe = 'alive'; });
    }
    // 记录 iframe 的 DOM 节点身份：重建会让它换一个新节点
    const nodeIds = await page.evaluate(() => {
      const frames = [...document.querySelectorAll('.frame-wrap iframe')];
      window.__iframeRefs = frames;
      frames.forEach((f, i) => f.setAttribute('data-node-id', 'node' + i));
      return frames.map((f) => f.getAttribute('data-node-id'));
    });

    await page.click('#btn-screenshots');
    await page.waitForTimeout(1500);
    // 截图进行中：第一个面板应该已经出现，但作品不应被重置
    const midState = await page.evaluate(() => ({
      panels: document.querySelectorAll('#screenshot-panel .panel').length,
      imgs: document.querySelectorAll('#screenshot-panel img[src^="data:image/png"]').length,
    }));
    add('截图', '截图面板在独立容器里出现（不重建作品区）', midState.panels > 0, midState);

    // 等截图全部完成（每个候选最多 10 秒）
    await page.waitForFunction(() => {
      const imgs = document.querySelectorAll('#screenshot-panel img[src^="data:image/png"]');
      return imgs.length > 0;
    }, { timeout: 90000 }).catch(() => {});
    await page.waitForTimeout(6000);

    const after = await page.evaluate(() => {
      const frames = [...document.querySelectorAll('.frame-wrap iframe')];
      const same = frames.length === window.__iframeRefs.length
        && frames.every((f, i) => f === window.__iframeRefs[i]);
      return {
        nodeIdentityPreserved: same,
        nodeIds: frames.map((f) => f.getAttribute('data-node-id')),
        imgs: document.querySelectorAll('#screenshot-panel img[src^="data:image/png"]').length,
      };
    });
    add('截图', '作品区 iframe 的 DOM 节点没有被替换', after.nodeIdentityPreserved, { nodeIds: after.nodeIds });
    add('截图', '截图确实生成了图片', after.imgs >= 1, { imgs: after.imgs });

    const alive = [];
    for (const id of ids) {
      alive.push(await frameFor(id).evaluate(() => window.__shotProbe ?? null).catch(() => '(frame 未就绪)'));
    }
    add('截图', '作品里的运行态标记全部存活（没有人在我没点重置时把作品重置了）',
      alive.every((v) => v === 'alive'), alive);
    await shot('after-screenshots');

    // 对照组：真的点"重置"时，标记必须被清掉 —— 证明上面的探针是有效的，不是永远为真
    const firstId = ids[0];
    await page.click('.frame-wrap:nth-child(1) .frame-head button:has-text("重置")');
    await page.waitForTimeout(2500);
    const afterReset = await frameFor(firstId).evaluate(() => window.__shotProbe ?? null).catch(() => '(frame 未就绪)');
    add('截图', '对照组：主动点重置确实会清掉标记（证明探针有效）', afterReset === null, { afterReset });
    await shot('control-reset');

    report.consoleErrors = consoleErrors;
    report.pageErrors = pageErrors;
    report.shots = shots;
    report.finishedAt = new Date().toISOString();
    report.ok = report.checks.every((c) => c.ok) && consoleErrors.length === 0 && pageErrors.length === 0;
  } catch (err) {
    report.error = String(err && err.stack || err).slice(0, 1500);
    try { await shot('99-error'); } catch { /* 忽略 */ }
    report.consoleErrors = consoleErrors;
    report.pageErrors = pageErrors;
    report.ok = false;
  } finally {
    await browser.close();
  }
}

const outPath = join(OUT, 'm2-screenshot-redraw-' + Date.now() + '.json');
writeEvidence(outPath, report);
if (report.error) console.log('\n脚本中断：' + report.error.split('\n')[0]);
const passed = report.checks.filter((c) => c.ok).length;
console.log('\n' + passed + '/' + report.checks.length + ' 项通过；控制台错误 ' + (report.consoleErrors || []).length + '；页面异常 ' + (report.pageErrors || []).length);
if ((report.pageErrors || []).length) console.log(JSON.stringify(report.pageErrors.slice(0, 4), null, 1));
console.log('证据：' + outPath);
process.exitCode = report.ok ? 0 : 1;
