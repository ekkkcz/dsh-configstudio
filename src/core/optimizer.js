/**
 * 提示词优化器对接 —— 与 @dsh-external/dsh-prompt-optimizer 协作（可选能力，零侵入）。
 *
 * 为什么用 HTTP 而不是 ctx.get()：
 *   经只读核查（该包 0.4.5-beta.2，见 docs/optimizer-integration.md），
 *   它**没有 ctx.provide 任何服务**，宿主半边也没有导出任何优化函数，
 *   唯一的可编程入口就是它注册在同一个 DSH webServer 上的 prefix 路由
 *   /prompt-optimizer/api/*。因此这里走 HTTP，不修改对方一个字节。
 *
 * 对接契约（实测确认，但对 beta 版本不承诺稳定）：
 *   探活：GET  <base>/models                       → { ok, current, groups[] }
 *   发起：POST <base>/run  {request,tier,provider?,model?} → { ok, runId, tier }
 *   取结果：GET <base>/stream?runId=<id>           → SSE，累加 text-delta 得到完整文本
 *   取消：POST <base>/run/abort {runId}
 *
 * 三个必须处理的坑（核查里点名过）：
 *   1. GET /runs 里的 text 被截断到 4000 字符 —— 长稿必须走 SSE。
 *   2. SSE 是增量分片，不拼接就没有完整文本。
 *   3. tier 只认 basic / advanced / extreme；传错会静默落到 basic。
 *
 * 失败策略：一律 fail-open —— 优化器不可用就用原文，绝不因为它拦住主流程。
 *
 * @module configstudio/core/optimizer
 */

/** 优化器的路由前缀（对方硬编码的常量）。 */
export const OPTIMIZER_PATH = '/prompt-optimizer/api';

/** 宿主侧认可的档位。'off' 只是它的客户端概念，传了会静默落到 basic。 */
export const OPTIMIZER_TIERS = Object.freeze(['basic', 'advanced', 'extreme']);

/** 默认超时：优化是"发给另一个模型"，慢一点正常，但不能无限等。 */
const DEFAULT_TIMEOUT_MS = 120000;

/**
 * 从进来的请求推导同实例的基地址。
 *
 * 插件与优化器跑在同一个 DSH 进程、同一个 webServer 上，所以直接用请求自己的 Host
 * 就能回到本机同一端口，**不需要用户配置任何端口**。
 * 只接受回环主机名，避免把题目发到别处。
 */
export function baseUrlFromRequest(req) {
  const host = String(req?.headers?.host ?? '');
  const hostname = host.split(':')[0].replace(/^[|]$/g, '');
  if (hostname !== '127.0.0.1' && hostname !== 'localhost' && hostname !== '::1') return null;
  return 'http://' + host;
}

/** 探测优化器是否在位。带超时，不可用就返回 available:false（不是错误）。 */
export async function detectOptimizer(baseUrl, { timeoutMs = 4000 } = {}) {
  if (!baseUrl) return { available: false, reason: '无法确定本机地址' };
  const url = baseUrl + OPTIMIZER_PATH + '/models';
  try {
    const res = await fetchWithTimeout(url, { method: 'GET' }, timeoutMs);
    if (res.status === 401 || res.status === 403) {
      return { available: false, reason: '优化器要求认证（HTTP ' + res.status + '），本插件不代为绕过' };
    }
    if (!res.ok) return { available: false, reason: '优化器返回 HTTP ' + res.status };
    const body = await res.json();
    if (!body || body.ok !== true) return { available: false, reason: '优化器响应不是预期形状' };
    return {
      available: true,
      path: OPTIMIZER_PATH,
      current: body.current ?? null,
      modelCount: (body.groups ?? []).reduce((n, g) => n + ((g.models ?? []).length), 0),
      note: '对接方式：HTTP 调用它自己的 API（它没有提供服务，也没有导出函数）',
    };
  } catch (err) {
    return { available: false, reason: '连不上优化器：' + String(err && err.message || err).slice(0, 200) };
  }
}

/**
 * 跑一次优化，返回优化后的文本。
 *
 * @returns {Promise<{ok:boolean, text?:string, tier?:string, runId?:string, ms?:number, reason?:string, usage?:object|null}>}
 *   失败时 ok=false 且带 reason，调用方应 fail-open 地用原文。
 */
export async function optimizePrompt(baseUrl, { request, tier = 'basic', provider = null, model = null, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  // provider / model 传参可覆盖它自己的选择（核查确认的优先级：传参 > 它的落盘 state > 会话当前模型）。
  // 它默认会跟随会话当前模型，而那个模型未必适合做优化（实测遇到过额度不足），所以界面允许指定。
  if (!baseUrl) return { ok: false, reason: '无法确定本机地址' };
  const text = String(request ?? '').trim();
  if (text.length === 0) return { ok: false, reason: '题目为空，没有可优化的内容' };
  const safeTier = OPTIMIZER_TIERS.includes(tier) ? tier : 'basic';

  const started = Date.now();
  let started2;
  try {
    started2 = await fetchWithTimeout(baseUrl + OPTIMIZER_PATH + '/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ request: text, tier: safeTier, provider, model }),
    }, 20000);
  } catch (err) {
    return { ok: false, reason: '发起优化失败：' + String(err && err.message || err).slice(0, 200) };
  }
  if (!started2.ok) return { ok: false, reason: '发起优化返回 HTTP ' + started2.status };
  const run = await started2.json().catch(() => null);
  if (!run || run.ok !== true || !run.runId) return { ok: false, reason: '优化器没有返回 runId' };

  // 走 SSE 拿增量：/runs 的 text 会被截断到 4000 字符，长稿必须用这条路。
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let out = '';
  let reasoning = '';
  let usage = null;
  let status = 'unknown';
  let errMessage = null;
  try {
    const res = await fetch(baseUrl + OPTIMIZER_PATH + '/stream?runId=' + encodeURIComponent(run.runId), {
      method: 'GET',
      headers: { Accept: 'text/event-stream' },
      signal: controller.signal,
    });
    if (!res.ok) return { ok: false, reason: '读取优化流返回 HTTP ' + res.status, runId: run.runId };
    for await (const ev of parseSse(res.body)) {
      // 事件类型在 JSON 载荷的 type 字段里，**不是** SSE 的 event: 行（实测确认）。
      // 最初按标准 event: 写，结果一个事件都没匹配上，优化永远返回空。
      const kind = ev.data?.type ?? ev.event;
      if (kind === 'text-delta' && typeof ev.data?.text === 'string') out += ev.data.text;
      else if (kind === 'reasoning-delta' && typeof ev.data?.text === 'string') reasoning += ev.data.text;
      else if (kind === 'snapshot') {
        // 快照可能已经带了一部分正文（例如中途重连）
        if (typeof ev.data?.text === 'string' && ev.data.text.length > out.length) out = ev.data.text;
        if (typeof ev.data?.reasoning === 'string' && ev.data.reasoning.length > reasoning.length) reasoning = ev.data.reasoning;
        if (ev.data?.status) status = ev.data.status;
        if (typeof ev.data?.error === 'string' && ev.data.error) errMessage = ev.data.error;
      } else if (kind === 'usage') {
        // 这个插件的 usage 事件把统计放在 text 字段里（是字符串化的 JSON），不是对象
        let u = null;
        if (typeof ev.data?.text === 'string') { try { u = JSON.parse(ev.data.text); } catch { u = null; } }
        usage = u ?? (ev.data?.usage ?? null);
      } else if (kind === 'error') { status = 'error'; errMessage = ev.data?.message ?? null; }
      else if (kind === 'aborted') status = 'aborted';
      else if (kind === 'done') { status = 'done'; if (ev.data?.usage) usage = ev.data.usage; }
    }
  } catch (err) {
    // 超时或中断：已经收到的部分仍然有用，但不能当成完整稿
    if (status !== 'done' && status !== 'error') status = 'aborted';
    if (!errMessage) errMessage = String(err && err.message || err).slice(0, 200);
  } finally {
    clearTimeout(timer);
  }

  if (out.trim().length === 0) {
    return {
      ok: false, runId: run.runId, status, ms: Date.now() - started,
      reason: '优化器没有产出文本',
      // 上游原因原样带出（可能是额度不足、模型不可用等），不要让用户去猜
      upstreamError: errMessage ? String(errMessage).slice(0, 800) : null,
    };
  }
  // 只有明确 done 才算成功；半截稿不能冒充完整优化结果
  if (status !== 'done') {
    return { ok: false, reason: '优化没有正常结束（状态 ' + status + (errMessage ? '：' + errMessage : '') + '），为避免用到半截稿，改回用原文', runId: run.runId, status, partial: out, ms: Date.now() - started };
  }
  return { ok: true, text: out, tier: safeTier, runId: run.runId, ms: Date.now() - started, usage, reasoningChars: reasoning.length };
}

/** 取消一个正在跑的优化（可选，尽力而为）。 */
export async function abortOptimize(baseUrl, runId) {
  if (!baseUrl || !runId) return { ok: false };
  try {
    const res = await fetchWithTimeout(baseUrl + OPTIMIZER_PATH + '/run/abort', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ runId }),
    }, 5000);
    return { ok: res.ok };
  } catch { return { ok: false }; }
}

// ── 辅助 ──────────────────────────────────────────────────────

/** 带超时的 fetch（Node 内置，无需额外依赖）。 */
async function fetchWithTimeout(url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 把 SSE 字节流解析成 { event, data } 序列。
 * 只实现我们用到的那部分规范：event: / data: 多行、空行分隔。
 */
export async function* parseSse(body) {
  if (!body) return;
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  for await (const chunk of body) {
    buf += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const ev = parseSseBlock(raw);
      if (ev) yield ev;
    }
  }
  const tail = parseSseBlock(buf);
  if (tail) yield tail;
}

function parseSseBlock(raw) {
  const lines = String(raw).split('\n');
  let event = 'message';
  const dataLines = [];
  for (const line of lines) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
  }
  if (dataLines.length === 0) return null;
  const dataText = dataLines.join('\n');
  let data = null;
  try { data = JSON.parse(dataText); } catch { data = { text: dataText }; }
  return { event, data };
}
