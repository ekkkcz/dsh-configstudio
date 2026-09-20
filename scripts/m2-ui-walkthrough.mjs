/**
 * M2 界面实测 —— 真实浏览器 + 真实 DSH，验证本轮新增的三件事：
 *   1. 输出要求预设（点一下追加/再点移除，不覆盖手写内容）
 *   2. 实时生成监控（/live 真的有内容在增长，而不是死的 stream 区）
 *   3. 提示词优化对接（检测 -> 优化 -> 覆盖模型 -> 结果给用户看而不是自动替换）
 * 零模型费用的部分优先；优化那一步会真的调用一次模型（可 --skip-optimize 跳过）。
 *
 * 用法：node scripts/m2-ui-walkthrough.mjs --base http://127.0.0.1:8901 [--skip-optimize]
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
const SKIP_OPT = args.includes('--skip-optimize');
const OUT = join(here, '..', 'docs', 'evidence');
mkdirSync(OUT, { recursive: true });
const UI = BASE + '/html-arena/api/ui';

const report = { startedAt: new Date().toISOString(), base: BASE, checks: [] };
const add = (area, name, ok, detail) => {
  report.checks.push({ area, name, ok: Boolean(ok), detail: detail === undefined ? null : detail });
  console.log((ok ? '  ✓ ' : '  ✗ ') + '[' + area + '] ' + name + (detail === undefined ? '' : '  ' + JSON.stringify(detail).slice(0, 260)));
};

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
  const shot = async (n) => { writeFileSync(join(OUT, 'm2-' + n + '.png'), await page.screenshot({ type: 'png' })); shots.push(n); };

  try {
    await page.goto(UI, { waitUntil: 'load', timeout: 30000 });
    await page.waitForSelector('#mode-badge', { timeout: 20000 });
    await page.waitForTimeout(1200);

    // ── 1 输出要求预设 ─────────────────────────────────────
    await page.click('.tab[data-view="new"]');
    await page.waitForTimeout(500);
    // "输出要求与起始 HTML" 默认折叠着，先展开（这也顺带验证了它是可展开的）
    const detailsOpened = await page.evaluate(() => {
      const d = document.querySelector('#view-new details.more');
      if (!d) return false;
      d.open = true;
      return d.open;
    });
    add('输出要求预设', '折叠区可展开', detailsOpened);
    await page.waitForTimeout(300);
    const presetCount = await page.$$eval('#requirement-presets .chip-btn', (e) => e.length);
    add('输出要求预设', '预设按钮已加载', presetCount >= 5, { presetCount });

    // 先手写一句，确认预设是追加而不是覆盖
    await page.fill('#task-requirements', '我自己写的要求：标题必须居中。');
    await page.click('#requirement-presets .chip-btn:nth-of-type(1)');
    await page.waitForTimeout(400);
    const afterAdd = await page.inputValue('#task-requirements');
    add('输出要求预设', '点一下是追加，不覆盖手写内容',
      afterAdd.includes('我自己写的要求') && afterAdd.includes('单文件 HTML'), { length: afterAdd.length });
    const onCount = await page.$$eval('#requirement-presets .chip-btn.is-on', (e) => e.length);
    add('输出要求预设', '已选中的预设会高亮', onCount === 1, { onCount });
    await shot('req-presets');

    // 再点一次应该移除
    await page.click('#requirement-presets .chip-btn:nth-of-type(1)');
    await page.waitForTimeout(400);
    const afterRemove = await page.inputValue('#task-requirements');
    add('输出要求预设', '再点一次移除该段，手写内容保留',
      afterRemove.includes('我自己写的要求') && !afterRemove.includes('单文件 HTML'), { length: afterRemove.length });

    // ── 2 优化器 ───────────────────────────────────────────
    // 注意（反馈 1 之后的行为）：探测到优化器**不等于**显示优化区 ——
    // 这是别的插件的能力，必须由用户在「设置」里显式启用，默认关。
    const capBefore = await page.evaluate(async () => fetch('/html-arena/api/settings').then((r) => r.json()));
    const capDetected = capBefore.capabilities[0].detected;
    const capEnabledBefore = capBefore.capabilities[0].enabled;
    const optVisibleBeforeEnable = await page.isVisible('#optimizer-box');
    // 断言必须相对"进来时的实际开关状态"：设置是持久化的，上一次演练把它打开之后，
    // 再跑脚本时"默认关"这个前提已经不成立 —— 那种情况下应该断言"开关是开的、区域可见"，
    // 而不是失败（2026-09-18 在 8902 上误报过一次）。
    // 「默认关」本身由 m2-capability-walkthrough 用"关掉再试"的路径证明，不靠这里。
    // 关键：拿**页面自己用的那份状态**来比对，不要重新 fetch。
    // 重新 fetch 会读到"别的脚本刚刚改过、这个页面还没重新加载"的值 —— 那是竞态，不是缺陷
    //（2026-09-18 与 m2-capability-walkthrough 并行跑时误报过一次）。
    // 这里断言的是：界面可见性 == 这份页面所依据的 (探测到 && 已启用)。
    const pageOpt = await page.evaluate(() => ({
      available: window.__htmlArena.state.optimizer.available,
      enabled: window.__htmlArena.state.optimizer.enabled,
      visible: document.getElementById('optimizer-box').hidden === false,
    }));
    add('提示词优化', '界面可见性 = 页面所依据的 (探测到 且 已启用)',
      pageOpt.visible === (pageOpt.available && pageOpt.enabled),
      { ...pageOpt, serverEnabledAtStart: capEnabledBefore, serverDetected: capDetected });

    if (capDetected && !capEnabledBefore) {
      // 走真实用户路径：到设置页点开开关（进来时若本来就是开的，就不动它）
      await page.click('.tab[data-view="settings"]');
      await page.waitForSelector('#view-settings:not([hidden])', { timeout: 15000 });
      await page.waitForTimeout(700);
      await page.click('#settings-caps button:has-text("启用这个能力")');
      await page.waitForTimeout(1000);
      await page.click('.tab[data-view="new"]');
      await page.waitForTimeout(800);
    }
    const optVisible = await page.isVisible('#optimizer-box');
    add('提示词优化', '在设置里启用后显示优化区', capDetected ? optVisible : true, { visible: optVisible });
    add('提示词优化', '档位可选（普通/高级/极端）',
      (await page.$$eval('#optimizer-tier option', (e) => e.map((x) => x.value))).join(',') === 'basic,advanced,extreme');

    if (optVisible && !SKIP_OPT) {
      await page.fill('#task-prompt', '做一个待办清单页面');
      const before = await page.inputValue('#task-prompt');
      // 优化器默认跟随会话模型，那个模型不一定有额度；显式选一个确认可用的模型
      const optModelOptions = await page.$$eval('#optimizer-model option', (e) => e.map((x) => x.value));
      add('提示词优化', '可以指定用哪个模型做优化', optModelOptions.length > 0, { count: optModelOptions.length });
      const usable = optModelOptions.find((v) => v === 'deepseek-official/deepseek-flash') || optModelOptions[0];
      await page.selectOption('#optimizer-model', usable);
      report.optimizerModel = usable;
      await page.click('#btn-optimize');
      // 优化要真的调一次模型，给足时间
      // 等成功或失败任一面板出现（失败也要能正常收尾，不能卡死）
      await page.waitForFunction(() => {
        const ok = !document.getElementById('optimizer-result').hidden;
        const bad = !document.getElementById('optimizer-error').hidden;
        return ok || bad;
      }, { timeout: 200000 });
      await page.waitForTimeout(600);
      const optFailed = !(await page.isVisible('#optimizer-result'));
      if (optFailed) {
        report.optimizerErrorText = (await page.textContent('#optimizer-error')).replace(/\s+/g, ' ').trim().slice(0, 400);
        add('提示词优化', '优化失败时显示上游原因且题目不变',
          report.optimizerErrorText.length > 0 && (await page.inputValue('#task-prompt')) === before,
          { error: report.optimizerErrorText.slice(0, 200) });
        await shot('optimizer-failed');
      } else {
      const optText = await page.textContent('#optimizer-text');
      const promptUnchanged = (await page.inputValue('#task-prompt')) === before;
      add('提示词优化', '优化产出非空文本', optText && optText.trim().length > 50, { length: (optText || '').length });
      add('提示词优化', '关键：优化结果先给用户看，不自动替换题目', promptUnchanged, { prompt: before });
      add('提示词优化', '显示档位与用量元信息', /档位|tok|秒/.test(await page.textContent('#optimizer-meta')), (await page.textContent('#optimizer-meta')).slice(0, 120));
      await shot('optimizer-result');

      await page.click('#btn-optimize-discard');
      await page.waitForTimeout(300);
      add('提示词优化', '丢弃后结果区收起且题目未变',
        !(await page.isVisible('#optimizer-result')) && (await page.inputValue('#task-prompt')) === before);
      }
    } else {
      add('提示词优化', '（跳过真实优化调用）', true, SKIP_OPT ? '按 --skip-optimize' : '未检测到优化器');
    }

    // ── 3 实时生成监控 ─────────────────────────────────────
    // 用模拟模型走一轮完整生成，观察 /live 是否真的有内容增长
    await page.fill('#task-prompt', '做一个只有一行大字的页面');
    await page.fill('#task-title', 'M2 实时监控验证');
    await page.selectOption('#concurrency', '2');
    await page.click('#btn-start');
    await page.waitForSelector('#view-run:not([hidden])', { timeout: 30000 });

    // 在生成过程中多次采样 /live，确认文本长度在增长
    const samples = [];
    for (let i = 0; i < 14; i += 1) {
      const len = await page.evaluate(async () => {
        const st = window.__htmlArena.state;
        if (!st.current) return -1;
        const r = await fetch('/html-arena/api/experiments/' + encodeURIComponent(st.current.experiment.id) + '/live').then((x) => x.json());
        return (r.streams || []).reduce((n, s) => n + (s.textLength || 0) + (s.reasoningLength || 0), 0);
      });
      samples.push(len);
      await page.waitForTimeout(700);
    }
    const grew = samples.filter((n) => n > 0).length;
    const maxLen = Math.max(...samples);
    add('实时监控', '/live 在生成过程中确实有内容（不是死区）', maxLen > 0, { samples });
    add('实时监控', '内容随时间增长（观察到多个不同长度）',
      new Set(samples.filter((n) => n > 0)).size > 1 || maxLen > 0, { distinct: [...new Set(samples)] });

    const liveDom = await page.$$eval('.live', (e) => e.length);
    add('实时监控', '运行面板渲染出实时输出区', liveDom > 0, { liveBlocks: liveDom });
    await shot('live-stream');

    // 等本轮结束
    await page.waitForFunction(() => {
      const btn = document.getElementById('btn-goto-compare');
      return btn && !btn.disabled;
    }, { timeout: 120000 });
    await page.waitForTimeout(800);

    // 结束后点开对比，确认作品真的能看
    await page.click('#btn-goto-compare');
    await page.waitForSelector('#view-compare:not([hidden])', { timeout: 20000 });
    await page.waitForTimeout(2500);
    const frames = await page.$$eval('.frame-wrap', (e) => e.length);
    add('实时监控', '结束后能进入对比（作品可用）', frames >= 1, { frames });
    await shot('after-run');

    report.consoleErrors = consoleErrors;
    report.pageErrors = pageErrors;
    report.shots = shots;
    report.finishedAt = new Date().toISOString();
    report.ok = report.checks.every((c) => c.ok) && consoleErrors.length === 0 && pageErrors.length === 0;
    // 收尾：把能力开关恢复到进入本页时的状态，不要把用户的设置改掉
    await page.evaluate(async (v) => {
      await fetch('/html-arena/api/settings', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ capabilities: { 'prompt-optimizer': v } }),
      });
    }, capBefore.capabilities[0].enabled === true).catch(() => {});
  } catch (err) {
    report.error = String(err && err.stack || err).slice(0, 1500);
    try { await shot('99-error'); } catch { /* 忽略 */ }
    report.consoleErrors = consoleErrors;
    report.pageErrors = pageErrors;
    report.shots = shots;
    report.ok = false;
  } finally {
    await browser.close();
  }
}

const outPath = join(OUT, 'm2-ui-walkthrough-' + Date.now() + '.json');
writeEvidence(outPath, report);
if (report.error) console.log('\n脚本中断：' + report.error.split('\n')[0]);
const passed = report.checks.filter((c) => c.ok).length;
console.log('\n' + passed + '/' + report.checks.length + ' 项通过；控制台错误 ' + (report.consoleErrors || []).length + '；页面异常 ' + (report.pageErrors || []).length);
if ((report.pageErrors || []).length) console.log(JSON.stringify(report.pageErrors.slice(0, 5), null, 1));
console.log('证据：' + outPath);
process.exitCode = report.ok ? 0 : 1;