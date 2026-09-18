/**
 * A08 完整回归 —— 超时路径、取消路径，以及"两条路径都不污染新 attempt"。
 *
 * 覆盖 ACCEPTANCE A08 的三个判据：状态落盘 / 尽力终止 / 后续输出不污染新 attempt。
 *
 * 全程零费用：起一个自己的开发服务器（模拟模型），
 * 用 sim-slow（慢慢吐、遵守中止信号）触发**真实**的运行上限，用 sim-ignore-abort
 * 制造"被超时之后还在继续吐"的情形，验证那些迟到的内容不会跑进新的一轮。
 *
 * 用法：node scripts/m2-timeout-check.mjs
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchBrowser } from '../src/preview/browser.js';
import {
  EVIDENCE_DIR, sleep, freePort, api, postJson, getText,
  startDevServer, waitHealthy, hardKill, logLines, makeChecker,
} from './lib/devhost.mjs';

const { add, report, finish } = makeChecker({
  what: 'A08：超时与取消的状态落盘、尽力终止、以及后续输出不污染新 attempt',
  note: '模拟模型，零费用；产物是模拟结果，不是真实模型输出',
});

const dataDir = mkdtempSync(join(tmpdir(), 'arena-timeout-'));
const llmLog = join(dataDir, 'llm-calls.jsonl');
const port = await freePort();
const base = 'http://127.0.0.1:' + port + '/html-arena/api';
const server = startDevServer({ port, dataDir, llmLog, latencyMs: 100 });
let browserHandle = null;

/** 等实验里没有候选在跑。 */
async function waitIdle(expId, timeoutMs = 40000) {
  const t0 = Date.now();
  for (;;) {
    const d = await api(base, '/experiments/' + expId);
    const running = d.body.attempts.filter((a) => a.running || a.status === 'running' || a.status === 'queued');
    if (running.length === 0) return d.body;
    if (Date.now() - t0 > timeoutMs) throw new Error('等待结束超时，仍有 ' + running.length + ' 个在跑');
    await sleep(150);
  }
}

try {
  await waitHealthy(base);
  add('准备', '开发服务器（模拟模型）已就绪', true, { port });

  // ══ 1. 超时路径 ═══════════════════════════════════════════════════
  const exp1 = await postJson(base, '/experiments', {
    title: 'M2 超时路径（模拟模型）',
    prompt: '这一轮用来触发运行上限',
    outputPolicy: { timeoutMs: 1200, concurrency: 1 },
  });
  const exp1Id = exp1.body.experiment.id;
  const started1 = await postJson(base, '/experiments/' + exp1Id + '/start', {
    concurrency: 1,
    candidates: [{ name: '慢的（会超时）', provider: 'sim-slow', model: 'sim-slow-1' }],
  });
  add('A08', '实验记录下了本轮的运行上限', started1.body.timeoutMs === 1200, { timeoutMs: started1.body.timeoutMs });

  const done1 = await waitIdle(exp1Id);
  const a1 = done1.attempts[0];
  add('A08', '超时状态落盘为 timed_out', a1.status === 'timed_out', a1.status);
  add('A08', '收尾原因与原因码都是超时（不是"未识别"）',
    a1.receipt.finishReason === 'timeout' && a1.receipt.errorCode === 'TIMEOUT',
    { finishReason: a1.receipt.finishReason, errorCode: a1.receipt.errorCode });
  add('A08', '界面拿到的是人能读懂的原因与下一步',
    Boolean(a1.error && a1.error.title === '请求超时' && a1.error.hint), a1.error);
  add('A08', '被中止前收到的正文已经落盘（可下载）', Boolean(a1.extraction) && a1.extraction.bytes > 0,
    a1.extraction && { bytes: a1.extraction.bytes, rawTextHash: String(a1.extraction.rawTextHash).slice(0, 12) });
  const raw1 = await getText(base, '/experiments/' + exp1Id + '/attempts/' + a1.id + '/raw');
  add('A08', '下载原始正文成功且非空', raw1.status === 200 && raw1.text.length > 0, { bytes: raw1.text.length });
  add('A08', '超时不会自动重试：只发生过这一次尝试', done1.attempts.length === 1 && logLines(llmLog) === 1,
    { attempts: done1.attempts.length, llmCalls: logLines(llmLog) });

  // ══ 2. 取消路径（与超时分开） ═════════════════════════════════════
  const exp2 = await postJson(base, '/experiments', {
    title: 'M2 取消路径（模拟模型）',
    prompt: '这一轮用来验证取消',
    outputPolicy: { timeoutMs: 60000, concurrency: 1 },
  });
  const exp2Id = exp2.body.experiment.id;
  await postJson(base, '/experiments/' + exp2Id + '/start', {
    concurrency: 1,
    candidates: [{ name: '慢的（会被取消）', provider: 'sim-slow', model: 'sim-slow-1' }],
  });
  for (let i = 0; i < 100; i += 1) {
    const live = await api(base, '/experiments/' + exp2Id + '/live');
    if (((live.body.streams || [])[0] || {}).text) break;
    await sleep(80);
  }
  const d2 = await api(base, '/experiments/' + exp2Id);
  const cancelRes = await postJson(base, '/experiments/' + exp2Id + '/cancel', { attemptId: d2.body.attempts[0].id });
  add('A08', '取消请求被接受', cancelRes.status === 200 && cancelRes.body.ok === true, cancelRes.body);
  const done2 = await waitIdle(exp2Id);
  const a2 = done2.attempts[0];
  add('A08', '取消状态落盘为 cancelled，收尾原因是 aborted',
    a2.status === 'cancelled' && a2.receipt.finishReason === 'aborted',
    { status: a2.status, finishReason: a2.receipt.finishReason });
  add('A08', '取消不会被记成超时（两条路径分开）', a2.receipt.finishReason !== 'timeout' && a2.receipt.errorCode !== 'TIMEOUT',
    { errorCode: a2.receipt.errorCode });
  add('A08', '取消也不会自动重试', done2.attempts.length === 1, { attempts: done2.attempts.length });

  // ══ 3. 迟到的输出不污染"别人"：同一批里另一个候选 + 之后新建的一轮 ═══
  //
  // 这里刻意用**两个同时跑的候选**：slot 0 是忽略中止的（超时后还会继续吐十几秒），
  // slot 1 是正常的。如果迟到输出会串台，最先被污染的就是同一批里那个正常的候选。
  const exp3 = await postJson(base, '/experiments', {
    title: 'M2 迟到输出不污染（模拟模型）',
    prompt: '这一轮验证污染隔离',
    // 运行上限必须大于"正常候选"的耗时（否则连它也会超时，那这一条就不是在测污染了）：
    // sim-ok-a 约 0.5 秒跑完；sim-ignore-abort 会吐十几秒，超时之后仍在吐 —— 窗口足够宽。
    outputPolicy: { timeoutMs: 2500, concurrency: 2 },
  });
  const exp3Id = exp3.body.experiment.id;
  await postJson(base, '/experiments/' + exp3Id + '/start', {
    concurrency: 2,
    candidates: [
      { name: '忽略中止的', provider: 'sim-ignore-abort', model: 'sim-late-1' },
      { name: '正常的', provider: 'sim-ok-a', model: 'sim-fast' },
    ],
  });

  const LATE = 'LATE-OUTPUT-OF-ATTEMPT-ONE';
  // 等"已经超时、但流还在吐"的窗口
  let window3 = null;
  const t3 = Date.now();
  while (Date.now() - t3 < 20000) {
    const live = await api(base, '/experiments/' + exp3Id + '/live');
    const s = (live.body.streams || []).find((x) => x.slot === 0);
    if (s && s.timedOut && s.running && s.text.length > 0) { window3 = s; break; }
    await sleep(60);
  }
  add('准备', '抓住了"已超时但流仍在吐"的窗口（迟到的输出真实存在）', Boolean(window3),
    window3 && { chars: window3.text.length, timedOut: window3.timedOut });

  const before3 = await api(base, '/experiments/' + exp3Id);
  const firstId = before3.body.attempts.find((a) => a.slot === 0).id;
  const normalId = before3.body.attempts.find((a) => a.slot === 1).id;

  // 同一批里那个正常候选先跑完了 —— 它绝不能沾上 slot 0 的迟到内容
  const rawNormal = await getText(base, '/experiments/' + exp3Id + '/attempts/' + normalId + '/raw');
  add('A08', '同一批里正常的候选没有沾上迟到内容（跨候选不串台）',
    rawNormal.status === 200 && !rawNormal.text.includes(LATE) && /模拟模型的说明/.test(rawNormal.text),
    { chars: rawNormal.text.length });

  // 窗口里再立刻开新的一轮（模拟用户点重试）
  const retry = await postJson(base, '/experiments/' + exp3Id + '/attempts/' + firstId + '/retry', {});
  add('准备', '在窗口内立刻开新的一轮（模拟用户点重试）', retry.status === 202, retry.body);

  const done3 = await waitIdle(exp3Id, 90000);
  const att0 = done3.attempts.find((a) => a.id === firstId);
  const attNormal = done3.attempts.find((a) => a.id === normalId);
  const attRetry = done3.attempts.find((a) => a.id === retry.body.attemptId);
  const rawLate = await getText(base, '/experiments/' + exp3Id + '/attempts/' + firstId + '/raw');
  const rawRetry = await getText(base, '/experiments/' + exp3Id + '/attempts/' + retry.body.attemptId + '/raw');

  add('A08', '被超时那一轮的迟到内容只留在它自己身上', rawLate.status === 200 && rawLate.text.includes(LATE),
    { chars: rawLate.text.length });
  // 关键：新那一轮拿到的必须**正好是一次流**的内容，而不是"两次流拼起来"
  add('A08', '新那一轮的正文长度等于一次完整输出（没有把上一次的迟到内容拼进来）',
    rawRetry.status === 200 && rawRetry.text.length === rawLate.text.length,
    { retryChars: rawRetry.text.length, firstChars: rawLate.text.length });
  // 注意：slot0 与它的重试是**同一套配置、同一道题**，两轮内容相同、hash 相同是正常的；
  // 真正要证明的是"不同候选之间不串台"，所以比对的是 slot0/slot1 与 retry/slot1 这两组。
  add('A08', '三个候选轮次各自的状态正确，且不同配置的内容互不串台',
    att0.status === 'timed_out' && attNormal.status === 'completed' && attRetry.status === 'timed_out'
      && att0.extraction.rawTextHash !== attNormal.extraction.rawTextHash
      && attRetry.extraction.rawTextHash !== attNormal.extraction.rawTextHash,
    {
      statuses: { slot0: att0.status, slot1: attNormal.status, retry: attRetry.status },
      slot0VsSlot1: att0.extraction.rawTextHash !== attNormal.extraction.rawTextHash,
      retryVsSlot1: attRetry.extraction.rawTextHash !== attNormal.extraction.rawTextHash,
      note: 'slot0 与它的重试是同一套配置，内容相同属预期',
    });

  // 记录与内容一一对应：重新提取必须得到它自己记下来的那个 hash
  const { extractHtml, sha256Hex } = await import('../src/core/extract.js');
  const reEx = extractHtml(rawRetry.text, { finishReason: attRetry.receipt.finishReason });
  add('A08', '新那一轮的正文 hash 与作品 hash 都能从磁盘内容重新算出来（记录不是拼出来的）',
    (await sha256Hex(rawRetry.text)) === attRetry.extraction.rawTextHash
      && Boolean(reEx.html) && (await sha256Hex(reEx.html)) === attRetry.extraction.htmlHash,
    { rawMatches: (await sha256Hex(rawRetry.text)) === attRetry.extraction.rawTextHash });
  const htmlNormal = await getText(base, '/experiments/' + exp3Id + '/attempts/' + normalId + '/html');
  add('A08', '正常候选的作品 HTML 里也没有迟到内容',
    htmlNormal.status === 200 && !htmlNormal.text.includes(LATE), { bytes: htmlNormal.text.length });

  // ══ 4. 界面：超时要显示得出来，且不是"生成中" ═════════════════════
  const b = await launchBrowser();
  if (!b.ok) {
    add('A08', '浏览器可用（界面核对）', false, b.reason);
  } else {
    browserHandle = b.browser;
    const page = await b.browser.newPage();
    const consoleErrors = [];
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200)); });
    await page.goto('http://127.0.0.1:' + port + '/html-arena/api/ui', { waitUntil: 'load', timeout: 30000 });
    await page.waitForSelector('#mode-badge', { timeout: 20000 });
    await page.waitForTimeout(800);
    await page.fill('#search', 'M2 超时路径');
    await page.waitForTimeout(900);
    await page.click('#experiment-list .exp:first-child button:has-text("打开")');
    await page.waitForSelector('#view-compare:not([hidden])', { timeout: 20000 });
    await page.waitForTimeout(1000);
    const text = await page.innerText('body');
    add('A08', '界面上写着"超时"而不是"生成中"', /超时/.test(text) && !/生成中/.test(text));
    // 卡片头上要有状态标记（超时的作品也可能有 HTML，只看作品是看不出它超时了的）
    const pill = await page.$eval('.frame-wrap[data-attempt="' + a1.id + '"] [data-attempt-status]', (e) => ({
      status: e.getAttribute('data-attempt-status'), text: e.textContent, title: e.getAttribute('title'),
    })).catch(() => null);
    add('A08', '对比页卡片头上明确标出"超时"，并把可读原因放进 title',
      Boolean(pill && pill.status === 'timed_out' && /超时/.test(pill.text) && /请求超时/.test(pill.title || '')), pill);
    // "展开配置"里要有状态、收尾原因、失败原因与下一步（这些内容默认折叠，所以要真的展开）
    await page.click('#compare-config summary');
    await page.waitForTimeout(400);
    const detailsText = await page.innerText('#compare-details');
    add('A08', '展开配置里写明了收尾原因 timeout 与可读的失败原因',
      /timeout/.test(detailsText) && /请求超时/.test(detailsText) && /运行上限|更快的模型/.test(detailsText),
      detailsText.replace(/\s+/g, ' ').slice(0, 200));
    const shotFile = join(EVIDENCE_DIR, 'm2-timeout-state.png');
    writeFileSync(shotFile, await page.screenshot({ type: 'png' }));
    report.screenshot = 'docs/evidence/m2-timeout-state.png';
    add('A08', '界面加载 0 控制台错误', consoleErrors.length === 0, consoleErrors.slice(0, 3));
    await b.browser.close();
    browserHandle = null;
  }

  report.totals = { llmCalls: logLines(llmLog) };
} catch (err) {
  add('执行', '脚本运行没有抛异常', false, String(err && err.stack || err));
} finally {
  try { if (browserHandle) await browserHandle.close(); } catch { /* 已关 */ }
  try { await hardKill(server, '开发服务器（收尾）'); } catch { /* 已经没了 */ }
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }
}

process.exit(finish('m2-timeout'));
