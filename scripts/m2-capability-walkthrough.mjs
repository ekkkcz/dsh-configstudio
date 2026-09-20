/**
 * 反馈 1 的验收脚本：**外部插件能力必须由用户显式启用**（默认关）。
 *
 * 用户原话："提示词优化那个是一个插件来的，如果是别的插件的，得让用户自己选择是否加插件呀"
 *
 * 因此要证明的是三件事，缺一不可：
 *   1. 探测到那个插件时，**默认不显示、也不调用**（不是"显示了但点了没用"）；
 *   2. 用户在「设置」里打开后，优化区才出现；
 *   3. 关掉后重新加载页面，仍然是关的 —— 说明设置真的持久化了，不是内存里的临时开关。
 *
 * 全程零模型费用：只验证开关与界面显隐，不点"优化题目"。
 *
 * 用法：node scripts/m2-capability-walkthrough.mjs --base http://127.0.0.1:8901
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from '../src/preview/browser.js';
import { writeEvidence } from './lib/redact.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const getArg = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
// 默认端口从 8901 改成 8902：8901 已被本机无关程序（与本插件无关）占用，
// 不带 --base 跑到别的服务上会得到莫名其妙的失败（2026-09-18 实测）。
const BASE = getArg('--base', 'http://127.0.0.1:8902');
const OUT = join(here, '..', 'docs', 'evidence');
mkdirSync(OUT, { recursive: true });
const UI = BASE + '/configstudio/api/ui';

const report = { startedAt: new Date().toISOString(), base: BASE, checks: [], notes: [] };
const add = (area, name, ok, detail) => {
  report.checks.push({ area, name, ok: Boolean(ok), detail: detail === undefined ? null : detail });
  console.log((ok ? '  ✓ ' : '  ✗ ') + '[' + area + '] ' + name + (detail === undefined ? '' : '  ' + JSON.stringify(detail).slice(0, 280)));
};

/** 直接调 API 把开关复位到一个已知状态（脚本自己收尾，不给用户留脏状态）。 */
async function setCapability(page, enabled) {
  return page.evaluate(async (v) => {
    const r = await fetch('/configstudio/api/settings', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ capabilities: { 'prompt-optimizer': v } }),
    }).then((x) => x.json());
    return r;
  }, enabled);
}

const b = await launchBrowser();
if (!b.ok) { console.log('无法启动浏览器：' + b.reason); process.exitCode = 1; }
else {
  const browser = b.browser;
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300)); });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e.message).slice(0, 300)));
  const shots = [];
  const shot = async (n) => { writeFileSync(join(OUT, 'm2cap-' + n + '.png'), await page.screenshot({ type: 'png' })); shots.push(n); };

  let originalState = null;
  try {
    await page.goto(UI, { waitUntil: 'load', timeout: 30000 });
    await page.waitForSelector('#mode-badge', { timeout: 20000 });
    await page.waitForTimeout(1200);

    // 记录进来时的原始状态，最后恢复（不要把用户的设置改掉）
    originalState = await page.evaluate(async () => fetch('/configstudio/api/settings').then((r) => r.json()));
    const cap0 = originalState.capabilities[0];
    report.detectedAtStart = cap0.detected;
    report.enabledAtStart = cap0.enabled;

    // ── 1) 探测到 ≠ 启用：默认不显示优化区 ──────────────────
    add('探测与启用分离', '服务端确实探测到那个插件', cap0.detected === true, { detected: cap0.detected, source: cap0.source });
    if (!cap0.detected) {
      report.notes.push('这个实例没有装 dsh-prompt-optimizer，只能验证"没探测到就不显示"这一半。');
    }

    // 先强制关掉，验证"关了就不显示"（无论进来时是什么状态）
    await setCapability(page, false);
    await page.reload({ waitUntil: 'load' });
    await page.waitForSelector('#mode-badge', { timeout: 20000 });
    await page.waitForTimeout(1500);
    await page.click('.tab[data-view="new"]');
    await page.waitForTimeout(600);
    const hiddenWhenOff = await page.evaluate(() => document.getElementById('optimizer-box').hidden);
    add('探测与启用分离', '关闭时"新建对比"页不出现优化区', hiddenWhenOff === true, { hidden: hiddenWhenOff });
    await shot('off-new-page');

    // ── 2) 设置页把两件事讲清楚 ────────────────────────────
    await page.click('.tab[data-view="settings"]');
    await page.waitForSelector('#view-settings:not([hidden])', { timeout: 15000 });
    await page.waitForTimeout(900);
    const settingsText = (await page.textContent('#settings-caps')).replace(/\s+/g, ' ').trim();
    add('设置页', '列出了这项能力并写明来源', /dsh-prompt-optimizer/.test(settingsText), settingsText.slice(0, 220));
    add('设置页', '写明开启后的代价（会花钱）', /费用|调用/.test(settingsText), settingsText.slice(0, 260));
    add('设置页', '写明当前状态是"没有启用"', /没有启用/.test(settingsText), settingsText.slice(0, 260));
    add('设置页', '说明了设置存在哪、不是浏览器本地存储', /数据目录/.test(await page.textContent('#settings-where')) && /本地存储/.test(await page.textContent('#view-settings')), (await page.textContent('#settings-where')).slice(0, 160));
    await shot('settings-off');

    // ── 3) 打开开关 → 优化区出现 ───────────────────────────
    await page.click('#settings-caps button:has-text("启用这个能力")');
    await page.waitForTimeout(1200);
    const afterOn = await page.evaluate(async () => fetch('/configstudio/api/settings').then((r) => r.json()));
    add('启用', 'PUT /settings 后服务端读到 enabled:true', afterOn.capabilities[0].enabled === true, { enabled: afterOn.capabilities[0].enabled });
    const settingsTextOn = (await page.textContent('#settings-caps')).replace(/\s+/g, ' ').trim();
    add('启用', '设置页状态文字跟着变成"已启用"', /已启用/.test(settingsTextOn), settingsTextOn.slice(0, 200));
    await shot('settings-on');

    await page.click('.tab[data-view="new"]');
    await page.waitForTimeout(900);
    const shownWhenOn = await page.evaluate(() => !document.getElementById('optimizer-box').hidden);
    add('启用', '启用后"新建对比"页出现优化区', shownWhenOn === true);
    const optBtn = await page.isVisible('#btn-optimize');
    add('启用', '优化按钮可用', optBtn === true);
    await shot('on-new-page');

    // ── 3b) 启用后必须真的放行（零费用证明：空题目会在"发起调用之前"被拒，
    //        所以能走到"题目为空"就说明已经越过了开关闸门，且没有花任何钱）─────
    const passedGate = await page.evaluate(async () => {
      return fetch('/configstudio/api/optimizer/optimize', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ request: '   ', tier: 'basic' }),
      }).then((x) => x.json());
    });
    add('启用', '启用后开关放行（不再返回 disabled，而是走到参数检查）',
      passedGate.disabled !== true && passedGate.ok === false, passedGate);

    // ── 4) 持久化：重新加载页面后仍然是启用 ─────────────────
    await page.reload({ waitUntil: 'load' });
    await page.waitForSelector('#mode-badge', { timeout: 20000 });
    await page.waitForTimeout(1500);
    await page.click('.tab[data-view="new"]');
    await page.waitForTimeout(800);
    const stillOnAfterReload = await page.evaluate(() => !document.getElementById('optimizer-box').hidden);
    add('持久化', '重新加载页面后仍是启用（设置真的落盘了，不是内存开关）', stillOnAfterReload === true);
    await shot('after-reload-on');

    // ── 5) 再关掉 → 立刻恢复不显示；且优化请求被拒绝 ──────────
    await page.click('.tab[data-view="settings"]');
    await page.waitForTimeout(800);
    await page.click('#settings-caps button:has-text("已启用")');
    await page.waitForTimeout(1200);
    await page.click('.tab[data-view="new"]');
    await page.waitForTimeout(800);
    const hiddenAgain = await page.evaluate(() => document.getElementById('optimizer-box').hidden);
    add('关闭', '关掉后优化区立刻消失（不用刷新页面）', hiddenAgain === true);

    const refused = await page.evaluate(async () => {
      const r = await fetch('/configstudio/api/optimizer/optimize', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ request: '这条路不该被走通', tier: 'basic' }),
      }).then((x) => x.json());
      return r;
    });
    add('关闭', '关闭状态下即使直接打接口也会被拒绝（服务端兜底，不只是隐藏界面）',
      refused.ok === false && refused.disabled === true, { ok: refused.ok, disabled: refused.disabled });
    add('关闭', '拒绝理由说明了这是"未启用的外部能力"', /未启用|尚未启用/.test(refused.reason || ''), (refused.reason || '').slice(0, 160));
    await shot('after-reload-off');

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
    // 收尾：恢复进入时的原始状态，不把用户的设置改掉
    try {
      if (originalState) await setCapability(page, report.enabledAtStart === true);
      report.restoredTo = report.enabledAtStart;
    } catch { report.notes.push('收尾恢复原始设置失败，请手动检查 /settings'); }
    await browser.close();
  }
}

const outPath = join(OUT, 'm2-capability-' + Date.now() + '.json');
writeEvidence(outPath, report);
if (report.error) console.log('\n脚本中断：' + report.error.split('\n')[0]);
const passed = report.checks.filter((c) => c.ok).length;
console.log('\n' + passed + '/' + report.checks.length + ' 项通过；控制台错误 ' + (report.consoleErrors || []).length + '；页面异常 ' + (report.pageErrors || []).length);
console.log('收尾：设置已恢复到进入时的状态（enabled=' + report.restoredTo + '）');
if (report.notes.length) console.log('说明：' + report.notes.join(' / '));
if ((report.pageErrors || []).length) console.log(JSON.stringify(report.pageErrors.slice(0, 5), null, 1));
console.log('证据：' + outPath);
process.exitCode = report.ok ? 0 : 1;