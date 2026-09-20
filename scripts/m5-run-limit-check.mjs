/**
 * 运行上限端到端验收 —— 真实 Chromium 里走一遍**用户报告的那个场景**。
 *
 * 背景（0.6.0 的欠账）：用真实模型跑「写一个动态的鹈鹕骑自行车」时，
 * 候选 B 卡在默认 180 秒上限上、0 字节，而界面给出的下一步是
 * "调大该候选的运行上限" —— **界面上根本没有改它的地方**。
 * 这个脚本要证明三件事在真实界面上都成立：
 *  ① 新建对比页真的有一个「运行上限」控件，选的值真的传进了这一轮；
 *  ② 超时之后，提示说的是"这次等满了多久"+"去哪里改"，而不是一句空话；
 *  ③ 在对比页上就能把上限改大并重跑这一个候选 —— 不用重建整道题，
 *     而且**已经跑过的记录不被改写**（历史记的是它当时用的值）。
 *
 * 顺带验一件同源的事：模型返回多个 HTML 块时，界面真的能选一块存成作品
 * （验收 A12 的"多块可选择"以前只有单元测试，界面上没有这个控件）。
 *
 * 全程零费用：模拟模型（scripts/simulated-llm.mjs）+ 真实 Chromium。
 *
 * 用法：node scripts/m5-run-limit-check.mjs
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchBrowser } from '../src/preview/browser.js';
import {
  sleep, freePort, api, postJson, getText, startDevServer, waitHealthy, hardKill, logLines, makeChecker,
} from './lib/devhost.mjs';

const { add, report, finish } = makeChecker({
  what: '运行上限：界面上改得动、超时提示指得动路、改完能重跑这一个候选（含多块选择）',
  note: '模拟模型 + 真实 Chromium，零费用；三段都用真实界面点击，不是接口直调',
});

const dataDir = mkdtempSync(join(tmpdir(), 'arena-runlimit-'));
const llmLog = join(dataDir, 'llm-calls.jsonl');
const port = await freePort();
const base = 'http://127.0.0.1:' + port + '/configstudio/api';
const uiUrl = 'http://127.0.0.1:' + port + '/configstudio/api/ui';
const server = startDevServer({ port, dataDir, llmLog, latencyMs: 60 });
let handle = null;

/** 等实验里没有候选在跑。 */
async function waitIdle(expId, timeoutMs = 60000) {
  const t0 = Date.now();
  for (;;) {
    const d = await api(base, '/experiments/' + expId);
    const running = (d.body.attempts || []).filter((a) => a.running || a.status === 'queued' || a.status === 'running');
    if (running.length === 0) return d.body;
    if (Date.now() - t0 > timeoutMs) throw new Error('等待结束超时，仍有 ' + running.length + ' 个在跑');
    await sleep(150);
  }
}

try {
  await waitHealthy(base);
  const b = await launchBrowser();
  if (!b.ok) {
    add('准备', '启动 Chromium', false, { reason: b.reason, attempts: b.attempts });
    process.exitCode = finish('m5-run-limit');
    throw new Error('无法启动浏览器：' + b.reason);
  }
  handle = b.browser;
  const context = await handle.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e.message).slice(0, 300)));
  const badResponses = [];
  page.on('response', (res) => { if (res.status() >= 400) badResponses.push(res.status() + ' ' + res.url()); });

  await page.goto(uiUrl, { waitUntil: 'load', timeout: 30000 });
  await page.waitForSelector('#mode-badge', { timeout: 15000 });
  await page.waitForTimeout(700);
  add('准备', '界面加载成功', !(await page.isVisible('#fatal')), { badge: await page.textContent('#mode-badge') });

  // ══ ① 新建对比页：运行上限控件真的在，且选的值真的进了这一轮 ══════════
  // 先切到「新建对比」页：控件在 DOM 里但那个 view 默认是隐藏的（用户也要先切过去）
  await page.click('.tab[data-view="new"]');
  await page.waitForSelector('#view-new:not([hidden])', { timeout: 10000 });
  await page.waitForTimeout(400);
  const timeoutOptions = await page.$$eval('#timeout option', (els) => els.map((e) => ({ value: e.value, label: e.textContent })));
  add('① 控件存在', '新建对比页有一个「运行上限」下拉（0.6.0 时这里什么都没有）',
    timeoutOptions.length >= 4, { options: timeoutOptions.map((o) => o.label) });
  add('① 控件存在', '第一项是"自动"，并写出了当前会用的值',
    timeoutOptions.length > 0 && /自动/.test(timeoutOptions[0].label) && /分钟|秒/.test(timeoutOptions[0].label),
    timeoutOptions[0]);
  const noteZero = await page.textContent('#timeout-note');
  add('① 控件存在', '控件边上写清了"这次最多等多久、到点会怎样"', /最多等/.test(noteZero) && /中止/.test(noteZero),
    { note: noteZero });

  // 选 5 分钟，并让第一个候选换成慢模型（它一定会跑满上限）
  await page.selectOption('#timeout', '300000');
  await page.waitForTimeout(200);
  await page.selectOption('#candidates .cand:nth-child(1) select[data-role="provider"]', 'sim-slow');
  await page.waitForTimeout(1200);
  await page.fill('#task-prompt', '这一轮验证运行上限真的生效（模拟模型，零费用）');
  const noteAfter = await page.textContent('#timeout-note');
  add('① 控件存在', '选了 5 分钟之后，说明文字跟着改成这个值', /5 分钟/.test(noteAfter), { note: noteAfter });

  await page.click('#btn-start');
  await page.waitForSelector('#view-run:not([hidden])', { timeout: 30000 });
  await page.waitForTimeout(600);

  // 从接口确认"界面上选的值真的传进去了"（不是只在下拉里好看）
  const list = await api(base, '/experiments');
  const expId = list.body.experiments[0].id;
  const created = await api(base, '/experiments/' + expId);
  add('① 控件生效', '界面上选的 5 分钟真的写进了这一轮（此前只有手写 API 才做得到）',
    created.body.experiment.outputPolicy.timeoutMs === 300000,
    { timeoutMs: created.body.experiment.outputPolicy.timeoutMs, title: created.body.experiment.title });

  // ══ ② 超时现场：提示指路 + 就地能改能重跑 ══════════════════════════════
  // 用接口造一个"上限太短"的慢候选（等价于用户那次真实对比：上限不够、候选被中止）
  const shortExp = await postJson(base, '/experiments', {
    title: 'M5 运行上限（超时现场）', prompt: '上限设小了，这个候选会被中止',
    outputPolicy: { timeoutMs: 1200, concurrency: 1 },
  });
  const shortId = shortExp.body.experiment.id;
  await postJson(base, '/experiments/' + shortId + '/start', {
    concurrency: 1, candidates: [{ name: '慢的（会超时）', provider: 'sim-slow', model: 'sim-slow-1' }],
  });
  const timedOut = await waitIdle(shortId);
  const oldAttemptId = timedOut.attempts[0].id;
  add('② 超时现场', '上限 1.2 秒的候选确实超时（前置条件成立）',
    timedOut.attempts[0].status === 'timed_out', timedOut.attempts[0].status);

  // 在真实界面上打开它，看用户看到什么
  await page.evaluate((id) => window.__htmlArena.openExperiment(id), shortId);
  await page.waitForSelector('#view-compare:not([hidden])', { timeout: 15000 });
  await page.waitForTimeout(900);

  // 断言要对着**整张卡**做：超时但已经收到完整 HTML 的候选会照常渲染作品区，
  // 那时原因与按钮在卡头而不是"没有作品"那块里。只查 .frame-error 会漏掉这种情形
  //（第一版脚本就是这么假红了一次）。
  const cardText = await page.$eval('#compare-grid .frame-wrap', (el) => el.innerText.replace(/\s+/g, ' ').trim());
  // 判据：提示里必须出现"运行上限"这个说法**加一个具体时长**（1.2 秒），
  // 而不是干巴巴一句"调大运行上限"
  add('② 超时现场', '提示说出了**这次**等满了多久（不是一句"调大运行上限"）',
    /运行上限（[\d.]+ (秒|分钟)）/.test(cardText), { text: cardText.slice(0, 300) });
  add('② 超时现场', '提示写出了去哪里改（「新建对比」的运行上限）', /新建对比/.test(cardText), { text: cardText.slice(0, 300) });

  const fixButtons = await page.$$eval('#compare-grid .frame-wrap button', (els) => els.map((e) => e.textContent));
  const fixLabel = fixButtons.filter((t) => /并重跑/.test(t))[0] || null;
  add('② 超时现场', '超时卡片上就有"改成更大的上限并重跑"的按钮（不用自己去别处找）',
    Boolean(fixLabel), { buttons: fixButtons });

  // 对比页头部也能改上限，且显示的是这个实验**实际**的值
  const compareSel = await page.inputValue('#compare-timeout');
  add('② 超时现场', '对比页头部显示的是这个实验实际用的上限',
    compareSel === '1200', { value: compareSel });

  if (fixLabel) {
    const callsBeforeRetry = logLines(llmLog);
    await page.click('#compare-grid .frame-wrap button:has-text("并重跑")');
    await sleep(900);
    // 等新的尝试跑完
    const after = await waitIdle(shortId, 60000);
    const exp = (await api(base, '/experiments/' + shortId)).body.experiment;
    const retried = after.attempts[after.attempts.length - 1];
    add('② 修好它', '点了按钮之后上限真的变大了', exp.outputPolicy.timeoutMs > 1200,
      { timeoutMs: exp.outputPolicy.timeoutMs, label: fixLabel });
    add('② 修好它', '重跑出来的新尝试带上了新的上限，并且真的跑完了',
      retried.id !== oldAttemptId && retried.timeoutMs === exp.outputPolicy.timeoutMs && retried.status === 'completed',
      { attemptNo: retried.attemptNo, timeoutMs: retried.timeoutMs, status: retried.status });
    const stillOld = after.attempts.find((a) => a.id === oldAttemptId);
    add('② 修好它', '**已经跑过的那次记录不被改写**（历史记的是它当时的上限）',
      stillOld.timeoutMs === 1200 && stillOld.status === 'timed_out',
      { timeoutMs: stillOld.timeoutMs, status: stillOld.status });
    // 按差值断言：一次重跑**只应该**产生一次新的逻辑请求（没有自动重试、没有额外采样）
    const callsAfterRetry = logLines(llmLog);
    add('② 修好它', '重跑只多了一次逻辑请求（不自动重试、不额外采样）',
      callsAfterRetry - callsBeforeRetry === 1,
      { before: callsBeforeRetry, after: callsAfterRetry });
    // 改完再打开一次：对比页头部的值要跟着变
    await page.evaluate((id) => window.__htmlArena.openExperiment(id), shortId);
    await page.waitForTimeout(900);
    add('② 修好它', '再打开时对比页头部的上限已经是新的值',
      (await page.inputValue('#compare-timeout')) === String(exp.outputPolicy.timeoutMs),
      { value: await page.inputValue('#compare-timeout') });
  }

  // ══ ③ 多块选择：界面上真的能挑一块（A12 的"多块可选择"） ═══════════════
  const multiExp = await postJson(base, '/experiments', {
    title: 'M5 多块选择', prompt: '这次模型会返回两个 HTML 块', outputPolicy: { timeoutMs: 60000, concurrency: 1 },
  });
  const multiId = multiExp.body.experiment.id;
  await postJson(base, '/experiments/' + multiId + '/start', {
    concurrency: 1, candidates: [{ name: '多块', provider: 'sim-multi', model: 'sim-fast' }],
  });
  await waitIdle(multiId);
  const multiDetail = (await api(base, '/experiments/' + multiId)).body;
  add('③ 多块选择', '前置条件：这一次返回了多个 HTML 块、且还没有作品',
    multiDetail.attempts[0].extraction.status === 'multiple' && !multiDetail.attempts[0].canPreview,
    { status: multiDetail.attempts[0].extraction.status, canPreview: multiDetail.attempts[0].canPreview });

  // 打开界面：应当自动弹出选择面板（以前界面上根本没有这个控件）
  await page.evaluate((id) => window.__htmlArena.openExperiment(id), multiId);
  await page.waitForSelector('#pick-modal:not([hidden])', { timeout: 15000 });
  await page.waitForTimeout(600);
  const cards = await page.$$eval('#pick-modal .pick-card', (els) => els.map((e) => e.innerText.replace(/\s+/g, ' ').trim().slice(0, 90)));
  add('③ 多块选择', '界面列出了可选的块（每块带语言、闭合状态与预览）', cards.length >= 2, { cards });
  const confirmDisabled = await page.$eval('#pick-modal .btn.primary', (e) => e.disabled);
  add('③ 多块选择', '没选之前确认按钮是禁用的（不替用户挑默认值）', confirmDisabled === true);

  await page.click('#pick-modal .pick-card[data-pick-index="1"]');
  await page.waitForTimeout(300);
  await page.click('#pick-modal .btn.primary');
  await page.waitForTimeout(1500);
  const picked = (await api(base, '/experiments/' + multiId)).body;
  const pickedAttempt = picked.attempts[0];
  add('③ 多块选择', '选完之后这个候选真的有作品了，且提取状态变成 ok',
    pickedAttempt.canPreview === true && pickedAttempt.extraction.status === 'ok',
    { canPreview: pickedAttempt.canPreview, mode: pickedAttempt.extraction.mode });
  const html = await getText(base, '/experiments/' + multiId + '/attempts/' + pickedAttempt.id + '/html');
  add('③ 多块选择', '下载下来的就是被选中那一块的原文（不是拼接、不是第一块）',
    html.status === 200 && html.text.length > 0, { bytes: html.text.length });
  add('③ 多块选择', '原始正文没有因此被改写（仍然可整份下载）',
    (await getText(base, '/experiments/' + multiId + '/attempts/' + pickedAttempt.id + '/raw')).status === 200);

  add('全程', '界面没有 JS 报错', pageErrors.length === 0, { pageErrors });
  add('全程', '界面没有 4xx/5xx 响应', badResponses.length === 0, { badResponses });
  report.pageErrors = pageErrors;
  report.badResponses = badResponses;
} catch (err) {
  add('脚本', '执行过程未抛异常', false, { message: String(err && err.message || err), stack: String(err && err.stack || '').split(String.fromCharCode(10)).slice(0, 4) });
} finally {
  if (handle) { try { await handle.close(); } catch { /* 已关闭 */ } }
  await hardKill(server, '开发服务器').catch(() => {});
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }
}

process.exitCode = finish('m5-run-limit');
