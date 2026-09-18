/**
 * HTML 文本处理 —— 只有一份口径。
 *
 * 以前 escapeHtml 有两份（core/report.js 与 preview/server.js），导出包的"作品文件名"
 * 也没有 scheme 白名单。两件事都属于"同一份逻辑写两遍 / 少一道闸"，在这里合并：
 *  - escapeHtml：所有动态文本进 HTML 之前必须过；
 *  - safeRelPath：报告里的 src/href 只允许包内相对路径，挡掉 javascript: / data: 之类。
 *
 * @module html-arena/core/html
 */

/** HTML 转义。null / undefined 一律当空串（两份旧实现里有一份会输出 "null"，那是缺陷）。 */
export function escapeHtml(value) {
  const s = value === null || value === undefined ? '' : String(value);
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 只允许"包内相对路径"：字母数字、点、横线、下划线、斜杠，且不以 / 或 .. 开头。
 * 不满足就返回 null —— 调用方据此不生成 iframe / 链接，而不是硬塞一个可疑 URL。
 */
export function safeRelPath(value) {
  const s = String(value ?? '');
  if (s.length === 0 || s.length > 300) return null;
  if (!/^[A-Za-z0-9._/-]+$/.test(s)) return null;
  if (s.startsWith('/') || s.startsWith('..')) return null;
  if (s.includes('//') || s.includes('..')) return null;
  return s;
}
