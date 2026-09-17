/**
 * 模型调用执行器 —— 一次逻辑生成请求 = 一次 ctx.llm.stream()。
 *
 * 关键契约（依据 DSH 0.1.6-alpha.2 源码核查，见 docs/dsh-integration.md）：
 *  - F02 单次逻辑请求：直接调 ctx.llm.stream()，不经过 agent loop，不发 tools 字段。
 *  - 不传 tools（连 [] 都不传）：Messages 协议下传 [] 会写出空 tools 数组。
 *  - 不传 sessionId / purpose：纯辅助调用，避免进入其它插件中间件的匹配面。
 *  - 重试策略：插件直调**不会**被 llm-retry 自动重试（它只监听 agent/request-error）。
 *    因此"逻辑请求数 = 网络请求数"，这是 F02 想要的；重试必须由我们显式新建 attempt。
 *  - 取消：用 AbortSignal，不要 break 出 for await（那样流里没有终态 finish）。取消得到
 *    finish{kind:'aborted', failure.code:'ABORTED'}，不会抛异常。
 *  - 错误：provider 错误（401/429/500/无凭据/无适配器）都以 finish{kind:'error'} 到达，
 *    不抛异常。只写 try/catch 会漏掉全部 provider 错误，必须读 finish。
 *  - 凭据：插件不读密钥。只给 provider + model，适配器自己解析凭据引用（F01）。
 *
 * 本模块不 import DSH 包：只用 ctx.llm 的运行时对象，因此 DSH 版本变化时
 * 最多是不可用，而不是加载期崩溃。
 *
 * @module html-arena/core/runner
 */

/** 从任意错误值里安全取字段，不解析 message 文本。 */
function pickFailure(value) {
  if (!value || typeof value !== 'object') return null;
  const out = {};
  if (typeof value.code === 'string') out.code = value.code;
  if (typeof value.message === 'string') out.message = value.message.slice(0, 1000);
  if (Number.isInteger(value.status)) out.status = value.status;
  if (typeof value.requestId === 'string' && value.requestId.length > 0) out.requestId = value.requestId.slice(0, 200);
  if (Number.isFinite(value.providerRetryAfterMs)) out.providerRetryAfterMs = value.providerRetryAfterMs;
  return Object.keys(out).length > 0 ? out : null;
}

/** 把 finish reason 归一成我们自己的字符串，未知就是 null。 */
function normalizeFinishReason(reason) {
  if (!reason || typeof reason !== 'object') return null;
  switch (reason.kind) {
    case 'stop': return 'stop';
    case 'max-tokens': return 'max_tokens';
    case 'tool-calls': return 'tool_calls';
    case 'aborted': return 'aborted';
    case 'error': return 'error';
    default: return null;
  }
}

/**
 * 列出可用于候选的 provider 与 model。
 * @param {object} llm ctx.llm
 * @returns {Promise<{providers: object[], modelsByProvider: Record<string, object[]>, errors: object[]}>}
 */
export async function listModelCatalog(llm) {
  const providers = Array.isArray(llm.listProviders()) ? llm.listProviders() : [];
  const modelsByProvider = {};
  const errors = [];
  for (const p of providers) {
    try {
      const models = await llm.listModels(p.id);
      modelsByProvider[p.id] = Array.isArray(models) ? models : [];
    } catch (err) {
      // 目录不可用不应让整个界面失败；如实记录这只 provider 的问题
      modelsByProvider[p.id] = [];
      errors.push({ provider: p.id, error: pickFailure(err) ?? { message: String(err && err.message || err).slice(0, 500) } });
    }
  }
  return { providers, modelsByProvider, errors };
}

/**
 * 解析一个候选真正会被应用到的调用配置（F03 的"适配器可确认的已解析设置"）。
 * 用 resolveModelInfo 拿上下文窗口、默认输出上限与可用思考档位；
 * 服务端真正采用但我们观测不到的字段保留 null，不伪造。
 * @param {object} llm
 * @param {{provider: string, model: string, reasoningEffort?: string|null}} requested
 * @param {AbortSignal} [signal]
 */
export async function resolveCandidateConfig(llm, requested, signal) {
  const base = {
    provider: requested.provider,
    model: requested.model,
    reasoningEffort: requested.reasoningEffort ?? null,
    reasoningEffortSupported: null,
    contextWindow: null,
    defaultMaxTokens: null,
    availableReasoningEfforts: null,
    inputModalities: null,
    resolvedAt: Date.now(),
    note: null,
  };
  try {
    const info = await llm.resolveModelInfo(requested.provider, requested.model, signal);
    const efforts = info?.reasoning?.efforts;
    const ids = Array.isArray(efforts) ? efforts.map((e) => (typeof e === 'string' ? e : e?.id)).filter(Boolean) : null;
    base.availableReasoningEfforts = ids;
    base.inputModalities = Array.isArray(info?.inputModalities) ? [...info.inputModalities] : null;
    base.contextWindow = Number.isInteger(info?.context?.contextWindow) ? info.context.contextWindow : null;
    base.defaultMaxTokens = Number.isInteger(info?.defaultMaxTokens) ? info.defaultMaxTokens : null;
    if (base.reasoningEffort !== null && ids !== null) {
      base.reasoningEffortSupported = ids.includes(base.reasoningEffort);
    } else if (base.reasoningEffort !== null && ids === null) {
      base.reasoningEffortSupported = null; // 未确认，界面显示"未确认"
      base.note = '该适配器没有上报思考档位清单，是否生效未确认';
    }
  } catch (err) {
    base.note = '无法解析模型信息：' + String((pickFailure(err)?.message) ?? (err && err.message) ?? err).slice(0, 300);
  }
  return base;
}

/**
 * 跑一次逻辑生成请求。
 *
 * @param {object} params
 * @param {object} params.llm ctx.llm
 * @param {string} params.provider
 * @param {string} params.model
 * @param {string|null} [params.system] 已拼接好的 system 消息
 * @param {Array<{type:'text',text:string}>} params.content user 消息内容块
 * @param {number|null} [params.temperature]
 * @param {number|null} [params.maxTokens]
 * @param {string|null} [params.reasoningEffort]
 * @param {AbortSignal} params.signal
 * @param {(event: object) => void} [params.onEvent] 流式回调（第一事件/首正文/增量）
 * @returns {Promise<object>} 结果 + 收据
 */
export async function runGeneration(params) {
  const { llm, provider, model, system, content, temperature, maxTokens, reasoningEffort, signal, onEvent } = params;

  const startedAt = Date.now();
  const receipt = {
    queuedAt: params.queuedAt ?? startedAt,
    startedAt,
    firstEventAt: null,
    firstTextAt: null,
    finishedAt: null,
    finishReason: null,
    usage: null,
    observedRequests: 1, // 插件直调 = 单次网络请求（无自动重试），见模块头说明
    error: null,
  };

  // 手写消息对象：不 import DSH 包也能跑。content 只用 text 块（F05：V1 输入为文本）。
  const messages = [{
    id: 'msg_htmlarena_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    role: 'user',
    content: content.map((c) => ({ type: 'text', text: c.text })),
    source: { kind: 'plugin', plugin: 'html-arena' },
  }];

  /** @type {any} */
  const options = { provider, model, messages, signal };
  if (typeof system === 'string' && system.length > 0) options.system = system;
  if (typeof temperature === 'number') options.temperature = temperature;
  if (typeof maxTokens === 'number') options.maxTokens = maxTokens;
  if (typeof reasoningEffort === 'string' && reasoningEffort.length > 0) options.reasoningEffort = reasoningEffort;
  // 刻意不设置 tools / sessionId / purpose

  let text = '';
  let reasoning = '';
  let finish = null;
  const emittedBlocks = [];

  try {
    const stream = llm.stream(options);
    // 注意：不要 break。要停就 abort signal（否则流里没有终态 finish）。
    for await (const chunk of stream) {
      if (!chunk || typeof chunk !== 'object') continue;
      if (receipt.firstEventAt === null) {
        receipt.firstEventAt = Date.now();
        onEvent?.({ type: 'first-event', at: receipt.firstEventAt });
      }
      switch (chunk.type) {
        case 'text-delta':
          if (typeof chunk.text === 'string') {
            if (receipt.firstTextAt === null) {
              receipt.firstTextAt = Date.now();
              onEvent?.({ type: 'first-text', at: receipt.firstTextAt });
            }
            text += chunk.text;
            onEvent?.({ type: 'text-delta', text: chunk.text });
          }
          break;
        case 'reasoning-delta':
          if (typeof chunk.text === 'string') {
            reasoning += chunk.text;
            onEvent?.({ type: 'reasoning-delta', text: chunk.text });
          }
          break;
        case 'block-end':
          if (chunk.block) emittedBlocks.push(chunk.block);
          break;
        case 'usage':
          if (chunk.usage && typeof chunk.usage === 'object') {
            // 只保存服务实际提供的字段，缺失保持 null（F18）
            receipt.usage = {
              inputTokens: Number.isInteger(chunk.usage.inputTokens) ? chunk.usage.inputTokens : null,
              outputTokens: Number.isInteger(chunk.usage.outputTokens) ? chunk.usage.outputTokens : null,
              totalTokens: Number.isInteger(chunk.usage.totalTokens) ? chunk.usage.totalTokens : null,
              cacheReadTokens: Number.isInteger(chunk.usage.cacheReadTokens) ? chunk.usage.cacheReadTokens : null,
              cacheWriteTokens: Number.isInteger(chunk.usage.cacheWriteTokens) ? chunk.usage.cacheWriteTokens : null,
              reasoningTokens: Number.isInteger(chunk.usage.reasoningTokens) ? chunk.usage.reasoningTokens : null,
            };
          }
          break;
        case 'finish':
          finish = chunk.reason ?? null;
          break;
        default:
          break; // tool-call-delta 等出现时忽略（我们不发 tools，正常情况下不会出现）
      }
    }
  } catch (err) {
    // 只有中间件/消费者/清理失败才会走到这里（provider 错误走 finish）
    receipt.finishedAt = Date.now();
    receipt.finishReason = 'thrown';
    receipt.error = pickFailure(err) ?? { code: 'UNKNOWN', message: String(err && err.message || err).slice(0, 1000) };
    onEvent?.({ type: 'error', error: receipt.error });
    return { status: 'failed', text, reasoning, receipt, blocks: emittedBlocks };
  }

  receipt.finishedAt = Date.now();
  if (finish && typeof finish === 'object' && 'kind' in finish) {
    receipt.finishReason = normalizeFinishReason(finish);
    if (finish.kind === 'error' || finish.kind === 'aborted') {
      receipt.error = pickFailure(finish.failure) ?? { code: finish.kind === 'aborted' ? 'ABORTED' : 'UNKNOWN', message: '模型调用未成功完成' };
    }
  } else {
    // 没有终态 finish：不猜原因（F08 的同一原则）
    receipt.finishReason = null;
    receipt.error = { code: 'NO_TERMINAL_FINISH', message: '模型流在结束前中断，没有收到收尾信息' };
  }

  let status;
  if (receipt.error && receipt.error.code === 'ABORTED') status = 'cancelled';
  else if (receipt.error) status = 'failed';
  else if (receipt.finishReason === 'aborted') status = 'cancelled';
  else status = 'completed';

  onEvent?.({ type: 'done', status, receipt });
  return { status, text, reasoning, receipt, blocks: emittedBlocks };
}

/** 把 provider 错误码翻译成人能读懂的原因与下一步（PRD 7：禁止只显示 undefined）。 */
export function explainError(error) {
  const code = error?.code ?? 'UNKNOWN';
  const map = {
    AUTH: ['凭据被拒绝（401/403）', '到 DSH 的模型设置里检查这个 provider 的 API key 是否正确、是否还有效。'],
    MISSING_CREDENTIAL: ['没有找到这个 provider 的凭据', '到 DSH 的模型设置里为它填写 API key，或在启动环境里导出对应的环境变量。'],
    INVALID_CREDENTIAL: ['凭据内容无法放进 HTTP 头', 'API key 里可能有换行或多余字符，重新粘贴一次原始 key。'],
    QUOTA: ['额度或余额不足', '到该 provider 的控制台确认余额，或换一个候选模型。'],
    RATE_LIMIT: ['被限流（429）', '稍后重试，或把并发数降到 1。'],
    SERVER: ['服务端错误（5xx）', '这是对方服务的问题，稍后重试；其它候选不受影响。'],
    TIMEOUT: ['请求超时', '调大该候选的运行上限，或换一个更快的模型。'],
    TRANSPORT: ['网络传输失败', '检查网络与代理设置后重试。'],
    CONTEXT_WINDOW_EXCEEDED: ['输入超过模型上下文', '缩短题目或起始 HTML；工具不会静默截断你的输入。'],
    NO_ADAPTER: ['这个 provider 当前没有被任何适配器注册', '到 DSH 的模型设置里确认它是否已启用。'],
    UNSUPPORTED_REASONING_EFFORT: ['这个模型不支持所选的思考档位', '把思考档位改成"未确认"以外的受支持值，或留空。'],
    EMPTY_RESPONSE: ['模型没有返回正文', '如果这个模型会输出推理内容，很可能是输出预算被推理吃光了：调大该候选的输出上限，或换一个不输出推理的模型。重试会创建新的尝试（原记录保留）。'],
    NO_TERMINAL_FINISH: ['模型流中断，没有收到收尾信息', '重试会创建新的尝试；已收到的正文仍然保存。'],
    ABORTED: ['已被你取消', '取消是尽力中止，服务端可能仍会计费；已上报的用量已保存。'],
    UNKNOWN: ['调用失败（未识别的错误）', '展开原始错误信息查看细节。'],
  };
  const [title, hint] = map[code] ?? map.UNKNOWN;
  return { code, title, hint, status: error?.status ?? null, requestId: error?.requestId ?? null };
}

/** 供候选卡显示的"未确认"标记：DSH 是否真的支持该参数，我们无法凭空确定。 */
export function parameterSupportNote(resolved) {
  if (!resolved) return { temperature: null, maxTokens: null, reasoningEffort: null };
  return {
    temperature: null, // 适配器不上报，界面统一显示未确认
    maxTokens: resolved.defaultMaxTokens !== null ? 'default-available' : null,
    reasoningEffort: resolved.reasoningEffortSupported,
  };
}
