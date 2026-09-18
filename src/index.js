/**
 * HTML Arena —— DSH 外部 bundle 插件的宿主半边。
 *
 * 集成方式（依据 DSH 0.1.6-alpha.2 源码核查，详见 docs/dsh-integration.md）：
 *  - 本包同时声明 dsh.bundle（宿主半边）与 dsh.client（浏览器半边）。
 *  - 宿主半边 inject 里同时要求 webServer 与 llm：
 *      · webServer 提供同端口路由 /html-arena/api/*，浏览器半边用它拿数据。
 *      · llm 提供模型目录与流式调用（F01/F02）。
 *  - 浏览器半边（src/client.js）通过 window.__ModuleLoader__ 加载，
 *    在 'main' 插槽注册整页。只 require('react')（在平台白名单里，绝对安全）。
 *
 * 设计取舍：把重交互放进我们自己路由吐的静态页面里，DSH 侧只保留
 * "一个整页 + 一套 HTTP API"，这样把对 DSH 内部契约的依赖压到最小。
 *
 * @module html-arena
 */
import { Store, newId, newToken, SCHEMA_VERSION } from './core/store.js';
import { extractHtml, extractHtmlFromCandidate, sha256Hex, EXTRACTOR_VERSION } from './core/extract.js';
import { runGeneration, explainError, listModelCatalog, resolveCandidateConfig } from './core/runner.js';
import { LIVE_MAX, createRunCandidate, pruneLive, liveFor as liveForAttempts, recoverUnfinishedAttempts } from './core/runtime.js';
import { createPreviewServer } from './preview/server.js';
import { capturePreviewInSubprocess, loadPlaywright } from './preview/browser.js';
import { CDN_ALLOWLIST, NETWORK_POLICIES, VIEWPORTS, sandboxAttribute } from './preview/policy.js';
import { createApi } from './api.js';
import { SettingsStore } from './core/settings.js';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = '@dsh-external/html-arena';

/** 需要宿主提供的服务。llm 缺失时插件仍加载，只是不能生成。 */
export const inject = ['webServer'];

/**
 * 取 llm 服务。
 *
 * 必须用 ctx.get('llm') 而不是 ctx.llm：Cordis 只允许访问已声明的注入，
 * 直接读 ctx.llm 会抛 "cannot get property without inject"（实测：在真实 DSH 里
 * /models 返回 500）。而且 llm 是可选能力——某些 profile 不装模型插件，
 * 那种组合下插件仍应能加载，只是不能生成。
 */
function llmOf(ctx) {
  try { return ctx.get('llm') ?? null; } catch { return null; }
}

/**
 * 读本包 package.json 里的版本号。
 * 失败返回 null（界面显示"版本未知"），不猜、不写死。
 */
function readOwnVersion() {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : null;
  } catch { return null; }
}

/** API 路由前缀。 */
export const API_PREFIX = '/html-arena';

/** 输入上限（F05）：V1 为文本与可选单个 HTML 文件。 */
export const LIMITS = Object.freeze({
  promptMaxChars: 50000,
  startHtmlMaxBytes: 2 * 1024 * 1024,
});

export const DEFAULT_CONFIG = Object.freeze({
  dataDir: null,           // null = 由 DSH 的 home 推导
  defaultConcurrency: 2,
  defaultTimeoutMs: 180000,
  defaultMaxTokens: null,
  defaultNetworkPolicy: 'offline',
});

/**
 * 插件的 runtime 状态：一个 SQLite 存储 + 一个预览服务 + 若干进行中的生成。
 * 拆成类是为了让 dispose 能真正收干净（F14 / A01 卸载不留监听与进程）。
 */
export class HtmlArenaRuntime {
  constructor(ctx, config = {}) {
    this.ctx = ctx;
    this.llmOf = () => llmOf(ctx);
    this.config = { ...DEFAULT_CONFIG, ...config };
    // 版本号取自 package.json，不在源码里再维护一份（避免两处不一致）。
    // 读不到就保持 null，界面显示"版本未知"——不编一个号出来。
    if (!this.config.pluginVersion) this.config.pluginVersion = readOwnVersion();
    this.store = new Store(this.resolveDataDir());
    // 用户设置（目前只有"外部插件能力开关"）：跟随数据目录，换浏览器行为一致（反馈 1）。
    this.settings = new SettingsStore(this.store.dataDir);
    this.runs = new Map();          // attemptId -> { controller, startedAt }
    // 实时流缓冲：attemptId -> { text, reasoning, truncated, updatedAt, startedAt, done }
    // 只用于界面观察，**不是**权威数据：权威内容以落盘的原始正文为准。
    this.live = new Map();
    // 共享的"跑一个候选"实现（core/runtime.js）：宿主半边与开发服务器用同一份代码。
    this._runCandidate = createRunCandidate({
      store: this.store,
      llmOf: () => llmOf(ctx),
      runs: this.runs,
      live: this.live,
    });
    this.previewServer = null;
    this.previewOrigin = null;
    this.api = null;
    this.disposers = [];
    this.browserStatus = null;
  }

  /** 数据目录：优先配置，其次 DSH home，最后退回当前工作目录下的 .html-arena。 */
  resolveDataDir() {
    if (this.config.dataDir) return this.config.dataDir;
    const home = process.env.DSH_HOME
      || (process.env.USERPROFILE ? process.env.USERPROFILE + '\\.dsh' : null)
      || (process.env.HOME ? process.env.HOME + '/.dsh' : null);
    const base = home ? home : process.cwd();
    return base + (process.platform === 'win32' ? '\\' : '/') + 'html-arena';
  }

  async start() {
    // 1) 预览服务：独立端口 = 独立源（F12）
    const preview = createPreviewServer({
      getHtml: (attemptId) => {
        try {
          if (!this.store.getAttempt(attemptId)) return null;
          return this.store.hasHtml(attemptId) ? this.store.readHtml(attemptId) : null;
        } catch {
          return null;
        }
      },
    });
    const addr = await preview.listen();
    this.previewServer = preview;
    this.previewOrigin = addr.origin;

    // 2) API 路由：注册在 DSH 自己的 webServer 上（同端口，无 CORS 问题）
    this.api = createApi(this);
    const disposeRoute = this.ctx.webServer.register({
      kind: 'prefix',
      path: API_PREFIX,
      handler: (req, res) => this.api.handle(req, res),
    });
    this.disposers.push(disposeRoute);
  }

  /** 顺手探测浏览器能力，供界面显示"未检查"还是"可用"。 */
  async probeBrowser() {
    if (this.browserStatus) return this.browserStatus;
    const pw = await loadPlaywright();
    this.browserStatus = pw.ok
      ? { available: true, candidates: pw.candidates.length }
      : { available: false, reason: pw.reason };
    return this.browserStatus;
  }

  /**
   * 启动一轮生成。并发由 api 层排队控制，这里只负责跑单个候选。
   * @param {{experimentId: string, attemptId: string, recipe: object, compiled: object}} job
   */
  async runCandidate(job) { return this._runCandidate(job); }

  // 真正干活的是 core/runtime.js 里的共享实现 —— scripts/dev-server.mjs 用的是同一份。
  // 以前两边各抄一份，宿主半边有实时流缓冲、开发服务器没有，于是
  // "运行面板的推理过程点开就被收回"这个缺陷在零费用的开发服务器上根本复现不出来。
  /** 丢掉太久没人看的流缓冲。 */
  #pruneLive(maxAgeMs) { return pruneLive(this.live, maxAgeMs); }

  /** 某个实验下各候选的实时流快照，供界面在生成过程中观察。 */
  liveFor(experimentId) { return liveForAttempts(this.store, this.live, this.runs, experimentId); }

  /** 取消一个候选：尽力中止，保存已知用量（F 取消语义）。 */
  cancelCandidate(attemptId) {
    const run = this.runs.get(attemptId);
    if (!run) return { ok: false, reason: '这个候选当前没有在运行' };
    run.controller.abort();
    return { ok: true };
  }

  /** 取消整轮。 */
  cancelAll(experimentId) {
    const attempts = this.store.listAttempts(experimentId);
    let cancelled = 0;
    for (const a of attempts) {
      if (this.runs.has(a.id)) { this.runs.get(a.id).controller.abort(); cancelled += 1; }
    }
    return { cancelled };
  }

  /**
   * 把宿主重启前没跑完的尝试标为 interrupted（A09：未完成标记中断、不自动重付费）。
   *
   * 判定与写入都在 store 里（running 与 queued 都算没跑完），这里只负责不让它影响插件加载。
   * **不新建 attempt、不重新发起调用** —— 重试必须由用户显式点。
   */
  markInterrupted() {
    return recoverUnfinishedAttempts(this.store);
  }

  async stop() {
    for (const d of this.disposers) { try { d(); } catch { /* 已经释放 */ } }
    this.disposers = [];
    for (const [, run] of this.runs) { try { run.controller.abort(); } catch { /* 已结束 */ } }
    this.runs.clear();
    if (this.previewServer) { try { await this.previewServer.close(); } catch { /* 已关闭 */ } this.previewServer = null; }
    try { this.store.close(); } catch { /* 已关闭 */ }
  }
}

/**
 * Cordis 插件入口。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} config
 */
export function apply(ctx, config = {}) {
  const runtime = new HtmlArenaRuntime(ctx, config);
  ctx.effect(() => {
    let disposed = false;
    runtime.start().then(() => {
      if (disposed) return;
      const n = runtime.markInterrupted();
      const migrated = runtime.store.migratedFrom;
      ctx.logger?.info?.('[html-arena] 已启动：预览源 ' + runtime.previewOrigin + '，API ' + API_PREFIX
        + (migrated ? '，数据目录已从 schema ' + migrated + ' 迁移到 ' + SCHEMA_VERSION : '')
        + (n.count > 0 ? '，' + n.count + ' 个未完成尝试已标记为中断（不会自动重试，也不重新计费）' : ''));
    }).catch((err) => {
      ctx.logger?.error?.('[html-arena] 启动失败：' + String(err && err.message || err));
    });
    return () => {
      disposed = true;
      return runtime.stop();
    };
  });

  // 不往 ctx 上挂属性：Cordis 要求先 provide 才能设置服务属性，
  // 而本插件不需要把 runtime 暴露成服务。返回值供测试与调试使用。
  return runtime;
}

export { Store, newId, newToken, extractHtml, extractHtmlFromCandidate, sha256Hex, runGeneration, explainError, listModelCatalog, resolveCandidateConfig, capturePreviewInSubprocess, CDN_ALLOWLIST, NETWORK_POLICIES, VIEWPORTS, sandboxAttribute, createPreviewServer };
export { SettingsStore, CAPABILITIES, defaultSettings, normalizeSettings } from './core/settings.js';
