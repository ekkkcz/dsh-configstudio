/**
 * 证据脱敏 —— 写进 docs/evidence 的 JSON 在落盘前统一过一遍。
 *
 * 为什么需要（本轮实测发现）：截图元信息里的 `stateNote` 带作品 URL，
 * 而 URL 上有预览桥令牌（`/preview/<attemptId>?token=<32 位随机>`）。
 * 那个令牌是每次截图请求现生成的、只对本次加载有效，没有凭据价值 ——
 * 但它属于"运行期凭据类字符串"，不该留在将来会公开的验收证据里。
 *
 * 这类问题靠"记得手动清"是守不住的，所以在**写盘这一步**统一处理：
 * 所有 walkthrough 脚本走 `writeEvidence()` 而不是直接 `writeFileSync`。
 *
 * @module scripts/lib/redact
 */
import { writeFileSync } from 'node:fs';

/** 需要脱敏的模式。 */
const TOKEN_PATTERNS = [
  [/token=[A-Za-z0-9_-]{16,}/g, 'token=<已脱敏>'],
  // 交付说明里也出现过把整个带 token 的地址贴出来的情况
  [/(\?|&)t=[A-Za-z0-9_-]{16,}/g, '$1t=<已脱敏>'],
  // 本机绝对路径（M2 补）：脚本报错时 Playwright 会把
  // "D:\\开发\\dsh插件\\html-arena\\scripts\\x.mjs:123" 整串写进证据，
  // 于是**验收证据里带着开发机的目录结构**。这类东西靠"记得清"守不住，
  // 与令牌同理，统一在写盘这一步抹掉。
  // JSON 里是双反斜杠，所以先处理双反斜杠形式。
  [/[A-Za-z]:\\\\[^"'\r\n]+/g, '<本地路径>'],
  [/[A-Za-z]:\\[^"'\r\n]+/g, '<本地路径>'],
  [/(?:^|[\s"'(])\/(?:home|mnt|Users)\/[^"'\s]+/g, ' <本地路径>'],
];

/**
 * 深度遍历对象/数组，把所有字符串按模式脱敏。
 * 返回新对象，不改原对象（调用方可能还要用它继续跑）。
 */
export function redactValue(value) {
  if (typeof value === 'string') {
    let out = value;
    for (const [re, to] of TOKEN_PATTERNS) out = out.replace(re, to);
    return out;
  }
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) out[k] = redactValue(value[k]);
    return out;
  }
  return value;
}

/**
 * 写证据文件：先脱敏，再以 2 空格缩进写盘。
 * @param {string} filePath
 * @param {object} report
 */
export function writeEvidence(filePath, report) {
  const safe = redactValue(report);
  writeFileSync(filePath, JSON.stringify(safe, null, 2), 'utf8');
  return filePath;
}
