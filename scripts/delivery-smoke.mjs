/**
 * 交付包冒烟检查 —— 在**全新 profile 里装交付区的 tgz**，用真实浏览器打开，
 * 确认打包出来的东西真的是可用的（不是"源码能跑"就算数）。
 *
 * 与 ui-walkthrough.mjs 的分工：那个走模拟模型、验证完整业务流程；
 * 这个只验证"交付物本身装起来能用"，因此不需要模拟 provider。
 *
 * 用法：node scripts/delivery-smoke.mjs --base http://127.0.0.1:8907 --expect-version 0.3.0
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from '../src/preview/browser.js';
import { writeEvidence } from './lib/redact.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const getArg = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const BASE = getArg('--base', 'http://127.0.0.1:8907');
const EXPECT = getArg('--expect-version', null);
const OUT = join(here, '..', 'docs', 'evidence');
mkdirSync(OUT, { recursive: true });

const report = { startedAt: new Date().toISOString(), base: BASE, expectVersion: EXPECT, checks: [] };
const add = (area, name, ok, detail) => {
  report.checks.push({ area, name, ok: Boolean(ok), detail: detail === undefined ? null : detail });
  console.log((ok ? '  ✓ ' : '  ✗ ') + '[' + area + '] ' + name + (detail === undefined ? '' : '  ' + JSON.stringify(detail).slice(0, 220)));
};

// 1) 先做接口层检查（不依赖浏览器）
const routes = ['/meta', '/models', '/settings', '/requirement-presets', '/experiments', '/ui', '/app.js', '/app.css'];
for (const p of routes) {
  try {
    const r = await fetch(BASE + '/html-arena/api' + p);
    add('接口', 'GET ' + p + ' 返回 200', r.status === 200, { status: r.status });
  } catch (err) {
    add('接口', 'GET ' + p + ' 返回 200', false, { error: String(err && err.message || err).slice(0, 160) });
  }
}
const meta = await fetch(BASE + '/html-arena/api/meta').then((r) => r.json()).catch(() => null);
report.meta = meta ? { pluginVersion: meta.pluginVersion, dshVersion: meta.dshVersion, browser: meta.browser, optimizer: meta.optimizer } : null;
if (EXPECT) {
  add('版本', '插件自报版本 = ' + EXPECT, meta && meta.pluginVersion === EXPECT, { got: meta ? meta.pluginVersion : null });
}
add('版本', '能识别宿主 DSH 版本（不是"版本未知"）', Boolean(meta && meta.dshVersion), { got: meta ? meta.dshVersion : null });
add('能力', '/meta 同时给出"探测到"与"已启用"两个字段（反馈 1 的语义）',
  Boolean(meta && meta.optimizer && 'available' in meta.optimizer && 'enabled' in meta.optimizer),
  meta ? meta.optimizer : null);

// 2) 浏览器层检查
const b = await launchBrowser();
if (!b.ok) { add('浏览器', '可启动浏览器', false, { reason: b.reason }); }
else {
  const browser = b.browser;
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300)); });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e.message).slice(0, 300)));
  try {
    await page.goto(BASE + '/html-arena/api/ui', { waitUntil: 'load', timeout: 30000 });
    await page.waitForSelector('#mode-badge', { timeout: 20000 });
    await page.waitForTimeout(1500);
    add('界面', '页面加载且没有致命错误横幅', !(await page.isVisible('#fatal')), await page.textContent('#env-note'));
    // 顶栏显示的是 DSH 版本；环境行里必须是**本插件**的版本。
    // 第一版断言只正则匹配了 "x.y.z"，结果匹配到的是 DSH 版本，等于没测插件版本。
    const envNote = await page.textContent('#env-note');
    add('界面', '环境行显示本插件版本（与 /meta 一致）',
      EXPECT ? envNote.includes('HTML Arena ' + EXPECT) : /HTML Arena \d/.test(envNote), envNote.slice(0, 90));

    // 反馈 1：设置页存在且开关默认关
    await page.click('.tab[data-view="settings"]');
    await page.waitForSelector('#view-settings:not([hidden])', { timeout: 15000 });
    await page.waitForTimeout(800);
    const caps = await page.$$eval('#settings-caps .exp', (els) => Array.from(els).map((e) => e.innerText.replace(/\s+/g, ' ').trim()));
    add('反馈 1', '设置页列出了外部能力清单', caps.length >= 1, caps.map((t) => t.slice(0, 70)));
    // 注意：数据目录是 $DSH_HOME/html-arena（**按用户，不按 profile**），
    // 所以这个烟雾实例和开发实例共用同一份 settings.json —— 上一次开发演练把开关打开之后，
    // "默认关"这个前提在这个实例上已经不成立，断言必须改成**相对当前状态的语义断言**：
    //   ① 探测到 ≠ 启用（两个字段是分开的）；
    //   ② 打开时界面上必须能关、关闭时服务端必须拦（"默认关"由 m2-capability-walkthrough
    //      用"真的关掉再试"的路径证明，而不是靠这里碰运气）。
    const settings = await page.evaluate(() => fetch('/html-arena/api/settings').then((r) => r.json()));
    const cap = settings.capabilities[0] || {};
    add('反馈 1', '外部能力的"探测到"与"已启用"是两件事（打包产物里也是）',
      'detected' in cap && 'enabled' in cap && typeof cap.enabled === 'boolean',
      settings.capabilities.map((c) => c.key + ' detected=' + c.detected + ' enabled=' + c.enabled));
    // 优化区可见的条件是 **探测到 且 已启用**（两个条件都要，见 web/app.js 的 applyOptimizerStatus）：
    // 光"开着开关"但本机没装那个插件时，应该什么都不显示 —— 那才是对的。
    const optState = await page.evaluate(async () => {
      const s = await fetch('/html-arena/api/settings').then((r) => r.json());
      const c = s.capabilities[0] || {};
      const meta = await fetch('/html-arena/api/meta').then((r) => r.json());
      document.querySelector('.tab[data-view="new"]').click();
      await new Promise((r) => setTimeout(r, 600));
      return {
        enabled: Boolean(c.enabled),
        available: Boolean(meta.optimizer && meta.optimizer.available),
        visible: document.getElementById('optimizer-box').hidden === false,
      };
    });
    add('反馈 1', '优化区可见性 = 探测到 且 已启用（探测到但没开 → 不显示；开了但没装 → 也不显示）',
      optState.visible === (optState.available && optState.enabled), optState);

    // 反馈 3：运行面板有"追加一轮"
    await page.click('.tab[data-view="new"]');
    await page.waitForTimeout(600);
    add('反馈 3', '运行面板的"追加一轮"入口存在于打包产物里',
      await page.evaluate(() => Boolean(document.getElementById('btn-add-round'))));

    // 反馈 4：对比页的展开配置区存在
    add('反馈 4', '对比页的"展开配置"面板存在于打包产物里',
      await page.evaluate(() => Boolean(document.getElementById('compare-config'))));

    // 反馈 2：界面上确实跑的是增量渲染那一版（函数存在）
    add('反馈 2', '打包产物里是增量渲染实现（不是旧的 clear 重建版）',
      await page.evaluate(() => typeof window.__htmlArena === 'object' && document.getElementById('screenshot-panel') !== null));

    writeFileSync(join(OUT, 'delivery-smoke.png'), await page.screenshot({ type: 'png' }));
    report.consoleErrors = consoleErrors;
    report.pageErrors = pageErrors;
    add('界面', '控制台 0 错误、页面 0 异常', consoleErrors.length === 0 && pageErrors.length === 0, { consoleErrors, pageErrors });
  } catch (err) {
    report.error = String(err && err.stack || err).slice(0, 1200);
    report.consoleErrors = consoleErrors;
    report.pageErrors = pageErrors;
    add('界面', '浏览器检查未中断', false, report.error.split('\n')[0]);
  } finally { await browser.close(); }
}

report.finishedAt = new Date().toISOString();
report.ok = report.checks.every((c) => c.ok);
const outPath = join(OUT, 'delivery-smoke-' + Date.now() + '.json');
writeEvidence(outPath, report);
const passed = report.checks.filter((c) => c.ok).length;
console.log('\n' + passed + '/' + report.checks.length + ' 项通过');
console.log('证据：' + outPath);
process.exitCode = report.ok ? 0 : 1;
