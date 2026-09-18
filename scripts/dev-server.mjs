/**
 * 开发服务器 —— 不装进 DSH 也能跑起完整插件，用于界面迭代与真实浏览器验证。
 *
 * 它做的事与 DSH 里的宿主半边一致：起预览服务、起 API 路由、提供一个假的 ctx.llm
 * （可用 --live 切到真实 DSH 需要真装进宿主，这里只做开发）。
 *
 * 用法：
 *   node scripts/dev-server.mjs                 # 模拟模型（默认，零费用）
 *   node scripts/dev-server.mjs --port 8790
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Store } from '../src/core/store.js';
import { createApi } from '../src/api.js';
import { createPreviewServer } from '../src/preview/server.js';
import { createUiRouter } from '../src/ui.js';
import { makeSimulatedLlm } from './simulated-llm.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const portArg = args.indexOf('--port');
const PORT = portArg >= 0 ? Number(args[portArg + 1]) : 8790;
const DATA_DIR = (() => {
  const i = args.indexOf('--data');
  if (i >= 0) return args[i + 1];
  return join(here, '..', 'dev-data');
})();

const store = new Store(DATA_DIR);

const preview = createPreviewServer({
  getHtml: (id) => {
    try { return store.getAttempt(id) && store.hasHtml(id) ? store.readHtml(id) : null; } catch { return null; }
  },
});
const paddr = await preview.listen();

const latencyArg = args.indexOf('--latency');
const LATENCY = latencyArg >= 0 ? Number(args[latencyArg + 1]) : 900;
const llm = makeSimulatedLlm({ latencyMs: LATENCY });

const runtime = {
  config: { defaultConcurrency: 2, defaultTimeoutMs: 120000, defaultMaxTokens: null, pluginVersion: '0.0.1-dev', dataDir: DATA_DIR },
  store, ctx: { get: () => llm }, runs: new Map(), previewOrigin: paddr.origin,
  // api.js 通过 runtime.llmOf() 取模型服务（宿主半边在 src/index.js 里也是这么给的）。
  // 这里以前漏了，导致开发服务器的 /models 与 /models/resolve 直接 500 —— M1 实测暴露。
  llmOf: () => llm,
  async probeBrowser() {
    const { loadPlaywright } = await import('../src/preview/browser.js');
    const pw = await loadPlaywright();
    return pw.ok ? { available: true, candidates: pw.candidates.length } : { available: false, reason: pw.reason };
  },
  async runCandidate(job) {
    const { attemptId, compiled } = job;
    const controller = new AbortController();
    this.runs.set(attemptId, { controller, startedAt: Date.now() });
    const { runGeneration } = await import('../src/core/runner.js');
    const { extractHtml, EXTRACTOR_VERSION } = await import('../src/core/extract.js');
    try {
      this.store.updateAttemptStatus(attemptId, 'running');
      this.store.stampReceipt(attemptId, 'started_at', Date.now());
      const result = await runGeneration({
        llm: this.ctx.get(), provider: compiled.provider, model: compiled.model,
        system: compiled.system, content: [{ type: 'text', text: compiled.userText }],
        temperature: compiled.temperature, maxTokens: compiled.maxTokens,
        reasoningEffort: compiled.reasoningEffort, signal: controller.signal,
        onEvent: (e) => {
          if (e.type === 'first-event') this.store.stampReceipt(attemptId, 'first_event_at', e.at);
          if (e.type === 'first-text') this.store.stampReceipt(attemptId, 'first_text_at', e.at);
        },
      });
      const raw = await this.store.writeRaw(attemptId, result.text ?? '');
      // F06：推理信息与原始正文分开保存（只存服务实际返回的内容）
      if (result.reasoning && result.reasoning.length > 0) {
        await this.store.writeReasoning(attemptId, result.reasoning);
      }
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
      // 与宿主实现一致：只在「完成但无正文」时给出推理吃光预算的诊断
      let errorCode = result.receipt.error?.code ?? null;
      let errorMessage = result.receipt.error?.message ?? null;
      if (result.status === 'completed' && (result.text ?? '').length === 0 && (result.reasoning ?? '').length > 0) {
        errorCode = 'EMPTY_RESPONSE';
        errorMessage = '模型把输出预算都用在了推理上，没有产生正文（推理 ' + result.reasoning.length + ' 字符）。'
          + '提高该候选的输出上限，或换一个不输出推理的模型。';
      }
      this.store.finishReceipt(attemptId, {
        finishReason: result.receipt.finishReason, errorCode,
        errorMessage, errorStatus: result.receipt.error?.status ?? null,
        usage: result.receipt.usage, observedRequests: result.receipt.observedRequests,
      });
      return { status: result.status };
    } finally { this.runs.delete(attemptId); }
  },
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
};

const api = createApi(runtime);
const ui = await createUiRouter(runtime);

const server = createServer((req, res) => {
  // 先给 SPA 静态资源与页面，再落到 API
  if (ui.handle(req, res)) return;
  api.handle(req, res);
});

await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
console.log('HTML Arena 开发服务器');
console.log('  界面：      http://127.0.0.1:' + PORT + '/html-arena/api/ui');
console.log('  API：       http://127.0.0.1:' + PORT + '/html-arena/api');
console.log('  预览源：    ' + paddr.origin + '  (独立 origin，作品不在这里的端口执行)');
console.log('  数据目录：  ' + DATA_DIR);
console.log('  模型：      模拟（零费用，字符串标记为模拟结果）');
