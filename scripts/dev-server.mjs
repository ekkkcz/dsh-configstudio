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
import { join, dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { makeSimulatedLlm } from './simulated-llm.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const getArg = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const PORT = Number(getArg('--port', 8790));

/**
 * 产品代码从哪个根目录加载。默认是**本仓库**（开发时用）。
 *
 * `--root <目录>` 指向另一个已安装的包目录时，加载的就是**那份安装里的代码** ——
 * M4 的升级/卸载验收需要"跑 0.4.0 装出来的东西"，而不是"跑仓库里当前这份"。
 * 这两件事看起来一样，实际差很多：仓库代码永远是新的，用它验证升级等于什么都没验证。
 */
const PKG_ROOT = resolvePath(getArg('--root', join(here, '..')));

// 动态 import：只有这样才能让根目录可配置（顶层静态 import 做不到）。
// 产品代码本身**一份都没有抄到这里** —— 全部来自 PKG_ROOT 下的 src/。
const { Store } = await import(pathToFileURL(join(PKG_ROOT, 'src', 'core', 'store.js')).href);
const { createApi } = await import(pathToFileURL(join(PKG_ROOT, 'src', 'api.js')).href);
const { createPreviewServer } = await import(pathToFileURL(join(PKG_ROOT, 'src', 'preview', 'server.js')).href);
const { createUiRouter } = await import(pathToFileURL(join(PKG_ROOT, 'src', 'ui.js')).href);
const { LIVE_MAX, createRunCandidate, liveFor, recoverUnfinishedAttempts } =
  await import(pathToFileURL(join(PKG_ROOT, 'src', 'core', 'runtime.js')).href);
const { SettingsStore } = await import(pathToFileURL(join(PKG_ROOT, 'src', 'core', 'settings.js')).href);

/** 读加载的那份包的版本号，读不到就写 unknown（不编一个号）。 */
function readPkgVersion() {
  try {
    return JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8')).version || 'unknown';
  } catch { return 'unknown'; }
}

const DATA_DIR = (() => {
  const i = args.indexOf('--data');
  if (i >= 0) return args[i + 1];
  return join(PKG_ROOT, 'dev-data');
})();

const store = new Store(DATA_DIR);

// 与宿主半边**同一个函数**：把上一个进程留下的未完成尝试标成中断（A09）。
// 以前只有 src/index.js 做了这件事，于是"重启后还显示 running"这个缺陷
// 在零费用的开发服务器上复现不出来（与实时流缓冲那次同类）。
const recovered = recoverUnfinishedAttempts(store);

const preview = createPreviewServer({
  getHtml: (id) => {
    try { return store.getAttempt(id) && store.hasHtml(id) ? store.readHtml(id) : null; } catch { return null; }
  },
});
const paddr = await preview.listen();

const latencyArg = args.indexOf('--latency');
const LATENCY = latencyArg >= 0 ? Number(args[latencyArg + 1]) : 900;
// --llm-log <路径>：把每次模型调用追加一行 JSON。
// 用途是给出**跨进程**的证据：重启后 attempt 被标中断，但没有产生新的模型调用（A09 不自动重付费）。
const llmLogArg = args.indexOf('--llm-log');
const LLM_LOG = llmLogArg >= 0 ? args[llmLogArg + 1] : null;
const llm = makeSimulatedLlm({ latencyMs: LATENCY, callLog: LLM_LOG });

const runtime = {
  config: {
    defaultConcurrency: 2, defaultTimeoutMs: 120000, defaultMaxTokens: null, dataDir: DATA_DIR,
    // 版本从 package.json 读，加 -dev 后缀标明这是开发服务器（不是装进 DSH 的那份）。
    // 以前这里写死 '0.0.1-dev'，导致交付截图上的版本号与实际不符。
    pluginVersion: readPkgVersion() + '-dev',
  },
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
console.log('  模型调用日志：' + (LLM_LOG ? LLM_LOG : '未开启（--llm-log <路径> 可开启）'));
if (recovered.count > 0) {
  console.log('  · 上个进程留下的 ' + recovered.count + ' 个未完成尝试已标记为中断（不会自动重跑，也不重新计费）');
}
console.log('  进程号：    ' + process.pid);
