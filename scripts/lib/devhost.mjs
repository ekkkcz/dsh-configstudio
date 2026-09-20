/**
 * 验收脚本的共用小工具 —— 起一个真的开发服务器进程、发请求、收集断言。
 *
 * 为什么单独抽出来：M2 要写好几个"进程级"的验收脚本（重启恢复、超时/取消、
 * 截图失败）。如果每个脚本各自抄一份 起进程 / 等就绪 / 硬杀 / 发请求，
 * 它们迟早会像当年的 dev-server 与宿主半边那样漂移 —— 一处改好、另一处没改，
 * 于是"某条验收在 A 脚本里过、在 B 脚本里不过"。这里只留一份。
 *
 * @module scripts/lib/devhost
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { writeEvidence } from './redact.mjs';

export const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(here, '..', '..');
export const EVIDENCE_DIR = join(ROOT, 'docs', 'evidence');
mkdirSync(EVIDENCE_DIR, { recursive: true });

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 找一个空闲端口：不要把端口写死（本机 8901 曾被无关程序占用）。 */
export function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

/** 发请求并尽量解析 JSON。 */
export async function api(base, path, options) {
  const r = await fetch(base + path, options);
  const text = await r.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body };
}

export function postJson(base, path, payload) {
  return api(base, path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload ?? {}),
  });
}

/** 读纯文本响应（下载原始正文 / partial / HTML 用）。 */
export async function getText(base, path) {
  const r = await fetch(base + path);
  return { status: r.status, text: await r.text() };
}

/**
 * 起一个开发服务器子进程（模拟模型，零费用）。
 *
 * `root` 用来指定**加载哪一份产品代码**：默认是本仓库；M4 的升级/卸载验收会指向
 * 一个已安装的包目录，这样验证的才是"那份装出来的代码"，而不是"仓库里当前这份"。
 */
export function startDevServer({ port, dataDir, llmLog = null, latencyMs = 200, root = null }) {
  const argv = [join(ROOT, 'scripts', 'dev-server.mjs'), '--port', String(port), '--data', dataDir, '--latency', String(latencyMs)];
  if (root) argv.push('--root', root);
  if (llmLog) argv.push('--llm-log', llmLog);
  const child = spawn(process.execPath, argv, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  // 不读走管道会让子进程在输出较多时阻塞，这里只是丢弃输出
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});
  return child;
}

export async function waitHealthy(base, timeoutMs = 20000) {
  const t0 = Date.now();
  for (;;) {
    try {
      const r = await api(base, '/meta');
      if (r.status === 200) return r.body;
    } catch { /* 还没起来 */ }
    if (Date.now() - t0 > timeoutMs) throw new Error('等待服务器就绪超时：' + base);
    await sleep(250);
  }
}

/** 硬杀一个子进程：先 SIGKILL，没退就 taskkill /F（确保真的没了）。 */
export async function hardKill(child, label = '进程') {
  const exited = new Promise((r) => child.once('exit', (code, signal) => r({ code, signal })));
  try { child.kill('SIGKILL'); } catch { /* 已经退出 */ }
  const winner = await Promise.race([exited, sleep(4000).then(() => 'timeout')]);
  if (winner === 'timeout') {
    spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { windowsHide: true });
    await Promise.race([exited, sleep(4000)]);
  }
  const line = winner === 'timeout'
    ? 'SIGKILL 后 4 秒未退出，已用 taskkill /F 强制结束'
    : '进程已退出 ' + JSON.stringify(winner);
  console.log('  · 杀掉 ' + label + ' pid=' + child.pid + '：' + line);
  return line;
}

/** 模型调用日志里的调用次数 —— "不自动重付费"就是数这个。 */
export function logLines(path) {
  if (!path || !existsSync(path)) return 0;
  const t = readFileSync(path, 'utf8').trim();
  return t.length === 0 ? 0 : t.split(String.fromCharCode(10)).length;
}

/**
 * 断言收集器：add(区域, 断言名, 是否通过, 细节)，最后统一写证据文件。
 * 所有脚本用同一种输出格式与同一种落盘方式（走 redact.writeEvidence）。
 */
export function makeChecker({ what, note, extra = {} }) {
  const checks = [];
  const add = (area, name, ok, detail) => {
    checks.push({ area, name, ok: Boolean(ok), detail: detail === undefined ? null : detail });
    console.log((ok ? '  ✓ ' : '  ✗ ') + '[' + area + '] ' + name + (detail === undefined ? '' : '  ' + JSON.stringify(detail)));
  };
  const report = { startedAt: new Date().toISOString(), what, note, ...extra, checks };
  return {
    add,
    checks,
    report,
    /** 写证据并返回退出码（全绿 0，有失败 1）。 */
    finish(prefix) {
      const passed = checks.filter((c) => c.ok).length;
      report.summary = { passed, total: checks.length };
      report.finishedAt = new Date().toISOString();
      const file = join(EVIDENCE_DIR, prefix + '-' + Date.now() + '.json');
      writeEvidence(file, report);
      console.log('');
      console.log(passed + '/' + checks.length + ' 项通过');
      console.log('证据：' + file);
      return passed === checks.length ? 0 : 1;
    },
  };
}
