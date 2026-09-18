/**
 * 测试用的最小宿主：真实 http 服务器 + 真实 store + **真实的 core/runtime.js 执行管线**。
 *
 * 为什么不照抄一份 runCandidate：M2 已经踩过这个坑 —— api.e2e.test.js 里手抄的那份
 * 一旦与 src/core/runtime.js 漂移，"超时/中断"这类行为就会在测试里通过、在真实插件里失效。
 * 这里只造假 llm，其余全部走生产实现。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { Store } from '../../src/core/store.js';
import { createApi } from '../../src/api.js';
import { createPreviewServer } from '../../src/preview/server.js';
import { createRunCandidate, liveFor } from '../../src/core/runtime.js';
import { SettingsStore } from '../../src/core/settings.js';

const NL = String.fromCharCode(10);
const FENCE = String.fromCharCode(96).repeat(3);

/** 把一段 HTML 包成"模型会返回的样子"。 */
export function asModelOutput(html, note = '这是测试用的说明文字。') {
  return note + NL + NL + FENCE + 'html' + NL + html + NL + FENCE + NL;
}

/**
 * 假 llm。streams 是 provider id -> 行为：
 *  - {text, chunkDelayMs}                       正常吐完
 *  - {text, chunkDelayMs, honorAbort: true}     收到 abort 后尽快收尾（真实适配器行为）
 *  - {text, chunkDelayMs, honorAbort: false}    忽略 abort，继续吐（用于验证迟到输出不污染）
 *  - {error: {code, message, status}}           直接以 provider 错误收尾
 */
export function fakeLlm(streams) {
  const ids = Object.keys(streams);
  /** 每一次 stream() 调用都记一笔 —— "没有自动重付费"就是靠这个数出来的。 */
  const calls = [];
  return {
    calls,
    listProviders: () => ids.map((id) => ({ id, name: 'provider ' + id })),
    async listModels(provider) { return [{ provider, id: provider + '-m1', name: provider + ' M1' }]; },
    async resolveModelInfo(provider, model) {
      return {
        provider, id: model, name: model,
        context: { contextWindow: 128000 }, defaultMaxTokens: 8192,
        reasoning: { efforts: [{ id: 'low' }, { id: 'high' }] }, inputModalities: ['text'],
      };
    },
    stream(options) {
      calls.push({ at: Date.now(), provider: options.provider, model: options.model });
      const b = streams[options.provider] ?? { text: asModelOutput('<html><body>default</body></html>') };
      const signal = options.signal;
      const aborted = () => Boolean(signal && signal.aborted);
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      return (async function* () {
        if (b.error) {
          yield { type: 'finish', reason: { kind: 'error', failure: { ...b.error } } };
          return;
        }
        const text = b.text ?? '';
        const chunk = b.chunkSize ?? 48;
        const delay = b.chunkDelayMs ?? 0;
        for (let i = 0; i < text.length; i += chunk) {
          if (b.honorAbort !== false && aborted()) {
            yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: '测试：收到中止信号' } } };
            return;
          }
          yield { type: 'text-delta', index: 0, text: text.slice(i, i + chunk) };
          if (delay > 0) await sleep(delay);
        }
        yield { type: 'usage', usage: { inputTokens: 11, outputTokens: 22, totalTokens: 33 } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      })();
    },
  };
}

/** 起一个测试宿主，返回真实 API 的 base 地址。 */
export async function startHarness({ streams, dataDir = null, defaultTimeoutMs = 60000 } = {}) {
  const dir = dataDir ?? mkdtempSync(join(tmpdir(), 'arena-harness-'));
  const store = new Store(dir);
  const preview = createPreviewServer({
    getHtml: (id) => {
      try { return store.getAttempt(id) && store.hasHtml(id) ? store.readHtml(id) : null; } catch { return null; }
    },
  });
  const paddr = await preview.listen();
  const llm = fakeLlm(streams);
  const runtime = {
    config: { defaultConcurrency: 2, defaultTimeoutMs, defaultMaxTokens: null, pluginVersion: 'test', dataDir: dir },
    store, llmOf: () => llm, runs: new Map(), live: new Map(),
    previewOrigin: paddr.origin, settings: new SettingsStore(dir),
    async probeBrowser() { return { available: false, reason: '测试环境不启动浏览器' }; },
    cancelCandidate(id) {
      const r = this.runs.get(id);
      if (!r) return { ok: false, reason: '这个候选当前没有在运行' };
      r.controller.abort();
      return { ok: true };
    },
    cancelAll(expId) {
      let n = 0;
      for (const a of this.store.listAttempts(expId)) if (this.runs.has(a.id)) { this.runs.get(a.id).controller.abort(); n += 1; }
      return { cancelled: n };
    },
    liveFor(expId) { return liveFor(this.store, this.live, this.runs, expId); },
  };
  // 生产实现，不是抄一份
  runtime.runCandidate = createRunCandidate({ store, llmOf: () => llm, runs: runtime.runs, live: runtime.live });

  const api = createApi(runtime);
  const server = createServer((req, res) => api.handle(req, res));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return {
    base: 'http://127.0.0.1:' + port + '/html-arena/api',
    previewOrigin: paddr.origin,
    dataDir: dir,
    store, runtime, llm,
    async close() {
      await new Promise((r) => server.close(r));
      await preview.close();
      store.close();
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* 清理失败不影响断言 */ }
    },
    /** 重开同一个数据目录（模拟宿主重启），旧句柄先关掉。 */
    async reopen() {
      store.close();
      const s2 = new Store(dir);
      return { store: s2 };
    },
  };
}

/** 发一个请求，返回 {status, body}。 */
export async function call(base, path, options) {
  const r = await fetch(base + path, options);
  const text = await r.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body };
}

export function postJson(base, path, payload) {
  return call(base, path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload ?? {}),
  });
}

/** 建一个实验（可选覆盖输出规则）。 */
export async function newExperiment(base, { title = '测试实验', prompt = '做一个测试页面', outputPolicy } = {}) {
  const r = await postJson(base, '/experiments', { title, prompt, outputPolicy });
  if (r.status !== 201) throw new Error('创建实验失败：' + JSON.stringify(r.body));
  return r.body.experiment;
}

/** 等某个实验没有在跑的候选（或超时）。 */
export async function waitIdle(base, expId, timeoutMs = 20000) {
  const t0 = Date.now();
  for (;;) {
    const r = await call(base, '/experiments/' + encodeURIComponent(expId));
    if (r.status !== 200) throw new Error('读取实验失败：' + JSON.stringify(r.body));
    const running = r.body.attempts.filter((a) => a.running || a.status === 'queued' || a.status === 'running');
    if (running.length === 0) return r.body;
    if (Date.now() - t0 > timeoutMs) throw new Error('等待超时，仍有 ' + running.length + ' 个在跑');
    await new Promise((r2) => setTimeout(r2, 60));
  }
}
