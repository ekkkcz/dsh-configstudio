/**
 * DSH 契约只读探测 —— 升级 DSH 后跑一次，确认本插件依赖的接口还在。
 *
 * 它**只读**：不发模型调用、不写文件、不产生费用。
 * 运行：node scripts/dsh-contract-check.mjs [--dsh <dsh 包目录>]
 *
 * 检查项对应 docs/dsh-integration.md 第 4 节。
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const dshArg = args.indexOf('--dsh');
const DSHS = dshArg >= 0 ? args[dshArg + 1] : [
  process.env.APPDATA ? join(process.env.APPDATA, 'npm', 'node_modules', '@deepseek-ai', 'dsh') : null,
  process.env.USERPROFILE ? join(process.env.USERPROFILE, 'AppData', 'Roaming', 'npm', 'node_modules', '@deepseek-ai', 'dsh') : null,
].filter(Boolean);

const results = [];
function check(name, fn) {
  try {
    const r = fn();
    results.push({ name, ok: r.ok !== false, detail: r.detail ?? null });
  } catch (err) {
    results.push({ name, ok: false, detail: '探测抛错：' + String(err && err.message || err).slice(0, 200) });
  }
}

/** 在 DSH 安装目录里找一个包，返回它的 package.json。 */
function dshPkg(name) {
  for (const root of DSHS) {
    const p = join(root, 'node_modules', '@deepseek-ai', name, 'package.json');
    if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8'));
    // 有的包被提升到 dsh 自己的 node_modules 之外
    const alt = join(root, 'package.json');
    if (existsSync(alt)) {
      const j = JSON.parse(readFileSync(alt, 'utf8'));
      if (j.dependencies && j.dependencies['@deepseek-ai/' + name]) return { version: j.dependencies['@deepseek-ai/' + name], viaRoot: true };
    }
  }
  return null;
}

check('DSH 安装可定位', () => {
  const found = DSHS.filter((d) => existsSync(d));
  return { ok: found.length > 0, detail: found[0] ?? '未找到安装目录（可用 --dsh 指定）' };
});

check('DSH 版本可读', () => {
  for (const d of DSHS) {
    const p = join(d, 'package.json');
    if (existsSync(p)) {
      const j = JSON.parse(readFileSync(p, 'utf8'));
      return { detail: j.version };
    }
  }
  return { ok: false, detail: '读不到 package.json' };
});

check('llm 服务包存在（ctx.llm / GenerateOptions）', () => {
  const j = dshPkg('dsh-llm');
  return { ok: Boolean(j), detail: j ? (j.version ?? 'declared') : '未找到 @deepseek-ai/dsh-llm' };
});

check('webserver 包存在（ctx.webServer.register）', () => {
  const j = dshPkg('dsh-host-webserver');
  return { ok: Boolean(j), detail: j ? (j.version ?? 'declared') : '未找到 @deepseek-ai/dsh-host-webserver' };
});

check('客户端模块包存在（__ModuleLoader__ 装载外部 client）', () => {
  const j = dshPkg('dsh-client-modules');
  return { ok: Boolean(j), detail: j ? (j.version ?? 'declared') : '未找到 @deepseek-ai/dsh-client-modules' };
});

check('插槽包存在（ui-slots）', () => {
  const j = dshPkg('dsh-client-ui-slots');
  return { ok: Boolean(j), detail: j ? (j.version ?? 'declared') : '未找到 @deepseek-ai/dsh-client-ui-slots' };
});

// 本插件自己声明的契约（不依赖 DSH 安装，永远可查）
// 注意：不能用 URL.pathname —— 中文路径会被百分号编码，导致 ENOENT。
const here = fileURLToPath(new URL('..', import.meta.url));
check('本插件 manifest 完整（dsh.bundle + dsh.client + exports["./client"]）', () => {
  const p = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8'));
  const missing = [];
  if (!p.dsh?.bundle?.patch) missing.push('dsh.bundle.patch');
  if (p.dsh?.client?.platform !== 'web') missing.push('dsh.client.platform=web');
  if (!p.exports?.['./client']?.default) missing.push('exports["./client"]');
  if (!p.exports?.['.']?.default) missing.push('exports["."]');
  if (!p.main) missing.push('main');
  return { ok: missing.length === 0, detail: missing.length ? '缺少：' + missing.join(', ') : null };
});

check('界面资源存在', () => {
  const need = ['index.html', 'app.css', 'app.js', 'output-policy.js'];
  const missing = need.filter((f) => !existsSync(join(here, 'web', f)));
  return { ok: missing.length === 0, detail: missing.length ? '缺少：' + missing.join(', ') : null };
});

const failed = results.filter((r) => !r.ok);
console.log(JSON.stringify({ checkedAt: new Date().toISOString(), results, passed: results.length - failed.length, failed: failed.length }, null, 2));
process.exit(failed.length === 0 ? 0 : 1);
