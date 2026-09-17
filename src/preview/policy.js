/**
 * 预览隔离策略 —— 纯函数生成 sandbox 属性与 CSP 响应头。
 *
 * 对应 PRD F10–F14：
 *  - F12：作品不放进宿主页面执行；组合使用「独立预览源 + iframe sandbox + 响应头 CSP +
 *         消息校验」。禁止在同源页面上同时开放 allow-scripts 与 allow-same-origin。
 *  - F13：默认禁止读取宿主存储、获取宿主凭据、顶层跳转、弹窗、摄像头麦克风、任意文件访问。
 *  - F10：默认离线，只允许内联 HTML/CSS/JS 与允许的 data/blob 资源。
 *  - F11：受控 CDN 模式，允许有限域名清单加载固定版本资源；仍禁用页面任意 fetch/WebSocket。
 *
 * 本模块不依赖 DSH，可单测。
 *
 * @module html-arena/preview/policy
 */

/** 网络策略取值。offline 是默认；cdn 需显式选择，且同轮各候选保持一致（F11）。 */
export const NETWORK_POLICIES = Object.freeze(['offline', 'cdn']);

/**
 * V1 受控 CDN 清单（F11：在 M0 确定的有限域名清单）。
 * 只放主流、长期稳定、提供固定版本路径的静态资源站。用户可读可改，但插件不自动扩展。
 * 版本核对时间写入 each entry 的 checkedAt，便于审计。
 */
export const CDN_ALLOWLIST = Object.freeze([
  { origin: 'https://cdn.jsdelivr.net', label: 'jsDelivr', note: '建议使用带版本号的路径，如 /npm/three@0.160.0/build/three.min.js' },
  { origin: 'https://unpkg.com', label: 'unpkg', note: '建议使用 /pkg@version/ 形式锁定版本' },
  { origin: 'https://cdnjs.cloudflare.com', label: 'cdnjs', note: '建议使用 /ajax/libs/<lib>/<version>/ 形式' },
  { origin: 'https://fonts.googleapis.com', label: 'Google Fonts', note: '仅样式表' },
  { origin: 'https://fonts.gstatic.com', label: 'Google Fonts 字型文件', note: '字体二进制' },
]);

/**
 * 允许嵌入作品的父页面来源：本机回环的 http 源，任意端口（端口通配是实测支持的写法；
 * [::1] 形式经实测不被支持，故不列入）。
 */
export const DEFAULT_FRAME_ANCESTORS = Object.freeze([
  'http://127.0.0.1:*',
  'http://localhost:*',
]);

/**
 * iframe sandbox 令牌。
 * 刻意不包含：allow-same-origin（会与 allow-scripts 组合出同源逃逸）、
 * allow-top-navigation*（顶层跳转）、allow-popups（弹窗）、allow-modals（alert 阻塞渲染）、
 * allow-downloads（下载由可信父界面提供，F13）。
 */
const SANDBOX_TOKENS = Object.freeze(['allow-scripts', 'allow-forms']);

/** 生成 iframe 的 sandbox 属性值。 */
export function sandboxAttribute() {
  return SANDBOX_TOKENS.join(' ');
}

/**
 * 构造作品的 CSP。作品以独立源提供，因此 CSP 里的 'self' 已经就是作品源本身。
 *
 * frame-ancestors 说明（M0 实测结论，证据见 docs/evidence 的 m0-isolation 记录）：
 * 作品必须能被宿主页面用 iframe 嵌入，而宿主与预览服务是不同端口 = 不同源，因此
 * X-Frame-Options: SAMEORIGIN 会连宿主页面一起拒绝（实测确实如此，已移除该头）。
 *
 * 实测得到三条事实：
 *  1. frame-ancestors 支持 "http://127.0.0.1:*" 这种端口通配写法；
 *  2. 不支持 "http://[::1]:*"（浏览器报 "does not support the source expression"）；
 *  3. 非回环源（如 https://evil.example.com）确实被拒绝。
 * 又因为浏览器在 iframe 导航请求上不发 Origin 头，服务端无法按请求动态判定父页面，
 * 所以只能用一个固定清单：本机回环的 http 源，任意端口。
 * 这比 SAMEORIGIN 更精确：只有本机上打开的页面能嵌入作品，远程站点一律不行。
 *
 * @param {object} [options]
 * @param {'offline'|'cdn'} [options.networkPolicy]
 * @param {string[]} [options.extraOrigins] cdn 模式下额外允许的源（必须已在清单内才会被采纳）
 * @param {string[]} [options.frameAncestors] 覆盖默认的嵌入来源清单
 * @returns {string}
 */
export function buildCsp(options = {}) {
  const policy = options.networkPolicy === 'cdn' ? 'cdn' : 'offline';
  const allowed = policy === 'cdn'
    ? (options.extraOrigins && options.extraOrigins.length > 0 ? options.extraOrigins : CDN_ALLOWLIST.map((e) => e.origin))
    : [];

  const scriptSrc = ["'unsafe-inline'", "'unsafe-eval'", 'blob:', ...allowed];
  const styleSrc = ["'unsafe-inline'", 'blob:', ...allowed];
  const imgSrc = ['data:', 'blob:', ...allowed];
  const fontSrc = ['data:', 'blob:', ...allowed];
  const mediaSrc = ['data:', 'blob:', ...allowed];

  const directives = [
    "default-src 'none'",
    'script-src ' + scriptSrc.join(' '),
    'style-src ' + styleSrc.join(' '),
    'img-src ' + imgSrc.join(' '),
    'font-src ' + fontSrc.join(' '),
    'media-src ' + mediaSrc.join(' '),
    // 作品页面本身不得发起 fetch/XHR/WebSocket（F11 明确禁用）
    "connect-src 'none'",
    // 不允许作品再嵌一层，避免绕过隔离
    "frame-src 'none'",
    "child-src 'none'",
    "object-src 'none'",
    // 表单提交不外发（F13）
    "form-action 'none'",
    "base-uri 'none'",
    // 只有本机上的页面能嵌入本作品（见上方 frame-ancestors 说明）
    'frame-ancestors ' + (options.frameAncestors && options.frameAncestors.length > 0
      ? options.frameAncestors.join(' ')
      : DEFAULT_FRAME_ANCESTORS.join(' ')),
    // 允许由 blob: 构造的 Web Worker（部分 Canvas/算法演示需要）
    'worker-src blob:',
    // 禁止 <base> 之外的插件内容与混合内容升级
    'block-all-mixed-content',
  ];
  return directives.join('; ');
}

/**
 * 预览响应头。除 CSP 外还固定几个降低风险的头。
 * @param {object} [options] 同 buildCsp
 * @returns {Record<string,string>}
 */
export function buildPreviewHeaders(options = {}) {
  return {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': buildCsp(options),
    // 刻意不设 X-Frame-Options：它无法表达"任意回环端口"，SAMEORIGIN 会连宿主页面
    // 一起拒绝（实测）。嵌入范围改由 CSP 的 frame-ancestors 精确控制。
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    // 关闭浏览器强能力（F13：摄像头/麦克风/定位等）
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), usb=(), serial=(), hid=(), midi=(), payment=(), clipboard-read=(), clipboard-write=()',
    // 预览资源不进缓存，避免"看到的是上一次的作品"
    'Cache-Control': 'no-store',
  };
}

/**
 * 判断一个 Origin 头是否属于本机回环宿主，可以作为嵌入本作品的父页面。
 * 只接受 http/https + 回环地址；任何非回环 origin 一律拒绝。
 * @param {string|undefined|null} origin
 * @returns {boolean}
 */
export function isLoopbackOrigin(origin) {
  if (!origin || typeof origin !== 'string') return false;
  let u;
  try { u = new URL(origin); } catch { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '0.0.0.0';
}

/**
 * 校验 CDN 模式的源是否在白名单内。不在清单内必须明确拒绝，不能静默放行（F11）。
 * @param {string[]} origins
 * @returns {{ok: boolean, rejected: string[]}}
 */
export function validateCdnOrigins(origins) {
  const allowed = new Set(CDN_ALLOWLIST.map((e) => e.origin));
  const rejected = (origins || []).filter((o) => !allowed.has(o));
  return { ok: rejected.length === 0, rejected };
}

/**
 * 生成给作品的注入引导脚本：把作品想发给父窗口的消息统一加上运行标识，
 * 父界面只接受带正确标识且结构合法的消息（F12 的"明确的消息校验"）。
 * 作品本身不需要知道这个协议；父界面用 postMessage 的校验做兜底。
 * @param {string} runToken 每次加载唯一的随机令牌
 * @returns {string} 一小段可内联的脚本
 */
export function buildBridgeScript(runToken) {
  const token = JSON.stringify(String(runToken));
  return [
    '<script data-html-arena-bridge>',
    '(function(){',
    '  var TOKEN = ' + token + ';',
    '  var send = function(type, payload){',
    '    try { parent.postMessage({ __htmlArena: TOKEN, type: type, payload: payload }, "*"); } catch (e) {}',
    '  };',
    '  window.addEventListener("error", function(e){',
    '    send("error", { message: String(e.message || ""), source: String(e.filename || ""), line: e.lineno || null, column: e.colno || null });',
    '  });',
    '  window.addEventListener("unhandledrejection", function(e){',
    '    var r = e.reason; send("unhandledrejection", { message: String((r && r.message) || r || "") });',
    '  });',
    '  var origError = console.error, origWarn = console.warn;',
    '  console.error = function(){ send("console", { level: "error", text: Array.prototype.map.call(arguments, String).join(" ") }); return origError.apply(console, arguments); };',
    '  console.warn = function(){ send("console", { level: "warn", text: Array.prototype.map.call(arguments, String).join(" ") }); return origWarn.apply(console, arguments); };',
    '  send("ready", { readyState: document.readyState });',
    '  document.addEventListener("DOMContentLoaded", function(){ send("domcontentloaded", {}); });',
    '  window.addEventListener("load", function(){ send("load", {}); });',
    '})();',
    '</script>',
  ].join('\n');
}

/**
 * 把桥接脚本插到作品最前面（在 <head> 内、其它脚本之前），
 * 这样连作品自己的早期脚本报错都能被捕获。
 * @param {string} html
 * @param {string} runToken
 * @returns {string}
 */
export function injectBridge(html, runToken) {
  const bridge = buildBridgeScript(runToken);
  const m = /<head[^>]*>/i.exec(html);
  if (m) return html.slice(0, m.index + m[0].length) + '\n' + bridge + html.slice(m.index + m[0].length);
  const h = /<html[^>]*>/i.exec(html);
  if (h) return html.slice(0, h.index + h[0].length) + '\n<head>' + bridge + '</head>' + html.slice(h.index + h[0].length);
  return bridge + '\n' + html;
}

/**
 * 父界面侧的消息校验（F22 的伪造 postMessage 场景）。
 * 只接受：来源窗口是我们创建的那个 iframe、令牌匹配、结构符合已知类型。
 * @param {object} params
 * @param {MessageEvent} params.event
 * @param {Window|null} params.expectedSource iframe 的 contentWindow
 * @param {string} params.expectedToken
 * @returns {{ok: true, type: string, payload: unknown} | {ok: false, reason: string}}
 */
export function validateBridgeMessage({ event, expectedSource, expectedToken }) {
  if (!event || typeof event !== 'object') return { ok: false, reason: 'not-an-event' };
  if (!expectedSource || event.source !== expectedSource) return { ok: false, reason: 'unexpected-source' };
  const data = event.data;
  if (data === null || typeof data !== 'object') return { ok: false, reason: 'not-an-object' };
  if (data.__htmlArena !== expectedToken) return { ok: false, reason: 'token-mismatch' };
  const known = new Set(['error', 'unhandledrejection', 'console', 'ready', 'domcontentloaded', 'load']);
  if (typeof data.type !== 'string' || !known.has(data.type)) return { ok: false, reason: 'unknown-type' };
  return { ok: true, type: data.type, payload: data.payload ?? null };
}

/** 视口预设（F14 / F16：截图与预览都要标注真实视口）。 */
export const VIEWPORTS = Object.freeze({
  desktop: { width: 1280, height: 720, label: '桌面 1280x720' },
  mobile: { width: 390, height: 844, label: '手机 390x844' },
});
