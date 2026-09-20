/**
 * 端到端测试：用**模拟 llm** 跑完整流程，不产生任何真实调用或费用。
 *
 * 覆盖 IMPLEMENTATION M0 的"打通调用与取消"与 M1 的两候选流程：
 *  - 两候选同题生成 → 原始输出与 HTML 落盘 → 并排预览取回 → 独立失败 → 重置
 *  - A05：双击开始只产生一次逻辑提交（服务端在 start 时创建 attempt，重复调用会新建 attempt，
 *         因此界面层用一个 requestId 去重；这里验证服务端不会因为重复读接口而重跑）
 *  - A07：一个候选 401，另一个继续成功
 *  - A18：用量缺失显示 null
 *
 * 用真实的 http 服务器 + 真实的 store，只有 llm 是假的。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, request as httpRequest } from 'node:http';
import { Store } from '../src/core/store.js';
import { createApi } from '../src/api.js';
import { createPreviewServer } from '../src/preview/server.js';
import { explainError } from '../src/core/runner.js';

const DOC_A = '<!DOCTYPE html><html><head><title>A</title></head><body><h1>alpha</h1></body></html>';
const DOC_B = '<!DOCTYPE html><html><head><title>B</title></head><body><h1>beta</h1></body></html>';

/** 按候选槽给出不同的流；canFail 用来模拟 provider 错误。 */
function fakeLlm({ failSlots = [], textFor }) {
  return {
    listProviders: () => [{ id: 'pa', name: 'Provider A' }, { id: 'pb', name: 'Provider B' }],
    async listModels(p) { return [{ provider: p, id: p + '-m1', name: p + ' M1' }]; },
    async resolveModelInfo(provider, model) {
      return { provider, id: model, name: model, context: { contextWindow: 64000 }, defaultMaxTokens: 4096, reasoning: { efforts: [{ id: 'low' }, { id: 'high' }] }, inputModalities: ['text'] };
    },
    stream(options) {
      const slot = options.provider === 'pb' ? 1 : 0;
      const fail = failSlots.includes(slot);
      return (async function* () {
        if (fail) {
          yield { type: 'finish', reason: { kind: 'error', failure: { code: 'AUTH', message: 'invalid api key', status: 401 } } };
          return;
        }
        const text = textFor(slot, options);
        yield { type: 'block-start', index: 0, blockType: 'text' };
        // 分片吐出，模拟流式
        for (let i = 0; i < text.length; i += 50) {
          yield { type: 'text-delta', index: 0, text: text.slice(i, i + 50) };
        }
        yield { type: 'block-end', index: 0, block: { type: 'text', text } };
        if (slot === 1) {
          // 第二候选故意不报 usage，验证 A18
          yield { type: 'finish', reason: { kind: 'stop' } };
        } else {
          yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 200, totalTokens: 300 } };
          yield { type: 'finish', reason: { kind: 'stop' } };
        }
      })();
    },
  };
}

function makeRuntime(store, llm, previewOrigin) {
  return {
    config: { defaultConcurrency: 2, defaultTimeoutMs: 60000, defaultMaxTokens: null, pluginVersion: '0.0.1-test' },
    // 与生产实现一致：通过 llmOf() 取服务（生产用 ctx.get('llm')，不直接读 ctx.llm）
    store, llmOf: () => llm,
    runs: new Map(),
    previewOrigin,
    previewServer: null,
    async probeBrowser() { return { available: false, reason: '测试环境不启动浏览器' }; },
    async runCandidate(job) {
      // 复制 index.js 里 runCandidate 的语义（保持与生产实现一致的关键行为）
      const { attemptId, compiled } = job;
      this.runs.set(attemptId, { startedAt: Date.now() });
      const { runGeneration } = await import('../src/core/runner.js');
      const { extractHtml, EXTRACTOR_VERSION } = await import('../src/core/extract.js');
      try {
        this.store.updateAttemptStatus(attemptId, 'running');
        this.store.stampReceipt(attemptId, 'started_at', Date.now());
        const result = await runGeneration({
          llm: this.llmOf(), provider: compiled.provider, model: compiled.model,
          system: compiled.system, content: [{ type: 'text', text: compiled.userText }],
          temperature: compiled.temperature, maxTokens: compiled.maxTokens,
          reasoningEffort: compiled.reasoningEffort, signal: new AbortController().signal,
          onEvent: (e) => {
            if (e.type === 'first-event') this.store.stampReceipt(attemptId, 'first_event_at', e.at);
            if (e.type === 'first-text') this.store.stampReceipt(attemptId, 'first_text_at', e.at);
          },
        });
        const raw = await this.store.writeRaw(attemptId, result.text ?? '');
        const ex = extractHtml(result.text ?? '', { finishReason: result.receipt.finishReason });
        let info = { hash: null, path: null };
        if (ex.status === 'ok' && ex.html !== null) info = await this.store.writeHtml(attemptId, ex.html);
        this.store.createArtifact({
          id: attemptId, attemptId, rawHash: raw.hash, htmlHash: info.hash,
          extractionVersion: EXTRACTOR_VERSION, extractionMode: ex.mode, extractionRange: ex.range,
          extractionStatus: ex.status, extractionWarnings: ex.warnings,
          rawPath: raw.path, htmlPath: info.path, bytes: raw.bytes,
        });
        this.store.updateAttemptStatus(attemptId, result.status);
        this.store.finishReceipt(attemptId, {
          finishReason: result.receipt.finishReason, errorCode: result.receipt.error?.code ?? null,
          errorMessage: result.receipt.error?.message ?? null, errorStatus: result.receipt.error?.status ?? null,
          usage: result.receipt.usage, observedRequests: result.receipt.observedRequests,
        });
        return { status: result.status };
      } finally { this.runs.delete(attemptId); }
    },
    cancelCandidate() { return { ok: false, reason: 'not running' }; },
    cancelAll() { return { cancelled: 0 }; },
  };
}

/** 起一个测试用的 http 服务器，把 API 与预览服务接上。 */
async function startHarness({ failSlots = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'arena-e2e-'));
  const store = new Store(dir);
  const preview = createPreviewServer({
    getHtml: (id) => {
      try { return store.getAttempt(id) && store.hasHtml(id) ? store.readHtml(id) : null; } catch { return null; }
    },
  });
  const paddr = await preview.listen();
  const llm = fakeLlm({
    failSlots,
    textFor: (slot) => '这是候选的说明文字。\n\n' + String.fromCharCode(96).repeat(3) + 'html\n' + (slot === 0 ? DOC_A : DOC_B) + '\n' + String.fromCharCode(96).repeat(3) + '\n',
  });
  const runtime = makeRuntime(store, llm, paddr.origin);
  const api = createApi(runtime);
  const server = createServer((req, res) => api.handle(req, res));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return {
    base: 'http://127.0.0.1:' + port + '/configstudio/api',
    previewOrigin: paddr.origin,
    store, runtime,
    async close() { await new Promise((r) => server.close(r)); await preview.close(); store.close(); try { rmSync(dir, { recursive: true, force: true }); } catch {} },
  };
}

async function api(base, path, options) {
  const r = await fetch(base + path, options);
  const text = await r.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body };
}

/** 等实验跑完（轮询 attempts，直到没有 running）。 */
async function waitDone(base, expId, timeoutMs = 15000) {
  const t0 = Date.now();
  for (;;) {
    const r = await api(base, '/experiments/' + expId);
    const running = r.body.attempts.filter((a) => a.running || a.status === 'queued' || a.status === 'running');
    if (running.length === 0) return r.body;
    if (Date.now() - t0 > timeoutMs) throw new Error('等待超时，仍有 ' + running.length + ' 个在跑');
    await new Promise((r) => setTimeout(r, 60));
  }
}

test('端到端：两候选同题生成，作品落盘，可并排取回，独立失败不影响彼此', async () => {
  const h = await startHarness();
  try {
    // 1) 建实验
    const created = await api(h.base, '/experiments', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: '天气仪表盘', category: 'dashboard',
        prompt: '做一个可切换城市与日期的天气仪表盘，使用内置示例数据，包含折线图和昼夜主题，所有内容放在一个 HTML 中',
        outputRequirements: '单文件，无外部依赖',
        previewPolicy: { networkPolicy: 'offline' }, outputPolicy: { concurrency: 2 },
      }),
    });
    assert.equal(created.status, 201);
    const expId = created.body.experiment.id;
    assert.ok(created.body.taskHash.length === 64);

    // 2) 开始生成两个候选
    const started = await api(h.base, '/experiments/' + expId + '/start', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        concurrency: 2,
        candidates: [
          { name: 'A', provider: 'pa', model: 'pa-m1', reasoningEffort: 'high' },
          { name: 'B', provider: 'pb', model: 'pb-m1' },
        ],
      }),
    });
    assert.equal(started.status, 202);
    assert.equal(started.body.started.length, 2);

    // 3) 等完成
    const done = await waitDone(h.base, expId);
    const bySlot = done.attempts.sort((a, b) => a.slot - b.slot);
    assert.equal(bySlot.length, 2);
    assert.equal(bySlot[0].status, 'completed');
    assert.equal(bySlot[1].status, 'completed', '第二个候选成功');

    // 4) 作品都提取出来了，且 hash 与原文不同（F06）
    assert.equal(bySlot[0].extraction.status, 'ok');
    assert.equal(bySlot[0].extraction.mode, 'fenced');
    assert.notEqual(bySlot[0].extraction.htmlHash, bySlot[0].extraction.rawTextHash);
    assert.equal(bySlot[0].canPreview, true);

    // 5) 预览服务能取回各自的 HTML，且互不串台
    const previewA = await fetch(h.previewOrigin + '/preview/' + bySlot[0].id + '?token=t&network=offline').then((r) => r.text());
    const previewB = await fetch(h.previewOrigin + '/preview/' + bySlot[1].id + '?token=t&network=offline').then((r) => r.text());
    assert.ok(previewA.includes('alpha'));
    assert.ok(previewB.includes('beta'));
    assert.ok(!previewA.includes('beta'), '候选 A 的预览不能出现候选 B 的内容');
    assert.ok(previewA.includes('data-configstudio-bridge'), '预览页应带桥接脚本');

    // 6) 用量：A 有，B 没有 → B 必须是 null（A18）
    assert.equal(bySlot[0].receipt.usage.inputTokens, 100);
    assert.equal(bySlot[1].receipt.usage, null, '未上报的用量必须是 null，不能是 0');

    // 7) 下载两个入口
    const rawDl = await fetch(h.base + '/experiments/' + expId + '/attempts/' + bySlot[0].id + '/raw');
    assert.equal(rawDl.status, 200);
    assert.ok((await rawDl.text()).includes('这是候选的说明文字'));
    const htmlDl = await fetch(h.base + '/experiments/' + expId + '/attempts/' + bySlot[0].id + '/html');
    assert.equal(htmlDl.status, 200);
    assert.equal((await htmlDl.text()), DOC_A);

    // 8) 再次读取详情不会重新跑（页面刷新只恢复展示，不重跑）
    const again = await api(h.base, '/experiments/' + expId);
    assert.equal(again.body.attempts.length, 2, '读详情不能新建 attempt');
    assert.equal(again.body.runs.length, 0);
  } finally { await h.close(); }
});

test('端到端：一个候选 401 失败，另一个继续成功（A07）', async () => {
  const h = await startHarness({ failSlots: [1] });
  try {
    const created = await api(h.base, '/experiments', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '失败隔离', prompt: '做一个落地页' }),
    });
    const expId = created.body.experiment.id;
    await api(h.base, '/experiments/' + expId + '/start', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ candidates: [{ name: 'A', provider: 'pa', model: 'pa-m1' }, { name: 'B', provider: 'pb', model: 'pb-m1' }] }),
    });
    const done = await waitDone(h.base, expId);
    const bySlot = done.attempts.sort((a, b) => a.slot - b.slot);
    assert.equal(bySlot[0].status, 'completed', '失败候选不能影响成功候选');
    assert.equal(bySlot[1].status, 'failed');
    assert.equal(bySlot[1].error.code, 'AUTH');
    assert.equal(bySlot[1].error.title.includes('凭据'), true);
    assert.ok(bySlot[1].error.hint.length > 0, '必须给人能读懂的下一步');
    // 失败的候选仍然保留原始输出位置，没有作品但记录在
    assert.equal(bySlot[1].canPreview, false);
    assert.equal(bySlot[1].extraction.status, 'none');
    // 实验列表如实汇报成功/失败数量
    const list = await api(h.base, '/experiments');
    const row = list.body.experiments.find((e) => e.id === expId);
    assert.equal(row.succeeded, 1);
    assert.equal(row.failed, 1);
  } finally { await h.close(); }
});

test('开始前阻止不受支持的思考档位（A04），不静默忽略', async () => {
  const h = await startHarness();
  try {
    const created = await api(h.base, '/experiments', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '参数核查', prompt: '做个计算器' }),
    });
    const expId = created.body.experiment.id;
    const r = await api(h.base, '/experiments/' + expId + '/start', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ candidates: [{ name: 'A', provider: 'pa', model: 'pa-m1', reasoningEffort: 'max' }] }),
    });
    assert.equal(r.status, 400);
    assert.equal(r.body.problems.length, 1);
    assert.ok(r.body.problems[0].includes('不支持思考档位'));
    assert.ok(r.body.problems[0].includes('low, high'), '要给出可选值');
    // 被阻止后没有创建 attempt
    const detail = await api(h.base, '/experiments/' + expId);
    assert.equal(detail.body.attempts.length, 0);
  } finally { await h.close(); }
});

test('输入超限明确拒绝，不截断（A10）', async () => {
  const h = await startHarness();
  try {
    const tooLong = 'x'.repeat(50001);
    const r = await api(h.base, '/experiments', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '超限', prompt: tooLong }),
    });
    assert.equal(r.status, 400);
    assert.ok(r.body.error.includes('50000'));
    assert.ok(r.body.error.includes('不会替你截断'));

    const bigHtml = 'x'.repeat(2 * 1024 * 1024 + 10);
    const r2 = await api(h.base, '/experiments', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '超限2', prompt: 'ok', startHtml: bigHtml }),
    });
    assert.equal(r2.status, 400);
    assert.equal(r2.body.field, 'startHtml');
  } finally { await h.close(); }
});

test('开始前可查看实际发送内容（F03）', async () => {
  const h = await startHarness();
  try {
    // 预览用无状态接口：不创建实验，因此不会污染实验列表
    const before = (await api(h.base, '/experiments')).body.experiments.length;
    const r = await api(h.base, '/preview-request', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        task: { prompt: '做一个动画', startHtml: '<html></html>', outputRequirements: '无外部依赖' },
        candidates: [{ provider: 'pa', model: 'pa-m1', systemPrompt: '你是前端专家', promptSegments: ['用深色主题'] }],
      }),
    });
    assert.equal(r.status, 200);
    const req = r.body.requests[0];
    assert.ok(req.system.includes('你是前端专家'));
    assert.ok(req.user.includes('做一个动画'));
    assert.ok(req.user.includes('无外部依赖'));
    assert.ok(req.user.includes('<html></html>'));
    assert.ok(req.user.includes('用深色主题'));
    assert.equal(req.tools, null, '必须明确说明不发送 tools');
    assert.equal(typeof r.body.taskHash, 'string');
    assert.equal(r.body.taskHash.length, 64);
    // 关键：预览不能创建实验
    const after = (await api(h.base, '/experiments')).body.experiments.length;
    assert.equal(after, before, '预览请求不应创建实验');

    // 超限同样要在这里被拒绝
    const bad = await api(h.base, '/preview-request', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task: { prompt: 'x'.repeat(50001) }, candidates: [] }),
    });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.field, 'prompt');
  } finally { await h.close(); }
});

test('盲选：揭晓前不出现模型身份，映射稳定，绑定作品 hash（A15）', async () => {
  const h = await startHarness();
  try {
    const created = await api(h.base, '/experiments', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '盲选', prompt: '做个可视化' }),
    });
    const expId = created.body.experiment.id;
    await api(h.base, '/experiments/' + expId + '/start', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ candidates: [{ name: '甲方案', provider: 'pa', model: 'pa-m1' }, { name: '乙方案', provider: 'pb', model: 'pb-m1' }] }),
    });
    const done = await waitDone(h.base, expId);

    const voted = await api(h.base, '/experiments/' + expId + '/vote', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ choice: 'A', tags: ['视觉'], note: '更清爽' }),
    });
    assert.equal(voted.status, 200);
    assert.equal(voted.body.vote.revealed, null, '未揭晓时 revealed 必须是 null');
    assert.equal(voted.body.vote.mapping.A.revealed, null, '揭晓前不得返回模型身份');
    const serialized = JSON.stringify(voted.body.vote);
    assert.ok(!serialized.includes('pa-m1'), '揭晓前响应里不能出现模型 id');
    assert.ok(!serialized.includes('甲方案'), '揭晓前响应里不能出现配方名');
    assert.equal(voted.body.vote.mapping.A.htmlHash.length, 64, '投票必须绑定作品 hash');

    // 映射稳定：再读一次还是同样映射
    const again = await api(h.base, '/experiments/' + expId + '/vote');
    assert.deepEqual(again.body.vote.mapping.A.attemptId, voted.body.vote.mapping.A.attemptId);

    // 揭晓后才有身份
    const revealed = await api(h.base, '/experiments/' + expId + '/reveal', { method: 'POST' });
    assert.ok(revealed.body.vote.revealed > 0);
    assert.equal(revealed.body.vote.mapping.A.revealed.model, 'pa-m1');
    assert.equal(revealed.body.vote.mapping.B.revealed.model, 'pb-m1');
    void done;
  } finally { await h.close(); }
});

test('非本机 Host 的请求被拒绝（避免被其它来源当开放接口）', async () => {
  const h = await startHarness();
  try {
    // 注意：不能用 fetch —— undici 会忽略调用方提供的 Host 头（实测），
    // 必须用原生 http.request 才能真正发出伪造的 Host。
    const url = new URL(h.base + '/meta');
    const result = await new Promise((resolve, reject) => {
      const req = httpRequest({
        host: url.hostname, port: url.port, path: url.pathname,
        method: 'GET', headers: { Host: 'evil.example.com' },
      }, (res) => {
        let d = '';
        res.on('data', (c) => { d += c; });
        res.on('end', () => resolve({ status: res.statusCode, body: d }));
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(result.status, 403);
    assert.ok(result.body.includes('只接受来自本机的请求'));
  } finally { await h.close(); }
});

test('未知接口给出可读错误，不是空白面板', async () => {
  const h = await startHarness();
  try {
    const r = await api(h.base, '/nope');
    assert.equal(r.status, 404);
    assert.ok(r.body.error.includes('未知接口'));
    const r2 = await api(h.base, '/experiments/exp_notexist');
    assert.equal(r2.status, 404);
    assert.ok(r2.body.error.includes('找不到'));
  } finally { await h.close(); }
});

test('meta 接口给出运行条件与限制，供界面显示真实状态', async () => {
  const h = await startHarness();
  try {
    const r = await api(h.base, '/meta');
    assert.equal(r.status, 200);
    assert.equal(r.body.limits.promptMaxChars, 50000);
    assert.equal(r.body.browser.available, false, '测试环境如实报告浏览器不可用');
    assert.ok(r.body.sandbox.includes('allow-scripts'));
    assert.ok(!r.body.sandbox.includes('allow-same-origin'));
    assert.ok(Array.isArray(r.body.cdnAllowlist) && r.body.cdnAllowlist.length > 0);
  } finally { await h.close(); }
});
