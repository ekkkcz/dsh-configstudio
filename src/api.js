/**
 * HTTP API —— 浏览器半边通过同端口路由访问（/html-arena/api/*）。
 *
 * 安全要点：
 *  - 只接受本机回环来源。DSH 的 webserver 有它自己的信任栅栏，这里再加一道
 *    Host 检查，避免被其它来源当成开放接口调用（会花用户的钱）。
 *  - 浏览器绝不透传文件系统路径：一切对象用服务端生成的 ID 解析（PRD 6.1）。
 *  - 输入超限明确拒绝，不静默截断（F05 / A10）。
 *  - 请求体有大小上限，防止构造超大请求打爆内存（F22 的同类防护）。
 *
 * @module html-arena/api
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { newId, newToken } from './core/store.js';
import { sha256Hex, extractHtmlFromCandidate } from './core/extract.js';
import { explainError, listModelCatalog, resolveCandidateConfig } from './core/runner.js';
import { buildCsp, CDN_ALLOWLIST, NETWORK_POLICIES, VIEWPORTS, sandboxAttribute, validateCdnOrigins } from './preview/policy.js';
import { createUiRouter } from './ui.js';
import { baseUrlFromRequest, detectOptimizer, optimizePrompt, OPTIMIZER_TIERS, OPTIMIZER_PATH } from './core/optimizer.js';
import { CAPABILITIES, capabilityEnabled } from './core/settings.js';

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const LIMITS = { promptMaxChars: 50000, startHtmlMaxBytes: 2 * 1024 * 1024 };

/**
 * 实时流缓冲每个候选保留的字符上限。
 * 必须与 src/index.js 的 LIVE_MAX 一致 —— 之所以不 import，是因为 index.js 已经 import 本文件，
 * 反向 import 会形成循环依赖。
 */
const LIVE_MAX = 64 * 1024;

/** 输出要求预设（零依赖单 HTML 等）。界面点一下就把文本填进"输出要求"，之后仍可自由编辑。 */
const REQUIREMENT_PRESETS = [
  { key: 'offline-single', label: '无依赖单 HTML（离线可开）', text: '必须是一个完整的单文件 HTML，除它以外不要输出任何内容；不引用任何外部资源（不使用 CDN、外链 CSS/JS、外部字体与图片），所有样式与脚本内联；直接双击用浏览器打开就能正常工作。' },
  { key: 'responsive', label: '响应式（手机与桌面都可用）', text: '页面要在窄屏（约 390px）与桌面（约 1280px）下都能正常使用，窄屏不要出现横向滚动条。' },
  { key: 'no-build', label: '不用构建工具与框架', text: '只用原生 HTML / CSS / JavaScript，不要使用 React、Vue 等框架，也不要使用需要编译的语法。' },
  { key: 'demo-data', label: '内置演示数据', text: '需要展示数据时使用内置的示例数据，不要发起网络请求；数据要能体现真实差异，不要用递增的假数字。' },
  { key: 'interactive', label: '必须有可交互功能', text: '至少有一个真正可用的交互功能（按钮 / 输入 / 切换等），点击后要有可见的状态变化。' },
  { key: 'a11y', label: '基本可访问性', text: '使用语义化标签，交互元素可用键盘操作，主要文字与背景对比度足够。' },
  { key: 'no-placeholder', label: '不写占位与 TODO', text: '不要说"这里可以扩展"，也不要留 TODO 或空函数；交付的就是能直接用的完整作品。' },
];

/** 并发闸门：默认 2，可选 1 或 2（F04）。首版不开放无限并发。 */
class ConcurrencyGate {
  constructor(limit) { this.limit = limit; this.active = 0; this.queue = []; }
  setLimit(n) { this.limit = Math.max(1, Math.min(2, n)); this.#drain(); }
  acquire() {
    if (this.active < this.limit) { this.active += 1; return Promise.resolve(); }
    return new Promise((resolve) => { this.queue.push(resolve); });
  }
  release() { this.active = Math.max(0, this.active - 1); this.#drain(); }
  #drain() {
    while (this.active < this.limit && this.queue.length > 0) {
      this.active += 1;
      this.queue.shift()();
    }
  }
  get pending() { return this.queue.length; }
}

/**
 * 优化器状态 + 用户开关，合成一份界面能直接用的视图。
 * **探测与启用是两件事**：探测只回答"本机有没有装"，开关回答"要不要用"。
 */
async function optimizerStatusFor(runtime, req) {
  const info = await detectOptimizer(baseUrlFromRequest(req));
  let enabled = false;
  try { enabled = capabilityEnabled(runtime.settings, 'prompt-optimizer'); } catch { enabled = false; }
  return {
    ...info,
    enabled,
    // 界面文案要能解释"为什么没显示"，所以把三种情况分开写
    note: !info.available
      ? '未检测到提示词优化插件（或它不可用）：' + (info.reason || '未知原因')
      : enabled
        ? '已启用：优化结果先给你看，点按钮才生效。'
        : '检测到本机装有 ' + CAPABILITIES[0].source + '，但**尚未启用** —— 是否使用另一个插件的能力由你决定，可在「设置」里打开。',
  };
}

/** 完整设置视图：每项能力是否探测到、是否已启用。 */
async function settingsView(runtime, req) {
  let detected = {};
  try {
    detected = { 'prompt-optimizer': await detectOptimizer(baseUrlFromRequest(req)) };
  } catch { detected = {}; }
  const view = runtime.settings.view(detected);
  // 界面不需要知道设置文件的绝对路径（那是宿主机信息），只给相对位置
  return { ...view, path: undefined, file: 'settings.json（位于本插件的数据目录）' };
}

export function createApi(runtime) {
  const gate = new ConcurrencyGate(runtime.config.defaultConcurrency);
  runtime.gate = gate;
  /** 界面静态资源。延迟建立，失败时退回到函数内建的兜底页。 */
  let ui = null;
  const uiReady = createUiRouter(runtime).then((u) => { ui = u; }).catch(() => { ui = null; });

  /** 路由分发。 */
  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    let path = url.pathname;
    if (path.startsWith('/html-arena')) path = path.slice('/html-arena'.length);
    if (path.startsWith('/api')) path = path.slice('/api'.length);
    if (path === '') path = '/';

    const method = req.method ?? 'GET';

    if (!isLocalRequest(req)) {
      return json(res, 403, { error: '只接受来自本机的请求' });
    }
    if (method === 'OPTIONS') { res.writeHead(204).end(); return; }

    try {
      // 界面静态资源（index.html / app.css / app.js）
      await uiReady;
      if (ui && ui.handle(req, res)) return;

      if (path === '/meta' && method === 'GET') {
        const browser = await runtime.probeBrowser();
        return json(res, 200, {
          pluginVersion: runtime.config.pluginVersion ?? null,
          node: process.version,
          platform: process.platform,
          dshVersion: detectDshVersion(),
          previewOrigin: runtime.previewOrigin,
          browser,
          limits: LIMITS,
          cdnAllowlist: CDN_ALLOWLIST,
          networkPolicies: NETWORK_POLICIES,
          viewports: VIEWPORTS,
          // 首帧就要知道优化器在不在，否则按钮会闪一下才消失。探测很快且带超时。
          // 注意：**探测到 ≠ 启用**（用户反馈 1）。optimizer 里带 enabled 字段，
          // 界面只在 enabled 为真时才显示优化区。
          optimizer: await optimizerStatusFor(runtime, req),
          sandbox: sandboxAttribute(),
          concurrency: { limit: gate.limit, active: gate.active, pending: gate.pending },
        });
      }

      if (path === '/models' && method === 'GET') {
        if (!runtime.llmOf()) {
          return json(res, 200, { available: false, reason: '这个 DSH 组合没有提供 llm 服务', providers: [], modelsByProvider: {}, errors: [] });
        }
        const catalog = await listModelCatalog(runtime.llmOf());
        return json(res, 200, { available: true, ...catalog });
      }

      if (path === '/models/resolve' && method === 'POST') {
        const body = await readJson(req);
        const resolved = await resolveCandidateConfig(runtime.llmOf(), {
          provider: String(body.provider ?? ''), model: String(body.model ?? ''),
          reasoningEffort: body.reasoningEffort ?? null,
        });
        return json(res, 200, { resolved });
      }

      // ── 提示词优化器对接（可选能力，零侵入） ──────────────────
      // 经只读核查：对方没有 provide 服务、也没有导出函数，唯一入口是它自己的 HTTP API。
      // 我们与它同进程同端口，所以用本次请求的 Host 直接回到本机，不需要用户配置端口。
      if (path === '/optimizer/status' && method === 'GET') {
        const base = baseUrlFromRequest(req);
        const info = await detectOptimizer(base);
        const caps = runtime.settings.view({ 'prompt-optimizer': info });
        return json(res, 200, {
          ...info,
          enabled: caps.capabilities[0].enabled,
          tiers: OPTIMIZER_TIERS,
          path: OPTIMIZER_PATH,
          note: info.available
            ? '检测到提示词优化插件。它没有提供服务接口，本插件通过它自己的 HTTP API 对接，不改动它。'
            : '未检测到提示词优化插件（或它不可用）。优化功能会隐藏，其它功能不受影响。' + (info.reason ? ' 原因：' + info.reason : ''),
        });
      }

      if (path === '/optimizer/optimize' && method === 'POST') {
        // 用户没有明确启用这个外部能力时，拒绝执行 —— 不替用户花钱（反馈 1）。
        // 这不是错误，是"这个能力还没被打开"，界面会引导去设置里开。
        if (!capabilityEnabled(runtime.settings, 'prompt-optimizer')) {
          return json(res, 200, {
            ok: false, disabled: true,
            reason: '提示词优化尚未启用。它是另一个插件（@dsh-external/dsh-prompt-optimizer）的能力，需要你在「设置」里明确打开后才会运行。',
          });
        }
        const base = baseUrlFromRequest(req);
        const body = await readJson(req);
        const r = await optimizePrompt(base, {
          request: body.request,
          tier: body.tier,
          provider: body.provider ?? null,
          model: body.model ?? null,
          timeoutMs: body.timeoutMs ?? undefined,
        });
        // fail-open：优化失败不是服务器错误，如实返回 ok:false 与原因，由界面决定是否用原文
        return json(res, 200, r);
      }

      // ── 设置（跟随数据目录持久化，用户反馈 1） ────────────────
      if (path === '/settings' && method === 'GET') {
        return json(res, 200, await settingsView(runtime, req));
      }
      if (path === '/settings' && method === 'PUT') {
        const body = await readJson(req);
        const r = runtime.settings.update(body);
        if (!r.ok) return json(res, 400, { error: r.reason });
        return json(res, 200, { ok: true, ...(await settingsView(runtime, req)), rejected: r.rejected ?? [] });
      }

      // 输出要求预设：纯静态清单，点了只是把文字填进输入框，之后仍可任意编辑。
      if (path === '/requirement-presets' && method === 'GET') {
        return json(res, 200, {
          presets: REQUIREMENT_PRESETS,
          note: '这些只是方便填写的文本模板，会与你已有的输出要求一起发送；不会覆盖你写的内容。',
        });
      }

      if (path === '/experiments' && method === 'GET') {
        const search = url.searchParams.get('search') ?? undefined;
        const category = url.searchParams.get('category') ?? undefined;
        const list = runtime.store.listExperiments({ search, category });
        return json(res, 200, { experiments: list.map((e) => summarizeExperiment(runtime, e)) });
      }

      // 无状态请求预览：不创建实验，因此不会污染实验列表。
      if (path === '/preview-request' && method === 'POST') {
        const body = await readJson(req);
        const validation = validateExperimentInput(body.task ?? {});
        if (!validation.ok) return json(res, 400, { error: validation.error, field: validation.field });
        const taskSnapshot = {
          prompt: String(body.task?.prompt ?? ''),
          startHtml: typeof body.task?.startHtml === 'string' && body.task.startHtml.length > 0 ? body.task.startHtml : null,
          outputRequirements: String(body.task?.outputRequirements ?? ''),
        };
        const taskHash = await sha256Hex(JSON.stringify({
          kind: 'task', prompt: taskSnapshot.prompt, startHtml: taskSnapshot.startHtml,
          outputRequirements: taskSnapshot.outputRequirements,
        }));
        const candidates = Array.isArray(body.candidates) ? body.candidates : [];
        const compiled = buildCompiledMessages({ taskSnapshot }, candidates);
        return json(res, 200, {
          taskHash,
          compilerVersion: MESSAGE_COMPILER_VERSION,
          previewCount: compiled.length,
          requests: compiled.map((c, i) => ({
            slot: i,
            provider: c.provider,
            model: c.model,
            system: c.system ?? null,
            user: c.userText,
            temperature: c.temperature ?? null,
            maxTokens: c.maxTokens ?? null,
            reasoningEffort: c.reasoningEffort ?? null,
            tools: null,
            note: '不发送 tools / sessionId / purpose：本次是单次逻辑生成请求，不含工具循环',
          })),
        });
      }

      if (path === '/experiments' && method === 'POST') {
        const body = await readJson(req);
        const validation = validateExperimentInput(body);
        if (!validation.ok) return json(res, 400, { error: validation.error, field: validation.field });

        const taskSnapshot = {
          prompt: body.prompt,
          startHtml: typeof body.startHtml === 'string' && body.startHtml.length > 0 ? body.startHtml : null,
          outputRequirements: String(body.outputRequirements ?? ''),
          createdAt: Date.now(),
        };
        const taskHash = await sha256Hex(JSON.stringify({
          kind: 'task', prompt: taskSnapshot.prompt, startHtml: taskSnapshot.startHtml,
          outputRequirements: taskSnapshot.outputRequirements,
        }));
        const outputPolicy = {
          maxTokens: body.outputPolicy?.maxTokens ?? runtime.config.defaultMaxTokens,
          timeoutMs: body.outputPolicy?.timeoutMs ?? runtime.config.defaultTimeoutMs,
          concurrency: body.outputPolicy?.concurrency ?? runtime.config.defaultConcurrency,
        };
        const previewPolicy = {
          networkPolicy: body.previewPolicy?.networkPolicy === 'cdn' ? 'cdn' : 'offline',
          viewport: body.previewPolicy?.viewport ?? 'desktop',
        };
        const exp = runtime.store.createExperiment({
          title: String(body.title ?? '未命名实验').slice(0, 200),
          category: String(body.category ?? ''),
          taskSnapshot, taskHash, outputPolicy, previewPolicy,
        });
        return json(res, 201, { experiment: exp, taskHash });
      }

      const expMatch = /^\/experiments\/([^/]+)(\/.*)?$/.exec(path);
      if (expMatch) {
        const id = decodeURIComponent(expMatch[1]);
        const rest = expMatch[2] ?? '';
        const exp = runtime.store.getExperiment(id);
        if (!exp) return json(res, 404, { error: '找不到这个实验' });

        if (rest === '' && method === 'GET') {
          const attempts = runtime.store.listAttempts(id);
          const vote = runtime.store.getVote(id);
          return json(res, 200, {
            experiment: exp,
            attempts: attempts.map((a) => describeAttempt(runtime, a)),
            vote: vote ? publicVote(vote, attempts) : null,
            runs: [...runtime.runs.keys()],
          });
        }

        // 生成过程中的实时观察。这是**辅助观察**接口，不是权威数据源：
        // 只返回缓冲区里的尾部文本，完整内容以落盘的原始正文为准。
        if (rest === '/live' && method === 'GET') {
          const live = typeof runtime.liveFor === 'function' ? runtime.liveFor(id) : [];
          return json(res, 200, {
            at: Date.now(),
            note: '生成过程中的实时预览，每个候选只保留尾部 ' + Math.round(LIVE_MAX / 1024) + 'KB；'
              + '权威内容以落盘的原始正文为准。',
            streams: live,
          });
        }

        if (rest === '' && method === 'DELETE') {
          runtime.cancelAll(id);
          runtime.store.deleteExperiment(id);
          return json(res, 200, { deleted: true, note: '本地记录与作品文件已移除；配方是独立对象，未被删除' });
        }

        if (rest === '/start' && method === 'POST') {
          if (!runtime.llmOf()) return json(res, 400, { error: '这个 DSH 组合没有提供 llm 服务，无法生成' });
          const body = await readJson(req);
          const candidates = Array.isArray(body.candidates) ? body.candidates : [];
          if (candidates.length < 1 || candidates.length > 4) {
            return json(res, 400, { error: '候选数量必须是 1 到 4 个' });
          }
          const problems = [];
          const resolvedList = [];
          for (let i = 0; i < candidates.length; i += 1) {
            const c = candidates[i];
            if (!c.provider || !c.model) { problems.push('候选 ' + (i + 1) + ' 没有选定模型'); continue; }
            const resolved = await resolveCandidateConfig(runtime.llmOf(), {
              provider: c.provider, model: c.model, reasoningEffort: c.reasoningEffort ?? null,
            });
            resolvedList.push(resolved);
            if (resolved.reasoningEffortSupported === false) {
              problems.push('候选 ' + (i + 1) + '（' + (c.name || c.model) + '）不支持思考档位 "' + c.reasoningEffort + '"；'
                + '可选值：' + (resolved.availableReasoningEfforts ?? []).join(', '));
            }
          }
          if (problems.length > 0) return json(res, 400, { error: '开始前检查未通过', problems });

          const requestedConcurrency = Number(body.concurrency ?? runtime.config.defaultConcurrency);
          gate.setLimit(requestedConcurrency === 1 ? 1 : 2);
          runtime.store.setExperimentStatus(id, 'running');

          // 先拼消息再建 attempt：每个 attempt 要把"这一轮实际发出去的 user 文本"记进 recipeSnapshot，
          // 追加轮次要靠它回放上一轮的上下文（否则只能伪造，那就破坏 F02 的可核对性）。
          const compiled = buildCompiledMessages(exp, candidates);
          const created = [];
          for (let i = 0; i < candidates.length; i += 1) {
            const c = candidates[i];
            const attemptNo = runtime.store.listAttempts(id).filter((a) => a.candidateSlot === i).length + 1;
            const recipeSnapshot = {
              slot: i, name: String(c.name ?? ('候选 ' + (i + 1))),
              provider: c.provider, model: c.model,
              systemPrompt: c.systemPrompt ?? null,
              promptSegments: Array.isArray(c.promptSegments) ? c.promptSegments : [],
              temperature: typeof c.temperature === 'number' ? c.temperature : null,
              maxTokens: typeof c.maxTokens === 'number' ? c.maxTokens : null,
              reasoningEffort: c.reasoningEffort ?? null,
              userText: compiled[i] ? compiled[i].userText : null,
              roundNote: null,
              requestedAt: Date.now(),
            };
            const attemptId = runtime.store.createAttempt({
              experimentId: id, candidateSlot: i, attemptNo,
              recipeSnapshot,
              requestedConfig: { provider: c.provider, model: c.model, temperature: recipeSnapshot.temperature, maxTokens: recipeSnapshot.maxTokens, reasoningEffort: recipeSnapshot.reasoningEffort },
              resolvedConfig: resolvedList[i] ?? null,
              parentAttemptId: null,
            });
            created.push({ attemptId, slot: i });
          }

          for (let i = 0; i < created.length; i += 1) {
            const { attemptId } = created[i];
            void (async () => {
              await gate.acquire();
              try {
                await runtime.runCandidate({ experimentId: id, attemptId, compiled: compiled[i] });
              } finally {
                gate.release();
                finalizeExperiment(runtime, id);
              }
            })();
          }
          return json(res, 202, { started: created, concurrency: gate.limit });
        }

        if (rest === '/cancel' && method === 'POST') {
          const body = await readJson(req).catch(() => ({}));
          if (body.attemptId) {
            const r = runtime.cancelCandidate(String(body.attemptId));
            return json(res, r.ok ? 200 : 409, r);
          }
          const r = runtime.cancelAll(id);
          return json(res, 200, r);
        }

        const pickMatch = /^\/attempts\/([^/]+)\/pick$/.exec(rest);
        if (pickMatch && method === 'POST') {
          const body = await readJson(req);
          const attemptId = decodeURIComponent(pickMatch[1]);
          const attempt = runtime.store.getAttempt(attemptId);
          if (!attempt) return json(res, 404, { error: '找不到这个候选' });
          const rawText = runtime.store.readRaw(attemptId);
          let picked;
          try {
            picked = extractHtmlFromCandidate(rawText, Number(body.candidateIndex), {
              finishReason: attempt.receipt?.finishReason ?? null,
            });
          } catch (err) {
            return json(res, 400, { error: String(err && err.message || err) });
          }
          const info = await runtime.store.writeHtml(attemptId, picked.html);
          runtime.store.updateArtifactExtraction(attemptId, {
            htmlHash: info.hash, extractionVersion: picked.extractionVersion,
            extractionMode: picked.mode, extractionRange: picked.range,
            extractionStatus: 'ok', extractionWarnings: picked.warnings, htmlPath: info.path,
          });
          return json(res, 200, { ok: true, extraction: { status: 'ok', warnings: picked.warnings, range: picked.range } });
        }

        const dlMatch = /^\/attempts\/([^/]+)\/(raw|html)$/.exec(rest);
        if (dlMatch && method === 'GET') {
          const attemptId = decodeURIComponent(dlMatch[1]);
          const kind = dlMatch[2];
          if (!runtime.store.getAttempt(attemptId)) return json(res, 404, { error: '找不到这个候选' });
          try {
            const text = kind === 'raw' ? runtime.store.readRaw(attemptId) : runtime.store.readHtml(attemptId);
            res.writeHead(200, {
              'Content-Type': kind === 'html' ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8',
              'Content-Disposition': 'attachment; filename="' + attemptId + (kind === 'html' ? '.html' : '.txt') + '"',
              'Cache-Control': 'no-store',
            });
            return res.end(text);
          } catch {
            return json(res, 404, { error: kind === 'html' ? '这个候选没有可下载的 HTML（未被识别为作品）' : '找不到原始输出' });
          }
        }

        // ── 追加轮次（M2 反馈 3，用户选定方案 1） ──────────────────
        //
        // 用户原话："中途最好也可以让用户自己输入提示词啥的，中途输入的时候最好也能加插件"。
        // 流式接口上**无法**向已发出的请求追加消息（消息在发起时已冻结），
        // 所以这里把"中途输入"实现成**新的一轮 attempt**：复用已有的"重试新建 attempt"机制，
        // 原 attempt 与它的原始输出完整保留、仍可下载；每一轮仍是一次逻辑请求（F02 不变）。
        if (rest === '/rounds' && method === 'POST') {
          const body = await readJson(req);
          const note = typeof body.note === 'string' ? body.note.trim() : '';
          if (note.length === 0) return json(res, 400, { error: '本轮要改的地方不能为空' });
          if (note.length > LIMITS.promptMaxChars) {
            return json(res, 400, { error: '本轮输入超过上限 ' + LIMITS.promptMaxChars + ' 字符（当前 ' + note.length + '），不会替你截断' });
          }

          // 每个候选取它最近的一次 attempt 作为"上一轮"
          const all = runtime.store.listAttempts(id);
          const latestBySlot = new Map();
          for (const a of all) latestBySlot.set(a.candidateSlot, a);
          const slots = [...latestBySlot.keys()].sort((x, y) => x - y);
          if (slots.length === 0) return json(res, 409, { error: '这个实验还没有任何候选记录，无法追加轮次' });

          // 上一轮必须真的有正文可回放：没有就拒绝，**不伪造 assistant 消息**
          const problems = [];
          for (const slot of slots) {
            const prev = latestBySlot.get(slot);
            if (runtime.runs.has(prev.id) || prev.status === 'queued' || prev.status === 'running') {
              problems.push('候选 ' + String.fromCharCode(65 + slot) + ' 还在生成中，等它结束再追加轮次');
              continue;
            }
            let raw = '';
            try { if (prev.artifact?.rawTextHash) raw = runtime.store.readRaw(prev.id); } catch { raw = ''; }
            if (raw.trim().length === 0) {
              problems.push('候选 ' + String.fromCharCode(65 + slot) + ' 上一轮没有产出正文（'
                + (prev.receipt?.errorCode || prev.status) + '），没有可回放的上下文；请先重试出一版再追加');
            }
          }
          if (problems.length > 0) return json(res, 409, { error: '还不能追加轮次', problems });

          const created = [];
          for (const slot of slots) {
            const prev = latestBySlot.get(slot);
            const prevRounds = all.filter((a) => a.candidateSlot === slot);
            // 只回放"真的发生过"的内容：上一轮的 user 文本 + 上一轮的原始正文
            const history = [];
            for (const a of prevRounds) {
              const raw = (() => { try { return a.artifact?.rawTextHash ? runtime.store.readRaw(a.id) : ''; } catch { return ''; } })();
              const userText = a.recipeSnapshot?.userText;
              if (userText) history.push({ role: 'user', text: userText });
              if (raw && raw.length > 0) history.push({ role: 'assistant', text: raw });
            }
            const compiled = buildCompiledMessages(exp, [prev.recipeSnapshot], { history, roundNote: note })[0];
            const attemptNo = prevRounds.length + 1;
            const recipeSnapshot = {
              ...prev.recipeSnapshot,
              userText: compiled.userText,
              roundNote: note,
              requestedAt: Date.now(),
            };
            const newAttemptId = runtime.store.createAttempt({
              experimentId: id, candidateSlot: slot, attemptNo,
              recipeSnapshot,
              requestedConfig: prev.requestedConfig,
              resolvedConfig: prev.resolvedConfig,
              parentAttemptId: prev.id,
            });
            created.push({
              attemptId: newAttemptId, slot, attemptNo, parentAttemptId: prev.id,
              compiled,
              historyMessages: history.length,
              // 让界面能如实显示"这一轮往上下文里放了什么"，而不是让用户猜
              contextWindowNote: '上一轮回放 ' + history.filter((h) => h.role === 'user').length + ' 条输入 + '
                + history.filter((h) => h.role === 'assistant').length + ' 条正文',
            });
          }

          runtime.store.setExperimentStatus(id, 'running');
          // 逐个候选排进并发闸门（与首轮同一套队列语义）
          for (const c of created) {
            void (async () => {
              await gate.acquire();
              try { await runtime.runCandidate({ experimentId: id, attemptId: c.attemptId, compiled: c.compiled }); }
              finally { gate.release(); finalizeExperiment(runtime, id); }
            })();
          }
          // 回执里不带 compiled（里面有完整的上下文文本，界面用不上），只回可核对的元信息
          return json(res, 202, {
            round: note,
            started: created.map((c) => ({
              attemptId: c.attemptId, slot: c.slot, attemptNo: c.attemptNo,
              parentAttemptId: c.parentAttemptId, historyMessages: c.historyMessages,
              contextWindowNote: c.contextWindowNote,
            })),
            concurrency: gate.limit,
          });
        }

        const retryMatch = /^\/attempts\/([^/]+)\/retry$/.exec(rest);
        if (retryMatch && method === 'POST') {
          const oldId = decodeURIComponent(retryMatch[1]);
          const old = runtime.store.getAttempt(oldId);
          if (!old) return json(res, 404, { error: '找不到这个候选' });
          const attemptNo = runtime.store.listAttempts(id).filter((a) => a.candidateSlot === old.candidateSlot).length + 1;
          const newAttemptId = runtime.store.createAttempt({
            experimentId: id, candidateSlot: old.candidateSlot, attemptNo,
            recipeSnapshot: old.recipeSnapshot, requestedConfig: old.requestedConfig,
            resolvedConfig: old.resolvedConfig, parentAttemptId: oldId,
          });
          const compiled = buildCompiledMessages(exp, [old.recipeSnapshot])[0];
          void (async () => {
            await gate.acquire();
            try { await runtime.runCandidate({ experimentId: id, attemptId: newAttemptId, compiled }); }
            finally { gate.release(); finalizeExperiment(runtime, id); }
          })();
          return json(res, 202, { attemptId: newAttemptId, attemptNo, parentAttemptId: oldId });
        }

        const shotMatch = /^\/attempts\/([^/]+)\/screenshot$/.exec(rest);
        if (shotMatch && method === 'POST') {
          const attemptId = decodeURIComponent(shotMatch[1]);
          const attempt = runtime.store.getAttempt(attemptId);
          if (!attempt) return json(res, 404, { error: '找不到这个候选' });
          if (!runtime.store.hasHtml(attemptId)) return json(res, 409, { error: '这个候选没有可预览的 HTML，无法截图' });
          const body = await readJson(req).catch(() => ({}));
          const viewportName = body.viewport === 'mobile' ? 'mobile' : 'desktop';
          const viewport = VIEWPORTS[viewportName];
          const runToken = newToken();
          const targetUrl = runtime.previewOrigin + '/preview/' + attemptId + '?token=' + runToken
            + '&network=' + encodeURIComponent(exp.previewPolicy.networkPolicy);
          const { capturePreviewInSubprocess } = await import('./preview/browser.js');
          const result = await capturePreviewInSubprocess({ url: targetUrl, viewport, dpr: 1, timeoutMs: 10000, screenshot: true });
          return json(res, 200, {
            status: result.status,
            viewport: result.viewport ?? viewport,
            dpr: result.dpr ?? 1,
            waitUntil: result.waitUntil ?? 'load',
            durationMs: result.durationMs ?? null,
            stateNote: result.stateNote ?? null,
            networkPolicy: exp.previewPolicy.networkPolicy,
            screenshotBase64: result.screenshotBase64 ?? null,
            pageErrors: result.pageErrors ?? [],
            consoleMessages: (result.consoleMessages ?? []).slice(0, 50),
            failedRequests: (result.failedRequests ?? []).slice(0, 50),
            reason: result.reason ?? null,
          });
        }
      }

      const voteMatch = /^\/experiments\/([^/]+)\/vote$/.exec(path);
      if (voteMatch) {
        const id = decodeURIComponent(voteMatch[1]);
        const exp = runtime.store.getExperiment(id);
        if (!exp) return json(res, 404, { error: '找不到这个实验' });

        if (method === 'GET') {
          const vote = runtime.store.getVote(id);
          const attempts = runtime.store.listAttempts(id);
          return json(res, 200, { vote: vote ? publicVote(vote, attempts) : null });
        }
        if (method === 'POST') {
          const body = await readJson(req);
          const attempts = runtime.store.listAttempts(id).filter((a) => a.status === 'completed' || a.artifact);
          if (attempts.length < 2) return json(res, 400, { error: '至少需要两个有作品的候选才能比较' });
          const mapping = {};
          const slots = [...attempts].sort((a, b) => a.candidateSlot - b.candidateSlot);
          slots.forEach((a, i) => { mapping[String.fromCharCode(65 + i)] = a.id; });
          const choice = String(body.choice ?? '');
          if (!['A', 'B', 'C', 'D', 'tie', 'undecided'].includes(choice)) {
            return json(res, 400, { error: '选择必须是 A/B/C/D/tie/undecided 之一' });
          }
          runtime.store.saveVote({
            experimentId: id, anonymousMapping: mapping, choice,
            tags: Array.isArray(body.tags) ? body.tags.slice(0, 10) : null,
            note: typeof body.note === 'string' ? body.note.slice(0, 2000) : null,
          });
          if (body.reveal === true) runtime.store.revealVote(id);
          const vote = runtime.store.getVote(id);
          return json(res, 200, { vote: publicVote(vote, attempts) });
        }
      }

      const revealMatch = /^\/experiments\/([^/]+)\/reveal$/.exec(path);
      if (revealMatch && method === 'POST') {
        const id = decodeURIComponent(revealMatch[1]);
        if (!runtime.store.getExperiment(id)) return json(res, 404, { error: '找不到这个实验' });
        runtime.store.revealVote(id);
        const vote = runtime.store.getVote(id);
        const attempts = runtime.store.listAttempts(id);
        return json(res, 200, { vote: vote ? publicVote(vote, attempts) : null });
      }

      return json(res, 404, { error: '未知接口：' + method + ' ' + path });
    } catch (err) {
      return json(res, 500, {
        error: '服务器内部错误',
        detail: String(err && err.message || err).slice(0, 1000),
        hint: '这是插件的缺陷，不是你的操作问题。请把这条信息连同操作步骤一起反馈。',
      });
    }
  }

  return { handle, gate };
}

// ── 辅助函数 ──────────────────────────────────────────────────────────

function isLocalRequest(req) {
  const host = String(req.headers.host ?? '');
  const hostname = host.split(':')[0].replace(/^\[|\]$/g, '');
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1' || hostname === '';
}

function json(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body, 'utf8'),
  });
  res.end(body);
}

function html(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('请求体超过 ' + MAX_BODY_BYTES + ' 字节上限');
    chunks.push(chunk);
  }
  if (size === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function validateExperimentInput(body) {
  const prompt = typeof body.prompt === 'string' ? body.prompt : '';
  if (prompt.trim().length === 0) return { ok: false, error: '题目不能为空', field: 'prompt' };
  if (prompt.length > LIMITS.promptMaxChars) {
    return {
      ok: false, field: 'prompt',
      error: '题目超过 ' + LIMITS.promptMaxChars + ' 字符上限（当前 ' + prompt.length
        + '）。工具不会替你截断——请自行精简后重试。',
    };
  }
  if (typeof body.startHtml === 'string' && body.startHtml.length > 0) {
    const bytes = Buffer.byteLength(body.startHtml, 'utf8');
    if (bytes > LIMITS.startHtmlMaxBytes) {
      return {
        ok: false, field: 'startHtml',
        error: '起始 HTML 超过 ' + (LIMITS.startHtmlMaxBytes / 1024 / 1024) + 'MB 上限（当前 '
          + (bytes / 1024 / 1024).toFixed(2) + 'MB）。工具不会替你截断。',
      };
    }
  }
  return { ok: true };
}

/** 消息编译器版本：拼接规则固定且版本化（F03）。改变拼接必须提升这个号。 */
export const MESSAGE_COMPILER_VERSION = 1;

/** 代码围栏标记：用三个反引号，运行时拼出来以避免源码里出现字面量。 */
const FENCE = String.fromCharCode(96) + String.fromCharCode(96) + String.fromCharCode(96);

/**
 * 把公共题目 + 输出要求 + 候选片段拼成实际发送的消息。
 *
 * @param {object} exp
 * @param {object[]} candidates
 * @param {object} [opts]
 * @param {Array<{role:'user'|'assistant',text:string}>} [opts.history]
 *   追加轮次（M2 反馈 3）：**先前轮次**的上下文。它不改变"本轮是一次逻辑请求"这件事，
 *   只是把已经发生过的轮次放进这次请求里，让模型知道我们接着改。
 * @param {string} [opts.roundNote] 本轮用户新输入的话
 */
export function buildCompiledMessages(exp, candidates, opts = {}) {
  const history = Array.isArray(opts.history) ? opts.history : [];
  const roundNote = typeof opts.roundNote === 'string' ? opts.roundNote.trim() : '';
  return candidates.map((c) => {
    const parts = [];
    // 追加轮次时，"这一轮要改什么"放在最前面 —— 用户本轮说的话才是重点
    if (roundNote) parts.push('# 本轮要改的地方（在你上一版的基础上修改）\n' + roundNote);
    parts.push('# 题目\n' + exp.taskSnapshot.prompt);
    if (exp.taskSnapshot.outputRequirements) parts.push('# 输出要求\n' + exp.taskSnapshot.outputRequirements);
    if (exp.taskSnapshot.startHtml) {
      parts.push('# 起始 HTML（作为参考材料，不是历史对话）\n' + exp.taskSnapshot.startHtml);
    }
    const segments = Array.isArray(c.promptSegments)
      ? c.promptSegments.filter((s) => typeof s === 'string' && s.trim().length > 0)
      : [];
    if (segments.length > 0) parts.push('# 附加提示词片段\n' + segments.join('\n\n'));
    parts.push('# 交付格式\n把完整的单文件 HTML 放在一个 ' + FENCE + 'html 代码块里返回，不要附加其它代码块。');
    // 有追加轮次时明确要求给完整新版：V1 不做"只给差异片段再合并"那套
    if (history.length > 0) {
      parts.push('# 输出方式\n直接给出修改后的**完整**单文件 HTML，不要只给差异片段，也不要解释你改了什么。');
    }
    const userText = parts.join('\n\n');
    const system = c.systemPrompt && String(c.systemPrompt).trim().length > 0 ? String(c.systemPrompt) : undefined;
    return {
      provider: c.provider,
      model: c.model,
      system,
      userText,
      history,
      roundNote: roundNote || null,
      temperature: typeof c.temperature === 'number' ? c.temperature : undefined,
      maxTokens: typeof c.maxTokens === 'number' ? c.maxTokens : undefined,
      reasoningEffort: c.reasoningEffort ?? undefined,
      compilerVersion: MESSAGE_COMPILER_VERSION,
    };
  });
}

/** 全部候选都跑完就把实验状态收尾。 */
function finalizeExperiment(runtime, experimentId) {
  const attempts = runtime.store.listAttempts(experimentId);
  const latestBySlot = new Map();
  for (const a of attempts) latestBySlot.set(a.candidateSlot, a);
  const latest = [...latestBySlot.values()];
  if (latest.length === 0) return;
  if (latest.some((a) => runtime.runs.has(a.id))) return;
  runtime.store.setExperimentStatus(experimentId, 'completed');
}

function summarizeExperiment(runtime, e) {
  const attempts = runtime.store.listAttempts(e.id);
  const latestBySlot = new Map();
  for (const a of attempts) latestBySlot.set(a.candidateSlot, a);
  const latest = [...latestBySlot.values()];
  const succeeded = latest.filter((a) => a.status === 'completed').length;
  const failed = latest.filter((a) => ['failed', 'cancelled', 'timed_out', 'interrupted'].includes(a.status)).length;
  const withHtml = latest.filter((a) => a.artifact?.htmlHash).length;
  const vote = runtime.store.getVote(e.id);
  return {
    id: e.id, title: e.title, category: e.category, status: e.status,
    createdAt: e.createdAt, updatedAt: e.updatedAt,
    candidateCount: latest.length,
    succeeded, failed, withHtml,
    vote: vote ? { choice: vote.choice, revealed: vote.revealedAt !== null } : null,
  };
}

function describeAttempt(runtime, a) {
  const extraction = a.artifact ? {
    status: a.artifact.extractionStatus,
    mode: a.artifact.extractionMode,
    warnings: a.artifact.extractionWarnings ?? [],
    range: a.artifact.extractionRange,
    version: a.artifact.extractionVersion,
    htmlHash: a.artifact.htmlHash,
    rawTextHash: a.artifact.rawTextHash,
    bytes: a.artifact.bytes,
  } : null;
  const error = a.receipt?.errorCode ? explainError({
    code: a.receipt.errorCode, message: a.receipt.errorMessage, status: a.receipt.errorStatus,
  }) : null;
  return {
    id: a.id, slot: a.candidateSlot, attemptNo: a.attemptNo, status: a.status,
    recipe: a.recipeSnapshot, resolved: a.resolvedConfig, requested: a.requestedConfig,
    parentAttemptId: a.parentAttemptId,
    createdAt: a.createdAt, updatedAt: a.updatedAt,
    receipt: a.receipt,
    extraction,
    error,
    canPreview: Boolean(a.artifact?.htmlHash),
    running: runtime.runs.has(a.id),
  };
}

/** 揭晓前不返回模型身份（F17：隐藏配置身份，不承诺严格双盲）。 */
function publicVote(vote, attempts) {
  const revealed = vote.revealedAt !== null;
  const byId = new Map(attempts.map((a) => [a.id, a]));
  const mapping = {};
  for (const [anon, attemptId] of Object.entries(vote.anonymousMapping)) {
    const a = byId.get(attemptId);
    mapping[anon] = {
      attemptId,
      revealed: revealed ? {
        provider: a?.recipeSnapshot?.provider ?? null,
        model: a?.recipeSnapshot?.model ?? null,
        name: a?.recipeSnapshot?.name ?? null,
      } : null,
      htmlHash: a?.artifact?.htmlHash ?? null,
    };
  }
  return { choice: vote.choice, tags: vote.tags, note: vote.note, createdAt: vote.createdAt, revealed: vote.revealedAt, mapping };
}

/**
 * 从运行环境探测 DSH 版本，探测不到就是 null（不伪造）。
 * 注意：本文件是 ESM，不能用 require()——那样会静默失败并永远返回 null。
 */
function detectDshVersion() {
  try {
    const candidates = [];
    if (process.env.APPDATA) {
      candidates.push(join(process.env.APPDATA, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'));
    }
    if (process.env.USERPROFILE) {
      candidates.push(join(process.env.USERPROFILE, 'AppData', 'Roaming', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'));
    }
    // 与插件被一起安装的场景
    candidates.push(join(process.cwd(), 'node_modules', '@deepseek-ai', 'dsh', 'package.json'));
    for (const c of candidates) {
      if (existsSync(c)) {
        const version = JSON.parse(readFileSync(c, 'utf8')).version;
        if (typeof version === 'string' && version.length > 0) return version;
      }
    }
  } catch { /* 探测不到就返回 null */ }
  return null;
}

/** 界面外壳：完整 SPA 由 web/ 目录提供，这里只做最小可用的入口页。 */
function uiPage() {
  return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>HTML Arena</title></head>'
    + '<body><p>HTML Arena 界面资源未加载。请通过 DSH 的 HTML 对比入口打开。</p></body></html>';
}
