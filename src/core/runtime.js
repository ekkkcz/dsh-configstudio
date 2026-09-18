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
import { stableStringify } from './canonical.js';

// 稳定序列化的唯一定义在 canonical.js（配方指纹与这里用的是同一份口径）。
// 这里重新导出，避免历史上引用过 runtime.stableStringify 的地方被破坏。
export { stableStringify };

/** 实时流缓冲每个候选最多保留多少字符（只保留尾部）。界面观察用，不是权威数据。 */
export const LIVE_MAX = 64 * 1024;

/**
 * 生成过程中定期落盘的部分输出（A09）。
 *
 * 为什么需要：宿主被**硬杀**时，进程里的实时缓冲会一起消失，而 raw.txt 要等流结束才写。
 * 实测（M2 的重启回归）：不做这件事的话，"生成到一半被杀"留下的是一条没有任何正文的记录 ——
 * 界面上写着"已保留内容"却什么都下载不到，那就是假的。
 *
 * 所以每 PARTIAL_FLUSH_MS 把最近收到的正文刷到 partial 文件；跑完（无论成功失败）就删掉它，
 * raw.txt 仍是唯一权威的完整正文。上限 PARTIAL_MAX 防止异常巨大的流把磁盘写满。
 */
export const PARTIAL_FLUSH_MS = 1500;
export const PARTIAL_MAX = 256 * 1024;

/** 只保留字符串尾部 max 个字符。 */
export function keepTail(s, max = LIVE_MAX) {
  return s.length > max ? s.slice(s.length - max) : s;
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

    // 运行上限（A08）。到点**尽力中止**这次调用，并把这次尝试记成 timed_out ——
    // 与"用户取消"（cancelled）分开：原因不同、下一步不同。
    // 注意：中止是尽力的，服务端可能仍在产出；那些迟到的内容只会留在**这一次**尝试里，
    // 不会写进新 attempt（每个 attempt 有自己的 controller 与收尾路径）。
    const timeoutMs = Number.isFinite(job.timeoutMs) && job.timeoutMs > 0 ? job.timeoutMs : null;
    let timedOut = false;
    // 运行条目同时是"这一轮现在处于什么状态"的唯一来源：界面靠它显示
    // "已到运行上限，正在尽力中止"，而不是一直显示"生成中"。
    const runEntry = { controller, startedAt: Date.now(), timeoutMs, deadline: timeoutMs === null ? null : Date.now() + timeoutMs, timedOut: false };
    const timeoutTimer = timeoutMs === null ? null : setTimeout(() => {
      timedOut = true;
      runEntry.timedOut = true;
      try { controller.abort(); } catch { /* 已经结束 */ }
    }, timeoutMs);

    runs.set(attemptId, runEntry);
    store.touchExperiment(job.experimentId);

    // 实时流缓冲。runGeneration 一直在发 text-delta / reasoning-delta，
    // 但以前宿主只取了两个时间戳、把正文片段整个丢掉，导致运行面板的"正文流"永远是空的
    //（M1 实测缺陷：state.streams 只被清空和读取，从来没有被写入）。
    const buf = {
      text: '', reasoning: '', truncated: false,
      startedAt: Date.now(), updatedAt: Date.now(), done: false,
    };
    live.set(attemptId, buf);

    // 部分输出的落盘状态：只在有正文、且距上次刷盘够久时才写，避免把磁盘当内存用
    let partialText = '';
    let partialTruncated = false;
    let lastFlushAt = 0;
    // raw 一旦落盘，partial 就不再是"唯一留下的正文"，之后不允许再写它
    let rawCommitted = false;
    const flushPartial = (force) => {
      if (partialText.length === 0) return;
      const now = Date.now();
      if (!force && now - lastFlushAt < PARTIAL_FLUSH_MS) return;
      lastFlushAt = now;
      try { store.writePartial(attemptId, partialText, { truncated: partialTruncated }); } catch { /* 落盘失败不影响生成本身 */ }
    };

    const emit = (event) => {
      // 事件只用于界面观察；状态以 SQLite 为准（页面刷新只恢复展示，不重跑）
      if (event.type === 'first-event') store.stampReceipt(attemptId, 'first_event_at', event.at);
      if (event.type === 'first-text') store.stampReceipt(attemptId, 'first_text_at', event.at);
      if (event.type === 'text-delta' && typeof event.text === 'string') {
        const before = buf.text.length;
        buf.text = keepTail(buf.text + event.text);
        if (before + event.text.length > LIVE_MAX) buf.truncated = true;
        buf.updatedAt = Date.now();
        // 部分输出：只在没到上限时继续累积（超了就只保留前 PARTIAL_MAX 并标记截断）
        if (partialText.length < PARTIAL_MAX) {
          partialText += event.text;
          if (partialText.length > PARTIAL_MAX) { partialText = partialText.slice(0, PARTIAL_MAX); partialTruncated = true; }
        } else {
          partialTruncated = true;
        }
        flushPartial(false);
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

      // 原始正文不可变落盘（F06）。落盘之后 partial 就不再需要 ——
      // 否则同一次尝试会同时存在"完整正文"和"部分输出"两份东西，界面与用户都会困惑。
      const raw = await store.writeRaw(attemptId, result.text ?? '');
      rawCommitted = true;
      try { store.removePartial(attemptId); } catch { /* 清理失败不影响结果 */ }
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

      // 超时优先于调用器自己报的收尾原因：是我们不再等它了，这件事必须如实记下来。
      const outcome = timedOut
        ? {
          status: 'timed_out',
          finishReason: 'timeout',
          errorCode: 'TIMEOUT',
          errorMessage: '超过本轮运行上限 ' + Math.round(timeoutMs / 1000) + ' 秒，已尽力中止这次调用。'
            + '已经收到的正文仍然保存；点重试会新建一次尝试（会重新计费）。',
          errorStatus: null,
        }
        : {
          status: result.status,
          finishReason: result.receipt.finishReason,
          errorCode: result.receipt.error?.code ?? null,
          errorMessage: result.receipt.error?.message ?? null,
          errorStatus: result.receipt.error?.status ?? null,
        };
      store.updateAttemptStatus(attemptId, outcome.status);
      store.finishReceipt(attemptId, {
        finishReason: outcome.finishReason,
        errorCode: outcome.errorCode,
        errorMessage: outcome.errorMessage,
        errorStatus: outcome.errorStatus,
        usage: result.receipt.usage,
        observedRequests: result.receipt.observedRequests,
      });

      // 诊断：推理把预算吃光时，text 很短但 reasoning 很长，界面要能说清这一点。
      // 只在「确实完成、但没有正文」时给出；取消或失败的原因更准确，不能被覆盖
      //（真实调用踩到过：取消后的 attempt 被这条诊断改写成了 EMPTY_RESPONSE）。
      if (!timedOut && result.status === 'completed' && (result.text ?? '').length === 0 && (result.reasoning ?? '').length > 0) {
        store.finishReceipt(attemptId, {
          finishReason: result.receipt.finishReason,
          errorCode: 'EMPTY_RESPONSE',
          errorMessage: '模型把输出预算都用在了推理上，没有产生正文（推理 ' + result.reasoning.length + ' 字符）。'
            + '提高该候选的输出上限，或换一个不输出推理的模型。',
          errorStatus: null, usage: result.receipt.usage, observedRequests: result.receipt.observedRequests,
        });
      }
      return { status: outcome.status, extraction: { status: extraction.status, warnings: extraction.warnings } };
    } catch (err) {
      // 不该发生：runGeneration 已经把 provider 错误转成结果。真发生就如实记录。
      // 这里**不删** partial：异常路径下它可能是唯一留下的正文。
      flushPartial(true);
      store.updateAttemptStatus(attemptId, 'failed');
      store.finishReceipt(attemptId, {
        finishReason: 'thrown', errorCode: 'PLUGIN_ERROR',
        errorMessage: String(err && err.message || err).slice(0, 1000),
        observedRequests: 1,
      });
      return { status: 'failed', error: String(err && err.message || err) };
    } finally {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      // 只有"raw 没能落盘"的路径才补写 partial：它是这种情况下唯一留下的正文
      if (!rawCommitted) flushPartial(true);
      runs.delete(attemptId);
      const l = live.get(attemptId);
      if (l) { l.done = true; l.updatedAt = Date.now(); }
    }
  };
}

/**
 * 启动时的恢复动作（A09）：把上一个进程留下的未完成尝试标成 interrupted。
 *
 * 为什么放在共享层：这件事原先只写在宿主半边（src/index.js）里，
 * 于是"重启后未完成尝试仍标 running"这个缺陷在**零费用的开发服务器上根本复现不出来** ——
 * 与当年"实时流缓冲只有宿主半边有"是完全同一类错误（同一个教训，第二次踩）。
 * 现在两边都调这一个函数；判定与写入在 store.markUnfinishedAsInterrupted()。
 *
 * 只改状态：不新建 attempt、不重新发起调用（不自动重付费）。
 */
export function recoverUnfinishedAttempts(store) {
  try { return store.markUnfinishedAsInterrupted(); } catch { return { count: 0, items: [] }; }
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
    const run = runs.get(a.id) ?? null;
    out.push({
      attemptId: a.id, slot: a.candidateSlot, status: a.status, running: runs.has(a.id),
      // 已过运行上限但流还没收尾时，界面要能如实说"正在尽力中止"，而不是继续显示"生成中"
      timedOut: run?.timedOut === true,
      timeoutMs: run?.timeoutMs ?? null,
      deadline: run?.deadline ?? null,
      done: l.done, truncated: l.truncated,
      textLength: l.text.length, reasoningLength: l.reasoning.length,
      text: l.text, reasoning: l.reasoning,
      startedAt: l.startedAt, updatedAt: l.updatedAt,
    });
  }
  return out;
}
