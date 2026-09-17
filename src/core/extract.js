/**
 * HTML 提取器 —— 把模型原始正文切成"作品 HTML"。
 *
 * 设计约束来自 PRD F07 / F08：
 *  - 只接受「原始完整 HTML」或「唯一一个明确的 HTML 代码块」；
 *  - 出现多个可能的 HTML 块时不猜、不拼接，返回候选让用户选择并记录选择；
 *  - 没有任何有效 HTML 时返回 none，界面显示"未识别到作品"；
 *  - 不自动补写缺失代码，缺结束标签只作为格式警告；
 *  - 记录提取器版本与被选文本区间，便于原始正文 hash 不受影响地复现。
 *
 * 本模块是纯函数、无 I/O、不依赖 DSH，可以直接单测。
 *
 * @module html-arena/core/extract
 */

/** 提取器算法版本。任何会改变切分结果的改动都必须提升它（F08）。 */
export const EXTRACTOR_VERSION = '1';

/** 反引号字符（避免在源码里直接写它，方便本文件被其它工具处理）。 */
const FENCE_CHAR = String.fromCharCode(96);

/** 匹配 markdown 围栏开启/关闭行。捕获组：1=围栏字符重复，2=围栏后的信息串。 */
const FENCE_LINE_RE = new RegExp('^ {0,3}(' + FENCE_CHAR + '{3,}|~{3,})(.*)$');

/**
 * 围栏语言标记的判定策略（F07「唯一一个明确的 HTML 代码块」）：
 *  - 显式标注 html/htm/html5/xhtml 的块：模型已声明这是 HTML，接受（片段也算，
 *    浏览器对 HTML 片段的容错解析是标准行为，强行要求完整文档会误杀合法作品）。
 *  - 没有任何语言标记、或标了别的语言的块：只有内容本身像一份 HTML 文档时才接受。
 */
const EXPLICIT_HTML_LANGUAGES = new Set(['html', 'htm', 'html5', 'xhtml']);

/** 小于这个长度的块不当作作品候选。 */
const MIN_CANDIDATE_LENGTH = 8;

/**
 * 扫描 markdown 围栏代码块。
 * 手写扫描而非正则：需要准确的字符区间，且要正确处理未闭合的围栏。
 * @param {string} text 原始正文
 * @returns {{language: string, info: string, bodyStart: number, bodyEnd: number, closed: boolean, fenceStart: number, fenceEnd: number}[]}
 */
function scanFences(text) {
  const lines = [];
  let offset = 0;
  const rawLines = text.split('\n');
  for (const raw of rawLines) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    lines.push({ text: line, start: offset, end: offset + raw.length });
    offset += raw.length + 1; // +1 为被 split 掉的换行符
  }

  const fences = [];
  let open = null;
  for (const l of lines) {
    const m = FENCE_LINE_RE.exec(l.text);
    if (!m) continue;
    const marker = m[1][0];
    const len = m[1].length;
    if (open === null) {
      open = { marker, len, info: m[2].trim(), fenceStart: l.start, bodyStart: l.end + 1 };
      continue;
    }
    // 关闭围栏：同种字符、长度不小于开启者、后面只有空白
    if (marker === open.marker && len >= open.len && m[2].trim() === '') {
      fences.push({
        language: (open.info.split(/\s+/)[0] || '').toLowerCase(),
        info: open.info,
        bodyStart: open.bodyStart,
        bodyEnd: Math.max(open.bodyStart, l.start > 0 ? l.start - 1 : 0),
        closed: true,
        fenceStart: open.fenceStart,
        fenceEnd: l.end,
      });
      open = null;
    }
  }
  if (open !== null) {
    // 未闭合围栏：正文一直延伸到结尾，作为截断信号的一部分
    fences.push({
      language: (open.info.split(/\s+/)[0] || '').toLowerCase(),
      info: open.info,
      bodyStart: open.bodyStart,
      bodyEnd: text.length,
      closed: false,
      fenceStart: open.fenceStart,
      fenceEnd: text.length,
    });
  }
  return fences;
}

/**
 * 保守判断一段文本"看起来就是 HTML 作品本体"。
 * 只在没有围栏候选时，用于识别"模型直接吐了整篇 HTML"的情况。
 * @param {string} s
 * @returns {boolean}
 */
function looksLikeHtmlDocument(s) {
  const head = s.slice(0, 400).trimStart().toLowerCase();
  if (/^<!doctype\s+html/.test(head)) return true;
  if (/^<html[\s>]/.test(head)) return true;
  // 允许模型先写一小段说明再给整篇 HTML
  return /<html[\s>]/i.test(s) && /<\/html\s*>/i.test(s);
}

/**
 * 找到真正的 <html> 根标签起点。
 * 光用 indexOf('<html') 会误判出现在字符串/示例里的 <html>（例如
 * print("<html>") 或 '拼接 <html> 开头'），必须要求它处在一个标签能开始的位置：
 * 行首、空白之后，或紧跟在 > 之后。
 * @param {string} lower 已转小写的全文
 * @returns {number} 起点下标，找不到返回 -1
 */
function findRealHtmlTagStart(lower) {
  let from = 0;
  for (;;) {
    const i = lower.indexOf('<html', from);
    if (i < 0) return -1;
    const next = lower[i + 5];
    const isTagBoundary = next === undefined || next === '>' || /\s/.test(next);
    const prev = i === 0 ? '' : lower[i - 1];
    const isStartBoundary = prev === '' || /\s/.test(prev) || prev === '>';
    if (isTagBoundary && isStartBoundary) return i;
    from = i + 1;
  }
}

/**
 * 在"模型直接吐 HTML、正文里还夹着说明文字"时，定位作品的准确区间。
 * 规则：起点取第一个 doctype 或 <html>；终点取最后一个 </html>（缺失则到最后一个非空字符）。
 * 找不到起点就返回 null，宁可报 none 也不切一段不是文档的东西当作品。
 * @param {string} text
 * @returns {{start: number, end: number}|null}
 */
function findRawDocumentBounds(text) {
  const lower = text.toLowerCase();
  const doctype = lower.indexOf('<!doctype html');
  const htmlTag = findRealHtmlTagStart(lower);
  let start = -1;
  if (doctype >= 0 && htmlTag >= 0) start = Math.min(doctype, htmlTag);
  else start = Math.max(doctype, htmlTag);
  if (start < 0) return null;

  const closeIdx = lower.lastIndexOf('</html>');
  let end;
  if (closeIdx >= start) {
    end = closeIdx + '</html>'.length;
  } else {
    // 缺结束标签：切到最后一个非空白字符，并交给警告体系标注
    end = start;
    for (let i = text.length - 1; i >= start; i -= 1) {
      if (!/\s/.test(text[i])) { end = i + 1; break; }
    }
  }
  return end > start ? { start, end } : null;
}

/** 收集格式警告：不改变结果，只如实标注风险（F08）。 */
export function collectWarnings(html, truncated) {
  const warnings = [];
  if (truncated === true) warnings.push({ code: 'truncated', message: '模型报告输出被截断，作品可能不完整' });
  if (!/<html[\s>]/i.test(html)) warnings.push({ code: 'missing_html_tag', message: '缺少 <html> 根标签' });
  if (!/<\/html\s*>/i.test(html)) warnings.push({ code: 'missing_closing_html', message: '缺少 </html> 结束标签' });
  const scriptOpens = (html.match(/<script[\s>]/gi) || []).length;
  const scriptCloses = (html.match(/<\/script\s*>/gi) || []).length;
  if (scriptOpens !== scriptCloses) {
    warnings.push({ code: 'unbalanced_script', message: 'script 标签数量不匹配（' + scriptOpens + ' 开 / ' + scriptCloses + ' 闭）' });
  }
  const styleOpens = (html.match(/<style[\s>]/gi) || []).length;
  const styleCloses = (html.match(/<\/style\s*>/gi) || []).length;
  if (styleOpens !== styleCloses) {
    warnings.push({ code: 'unbalanced_style', message: 'style 标签数量不匹配（' + styleOpens + ' 开 / ' + styleCloses + ' 闭）' });
  }
  return warnings;
}

/** 供用户在选择界面里辨认候选的短预览。 */
function previewOf(body) {
  const one = body.replace(/\s+/g, ' ').trim();
  return one.length > 120 ? one.slice(0, 120) + '…' : one;
}

/**
 * 从模型原始正文提取作品 HTML。
 *
 * @param {string} rawText 模型返回的完整正文（不可变保存的原文）
 * @param {{finishReason?: string|null}} [meta] 生成收尾信息，用于截断判定
 */
export function extractHtml(rawText, meta = {}) {
  const text = typeof rawText === 'string' ? rawText : '';
  const finishReason = meta.finishReason ?? null;
  // 只在明确知道 finish reason 时判定截断；未知就是未知，不猜（F08）
  let truncated = null;
  if (finishReason === 'length' || finishReason === 'max_tokens') truncated = true;
  else if (finishReason === 'stop' || finishReason === 'end_turn') truncated = false;

  const fences = scanFences(text);
  const htmlFences = fences.filter((f) => {
    const body = text.slice(f.bodyStart, f.bodyEnd);
    if (body.trim().length < MIN_CANDIDATE_LENGTH) return false;
    // 光有 html 语言标记还不够：模型有时会写一个标着 html 的围栏却把说明文字放进去。
    // 至少要出现一个标签构造才当作 HTML（'<div>x</div>' 这类片段仍然接受）。
    const hasAnyTag = /<[a-zA-Z!/]/.test(body);
    if (f.language !== '' && EXPLICIT_HTML_LANGUAGES.has(f.language)) return hasAnyTag;
    // 未闭合的围栏（模型被截断）常常只剩开头，此时靠 HTML 特征判断。
    // 只要内容是 HTML 就保留，让用户拿到半成品而不是"什么都没有"。
    if (!f.closed) return /<!doctype\s+html|<html[\s>]|<body[\s>]|<div[\s>]|<script[\s>]|<style[\s>]/i.test(body);
    return looksLikeHtmlDocument(body);
  });

  if (htmlFences.length > 1) {
    return {
      status: 'multiple',
      extractionVersion: EXTRACTOR_VERSION,
      mode: null,
      html: null,
      range: null,
      candidates: htmlFences.map((f, i) => ({
        index: i,
        start: f.bodyStart,
        end: f.bodyEnd,
        language: f.language || '(未标注)',
        closed: f.closed,
        preview: previewOf(text.slice(f.bodyStart, f.bodyEnd)),
      })),
      warnings: [],
      truncated,
      stats: { rawLength: text.length, htmlLength: 0 },
    };
  }

  if (htmlFences.length === 1) {
    const f = htmlFences[0];
    const html = text.slice(f.bodyStart, f.bodyEnd);
    return {
      status: 'ok',
      extractionVersion: EXTRACTOR_VERSION,
      mode: 'fenced',
      html,
      range: { start: f.bodyStart, end: f.bodyEnd },
      candidates: [],
      warnings: collectWarnings(html, truncated),
      truncated,
      stats: { rawLength: text.length, htmlLength: html.length },
    };
  }

  // 没有围栏候选：模型可能直接返回了整篇 HTML（前面/后面可能带说明文字）
  const bounds = findRawDocumentBounds(text);
  if (bounds !== null) {
    const html = text.slice(bounds.start, bounds.end);
    if (html.trim().length >= MIN_CANDIDATE_LENGTH) {
      return {
        status: 'ok',
        extractionVersion: EXTRACTOR_VERSION,
        mode: 'raw',
        html,
        range: bounds,
        candidates: [],
        warnings: collectWarnings(html, truncated),
        truncated,
        stats: { rawLength: text.length, htmlLength: html.length },
      };
    }
  }

  return {
    status: 'none',
    extractionVersion: EXTRACTOR_VERSION,
    mode: null,
    html: null,
    range: null,
    candidates: [],
    warnings: [],
    truncated,
    stats: { rawLength: text.length, htmlLength: 0 },
  };
}

/**
 * 用户在多候选中选定后，用同一个提取器版本切出最终 HTML（F07 要求记录选择）。
 * @param {string} rawText
 * @param {number} candidateIndex
 * @param {{finishReason?: string|null}} [meta]
 */
export function extractHtmlFromCandidate(rawText, candidateIndex, meta = {}) {
  const first = extractHtml(rawText, meta);
  if (first.status !== 'multiple') {
    throw new Error('当前正文没有多个候选，无法按候选提取：' + first.status);
  }
  const c = first.candidates[candidateIndex];
  if (!c) throw new Error('候选序号不存在：' + candidateIndex);
  const html = rawText.slice(c.start, c.end);
  return {
    status: 'ok',
    extractionVersion: EXTRACTOR_VERSION,
    mode: 'fenced',
    html,
    range: { start: c.start, end: c.end },
    candidates: first.candidates,
    warnings: collectWarnings(html, first.truncated),
    truncated: first.truncated,
    stats: { rawLength: rawText.length, htmlLength: html.length },
  };
}

/** 稳定 hash（与"原始正文不可变"关联用，F06）。SHA-256 十六进制。 */
export async function sha256Hex(text) {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
