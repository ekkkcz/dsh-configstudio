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
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { newId, newToken } from './core/store.js';
import { extractHtmlFromCandidate } from './core/extract.js';
import { explainError, listModelCatalog, resolveCandidateConfig } from './core/runner.js';
import { buildCsp, CDN_ALLOWLIST, NETWORK_POLICIES, VIEWPORTS, sandboxAttribute, validateCdnOrigins } from './preview/policy.js';
import { createUiRouter } from './ui.js';
import { baseUrlFromRequest, detectOptimizer, optimizePrompt, OPTIMIZER_TIERS, OPTIMIZER_PATH } from './core/optimizer.js';
import { CAPABILITIES, capabilityEnabled } from './core/settings.js';
import { RECIPE_FIELDS, normalizeRecipeContent } from './core/recipe.js';
import { taskHashOf, normalizeTaskSnapshot } from './core/task.js';
import { normalizeUsage } from './core/usage.js';
import { readZip, writeZip, ZipError } from './core/zip.js';
import {
  PACK_UPLOAD_MAX_BYTES, describeExport, slotLetter,
  buildRetestPack, buildShowcasePack, normalizeExportOptions, parseRetestPack,
} from './core/pack.js';
import { sha256 } from './core/canonical.js';

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const LIMITS = { promptMaxChars: 50000, startHtmlMaxBytes: 2 * 1024 * 1024 };

/** 历史列表的评价筛选取值（界面与接口共用一份，避免两处各写一遍）。 */
const VOTE_FILTERS = Object.freeze([
  { key: '', label: '全部评价' },
  { key: 'any', label: '已评价' },
  { key: 'none', label: '未评价' },
  { key: 'revealed', label: '已揭晓' },
  { key: 'unrevealed', label: '未揭晓' },
  { key: 'A', label: '偏好 A' },
  { key: 'B', label: '偏好 B' },
  { key: 'C', label: '偏好 C' },
  { key: 'D', label: '偏好 D' },
  { key: 'tie', label: '平局' },
  { key: 'undecided', label: '无法判断' },
]);

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
        : '检测到本机装有 ' + CAPABILITIES[0].source + '，但尚未启用 —— 是否使用另一个插件的能力由你决定，可在「设置」里打开。',
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

      // ── 配方对象与版本（F19 / A03：每次修改生成版本，历史配方不被覆盖） ──────
      //
      // 设计要点：配方是**独立对象**，实验只是引用它的某一版；而 attempt 里存的是
      // 那一版的**快照**。所以"配方后来改了"永远不会改写历史实验。
      if (path === '/recipes' && method === 'GET') {
        const search = url.searchParams.get('search') ?? undefined;
        const full = url.searchParams.get('full') === '1';
        const list = runtime.store.listRecipes({ search });
        return json(res, 200, {
          // full=1 时带上每个配方的全部版本（界面要在一页里展示版本历史）
          recipes: full ? list.map((r) => runtime.store.getRecipe(r.id)) : list,
          note: '配方是独立对象，不随实验一起删除。每次修改都会追加一个新版本，历史版本不会被覆盖。',
        });
      }

      if (path === '/recipes' && method === 'POST') {
        const body = await readJson(req);
        const snapshot = recipeSnapshotFromBody(runtime, body);
        if (!snapshot.ok) return json(res, 400, { error: snapshot.error });
        const name = String(body.name ?? '').trim() || snapshot.content.name || '未命名配方';
        const note = typeof body.note === 'string' ? body.note : null;
        const created = runtime.store.createRecipe({ name, note, snapshot: snapshot.content, source: snapshot.source });
        return json(res, 201, {
          recipe: created,
          version: 1,
          unchanged: false,
          note: '已保存为配方第 1 版。以后每次修改都会追加新版本，这一版不会被覆盖。',
        });
      }

      const recipeMatch = /^\/recipes\/([^/]+)(\/.*)?$/.exec(path);
      if (recipeMatch) {
        const recipeId = decodeURIComponent(recipeMatch[1]);
        const rest = recipeMatch[2] ?? '';
        const recipe = runtime.store.getRecipe(recipeId);
        if (!recipe) return json(res, 404, { error: '找不到这个配方' });

        if (rest === '' && method === 'GET') {
          return json(res, 200, {
            recipe,
            note: 'versions 里每一版都带 content_hash 与保存时间；历史版本只读。',
          });
        }

        // 追加新版本。**不会覆盖任何已有版本**；内容与当前版完全一致时不新增版本（如实回报 unchanged）。
        if ((rest === '/versions' || rest === '') && method === 'POST') {
          const body = await readJson(req);
          const snapshot = recipeSnapshotFromBody(runtime, body);
          if (!snapshot.ok) return json(res, 400, { error: snapshot.error });
          const r = runtime.store.addRecipeVersion(recipeId, {
            snapshot: snapshot.content,
            note: typeof body.note === 'string' ? body.note : null,
            source: snapshot.source,
          });
          if (!r.ok) return json(res, 400, { error: r.reason });
          return json(res, r.unchanged ? 200 : 201, {
            ...r,
            note: r.unchanged
              ? '内容与第 ' + r.version + ' 版完全相同，没有生成新版本。'
              : '已追加为第 ' + r.version + ' 版；第 1–' + (r.version - 1) + ' 版仍然保留，随时可回看。',
          });
        }

        if (rest === '' && method === 'PATCH') {
          const body = await readJson(req);
          const r = runtime.store.updateRecipeMeta(recipeId, { name: body.name, note: body.note });
          if (!r.ok) return json(res, 400, { error: r.reason });
          return json(res, 200, { recipe: r.recipe, note: '只改了名称/说明，没有产生新版本（版本记录的是调用配置）。' });
        }

        if (rest === '' && method === 'DELETE') {
          const r = runtime.store.deleteRecipe(recipeId);
          if (!r.ok) return json(res, 400, { error: r.reason });
          return json(res, 200, { deleted: true, note: '只是移除这个配方对象；历史实验里存的是快照，不受影响。' });
        }
      }

      if (path === '/experiments' && method === 'GET') {
        const search = url.searchParams.get('search') ?? undefined;
        const category = url.searchParams.get('category') ?? undefined;
        // 评价筛选（M3 历史搜索）：any / none / revealed / unrevealed / A / B / tie / undecided
        const vote = url.searchParams.get('vote') ?? undefined;
        const list = runtime.store.listExperiments({ search, category, vote });
        return json(res, 200, {
          experiments: list.map((e) => summarizeExperiment(runtime, e)),
          filters: { search: search ?? null, category: category ?? null, vote: vote ?? null },
          voteFilters: VOTE_FILTERS,
        });
      }

      // 无状态请求预览：不创建实验，因此不会污染实验列表。
      if (path === '/preview-request' && method === 'POST') {
        const body = await readJson(req);
        const validation = validateExperimentInput(body.task ?? {});
        if (!validation.ok) return json(res, 400, { error: validation.error, field: validation.field });
        const taskSnapshot = normalizeTaskSnapshot(body.task ?? {});
        const taskHash = await taskHashOf(taskSnapshot);
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
          ...normalizeTaskSnapshot(body),
          createdAt: Date.now(),
        };
        const taskHash = await taskHashOf(taskSnapshot);
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
            // 截图记录（含失败）：刷新页面后仍然看得到"上次截图为什么没成"（A23）
            screenshots: runtime.store.listScreenshots(id, 20),
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
          // 顺序很重要：**先把配方引用解析成"这一轮真正要用的配置"，再拿它核对模型能力**。
          // 反过来的话，只带 recipeId + recipeVersion 的候选（导入复测包后的典型用法）
          // 在解析前根本没有 provider / model，会被误判成"没有选定模型"（实测踩过，
          // 由 tests/packs.api.test.js 的"导入后接着跑"抓出来）。
          const effective = [];
          const links = [];
          for (let i = 0; i < candidates.length; i += 1) {
            const r = resolveCandidateRecipe(runtime, candidates[i]);
            if (!r.ok) return json(res, 400, { error: '候选 ' + (i + 1) + '：' + r.error });
            effective.push(r.candidate);
            links.push(r.link);
          }

          const problems = [];
          const resolvedList = [];
          for (let i = 0; i < effective.length; i += 1) {
            const c = effective[i];
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
          const compiled = buildCompiledMessages(exp, effective);
          const created = [];
          for (let i = 0; i < effective.length; i += 1) {
            const c = effective[i];
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
              recipeId: links[i]?.recipeId ?? null,
              recipeVersion: links[i]?.recipeVersion ?? null,
            });
            created.push({ attemptId, slot: i });
          }

          for (let i = 0; i < created.length; i += 1) {
            const { attemptId } = created[i];
            void (async () => {
              await gate.acquire();
              try {
                // 运行上限来自本实验的输出规则（A08）：到点由 runtime 尽力中止并记成超时
                await runtime.runCandidate({ experimentId: id, attemptId, compiled: compiled[i], timeoutMs: exp.outputPolicy.timeoutMs });
              } finally {
                gate.release();
                finalizeExperiment(runtime, id);
              }
            })();
          }
          return json(res, 202, {
            started: created,
            concurrency: gate.limit,
            timeoutMs: exp.outputPolicy.timeoutMs ?? null,
            recipeLinks: links,
          });
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

        const dlMatch = /^\/attempts\/([^/]+)\/(raw|html|partial)$/.exec(rest);
        if (dlMatch && method === 'GET') {
          const attemptId = decodeURIComponent(dlMatch[1]);
          const kind = dlMatch[2];
          if (!runtime.store.getAttempt(attemptId)) return json(res, 404, { error: '找不到这个候选' });
          try {
            const text = kind === 'raw' ? runtime.store.readRaw(attemptId)
              : kind === 'html' ? runtime.store.readHtml(attemptId)
                : runtime.store.readPartial(attemptId);
            res.writeHead(200, {
              'Content-Type': kind === 'html' ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8',
              'Content-Disposition': 'attachment; filename="' + attemptId
                + (kind === 'html' ? '.html' : (kind === 'partial' ? '.partial.txt' : '.txt')) + '"',
              'Cache-Control': 'no-store',
            });
            return res.end(text);
          } catch {
            return json(res, 404, {
              error: kind === 'html' ? '这个候选没有可下载的 HTML（未被识别为作品）'
                : kind === 'partial' ? '这次尝试没有留下部分输出（它可能还没来得及产出正文，或者已经正常跑完）'
                  : '找不到原始输出',
            });
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
              problems.push('候选 ' + slotLetter(slot) + ' 还在生成中，等它结束再追加轮次');
              continue;
            }
            let raw = '';
            try { if (prev.artifact?.rawTextHash) raw = runtime.store.readRaw(prev.id); } catch { raw = ''; }
            if (raw.trim().length === 0) {
              problems.push('候选 ' + slotLetter(slot) + ' 上一轮没有产出正文（'
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
              try { await runtime.runCandidate({ experimentId: id, attemptId: c.attemptId, compiled: c.compiled, timeoutMs: exp.outputPolicy.timeoutMs }); }
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
            try { await runtime.runCandidate({ experimentId: id, attemptId: newAttemptId, compiled, timeoutMs: exp.outputPolicy.timeoutMs }); }
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
          // 采集与落盘只有一份实现（captureShot）：展示包导出用的是**同一个**函数，
          // 所以"截图标注了视口 / DPR / 等待时间 / 网络策略"这两条路径不会漂移。
          const { result, saved, viewport } = await captureShot(runtime, {
            experiment: exp, attemptId, viewportName, source: 'compare-page',
          });

          return json(res, 200, {
            id: saved.id,
            recordedAt: saved.createdAt,
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

        // ── 导出展示包 / 复测包（F20 / F21 / F22） ──────────────────────
        //
        // 三条原则：
        //  ① 导出**前**先给"包含什么"的清单，用户确认后才下载（F22）；
        //  ② 导出的字符串统一过脱敏（A27），包里永远没有绝对路径与凭据；
        //  ③ 展示包里的截图是**导出时重新加载作品采集**的初始状态，与 F16 同一套语义。
        if (rest === '/export/preview' && method === 'POST') {
          const body = await readJson(req).catch(() => ({}));
          const kind = body.kind === 'retest' ? 'retest' : 'showcase';
          const options = normalizeExportOptions(body.options ?? body);
          const attempts = latestAttempts(runtime, id);
          const described = describeExport({ kind, experiment: exp, attempts, vote: runtime.store.getVote(id), options });
          return json(res, 200, {
            ...described,
            experimentId: id,
            title: exp.title,
            candidateCount: attempts.length,
            withWorkCount: attempts.filter((a) => a.extraction?.htmlHash).length,
            taskHash: await taskHashOf(exp.taskSnapshot),
            browser: (await runtime.probeBrowser()).available,
            note: '这是导出前的清单：确认包含内容后再下载。导出只写本地文件，不会上传到任何地方。',
          });
        }

        if (rest === '/export/retest' && method === 'GET') {
          const options = normalizeExportOptions(optionsFromQuery(url));
          const built = await buildRetestPack({
            experiment: exp, attempts: latestAttempts(runtime, id), options, tool: TOOL_INFO,
            now: new Date().toISOString(),
          });
          return sendZip(res, writeZip(built.entries), 'retest', exp);
        }

        if (rest === '/export/showcase' && method === 'GET') {
          const options = normalizeExportOptions(optionsFromQuery(url));
          const attempts = latestAttempts(runtime, id);
          const viewportName = exp.previewPolicy?.viewport === 'mobile' ? 'mobile' : 'desktop';
          const shots = [];
          const shotNotes = [];
          if (options.screenshots) {
            for (const a of attempts) {
              if (!a.extraction?.htmlHash) continue;
              const cap = await captureShot(runtime, { experiment: exp, attemptId: a.id, viewportName, source: 'export' });
              const letter = slotLetter(a.slot);
              if (cap.result?.status === 'ok' && cap.result.screenshotBase64) {
                shots.push({
                  file: 'shots/' + letter.toLowerCase() + '-' + viewportName + '.png',
                  data: Buffer.from(cap.result.screenshotBase64, 'base64'),
                  viewport: viewportName,
                  caption: letter + ' · ' + cap.viewport.label + ' · DPR ' + (cap.result.dpr ?? 1)
                    + ' · 等待 ' + (cap.result.durationMs ?? cap.elapsedMs) + 'ms'
                    + ' · 网络策略 ' + exp.previewPolicy.networkPolicy
                    + ' · 初始状态（重新加载后未做任何交互）',
                  meta: {
                    attemptId: a.id, viewport: viewportName, dpr: cap.result.dpr ?? 1,
                    waitUntil: cap.result.waitUntil ?? 'load', durationMs: cap.result.durationMs ?? null,
                    networkPolicy: exp.previewPolicy.networkPolicy, capturedFor: 'showcase-pack',
                  },
                });
              } else {
                shotNotes.push(letter + '：' + (cap.result?.reason || cap.result?.error || '截图未成功')
                  + '（记录已落盘，包里不含这张图）');
              }
            }
          }
          const vote = runtime.store.getVote(id);
          const built = await buildShowcasePack({
            experiment: exp, attempts, shots, options, tool: TOOL_INFO, now: new Date().toISOString(),
            screenshotRecords: runtime.store.listScreenshots(id, 20),
            vote: vote ? {
              ...vote,
              choiceLabel: voteLabelOf(vote.choice),
              mappingText: vote.revealedAt !== null
                ? Object.entries(vote.anonymousMapping)
                  .map(([anon, attemptId]) => {
                    const a = attempts.find((x) => x.id === attemptId);
                    return anon + ' = ' + (a ? (a.recipe.provider + ' / ' + a.recipe.model) : attemptId);
                  }).join('\n')
                : null,
            } : null,
            readHtml: (attemptId) => runtime.store.readHtml(attemptId),
            readRaw: (attemptId) => runtime.store.readRaw(attemptId),
          });
          const buf = writeZip(built.entries);
          if (shotNotes.length > 0) res.setHeader('X-Arena-Shot-Notes', encodeURIComponent(shotNotes.join(' | ')).slice(0, 900));
          return sendZip(res, buf, 'showcase', exp);
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
          slots.forEach((a, i) => { mapping[slotLetter(i)] = a.id; });
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

      // ── 复测包：检视与导入（F21 / F22 / A25 / A26 / A27） ───────────────
      //
      // 检视（dry-run）与导入**走同一条分析路径**：解析 → 逐条校验 sha256 → 本机模型匹配。
      // 区别只有最后写不写库。这样"界面上看到的"与"真正导入的"不可能不一致。
      if ((path === '/packs/inspect' || path === '/packs/import') && method === 'POST') {
        let analyzed;
        let buf;
        try {
          // 读体也要在同一段保护里：声明的 Content-Length 超限时 readBinary 会抛 ZipError，
          // 那属于"这个上传不合规"（400），不是插件内部错误（500）—— 实测由
          // scripts/m3-export-import-check.mjs 的"超大上传"那条断言抓出来过。
          buf = await readBinary(req, PACK_UPLOAD_MAX_BYTES);
          if (buf.length === 0) return json(res, 400, { error: '没有收到包内容' });
          analyzed = await analyzePack(runtime, buf);
        } catch (err) {
          if (err instanceof ZipError) {
            return json(res, 400, {
              error: err.message, code: err.code,
              hint: '导入被拒绝。插件不会执行包里的任何东西，也没有在本机写入任何文件。',
            });
          }
          throw err;
        }
        const packHash = sha256(buf);
        const previousImport = runtime.store.findPackImportByHash(packHash);
        if (path === '/packs/inspect') {
          return json(res, 200, {
            ok: true, dryRun: true, packHash,
            ...analyzed.view,
            previousImport,
            note: '这只是检视：还没有写入任何东西，也没有发起任何模型调用。确认后再点导入。',
          });
        }

        // 真导入：把题目与配方**落到本机**（配方是独立对象，跨安装复用），
        // 但**不发起任何调用**（F21）—— 要不要跑、跑哪个模型由用户决定。
        const parsedSanitized = analyzed.parsed.sanitized;
        // 三步写库放在**一个事务**里：中间失败不会留下"半成品实验 + 半套配方"（实测过）。
        const { imported, links } = runtime.store.transact(() => {
          const exp = runtime.store.createExperiment({
            title: parsedSanitized.title + '（导入）',
            category: parsedSanitized.category,
            taskSnapshot: { ...analyzed.parsed.task, createdAt: Date.now() },
            taskHash: analyzed.parsed.summary.taskHash,
            // 输出 / 预览规则用**钳制后**的值；包里写了不合理数字时回落本机默认（并在 warnings 里说明）
            outputPolicy: {
              maxTokens: parsedSanitized.outputPolicy.maxTokens ?? runtime.config.defaultMaxTokens,
              timeoutMs: parsedSanitized.outputPolicy.timeoutMs ?? runtime.config.defaultTimeoutMs,
              concurrency: parsedSanitized.outputPolicy.concurrency ?? runtime.config.defaultConcurrency,
            },
            previewPolicy: parsedSanitized.previewPolicy,
          });
          const created = [];
          for (const c of analyzed.parsed.recipes.candidates ?? []) {
            const recipe = runtime.store.createRecipe({
              name: c.name || ('候选 ' + c.letter),
              note: '从复测包导入（来源实验：' + analyzed.parsed.summary.title + '）',
              snapshot: c.recipe,
              source: 'pack-import',
            });
            created.push({
              slot: c.slot, letter: c.letter, recipeId: recipe.id, recipeVersion: 1,
              contentHash: recipe.versions[0].contentHash, recipeName: recipe.name,
              provider: c.recipe.provider, model: c.recipe.model,
              // 把配方内容一起回给界面：导入后要立刻把候选卡填好，少发 N 个请求，
              // 也保证"界面上看到的"就是刚落库的那一份。
              recipe: c.recipe,
            });
          }
          runtime.store.recordPackImport({
            experimentId: exp.id,
            kind: 'retest',
            schemaVersion: analyzed.parsed.summary.schemaVersion,
            packHash,
            sourceTitle: analyzed.parsed.summary.title,
            candidates: created.map((l) => ({ slot: l.slot, provider: l.provider, model: l.model, contentHash: l.contentHash })),
            matches: analyzed.matches,
          });
          return { imported: exp, links: created };
        });
        return json(res, 201, {
          imported: true,
          experimentId: imported.id,
          taskHash: analyzed.parsed.summary.taskHash,
          packHash,
          experiment: summarizeExperiment(runtime, imported),
          links,
          matches: analyzed.matches,
          warnings: analyzed.view.warnings,
          summary: analyzed.view.summary,
          previousImport,
          started: [],
          note: '导入完成：题目与配方已落到本机，没有发起任何模型调用。'
            + '接下来请确认每个候选的模型（导入的模型引用在这台机器上不一定存在），再点开始生成。',
        });
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

// ── M3：导出 / 导入用的辅助 ────────────────────────────────────────────

/** 包里的工具标识（展示包报告与复测包清单都要写"谁生成的、哪一版"）。 */
export const TOOL_INFO = Object.freeze({ name: 'HTML Arena', version: readPluginVersion() });

function readPluginVersion() {
  try {
    return JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')).version || 'unknown';
  } catch { return 'unknown'; }
}

/** 每个候选**最新一轮**的尝试（导出、收尾、摘要都用这一个口径，不各写一遍）。 */
function latestAttempts(runtime, experimentId) {
  const all = runtime.store.listAttempts(experimentId);
  const bySlot = new Map();
  for (const a of all) bySlot.set(a.candidateSlot, a);   // listAttempts 按 slot, attemptNo 升序
  return [...bySlot.values()]
    .sort((x, y) => x.candidateSlot - y.candidateSlot)
    .map((a) => describeAttempt(runtime, a));
}

/** 查询串 → 导出选项（?prompt=0&rawOutput=1…）。没写的键用默认值。 */
function optionsFromQuery(url) {
  const out = {};
  for (const key of ['prompt', 'startHtml', 'outputRequirements', 'recipes', 'rawOutput', 'screenshots', 'screenshotRecords']) {
    const v = url.searchParams.get(key);
    if (v !== null) out[key] = v !== '0' && v !== 'false';
  }
  return out;
}

/** 以附件形式回一个 ZIP。文件名只用 ASCII，避免各平台对非 ASCII 头部的处理差异。 */
function sendZip(res, buf, kind, exp) {
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '');
  const name = 'html-arena-' + kind + '-' + stamp + '-' + String(exp.id).replace(/[^A-Za-z0-9_-]/g, '') + '.zip';
  res.writeHead(200, {
    'Content-Type': 'application/zip',
    'Content-Disposition': 'attachment; filename="' + name + '"',
    'Content-Length': buf.length,
    'Cache-Control': 'no-store',
  });
  res.end(buf);
}

function voteLabelOf(choice) {
  if (choice === 'tie') return '平局';
  if (choice === 'undecided') return '无法判断';
  return '偏好 ' + choice;
}

/** 读原始二进制请求体（上传 ZIP）。超限立刻拒绝，不先读进内存。 */
async function readBinary(req, maxBytes) {
  const declared = Number(req.headers['content-length'] ?? 0);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new ZipError('too-large', '上传内容超过 ' + Math.round(maxBytes / 1024 / 1024) + 'MB 上限（声明 ' + declared + ' 字节）');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new ZipError('too-large', '上传内容超过 ' + Math.round(maxBytes / 1024 / 1024) + 'MB 上限');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * 采集一次初始截图并落一条记录 —— **界面按钮与展示包导出共用这一份**。
 *
 * 以前这段逻辑只写在截图接口里；展示包也要截图，如果各写一份，
 * "标注了视口 / DPR / 等待时间 / 网络策略"迟早只在其中一条路径上成立（A23 要的正是这个标注）。
 */
async function captureShot(runtime, { experiment, attemptId, viewportName, source }) {
  const viewport = VIEWPORTS[viewportName] ?? VIEWPORTS.desktop;
  const runToken = newToken();
  const targetUrl = runtime.previewOrigin + '/preview/' + attemptId + '?token=' + runToken
    + '&network=' + encodeURIComponent(experiment.previewPolicy?.networkPolicy ?? 'offline');
  const { capturePreviewInSubprocess } = await import('./preview/browser.js');
  // 记一个墙钟耗时：子进程被硬杀时结果体里没有 durationMs（进程没机会写），
  // 但"这次截图一共花了多久"是失败记录里最该有的信息之一，不能因此变成 null。
  const startedAt = Date.now();
  const result = await capturePreviewInSubprocess({ url: targetUrl, viewport, dpr: 1, timeoutMs: 10000, screenshot: true });
  const elapsedMs = Date.now() - startedAt;
  // A23：成功与失败都写一条（视口 / 状态 / 原因 / 耗时 / 页面诊断计数），但**不写图片本身**。
  const saved = runtime.store.recordScreenshot({
    experimentId: experiment.id,
    attemptId,
    viewport: viewportName,
    status: String(result.status ?? 'unknown'),
    reason: result.reason ?? result.error ?? result.navigationError ?? null,
    durationMs: result.durationMs ?? elapsedMs,
    detail: {
      waitUntil: result.waitUntil ?? 'load',
      networkPolicy: experiment.previewPolicy?.networkPolicy ?? 'offline',
      dpr: result.dpr ?? 1,
      pageErrors: (result.pageErrors ?? []).length,
      consoleMessages: (result.consoleMessages ?? []).length,
      failedRequests: (result.failedRequests ?? []).length,
      hardTimeoutMs: result.hardTimeoutMs ?? null,
      source: source ?? 'compare-page',
    },
  });
  return { result, saved, elapsedMs, viewport, targetUrl };
}

/**
 * 解析 + 校验一个复测包，并算出"本机有没有对应的模型"。
 * 检视与导入共用这一条路径 —— 界面上看到的就是导入时会发生的。
 */
async function analyzePack(runtime, buf) {
  // 先按通用规则读出来（会拒绝可执行载荷 / 路径穿越 / 压缩炸弹），
  // 再由 parseRetestPack 判断"这是不是复测包、该有哪些文件" —— 这样展示包能得到
  // 一句人话（"这是展示包，双击 index.html 就行"），而不是一个文件类型报错。
  const zip = readZip(buf);
  const parsed = await parseRetestPack(zip);
  const matches = await matchImportedCandidates(runtime, parsed.recipes.candidates ?? []);
  const unmatched = matches.filter((m) => m.status !== 'matched');
  const warnings = [...parsed.warnings];
  if (unmatched.length > 0) {
    warnings.push('有 ' + unmatched.length + ' 个候选的模型在这台机器上不存在（或来源不在目录里）：'
      + unmatched.map((m) => m.letter + ' ' + m.provider + '/' + m.model).join('、')
      + '。导入后需要重新选模型，插件不会替你猜一个顶上。');
  }
  return {
    zip, parsed, matches,
    view: {
      kind: 'retest',
      schemaVersion: parsed.summary.schemaVersion,
      createdAt: parsed.summary.createdAt,
      tool: parsed.summary.tool,
      summary: parsed.summary,
      matches,
      needRemap: unmatched.length > 0,
      unmatchedCount: unmatched.length,
      entryCount: zip.entries.length,
      entries: zip.entries.map((e2) => ({ path: e2.name, bytes: e2.size })),
      zipStats: zip.stats,
      warnings,
      willCreate: {
        experiment: 1,
        recipes: (parsed.recipes.candidates ?? []).length,
        modelCalls: 0,
      },
      note: '不会自动执行：包里只有题目与配方，导入不会发起任何模型调用，也不会运行包里的任何文件。',
    },
  };
}

/** 逐个候选核对本机模型目录。对不上就如实说"需要在导入后重新匹配"，不做静默替换。 */
async function matchImportedCandidates(runtime, candidates) {
  const base = candidates.map((c) => ({
    slot: c.slot, letter: c.letter ?? slotLetter(Number(c.slot ?? 0)),
    name: c.name ?? null, provider: c.recipe?.provider ?? null, model: c.recipe?.model ?? null,
    recipeHash: c.contentHash ?? null, status: 'unknown', note: null, suggestions: [],
  }));
  const llm = runtime.llmOf();
  if (!llm) {
    return base.map((b) => ({ ...b, status: 'catalog-unavailable', note: '这个 DSH 组合没有提供 llm 服务，无法核对模型；导入后请手动选择。' }));
  }
  let catalog;
  try {
    catalog = await listModelCatalog(llm);
  } catch (err) {
    return base.map((b) => ({ ...b, status: 'catalog-unavailable', note: '读取本机模型目录失败：' + String(err && err.message || err).slice(0, 200) }));
  }
  const providerIds = new Set((catalog.providers ?? []).map((p) => p.id));
  return base.map((b) => {
    if (!b.provider || !b.model) return { ...b, status: 'bad-recipe', note: '这个候选的配方里没有模型引用' };
    if (!providerIds.has(b.provider)) {
      return {
        ...b, status: 'provider-missing',
        note: '本机没有模型来源「' + b.provider + '」',
        suggestions: (catalog.providers ?? []).slice(0, 6).map((p) => ({
          provider: p.id, model: (catalog.modelsByProvider?.[p.id] ?? [])[0]?.id ?? null,
          name: (catalog.modelsByProvider?.[p.id] ?? [])[0]?.name ?? null,
        })).filter((s) => s.model),
      };
    }
    const models = catalog.modelsByProvider?.[b.provider] ?? [];
    const hit = models.find((m) => m.id === b.model);
    if (hit) return { ...b, status: 'matched', note: '本机有这个模型', modelName: hit.name ?? null };
    return {
      ...b, status: 'model-missing',
      note: '来源「' + b.provider + '」在本机没有模型「' + b.model + '」',
      suggestions: models.slice(0, 8).map((m) => ({ provider: b.provider, model: m.id, name: m.name ?? null })),
    };
  });
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

/**
 * 把候选里的配方引用解析成"这一轮真正要用的配置"。
 *
 * 规则（只有一条，避免两处各写一遍）：
 *  - 带 recipeId 时，先取那一版的快照作为基底；版本不存在就直接拒绝，**不拿别的版本顶替**；
 *  - 候选体里明确写了的字段优先 —— 这正是"复制配方后只改提示词"（A03）的用法；
 *  - 返回值里的 link 只用于溯源，配方以后怎么改都不影响这次已经定下来的内容。
 */
function resolveCandidateRecipe(runtime, candidate) {
  const c = candidate ?? {};
  const link = { recipeId: null, recipeVersion: null };
  let base = {};
  if (typeof c.recipeId === 'string' && c.recipeId.length > 0) {
    const version = Number.isInteger(c.recipeVersion) ? c.recipeVersion : null;
    if (version === null) return { ok: false, error: '引用了配方但没有指定版本号（recipeVersion）' };
    const v = runtime.store.getRecipeVersion(c.recipeId, version);
    if (!v) {
      return { ok: false, error: '配方版本不存在（' + c.recipeId + ' 第 ' + version + ' 版）；不会用其它版本顶替，请重新选择' };
    }
    base = v.snapshot;
    link.recipeId = v.recipeId;
    link.recipeVersion = v.version;
  }
  const merged = { ...base };
  for (const f of RECIPE_FIELDS) {
    const v = c[f];
    if (v === undefined || v === null) continue;
    if (f === 'promptSegments' && Array.isArray(v) && v.length === 0) continue;
    merged[f] = v;
  }
  if (!merged.provider || !merged.model) return { ok: false, error: '没有选定模型' };
  if (!merged.name) merged.name = String(merged.model);
  return { ok: true, candidate: merged, link };
}

/**
 * 从请求体里取"配方内容"。
 * 两种来源：直接给 snapshot/config，或给 fromAttemptId（从某一次尝试保存 —— 存的是那一轮的快照）。
 */
function recipeSnapshotFromBody(runtime, body) {
  if (typeof body.fromAttemptId === 'string' && body.fromAttemptId.length > 0) {
    const a = runtime.store.getAttempt(body.fromAttemptId);
    if (!a) return { ok: false, error: '找不到这次尝试，无法从它保存配方' };
    return { ok: true, content: normalizeRecipeContent(a.recipeSnapshot), source: 'attempt:' + a.id };
  }
  const src = body.snapshot ?? body.config ?? null;
  if (!src || typeof src !== 'object') return { ok: false, error: '缺少配方内容（snapshot 或 config）' };
  const content = normalizeRecipeContent(src);
  if (!content.provider || !content.model) return { ok: false, error: '配方至少要包含模型来源与模型' };
  return { ok: true, content, source: typeof body.source === 'string' ? body.source.slice(0, 200) : 'manual' };
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
  // 导入来源（M3）：列表上要能看出"这条是从复测包导进来的"，而不是一条来路不明的记录
  const imported = typeof runtime.store.getPackImport === 'function' ? runtime.store.getPackImport(e.id) : null;
  return {
    id: e.id, title: e.title, category: e.category, status: e.status,
    createdAt: e.createdAt, updatedAt: e.updatedAt,
    candidateCount: latest.length,
    succeeded, failed, withHtml,
    vote: vote ? { choice: vote.choice, revealed: vote.revealedAt !== null } : null,
    importedFrom: imported ? {
      kind: imported.kind, at: imported.importedAt, sourceTitle: imported.sourceTitle,
      schemaVersion: imported.schemaVersion, packHash: imported.packHash,
      unmatchedCount: (imported.matches ?? []).filter((m) => m.status !== 'matched').length,
    } : null,
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
    // 溯源：这一轮是从哪个配方的哪一版复制过来的（不等于"现在那个配方长什么样"）
    recipeLink: a.recipeId ? { recipeId: a.recipeId, recipeVersion: a.recipeVersion } : null,
    parentAttemptId: a.parentAttemptId,
    createdAt: a.createdAt, updatedAt: a.updatedAt,
    // A18：读取侧也过一遍同一套口径（core/usage.js），这样**历史数据与导入包**里
    // 那些"失败调用被适配器填成 0"的旧记录也会显示成"未上报"，而不是只在修复之后
    // 新产生的数据才对。规则只有一份，写入侧与读取侧共用。
    receipt: a.receipt ? { ...a.receipt, usage: normalizeUsage(a.status, a.receipt.usage) } : a.receipt,
    extraction,
    error,
    canPreview: Boolean(a.artifact?.htmlHash),
    // 被硬杀/中断的尝试可能只留下定期落盘的部分输出 —— 界面要能诚实地把它交出来（A09）
    partial: runtime.store.partialInfo(a.id),
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
