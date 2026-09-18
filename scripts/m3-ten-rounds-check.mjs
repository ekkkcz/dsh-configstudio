/**
 * A28 完整回归 —— **连续十轮**（首轮 + 10 次「追加一轮」）**并停止全部预览**。
 *
 * 验收原文：连续十轮并停止全部预览 —— 订阅无重复，任务与预览资源可回收。
 *
 * 这条为什么要单独写：m2-rounds-walkthrough 只跑了两轮，而"订阅无重复"这类缺陷
 * 恰恰是**轮次一多才显形**的（监听器/定时器只要有一处重复挂，前一两次看不出来，
 * 十轮之后界面就会变成一片卡顿）。所以这里全程走真实界面连点 10 次「追加一轮」，
 * 然后用两条可核对的口径验收：
 *
 *  ① 订阅无重复：用 page.on('request') 数 /live 请求。比较"第 1 轮跑完后 3 秒窗口"
 *     与"最后一轮跑完后 3 秒窗口"的请求数（题目指定口径），另外补一条更强的
 *     "每轮进行中"的请求**速率**比较 —— 数量级不对就说明轮询/订阅被叠加了。
 *  ② 资源可回收：十轮之后对比页里只应该有**最新一轮**的 2 个预览 iframe（不是 22 个）；
 *     **离开对比页时就把 iframe 摘掉**（数量 0，预览文档随之销毁，动画/定时器不再后台空跑）；
 *     刷新页面后 iframe 与 window.__arenaFrames 引用都归零；重新打开对比页能恢复成 2 个
 *     并真的渲染出作品（不是"再也打不开"）。
 *
 * 关于"离开对比页就回收"这条：本脚本第一版实测**不成立**（section 只是被 hidden，
 * iframe 还挂在 DOM 上），当时把它记成 knownGaps 并留了 --strict-preview-recycle 开关。
 * 现在产品侧已修（web/app.js 的 releasePreviews()），**这条成为默认硬断言**；
 * 开关保留但已无差别（写它是为了让旧命令继续可用）。
 *
 * 全程零费用：模拟模型（scripts/simulated-llm.mjs）+ 真实 Chromium，不调用任何真实模型。
 *
 * 用法：node scripts/m3-ten-rounds-check.mjs
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchBrowser } from '../src/preview/browser.js';
import {
  sleep, freePort, api, startDevServer, waitHealthy, hardKill, logLines, makeChecker,
} from './lib/devhost.mjs';

const { add, report, finish } = makeChecker({
  what: 'A28：连续十轮（首轮 + 10 次追加）并停止全部预览 —— 订阅无重复、任务与预览资源可回收',
  note: '模拟模型 + 真实 Chromium，零费用；十次「追加一轮」全部由界面点击触发，共 11 轮 × 2 候选',
});

/** 严格口径：把"离开对比页后 iframe 必须为 0"当硬断言（产品改好后打开即可回归）。 */
const STRICT_RECYCLE = process.argv.includes('--strict-preview-recycle')
  || process.env.ARENA_STRICT_PREVIEW_RECYCLE === '1';
report.strictPreviewRecycle = STRICT_RECYCLE;

const ROUNDS = 10;                    // 「追加一轮」点几次
const TOTAL_ROUNDS = ROUNDS + 1;      // 首轮 + 追加 = 11 轮
const CANDIDATES = 2;                 // 两候选实验
const AFTER_WINDOW_MS = 3000;         // "跑完后 3 秒内"这个窗口（题目指定口径）

const dataDir = mkdtempSync(join(tmpdir(), 'arena-ten-rounds-'));
const llmLog = join(dataDir, 'llm-calls.jsonl');
const port = await freePort();
const base = 'http://127.0.0.1:' + port + '/html-arena/api';
const uiUrl = 'http://127.0.0.1:' + port + '/html-arena/api/ui';
// latencyMs 是"首块之前的等待"（模拟模型正文每 64 字符再等 6ms），取 60ms：
// 每轮约 1 秒跑完 —— 够快，又足够让界面轮询真实观察到"生成中"这一段。
const server = startDevServer({ port, dataDir, llmLog, latencyMs: 60 });
let browserHandle = null;

/** 每轮的计时与请求计数（可核对口径的原始数据，最后一起落盘）。 */
const rounds = [];
/** /live 请求时间线（订阅是否叠加就看它）。 */
const liveRequests = [];
/** /preview/<attemptId> 请求时间线（预览文档真的被加载了几次）。 */
const previewRequests = [];

/** 读实验详情（服务端权威数据，不靠界面自报）。 */
async function detail(expId) {
  const r = await api(base, '/experiments/' + encodeURIComponent(expId));
  if (r.status !== 200) throw new Error('读取实验失败：' + JSON.stringify(r.body));
  return r.body;
}

/** 数某个时间窗内的 /live 请求数。 */
function liveIn(from, to) {
  let n = 0;
  for (const r of liveRequests) if (r.at >= from && r.at <= to) n += 1;
  return n;
}

/** 每个候选取轮号最大的那一次（与服务端"最新一轮"口径一致）。 */
function latestPerSlot(attempts) {
  const map = new Map();
  for (const a of attempts) {
    const cur = map.get(a.slot);
    if (!cur || a.attemptNo > cur.attemptNo) map.set(a.slot, a);
  }
  return [...map.entries()].sort((x, y) => x[0] - y[0]).map((e) => e[1]);
}

/**
 * 等服务端把第 target 轮跑到"两个候选都 completed 且没有任何 running"，
 * 返回观察到的完成时刻（= 后面 3 秒窗口的起点）。
 */
async function waitRoundDone(expId, target, timeoutMs = 90000) {
  const t0 = Date.now();
  for (;;) {
    const d = await detail(expId);
    const latest = latestPerSlot(d.attempts);
    const running = d.attempts.filter((a) => a.running || a.status === 'running' || a.status === 'queued');
    if (latest.length === CANDIDATES && running.length === 0
      && latest.every((a) => a.attemptNo >= target && a.status === 'completed')) {
      return { at: Date.now(), detail: d };
    }
    if (Date.now() - t0 > timeoutMs) {
      throw new Error('等第 ' + target + ' 轮跑完超时：当前 '
        + JSON.stringify(d.attempts.map((a) => ({ slot: a.slot, no: a.attemptNo, st: a.status }))));
    }
    await sleep(120);
  }
}

/** 等界面把"最新一轮"真的画出来（用 #run-cards 的轮次标签，不靠计时猜）。 */
async function waitRunPanelRendered(page, target) {
  await page.waitForFunction((t) => {
    const tags = Array.prototype.slice.call(document.querySelectorAll('#run-cards .round-tag'))
      .map((e) => e.textContent);
    return tags.length === 2 && tags.every((x) => x === '第 ' + t + ' 轮');
  }, target, { timeout: 30000 });
}

/** 界面侧数 iframe 与 __arenaFrames 引用（资源有没有被回收就看这两个数）。 */
function countFrames(page) {
  return page.evaluate(() => ({
    inCompareView: document.querySelectorAll('#view-compare iframe').length,
    inCompareGrid: document.querySelectorAll('#compare-grid iframe').length,
    inWholePage: document.querySelectorAll('iframe').length,
    arenaFrames: Object.keys(window.__arenaFrames || {}).length,
    view: window.__htmlArena.state.view,
    compareHidden: document.getElementById('view-compare').hidden,
  }));
}

/** 读当前所有作品 iframe 的可见正文长度（用来证明"真的渲染出来了"）。 */
async function frameTextLengths(page) {
  const out = [];
  for (const f of page.frames()) {
    if (f === page.mainFrame()) continue;
    try {
      const t = await f.evaluate(() => (document.body ? document.body.innerText.trim() : ''));
      out.push(t.length);
    } catch { out.push(-1); }
  }
  return out;
}

try {
  await waitHealthy(base);
  add('准备', '开发服务器（模拟模型，零费用）已就绪', true, { port, dataDir });

  const b = await launchBrowser();
  if (!b.ok) throw new Error('无法启动浏览器：' + b.reason);
  browserHandle = b.browser;
  add('准备', '真实 Chromium 可用（走界面路径，不是只调接口）', true, { resolvedFrom: b.resolvedFrom });

  const page = await b.browser.newPage({ viewport: { width: 1500, height: 950 } });
  const consoleErrors = [];
  const pageErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200)); });
  page.on('pageerror', (e) => pageErrors.push(String(e.message).slice(0, 200)));
  page.on('request', (r) => {
    const u = r.url();
    const at = Date.now();
    if (u.indexOf('/live') >= 0) liveRequests.push({ at, url: u.slice(-80) });
    if (/\/preview\/att_/.test(u)) previewRequests.push({ at, url: u.slice(0, 100) });
  });

  await page.goto(uiUrl, { waitUntil: 'load', timeout: 30000 });
  await page.waitForSelector('#mode-badge', { timeout: 20000 });
  await page.waitForTimeout(800);

  // ── ① 首轮：真实界面里点「开始生成」 ───────────────────────────────
  await page.click('.tab[data-view="new"]');
  await page.waitForTimeout(300);
  await page.fill('#task-title', 'A28 十轮连续追加（模拟模型）');
  await page.fill('#task-prompt', '做一个可切换城市的天气仪表盘，使用内置示例数据。');
  const round1Start = Date.now();
  await page.click('#btn-start');
  await page.waitForSelector('#view-run:not([hidden])', { timeout: 30000 });
  const expId = await page.evaluate(() => (window.__htmlArena.state.current || {}).experiment
    ? window.__htmlArena.state.current.experiment.id : null);
  add('准备', '首轮在真实界面上跑起来了（拿到实验 id）', Boolean(expId), { experimentId: expId });

  const done1 = await waitRoundDone(expId, 1);
  await waitRunPanelRendered(page, 1);
  const callsAfterRound1 = logLines(llmLog);
  add('第 1 轮', '首轮两个候选都跑完：attempts=2、都是 completed、都有可预览作品',
    done1.detail.attempts.length === CANDIDATES
      && done1.detail.attempts.every((a) => a.status === 'completed' && a.canPreview),
    done1.detail.attempts.map((a) => ({ slot: a.slot, no: a.attemptNo, st: a.status, preview: a.canPreview })));
  add('第 1 轮', '首轮的模型调用次数正好是 2（每个候选一次逻辑请求，没有重复发起）',
    callsAfterRound1 === CANDIDATES, { calls: callsAfterRound1 });

  // 题目指定口径：第 1 轮结束后的 3 秒窗口
  await sleep(AFTER_WINDOW_MS);
  rounds.push({
    round: 1, clicked: round1Start, doneAt: done1.at,
    duringMs: done1.at - round1Start,
    liveDuring: liveIn(round1Start, done1.at),
    liveAfter3s: liveIn(done1.at, done1.at + AFTER_WINDOW_MS),
    fromUi: '点击「开始生成」',
  });

  // ── ② 连点 10 次「追加一轮」，每轮等它跑完再点下一轮 ──────────────
  for (let k = 1; k <= ROUNDS; k += 1) {
    const target = k + 1;
    await page.fill('#round-note', '第 ' + target + ' 轮：主色调再深一点，布局保持不变。');
    const clicked = Date.now();
    await page.click('#btn-add-round');
    const done = await waitRoundDone(expId, target);
    await waitRunPanelRendered(page, target);
    // 界面必须回报"这一轮往上下文里放了什么"（否则追加轮次对用户是黑盒）
    const hist = await page.textContent('#round-history');
    add('追加轮次', '第 ' + target + ' 轮：界面回报了每个候选的新轮次与回放内容',
      hist.indexOf('第 ' + target + ' 轮') >= 0 && hist.indexOf('上一轮回放') >= 0,
      hist.replace(/\s+/g, ' ').slice(0, 120));
    await sleep(AFTER_WINDOW_MS);
    rounds.push({
      round: target, clicked, doneAt: done.at, duringMs: done.at - clicked,
      liveDuring: liveIn(clicked, done.at),
      liveAfter3s: liveIn(done.at, done.at + AFTER_WINDOW_MS),
      fromUi: '点击「追加一轮」',
    });
  }

  // ── ③ 十轮之后的账：attempt 数量、状态、轮号、正文、runs ──────────
  const final = await detail(expId);
  const slots = [0, 1].map((slot) => final.attempts.filter((a) => a.slot === slot));
  add('A28', '十轮之后候选 A/B 各有 ' + TOTAL_ROUNDS + ' 个 attempt（首轮 + ' + ROUNDS + ' 次追加）',
    final.attempts.length === TOTAL_ROUNDS * CANDIDATES
      && slots.every((arr) => arr.length === TOTAL_ROUNDS),
    { total: final.attempts.length, perSlot: slots.map((arr) => arr.length) });
  add('A28', '全部 ' + (TOTAL_ROUNDS * CANDIDATES) + ' 个 attempt 都是 completed（没有跑不完/失败/超时的残留）',
    final.attempts.every((a) => a.status === 'completed'),
    final.attempts.filter((a) => a.status !== 'completed').map((a) => ({ slot: a.slot, no: a.attemptNo, st: a.status })));
  add('A28', '每个候选的轮号恰好是 1..' + TOTAL_ROUNDS + '（没有缺号，也没有重复轮号）',
    slots.every((arr) => {
      const nos = arr.map((a) => a.attemptNo).sort((x, y) => x - y);
      return nos.length === TOTAL_ROUNDS && nos.every((n, i) => n === i + 1);
    }),
    slots.map((arr) => arr.map((a) => a.attemptNo).sort((x, y) => x - y)));
  add('A28', '每一轮的原始输出都真的留在磁盘上（' + (TOTAL_ROUNDS * CANDIDATES) + ' 份正文都非空）',
    final.attempts.every((a) => a.extraction && a.extraction.bytes > 0),
    { minBytes: Math.min(...final.attempts.map((a) => (a.extraction ? a.extraction.bytes : 0))) });
  add('A28', '服务端 /experiments/:id 的 runs 为空（十一轮跑完没有留下跑不完的任务）',
    Array.isArray(final.runs) && final.runs.length === 0, { runs: final.runs });
  const callsTotal = logLines(llmLog);
  add('A28', '模型调用日志 = ' + (TOTAL_ROUNDS * CANDIDATES) + ' 行（11 轮 × 2 候选；订阅叠加会让这个数变大）',
    callsTotal === TOTAL_ROUNDS * CANDIDATES, { calls: callsTotal });

  // ── ④ 订阅无重复：/live 的两条口径 ────────────────────────────────
  const first = rounds[0];
  const last = rounds[rounds.length - 1];
  const afterLimit = first.liveAfter3s * 1.5 + 2;
  add('A28', '订阅无重复（题目口径）：最后一轮跑完后 3 秒内的 /live 请求数 ≤ 第 1 轮同窗口的 1.5 倍 + 2',
    last.liveAfter3s <= afterLimit,
    { round1After3s: first.liveAfter3s, roundLastAfter3s: last.liveAfter3s, limit: afterLimit });
  const rateOf = (r) => (r.duringMs > 0 ? (r.liveDuring / r.duringMs) * 1000 : 0);
  const rateLimit = rateOf(first) * 1.5 + 2;
  add('A28', '订阅无重复（更强口径）：最后一轮进行中的 /live 请求速率 ≤ 第 1 轮的 1.5 倍 + 2 次/秒',
    rateOf(last) <= rateLimit,
    {
      round1Rate: Number(rateOf(first).toFixed(2)), roundLastRate: Number(rateOf(last).toFixed(2)),
      limit: Number(rateLimit.toFixed(2)),
      round1During: first.liveDuring, roundLastDuring: last.liveDuring,
    });
  add('A28', '订阅不会随轮次累积：十一轮的"跑完后 3 秒窗口"请求数最大值 ≤ 第 1 轮的 1.5 倍 + 2',
    Math.max(...rounds.map((r) => r.liveAfter3s)) <= afterLimit,
    { perRoundAfter3s: rounds.map((r) => r.liveAfter3s) });

  // ── ⑤ 停止全部预览 / 预览资源可回收 ──────────────────────────────
  await page.click('#btn-goto-compare');
  await page.waitForSelector('#view-compare:not([hidden])', { timeout: 20000 });
  await page.waitForTimeout(1200);
  const inCompare = await countFrames(page);
  const latestIds = latestPerSlot(final.attempts).map((a) => a.id);
  const shownIds = await page.$$eval('#compare-grid .frame-wrap', (els) => els.map((e) => e.getAttribute('data-attempt')));
  add('A28', '对比页里只有最新一轮的 2 份作品（DOM 里是 2 个 iframe，不是 11 轮累积的 22 个）',
    inCompare.inCompareView === CANDIDATES && shownIds.length === CANDIDATES
      && latestIds.every((id) => shownIds.indexOf(id) >= 0),
    { iframes: inCompare.inCompareView, shown: shownIds, latest: latestIds });

  // 切走再回来往返 3 次：既不累积，也不丢
  for (let i = 0; i < 3; i += 1) {
    await page.click('.tab[data-view="experiments"]');
    await page.waitForTimeout(700);
    await page.click('.tab[data-view="compare"]');
    await page.waitForTimeout(700);
  }
  const afterTrips = await countFrames(page);
  const tripTexts = await frameTextLengths(page);
  add('A28', '切到实验列表再回来往返 3 次：预览既不累积（仍是 2 个 iframe）也不丢（两份作品都还有内容）',
    afterTrips.inCompareView === CANDIDATES && tripTexts.filter((n) => n > 50).length === CANDIDATES,
    { frames: afterTrips, frameTextLengths: tripTexts });

  // 严格口径：离开对比页时就该把 iframe 摘掉（本机实测未实现，见 knownGaps）
  await page.click('.tab[data-view="experiments"]');
  await page.waitForTimeout(1500);
  const leftCompare = await countFrames(page);
  // 这条现在是硬断言（产品侧 releasePreviews() 已实现）：离开对比页 → iframe 摘掉、
  // window.__arenaFrames 引用也清空，预览文档不再挂着空跑。
  add('A28', '离开对比页后预览资源已回收：#view-compare 里 iframe 数量为 0、悬挂引用也为 0',
    leftCompare.inCompareView === 0 && leftCompare.arenaFrames === 0,
    { ...leftCompare, strictFlagUsed: STRICT_RECYCLE });

  // 刷新页面 = 真正把预览全部停掉（现有的"停止全部预览"路径）
  await page.reload({ waitUntil: 'load', timeout: 30000 });
  await page.waitForSelector('#mode-badge', { timeout: 20000 });
  await page.waitForTimeout(1000);
  const afterReload = await countFrames(page);
  add('A28', '刷新页面后预览全部停掉：iframe 数为 0，window.__arenaFrames 悬挂引用也清空',
    afterReload.inCompareView === 0 && afterReload.inWholePage === 0 && afterReload.arenaFrames === 0,
    afterReload);

  // 重新打开：不是"再也打不开"
  await page.click('.tab[data-view="experiments"]');
  await page.waitForTimeout(900);
  await page.click('#experiment-list .exp:first-child button:has-text("打开")');
  await page.waitForSelector('#view-compare:not([hidden])', { timeout: 20000 });
  await page.waitForTimeout(1500);
  const reopened = await countFrames(page);
  const reopenedTexts = await frameTextLengths(page);
  add('A28', '重新打开对比页后预览恢复：iframe 回到 2 个，且两个都真的渲染出了作品内容（不是再也打不开）',
    reopened.inCompareView === CANDIDATES && reopenedTexts.filter((n) => n > 50).length === CANDIDATES,
    { frames: reopened, frameTextLengths: reopenedTexts });

  add('界面', '全程 0 控制台错误、0 页面异常（十轮 + 往返 3 次 + 刷新 + 重开）',
    consoleErrors.length === 0 && pageErrors.length === 0,
    { consoleErrors: consoleErrors.slice(0, 3), pageErrors: pageErrors.slice(0, 3) });

  // ── 证据 ────────────────────────────────────────────────────────
  report.measurements = {
    experimentId: expId,
    rounds,
    liveRequestTotal: liveRequests.length,
    previewRequestTotal: previewRequests.length,
    previewRequestFirstAt: previewRequests.length ? previewRequests[0].at : null,
    frames: {
      inCompare, afterTrips, leftCompare, afterReload, reopened,
      frameTextLengthsInCompare: tripTexts, frameTextLengthsReopened: reopenedTexts,
    },
    llmCalls: { afterRound1: callsAfterRound1, total: callsTotal },
    attempts: final.attempts.map((a) => ({
      slot: a.slot, no: a.attemptNo, status: a.status, bytes: a.extraction ? a.extraction.bytes : 0,
      parent: a.parentAttemptId || null,
    })),
  };
  report.notes = [
    '模拟模型的产物一律带"这是模拟模型的说明"字样，不会被误认成真实模型输出。',
    '「跑完后 3 秒窗口」是题目指定的口径；十一轮里这个窗口的请求数都是 '
      + JSON.stringify(rounds.map((r) => r.liveAfter3s)) + '，真正有信息量的是"进行中速率"那条。',
    '严格口径（离开对比页后 iframe 应为 0）默认只记录、不断言：本机实测离开后 #view-compare '
      + '里仍有 ' + leftCompare.inCompareView + ' 个 iframe（整个 section 只是被 hidden）。',
  ];
  // 这一节记录"本脚本抓出来、随后**已经修掉**的两个产品缺陷"（留档，不是遗留问题）。
  report.fixedGaps = [
    {
      what: '切到别的标签页不会回收对比页的预览 iframe（section 只是被 hidden）',
      wasMeasured: '离开对比页后 #view-compare 里仍有 2 个 iframe（本脚本第一版实测）',
      nowMeasured: leftCompare,
      fixedIn: 'web/app.js 的 releasePreviews()：离开对比页时摘掉 iframe、清空 window.__arenaFrames、'
        + '清掉 compareRefs.sig（回到对比页时按当前实验重建）',
      verifiedBy: '本脚本"离开对比页后预览资源已回收"这条断言（默认硬断言）',
    },
    {
      what: 'window.__arenaFrames 里的 iframe 引用只增不减（十一轮之后 22 条，DOM 里只有 2 个）',
      wasMeasured: 22,
      nowMeasured: { arenaFramesAfterTrips: afterTrips.arenaFrames, domIframesAfterTrips: afterTrips.inCompareView },
      fixedIn: '同上：releasePreviews() 里 window.__arenaFrames = {}',
    },
  ];

  await page.close();
  await b.browser.close();
  browserHandle = null;
} catch (err) {
  add('执行', '脚本运行没有抛异常', false, String((err && err.stack) || err).slice(0, 1500));
} finally {
  try { if (browserHandle) await browserHandle.close(); } catch { /* 已关 */ }
  try { await hardKill(server, '开发服务器（收尾）'); } catch { /* 已经没了 */ }
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }
}

process.exit(finish('m3-ten-rounds'));
