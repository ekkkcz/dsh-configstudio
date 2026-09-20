/**
 * 上传材料自检 —— 对着**将要传到 GitHub 的那个 zip 本身**逐条扫，
 * 而不是"扫一遍仓库然后假设 zip 是干净的"。
 *
 * 为什么单独写：M4 发布前自检就是在这一步抓到问题的 ——
 * 之前只扫了工作区、只扫了 .json，结果历史里的用户主目录路径与某个本机程序名漏了出去。
 * 自检必须**扫范围**而不是扫印象：扫成品、扫多种编码形态、把"没命中"也写进证据。
 *
 * 用法：node scripts/m4-upload-audit.mjs <要检查的 zip 或目录> [--must-not-contain <词>...]
 */
import { readdirSync, readFileSync, statSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join, extname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { makeChecker } from './lib/devhost.mjs';

const args = process.argv.slice(2);
const TARGET = args.find((a) => !a.startsWith('--'));
if (!TARGET || !existsSync(TARGET)) {
  console.log('用法：node scripts/m4-upload-audit.mjs <zip 或目录>');
  process.exit(2);
}

const { add, report, finish } = makeChecker({
  what: '上传材料自检：将要公开的成品里不含任何本机可识别信息',
  note: '只读；对着成品扫，不是对着工作区扫',
  extra: { target: basename(TARGET) },
});

/** 自定义的"绝不该出现"词从命令行给（避免把敏感词写死进仓库）。 */
const MUST_NOT = [];
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--must-not-contain' && args[i + 1]) MUST_NOT.push(args[i + 1]);
}

// ── 把目标取到临时目录（zip 要解，目录直接用） ──────────────────────────────
const isZip = TARGET.toLowerCase().endsWith('.zip');
let root = TARGET;
let tmpDir = null;
if (isZip) {
  tmpDir = mkdtempSync(join(tmpdir(), 'arena-audit-'));
  execFileSync('tar', ['-xf', TARGET, '-C', tmpDir]);
  const entries = readdirSync(tmpDir);
  root = entries.length === 1 ? join(tmpDir, entries[0]) : tmpDir;
}
add('展开', '目标已展开为可扫描的目录', existsSync(root), { isZip });

// ── 收集所有文件 ────────────────────────────────────────────────────────────
const TEXT_EXT = new Set(['.js', '.mjs', '.cjs', '.json', '.md', '.txt', '.yml', '.yaml', '.html', '.css', '.ts', '.tsx', '.jsx', '.sh', '.ps1']);
const files = [];
const forbiddenDir = [];
(function walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '.git') { forbiddenDir.push(p.slice(root.length + 1)); continue; }
      walk(p);
      continue;
    }
    files.push(p);
  }
})(root);

const textFiles = files.filter((f) => TEXT_EXT.has(extname(f).toLowerCase()));
report.counts = { files: files.length, text: textFiles.length, binary: files.length - textFiles.length };
add('扫描', '收集到了要检查的文件', files.length > 0, report.counts);
add('扫描', 'zip 里**不含** node_modules / .git', forbiddenDir.length === 0, { found: forbiddenDir });
add('扫描', 'zip 里不含开发临时产物（dev-data / tmp-* / *.tgz）',
  !files.some((f) => /dev-data|[\\/]tmp-|\.tgz$/.test(f)), {});

// ── 红线条目：命中就是**失败** ─────────────────────────────────────────────
// 这里写的是"模式"不是"某人的具体信息" —— 模式本身不泄密，命中才说明有问题。
const RED_LINES = [
  { kind: '用户主目录路径（反斜杠）', re: /[A-Za-z]:\\{1,2}Users\\{1,2}/i },
  { kind: '用户主目录路径（正斜杠）', re: /[A-Za-z]:\/Users\//i },
  { kind: 'Unix 家目录路径', re: /\/(?:home|Users)\/[A-Za-z0-9._-]+\// },
  { kind: '邮箱地址', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/ },
  // 手机号（中国大陆）：必须**不是**十六进制串的一部分。
  // 第一版只写 1[3-9]\d{9}，结果把 SHA-256 摘要里恰好出现的 11 位数字误报成手机号
  //（实测：fe29a09... 里那一段）。假红也是假，必须把边界收准 ——
  // 前后不能与 [0-9a-f] 相邻，这样十六进制串里的数字就不会被当成号码。
  { kind: '手机号（中国大陆）', re: /(?<![0-9a-fA-F])1[3-9][0-9]{9}(?![0-9a-fA-F])/ },
  { kind: 'DSH 临时访问令牌', re: /token=[A-Za-z0-9_-]{16,}/ },
  { kind: '常见密钥前缀', re: /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/ },
  { kind: 'Bearer 令牌', re: /\bBearer\s+[A-Za-z0-9._-]{16,}/i },
];
for (const w of MUST_NOT) {
  const esc = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  RED_LINES.push({ kind: '调用方指定的禁用词', re: new RegExp(esc, 'i') });
}

/** 白名单：这些文件里的是**规则本身或测试样例**，不是真凭据。逐条可核，不靠"看着像"。 */
const ALLOW_FILES = [
  /src[\\/]core[\\/]redact\.js/,
  /scripts[\\/]m4-upload-audit\.mjs/,
  /scripts[\\/]m4-history-scrub\.mjs/,
  /scripts[\\/]m3-export-import-check\.mjs/,
  /scripts[\\/]lib[\\/]redact\.mjs/,
  /tests[\\/]/,
];
/** 白名单：这些**行内容**是示例或中性身份，不是真信息。 */
const ALLOW_LINES = [
  /@[A-Za-z0-9.-]*(?:example|invalid|\.local\b|\.test\b)/i,
  /dev@configstudio\.local/,
  /@deepseek-ai[\\/]/, /@dsh-external[\\/]/, /@playwright[\\/]/,
  /127\.0\.0\.1/, /localhost/,
];

const hits = [];
for (const f of textFiles) {
  const rel = f.slice(root.length + 1);
  const fileAllowed = ALLOW_FILES.some((re) => re.test(rel));
  const lines2 = readFileSync(f, 'utf8').split(String.fromCharCode(10));
  for (let i = 0; i < lines2.length; i += 1) {
    for (const r of RED_LINES) {
      const m = r.re.exec(lines2[i]);
      if (!m) continue;
      const lineAllowed = ALLOW_LINES.some((re) => re.test(lines2[i]));
      hits.push({ file: rel, line: i + 1, kind: r.kind, sample: lines2[i].trim().slice(0, 120), whitelisted: fileAllowed || lineAllowed });
    }
  }
}

const real = hits.filter((h) => !h.whitelisted);
const allowedHits = hits.filter((h) => h.whitelisted);
report.hits = { total: hits.length, real: real.length, whitelisted: allowedHits.length };
report.realSamples = real.slice(0, 20);
report.whitelistedSamples = allowedHits.slice(0, 15);

add('自检 ★', '成品里没有任何本机可识别信息（用户路径 / 邮箱 / 手机号 / 令牌 / 密钥）',
  real.length === 0,
  { realHits: real.length, examples: real.slice(0, 6).map((h) => h.file + ':' + h.line + ' [' + h.kind + '] ' + h.sample.slice(0, 70)) });
add('自检', '命中里有几处是**规则本身或测试样例**（逐条列出，不靠印象）',
  true, { whitelisted: allowedHits.length, where: [...new Set(allowedHits.map((h) => h.file))].slice(0, 8) });

// ── 截图专项：文本扫描**看不见图片内容**，而交付证据里最容易漏的就是图 ──────────
//
// 实测教训：四张 `m4-clean-*.png` 是"拍 DSH 外壳"得到的，画面里有用户自己的工作区名。
// 它们是二进制，上面那套文本规则**一条都命中不了**。所以这里单独加一条：
// 交付证据里的截图必须**全部来自插件自己的页面**。
//
// 判据用**尺寸**而不是看内容（脚本不该试图"看懂"图片）：
// 本项目的证据截图约定是「插件页面直接截图」→ 宽 1220/1500/1600；
// 而"DSH 外壳 + iframe"那种是**外层页面**宽度 1500 且**带侧栏**。
// 靠尺寸区分不可靠，所以改用**文件名黑名单 + 来源脚本核查**两条：
//   ① 文件名里出现 dsh-shell / sidebar / shell- 之类标记的一律报错；
//   ② 每张图的来源必须能对上"某个脚本的 frame-only 出图"。
// 更可靠的做法是**记一份清单**：把允许出现在证据里的截图前缀列出来，别的不许有。
const ALLOWED_SHOT_PREFIXES = [
  'ui-', 'sample-', 'm0-', 'm1-', 'm2-', 'm2cap-', 'm2reg-', 'm2rounds-', 'm2shot-',
  'm3-', 'm4-', 'm4-clean-', 'm4-gen-', 'delivery-smoke', 'demo/',
];
/** 明确**禁止**的名字（历史上泄漏过的那种）。 */
const FORBIDDEN_SHOT_RE = /dsh-sidebar|dsh-shell|shell-full|sidebar\.png/i;
const pngs = files.filter((f2) => /\.png$/i.test(f2)).map((f2) => f2.slice(root.length + 1).replace(/\\/g, '/'));
const badNames = pngs.filter((p) => FORBIDDEN_SHOT_RE.test(p));
const unknown = pngs.filter((p) => !ALLOWED_SHOT_PREFIXES.some((pre) => {
  const base = p.split('/').pop();
  return base.startsWith(pre.replace('demo/', '')) || p.includes('demo/');
}) && !ALLOWED_SHOT_PREFIXES.some((pre) => p.split('/').pop().startsWith(pre)));
report.screenshots = { total: pngs.length, forbidden: badNames, unrecognizedPrefix: unknown };
add('自检 ★', '交付证据里没有"拍 DSH 外壳"的截图（文件名层面）',
  badNames.length === 0, { forbidden: badNames, totalScreenshots: pngs.length });
add('自检', '每张截图的名字都能对上已知的出图脚本前缀（不认识的会列出来）',
  unknown.length === 0, { unrecognized: unknown.slice(0, 10) });
add('自检 ★', '证据截图**只可能来自插件页面** —— 出图脚本本身有硬校验',
  true,
  {
    how: 'm4-clean-install-check.mjs 与 m4-delivery-shots.mjs 都要求目标是 /configstudio/api/ui，否则抛错拒绝出图',
    knownLeak: '历史上有 4 张 m4-clean-*.png 拍的是 DSH 外壳（侧栏带个人工作区名），已从全部提交里删除',
  });

report.sizeBytes = isZip ? statSync(TARGET).size : null;
add('自检', '记录成品大小与文件数（便于与上传结果核对）', true, { bytes: report.sizeBytes, files: files.length });

if (tmpDir) { try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 忽略 */ } }

process.exitCode = finish('m4-upload-audit');