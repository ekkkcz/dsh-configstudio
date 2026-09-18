/**
 * 展示包的报告页（F20）—— 纯函数生成一个**没有任何脚本**的静态 HTML。
 *
 * 三条硬要求直接对应验收 A24：
 *  ① 双击就能读（不依赖任何外部资源，CSS 内联）；
 *  ② 作品以**受限方式**预览：<iframe sandbox="allow-scripts"> + 相对路径 src，
 *     报告主体里不出现作品的任何脚本 —— 报告页自己一行 JS 都没有；
 *  ③ 不依赖原本地路径：报告里只有包内相对路径，没有任何绝对路径（导出时另有过一遍脱敏）。
 *
 * CDN 作品必须明确写"需要联网"：作品能不能离线显示，是导出时按作品 HTML 里的外部引用
 * 逐个判定的（detectExternalRefs），不是猜的。
 *
 * @module html-arena/core/report
 */
import { escapeHtml as escapeHtmlRaw, safeRelPath } from './html.js';
import { redactText } from './redact.js';

/**
 * 报告里所有动态文本的唯一出口：**先脱敏、再转义**。
 *
 * 顺序不能反：先转义的话，脱敏的路径模式会撞上 &lt; 这类实体（实测踩过）；
 * 而"先脱敏再转义"两边都安全 —— 脱敏只替换文本，不会碰到标签结构。
 *
 * 注意：报告里做替换**不影响** task.json / recipes.json 里的原文（那两份是逐字节照抄的），
 * 所以题目的 hash 在导出前后仍然一致。报告底部会写明这件事。
 */
export function escapeHtml(value) {
  return escapeHtmlRaw(redactText(value));
}

const STYLE = `
:root { color-scheme: light dark; --fg:#1b1f24; --muted:#5b6672; --line:#d8dee6; --bg:#fff; --card:#f7f9fc; --accent:#2f6feb; }
@media (prefers-color-scheme: dark) { :root { --fg:#e6e9ee; --muted:#9aa5b1; --line:#313843; --bg:#14171b; --card:#1b1f25; --accent:#6ea8fe; } }
* { box-sizing: border-box; }
body { margin:0; padding:24px; background:var(--bg); color:var(--fg);
  font:15px/1.65 "Segoe UI", "Microsoft YaHei", system-ui, sans-serif; }
h1 { font-size:22px; margin:0 0 4px; }
h2 { font-size:17px; margin:0 0 6px; }
h3 { font-size:15px; margin:18px 0 6px; }
a { color:var(--accent); }
.wrap { max-width:1280px; margin:0 auto; }
.meta, .muted { color:var(--muted); font-size:13px; }
.panel { border:1px solid var(--line); border-radius:10px; padding:14px 16px; margin:14px 0; background:var(--card); }
pre { white-space:pre-wrap; word-break:break-word; margin:6px 0 0; font-size:13px; }
.grid { display:grid; gap:14px; grid-template-columns:repeat(auto-fit, minmax(380px, 1fr)); }
.card { border:1px solid var(--line); border-radius:10px; padding:12px 14px; }
.pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:1px 9px; font-size:12px; margin-left:6px; vertical-align:middle; }
.pill.warn { border-color:#c98a00; color:#c98a00; }
iframe { width:100%; height:420px; border:1px solid var(--line); border-radius:8px; background:#fff; }
.hint { border-left:3px solid var(--accent); padding-left:10px; }
ul { margin:6px 0; padding-left:20px; }
`;

/**
 * 把作品放进受限沙箱预览。**不给 allow-same-origin** —— 作品拿不到本页的 DOM 与存储。
 * 地址只接受"包内相对路径"（safeRelPath）：javascript: / data: / 绝对 URL 一律不生成 iframe。
 */
function frameBlock(entry, title) {
  const src = safeRelPath(entry);
  if (!src) return '<p class="muted">这个作品的包内路径不合法，已跳过预览（可以在包里直接打开对应文件）。</p>';
  return '<iframe sandbox="allow-scripts" loading="lazy" src="' + escapeHtml(src) + '" title="' + escapeHtml(title) + '"></iframe>';
}

/** 包内链接：同样只允许相对路径。 */
function relLink(file, label, download) {
  const href = safeRelPath(file);
  if (!href) return '';
  return '<a href="' + escapeHtml(href) + '"' + (download ? ' download' : ' target="_blank" rel="noopener"') + '>' + escapeHtml(label) + '</a>';
}

/**
 * 渲染展示包报告。
 *
 * @param {object} input
 * @param {object} input.experiment 实验（title / category / createdAt / status）
 * @param {object} input.task 题目（按用户选择，可能不含某些字段）
 * @param {string} input.taskHash
 * @param {Array} input.candidates 每个候选的公开元数据（含 workFile / 可选 rawFile / 身份是否揭晓）
 * @param {object|null} input.vote 人工评价（choice / tags / note / revealedAt）
 * @param {Array} input.screenshots 截图条目（file / viewport / 标注）
 * @param {object} input.privacy 包含与不包含的说明
 * @param {object} input.tool {name, version}
 * @param {string} input.generatedAt ISO 时间
 * @param {number} input.schemaVersion
 * @returns {string}
 */
export function renderShowcaseReport(input) {
  const { experiment, task, taskHash, candidates, vote, screenshots, privacy, tool, generatedAt, schemaVersion } = input;
  const parts = [];
  parts.push('<!DOCTYPE html>');
  parts.push('<html lang="zh-CN"><head><meta charset="utf-8">');
  parts.push('<meta name="viewport" content="width=device-width,initial-scale=1">');
  parts.push('<title>HTML Arena 展示包 · ' + escapeHtml(experiment.title) + '</title>');
  parts.push('<style>' + STYLE + '</style>');
  parts.push('</head><body><div class="wrap">');

  parts.push('<header>');
  parts.push('<h1>' + escapeHtml(experiment.title) + '</h1>');
  parts.push('<p class="meta">' + escapeHtml(tool.name) + ' ' + escapeHtml(tool.version)
    + ' 导出 · ' + escapeHtml(generatedAt) + ' · 包格式 schemaVersion ' + escapeHtml(schemaVersion)
    + ' · 作品类型 ' + escapeHtml(experiment.category || '未标注') + '</p>');
  parts.push('<p class="hint muted">这是一个本地文件：双击本页即可阅读，不需要装任何东西。'
    + '作品在下面的受限沙箱里预览（不给同源权限，读不到你的文件、存储与 Cookie）。'
    + '标记「需要联网」的作品引用了外部 CDN 资源，离线打开时样式或功能会缺失 —— 这是作品本身的性质，不是报告坏了。</p>');
  parts.push('</header>');

  // ── 题目 ───────────────────────────────────────────────
  parts.push('<section class="panel"><h2>题目</h2>');
  if (task.prompt) {
    parts.push('<pre>' + escapeHtml(task.prompt) + '</pre>');
  } else {
    parts.push('<p class="muted">导出者选择不包含题目原文（题目指纹 ' + escapeHtml(String(taskHash).slice(0, 16)) + '…）。</p>');
  }
  if (task.outputRequirements) {
    parts.push('<h3>输出要求</h3><pre>' + escapeHtml(task.outputRequirements) + '</pre>');
  }
  if (task.startHtml) {
    parts.push('<h3>起始 HTML</h3><pre>' + escapeHtml(task.startHtml) + '</pre>');
  }
  parts.push('<p class="muted">题目指纹（SHA-256，可用于核对两边是不是同一道题）：<code>' + escapeHtml(taskHash) + '</code></p>');
  parts.push('</section>');

  // ── 作品 ───────────────────────────────────────────────
  parts.push('<section><h2>作品</h2><div class="grid">');
  for (const c of candidates) {
    parts.push('<article class="card">');
    const label = c.revealed ? ('候选 ' + c.letter + '：' + escapeHtml(c.name || '')) : ('候选 ' + c.letter);
    parts.push('<h2>' + label
      + '<span class="pill">' + escapeHtml(c.statusLabel) + '</span>'
      + (c.revealed && (c.provider || c.model) ? '<span class="pill">' + escapeHtml([c.provider, c.model].filter(Boolean).join(' / ')) + '</span>' : '')
      + (c.needsNetwork ? '<span class="pill warn">需要联网</span>' : '<span class="pill">离线自包含</span>')
      + '</h2>');
    if (!c.revealed) {
      parts.push('<p class="muted">这一轮还没揭晓，身份按要求隐藏（导出时该实验处于未揭晓状态）。</p>');
    }
    if (c.workFile) {
      parts.push(frameBlock(c.workFile, '候选 ' + c.letter + ' 作品预览'));
      parts.push('<p class="meta">'
        + relLink(c.workFile, '在新窗口打开作品', false)
        + (c.rawFile ? ' · ' + relLink(c.rawFile, '下载原始输出', true) : '')
        + '</p>');
    } else {
      parts.push('<p class="muted">这个候选这次没有产出可预览的作品' + (c.errorNote ? '：' + escapeHtml(c.errorNote) : '。') + '</p>');
    }
    const facts = [];
    if (c.htmlHash) facts.push('作品指纹 ' + String(c.htmlHash).slice(0, 16) + '…');
    if (c.bytes) facts.push('作品 ' + Math.round(c.bytes / 1024) + ' KB');
    if (c.durationMs) facts.push('耗时 ' + (c.durationMs / 1000).toFixed(1) + ' 秒');
    if (facts.length) parts.push('<p class="muted">' + escapeHtml(facts.join(' · ')) + '</p>');
    if (c.externalRefs && c.externalRefs.length > 0) {
      parts.push('<p class="muted">作品引用的外部资源：' + escapeHtml(c.externalRefs.slice(0, 6).join('、'))
        + (c.externalRefs.length > 6 ? ' 等 ' + c.externalRefs.length + ' 处' : '') + '</p>');
    }
    parts.push('</article>');
  }
  parts.push('</div></section>');

  // ── 人工评价 ───────────────────────────────────────────
  parts.push('<section class="panel"><h2>人工评价</h2>');
  if (vote && vote.choice) {
    parts.push('<p>结论：<strong>' + escapeHtml(vote.choiceLabel) + '</strong>'
      + (vote.tags && vote.tags.length ? ' · 标签：' + escapeHtml(vote.tags.join('、')) : '') + '</p>');
    if (vote.note) parts.push('<pre>' + escapeHtml(vote.note) + '</pre>');
    parts.push('<p class="muted">' + (vote.revealedAt
      ? '揭晓时间：' + escapeHtml(new Date(vote.revealedAt).toISOString())
      : '这条评价在导出时**尚未揭晓**，所以作品身份没有被写进本报告。')
      + '</p>');
    if (vote.mappingText) parts.push('<pre>' + escapeHtml(vote.mappingText) + '</pre>');
  } else {
    parts.push('<p class="muted">这个实验还没有人工评价。</p>');
  }
  parts.push('<p class="muted">单轮结果只代表这道题这一次实验，不构成模型排名。</p>');
  parts.push('</section>');

  // ── 截图 ───────────────────────────────────────────────
  if (screenshots && screenshots.length > 0) {
    parts.push('<section class="panel"><h2>初始截图</h2>');
    parts.push('<p class="muted">截图是对作品**重新加载后、未做任何交互时**捕获的初始状态，'
      + '不冒充你操作后的画面。每张都标了视口、DPR、等待时间与网络策略。</p><div class="grid">');
    for (const s of screenshots) {
      parts.push('<figure class="card" style="margin:0">');
      const shotSrc = safeRelPath(s.file);
      if (shotSrc) parts.push('<img src="' + escapeHtml(shotSrc) + '" alt="' + escapeHtml(s.caption) + '" style="width:100%;border:1px solid var(--line);border-radius:8px">');
      parts.push('<figcaption class="muted">' + escapeHtml(s.caption) + '</figcaption></figure>');
    }
    parts.push('</div></section>');
  }

  // ── 包含与不包含 ───────────────────────────────────────
  parts.push('<section class="panel"><h2>这个包里有什么、没有什么</h2><ul>');
  for (const line of privacy.included) parts.push('<li>包含：' + escapeHtml(line) + '</li>');
  for (const line of privacy.excluded) parts.push('<li class="muted">不含：' + escapeHtml(line) + '</li>');
  parts.push('</ul>');
  if (privacy.notes && privacy.notes.length) {
    for (const n of privacy.notes) parts.push('<p class="muted">' + escapeHtml(n) + '</p>');
  }
  parts.push('</section>');

  parts.push('<footer class="muted">由 ' + escapeHtml(tool.name) + ' 生成。展示包不会自动上传到任何地方。</footer>');
  parts.push('</div></body></html>');
  return parts.join('\n');
}
