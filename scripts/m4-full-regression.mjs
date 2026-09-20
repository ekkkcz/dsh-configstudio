/**
 * M4-3 完整回归运行器 —— 把 tests/ 与 scripts/ 下的验收套件**一次跑齐**，
 * 落一份机器可读的报告，并明确列出"哪些必需项**没被任何套件覆盖**"。
 *
 * 为什么需要它：M1–M3 每一轮的回归基线都是**手工敲一串命令**得到的。手工做这件事有两个问题：
 *   1. 漏跑不会有任何提示（"我记得跑过了"）；
 *   2. 报告里的数字是手抄的，跟实际输出对不上也不会有人发现。
 * 这个运行器把"跑什么、跑成什么样、哪些没覆盖"变成一份**可复核的文件**。
 *
 * 用法：
 *   node scripts/m4-full-regression.mjs                 # 全跑（默认）
 *   node scripts/m4-full-regression.mjs --only m3-      # 只跑名字带 m3- 的
 *   node scripts/m4-full-regression.mjs --skip-slow     # 跳过耗时的隔离试验
 */
import { spawn } from 'node:child_process';
import { mkdirSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EVIDENCE_DIR, freePort, sleep } from './lib/devhost.mjs';
import { writeEvidence } from './lib/redact.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..');
const args = process.argv.slice(2);
const getArg = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const ONLY = getArg('--only', null);
const SKIP_SLOW = args.includes('--skip-slow');

// ── 套件清单 ───────────────────────────────────────────────────────────────
// 每条都写明：跑什么、需要哪个 base、对应哪些 A 编号。A 编号列在这里是为了让
// "未覆盖的必需项"这个结论**能自动算出来**，而不是靠人回想。
const DEV = 'http://127.0.0.1:8790';
const DSH = 'http://127.0.0.1:8902';

const SUITES = [
  { name: 'node --test', cmd: ['node', '--test', 'tests/**/*.test.js'], cwd: ROOT, kind: 'unit',
    covers: ['A02', 'A03', 'A05', 'A06', 'A07', 'A08', 'A09', 'A11', 'A12', 'A18', 'A19', 'A20', 'A21', 'A22', 'A24', 'A25', 'A26', 'A27', 'A29'],
    // A18 的"只用模拟不算数"那部分由 m4-a18-usage-scan 单独扫真实数据，见下面那条。
    note: '单元与集成测试（模拟模型，零费用）' },

  { name: 'ui-walkthrough', cmd: ['node', 'scripts/ui-walkthrough.mjs', '--base', DEV], cwd: ROOT, kind: 'ui',
    covers: ['A01', 'A03', 'A05', 'A11', 'A12', 'A14', 'A15', 'A16'],
    note: '真实浏览器端到端演练（模拟模型）' },

  { name: 'm0-isolation-experiment', cmd: ['node', 'scripts/m0-isolation-experiment.mjs'], cwd: ROOT, kind: 'isolation',
    covers: ['A19', 'A20', 'A21', 'A22'], slow: true,
    note: '隔离边界试验（真实 Chromium 子进程）' },

  { name: 'm1-samples-check', cmd: ['node', 'scripts/m1-samples-check.mjs'], cwd: ROOT, kind: 'ui',
    covers: ['A13'], note: '六类固定样例真实渲染与交互' },

  { name: 'm1-compare-walkthrough', cmd: ['node', 'scripts/m1-compare-walkthrough.mjs', '--base', DSH, '--title', 'M2 实时监控验证', '--fail-title', 'M1 真实对比'],
    cwd: ROOT, kind: 'ui', covers: ['A14', 'A15', 'A16', 'A23'], needs: ['dsh-8902'],
    note: '对比页实测（真实 DSH + 真实模型作品，零费用）' },

  { name: 'm2-ui-walkthrough', cmd: ['node', 'scripts/m2-ui-walkthrough.mjs', '--base', DSH, '--skip-optimize'], cwd: ROOT, kind: 'ui',
    covers: ['A11'], needs: ['dsh-8902'], note: 'M2 界面三项（预置 / 实时流 / 优化器对接）' },

  { name: 'm2-regression-walkthrough', cmd: ['node', 'scripts/m2-regression-walkthrough.mjs', '--base', DEV], cwd: ROOT, kind: 'ui',
    covers: ['A14'], note: '重绘不打断用户操作' },

  { name: 'm2-rounds-walkthrough', cmd: ['node', 'scripts/m2-rounds-walkthrough.mjs'], cwd: ROOT, kind: 'selfhost',
    covers: ['A03'], note: '追加轮次（自带服务，模拟模型）' },

  { name: 'm2-capability-walkthrough', cmd: ['node', 'scripts/m2-capability-walkthrough.mjs', '--base', DSH], cwd: ROOT, kind: 'ui',
    covers: ['A01'], needs: ['dsh-8902'], note: '外部能力开关（默认关）' },

  { name: 'm2-four-walkthrough', cmd: ['node', 'scripts/m2-four-walkthrough.mjs', '--base', DSH, '--title', 'M2 四候选对比'], cwd: ROOT, kind: 'ui',
    covers: ['A06', 'A14', 'A15'], needs: ['dsh-8902'], note: '四候选对比页 + 展开配置 + 盲选脱敏' },

  { name: 'm2-screenshot-redraw-check', cmd: ['node', 'scripts/m2-screenshot-redraw-check.mjs', '--base', DSH, '--title', 'M2 实时监控验证'], cwd: ROOT, kind: 'ui',
    covers: ['A23'], needs: ['dsh-8902'], note: '截图不重置作品（含对照组）' },

  { name: 'm2-usage-metrics-check', cmd: ['node', 'scripts/m2-usage-metrics-check.mjs', '--base', DSH, '--title', 'M2 实时监控验证', '--base-null', DEV, '--title-null', 'M2 轮询不打断操作'],
    cwd: ROOT, kind: 'ui', covers: ['A18', 'A15'], needs: ['dsh-8902', 'dev-8790'],
    note: '用量与速度口径（含"未上报"路径）' },

  { name: 'm2-horizontal-compare-check', cmd: ['node', 'scripts/m2-horizontal-compare-check.mjs', '--base', DSH, '--title', '写个秦始皇骑北极熊'], cwd: ROOT, kind: 'ui',
    covers: ['A14'], needs: ['dsh-8902'], note: '水平展开比对与手机视口撑满' },

  { name: 'm2-recipes-check', cmd: ['node', 'scripts/m2-recipes-check.mjs'], cwd: ROOT, kind: 'selfhost',
    covers: ['A03'], note: '配方版本全流程（自带服务，模拟模型）' },

  { name: 'm2-restart-recovery-check', cmd: ['node', 'scripts/m2-restart-recovery-check.mjs'], cwd: ROOT, kind: 'selfhost',
    covers: ['A09'], note: '真 SIGKILL 后重启恢复' },

  { name: 'm2-timeout-check', cmd: ['node', 'scripts/m2-timeout-check.mjs'], cwd: ROOT, kind: 'selfhost',
    covers: ['A08'], note: '超时与取消（自带服务，模拟模型）' },

  { name: 'm2-screenshot-failure-check', cmd: ['node', 'scripts/m2-screenshot-failure-check.mjs'], cwd: ROOT, kind: 'selfhost',
    covers: ['A23'], note: '截图失败也有落盘记录' },

  { name: 'm3-export-import-check', cmd: ['node', 'scripts/m3-export-import-check.mjs'], cwd: ROOT, kind: 'selfhost',
    covers: ['A24', 'A25', 'A26', 'A27'], note: '展示包 / 复测包导出导入往返' },

  { name: 'm3-history-check', cmd: ['node', 'scripts/m3-history-check.mjs'], cwd: ROOT, kind: 'selfhost',
    covers: ['A03'], note: '历史搜索与筛选 / 复制实验 / 列表导出' },

  { name: 'm3-cdn-check', cmd: ['node', 'scripts/m3-cdn-check.mjs'], cwd: ROOT, kind: 'selfhost',
    covers: ['A17'], note: '受控 CDN 真实网络（offline 拦截 / cdn 200）' },

  { name: 'm3-ten-rounds-check', cmd: ['node', 'scripts/m3-ten-rounds-check.mjs'], cwd: ROOT, kind: 'selfhost',
    covers: ['A28'], note: '连续十轮并停止全部预览' },

  { name: 'm3-input-limit-check', cmd: ['node', 'scripts/m3-input-limit-check.mjs'], cwd: ROOT, kind: 'selfhost',
    covers: ['A10'], note: '输入超限的真实界面验证' },

  { name: 'm3-real-pack-check', cmd: ['node', 'scripts/m3-real-pack-check.mjs', '--base', DSH, '--title', 'M2 实时监控验证'], cwd: ROOT, kind: 'ui',
    covers: ['A30'], needs: ['dsh-8902'], note: '真实模型实验的导出 / 导入（零费用）' },

  { name: 'm4-clean-install-check', cmd: ['node', 'scripts/m4-clean-install-check.mjs', '--base', 'http://127.0.0.1:8909', '--expect-version', '0.7.0'], cwd: ROOT, kind: 'ui',
    covers: ['A01'], needs: ['dsh-8909'], optional: true, note: '干净安装的真实用户路径走查（需要 8909 实例，token 从 docs/evidence/.dsh-token-8909.txt 读）' },

  { name: 'm4-clean-generate-check', cmd: ['node', 'scripts/m4-clean-generate-check.mjs', '--base', 'http://127.0.0.1:8910'], cwd: ROOT, kind: 'ui',
    covers: ['A02', 'A14', 'A15', 'A23', 'A24', 'A25', 'A30'], needs: ['dsh-8910'], optional: true,
    note: '干净安装的完整用户路径（生成 → 对比 → 盲选 → 揭晓 → 导出），模拟 provider 零费用' },

  { name: 'm4-upgrade-uninstall-check', cmd: ['node', 'scripts/m4-upgrade-uninstall-check.mjs'], cwd: ROOT, kind: 'selfhost',
    covers: ['A01', 'A29'], slow: true,
    note: '0.4.0 → 0.5.0 升级、schema 迁移与回退边界、卸载后数据保留（自建临时 profile；老交付包按当时的文件名找）' },

  { name: 'm5-run-limit-check', cmd: ['node', 'scripts/m5-run-limit-check.mjs'], cwd: ROOT, kind: 'ui', slow: true,
    covers: ['A08', 'A12', 'A04'],
    note: '运行上限：界面上改得动、超时提示指得动路、改完能重跑这一个候选（含多块选择，真实 Chromium）' },

  { name: 'm4-a04-adapter-probe', cmd: ['node', 'scripts/m4-a04-adapter-probe.mjs'], cwd: ROOT, kind: 'probe',
    covers: ['A04'], needs: ['dsh-8902'], note: 'A04：实测 resolveModelInfo 到底有没有温度/输出上限的"支持性"字段（接口 + 类型声明两口径）' },

  { name: 'm4-a18-usage-scan', cmd: ['node', 'scripts/m4-a18-usage-scan.mjs'], cwd: ROOT, kind: 'probe',
    covers: ['A18'], needs: ['dsh-8902'], note: 'A18：扫全部真实模型的 attempt，找"没上报用量"的真实实例（只读，零费用）' },

  { name: 'delivery-smoke', cmd: ['node', 'scripts/delivery-smoke.mjs', '--base', 'http://127.0.0.1:8908', '--expect-version', '0.7.0'], cwd: ROOT, kind: 'ui',
    covers: ['A01'], needs: ['dsh-8908'], note: '交付物冒烟（装的是交付区 tgz）' },
];

// ── A01–A30 的必需要求（来自 方案区/ACCEPTANCE.md） ──────────────────────────
const ALL_A = Array.from({ length: 30 }, (_, i) => 'A' + String(i + 1).padStart(2, '0'));

/** 端口探活：某条套件声明的依赖没起时，明确报"缺服务"而不是让它跑出莫名其妙的失败。 */
async function serviceUp(key) {
  const map = { 'dev-8790': 'http://127.0.0.1:8790/configstudio/api/meta', 'dsh-8902': 'http://127.0.0.1:8902/configstudio/api/meta', 'dsh-8908': 'http://127.0.0.1:8908/configstudio/api/meta', 'dsh-8909': 'http://127.0.0.1:8909/configstudio/api/meta', 'dsh-8910': 'http://127.0.0.1:8910/configstudio/api/meta' };
  try { const r = await fetch(map[key], { signal: AbortSignal.timeout(5000) }); return r.status === 200; } catch { return false; }
}

function runSuite(suite) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    // 不用 shell：`node --test "tests/**/*.test.js"` 的 glob 由 node 自己展开，
    // 交给 shell 反而会被 cmd/pwsh 改写（第一版就是这么把 153 个测试跑成失败的）。
    const child = spawn(suite.cmd[0], suite.cmd.slice(1), { cwd: suite.cwd, windowsHide: true });
    let out = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { out += d.toString(); });
    child.on('close', (code) => resolve({ code, out, ms: Date.now() - t0 }));
  });
}

/** 从输出里抽"通过数/总数"：各脚本的收尾行格式统一为 "N/M 项通过"。 */
function parseCounts(text) {
  const m = [...text.matchAll(/(\d+)\s*\/\s*(\d+)\s*项通过/g)];
  if (m.length) { const last = m[m.length - 1]; return { passed: Number(last[1]), total: Number(last[2]) }; }
  const steps = /(\d+)\s*步全通过/.exec(text);
  if (steps) return { passed: Number(steps[1]), total: Number(steps[1]), unit: '步' };
  const t = /# pass (\d+)/.exec(text);
  const f = /# fail (\d+)/.exec(text);
  if (t) return { passed: Number(t[1]), total: Number(t[1]) + (f ? Number(f[1]) : 0) };
  return null;
}

const report = { startedAt: new Date().toISOString(), note: 'M4-3 完整回归：一次跑齐 tests/ 与 scripts/ 的验收套件', suites: [] };
mkdirSync(EVIDENCE_DIR, { recursive: true });

// 每跑完一条就**立刻**落盘一次。整套要跑十几分钟，中途被杀（工具超时、手滑 Ctrl-C）时
// 至少能留下一份"跑到哪了、哪些已经通过"的报告 —— 第一版是在最后才写的，
// 结果被中途掐掉之后什么都没留下。
const LIVE_FILE = join(EVIDENCE_DIR, 'm4-full-regression-live.json');
const flush = () => {
  report.summaryNow = {
    done: report.suites.length,
    ok: report.suites.filter((s) => s.ok === true).length,
    failed: report.suites.filter((s) => s.ok === false).length,
    skipped: report.suites.filter((s) => s.skipped).length,
  };
  try { writeEvidence(LIVE_FILE, report); } catch { /* 落盘失败不影响继续跑 */ }
};

console.log('M4-3 完整回归（一次跑齐）');
console.log('─'.repeat(72));

for (const suite of SUITES) {
  if (ONLY && !suite.name.includes(ONLY)) continue;
  if (SKIP_SLOW && suite.slow) { console.log('  ⤼ ' + suite.name + '（--skip-slow 跳过）'); report.suites.push({ name: suite.name, skipped: true, reason: '--skip-slow', covers: suite.covers }); flush(); continue; }

  // 依赖的服务没起 → 记录为"缺服务"，不算产品失败（但要显眼）
  let missing = null;
  for (const dep of suite.needs || []) { if (!(await serviceUp(dep))) { missing = dep; break; } }
  if (missing) {
    console.log('  ⚠ ' + suite.name + ' 跳过：依赖的 ' + missing + ' 没有在跑');
    report.suites.push({ name: suite.name, skipped: true, reason: 'missing-service:' + missing, covers: suite.covers, note: suite.note });
    flush();
    continue;
  }

  process.stdout.write('  … ' + suite.name + ' ');
  const r = await runSuite(suite);
  const counts = parseCounts(r.out);
  const pass = r.code === 0;
  console.log((pass ? '✓' : '✗') + '  ' + (counts ? counts.passed + '/' + counts.total : '退出码 ' + r.code) + '  (' + Math.round(r.ms / 1000) + 's)');
  if (!pass) {
    const tail = r.out.split(String.fromCharCode(10)).filter((l) => l.includes('✗') || /Error|错误|failed/.test(l)).slice(0, 6);
    for (const l of tail) console.log('      ' + l.trim().slice(0, 150));
  }
  report.suites.push({
    name: suite.name, ok: pass, exitCode: r.code, ms: r.ms, cmd: suite.cmd.join(' '),
    counts, covers: suite.covers, note: suite.note,
    tail: pass ? null : r.out.slice(-2500),
  });
  flush();
}

// ── 覆盖统计：哪些 A 编号被哪些套件覆盖，哪些**没有被任何套件覆盖** ────────
const covered = new Map();
for (const s of report.suites) {
  if (s.skipped) continue;
  for (const a of s.covers || []) {
    if (!covered.has(a)) covered.set(a, []);
    covered.get(a).push(s.name + (s.ok ? '' : '(失败)'));
  }
}
const uncovered = ALL_A.filter((a) => !covered.has(a));
report.coverage = {
  declared: ALL_A,
  coveredBy: Object.fromEntries([...covered.entries()].sort()),
  uncovered,
};
report.summary = {
  total: report.suites.length,
  ok: report.suites.filter((s) => s.ok === true).length,
  failed: report.suites.filter((s) => s.ok === false).length,
  skipped: report.suites.filter((s) => s.skipped).length,
};
report.finishedAt = new Date().toISOString();

console.log('─'.repeat(72));
console.log('套件：' + report.summary.ok + ' 通过 / ' + report.summary.failed + ' 失败 / ' + report.summary.skipped + ' 跳过（共 ' + report.summary.total + '）');
console.log('A 编号覆盖：' + covered.size + '/30');
if (uncovered.length) console.log('★ 没有被任何套件覆盖的必需项：' + uncovered.join(' '));
if (report.summary.skipped) {
  console.log('★ 跳过的套件：');
  for (const s of report.suites.filter((x) => x.skipped)) console.log('    ' + s.name + ' —— ' + s.reason);
}
const file = join(EVIDENCE_DIR, 'm4-full-regression-' + Date.now() + '.json');
writeEvidence(file, report);
console.log('证据：' + file);
console.log('（JSON 里带着每个失败套件的输出尾部与逐条 A 编号覆盖表；跑的过程中' +
  '实时更新的进度在同目录的 m4-full-regression-live.json，中途被杀也能看到跑到哪了）');
process.exitCode = report.summary.failed === 0 ? 0 : 1;
