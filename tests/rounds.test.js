/**
 * 追加轮次（反馈 3 / 方案 1）的验收测试 —— 全部用模拟模型，零费用。
 *
 * 用户拍的方案是："中途输入 = 新的一轮 attempt"，因此要证明的性质是：
 *   1. 追加一轮**不覆盖**原 attempt —— 第 1 轮的原始正文仍然完整、仍能单独读到（可核对性）；
 *   2. 每一轮各自是一次逻辑请求（F02 不变）—— 每次 runGeneration 的 observedRequests 仍是 1；
 *   3. 下一轮**真的带上了上一轮的上下文**（上一轮的 user 文本 + 上一轮的原始正文），
 *      而不是假装接着聊；
 *   4. 上一轮没有正文（失败/取消）时**拒绝**追加，绝不伪造一条 assistant 消息；
 *   5. 上一轮还在跑时拒绝追加（避免同时挂两个 attempt 到同一个候选上）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { Store } from '../src/core/store.js';
import { createApi, buildCompiledMessages, MESSAGE_COMPILER_VERSION } from '../src/api.js';
import { sha256Hex } from '../src/core/extract.js';

/** 造一个每次调用都记下"它到底收到了什么消息"的假 llm。 */
function recordingLlm(texts) {
  const calls = [];
  let i = 0;
  return {
    calls,
    listProviders: () => [{ id: 'p1', name: 'P1' }],
    async listModels() { return [{ provider: 'p1', id: 'm1', name: 'M1' }]; },
    async resolveModelInfo(provider, model) {
      return { provider, id: model, name: model, context: { contextWindow: 128000 }, defaultMaxTokens: 8192, reasoning: { efforts: [] }, inputModalities: ['text'] };
    },
    stream(options) {
      calls.push({ messages: options.messages.map((m) => ({ role: m.role, text: m.content.map((c) => c.text).join('') })), system: options.system });
      const body = texts[Math.min(i, texts.length - 1)];
      i += 1;
      return (async function* () {
        yield { type: 'text-delta', index: 0, text: body };
        yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      })();
    },
  };
}

/** 起一个只监听回环的测试服务器，返回 { url, close }。 */
async function withServer(runtime, fn) {
  const api = createApi(runtime);
  const server = createServer((req, res) => api.handle(req, res));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = 'http://127.0.0.1:' + server.address().port;
  try { return await fn(url); } finally { await new Promise((r) => server.close(r)); }
}

function makeRuntime(store, llm) {
  const runs = new Map();
  const live = new Map();
  return {
    config: { defaultConcurrency: 2, defaultTimeoutMs: 60000, defaultMaxTokens: null, pluginVersion: 'test', dataDir: store.dataDir },
    store, runs, live, previewOrigin: 'http://127.0.0.1:1',
    llmOf: () => llm, ctx: { get: () => llm },
    settings: { read: () => ({ capabilities: {} }), view: () => ({ capabilities: [] }), update: () => ({ ok: true }) },
    async probeBrowser() { return { available: false, reason: '测试环境' }; },
    async runCandidate(job) {
      const { attemptId, compiled } = job;
      const controller = new AbortController();
      runs.set(attemptId, { controller });
      const { runGeneration } = await import('../src/core/runner.js');
      const { extractHtml, EXTRACTOR_VERSION } = await import('../src/core/extract.js');
      try {
        store.updateAttemptStatus(attemptId, 'running');
        const result = await runGeneration({
          llm, provider: compiled.provider, model: compiled.model, system: compiled.system,
          content: [{ type: 'text', text: compiled.userText }],
          history: compiled.history || [],
          signal: controller.signal,
        });
        const raw = await store.writeRaw(attemptId, result.text ?? '');
        const ex = extractHtml(result.text ?? '', { finishReason: result.receipt.finishReason });
        let info = { hash: null, path: null };
        if (ex.status === 'ok' && ex.html !== null) info = await store.writeHtml(attemptId, ex.html);
        store.createArtifact({
          id: attemptId, attemptId, rawHash: raw.hash, htmlHash: info.hash,
          extractionVersion: EXTRACTOR_VERSION, extractionMode: ex.mode, extractionRange: ex.range,
          extractionStatus: ex.status, extractionWarnings: ex.warnings, rawPath: raw.path, htmlPath: info.path, bytes: raw.bytes,
        });
        store.updateAttemptStatus(attemptId, result.status);
        store.finishReceipt(attemptId, {
          finishReason: result.receipt.finishReason, errorCode: result.receipt.error?.code ?? null,
          errorMessage: result.receipt.error?.message ?? null, errorStatus: result.receipt.error?.status ?? null,
          usage: result.receipt.usage, observedRequests: result.receipt.observedRequests,
        });
        return { status: result.status };
      } finally { runs.delete(attemptId); }
    },
    cancelCandidate() { return { ok: false }; }, cancelAll() { return { cancelled: 0 }; },
    liveFor() { return []; },
  };
}

const HTML = (a) => '这是第 ' + a + ' 版。\n\n' + String.fromCharCode(96).repeat(3) + 'html\n<html><body>v' + a + '</body></html>\n' + String.fromCharCode(96).repeat(3);

async function setup(texts) {
  const dir = mkdtempSync(join(tmpdir(), 'arena-rounds-'));
  const store = new Store(dir);
  const llm = recordingLlm(texts);
  const runtime = makeRuntime(store, llm);
  const taskSnapshot = { prompt: '做一个单文件页面', outputRequirements: '', startHtml: null, createdAt: Date.now() };
  const exp = store.createExperiment({
    title: '追加轮次测试', category: 'dashboard', taskSnapshot,
    taskHash: await sha256Hex(JSON.stringify(taskSnapshot)),
    outputPolicy: { concurrency: 2, timeoutMs: 60000, maxTokens: null },
    previewPolicy: { networkPolicy: 'offline', viewport: 'desktop' },
  });
  return { dir, store, llm, runtime, exp };
}

async function post(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}
/** 等这一轮跑完（runs 空 + 没有 queued/running 的 attempt）。 */
async function waitIdle(store, expId, ms = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const atts = store.listAttempts(expId);
    if (atts.every((a) => a.status !== 'queued' && a.status !== 'running')) return true;
    await new Promise((r) => setTimeout(r, 40));
  }
  return false;
}

test('追加一轮：不覆盖第 1 轮，且下一轮真的带上了上一轮的上下文', async () => {
  const { dir, store, llm, runtime, exp } = await setup([HTML(1), HTML(2)]);
  try {
    await withServer(runtime, async (url) => {
      const started = await post(url + '/experiments/' + exp.id + '/start', {
        candidates: [{ name: 'A', provider: 'p1', model: 'm1' }], concurrency: 2,
      });
      assert.equal(started.status, 202);
      await waitIdle(store, exp.id);

      const round1 = store.listAttempts(exp.id);
      assert.equal(round1.length, 1);
      assert.equal(round1[0].attemptNo, 1);
      const raw1 = store.readRaw(round1[0].id);
      const hash1 = round1[0].artifact.rawTextHash;

      // ── 追加一轮 ──────────────────────────────────────────
      const add = await post(url + '/experiments/' + exp.id + '/rounds', { note: '把背景改成深色' });
      assert.equal(add.status, 202, JSON.stringify(add.body));
      assert.equal(add.body.started[0].attemptNo, 2);
      assert.equal(add.body.started[0].parentAttemptId, round1[0].id);
      await waitIdle(store, exp.id);

      // 1) 原 attempt 完整保留
      const after = store.listAttempts(exp.id);
      assert.deepEqual(after.map((a) => a.attemptNo), [1, 2], '两轮都要在');
      const still1 = after.find((a) => a.attemptNo === 1);
      assert.equal(still1.artifact.rawTextHash, hash1, '第 1 轮的 hash 不能被改写');
      assert.equal(store.readRaw(still1.id), raw1, '第 1 轮的原始正文必须逐字节不变');
      assert.equal(still1.status, 'completed');

      // 2) 第 2 轮是一次独立的逻辑请求，且带上上下文
      assert.equal(llm.calls.length, 2, '追加一轮 = 又发了一次逻辑请求');
      const second = llm.calls[1];
      assert.equal(second.messages.length, 3, '上一轮 user + 上一轮 assistant + 本次 user');
      assert.equal(second.messages[0].role, 'user');
      assert.ok(second.messages[0].text.includes('做一个单文件页面'), '第一条是上一轮真正发出去的输入');
      assert.equal(second.messages[1].role, 'assistant');
      assert.equal(second.messages[1].text, raw1, 'assistant 内容是上一轮的原始正文，逐字节一致（没有伪造）');
      assert.equal(second.messages[2].role, 'user');
      assert.ok(second.messages[2].text.includes('把背景改成深色'), '本轮新输入必须在里面');

      // 3) 两轮各自一次请求（F02 不变）
      const r2 = store.getAttempt(after.find((a) => a.attemptNo === 2).id);
      assert.equal(r2.receipt.observedRequests, 1, '每一轮各自 observedRequests=1');
      const r1r = store.getAttempt(round1[0].id);
      assert.equal(r1r.receipt.observedRequests, 1);

      // 4) 第 2 轮的正文与第 1 轮不同（确实改了，不是复制）
      assert.notEqual(store.readRaw(after.find((a) => a.attemptNo === 2).id), raw1);
    });
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('上一轮没有正文时拒绝追加，绝不伪造 assistant 消息', async () => {
  const { dir, store, runtime, exp } = await setup([HTML(1)]);
  try {
    await withServer(runtime, async (url) => {
      // 造一个"失败了、没有正文"的 attempt：直接建 attempt 并标记失败
      const attemptId = store.createAttempt({
        experimentId: exp.id, candidateSlot: 0, attemptNo: 1,
        recipeSnapshot: { slot: 0, name: 'A', provider: 'p1', model: 'm1', userText: '题目' },
        requestedConfig: { provider: 'p1', model: 'm1' }, resolvedConfig: null, parentAttemptId: null,
      });
      store.updateAttemptStatus(attemptId, 'failed');
      store.finishReceipt(attemptId, { finishReason: 'error', errorCode: 'AUTH', errorMessage: 'x', errorStatus: 401, usage: null, observedRequests: 1 });

      const add = await post(url + '/experiments/' + exp.id + '/rounds', { note: '改一下' });
      assert.equal(add.status, 409, '必须拒绝，而不是硬着头皮发一轮没有上下文的请求');
      assert.ok(add.body.problems.some((p) => /没有产出正文/.test(p)), JSON.stringify(add.body));
      assert.equal(store.listAttempts(exp.id).length, 1, '被拒绝时不能留下半个新 attempt');
    });
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('上一轮还在跑时拒绝追加', async () => {
  const { dir, store, runtime, exp } = await setup([HTML(1)]);
  try {
    await withServer(runtime, async (url) => {
      const attemptId = store.createAttempt({
        experimentId: exp.id, candidateSlot: 0, attemptNo: 1,
        recipeSnapshot: { slot: 0, name: 'A', provider: 'p1', model: 'm1', userText: '题目' },
        requestedConfig: { provider: 'p1', model: 'm1' }, resolvedConfig: null, parentAttemptId: null,
      });
      store.updateAttemptStatus(attemptId, 'running');

      const add = await post(url + '/experiments/' + exp.id + '/rounds', { note: '改一下' });
      assert.equal(add.status, 409);
      assert.ok(add.body.problems.some((p) => /还在生成中/.test(p)), JSON.stringify(add.body));
      assert.equal(store.listAttempts(exp.id).length, 1);
    });
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('空输入被拒绝（不会白花一次调用）', async () => {
  const { dir, store, runtime, exp } = await setup([HTML(1)]);
  try {
    await withServer(runtime, async (url) => {
      const add = await post(url + '/experiments/' + exp.id + '/rounds', { note: '   ' });
      assert.equal(add.status, 400);
    });
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('编译规则：追加轮次会把"本轮要改的地方"和"给完整新版"写进请求', () => {
  const exp = { taskSnapshot: { prompt: '原始题目', outputRequirements: '', startHtml: null } };
  const plain = buildCompiledMessages(exp, [{ provider: 'p', model: 'm' }])[0];
  assert.equal(plain.compilerVersion, MESSAGE_COMPILER_VERSION);
  assert.ok(!plain.userText.includes('本轮要改的地方'));
  assert.ok(!plain.userText.includes('# 输出方式'), '首轮不该出现追加轮次才需要的段落');

  const withRound = buildCompiledMessages(exp, [{ provider: 'p', model: 'm' }], {
    history: [{ role: 'user', text: '旧的' }, { role: 'assistant', text: '旧正文' }],
    roundNote: '把按钮改成圆角',
  })[0];
  assert.ok(withRound.userText.startsWith('# 本轮要改的地方'), '本轮输入放最前面');
  assert.ok(withRound.userText.includes('把按钮改成圆角'));
  assert.ok(withRound.userText.includes('原始题目'), '原题目仍然在');
  assert.ok(/# 输出方式\n[^#]*完整/.test(withRound.userText), '必须要求给完整新版，V1 不做差分合并');
  assert.equal(withRound.history.length, 2, '历史原样带下去');
  assert.equal(withRound.history[1].text, '旧正文');
});

test('首轮不含 history（追加轮次不能污染首轮语义）', () => {
  const exp = { taskSnapshot: { prompt: 'p', outputRequirements: '', startHtml: null } };
  const c = buildCompiledMessages(exp, [{ provider: 'p', model: 'm' }])[0];
  assert.deepEqual(c.history, []);
  assert.equal(c.roundNote, null);
});
