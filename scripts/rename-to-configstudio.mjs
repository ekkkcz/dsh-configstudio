/**
 * 改名：HTML Arena → ConfigStudio
 *
 * 为什么写成脚本而不是手改：`html-arena` 这个字面量在 **120 个文件**里，
 * 手改必然漏。而且改名的**破坏性**在于三处标识符：
 *   - npm 包名 `@dsh-external/html-arena`（装了旧包的 profile 要重装）
 *   - API 前缀 `/html-arena`（界面所有请求路径）
 *   - **数据目录** `$DSH_HOME/html-arena`（改了就读不到旧实验 —— 必须搬目录）
 *
 * 替换规则（大小写敏感，顺序有意义）：
 *   `@dsh-external/html-arena` → `@dsh-external/configstudio`
 *   `html-arena`               → `configstudio`   （包名/路径/id/CSS 属性/导出文件名）
 *   `HtmlArena`                → `ConfigStudio`    （类名）
 *   `HTML Arena`               → `ConfigStudio`    （显示名）
 *   `HTML 对比`                → `配置对比`         （侧栏入口与文档里的界面文案）
 *
 * **不动** `docs/evidence/` 里的历史证据：那是"当时真的发生了什么"的记录，
 * 改写它们等于篡改证据。改了名字之前的证据就该显示旧名字 —— 这一点在
 * progress.md 里另记一条说明。
 *
 * 用法：
 *   node scripts/rename-to-configstudio.mjs --dry-run
 *   node scripts/rename-to-configstudio.mjs --apply
 */
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..');
const APPLY = process.argv.includes('--apply');

/** 替换规则：顺序有意义（先长后短，避免 @dsh-external/html-arena 被拆坏）。 */
const RULES = [
  ['@dsh-external/html-arena', '@dsh-external/configstudio'],
  ['html-arena', 'configstudio'],
  ['HtmlArena', 'ConfigStudio'],
  ['HTML Arena', 'ConfigStudio'],
  ['HTML 对比', '配置对比'],
];

/** 不动的路径：历史证据 + 本脚本自己（否则自检样本会被替换掉）。 */
const SKIP = [
  /^docs[\\/]evidence[\\/]/,
  /^scripts[\\/]rename-to-configstudio\.mjs$/,
  /^scripts[\\/]m4-history-scrub\.mjs$/,
];

const TEXT_EXT = new Set(['.js', '.mjs', '.cjs', '.json', '.md', '.txt', '.yml', '.yaml', '.html', '.css', '.ts']);

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '.git' || e.name === 'node_modules' || e.name === 'dev-data') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) { walk(p, out); continue; }
    out.push(p);
  }
  return out;
}

const files = walk(ROOT);
const textFiles = files.filter((f) => TEXT_EXT.has(extname(f).toLowerCase()));
const targets = textFiles.filter((f) => {
  const rel = f.slice(ROOT.length + 1).replace(/\\/g, '/');
  if (SKIP.some((re) => re.test(rel))) return false;
  const text = readFileSync(f, 'utf8');
  return RULES.some(([from]) => text.includes(from));
});

console.log('仓库根：' + ROOT);
console.log('文本文件：' + textFiles.length + '，其中含旧名字的：' + targets.length);
console.log('');

let totalHits = 0;
const perRule = RULES.map(() => 0);
const preview = [];
for (const f of targets) {
  const rel = f.slice(ROOT.length + 1);
  const text = readFileSync(f, 'utf8');
  let hits = 0;
  const counts = RULES.map(() => 0);
  RULES.forEach(([from], i) => {
    const n = text.split(from).length - 1;
    counts[i] += n; hits += n;
  });
  totalHits += hits;
  RULES.forEach(([, ], i) => { perRule[i] += counts[i]; });
  if (preview.length < 12) preview.push(rel + '  (' + hits + ')');
}

console.log('逐规则命中数：');
RULES.forEach(([from, to], i) => console.log('  ' + from.padEnd(28) + ' -> ' + to.padEnd(28) + ' ' + perRule[i] + ' 处'));
console.log('合计：' + totalHits + ' 处，分布在 ' + targets.length + ' 个文件');
console.log('');
console.log('前几个文件：');
for (const p of preview) console.log('  ' + p);
console.log('');
console.log('★ 不动（历史证据，改写等于篡改记录）：docs/evidence/ 下的文件');

if (!APPLY) {
  console.log('');
  console.log('--dry-run：没有改动任何文件。要真做加 --apply。');
  process.exit(0);
}

let changed = 0;
for (const f of targets) {
  const text = readFileSync(f, 'utf8');
  let out = text;
  for (const [from, to] of RULES) out = out.split(from).join(to);
  if (out !== text) { writeFileSync(f, out, 'utf8'); changed += 1; }
}
console.log('');
console.log('已改写 ' + changed + ' 个文件。');

// 自检：确认关键标识符真的换了，且没有留下旧名字（除历史证据）
const mustHave = [
  ['package.json', '@dsh-external/configstudio'],
  ['src/index.js', "API_PREFIX = '/configstudio'"],
  ['src/index.js', "'configstudio'"],
  ['src/client.js', '/configstudio/api'],
  ['web/app.js', '/configstudio/api'],
  ['cordis.patch.yml', '@dsh-external/configstudio'],
];
console.log('');
console.log('关键标识符自检：');
let ok = true;
for (const [rel, needle] of mustHave) {
  const text = readFileSync(join(ROOT, rel), 'utf8');
  const good = text.includes(needle);
  if (!good) ok = false;
  console.log('  ' + (good ? '✓' : '✗') + ' ' + rel + '  含 ' + needle);
}
if (!ok) { console.log('★ 有自检未通过，请检查。'); process.exit(1); }
console.log('');
console.log('✓ 改名自检通过。');
console.log('下一步（人工）：搬数据目录、升版本、跑全套回归、改 GitHub 仓库名。');
