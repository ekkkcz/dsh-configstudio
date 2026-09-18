/**
 * A08 超时路径 + 取消 + A09 重启恢复的**逻辑部分**（M2）。
 *
 * 全链路走生产实现：真实 HTTP API → 真实 core/runtime.js → 真实 SQLite 存储，
 * 只有 llm 是假的，因此零模型费用。
 * 进程级"真的杀掉再起来"的回归在 scripts/m2-restart-recovery-check.mjs 里做。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { explainError } from '../src/core/runner.js';
import { startHarness, call, postJson, newExperiment, waitIdle, asModelOutput } from './lib/arena-harness.js';

const NL = String.fromCharCode(10);
const FENCE = String.fromCharCode(96).repeat(3);

/** 一段很长的正文：每块之间有间隔，足够让运行上限先到。 */
function longOutput(marker) {
  return '这是慢速输出的说明。' + NL + NL + FENCE + 'html' + NL
    + '<!DOCTYPE html><html><body><h1>' + marker + '</h1>' + '<p>' + 'x'.repeat(3000) + '</p></body></html>'
    + NL + FENCE + NL;
}

/** 等某个 attempt 从 runs 里消失（真正跑完），用来观察"迟到输出"的落点。 */
async function waitAttemptSettled(base, expId, timeoutMs = 15000) {
  const t0 = Date.now();
  for (;;) {
    const r = await call(base, '/experiments/' + expId);
    const running = r.body.attempts.filter((a) => a.running);
    if (running.length === 0) return r.body;
    if (Date.now() - t0 > timeoutMs) throw new Error('等待跑完超时');
    await new Promise((res) => setTimeout(res, 60));
  }
}

test('A08 超时：状态落盘为 timed_out，收尾原因与原因码都是超时（不是"未识别"）', async (t) => {
  const h = await startHarness({
    streams: { pa: { text: longOutput('slow'), chunkDelayMs: 70, honorAbort: true } },
  });
  t.after(() => h.close());

  const exp = await newExperiment(h.base, { title: '超时路径', outputPolicy: { timeoutMs: 400 } });
  const started = await postJson(h.base, '/experiments/' + exp.id + '/start', {
    candidates: [{ name: '慢的', provider: 'pa', model: 'pa-m1' }],
  });
  assert.equal(started.status, 202);
  assert.equal(started.body.timeoutMs, 400);

  const detail = await waitIdle(h.base, exp.id);
  const a = detail.attempts[0];
  assert.equal(a.status, 'timed_out');
  assert.equal(a.receipt.finishReason, 'timeout');
  assert.equal(a.receipt.errorCode, 'TIMEOUT');
  assert.match(a.receipt.errorMessage, /运行上限/);
  // 超时也不能编造用量：中止前没有 usage 事件就是 null（F18）
  assert.equal(a.receipt.usage, null);
  // 已经收到的内容仍然保存，并且能下载
  const raw = h.store.readRaw(a.id);
  assert.ok(raw.length > 0, '超时也要保留已收到的正文');
  assert.ok(a.extraction, '超时也要有提取记录（artifact）');
  assert.equal(a.extraction.rawTextHash, h.store.getAttempt(a.id).artifact.rawTextHash);
  assert.equal(a.canPreview, true, '被中止前已经拿到完整 HTML 时仍应可预览');
  const dl = await call(h.base, '/experiments/' + exp.id + '/attempts/' + a.id + '/raw');
  assert.equal(dl.status, 200);
  assert.equal(dl.body, raw);

  // 错误翻译必须给出人能读懂的原因与下一步
  const explained = explainError({ code: a.receipt.errorCode, message: a.receipt.errorMessage });
  assert.equal(explained.title, '请求超时');
  assert.match(explained.hint, /上限|模型/);
});

test('A08 取消与超时是两件事：超时不触发时取消仍记 cancelled', async (t) => {
  const h = await startHarness({
    streams: { pa: { text: longOutput('cancel-me'), chunkDelayMs: 60, honorAbort: true } },
  });
  t.after(() => h.close());

  const exp = await newExperiment(h.base, { title: '取消路径', outputPolicy: { timeoutMs: 60000 } });
  await postJson(h.base, '/experiments/' + exp.id + '/start', {
    candidates: [{ name: '慢的', provider: 'pa', model: 'pa-m1' }],
  });
  // 等它真的开始产出再取消
  for (let i = 0; i < 60; i += 1) {
    const live = await call(h.base, '/experiments/' + exp.id + '/live');
    if ((live.body.streams[0]?.text || '').length > 0) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  const detail0 = await call(h.base, '/experiments/' + exp.id);
  const attemptId = detail0.body.attempts[0].id;
  const cancelled = await postJson(h.base, '/experiments/' + exp.id + '/cancel', { attemptId });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.ok, true);

  const detail = await waitIdle(h.base, exp.id);
  const a = detail.attempts[0];
  assert.equal(a.status, 'cancelled');
  assert.equal(a.receipt.finishReason, 'aborted');
  assert.equal(a.receipt.errorCode, 'ABORTED');
  // 取消不是超时：不能把它记成 TIMEOUT
  assert.notEqual(a.receipt.finishReason, 'timeout');
  // 取消后不会自动重试：仍然只有这一次尝试，也只发生过一次模型调用
  assert.equal(h.store.listAttempts(exp.id).length, 1);
  assert.equal(h.llm.calls.length, 1);
});

test('A08 迟到的输出不会污染新 attempt（被超时那次继续吐，也只落在它自己身上）', async (t) => {
  const MARK = 'LATE-OUTPUT-ONLY-FOR-ATTEMPT-ONE';
  const h = await startHarness({
    streams: {
      // 故意忽略中止信号：超时之后它还会继续吐一段时间（真实世界里服务端也可能这样）
      pc: { text: longOutput(MARK), chunkDelayMs: 45, honorAbort: false },
      pa: { text: asModelOutput('<!DOCTYPE html><html><body><h1>第二次尝试</h1></body></html>', '第二次的说明'), chunkDelayMs: 0 },
    },
  });
  t.after(() => h.close());

  const exp = await newExperiment(h.base, { title: '迟到输出', outputPolicy: { timeoutMs: 250 } });
  await postJson(h.base, '/experiments/' + exp.id + '/start', {
    candidates: [{ name: '不理中止的', provider: 'pc', model: 'pc-m1' }],
  });

  // 等"运行上限已过、但第一次的流还在吐"这个时刻。
  // 注意：这里**不能**等状态变成 timed_out —— 状态是在流真正收尾时才落盘的，
  // 而 pc 故意忽略中止，所以那要等到最后。要观察"迟到的输出"，必须在这个窗口里动手。
  const d0 = await call(h.base, '/experiments/' + exp.id);
  const firstId = d0.body.attempts[0].id;
  await new Promise((r) => setTimeout(r, 700));
  const runNow = h.runtime.runs.get(firstId);
  assert.ok(runNow, '关键前提 ①：这一轮的流还在跑（服务端无视了中止信号）');
  assert.equal(runNow.timedOut, true, '关键前提 ②：运行上限已经到点并已请求中止');

  const secondId = h.store.createAttempt({
    experimentId: exp.id, candidateSlot: 0, attemptNo: 2,
    recipeSnapshot: { name: '第二次', provider: 'pa', model: 'pa-m1' },
    requestedConfig: { provider: 'pa', model: 'pa-m1' }, resolvedConfig: null, parentAttemptId: firstId,
  });
  await h.runtime.runCandidate({
    experimentId: exp.id, attemptId: secondId,
    compiled: { provider: 'pa', model: 'pa-m1', userText: '再试一次', history: [] },
    timeoutMs: 60000,
  });

  // 两次都跑完（第一次的流也终于结束）
  await waitAttemptSettled(h.base, exp.id, 20000);

  const raw1 = h.store.readRaw(firstId);
  const raw2 = h.store.readRaw(secondId);
  assert.ok(raw1.includes(MARK), '第一次尝试自己收到了那段迟到输出');
  assert.equal(raw2.includes(MARK), false, '新 attempt 里不能出现上一次的迟到输出');
  assert.match(raw2, /第二次尝试/);

  const d = await call(h.base, '/experiments/' + exp.id);
  const a1 = d.body.attempts.find((x) => x.id === firstId);
  const a2 = d.body.attempts.find((x) => x.id === secondId);
  assert.equal(a1.status, 'timed_out');
  assert.equal(a2.status, 'completed');
  // 两次确实重叠过：第一次的收尾时间晚于第二次的开始时间
  const r1 = h.store.getAttempt(firstId).receipt;
  const r2 = h.store.getAttempt(secondId).receipt;
  assert.ok(r1.finishedAt > r2.startedAt, '第一次收尾晚于第二次开始 —— 两次确实同时存在过');

  // 两条记录各自绑定自己的正文与作品，不串台
  assert.notEqual(a1.extraction.rawTextHash, a2.extraction.rawTextHash);
  assert.notEqual(a1.extraction.htmlHash, a2.extraction.htmlHash);
  assert.equal(h.store.readHtml(secondId).includes(MARK), false);
  // 第二次的正文与它自己的作品 hash 对得上（不是"看起来没串台"）
  const { sha256Hex } = await import('../src/core/extract.js');
  const html2 = h.store.readHtml(secondId);
  assert.equal(a2.extraction.htmlHash, await sha256Hex(html2));
});

test('A09 未完成的尝试标为 interrupted：不新建 attempt、不自动重新调用、不覆盖已有错误', async (t) => {
  const h = await startHarness({ streams: { pa: { text: asModelOutput('<html></html>') } } });
  t.after(() => h.close());

  const exp = await newExperiment(h.base, { title: '重启恢复' });
  const runningId = h.store.createAttempt({
    experimentId: exp.id, candidateSlot: 0, attemptNo: 1,
    recipeSnapshot: { name: 'A', provider: 'pa', model: 'pa-m1' }, requestedConfig: {}, resolvedConfig: null, parentAttemptId: null,
  });
  const queuedId = h.store.createAttempt({
    experimentId: exp.id, candidateSlot: 1, attemptNo: 1,
    recipeSnapshot: { name: 'B', provider: 'pa', model: 'pa-m1' }, requestedConfig: {}, resolvedConfig: null, parentAttemptId: null,
  });
  const doneId = h.store.createAttempt({
    experimentId: exp.id, candidateSlot: 2, attemptNo: 1,
    recipeSnapshot: { name: 'C', provider: 'pa', model: 'pa-m1' }, requestedConfig: {}, resolvedConfig: null, parentAttemptId: null,
  });
  h.store.updateAttemptStatus(runningId, 'running');
  h.store.updateAttemptStatus(doneId, 'completed');
  // 已经跑完的那次有真实错误：不能被"中断"覆盖掉
  h.store.finishReceipt(queuedId, { finishReason: 'error', errorCode: 'AUTH', errorMessage: '上游 401', observedRequests: 1 });
  h.store.updateAttemptStatus(queuedId, 'running');

  const callsBefore = h.llm.calls.length;
  const attemptsBefore = h.store.listAttempts(exp.id).length;
  const r = h.store.markUnfinishedAsInterrupted();
  assert.equal(r.count, 2);
  assert.deepEqual(r.items.map((i) => i.id).sort(), [runningId, queuedId].sort());

  const after = h.store.listAttempts(exp.id);
  assert.equal(after.find((a) => a.id === runningId).status, 'interrupted');
  assert.equal(after.find((a) => a.id === queuedId).status, 'interrupted');
  assert.equal(after.find((a) => a.id === doneId).status, 'completed');
  // 不伪造收尾时间，也不新建 attempt / 不重新调用模型
  assert.equal(after.find((a) => a.id === runningId).receipt.finishedAt, null);
  assert.equal(h.store.listAttempts(exp.id).length, attemptsBefore);
  assert.equal(h.llm.calls.length, callsBefore);
  // 已有的真实错误原样保留；没错误的补一条能读懂的解释
  assert.equal(after.find((a) => a.id === queuedId).receipt.errorCode, 'AUTH');
  assert.equal(after.find((a) => a.id === runningId).receipt.errorCode, 'INTERRUPTED');
  assert.match(after.find((a) => a.id === runningId).receipt.errorMessage, /重启/);
  // 再调用一次是幂等的（第二次没有可标记的了）
  assert.equal(h.store.markUnfinishedAsInterrupted().count, 0);
});

test('A09 被杀之前收到的正文会定期落盘：partial 存在、可读，且跑完后不残留', async (t) => {
  const h = await startHarness({
    streams: { pa: { text: longOutput('partial-probe'), chunkDelayMs: 60, honorAbort: false } },
  });
  t.after(() => h.close());

  const exp = await newExperiment(h.base, { title: '部分输出', outputPolicy: { timeoutMs: 60000 } });
  await postJson(h.base, '/experiments/' + exp.id + '/start', {
    candidates: [{ name: '慢的', provider: 'pa', model: 'pa-m1' }],
  });
  const d0 = await call(h.base, '/experiments/' + exp.id);
  const attemptId = d0.body.attempts[0].id;

  // 等一次刷盘周期（PARTIAL_FLUSH_MS = 1500）
  await new Promise((r) => setTimeout(r, 2200));

  // 这时"进程还活着但没跑完"：磁盘上应当已经有 partial，界面也能看到它的元信息
  assert.equal(h.store.hasPartial(attemptId), true, '生成过程中应当已经把部分输出刷到磁盘');
  const part = h.store.readPartial(attemptId);
  assert.ok(part.includes('partial-probe'), 'partial 里应当是这一轮真实收到的正文');
  const info = h.store.partialInfo(attemptId);
  assert.equal(info.chars, part.length);
  assert.ok(info.at > 0);

  // 模拟"进程被硬杀之后重新起来"：标记中断（不会自动重跑）
  const marked = h.store.markUnfinishedAsInterrupted();
  assert.equal(marked.count, 1);
  const after = h.store.getAttempt(attemptId);
  assert.equal(after.status, 'interrupted');
  assert.equal(after.receipt.errorCode, 'INTERRUPTED');
  assert.match(after.receipt.errorMessage, /部分输出还在/);
  // 部分输出仍然在，且能原样读回来
  assert.equal(h.store.hasPartial(attemptId), true);
  assert.equal(h.store.readPartial(attemptId), part);

  // 让这一轮自然跑完：raw 落盘之后 partial 必须消失（否则同一轮会有两份"正文"）
  await waitAttemptSettled(h.base, exp.id, 20000);
  assert.equal(h.store.hasPartial(attemptId), false, 'raw 落盘后 partial 要清掉');
  assert.equal(h.store.readRaw(attemptId).includes('partial-probe'), true);
});

test('错误翻译：未识别的错误码要把上游原文带出来，不能只说"未识别"', () => {
  const raw = '404: {"message":"Model \"deepseek/deepseek-v4-pro\" does not exist."}';
  const e = explainError({ code: 'PI_AI_ERROR', message: raw, status: 404 });
  assert.equal(e.code, 'PI_AI_ERROR');
  assert.equal(e.title, '调用失败（未识别的错误）');
  assert.equal(e.message, raw, '上游原文必须能被界面显示出来');
  assert.equal(e.status, 404);
  // 已知错误码不受影响
  assert.equal(explainError({ code: 'AUTH', message: 'x' }).title, '凭据被拒绝（401/403）');
});
