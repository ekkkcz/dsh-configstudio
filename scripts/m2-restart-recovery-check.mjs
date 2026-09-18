/**
 * A09 完整回归 —— **生成到一半真的杀掉进程，再重新起来**。
 *
 * 与单测的分工：tests/stability.test.js 验证的是逻辑（状态怎么标、有没有新建 attempt）；
 * 这个脚本验证的是**进程级**的事实：一个真的 node 进程在流式生成中途被 SIGKILL，
 * 数据目录原封不动地交给下一个进程，然后逐条核对：
 *
 *   ① 未完成的那次被标成 interrupted（不是永远停在 running）；
 *   ② 已完成的作品可恢复：正文逐字节不变、HTML 仍能下载；
 *   ③ 不自动重付费：没有新建 attempt，也没有发生任何新的模型调用（用模型调用日志核对）；
 *   ④ 被杀之前收到的正文**真的留在磁盘上**（partial），界面能把它交出来；
 *   ⑤ 用户显式点重试才会新建 attempt（费用由用户自己触发）。
 *
 * 全程零模型费用：用的是模拟模型（scripts/simulated-llm.mjs），产物明确标注为模拟结果。
 *
 * 用法：node scripts/m2-restart-recovery-check.mjs
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchBrowser } from '../src/preview/browser.js';
// 起进程 / 发请求 / 硬杀 / 计数这些工具只有一份（scripts/lib/devhost.mjs）：
// 三个进程级验收脚本各抄一份的话，迟早会像 dev-server 与宿主半边那样漂移。
import {
  EVIDENCE_DIR, ROOT, sleep, freePort, api, postJson, getText,
  startDevServer, waitHealthy, hardKill, logLines, makeChecker,
} from './lib/devhost.mjs';

const { add, report, finish } = makeChecker({
  what: 'A09：生成中途 SIGKILL 掉开发服务器进程，重启后核对状态、作品恢复与"不自动重付费"',
  note: '模拟模型，零费用；产物是模拟结果，不是真实模型输出',
});

const startServer = (port, dataDir, logPath) => startDevServer({ port, dataDir, llmLog: logPath, latencyMs: 200 });

const dataDir = mkdtempSync(join(tmpdir(), 'arena-restart-'));
const logPath = join(dataDir, 'llm-calls.jsonl');
const port = await freePort();
const base = 'http://127.0.0.1:' + port + '/html-arena/api';
let server = startServer(port, dataDir, logPath);
let browserHandle = null;

try {
  await waitHealthy(base);
  add('准备', '第一个开发服务器进程已就绪', true, { port, dataDir });

  // ── 发起一轮两个候选：A 很快跑完，B 很慢（会在中途被杀） ──────────────
  const created = await postJson(base, '/experiments', {
    title: 'M2 重启恢复（模拟模型）',
    prompt: '做一个用于验证重启恢复的页面',
    outputPolicy: { timeoutMs: 120000, concurrency: 2 },
  });
  add('准备', '创建实验', created.status === 201, created.body.experiment && created.body.experiment.id);
  const expId = created.body.experiment.id;

  await postJson(base, '/experiments/' + expId + '/start', {
    concurrency: 2,
    candidates: [
      { name: '快的（会跑完）', provider: 'sim-ok-a', model: 'sim-fast' },
      { name: '慢的（会被杀）', provider: 'sim-slow', model: 'sim-slow-1' },
    ],
  });

  // 等到：A 完成、B 正在跑且有实时正文
  let beforeKill = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 30000) {
    const d = await api(base, '/experiments/' + expId);
    const live = await api(base, '/experiments/' + expId + '/live');
    const a = d.body.attempts.find((x) => x.slot === 0);
    const b = d.body.attempts.find((x) => x.slot === 1);
    const bLive = (live.body.streams || []).find((s) => s.attemptId === b.id);
    if (a.status === 'completed' && b.status === 'running' && bLive && bLive.text.length > 200) {
      beforeKill = { d: d.body, a, b, bLive };
      break;
    }
    await sleep(200);
  }
  if (!beforeKill) throw new Error('没能在 30 秒内进入"A 已完成、B 正在吐"的状态');
  add('准备', '进入"生成到一半"的状态：A 已完成，B 正在流式输出', true,
    { a: beforeKill.a.status, b: beforeKill.b.status, bLiveChars: beforeKill.bLive.text.length });

  const rawABefore = await getText(base, '/experiments/' + expId + '/attempts/' + beforeKill.a.id + '/raw');
  // 部分输出是 text/plain，要用 getText 读（api() 会尝试解析 JSON）
  const partialBBeforeKill = await getText(base, '/experiments/' + expId + '/attempts/' + beforeKill.b.id + '/partial');
  const attemptsBefore = beforeKill.d.attempts.length;
  const callsBefore = logLines(logPath);
  report.beforeKill = {
    experimentId: expId,
    attempts: beforeKill.d.attempts.map((a) => ({ id: a.id, slot: a.slot, status: a.status })),
    aRawBytes: rawABefore.text.length,
    bPartialStatus: partialBBeforeKill.status,
    bPartialChars: partialBBeforeKill.status === 200 ? partialBBeforeKill.text.length : 0,
    llmCalls: callsBefore,
    liveCharsAtKill: beforeKill.bLive.text.length,
  };
  add('被杀之前', 'B 在磁盘上已经有部分输出（不是只在内存里）',
    partialBBeforeKill.status === 200 && partialBBeforeKill.text.length > 0,
    { httpStatus: partialBBeforeKill.status, chars: partialBBeforeKill.text.length });

  // ── 真的杀掉进程 ─────────────────────────────────────────────
  const killLine = await hardKill(server, '开发服务器 #1');
  report.kill = killLine;
  await sleep(300);

  // ── 重新起来 ─────────────────────────────────────────────────
  server = startServer(port, dataDir, logPath);
  await waitHealthy(base);
  add('重启', '第二个开发服务器进程已就绪（同一个数据目录）', true, { port });

  const after = await api(base, '/experiments/' + expId);
  const aAfter = after.body.attempts.find((x) => x.id === beforeKill.a.id);
  const bAfter = after.body.attempts.find((x) => x.id === beforeKill.b.id);

  add('A09', '未完成的那次被标成 interrupted（不是永远停在 running）',
    bAfter && bAfter.status === 'interrupted', bAfter ? bAfter.status : null);
  add('A09', '已完成的那次仍然是 completed，没有被改写',
    aAfter && aAfter.status === 'completed', aAfter ? aAfter.status : null);
  add('A09', '中断原因写清楚了，且说明不会自动重跑',
    Boolean(bAfter && bAfter.error && /重启/.test(bAfter.error.title) && /不会自动重跑|不会重新计费/.test(bAfter.error.hint)),
    bAfter && bAfter.error ? { title: bAfter.error.title, hint: bAfter.error.hint } : null);

  // 已完成作品可恢复：正文逐字节不变 + HTML 仍可下载
  const rawAAfter = await getText(base, '/experiments/' + expId + '/attempts/' + beforeKill.a.id + '/raw');
  add('A09', '已完成作品的正文逐字节不变（hash 与长度都对得上）',
    rawAAfter.status === 200 && rawAAfter.text === rawABefore.text,
    { before: rawABefore.text.length, after: rawAAfter.text.length });
  const htmlAAfter = await getText(base, '/experiments/' + expId + '/attempts/' + beforeKill.a.id + '/html');
  add('A09', '已完成作品的 HTML 仍然可以下载', htmlAAfter.status === 200 && htmlAAfter.text.length > 0,
    { status: htmlAAfter.status, bytes: htmlAAfter.text.length });

  // 不自动重付费：没有新 attempt、没有新的模型调用
  add('A09', '没有自动新建 attempt（attempt 数量不变）',
    after.body.attempts.length === attemptsBefore,
    { before: attemptsBefore, after: after.body.attempts.length });
  const callsAfter = logLines(logPath);
  add('A09', '重启后没有发生任何新的模型调用（不自动重付费）',
    callsAfter === callsBefore, { before: callsBefore, after: callsAfter });
  add('A09', '被中断尝试的状态里没有伪造用量与收尾时间',
    bAfter.receipt.finishedAt === null && bAfter.receipt.usage === null,
    { finishedAt: bAfter.receipt.finishedAt, usage: bAfter.receipt.usage });

  // 部分输出：重启后仍然在，并能通过接口下载
  const partialBAfter = await getText(base, '/experiments/' + expId + '/attempts/' + beforeKill.b.id + '/partial');
  add('A09', '被杀之前收到的正文重启后仍在磁盘上，并且接口能交出来',
    partialBAfter.status === 200 && partialBAfter.text.length > 0,
    { status: partialBAfter.status, chars: partialBAfter.status === 200 ? partialBAfter.text.length : 0 });
  add('A09', 'API 如实报告 partial 的元信息（字符数、是否只留尾部）',
    Boolean(bAfter.partial && bAfter.partial.chars > 0),
    bAfter.partial);
  add('A09', '中断的那次没有可预览作品，但记录仍在（失败占位，不是消失）',
    bAfter.canPreview === false && bAfter.extraction === null, { canPreview: bAfter.canPreview });

  // ── 界面：真实浏览器打开，确认用户看到的是"已中断"而不是空白或"生成中" ──
  const b = await launchBrowser();
  if (!b.ok) {
    add('A09', '浏览器可用（界面核对）', false, b.reason);
  } else {
    browserHandle = b.browser;
    const page = await b.browser.newPage();
    const consoleErrors = [];
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200)); });
    await page.goto('http://127.0.0.1:' + port + '/html-arena/api/ui', { waitUntil: 'load', timeout: 30000 });
    await page.waitForSelector('#mode-badge', { timeout: 20000 });
    await page.waitForTimeout(800);
    await page.fill('#search', 'M2 重启恢复');
    await page.waitForTimeout(900);
    await page.click('#experiment-list .exp:first-child button:has-text("打开")');
    await page.waitForSelector('#view-compare:not([hidden])', { timeout: 20000 });
    await page.waitForTimeout(1200);

    const ui = await page.evaluate(() => {
      const last = {};
      window.__htmlArena.state.current.attempts.forEach((a) => { if (!last[a.slot] || a.attemptNo > last[a.slot].attemptNo) last[a.slot] = a; });
      return {
        statuses: Object.keys(last).sort().map((k) => ({ slot: last[k].slot, status: last[k].status, partial: last[k].partial || null })),
      };
    });
    add('A09', '界面读到的状态就是一个 completed + 一个 interrupted',
      ui.statuses.length === 2 && ui.statuses.some((s) => s.status === 'completed') && ui.statuses.some((s) => s.status === 'interrupted'),
      ui.statuses);

    const placeholder = await page.$$eval('.frame-error', (els) => els.map((e) => e.innerText.replace(/\s+/g, ' ').trim()));
    add('A09', '对比页对中断的候选显示可读原因（不是空白，也不是"生成中"）',
      placeholder.some((t) => /重启/.test(t)), placeholder.map((t) => t.slice(0, 120)));
    const partialBtn = await page.$$eval('.frame-error button', (els) => els.map((e) => e.textContent));
    add('A09', '界面上能下载"中断前的部分输出"（说明它不是嘴上说保留）',
      partialBtn.some((t) => /部分输出/.test(t)), partialBtn);
    add('A09', '界面加载 0 控制台错误', consoleErrors.length === 0, consoleErrors.slice(0, 3));

    const shotFile = join(EVIDENCE_DIR, 'm2-restart-interrupted.png');
    writeFileSync(shotFile, await page.screenshot({ type: 'png' }));
    report.screenshot = 'docs/evidence/m2-restart-interrupted.png';

    // ── 用户显式点"重试"：这时**才**允许新建 attempt 并重新计费 ──────────
    const beforeRetry = (await api(base, '/experiments/' + expId)).body.attempts.length;
    await page.click('.frame-error button:has-text("重试")');
    await page.waitForTimeout(600);
    const duringRetry = (await api(base, '/experiments/' + expId)).body.attempts.length;
    add('A09', '用户显式点重试才会新建 attempt（费用由用户触发）', duringRetry === beforeRetry + 1,
      { before: beforeRetry, after: duringRetry });
    // 等新的一轮跑完
    const t1 = Date.now();
    let finished = null;
    while (Date.now() - t1 < 40000) {
      const d = await api(base, '/experiments/' + expId);
      const latestB = d.body.attempts.filter((x) => x.slot === 1).sort((x, y) => y.attemptNo - x.attemptNo)[0];
      if (latestB && latestB.status === 'completed') { finished = latestB; break; }
      await sleep(300);
    }
    add('A09', '重试之后新的一轮能正常跑完并产出作品',
      Boolean(finished && finished.canPreview), finished ? { status: finished.status, canPreview: finished.canPreview } : null);
    const callsFinal = logLines(logPath);
    add('A09', '重试这一轮只发生了一次新的模型调用', callsFinal === callsBefore + 1, { before: callsBefore, after: callsFinal });

    await b.browser.close();
    browserHandle = null;
  }

  report.afterRestart = {
    attempts: after.body.attempts.map((a) => ({ id: a.id, slot: a.slot, status: a.status, partial: a.partial })),
    llmCalls: callsAfter,
  };
} catch (err) {
  add('执行', '脚本运行没有抛异常', false, String(err && err.stack || err));
} finally {
  try { if (browserHandle) await browserHandle.close(); } catch { /* 已关 */ }
  try { await hardKill(server, '开发服务器（收尾）'); } catch { /* 已经没了 */ }
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }
}

process.exit(finish('m2-restart-recovery'));
