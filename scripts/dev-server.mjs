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
import { LIVE_MAX, createRunCandidate, liveFor } from '../src/core/runtime.js';
import { SettingsStore } from '../src/core/settings.js';

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
  store, ctx: { get: () => llm }, runs: new Map(), live: new Map(), previewOrigin: paddr.origin,
  settings: new SettingsStore(store.dataDir),
  // api.js 通过 runtime.llmOf() 取模型服务（宿主半边在 src/index.js 里也是这么给的）。
  // 这里以前漏了，导致开发服务器的 /models 与 /models/resolve 直接 500 —— M1 实测暴露。
  llmOf: () => llm,
  async probeBrowser() {
    const { loadPlaywright } = await import('../src/preview/browser.js');
    const pw = await loadPlaywright();
    return pw.ok ? { available: true, candidates: pw.candidates.length } : { available: false, reason: pw.reason };
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
  // 实时流快照：与宿主半边同一份实现（core/runtime.js）。
  // 以前开发服务器没有这个，于是"推理过程被轮询收回"只能在真实 DSH 上复现（M2 踩坑）。
  liveFor(expId) { return liveFor(this.store, this.live, this.runs, expId); },
};

// 跑一个候选：**与宿主半边共用同一份实现**，不再手抄。
runtime.runCandidate = createRunCandidate({
  store: runtime.store,
  llmOf: () => llm,
  runs: runtime.runs,
  live: runtime.live,
});

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
console.log('  实时流：    已开启（尾部 ' + Math.round(LIVE_MAX / 1024) + 'KB/候选，与宿主半边同一实现）');
