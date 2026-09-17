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
import { Store, newId, newToken } from './core/store.js';
import { extractHtml, extractHtmlFromCandidate, sha256Hex, EXTRACTOR_VERSION } from './core/extract.js';
import { runGeneration, explainError, listModelCatalog, resolveCandidateConfig } from './core/runner.js';
import { createPreviewServer } from './preview/server.js';
import { capturePreviewInSubprocess, loadPlaywright } from './preview/browser.js';
import { CDN_ALLOWLIST, NETWORK_POLICIES, VIEWPORTS, sandboxAttribute } from './preview/policy.js';
import { createApi } from './api.js';

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
    this.store = new Store(this.resolveDataDir());
    this.runs = new Map();          // attemptId -> { controller, startedAt }
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
  async runCandidate(job) {
    const { attemptId, compiled } = job;
    const controller = new AbortController();
    this.runs.set(attemptId, { controller, startedAt: Date.now() });
    this.store.touchExperiment(job.experimentId);

    const emit = (event) => {
      // 事件只用于日志与调试；状态以 SQLite 为准（页面刷新只恢复展示，不重跑）
      if (event.type === 'first-event') this.store.stampReceipt(attemptId, 'first_event_at', event.at);
      if (event.type === 'first-text') this.store.stampReceipt(attemptId, 'first_text_at', event.at);
    };

    try {
      this.store.updateAttemptStatus(attemptId, 'running');
      this.store.stampReceipt(attemptId, 'started_at', Date.now());

      const result = await runGeneration({
        llm: llmOf(this.ctx),
        provider: compiled.provider,
        model: compiled.model,
        system: compiled.system,
        content: [{ type: 'text', text: compiled.userText }],
        temperature: compiled.temperature,
        maxTokens: compiled.maxTokens,
        reasoningEffort: compiled.reasoningEffort,
        signal: controller.signal,
        onEvent: emit,
      });

      // 原始正文不可变落盘（F06）
      const raw = await this.store.writeRaw(attemptId, result.text ?? '');
      // F06：推理信息与原始正文分开保存（只存服务实际返回的内容）
      if (result.reasoning && result.reasoning.length > 0) {
        await this.store.writeReasoning(attemptId, result.reasoning);
      }
      const extraction = extractHtml(result.text ?? '', { finishReason: result.receipt.finishReason });
      let htmlInfo = { hash: null, path: null };
      if (extraction.status === 'ok' && extraction.html !== null) {
        htmlInfo = await this.store.writeHtml(attemptId, extraction.html);
      }
      this.store.createArtifact({
        id: attemptId, attemptId,
        rawHash: raw.hash, htmlHash: htmlInfo.hash,
        extractionVersion: EXTRACTOR_VERSION, extractionMode: extraction.mode,
        extractionRange: extraction.range, extractionStatus: extraction.status,
        extractionWarnings: extraction.warnings, rawPath: raw.path, htmlPath: htmlInfo.path,
        bytes: raw.bytes,
      });

      this.store.updateAttemptStatus(attemptId, result.status);
      this.store.finishReceipt(attemptId, {
        finishReason: result.receipt.finishReason,
        errorCode: result.receipt.error?.code ?? null,
        errorMessage: result.receipt.error?.message ?? null,
        errorStatus: result.receipt.error?.status ?? null,
        usage: result.receipt.usage,
        observedRequests: result.receipt.observedRequests,
      });

      // 诊断：推理把预算吃光时，text 很短但 reasoning 很长，界面要能说清这一点。
      // 只在「确实完成、但没有正文」时给出；取消或失败的原因更准确，不能被覆盖
      //（真实调用踩到过：取消后的 attempt 被这条诊断改写成了 EMPTY_RESPONSE）。
      if (result.status === 'completed' && (result.text ?? '').length === 0 && (result.reasoning ?? '').length > 0) {
        this.store.finishReceipt(attemptId, {
          finishReason: result.receipt.finishReason,
          errorCode: 'EMPTY_RESPONSE',
          errorMessage: '模型把输出预算都用在了推理上，没有产生正文（推理 ' + result.reasoning.length + ' 字符）。'
            + '提高该候选的输出上限，或换一个不输出推理的模型。',
          errorStatus: null, usage: result.receipt.usage, observedRequests: result.receipt.observedRequests,
        });
      }
      return { status: result.status, extraction: { status: extraction.status, warnings: extraction.warnings } };
    } catch (err) {
      // 不该发生：runGeneration 已经把 provider 错误转成结果。真发生就如实记录。
      this.store.updateAttemptStatus(attemptId, 'failed');
      this.store.finishReceipt(attemptId, {
        finishReason: 'thrown', errorCode: 'PLUGIN_ERROR',
        errorMessage: String(err && err.message || err).slice(0, 1000),
        observedRequests: 1,
      });
      return { status: 'failed', error: String(err && err.message || err) };
    } finally {
      this.runs.delete(attemptId);
    }
  }

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

  /** 把 DSH 重启前仍在 running 的尝试标为 interrupted（A09，不自动重付费）。 */
  markInterrupted() {
    let count = 0;
    try {
      const rows = this.store.db.prepare("SELECT id FROM attempts WHERE status = 'running'").all();
      for (const r of rows) { this.store.updateAttemptStatus(r.id, 'interrupted'); count += 1; }
    } catch { /* 存储不可用时忽略，不影响加载 */ }
    return count;
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
      ctx.logger?.info?.('[html-arena] 已启动：预览源 ' + runtime.previewOrigin + '，API ' + API_PREFIX
        + (n > 0 ? '，' + n + ' 个未完成尝试已标记为中断' : ''));
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
