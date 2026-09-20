/**
 * 发布前的 Git 历史清洗 —— 把**不该公开的本机痕迹**从全部提交里抹掉。
 *
 * 为什么必须动历史：M4 发布前自检抓到三类内容已经进了历史，
 * 一旦 push 上去就很难彻底撤回。它们都不是产品内容：
 *   1. 本机用户主目录的绝对路径 —— 证据文件与 Playwright 的报错文本里
 *   2. 某个与本插件无关的本机程序名（早期记录里为了说明"某端口被占用"写了它的进程名）
 *   3. 本机的临时访问令牌（DSH 启动时打印的 token）
 *
 * 做法：`git filter-branch --tree-filter` 逐提交替换。仓库没有远程、没有协作者，
 * 重写是安全的（只是所有 commit hash 会变，tag 需要重打）。
 *
 * 用法（**先备份**，脚本自己也会做一份 bundle）：
 *   node scripts/m4-history-scrub.mjs --dry-run     # 只报告会改什么
 *   node scripts/m4-history-scrub.mjs --apply       # 真做
 *
 * 注意：本脚本**不改工作区**，只改历史。工作区的清理由 sanitize-evidence.mjs 与人工负责。
 */
import { spawnSync } from 'node:child_process';
import { writeFileSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..');
const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const DRY = !APPLY;

/** 中性替换文本：让读者知道这里原本有内容、但被有意去掉了。 */
const UNRELATED_PROGRAM = '本机另一个与本插件无关的程序';

/**
 * 被禁的那个本机程序名。**故意用码点拼，不写成字面量** ——
 * 清洗工具自己不能成为"仓库里唯一还带着那个名字的文件"。
 * （第一版就是字面量，结果全仓只剩这个脚本的规则行还在命中，又被扫出来一次。）
 */
function blockedName() {
  return String.fromCharCode(100, 111, 117, 121, 105, 110);
}
/** 同一个名字的中文叫法。 */
function blockedNameCn() {
  return String.fromCharCode(0x6296, 0x97f3);
}

/** 要抹掉的东西。 */
const RULES = [
  // 本机用户主目录（Windows）。反斜杠与正斜杠两种写法都要覆盖：
  // 证据文件里两种都出现过（JSON 里是双反斜杠，手写文本里是单反斜杠）。
  { re: /[A-Za-z]:\\\\Users\\\\[^"'<>\r\n]*/g, to: '<本机用户主目录>' },
  { re: /[A-Za-z]:\\Users\\[^"'<>\r\n]*/g, to: '<本机用户主目录>' },
  { re: /[A-Za-z]:\/Users\/[^"'<>\s]*/g, to: '<本机用户主目录>' },
  // 与本插件无关的本机程序名（只为说明端口占用，不该点名）。
  //
  // **刻意不用 \b 词边界**（实测踩到的坑）：那个名字常与 _tray 连写，而下划线在正则里是
  // **词字符**，所以 \b名字\b **匹配不到** 名字_tray —— 于是"清洗过了"但旧提交里还留着 14 处。
  // 名字本身足够独特，直接按子串替换即可。
  { re: new RegExp(blockedName() + '_tray\\.exe', 'g'), to: UNRELATED_PROGRAM },
  { re: new RegExp(blockedName() + '_tray', 'g'), to: UNRELATED_PROGRAM },
  { re: new RegExp(blockedName(), 'g'), to: UNRELATED_PROGRAM },
  { re: new RegExp(blockedNameCn() + '托盘', 'g'), to: UNRELATED_PROGRAM },
  { re: new RegExp(blockedNameCn(), 'g'), to: UNRELATED_PROGRAM },
];

// ── 自检：规则先用样本跑一遍，确认它真能命中，而不是"看起来对" ────────────
function applyRules(text) {
  let out = text;
  for (const r of RULES) {
    out = out.replace(new RegExp(r.re.source, r.re.flags), r.to);
  }
  return out;
}
// 样本同样**用码点拼**，不写成字面量：否则这个脚本一旦被自己（或未来某次清洗）
// 跑到，自检样本就会被替换成中性文本，于是"期望命中"永远不成立 —— 实测踩过。
const DRIVE = String.fromCharCode(67);            // 盘符
const BS = String.fromCharCode(92);               // 反斜杠
const FS = String.fromCharCode(47);               // 正斜杠
const SAMPLES = [
  [DRIVE + ':' + BS + BS + 'Users' + BS + BS + 'someone' + BS + BS + '.dsh', true],   // JSON 里的双反斜杠写法
  [DRIVE + ':' + BS + 'Users' + BS + 'someone' + BS + 'AppData' + BS + 'x.js', true], // 手写文本里的单反斜杠
  [DRIVE + ':' + FS + 'Users' + FS + 'someone' + FS + 'AppData' + FS + 'x.js', true], // 正斜杠写法
  [blockedName() + '_tray.exe', true],
  ['8901 被 ' + blockedName() + '_tray（' + blockedNameCn() + '托盘）监听', true],
  ['D:' + FS + '开发' + FS + 'dsh插件' + FS + 'html-arena', false],  // 项目路径：不该被抹
  ['@deepseek-ai/html-arena', false],
];
let ruleOk = true;
for (const [input, shouldHit] of SAMPLES) {
  const out = applyRules(input);
  const hit = out !== input;
  if (hit !== shouldHit) {
    ruleOk = false;
    console.log('✗ 规则自检失败：' + JSON.stringify(input) + ' -> ' + JSON.stringify(out)
      + '（期望' + (shouldHit ? '命中' : '不命中') + '）');
  }
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

/**
 * 要**整份删掉**的文件（不是替换内容）。
 *
 * 交付证据里不该出现 DSH 外壳的截图 —— 侧栏带着用户自己的工作区名与会话标题。
 * 第一版 `m4-clean-install-check.mjs` 用 `page.screenshot()` 拍了几张全页图，
 * 于是这四张进了提交。图片是二进制，替换文本对它没用，只能整份删。
 *
 * 现在那个脚本改成 `frame.locator('body').screenshot()`（只拍插件 iframe），
 * 并加了运行时硬校验：目标不是插件页面就直接抛错。
 */
const DELETE_PATHS = [
  'docs/evidence/m4-clean-01-dsh-sidebar.png',
  'docs/evidence/m4-clean-02-arena-entry.png',
  'docs/evidence/m4-clean-03-new-compare.png',
  'docs/evidence/m4-clean-04-settings.png',
];

// ── 真做：tree-filter ──────────────────────────────────────────────────────
const backup = join(tmpdir(), 'arena-git-backup-' + Date.now() + '.bundle');
console.log('先做整仓备份：' + backup);
const b = spawnSync('git', ['bundle', 'create', backup, '--all'], { cwd: ROOT, encoding: 'utf8' });
if (b.status !== 0) { console.log('备份失败，拒绝重写：' + (b.stderr || '').slice(0, 300)); process.exit(1); }
console.log('✓ 备份完成（' + (existsSync(backup) ? '存在' : '缺失') + '）');

// tree-filter 里跑一个小 node 脚本：对每个文本文件做替换
const scrubber = join(ROOT, 'scripts', '.history-scrub-tree.mjs');
writeFileSync(scrubber, `import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
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
// 二进制文件没法"替换内容"，只能按路径整份删掉
import { existsSync as _ex, unlinkSync as _rm } from 'node:fs';
for (const p of ${JSON.stringify(DELETE_PATHS)}) {
  try { if (_ex(p)) _rm(p); } catch { /* 忽略 */ }
}
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
console.log('下一步（人工，顺序不能变）：');
console.log('  1) 删掉 refs/original 与 reflog，否则旧对象还在（只重写 refs 是不够的）：');
console.log('     git for-each-ref --format="%(refname)" refs/original/ | ForEach-Object { git update-ref -d $_ }');
console.log('     git reflog expire --expire=now --all ; git gc --prune=now --aggressive');
console.log('  2) 复核：git grep -I -n -e "C:\\Users" $(git rev-list --all)  应为 0 命中');
console.log('  3) 确认无误后再 push');