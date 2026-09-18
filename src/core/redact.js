/**
 * 脱敏口径 —— "会离开本机的东西里不能带什么"的**唯一一份**规则。
 *
 * 两个使用方：
 *  ① 验收脚本写证据文件（docs/evidence 将来会公开）；
 *  ② 展示包 / 复测包导出（F21 / A27：导出包与默认日志不含测试密钥、请求头、绝对路径或私密推理）。
 *
 * 以前这份规则只存在于 scripts/lib/redact.mjs。M3 要让**导出包**也走同一套规则，
 * 而 src/ 不能 import scripts/（一个是产品、一个是脚手架），所以口径上移到 core，
 * 脚本侧改为从这里 re-export —— 与 canonical.js 那次抽取同一理由：同一份逻辑不写两遍。
 *
 * @module html-arena/core/redact
 */

/** 需要脱敏的模式。顺序有意义：先处理 JSON 里的双反斜杠形式，再处理单反斜杠。 */
export const REDACT_PATTERNS = Object.freeze([
  [/token=[A-Za-z0-9_-]{16,}/g, 'token=<已脱敏>'],
  // 交付说明里也出现过把整个带 token 的地址贴出来的情况
  [/(\?|&)t=[A-Za-z0-9_-]{16,}/g, '$1t=<已脱敏>'],
  // 本机绝对路径：脚本报错时 Playwright 会把 "D:\\开发\\...\\x.mjs:123" 整串写进证据，
  // 于是验收证据里带着开发机的目录结构。这类东西靠"记得清"守不住，统一在这一步抹掉。
  //
  // 字符类的边界很关键（这是实测踩过的坑）：早先写的是 [^"'\r\n]+，遇到 HTML 就会
  // 一路吃到行尾，把 </title>、</pre> 这类闭合标签一起删掉 —— 于是"脱敏"把文档改成了空页。
  // 现在一律在 < > " ' 处停下。同时**不再对 HTML 负载跑脱敏**（见 pack.js 的 entry/metaEntry）。
  [/[A-Za-z]:\\\\[^"'<>\r\n]+/g, '<本地路径>'],
  [/[A-Za-z]:\\[^"'<>\r\n]+/g, '<本地路径>'],
  [/(?:^|[\s"'(])\/(?:home|mnt|Users)\/[^"'\s<>]+/g, ' <本地路径>'],
  // 凭据类字符串：导出包绝不该带 API key / Bearer 令牌 / 常见前缀的密钥
  [/\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}/g, '<已脱敏的密钥>'],
  [/\bBearer\s+[A-Za-z0-9._-]{16,}/gi, 'Bearer <已脱敏>'],
  [/\b(api[_-]?key|apikey|access[_-]?token|authorization)\b\s*[:=]\s*"?[A-Za-z0-9._-]{12,}"?/gi, '$1=<已脱敏>'],
]);

/** 对一个字符串脱敏。 */
export function redactText(value) {
  let out = String(value);
  for (const [re, to] of REDACT_PATTERNS) out = out.replace(re, to);
  return out;
}

/**
 * 深度遍历对象/数组，把所有字符串按模式脱敏。返回新对象，不改原对象。
 */
export function redactValue(value) {
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) out[k] = redactValue(value[k]);
    return out;
  }
  return value;
}

/**
 * 扫描一段"准备导出给别人的用户内容"，只报告、不改动。
 *
 * 为什么只报告不改：题目与配方是**用户自己的内容**，改写它们会让"题目指纹"
 * 在导出前后对不上（A25 要的正是这个一致性）。所以这里如实告诉用户
 * "这几处看起来像本机路径、会跟着包一起发出去"，由他决定要不要取消勾选。
 *
 * @param {string} text
 * @returns {{hits: {kind: string, sample: string}[], count: number}}
 */
export function scanForPrivateContent(text) {
  const hits = [];
  const patterns = [
    { kind: '本机绝对路径', re: /[A-Za-z]:\\[^"'<>\r\n]{2,}/g },
    { kind: '本机绝对路径', re: /(?:^|[\s"'(])\/(?:home|mnt|Users)\/[^"'\s<>]{2,}/g },
    { kind: '疑似密钥', re: /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g },
    { kind: '访问令牌', re: /\bBearer\s+[A-Za-z0-9._-]{16,}/gi },
    { kind: '带令牌的地址', re: /token=[A-Za-z0-9_-]{16,}/g },
  ];
  for (const p of patterns) {
    let m;
    while ((m = p.re.exec(String(text))) !== null) {
      hits.push({ kind: p.kind, sample: redactText(m[0]).slice(0, 80) });
      if (hits.length >= 20) return { hits, count: hits.length };
    }
  }
  return { hits, count: hits.length };
}

/**
 * 检查一段文本里是否**仍然**含有疑似私密内容（A27 的自检口径）。
 * 与 redactText 用的是同一组模式 —— 导出后用这个再验一遍，而不是另写一份规则。
 * @returns {{clean: boolean, hits: {pattern: string, sample: string}[]}}
 */
export function findSensitive(text) {
  const hits = [];
  for (const [re, to] of REDACT_PATTERNS) {
    const rx = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    let m;
    while ((m = rx.exec(String(text))) !== null) {
      hits.push({ pattern: String(re), replacement: to, sample: String(m[0]).slice(0, 60) });
      if (hits.length > 50) return { clean: false, hits };
    }
  }
  return { clean: hits.length === 0, hits };
}
