/**
 * A10 完整回归 —— **输入超过大小限制：明确拒绝，原题不被截断后偷偷发送**。
 *
 * 判据（逐条对应验收原文）：
 *  ① 明确拒绝：界面上出现人能读懂的原因，而且原因里必须带**实际上限**与**当前长度**
 *     （只写一句"失败"/"参数错误"不算）；
 *  ② 不偷偷发送：模型调用日志行数仍然是 0（用的是 --llm-log 那个跨进程的计数口径）；
 *  ③ 不留半个 attempt：数据目录里既没有新实验，也没有任何 attempt 记录；
 *  ④ 不截断：题框 / 起始 HTML 框里的 value.length 仍是我填进去的长度（工具没有替你改小）。
 *
 * 为什么必须走真实界面：接口层"拒绝"很好写，难的是**界面把原因如实交出来**、
 * 而且拒绝之后用户改好输入还能正常开始。所以这里全程用真实 Chromium 点按钮，
 * 最后再加一组**对照组**：把起始 HTML 清空、题目恢复正常，点开始必须真的跑起来 ——
 * 否则"被拒绝"就可能只是因为这个环境根本起不来。
 *
 * 超限是怎么造出来的（如实说明）：
 *  · 题目：page.fill('#task-prompt', 'x'.repeat(52000))，走的是 Playwright 的真实
 *    填表路径（会派发 input 事件，界面上的 "n / 50000" 计数器因此会更新）；
 *  · 起始 HTML：同样先用 page.fill 给 #task-starthtml 赋值 2.20MB；只有在 fill 超时
 *    或报错时才退回 page.evaluate + 手派 input 事件，并且把**实际用了哪种**写进证据。
 *
 * 全程零费用：模拟模型（scripts/simulated-llm.mjs）+ 真实 Chromium，不调用任何真实模型。
 *
 * 用法：node scripts/m3-input-limit-check.mjs
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchBrowser } from '../src/preview/browser.js';
import {
  sleep, freePort, api, postJson, startDevServer, waitHealthy, hardKill, logLines, makeChecker,
} from './lib/devhost.mjs';

const { add, report, finish } = makeChecker({
  what: 'A10：输入超过大小限制（题目 > 50000 字符 / 起始 HTML > 2MB）—— 明确拒绝、不截断偷发、不留半个 attempt',
  note: '模拟模型 + 真实 Chromium，零费用；拒绝路径与对照组都在真实界面上点击',
});

const PROMPT_LIMIT = 50000;                                  // src/api.js LIMITS.promptMaxChars
const PROMPT_OVER_CHARS = 52000;                             // 超过 50000 的题目
const HTML_LIMIT_BYTES = 2 * 1024 * 1024;                    // src/api.js LIMITS.startHtmlMaxBytes
const HTML_OVER_CHARS = Math.round(2.2 * 1024 * 1024);       // 2.20MB 的起始 HTML（ASCII，1 字符 = 1 字节）
const NORMAL_PROMPT = '做一个只有一行大字的页面，用内置示例数据。';

const dataDir = mkdtempSync(join(tmpdir(), 'arena-input-limit-'));
const llmLog = join(dataDir, 'llm-calls.jsonl');
const port = await freePort();
const base = 'http://127.0.0.1:' + port + '/configstudio/api';
const uiUrl = 'http://127.0.0.1:' + port + '/configstudio/api/ui';
const server = startDevServer({ port, dataDir, llmLog, latencyMs: 60 });
let browserHandle = null;

/** 数据目录里现在有几个实验、几个 attempt（"没有留下半个 attempt"就是这个数）。 */
async function storeCounts() {
  const list = await api(base, '/experiments');
  const experiments = (list.body && list.body.experiments) || [];
  let attempts = 0;
  for (const e of experiments) {
    const d = await api(base, '/experiments/' + e.id);
    attempts += ((d.body && d.body.attempts) || []).length;
  }
  return { experiments: experiments.length, attempts };
}

/** 等"开始前检查未通过"这块面板出现，并且文案里含指定的每一段（等的是文案，不是一个 hidden 标志）。 */
function waitForStartErrors(page, needles, timeout = 20000) {
  return page.waitForFunction((list) => {
    const box = document.getElementById('start-errors');
    if (!box || box.hidden) return false;
    const text = box.innerText || '';
    for (let i = 0; i < list.length; i += 1) if (text.indexOf(list[i]) < 0) return false;
    return true;
  }, needles, { timeout });
}

/**
 * 给 textarea 填一个很大的值：先用真实 fill（会派发 input 事件），失败才退回 evaluate + 手派 input。
 * 返回实际用了哪种方式 —— 这件事必须写进证据，不能让读者以为都是同一条路径。
 */
async function fillHuge(page, selector, value) {
  const t0 = Date.now();
  try {
    await page.fill(selector, value, { timeout: 60000 });
    return { method: 'page.fill（Playwright 真实填表，派发 input 事件）', ms: Date.now() - t0 };
  } catch (err) {
    const first = String((err && err.message) || err).split('\n')[0];
    await page.evaluate((args) => {
      const elm = document.querySelector(args.sel);
      elm.value = args.val;
      elm.dispatchEvent(new Event('input', { bubbles: true }));
    }, { sel: selector, val: value });
    return { method: 'page.evaluate 赋值 + 手派 input 事件（fill 失败后的退路）', ms: Date.now() - t0, fillError: first };
  }
}

/** 等当前实验的两个候选都跑完（对照组用）。 */
async function waitIdle(expId, timeoutMs = 60000) {
  const t0 = Date.now();
  for (;;) {
    const d = await api(base, '/experiments/' + expId);
    const running = ((d.body && d.body.attempts) || []).filter((a) => a.running || a.status === 'running' || a.status === 'queued');
    if (running.length === 0) return d.body;
    if (Date.now() - t0 > timeoutMs) throw new Error('等对照组跑完超时，仍有 ' + running.length + ' 个在跑');
    await sleep(150);
  }
}

try {
  await waitHealthy(base);
  add('准备', '开发服务器（模拟模型，零费用）+ 模型调用日志已就绪', true, { port, llmLog });

  // 基线：干净的数据库、0 次模型调用（后面的"仍然为 0"才有意义）
  const base0 = await storeCounts();
  add('准备', '基线：数据目录里 0 个实验、0 个 attempt、模型调用 0 行',
    base0.experiments === 0 && base0.attempts === 0 && logLines(llmLog) === 0,
    { ...base0, llmCalls: logLines(llmLog) });

  const b = await launchBrowser();
  if (!b.ok) throw new Error('无法启动浏览器：' + b.reason);
  browserHandle = b.browser;
  add('准备', '真实 Chromium 可用（拒绝路径走界面，不是只调接口）', true, { resolvedFrom: b.resolvedFrom });

  const page = await b.browser.newPage({ viewport: { width: 1500, height: 950 } });
  const consoleErrors = [];
  const pageErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200)); });
  page.on('pageerror', (e) => pageErrors.push(String(e.message).slice(0, 200)));
  await page.goto(uiUrl, { waitUntil: 'load', timeout: 30000 });
  await page.waitForSelector('#mode-badge', { timeout: 20000 });
  await page.waitForTimeout(800);
  await page.click('.tab[data-view="new"]');
  await page.waitForTimeout(300);
  await page.fill('#task-title', 'A10 输入超限（模拟模型）');

  // ══ ① 题目超过 50000 字符 ══════════════════════════════════════════
  const overPrompt = 'x'.repeat(PROMPT_OVER_CHARS);
  await page.fill('#task-prompt', overPrompt);
  const counter = (await page.textContent('#prompt-count')).trim();
  add('A10', '界面自己就把"当前长度 / 上限"摆出来了（开始前就看得见 ' + PROMPT_OVER_CHARS + ' / ' + PROMPT_LIMIT + '）',
    counter.indexOf(String(PROMPT_OVER_CHARS)) >= 0 && counter.indexOf(String(PROMPT_LIMIT)) >= 0,
    { promptCount: counter });

  await page.click('#btn-start');
  await waitForStartErrors(page, ['50000', String(PROMPT_OVER_CHARS)]);
  const promptReject = (await page.innerText('#start-errors')).replace(/\s+/g, ' ').trim();
  add('A10', '题目超限被明确拒绝：原因里带实际上限 50000 与当前长度 ' + PROMPT_OVER_CHARS
    + '，并说明不会替你截断（不是只说"失败"）',
    promptReject.indexOf('50000') >= 0 && promptReject.indexOf(String(PROMPT_OVER_CHARS)) >= 0
      && /不会替你截断/.test(promptReject),
    promptReject.slice(0, 220));

  const afterPromptReject = await storeCounts();
  add('A10', '题目超限：模型调用日志仍为 0 行（没有偷偷发出去）', logLines(llmLog) === 0,
    { llmCalls: logLines(llmLog) });
  add('A10', '题目超限：没有留下半个 attempt（实验 0 个、attempt 0 个）',
    afterPromptReject.experiments === 0 && afterPromptReject.attempts === 0, afterPromptReject);
  const promptValueLen = (await page.inputValue('#task-prompt')).length;
  add('A10', '题目超限：题框里的内容没有被截断（value.length 仍是我填进去的 ' + PROMPT_OVER_CHARS + '）',
    promptValueLen === PROMPT_OVER_CHARS, { valueLength: promptValueLen, filled: PROMPT_OVER_CHARS });

  // 补充口径（接口层交叉验证）：同样超限的请求被 400 拒绝，且错误带字段名
  const apiReject = await postJson(base, '/experiments', { title: 'A10 接口口径', prompt: overPrompt });
  add('A10', '补充口径（接口层）：同样的超限请求返回 400，错误里带 field=prompt 与两个数字',
    apiReject.status === 400 && apiReject.body.field === 'prompt'
      && String(apiReject.body.error).indexOf('50000') >= 0
      && String(apiReject.body.error).indexOf(String(PROMPT_OVER_CHARS)) >= 0,
    { status: apiReject.status, field: apiReject.body.field, error: String(apiReject.body.error).slice(0, 160) });
  const afterApiReject = await storeCounts();
  add('A10', '补充口径：接口层被拒之后也仍然没有实验、没有 attempt',
    afterApiReject.experiments === 0 && afterApiReject.attempts === 0, afterApiReject);

  // ══ ② 起始 HTML 超过 2MB ═══════════════════════════════════════════
  await page.fill('#task-prompt', NORMAL_PROMPT);   // 题目恢复成正常长度，才能单独验证起始 HTML 这条
  // 输出要求在折叠区里：真实用户也要先展开（脚本不能绕过界面状态直接改 DOM 的可填状态）
  await page.locator('#task-starthtml').locator('xpath=ancestor::details[1]/summary').click();
  await page.waitForTimeout(250);
  await page.waitForSelector('#task-starthtml', { state: 'visible', timeout: 10000 });
  const htmlOver = 'x'.repeat(HTML_OVER_CHARS);
  const fillInfo = await fillHuge(page, '#task-starthtml', htmlOver);
  report.addHtmlFill = fillInfo;
  add('准备', '起始 HTML 已填入 ' + (HTML_OVER_CHARS / 1024 / 1024).toFixed(2) + 'MB（方式：' + fillInfo.method + '）',
    (await page.inputValue('#task-starthtml')).length === HTML_OVER_CHARS,
    { ms: fillInfo.ms, chars: HTML_OVER_CHARS });

  await page.click('#btn-start');
  await waitForStartErrors(page, ['2MB']);
  const htmlReject = (await page.innerText('#start-errors')).replace(/\s+/g, ' ').trim();
  add('A10', '起始 HTML 超限被明确拒绝：原因里带 2MB 上限与当前大小（2.20MB），同样说明不会替你截断',
    htmlReject.indexOf('2MB') >= 0 && /当前 2\.\d\dMB/.test(htmlReject) && /不会替你截断/.test(htmlReject),
    htmlReject.slice(0, 220));

  const afterHtmlReject = await storeCounts();
  add('A10', '起始 HTML 超限：模型调用日志仍为 0 行（没有偷偷发出去）', logLines(llmLog) === 0,
    { llmCalls: logLines(llmLog) });
  add('A10', '起始 HTML 超限：没有留下半个 attempt（实验 0 个、attempt 0 个）',
    afterHtmlReject.experiments === 0 && afterHtmlReject.attempts === 0, afterHtmlReject);
  const htmlValueLen = (await page.inputValue('#task-starthtml')).length;
  add('A10', '起始 HTML 超限：内容没有被截断（value.length 仍是我填进去的 ' + HTML_OVER_CHARS + '）',
    htmlValueLen === HTML_OVER_CHARS, { valueLength: htmlValueLen, filled: HTML_OVER_CHARS });

  // ══ ③ 对照组：把输入修好，点开始必须真的跑起来 ═════════════════════
  await page.fill('#task-starthtml', '');
  await page.fill('#task-prompt', NORMAL_PROMPT + '（对照组）');
  await page.click('#btn-start');
  await page.waitForFunction(() => {
    const st = window.__htmlArena.state;
    return Boolean(st.current && st.current.experiment && st.current.attempts.length > 0);
  }, undefined, { timeout: 60000 });
  const expId = await page.evaluate(() => window.__htmlArena.state.current.experiment.id);
  const control = await waitIdle(expId);
  add('对照', '修好输入后真的跑起来了：新建了实验、两个候选都有 attempt',
    control.attempts.length === 2 && control.attempts.every((a) => a.status === 'completed'),
    { experimentId: expId, attempts: control.attempts.map((a) => ({ slot: a.slot, st: a.status })) });
  add('对照', '对照组确实发生了模型调用（说明前面的"拒绝"不是因为环境起不来）',
    logLines(llmLog) === 2, { llmCalls: logLines(llmLog) });
  add('对照', '对照组开始时，之前的拒绝提示已经收起（不会一直挂在那里误导用户）',
    await page.evaluate(() => document.getElementById('start-errors').hidden));

  // 注意口径：这两次拒绝本身就是 HTTP 400，浏览器会在网络层记一条 "Failed to load resource: 400"。
  // 那不是缺陷（它恰好证明拒绝发生在服务端、不是前端悄悄拦下），所以把这两条单独数出来，
  // 断言的是"除了这两条可预期的 400 之外，没有别的控制台错误"。
  const expected400 = consoleErrors.filter((t) => /Failed to load resource/.test(t) && /400/.test(t));
  const otherErrors = consoleErrors.filter((t) => !(/Failed to load resource/.test(t) && /400/.test(t)));
  add('界面', '两次拒绝各留下 1 条可预期的 400 网络记录（证明是服务端拒绝，不是前端自己拦下）',
    expected400.length === 2, { expected400: expected400.slice(0, 3) });
  add('界面', '除这两条可预期的 400 之外：0 控制台错误、0 页面异常',
    otherErrors.length === 0 && pageErrors.length === 0,
    { otherErrors: otherErrors.slice(0, 3), pageErrors: pageErrors.slice(0, 3) });

  report.measurements = {
    prompt: {
      limit: PROMPT_LIMIT, filled: PROMPT_OVER_CHARS, valueLengthAfterReject: promptValueLen,
      counterText: counter, rejectionText: promptReject,
    },
    startHtml: {
      limitBytes: HTML_LIMIT_BYTES, filledChars: HTML_OVER_CHARS, valueLengthAfterReject: htmlValueLen,
      fill: fillInfo, rejectionText: htmlReject,
    },
    counts: {
      baseline: base0, afterPromptReject, afterApiReject, afterHtmlReject,
      controlAttempts: control.attempts.length,
    },
    llmCalls: { afterRejects: 0, afterControl: logLines(llmLog) },
    console: { expected400: expected400.length, otherErrors, pageErrors },
  };
  report.notes = [
    '题目超限用的是 page.fill（真实填表路径）:' + PROMPT_OVER_CHARS + ' 个字符。',
    '起始 HTML 超限用的是 ' + fillInfo.method + '；耗时 ' + fillInfo.ms + 'ms。',
    '「没有偷偷发送」的判据是 --llm-log 那个文件的行数：两次拒绝之后它一直是 0，'
      + '对照组跑完变成 ' + logLines(llmLog) + '（2 个候选各一次）。',
    '「没有留下半个 attempt」的判据是数据目录里的实验数与 attempt 总数：拒绝路径上两者都是 0。',
    '控制台里那 2 条 "Failed to load resource: 400" 是两次拒绝自身的网络层记录（每次拒绝 1 条），'
      + '已单独计数；除它们之外没有别的控制台错误与页面异常。',
  ];

  await page.close();
  await b.browser.close();
  browserHandle = null;
} catch (err) {
  add('执行', '脚本运行没有抛异常', false, String((err && err.stack) || err).slice(0, 1500));
} finally {
  try { if (browserHandle) await browserHandle.close(); } catch { /* 已关 */ }
  try { await hardKill(server, '开发服务器（收尾）'); } catch { /* 已经没了 */ }
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }
}

process.exit(finish('m3-input-limit'));
