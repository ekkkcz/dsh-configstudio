/**
 * M2 四候选对比页实测 —— 确认 3–4 个作品在界面上真的能看、能独立操作。
 * 零模型费用：只打开已经跑完的实验。
 *
 * 用法：node scripts/m2-four-walkthrough.mjs --base http://127.0.0.1:8901 --title "M2 四候选对比"
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from '../src/preview/browser.js';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const getArg = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const BASE = getArg('--base', 'http://127.0.0.1:8901');
const TITLE = getArg('--title', 'M2 四候选对比');
const OUT = join(here, '..', 'docs', 'evidence');
mkdirSync(OUT, { recursive: true });
const UI = BASE + '/html-arena/api/ui';

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
  const shot = async (n) => { writeFileSync(join(OUT, 'm2-' + n + '.png'), await page.screenshot({ type: 'png' })); shots.push(n); };

  try {
    await page.goto(UI, { waitUntil: 'load', timeout: 30000 });
    await page.waitForSelector('#mode-badge', { timeout: 20000 });
    await page.waitForTimeout(1000);
    await page.fill('#search', TITLE);
    await page.waitForTimeout(1200);
    const rows = await page.$$eval('#experiment-list .exp', (e) => e.map((x) => x.innerText.replace(/\s+/g, ' ').trim().slice(0, 130)));
    add('准备', '按标题找到四候选实验', rows.length === 1, rows);
    await page.click('#experiment-list .exp:first-child button:has-text("打开")');
    await page.waitForSelector('#view-compare:not([hidden])', { timeout: 20000 });
    await page.waitForTimeout(3000);

    const shape = await page.$$eval('.frame-wrap', (els) => els.map((e) => ({
      head: e.querySelector('.frame-head') ? e.querySelector('.frame-head').innerText.replace(/\s+/g, ' ').trim().slice(0, 70) : '',
      hasIframe: Boolean(e.querySelector('iframe')),
      hasError: Boolean(e.querySelector('.frame-error')),
      x: Math.round(e.getBoundingClientRect().x),
      y: Math.round(e.getBoundingClientRect().y),
      w: Math.round(e.getBoundingClientRect().width),
    })));
    add('对比页', '四个候选都渲染成卡片', shape.length === 4, { count: shape.length });
    const okCards = shape.filter((s) => s.hasIframe).length;
    const errCards = shape.filter((s) => s.hasError).length;
    add('对比页', '三个成功的显示作品、一个失败的显示占位', okCards === 3 && errCards === 1, { okCards, errCards });
    add('对比页', '四候选是两行两列（不是挤成一条）',
      new Set(shape.map((s) => s.y)).size === 2 && new Set(shape.map((s) => s.x)).size === 2,
      shape.map((s) => s.x + ',' + s.y));
    add('对比页', '同一行的卡片等宽', (() => {
      const row1 = shape.filter((s) => s.y === shape[0].y).map((s) => s.w);
      const row2 = shape.filter((s) => s.y !== shape[0].y).map((s) => s.w);
      const same = (a) => a.every((v) => Math.abs(v - a[0]) <= 2);
      return same(row1) && same(row2);
    })(), shape.map((s) => s.w));
    await shot('four-candidates');

    // 独立重置仍然只影响一个（4 个候选下再确认一次）
    // 只有"有作品"的卡片才有 iframe —— 失败占位没有，所以数量应按 okCards 算，不是固定 4
    const ids = await page.$$eval('.frame-wrap iframe', (els) => els.map((e) => (e.src.match(/\/preview\/([^?]+)/) || [])[1]));
    add('对比页', '每个作品有独立的预览地址', ids.length === okCards && new Set(ids).size === ids.length, ids);
    const frameFor = (id) => page.frames().find((f) => f.url().includes('/preview/' + id));
    for (const id of ids) await frameFor(id).evaluate(() => { window.__m2 = 'x'; });
    await page.click('.frame-wrap:nth-child(2) .frame-head button:has-text("重置")');
    await page.waitForTimeout(2500);
    const marks = [];
    for (const id of ids) marks.push(await frameFor(id).evaluate(() => window.__m2 ?? null).catch(() => '?'));
    add('对比页', '四候选下重置只影响被点的那一个',
      marks.filter((m) => m === null).length === 1 && marks.filter((m) => m === 'x').length === ids.length - 1, marks);
    await shot('four-reset');

    // ── 展开配置（反馈 4）──────────────────────────────────────
    // 用户原话："最终的实验对比你得搞一个展开配置出来，这样才能知道具体配置"
    report.expected = await page.evaluate(() => {
      const st = window.__htmlArena.state;
      const e = st.current.experiment;
      const ts = e.taskSnapshot || {};
      return {
        prompt: ts.prompt || '',
        taskHash: e.taskHash || '',
        concurrency: (e.outputPolicy || {}).concurrency,
        timeoutMs: (e.outputPolicy || {}).timeoutMs,
        networkPolicy: (e.previewPolicy || {}).networkPolicy,
        attempts: st.current.attempts.map((a) => ({
          slot: a.slot, provider: a.recipe.provider, model: a.recipe.model,
          maxTokens: a.recipe.maxTokens, inputTokens: a.receipt ? a.receipt.usage && a.receipt.usage.inputTokens : null,
          outputTokens: a.receipt ? a.receipt.usage && a.receipt.usage.outputTokens : null,
          finishReason: a.receipt ? a.receipt.finishReason : null,
        })),
      };
    });

    await page.evaluate(() => { document.getElementById('compare-config').open = true; });
    await page.waitForTimeout(600);
    const cfgText = (await page.textContent('#compare-details')).replace(/\s+/g, ' ').trim();
    const exp = report.expected;

    add('展开配置', '面板可展开且渲染出内容', cfgText.length > 200, { length: cfgText.length });
    add('展开配置', '能看到题目原文（对"为什么作品不一样"解释力最强）',
      exp.prompt.length > 0 && cfgText.includes(exp.prompt.slice(0, 30)), exp.prompt.slice(0, 60));
    add('展开配置', '题目处写明了"所有候选收到同一份"', /所有候选收到的是同一份/.test(cfgText));
    add('展开配置', '能看到 taskHash', exp.taskHash.length > 0 && cfgText.includes(exp.taskHash.slice(0, 16)), exp.taskHash.slice(0, 16));
    add('展开配置', '能看到运行上限与并发数',
      cfgText.includes(String(exp.timeoutMs / 1000)) && cfgText.includes(String(exp.concurrency)),
      { timeoutSec: exp.timeoutMs / 1000, concurrency: exp.concurrency });
    add('展开配置', '能看到预览网络策略', /离线|受控 CDN/.test(cfgText), exp.networkPolicy);
    add('展开配置', '每个候选都有独立的配置块（不是只渲染第一个）',
      await page.$$eval('#compare-details .cfg-block', (els) => els.length) === exp.attempts.length + 1,
      await page.$$eval('#compare-details .cfg-block', (els) => els.length));

    const cfgPerCandidate = await page.$$eval('#compare-details .cfg-block', (els) => Array.from(els).slice(1).map((e) => e.innerText.replace(/\s+/g, ' ')));
    add('展开配置', '每个候选块写出 provider 与 model',
      exp.attempts.every((a, i) => cfgPerCandidate[i] && cfgPerCandidate[i].includes(a.provider) && cfgPerCandidate[i].includes(a.model)),
      cfgPerCandidate.map((t) => t.slice(0, 60)));
    add('展开配置', '每个候选块写出输出上限',
      exp.attempts.every((a, i) => cfgPerCandidate[i] && (a.maxTokens === null || cfgPerCandidate[i].includes(String(a.maxTokens)))),
      exp.attempts.map((a) => a.maxTokens));
    add('展开配置', '每个候选块写出用量（输入/输出 tokens）与收尾原因',
      exp.attempts.every((a, i) => {
        const t = cfgPerCandidate[i] || '';
        const hasUsage = a.outputTokens === null || a.outputTokens === undefined ? /未上报/.test(t) : t.includes(String(a.outputTokens));
        const hasFinish = !a.finishReason || t.includes(a.finishReason);
        return hasUsage && hasFinish;
      }),
      exp.attempts.map((a) => (a.inputTokens === null || a.inputTokens === undefined ? '未上报' : a.inputTokens + '/' + (a.outputTokens === null || a.outputTokens === undefined ? '未上报' : a.outputTokens))));
    add('展开配置', '写了"逻辑请求数 = 1（插件直调不会被自动重试）"这件事',
      /逻辑请求数/.test(cfgText) && /不会被自动重试/.test(cfgText));
    add('展开配置', '长文本用可折叠块承载（不把面板撑爆）',
      (await page.$$eval('#compare-details details.cfg-long', (els) => els.length)) >= 1,
      await page.$$eval('#compare-details details.cfg-long', (els) => els.length));
    add('展开配置', '系统提示词与提示词片段在候选块里（候选间差异的主要来源）',
      /系统提示词/.test(cfgText) && /提示词片段/.test(cfgText));
    await shot('four-config-expanded');

    // 展开状态必须能保持住（不要再犯"轮询/重绘把 details 收回去"的老毛病）
    const openBefore = await page.$$eval('#compare-details details.cfg-long', (els) => els.map((e) => e.open));
    await page.evaluate(() => {
      const d = document.querySelector('#compare-details details.cfg-long');
      if (d) d.open = true;
    });
    await page.waitForTimeout(400);
    const marked = await page.evaluate(() => {
      const b = document.querySelector('#compare-details .cfg-block');
      if (b) b.setAttribute('data-cfg-probe', '1');
      return Boolean(b);
    });
    // 触发一次"配置差异面板之外"的重绘：切换视口会 renderCompare()
    await page.click('.seg-btn[data-vp="desktop"]');
    await page.waitForTimeout(1200);
    const survived = await page.evaluate(() => {
      const b = document.querySelector('#compare-details .cfg-block');
      const d = document.querySelector('#compare-details details.cfg-long');
      return { probe: b ? b.getAttribute('data-cfg-probe') : null, open: d ? d.open : null };
    });
    add('展开配置', '触发重绘后候选集合不变 → 骨架被复用，展开状态保持',
      marked && survived.probe === '1' && survived.open === true, survived);

    // ── 盲选脱敏：展开配置后不得泄露身份（复用 m1 的既有约束）──
    // 走真实按钮路径，但先读真实状态再决定要不要点 —— 只看按钮文案会被
    // "状态被改过但没重绘"的情况骗到（这个脚本第一版就这么错过一次）。
    const blindBefore = await page.evaluate(() => window.__htmlArena.state.blind);
    if (blindBefore !== true) await page.click('#btn-blind');
    await page.waitForTimeout(900);
    const blindState = await page.evaluate(() => ({ blind: window.__htmlArena.state.blind, revealed: window.__htmlArena.state.revealed }));
    add('展开配置', '已进入盲选状态（前置条件成立）', blindState.blind === true && blindState.revealed !== true, blindState);
    const blindCfg = (await page.textContent('#compare-details')).replace(/\s+/g, ' ');
    const ident = exp.attempts.flatMap((a) => [a.provider, a.model]).filter(Boolean);
    const leaked = ident.filter((w) => blindCfg.includes(w));
    add('展开配置', '盲选状态下展开配置不泄露 provider / model', leaked.length === 0, { leaked, sample: blindCfg.slice(0, 200) });

    // 只遮 provider/model 是不够的：上下文窗口、默认输出上限、可用思考档位清单是**模型指纹**，
    // 拼在一起基本等于把模型名写出来（第一版截图就是这么漏的，肉眼在图上看到 1000000 / off·low·high·max）。
    const fingerprints = await page.evaluate(() => {
      const st = window.__htmlArena.state;
      const out = [];
      st.current.attempts.forEach((a) => {
        const r = a.resolved || {};
        if (Number.isInteger(r.contextWindow)) out.push(String(r.contextWindow));
        if (Number.isInteger(r.defaultMaxTokens)) out.push(String(r.defaultMaxTokens));
        if (Array.isArray(r.availableReasoningEfforts) && r.availableReasoningEfforts.length) {
          out.push(r.availableReasoningEfforts.join(' / '));
        }
      });
      return out;
    });
    const leakedFp = fingerprints.filter((v) => v && blindCfg.includes(v));
    add('展开配置', '盲选状态下也不泄露模型指纹（上下文窗口 / 默认输出上限 / 档位清单）',
      leakedFp.length === 0, { fingerprints, leakedFp });
    add('展开配置', '盲选状态下候选名也写"已隐藏，揭晓后可见"', /已隐藏，揭晓后可见/.test(blindCfg));
    add('展开配置', '盲选状态下仍然看得到题目（不因为脱敏把整块藏掉）',
      exp.prompt.length > 0 && blindCfg.includes(exp.prompt.slice(0, 20)));
    await shot('four-config-blind');

    // 恢复显示身份，避免影响后续断言
    if ((await page.evaluate(() => window.__htmlArena.state.blind)) === true) await page.click('#btn-blind');
    await page.waitForTimeout(600);

    // 视口切换对四个都生效
    await page.click('.seg-btn[data-vp="mobile"]');
    await page.waitForTimeout(1500);
    const widths = await page.$$eval('.frame-wrap iframe', (e) => e.map((x) => x.style.width));
    add('对比页', '切手机视口对全部作品都生效', widths.length === ids.length && widths.every((w) => w === '390px'), widths);
    await shot('four-mobile');

    report.consoleErrors = consoleErrors;
    report.pageErrors = pageErrors;
    report.shots = shots;
    report.finishedAt = new Date().toISOString();
    report.ok = report.checks.every((c) => c.ok) && consoleErrors.length === 0 && pageErrors.length === 0;
  } catch (err) {
    report.error = String(err && err.stack || err).slice(0, 1200);
    try { await shot('99-error'); } catch { /* 忽略 */ }
    report.consoleErrors = consoleErrors;
    report.pageErrors = pageErrors;
    report.shots = shots;
    report.ok = false;
  } finally {
    await browser.close();
  }
}

const outPath = join(OUT, 'm2-four-walkthrough-' + Date.now() + '.json');
writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');
if (report.error) console.log('\n脚本中断：' + report.error.split('\n')[0]);
const passed = report.checks.filter((c) => c.ok).length;
console.log('\n' + passed + '/' + report.checks.length + ' 项通过；控制台错误 ' + (report.consoleErrors || []).length + '；页面异常 ' + (report.pageErrors || []).length);
console.log('证据：' + outPath);
process.exitCode = report.ok ? 0 : 1;
