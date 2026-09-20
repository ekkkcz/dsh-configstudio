/**
 * 第三轮反馈 2：对比页显眼处显示 token 消耗、速度等数据 —— **零费用**。
 *
 * 用户原话："然后最终页面也要写上消耗 token，速度，等数据"。
 * 数据服务端一直都有（v0.3.0 已渲染进「展开配置」），只是默认折叠 = 用户看不见。
 *
 * ★ 速度口径是本脚本的重点（上一轮实测踩过坑）：
 *   总速度 = outputTokens / (finishedAt - startedAt)
 *   **绝不能**用 outputTokens / (finishedAt - firstTextAt)：推理型模型先吐完 reasoning token
 *   才出正文，用户那条实验"等首正文"就花了 168.3 秒，正文只写了 11.1 秒，
 *   拿后者当分母会算成 3703 tok/s。所以这里既断言正确值出现，也断言错误值**不出现**。
 *
 * 用法：
 *   node scripts/m2-usage-metrics-check.mjs --base http://127.0.0.1:8902 --title "写个秦始皇骑北极熊"
 *   node scripts/m2-usage-metrics-check.mjs --base ... --title ... --base-null http://127.0.0.1:8790 --title-null "M2 轮询不打断操作"
 *   （--base-null 用于验证"用量未上报"路径：必须写"未上报"，不能写 0）
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from '../src/preview/browser.js';
import { writeEvidence } from './lib/redact.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const getArg = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const BASE = getArg('--base', 'http://127.0.0.1:8902');
const TITLE = getArg('--title', '');
const BASE_NULL = getArg('--base-null', '');
const TITLE_NULL = getArg('--title-null', '');
const OUT = join(here, '..', 'docs', 'evidence');
mkdirSync(OUT, { recursive: true });

/**
 * 指纹是否真的出现在文本里。
 *
 * 不能用朴素的 includes：token 数可能是 81 这种两位数，
 * 而页面上到处都是时间戳、耗时、hash —— "81" 很容易作为**更长数字的一部分**偶然命中
 *（2026-09-18 在一条真实实验上被误报过一次，那次实验的输出 token 数就是 81）。
 * 所以纯数字要求**两侧都不是数字**才算命中；带字母/符号的指纹（模型 id、档位清单）照常 substring。
 */
function fingerprintHit(text, value) {
  if (!value) return false;
  const s = String(value);
  if (/^\d+$/.test(s)) return new RegExp('(^|[^0-9])' + s + '([^0-9]|$)').test(text);
  return text.includes(s);
}

const report = { startedAt: new Date().toISOString(), base: BASE, title: TITLE, checks: [] };
const add = (area, name, ok, detail) => {
  report.checks.push({ area, name, ok: Boolean(ok), detail: detail === undefined ? null : detail });
  console.log((ok ? '  ✓ ' : '  ✗ ') + '[' + area + '] ' + name + (detail === undefined ? '' : '  ' + JSON.stringify(detail).slice(0, 260)));
};

const b = await launchBrowser();
if (!b.ok) { console.log('无法启动浏览器：' + b.reason); process.exitCode = 1; }
else {
  const browser = b.browser;
  const consoleErrors = [];
  const pageErrors = [];
  const shots = [];
  let page = null;
  const shot = async (n) => { writeFileSync(join(OUT, 'm2-' + n + '.png'), await page.screenshot({ type: 'png' })); shots.push(n); };

  /**
   * 打开某个实例上按标题搜到的第 rowIndex 条实验，停在对比页。
   *
   * rowIndex 是给"盲选硬前置"用的：同名实验可能有好几条，最新的那条可能已经被别的
   * 验收脚本走完盲选并揭晓了（揭晓不可逆）。这时**只能换一条**，
   * 不能拿已揭晓的实验去断言"脱敏生效"。
   */
  const openExperiment = async (base, title, viewport, rowIndex = 0) => {
    const ctx = await browser.newContext({ viewport: viewport || { width: 1600, height: 1000 } });
    const p = await ctx.newPage();
    p.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300)); });
    p.on('pageerror', (e) => pageErrors.push(String(e.message).slice(0, 300)));
    await p.goto(base + '/configstudio/api/ui', { waitUntil: 'load', timeout: 30000 });
    await p.waitForSelector('#mode-badge', { timeout: 20000 });
    await p.waitForTimeout(1100);
    if (title) { await p.fill('#search', title); await p.waitForTimeout(1400); }
    const rows = p.locator('#experiment-list .exp');
    const count = await rows.count();
    if (count === 0) throw new Error('列表里没有匹配「' + title + '」的实验');
    await rows.nth(Math.min(rowIndex, count - 1)).locator('button:has-text("打开")').click();
    await p.waitForSelector('#view-compare:not([hidden])', { timeout: 20000 });
    await p.waitForTimeout(2200);
    return p;
  };

  try {
    // 先找到一条**尚未揭晓**的实验：逐条打开检查，已揭晓的就关掉换下一条。
    // 这是"盲选断言必须有未揭晓硬前置"的落地 —— 找不到就明确失败，绝不在已揭晓的画面上断言脱敏。
    let picked = null;
    let lastState = null;
    for (let i = 0; i < 12; i += 1) {
      const p = await openExperiment(BASE, TITLE, null, i);
      lastState = await p.evaluate(() => ({
        revealed: window.__htmlArena.state.revealed,
        blindBtnVisible: document.getElementById('btn-blind').hidden === false,
        title: window.__htmlArena.state.current.experiment.title,
        id: window.__htmlArena.state.current.experiment.id,
      }));
      if (lastState.revealed !== true && lastState.blindBtnVisible) { picked = { page: p, index: i, state: lastState }; break; }
      console.log('  · 第 ' + (i + 1) + ' 条「' + TITLE + '」已揭晓，换下一条');
      await p.context().close();
    }
    if (!picked) {
      throw new Error('按标题「' + TITLE + '」找不到未揭晓的实验（试了 12 条）。'
        + '盲选脱敏不能在已揭晓的画面上断言 —— 请换一条未揭晓的实验（--title）。最后一个状态：' + JSON.stringify(lastState));
    }
    page = picked.page;
    add('准备', '选用的实验尚未揭晓（盲选断言的硬前置条件）',
      picked.state.revealed !== true && picked.state.blindBtnVisible,
      { rowIndex: picked.index, ...picked.state });
    const expected = await page.evaluate(() => {
      const st = window.__htmlArena.state;
      const shown = [];
      const seen = {};
      st.current.attempts.forEach((a) => { if (!seen[a.slot] || a.attemptNo > seen[a.slot].attemptNo) seen[a.slot] = a; });
      Object.keys(seen).forEach((k) => shown.push(seen[k]));
      return shown.map((a) => {
        const r = a.receipt || {};
        const u = r.usage || null;
        const ms = (r.startedAt && r.finishedAt) ? r.finishedAt - r.startedAt : null;
        const ttft = (r.startedAt && r.firstTextAt) ? r.firstTextAt - r.startedAt : null;
        const wrongMs = (r.firstTextAt && r.finishedAt) ? r.finishedAt - r.firstTextAt : null;
        return {
          id: a.id, cand: String.fromCharCode(65 + shown.indexOf(a)),
          hasReceipt: Boolean(a.receipt), usage: u,
          totalSpeed: (u && u.outputTokens !== null && u.outputTokens !== undefined && ms) ? u.outputTokens / (ms / 1000) : null,
          wrongSpeed: (u && u.outputTokens && wrongMs) ? u.outputTokens / (wrongMs / 1000) : null,
          ttftSec: ttft === null ? null : ttft / 1000,
          totalSec: ms === null ? null : ms / 1000,
        };
      });
    });

    // ── 1) 不用展开任何折叠面板就能看到 ───────────────────────
    const foldOpen = await page.evaluate(() => {
      const d = document.getElementById('compare-config');
      return d ? d.open : null;
    });
    add('显眼处', '「展开配置」仍处于默认折叠状态（没有靠展开才看到）', foldOpen === false, { open: foldOpen });

    const strips = await page.$$eval('.frame-wrap', (els) => els.map((e) => {
      const s = e.querySelector('.usage-strip');
      const r = s ? s.getBoundingClientRect() : null;
      return {
        hasStrip: Boolean(s),
        visible: Boolean(s) && s.offsetParent !== null && r.height > 0,
        inCard: Boolean(s) && e.contains(s),
        blind: s ? s.getAttribute('data-blind') : null,
        text: s ? s.innerText.replace(/\s+/g, ' ').trim() : null,
        cards: s ? s.querySelectorAll('.usage-cell').length : 0,
        topUnderHead: Boolean(s) && s.previousElementSibling !== null && s.previousElementSibling.classList.contains('frame-body'),
      };
    }));
    add('显眼处', '每个作品卡里都有一条用量摘要，且不在折叠区里',
      strips.length === expected.length && strips.every((s) => s.hasStrip && s.visible && s.inCard && s.topUnderHead),
      strips.map((s) => ({ has: s.hasStrip, vis: s.visible, cells: s.cards })));
    add('显眼处', '摘要里确实有内容（不是空壳）', strips.every((s) => s.text && s.text.length > 20), strips.map((s) => (s.text || '').slice(0, 90)));

    // ── 2) 数字与口径正确 ─────────────────────────────────────
    const withReceipt = expected.filter((x) => x.hasReceipt && x.usage);
    add('准备', '打开了有真实用量的实验（前置条件）', withReceipt.length >= 1, withReceipt.map((x) => x.cand));

    const digitCheck = [];
    for (let i = 0; i < strips.length; i++) {
      const exp = expected[i];
      const text = strips[i].text || '';
      if (!exp || !exp.hasReceipt || !exp.usage) continue;
      const row = { cand: exp.cand, text: text.slice(0, 200) };
      row.input = text.includes('输入 ' + exp.usage.inputTokens + ' tok');
      row.output = text.includes('输出 ' + exp.usage.outputTokens + ' tok');
      row.total = exp.usage.totalTokens === null || exp.usage.totalTokens === undefined
        ? /合计 未上报 tok/.test(text) : text.includes('合计 ' + exp.usage.totalTokens + ' tok');
      row.reasoning = exp.usage.reasoningTokens === null || exp.usage.reasoningTokens === undefined
        ? /推理 未上报 tok/.test(text) : text.includes('推理 ' + exp.usage.reasoningTokens + ' tok');
      row.speed = exp.totalSpeed === null ? /总速度 未上报/.test(text) : text.includes('总速度 ' + exp.totalSpeed.toFixed(1) + ' tok/s');
      row.ttft = exp.ttftSec === null ? /首正文延迟 未上报/.test(text) : text.includes('首正文延迟 ' + exp.ttftSec.toFixed(1) + ' 秒');
      row.totalSec = exp.totalSec === null ? /总耗时/.test(text) : text.includes('总耗时 ' + exp.totalSec.toFixed(1) + ' 秒');
      digitCheck.push(row);
    }
    const digitOk = (k) => digitCheck.length > 0 && digitCheck.every((r) => r[k]);
    add('数据口径', '输入 / 输出 tokens 与实际用量逐位一致', digitOk('input') && digitOk('output'), digitCheck);
    add('数据口径', '合计 tokens 一致；未上报时写"未上报"而不是 0', digitOk('total'), digitCheck.map((r) => r.total));
    add('数据口径', '推理 tokens 缺失写"未上报"（这次真实实验就是 null）', digitOk('reasoning'), digitCheck.map((r) => r.reasoning));
    add('数据口径', '总速度 = outputTokens /（开始→结束），逐位一致', digitOk('speed'), digitCheck.map((r) => r.speed));
    add('数据口径', '首正文延迟 = firstTextAt - startedAt，逐位一致', digitOk('ttft'), digitCheck.map((r) => r.ttft));
    add('数据口径', '总耗时 = finishedAt - startedAt', digitOk('totalSec'), digitCheck.map((r) => r.totalSec));

    // ★ 反例：错误口径（首正文之后的时间当分母）算出来的值绝不能出现
    const pageText = (await page.textContent('#view-compare')).replace(/\s+/g, ' ');
    const wrongValues = withReceipt.filter((x) => x.wrongSpeed !== null).map((x) => x.wrongSpeed.toFixed(1));
    const leakedWrong = wrongValues.filter((v) => pageText.includes(v));
    add('数据口径', '错误口径（首正文之后的时间当分母，如 3703.4 tok/s）没有出现在页面上',
      leakedWrong.length === 0, { wrongValues, leakedWrong, sample: digitCheck.map((r) => (r.text || '').slice(0, 120)) });

    // 摘要里写清了两个口径各自的含义
    const noteText = (await page.textContent('#compare-note')) + ' ' + (await page.textContent('#expand-note'));
    add('数据口径', '界面上写明了"总速度"与"首正文延迟"是两个不同的口径',
      /总速度/.test(pageText) && /首正文延迟/.test(pageText), { noteSample: noteText.slice(0, 160) });
    await shot('usage-strip-visible');

    // ── 3) 盲选指纹判定 ───────────────────────────────────────
    // 前置条件：这条实验必须**还没揭晓**（揭晓不可逆，已揭晓的实验上不再提供隐藏开关）。
    // 不硬断言的话，这里会点到一个已经不存在的按钮上，然后拿着"没脱敏"的画面去断言脱敏 ——
    // 那是最坏的一种假证据（2026-09-18 实测踩到，换实验才修好）。所以宁可直接报错。
    // 现在这条前置条件在**打开实验之前**就已经逐条检查过了（见上面的 picked），
    // 这里再核一次：中途状态若被别的动作改掉，同样立刻报错而不是继续往下断言。
    const revealState = await page.evaluate(() => ({
      revealed: window.__htmlArena.state.revealed,
      blindBtnVisible: document.getElementById('btn-blind').hidden === false,
    }));
    if (revealState.revealed === true || !revealState.blindBtnVisible) {
      throw new Error('这条实验已经揭晓过了，无法用它验证盲选脱敏。请换一条未揭晓的实验（--title）。');
    }
    const blindBefore = await page.evaluate(() => window.__htmlArena.state.blind);
    if (blindBefore !== true) await page.click('#btn-blind');
    await page.waitForTimeout(900);
    const blindStrips = await page.$$eval('.frame-wrap .usage-strip', (els) => els.map((e) => ({
      blind: e.getAttribute('data-blind'),
      text: e.innerText.replace(/\s+/g, ' ').trim(),
      cells: e.querySelectorAll('.usage-cell').length,
      title: e.getAttribute('title') || '',
    })));
    const ident = await page.evaluate(() => {
      const words = [];
      window.__htmlArena.state.current.attempts.forEach((a) => {
        if (a.recipe.provider) words.push(a.recipe.provider);
        if (a.recipe.model) words.push(a.recipe.model);
        if (a.recipe.name && a.recipe.name.length >= 3) words.push(a.recipe.name);
      });
      return words;
    });
    const stripBlindText = blindStrips.map((s) => s.text).join(' ');
    add('盲选', '隐藏身份期间用量摘要不泄露 provider / model / 候选名',
      ident.every((w) => !stripBlindText.includes(w)), { leaked: ident.filter((w) => stripBlindText.includes(w)) });
    report.fingerprintNote = '纯数字指纹按"两侧不是数字"匹配：token 数可能是 81 这种两位数，朴素 includes 会误报。';
    add('盲选', '隐藏身份期间不显示具体数值（数值组合是模型指纹，与上下文窗口同类处理）',
      blindStrips.every((s) => s.blind === '1' && s.cells === 0), blindStrips.map((s) => ({ blind: s.blind, cells: s.cells })));
    add('盲选', '隐藏原因是写给用户看的（说明揭晓后可见），不是空白',
      blindStrips.every((s) => /揭晓后可见/.test(s.text)) && blindStrips.some((s) => s.title.length > 20),
      blindStrips.map((s) => s.text.slice(0, 60)));
    // 指纹断言：上下文窗口 / 档位清单 / 这次的 token 数都不能出现在盲选页面上
    const blindPage = (await page.textContent('#view-compare')).replace(/\s+/g, ' ');
    const fp = await page.evaluate(() => {
      const out = [];
      window.__htmlArena.state.current.attempts.forEach((a) => {
        const r = a.resolved || {};
        if (Number.isInteger(r.contextWindow)) out.push(String(r.contextWindow));
        if (Number.isInteger(r.defaultMaxTokens)) out.push(String(r.defaultMaxTokens));
        if (Array.isArray(r.availableReasoningEfforts) && r.availableReasoningEfforts.length) out.push(r.availableReasoningEfforts.join(' / '));
        const u = (a.receipt || {}).usage || {};
        [u.inputTokens, u.outputTokens, u.totalTokens].forEach((v) => { if (Number.isInteger(v)) out.push(String(v)); });
      });
      return out;
    });
    const leakedFp = fp.filter((v) => fingerprintHit(blindPage, v));
    add('盲选', '盲选状态下上下文窗口 / 档位清单 / token 数都不出现在页面上',
      leakedFp.length === 0, { fingerprints: fp.slice(0, 12), leakedFp });
    await shot('usage-strip-blind');

    // 揭晓后立刻回来（不能因为脱敏把功能关掉）
    await page.click('#btn-blind');
    await page.waitForTimeout(900);
    const afterReveal = await page.$$eval('.frame-wrap .usage-strip .usage-cell', (e) => e.length);
    add('盲选', '取消盲选后数值立即回来（脱敏不是把功能关掉）', afterReveal === strips.reduce((n, s) => n + s.cards, 0), { cells: afterReveal });

    // ── 4) 不引入新的重绘缺陷 ─────────────────────────────────
    const before = await page.$$eval('.frame-wrap iframe', (e) => e.map((x) => x.src));
    await page.click('.seg-btn[data-vp="mobile"]');
    await page.waitForTimeout(1500);
    const after = await page.$$eval('.frame-wrap iframe', (e) => e.map((x) => x.src));
    add('重绘', '切视口后每个卡片的用量摘要仍在', (await page.$$eval('.frame-wrap .usage-strip', (e) => e.length)) === strips.length);
    add('重绘', '切视口重绘后作品的预览地址不变（iframe 被重建但作品一致）',
      before.length === after.length && before.every((s, i) => s.split('?')[0] === after[i].split('?')[0]), { before: before.length, after: after.length });

    // ── 5) 用量真的没上报时的路径（第二个实例）────────────────
    if (BASE_NULL) {
      await page.context().close();
      page = await openExperiment(BASE_NULL, TITLE_NULL);
      const nullStrips = await page.$$eval('.frame-wrap .usage-strip', (els) => els.map((e) => e.innerText.replace(/\s+/g, ' ').trim()));
      add('未上报路径', '有一个候选真的没上报用量（前置条件）', nullStrips.some((t) => /未上报/.test(t)), nullStrips.map((t) => t.slice(0, 120)));
      add('未上报路径', '该候选的 token 与速度写"未上报"，绝不写 0',
        nullStrips.some((t) => /输入 未上报 tok/.test(t) && /总速度 未上报|总耗时/.test(t)) &&
        !nullStrips.some((t) => /输入 0 tok/.test(t)), nullStrips);
      await shot('usage-strip-unreported');
    }

    report.expected = expected;
    report.consoleErrors = consoleErrors;
    report.pageErrors = pageErrors;
    report.shots = shots;
    report.finishedAt = new Date().toISOString();
    report.ok = report.checks.every((c) => c.ok) && consoleErrors.length === 0 && pageErrors.length === 0;
  } catch (err) {
    report.error = String(err && err.stack || err).slice(0, 1500);
    try { await shot('99-usage-error'); } catch { /* 忽略 */ }
    report.consoleErrors = consoleErrors;
    report.pageErrors = pageErrors;
    report.ok = false;
  } finally {
    await browser.close();
  }
}

const outPath = join(OUT, 'm2-usage-metrics-' + Date.now() + '.json');
writeEvidence(outPath, report);
if (report.error) console.log('\n脚本中断：' + report.error.split('\n')[0]);
const passed = report.checks.filter((c) => c.ok).length;
console.log('\n' + passed + '/' + report.checks.length + ' 项通过；控制台错误 ' + (report.consoleErrors || []).length + '；页面异常 ' + (report.pageErrors || []).length);
console.log('证据：' + outPath);
process.exitCode = report.ok ? 0 : 1;
