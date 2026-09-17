/**
 * 模型执行器测试 —— 全部使用模拟 llm，不产生任何真实调用或费用。
 * 对应 A07（单个候选失败不影响其它）、A08（取消/超时）、A18（用量缺失）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runGeneration, explainError, listModelCatalog, resolveCandidateConfig } from '../src/core/runner.js';

/** 造一个假的 ctx.llm，可以按脚本吐 chunk。 */
function fakeLlm(chunks, { throwAfter = null, providers = [{ id: 'p1', name: 'P1' }], models = { p1: [{ provider: 'p1', id: 'm1', name: 'M1' }] } } = {}) {
  return {
    listProviders: () => providers,
    async listModels(provider) {
      if (!models[provider]) throw Object.assign(new Error('no adapter for ' + provider), { code: 'NO_ADAPTER' });
      return models[provider];
    },
    async resolveModelInfo(provider, model) {
      if (provider !== 'p1') throw Object.assign(new Error('no adapter'), { code: 'NO_ADAPTER' });
      return { provider, id: model, name: model, context: { contextWindow: 128000 }, defaultMaxTokens: 8192, reasoning: { efforts: [{ id: 'low' }, { id: 'high' }], defaultEffort: 'low' }, inputModalities: ['text'] };
    },
    stream() {
      return (async function* () {
        let i = 0;
        for (const c of chunks) {
          if (throwAfter !== null && i === throwAfter) throw new Error('middleware exploded');
          i += 1;
          yield c;
        }
      })();
    },
  };
}

const USAGE = { type: 'usage', usage: { inputTokens: 12, outputTokens: 34, totalTokens: 46 } };
const FINISH_STOP = { type: 'finish', reason: { kind: 'stop' } };

test('正常完成：收集正文、用量、收尾原因与首事件时间', async () => {
  const events = [];
  const r = await runGeneration({
    llm: fakeLlm([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: '<html>' },
      { type: 'reasoning-delta', index: 1, text: '想想' },
      { type: 'text-delta', index: 0, text: 'x</html>' },
      { type: 'block-end', index: 0, block: { type: 'text', text: '<html>x</html>' } },
      USAGE, FINISH_STOP,
    ]),
    provider: 'p1', model: 'm1', content: [{ type: 'text', text: '题目' }],
    signal: new AbortController().signal, onEvent: (e) => events.push(e),
  });
  assert.equal(r.status, 'completed');
  assert.equal(r.text, '<html>x</html>');
  assert.equal(r.reasoning, '想想');
  assert.equal(r.receipt.usage.inputTokens, 12);
  assert.equal(r.receipt.usage.cacheReadTokens, null, '未提供的字段必须是 null');
  assert.equal(r.receipt.finishReason, 'stop');
  assert.equal(r.receipt.observedRequests, 1);
  assert.ok(r.receipt.queuedAt <= r.receipt.startedAt);
  assert.ok(r.receipt.firstTextAt !== null);
  assert.equal(events.some((e) => e.type === 'first-text'), true);
  assert.equal(events.some((e) => e.type === 'done'), true);
});

test('provider 错误以 finish 到达，不抛异常：标记 failed 并脱敏保存', async () => {
  const r = await runGeneration({
    llm: fakeLlm([{ type: 'finish', reason: { kind: 'error', failure: { code: 'AUTH', message: 'bad key', status: 401, requestId: 'req_123', extra: '不应保存' } } }]),
    provider: 'p1', model: 'm1', content: [{ type: 'text', text: 't' }],
    signal: new AbortController().signal,
  });
  assert.equal(r.status, 'failed');
  assert.equal(r.receipt.error.code, 'AUTH');
  assert.equal(r.receipt.error.status, 401);
  assert.equal(r.receipt.error.requestId, 'req_123');
  assert.equal(r.receipt.error.extra, undefined, '只保存白名单字段');
});

test('取消：status=cancelled，保存已收到的正文与用量', async () => {
  const r = await runGeneration({
    llm: fakeLlm([
      { type: 'text-delta', index: 0, text: 'part' },
      { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'aborted by user' } } },
    ]),
    provider: 'p1', model: 'm1', content: [{ type: 'text', text: 't' }],
    signal: new AbortController().signal,
  });
  assert.equal(r.status, 'cancelled');
  assert.equal(r.text, 'part');
  assert.equal(r.receipt.error.code, 'ABORTED');
});

test('没有终态 finish：如实标记，不猜原因', async () => {
  const r = await runGeneration({
    llm: fakeLlm([{ type: 'text-delta', index: 0, text: 'x' }]),
    provider: 'p1', model: 'm1', content: [{ type: 'text', text: 't' }],
    signal: new AbortController().signal,
  });
  assert.equal(r.status, 'failed');
  assert.equal(r.receipt.error.code, 'NO_TERMINAL_FINISH');
  assert.equal(r.receipt.finishReason, null, '没有收尾信息就是 null，不伪造 stop');
});

test('中间件抛出的异常被捕获成 failed，不冒泡', async () => {
  // 需要至少两个 chunk，否则生成器在抛错前就正常结束了
  const r = await runGeneration({
    llm: fakeLlm([{ type: 'text-delta', index: 0, text: 'x' }, { type: 'text-delta', index: 0, text: 'y' }], { throwAfter: 1 }),
    provider: 'p1', model: 'm1', content: [{ type: 'text', text: 't' }],
    signal: new AbortController().signal,
  });
  assert.equal(r.status, 'failed');
  assert.equal(r.receipt.finishReason, 'thrown');
  assert.ok(r.receipt.error.message.includes('middleware exploded'));
});

test('不发送 tools / sessionId / purpose（F02：单次无工具调用）', async () => {
  let captured = null;
  const llm = fakeLlm([FINISH_STOP]);
  const origStream = llm.stream;
  llm.stream = (options) => { captured = options; return origStream(options); };
  await runGeneration({
    llm, provider: 'p1', model: 'm1', content: [{ type: 'text', text: 't' }],
    signal: new AbortController().signal,
  });
  assert.equal(captured.tools, undefined);
  assert.equal(captured.sessionId, undefined);
  assert.equal(captured.purpose, undefined);
  assert.equal(captured.provider, 'p1');
  assert.equal(captured.model, 'm1');
  assert.equal(captured.messages.length, 1);
  assert.equal(captured.messages[0].role, 'user');
  assert.equal(captured.messages[0].source.kind, 'plugin');
});

test('可选参数只在真的给了值时才写入请求', async () => {
  let captured = null;
  const llm = fakeLlm([FINISH_STOP]);
  const orig = llm.stream;
  llm.stream = (o) => { captured = o; return orig(o); };
  await runGeneration({ llm, provider: 'p1', model: 'm1', content: [{ type: 'text', text: 't' }], signal: new AbortController().signal });
  assert.equal(captured.temperature, undefined);
  assert.equal(captured.maxTokens, undefined);
  assert.equal(captured.reasoningEffort, undefined);
  assert.equal(captured.system, undefined);

  await runGeneration({
    llm, provider: 'p1', model: 'm1', content: [{ type: 'text', text: 't' }], signal: new AbortController().signal,
    system: '你是助手', temperature: 0.7, maxTokens: 1024, reasoningEffort: 'high',
  });
  assert.equal(captured.system, '你是助手');
  assert.equal(captured.temperature, 0.7);
  assert.equal(captured.maxTokens, 1024);
  assert.equal(captured.reasoningEffort, 'high');
});

test('模型目录：单只 provider 失败不影响整体', async () => {
  const cat = await listModelCatalog(fakeLlm([], {
    providers: [{ id: 'p1', name: 'P1' }, { id: 'broken', name: 'Broken' }],
    models: { p1: [{ provider: 'p1', id: 'm1', name: 'M1' }] },
  }));
  assert.equal(cat.providers.length, 2);
  assert.equal(cat.modelsByProvider.p1.length, 1);
  assert.deepEqual(cat.modelsByProvider.broken, []);
  assert.equal(cat.errors.length, 1);
  assert.equal(cat.errors[0].provider, 'broken');
  assert.equal(cat.errors[0].error.code, 'NO_ADAPTER');
});

test('解析候选配置：拿到上下文窗口与思考档位支持情况', async () => {
  const r = await resolveCandidateConfig(fakeLlm([]), { provider: 'p1', model: 'm1', reasoningEffort: 'high' });
  assert.equal(r.contextWindow, 128000);
  assert.equal(r.defaultMaxTokens, 8192);
  assert.equal(r.reasoningEffortSupported, true);
  assert.deepEqual(r.availableReasoningEfforts, ['low', 'high']);

  const bad = await resolveCandidateConfig(fakeLlm([]), { provider: 'p1', model: 'm1', reasoningEffort: 'max' });
  assert.equal(bad.reasoningEffortSupported, false);
});

test('解析失败时给出说明而不是崩掉', async () => {
  const r = await resolveCandidateConfig(fakeLlm([]), { provider: 'nope', model: 'm' });
  assert.equal(r.contextWindow, null);
  assert.ok(r.note.includes('无法解析'));
});

test('错误翻译覆盖已知码，未知码也有兜底', () => {
  assert.ok(explainError({ code: 'AUTH' }).title.includes('凭据'));
  assert.ok(explainError({ code: 'RATE_LIMIT' }).title.includes('限流'));
  assert.ok(explainError({ code: 'SERVER' }).title.includes('服务端'));
  assert.ok(explainError({ code: 'MISSING_CREDENTIAL' }).hint.includes('API key'));
  const unknown = explainError({ code: 'SOMETHING_NEW', status: 418 });
  assert.equal(unknown.code, 'SOMETHING_NEW');
  assert.equal(unknown.status, 418);
  assert.ok(unknown.title.length > 0, '未知码也要有可读标题');
  assert.ok(explainError(null).title.length > 0);
});
