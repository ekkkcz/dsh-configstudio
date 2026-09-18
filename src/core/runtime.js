/**
 * 生成运行器 —— **宿主半边与开发服务器共用这一份实现**。
 *
 * 为什么单独抽出来（M2 实测踩到的坑）：
 *  `scripts/dev-server.mjs` 以前手抄了一份 runCandidate，结果和 `src/index.js` 漂移了 ——
 *  宿主半边有实时流缓冲（`/live`），开发服务器没有，于是"运行面板的推理过程会被收回"
 *  这个缺陷只能在真实 DSH 上复现，零费用的开发服务器复现不出来。
 *  现在两边都调这里的 `createRunCandidate()`，不会再各自演化。
 *
 * @module html-arena/core/runtime
 */
import { runGeneration } from './runner.js';
import { extractHtml, EXTRACTOR_VERSION } from './extract.js';

/** 实时流缓冲每个候选最多保留多少字符（只保留尾部）。界面观察用，不是权威数据。 */
export const LIVE_MAX = 64 * 1024;

/** 只保留字符串尾部 max 个字符。 */
export function keepTail(s, max = LIVE_MAX) {
  return s.length > max ? s.slice(s.length - max) : s;
}

/**
 * 稳定序列化一个值：对象键排序，避免"同样的内容算出不同指纹"。
 * 用于判断"这一轮请求与上一轮是否真的完全一致"。
 */
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}

/** 从 llm 服务取模型目录，并按对象形状归一（不同适配器用 context / contextWindow 两种写法）。 */
export async function listModelCatalog(llm) {
  const providers = Array.isArray(llm.listProviders()) ? llm.listProviders() : [];
  const modelsByProvider = {};
  for (const p of providers) {
    try {
      const models = await llm.listModels(p.id);
      modelsByProvider[p.id] = Array.isArray(models) ? models : [];
    } catch (err) {
      modelsByProvider[p.id] = [];
      void err; // 单只 provider 的目录失败不影响界面（api 层会照实记录 error）
    }
  }
  return { providers, modelsByProvider };
}

/**
 * 解析候选的完整调用配置（provider / model / 参数 / 可用思考档位）。
 * 解析不到就退回用户填的值，不猜。
 */
export async function resolveCandidateConfig(llm, candidate) {
  const out = {
    provider: candidate.provider,
    model: candidate.model,
    temperature: candidate.temperature,
    maxTokens: candidate.maxTokens,
    reasoningEffort: candidate.reasoningEffort,
    contextWindow: null,
    defaultMaxTokens: null,
    availableReasoningEfforts: null,
    reasoningEffortSupported: null,
    note: null,
  };
  try {
    const info = await llm.resolveModelInfo(candidate.provider, candidate.model);
    const efforts = info?.reasoning?.efforts;
    const ids = Array.isArray(efforts) ? efforts.map((e) => (typeof e === 'string' ? e : e?.id)).filter(Boolean) : null;
    out.availableReasoningEfforts = ids;
    out.contextWindow = Number.isInteger(info?.context?.contextWindow) ? info.context.contextWindow : null;
    out.defaultMaxTokens = Number.isInteger(info?.defaultMaxTokens) ? info.defaultMaxTokens : null;
    if (out.reasoningEffort !== null && out.reasoningEffort !== undefined && ids !== null) {
      out.reasoningEffortSupported = ids.includes(out.reasoningEffort);
    }
  } catch (err) {
    out.note = '无法解析模型信息：' + String(err && err.message || err).slice(0, 300);
  }
  return out;
}

/**
 * 造一个"跑一个候选"的函数。宿主半边与开发服务器都用它，行为完全一致。
 *
 * @param {object} deps
 * @param {object} deps.store      存储层
 * @param {() => object} deps.llmOf 取 llm 服务（每次调用时取，宿主可能晚于插件到达）
 * @param {Map} deps.runs          attemptId -> { controller }
 * @param {Map} deps.live          attemptId -> 实时流缓冲
 * @returns {(job: object) => Promise<object>}
 */
export function createRunCandidate({ store, llmOf, runs, live }) {
  return async function runCandidate(job) {
    const { attemptId, compiled } = job;
    const controller = new AbortController();
    runs.set(attemptId, { controller, startedAt: Date.now() });
    store.touchExperiment(job.experimentId);

    // 实时流缓冲。runGeneration 一直在发 text-delta / reasoning-delta，
    // 但以前宿主只取了两个时间戳、把正文片段整个丢掉，导致运行面板的"正文流"永远是空的
    //（M1 实测缺陷：state.streams 只被清空和读取，从来没有被写入）。
    const buf = {
      text: '', reasoning: '', truncated: false,
      startedAt: Date.now(), updatedAt: Date.now(), done: false,
    };
    live.set(attemptId, buf);

    const emit = (event) => {
      // 事件只用于界面观察；状态以 SQLite 为准（页面刷新只恢复展示，不重跑）
      if (event.type === 'first-event') store.stampReceipt(attemptId, 'first_event_at', event.at);
      if (event.type === 'first-text') store.stampReceipt(attemptId, 'first_text_at', event.at);
      if (event.type === 'text-delta' && typeof event.text === 'string') {
        const before = buf.text.length;
        buf.text = keepTail(buf.text + event.text);
        if (before + event.text.length > LIVE_MAX) buf.truncated = true;
        buf.updatedAt = Date.now();
      }
      if (event.type === 'reasoning-delta' && typeof event.text === 'string') {
        const before = buf.reasoning.length;
        buf.reasoning = keepTail(buf.reasoning + event.text);
        if (before + event.text.length > LIVE_MAX) buf.truncated = true;
        buf.updatedAt = Date.now();
      }
    };

    try {
      store.updateAttemptStatus(attemptId, 'running');
      store.stampReceipt(attemptId, 'started_at', Date.now());

      const result = await runGeneration({
        llm: llmOf(),
        provider: compiled.provider,
        model: compiled.model,
        system: compiled.system,
        content: [{ type: 'text', text: compiled.userText }],
        // 追加轮次（M2 反馈 3）：先前轮次作为上下文；本次仍是一次逻辑请求
        history: Array.isArray(compiled.history) ? compiled.history : [],
        temperature: compiled.temperature,
        maxTokens: compiled.maxTokens,
        reasoningEffort: compiled.reasoningEffort,
        signal: controller.signal,
        onEvent: emit,
      });

      // 原始正文不可变落盘（F06）
      const raw = await store.writeRaw(attemptId, result.text ?? '');
      // F06：推理信息与原始正文分开保存（只存服务实际返回的内容）
      if (result.reasoning && result.reasoning.length > 0) {
        await store.writeReasoning(attemptId, result.reasoning);
      }
      const extraction = extractHtml(result.text ?? '', { finishReason: result.receipt.finishReason });
      let htmlInfo = { hash: null, path: null };
      if (extraction.status === 'ok' && extraction.html !== null) {
        htmlInfo = await store.writeHtml(attemptId, extraction.html);
      }
      store.createArtifact({
        id: attemptId, attemptId,
        rawHash: raw.hash, htmlHash: htmlInfo.hash,
        extractionVersion: EXTRACTOR_VERSION, extractionMode: extraction.mode,
        extractionRange: extraction.range, extractionStatus: extraction.status,
        extractionWarnings: extraction.warnings, rawPath: raw.path, htmlPath: htmlInfo.path,
        bytes: raw.bytes,
      });

      store.updateAttemptStatus(attemptId, result.status);
      store.finishReceipt(attemptId, {
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
        store.finishReceipt(attemptId, {
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
      store.updateAttemptStatus(attemptId, 'failed');
      store.finishReceipt(attemptId, {
        finishReason: 'thrown', errorCode: 'PLUGIN_ERROR',
        errorMessage: String(err && err.message || err).slice(0, 1000),
        observedRequests: 1,
      });
      return { status: 'failed', error: String(err && err.message || err) };
    } finally {
      runs.delete(attemptId);
      const l = live.get(attemptId);
      if (l) { l.done = true; l.updatedAt = Date.now(); }
    }
  };
}

/** 丢掉太久没人看的流缓冲，避免长期运行后内存里堆满历史文本。 */
export function pruneLive(live, maxAgeMs = 30 * 60 * 1000) {
  const now = Date.now();
  for (const [id, l] of live) {
    if (l.done && now - l.updatedAt > maxAgeMs) live.delete(id);
  }
}

/**
 * 某个实验下各候选的实时流快照，供界面在生成过程中观察。
 * 只返回本实验的 attempt，避免跨实验串台；没有缓冲的候选不出现。
 */
export function liveFor(store, live, runs, experimentId) {
  const out = [];
  let attempts = [];
  try { attempts = store.listAttempts(experimentId); } catch { return out; }
  for (const a of attempts) {
    const l = live.get(a.id);
    if (!l) continue;
    out.push({
      attemptId: a.id, slot: a.candidateSlot, status: a.status, running: runs.has(a.id),
      done: l.done, truncated: l.truncated,
      textLength: l.text.length, reasoningLength: l.reasoning.length,
      text: l.text, reasoning: l.reasoning,
      startedAt: l.startedAt, updatedAt: l.updatedAt,
    });
  }
  return out;
}
