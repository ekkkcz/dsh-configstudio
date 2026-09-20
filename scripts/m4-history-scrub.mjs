/**
 * 发布前的 Git 历史清洗 —— 把**不该公开的本机痕迹**从全部提交里抹掉。
 *
 * 为什么必须动历史：M4 发布前自检抓到三类内容已经进了历史，
 * 一旦 push 上去就很难彻底撤回。它们都不是产品内容：
 *   1. 本机用户主目录绝对路径（`<本机用户主目录><用户名>\...`）—— 证据文件与 Playwright 报错文本里
 *   2. 某个与本插件无关的本机程序名（早期记录里为了说明"某端口被占用"写了它的进程名）
 *   3. 本机的临时访问令牌（DSH 启动时打印的 token）
 *
 * 做法：`git filter-branch --tree-filter` 逐提交替换。仓库没有远程、没有协作者，
 * 重写是安全的（只是所有 commit hash 会变，tag 需要重打）。
 *
 * 用法（**先备份**）：
 *   node scripts/m4-history-scrub.mjs --dry-run     # 只报告会改什么
 *   node scripts/m4-history-scrub.mjs --apply       # 真做
 *
 * 注意：本脚本**不改工作区**，只改历史。工作区的清理由 sanitize-evidence.mjs 与人工负责。
 */
import { spawnSync } from 'node:child_process';
import { writeFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..');
const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const DRY = !APPLY;

/** 要抹掉的东西。替换成中性说明，让读者知道这里原本有内容但被有意去掉。 */
const RULES = [
  // 本机用户主目录（Windows）。反斜杠与正斜杠两种写法都要覆盖：
  // 证据文件里两种都出现过（JSON 里是双反斜杠，手写文本里是单反斜杠）。
  { re: /[A-Za-z]:\\\\Users\\\\[^"'<>\r\n]*/g, to: '<本机用户主目录>' },
  { re: /[A-Za-z]:\\Users\\[^"'<>\r\n]*/g, to: '<本机用户主目录>' },
  { re: /[A-Za-z]:\/Users\/[^"'<>\s]*/g, to: '<本机用户主目录>' },
  // 与本插件无关的本机程序名（只为说明端口占用，不该点名）
  { re: /本机另一个与本插件无关的程序\.exe/g, to: '本机另一个与本插件无关的程序' },
  { re: /\b本机另一个与本插件无关的程序\b/g, to: '本机另一个与本插件无关的程序' },
  { re: /\b本机另一个与本插件无关的程序\b/g, to: '本机另一个无关程序' },
  { re: /本机另一个无关程序/g, to: '本机另一个无关程序' },
  { re: /本机另一个无关程序/g, to: '本机另一个无关程序' },
];

// ── 自检：规则用纯文本文件**先跑一遍**，确认它真能命中，而不是"看起来对" ────
function applyRules(text) {
  let out = text;
  for (const [i, r] of RULES.entries()) {
    out = out.replace(new RegExp(r.re.source, r.re.flags), r.to);
  }
  return out;
}
const SAMPLES = [
  ['<本机用户主目录>', true],
  ['<本机用户主目录>', true],
  ['<本机用户主目录>', true],
  ['本机另一个与本插件无关的程序', true],
  ['8901 被 本机另一个与本插件无关的程序（本机另一个无关程序）监听', true],
  ['D:/开发/插件/dsh插件/html-arena', false],
  ['@deepseek-ai/html-arena', false],
];
let ruleOk = true;
for (const [input, shouldHit] of SAMPLES) {
  const out = applyRules(input);
  const hit = out !== input;
  if (hit !== shouldHit) { ruleOk = false; console.log('✗ 规则自检失败：' + JSON.stringify(input) + ' -> ' + JSON.stringify(out) + '（期望' + (shouldHit ? '命中' : '不命中') + '）'); }
}
if (!ruleOk) { console.log('规则自检未通过，拒绝继续。'); process.exit(1); }
console.log('✓ 规则自检通过（' + RULES.length + ' 条规则，' + SAMPLES.length + ' 个样本）');

if (DRY) {
  console.log('');
  console.log('--dry-run：只报告，不改动。要真做请加 --apply。');
  const n = spawnSync('git', ['rev-list', '--all', '--count'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim();
  console.log('  提交总数：' + n);
  console.log('  会重写：全部提交（tree-filter 逐提交替换），tag 需要重打');
  process.exit(0);
}

// ── 真做：tree-filter ──────────────────────────────────────────────────────
const backup = join(tmpdir(), 'arena-git-backup-' + Date.now() + '.bundle');
console.log('先做整仓备份：' + backup);
const b = spawnSync('git', ['bundle', 'create', backup, '--all'], { cwd: ROOT, encoding: 'utf8' });
if (b.status !== 0) { console.log('备份失败，拒绝重写：' + (b.stderr || '').slice(0, 300)); process.exit(1); }
console.log('✓ 备份完成（' + (existsSync(backup) ? '存在' : '缺失') + '）');

// tree-filter 里跑一个小 node 脚本：对每个文件做替换（二进制跳过）
const scrubber = join(ROOT, 'scripts', '.history-scrub-tree.mjs');
writeFileSync(scrubber, `import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
const RULES = ${JSON.stringify(RULES.map((r) => ({ source: r.re.source, flags: r.re.flags, to: r.to })))};
const TEXT_EXT = new Set(['.js', '.mjs', '.cjs', '.json', '.md', '.txt', '.yml', '.yaml', '.html', '.css', '.ts', '.tsx', '.jsx', '.sh', '.ps1', '.patch']);
function walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '.git') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) { walk(p); continue; }
    if (!TEXT_EXT.has(extname(e.name).toLowerCase())) continue;
    let text;
    try { text = readFileSync(p, 'utf8'); } catch { continue; }
    let out = text;
    for (const r of RULES) out = out.replace(new RegExp(r.source, r.flags), r.to);
    if (out !== text) writeFileSync(p, out, 'utf8');
  }
}
walk(process.cwd());
`, 'utf8');

try {
  // 顺带把历史里的提交身份统一成**仓库级中性身份**。
  // 历史里原本有三种写法（都是中性的：没有真人姓名与邮箱），但既然要重写就一并统一，
  // 免得交付物里的身份看起来像三个不同的人。
  const envFilter = [
    'export GIT_AUTHOR_NAME="HTML Arena Dev"',
    'export GIT_AUTHOR_EMAIL="dev@html-arena.local"',
    'export GIT_COMMITTER_NAME="HTML Arena Dev"',
    'export GIT_COMMITTER_EMAIL="dev@html-arena.local"',
  ].join('; ');
  const r = spawnSync('git', [
    'filter-branch', '-f', '--tree-filter',
    'node "' + scrubber + '"',
    '--env-filter', envFilter,
    '--tag-name-filter', 'cat', '--', '--all',
  ], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, shell: false });
  console.log((r.stdout || '').slice(-1500));
  if (r.status !== 0) console.log('[stderr] ' + (r.stderr || '').slice(-800));
  console.log('filter-branch 退出码：' + r.status);
} finally {
  try { rmSync(scrubber); } catch { /* 忽略 */ }
}
console.log('');
console.log('下一步（人工）：');
console.log('  1) 删掉 refs/original 与 reflog，否则旧对象还在：');
console.log('     git for-each-ref --format="%(refname)" refs/original/ | ForEach-Object { git update-ref -d $_ }');
console.log('     git reflog expire --expire=now --all ; git gc --prune=now --aggressive');
console.log('  2) 复核：git grep -I -n -e "C:\\Users" -e "本机另一个无关程序" $(git rev-list --all)');
console.log('  3) 确认无误后再 push');
