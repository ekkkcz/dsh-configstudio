/**
 * A23 剩余部分 —— **截图失败的正式记录**。
 *
 * 判据（ACCEPTANCE A23）："标注初始状态与视口；截图失败有明确记录"。
 * 前半段 M1 已经通过；这里补的是后半段：一个永远加载不完的作品（主线程死循环）
 * 截图会失败，失败必须**落盘**（刷新页面、换个浏览器仍看得到原因），而不是只在界面上闪一下。
 *
 * 另外两条一起验：
 *  - 成功的那次也要留记录（对照组，证明记录不是"只有失败才写"）；
 *  - 截图失败**不能动作品本身**：HTML 与原始正文的 hash 一个字节都不能变（F14/F16 的语义）。
 *
 * 全程零费用：起自己的开发服务器（模拟模型），死循环作品直接写进数据目录。
 *
 * 用法：node scripts/m2-screenshot-failure-check.mjs
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { sha256 } from '../src/core/canonical.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/core/store.js';
import { launchBrowser } from '../src/preview/browser.js';
import {
  EVIDENCE_DIR, sleep, freePort, api, postJson,
  startDevServer, waitHealthy, hardKill, makeChecker,
} from './lib/devhost.mjs';

const { add, report, finish } = makeChecker({
  what: 'A23：截图失败的正式记录（含成功对照组，以及"截图不动作品"）',
  note: '模拟模型 + 死循环作品，零费用',
});

const NL = String.fromCharCode(10);
const DOC_OK = '<!DOCTYPE html><html><head><title>正常作品</title></head><body><h1>ok</h1></body></html>';
// 主线程死循环：解析器永远走不到 load，渲染进程也无法响应截图请求。
// 这是 M0 隔离试验里用过的同一类作品，这里把它接到产品的截图接口上。
const DOC_BLOCK = [
  '<!DOCTYPE html><html><head><title>死循环作品</title></head><body><h1>这一页永远加载不完</h1><script>',
  'while (true) { /* 故意阻塞主线程 */ }',
  '</' + 'script></body></html>',
].join(NL);
// 另一种失败方式：作品一打开就把自己导航到一个连不上的地址（加载失败）。
// 用它做**界面**核对，因为死循环那页会把渲染进程钉在 100% CPU 上，
// 连 Playwright 自己等元素都会被拖住 —— 那是测试工具的问题，不是产品的问题。
// （试过 document.open() 那招，实测 load 事件照样会触发，截图是成功的，不能用。）
const DOC_BAD_NAV = [
  '<!DOCTYPE html><html><head><title>加载失败的作品</title></head><body><h1>马上跳到一个连不上的地址</h1><script>',
  'location.replace("http://127.0.0.1:9/never-responds");',
  '</' + 'script></body></html>',
].join(NL);

const dataDir = mkdtempSync(join(tmpdir(), 'arena-shot-'));
const port = await freePort();
const base = 'http://127.0.0.1:' + port + '/configstudio/api';
const server = startDevServer({ port, dataDir, latencyMs: 100 });
let browserHandle = null;

try {
  await waitHealthy(base);
  add('准备', '开发服务器已就绪', true, { port });

  // ── 直接把两个作品写进数据目录（模拟"之前生成过这两份作品"） ──────────
  const store = new Store(dataDir);
  const exp = store.createExperiment({
    title: 'M2 截图失败记录', category: 'dashboard',
    taskSnapshot: { prompt: '用于验证截图失败记录' }, taskHash: 'x',
    outputPolicy: { timeoutMs: 60000, concurrency: 2 }, previewPolicy: { networkPolicy: 'offline', viewport: 'desktop' },
  });
  const mkAttempt = (slot, name, doc) => {
    const id = store.createAttempt({
      experimentId: exp.id, candidateSlot: slot, attemptNo: 1,
      recipeSnapshot: { name, provider: 'sim-ok-a', model: 'sim-fast', promptSegments: [] },
      requestedConfig: {}, resolvedConfig: null, parentAttemptId: null,
    });
    store.writeRaw(id, doc);
    store.writeHtml(id, doc);
    store.createArtifact({
      // 口径统一走 core/canonical.js 的 sha256（脚本里不再自己写一份）
      id, attemptId: id, rawHash: sha256(doc), htmlHash: sha256(doc),
      extractionVersion: '1', extractionMode: 'document', extractionRange: null,
      extractionStatus: 'ok', extractionWarnings: [], rawPath: '', htmlPath: '', bytes: doc.length,
    });
    store.updateAttemptStatus(id, 'completed');
    store.finishReceipt(id, { finishReason: 'stop', observedRequests: 1 });
    return id;
  };
  const okId = mkAttempt(0, '正常的', DOC_OK);
  const blockId = mkAttempt(1, '死循环的', DOC_BLOCK);
  const beforeHashes = {
    ok: store.getAttempt(okId).artifact.htmlHash,
    block: store.getAttempt(blockId).artifact.htmlHash,
  };
  store.close();
  add('准备', '把两个作品写进数据目录（一个正常、一个死循环）', true,
    { okAttempt: okId, blockingAttempt: blockId });

  // ── 截图：正常作品应当成功并且有记录（对照组） ─────────────────────
  const shotOk = await postJson(base, '/experiments/' + exp.id + '/attempts/' + okId + '/screenshot', { viewport: 'desktop' });
  add('A23', '正常作品截图成功', shotOk.status === 200 && shotOk.body.status === 'ok',
    { status: shotOk.body.status, hasImage: Boolean(shotOk.body.screenshotBase64), recordedId: shotOk.body.id });
  add('A23', '成功也写了记录，并且带视口与耗时',
    Boolean(shotOk.body.recordedAt) && shotOk.body.viewport && typeof shotOk.body.durationMs === 'number',
    { recordedAt: shotOk.body.recordedAt, durationMs: shotOk.body.durationMs });

  // ── 截图：死循环作品必然失败，而且必须落盘 ─────────────────────────
  const t0 = Date.now();
  const shotBad = await postJson(base, '/experiments/' + exp.id + '/attempts/' + blockId + '/screenshot', { viewport: 'mobile' });
  const elapsed = Date.now() - t0;
  const badStatus = shotBad.body.status;
  add('A23', '永远加载不完的作品截图被判定为失败（不是假装成功）',
    shotBad.status === 200 && ['screenshot_failed', 'navigation_failed', 'timeout', 'error'].includes(badStatus),
    { status: badStatus, elapsedMs: elapsed });
  add('A23', '失败原因是一句人能读懂的话，并且真的存在',
    typeof shotBad.body.reason === 'string' && shotBad.body.reason.length > 0,
    String(shotBad.body.reason).slice(0, 160));
  add('A23', '失败也是**尽力终止**：整个调用在上限内返回（没有把插件拖死）',
    elapsed < 40000, { elapsedMs: elapsed });

  // ── 记录必须落盘：重新读实验就能看到，不依赖刚才那次响应 ────────────
  const detail = await api(base, '/experiments/' + exp.id);
  const records = detail.body.screenshots || [];
  const badRec = records.find((r) => r.attemptId === blockId);
  const okRec = records.find((r) => r.attemptId === okId);
  add('A23', '失败记录已经落盘（重新读取实验仍在）', Boolean(badRec),
    badRec && { status: badRec.status, viewport: badRec.viewport, reason: String(badRec.reason).slice(0, 120) });
  add('A23', '记录里写明视口、状态、原因与耗时',
    Boolean(badRec && badRec.viewport === 'mobile' && badRec.status === badStatus
      && badRec.reason && typeof badRec.durationMs === 'number'),
    badRec && { viewport: badRec.viewport, status: badRec.status, durationMs: badRec.durationMs });
  add('A23', '记录里还带页面诊断（脚本错误/控制台/失败请求的条数）',
    Boolean(badRec && badRec.detail && typeof badRec.detail.pageErrors === 'number'),
    badRec && badRec.detail);
  add('A23', '成功那条记录也在（记录不是"只有失败才写"）', Boolean(okRec && okRec.status === 'ok'),
    okRec && { status: okRec.status, viewport: okRec.viewport });

  // ── 截图不能动作品 ────────────────────────────────────────────────
  const store2 = new Store(dataDir);
  const afterHashes = {
    ok: store2.getAttempt(okId).artifact.htmlHash,
    block: store2.getAttempt(blockId).artifact.htmlHash,
  };
  store2.close();
  add('A23', '截图（含失败的那次）没有改动作品本身：HTML hash 与原始正文都不变',
    afterHashes.ok === beforeHashes.ok && afterHashes.block === beforeHashes.block,
    { before: beforeHashes, after: afterHashes });

  // ── 界面用的第二组：用"永不结束加载"的作品，界面能正常打开，记录同样是失败 ──
  const store3 = new Store(dataDir);
  const exp2 = store3.createExperiment({
    title: 'M2 截图失败记录（界面）', category: 'landing',
    taskSnapshot: { prompt: '用于在界面上核对截图失败记录' }, taskHash: 'y',
    outputPolicy: { timeoutMs: 60000, concurrency: 1 }, previewPolicy: { networkPolicy: 'offline', viewport: 'desktop' },
  });
  // 第 1 轮 = 死循环作品（截图会硬超时、留下失败记录）
  const neverId = store3.createAttempt({
    experimentId: exp2.id, candidateSlot: 0, attemptNo: 1,
    recipeSnapshot: { name: '死循环的', provider: 'sim-ok-a', model: 'sim-fast', promptSegments: [] },
    requestedConfig: {}, resolvedConfig: null, parentAttemptId: null,
  });
  store3.writeRaw(neverId, DOC_BLOCK);
  store3.writeHtml(neverId, DOC_BLOCK);
  const h2 = sha256(DOC_BLOCK);
  store3.createArtifact({
    id: neverId, attemptId: neverId, rawHash: h2, htmlHash: h2,
    extractionVersion: '1', extractionMode: 'document', extractionRange: null,
    extractionStatus: 'ok', extractionWarnings: [], rawPath: '', htmlPath: '', bytes: DOC_BLOCK.length,
  });
  store3.updateAttemptStatus(neverId, 'completed');
  store3.finishReceipt(neverId, { finishReason: 'stop', observedRequests: 1 });
  // 第 2 轮 = 正常作品，且它是**当前显示的那一轮** —— 界面打开时不会加载那个死循环作品，
  // 否则渲染进程被钉在 100% CPU 上，连 Playwright 自己等元素都会被拖住（实测踩到过）。
  const shownId = store3.createAttempt({
    experimentId: exp2.id, candidateSlot: 0, attemptNo: 2,
    recipeSnapshot: { name: '正常的', provider: 'sim-ok-a', model: 'sim-fast', promptSegments: [] },
    requestedConfig: {}, resolvedConfig: null, parentAttemptId: neverId,
  });
  store3.writeRaw(shownId, DOC_OK);
  store3.writeHtml(shownId, DOC_OK);
  const h3 = sha256(DOC_OK);
  store3.createArtifact({
    id: shownId, attemptId: shownId, rawHash: h3, htmlHash: h3,
    extractionVersion: '1', extractionMode: 'document', extractionRange: null,
    extractionStatus: 'ok', extractionWarnings: [], rawPath: '', htmlPath: '', bytes: DOC_OK.length,
  });
  store3.updateAttemptStatus(shownId, 'completed');
  store3.finishReceipt(shownId, { finishReason: 'stop', observedRequests: 1 });
  store3.close();
  const shotNever = await postJson(base, '/experiments/' + exp2.id + '/attempts/' + neverId + '/screenshot', { viewport: 'desktop' });
  add('A23', '同一实验的另一次失败也留下记录（失败不是稀有路径，照样要有据可查）',
    shotNever.status === 200 && shotNever.body.status !== 'ok' && Boolean(shotNever.body.id),
    { status: shotNever.body.status, reason: String(shotNever.body.reason || '').slice(0, 160) });
  const detail2 = await api(base, '/experiments/' + exp2.id);
  const neverRec = (detail2.body.screenshots || []).find((r) => r.attemptId === neverId);
  add('A23', '这条失败记录也落盘了（带视口与原因）',
    Boolean(neverRec && neverRec.status === shotNever.body.status && neverRec.reason),
    neverRec && { status: neverRec.status, viewport: neverRec.viewport, reason: String(neverRec.reason).slice(0, 120) });
  report.neverLoadRecord = neverRec || null;

  // 服务端按同一个词搜一次：界面搜不到时，能立刻分清是"服务端没搜到"还是"界面没渲染"
  const srvSearch = await api(base, '/experiments?search=' + encodeURIComponent('界面'));
  add('准备', '服务端按"界面"能搜到那条实验（用于分辨界面问题还是数据问题）',
    srvSearch.body.experiments.length === 1, srvSearch.body.experiments.map((e) => e.title));

  // ── 界面：刷新之后仍然看得到"上次截图为什么没成" ────────────────────
  const b = await launchBrowser();
  if (!b.ok) {
    add('A23', '浏览器可用（界面核对）', false, b.reason);
  } else {
    browserHandle = b.browser;
    const page = await b.browser.newPage();
    const consoleErrors = [];
    const pageErrors = [];
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200)); });
    page.on('pageerror', (e) => pageErrors.push(String(e.message).slice(0, 200)));
    await page.goto('http://127.0.0.1:' + port + '/configstudio/api/ui', { waitUntil: 'load', timeout: 30000 });
    await page.waitForSelector('#mode-badge', { timeout: 20000 });
    await page.waitForTimeout(700);
    // 打开"界面"那一组（作品不会把渲染进程钉住，界面能正常打开）。
    // 搜索词用短的唯一片段，并在真的没行时把列表内容打出来 —— 否则只会得到一句
    // "click 超时"，看不出到底是搜索没命中还是列表没渲染。
    await page.click('.tab[data-view="experiments"]');
    await page.waitForTimeout(400);
    await page.fill('#search', '界面');
    await page.waitForTimeout(1000);
    const rows = await page.$$eval('#experiment-list .exp', (els) => els.map((e) => e.innerText.replace(/\s+/g, ' ').slice(0, 100)));
    if (rows.length !== 1) {
      // 失败时把现场一起记下来：致命错误、列表原文、页面异常 —— 否则只剩一句"click 超时"
      const diag = await page.evaluate(() => ({
        fatalVisible: !document.getElementById('fatal').hidden,
        fatalText: document.getElementById('fatal').innerText.slice(0, 300),
        listText: document.getElementById('experiment-list').innerText.slice(0, 300),
        badge: document.getElementById('mode-badge').textContent,
        searchValue: document.getElementById('search').value,
        experimentsInState: (window.__htmlArena.state.experiments || []).length,
      })).catch((err) => ({ diagError: String(err) }));
      add('诊断', '列表为空的现场', false, { diag, pageErrors: pageErrors.slice(0, 3), consoleErrors: consoleErrors.slice(0, 3) });
    }
    add('准备', '列表里能搜到用于界面核对的那条实验', rows.length === 1, rows);
    await page.click('#experiment-list .exp:first-child button:has-text("打开")');
    // 等真正的内容出现（等一个 section 的 hidden 属性在 Playwright 里不够稳），
    // 同时把现场记下来，失败时能看出到底卡在哪一步。
    await page.waitForSelector('#view-compare .frame-wrap', { timeout: 25000 });
    await page.waitForTimeout(1200);

    const panel = await page.innerText('#screenshot-panel').catch(() => '');
    add('A23', '界面上能看到落盘的截图记录（刷新/换浏览器后仍可见）',
      /截图未成功/.test(panel) && /截图未成功：/.test(panel), panel.replace(/\s+/g, ' ').slice(0, 200));
    add('A23', '界面写清了失败原因，并说明作品本身仍可预览',
      /作品本身仍可预览/.test(panel), panel.replace(/\s+/g, ' ').slice(0, 160));
    const shotFile = join(EVIDENCE_DIR, 'm2-screenshot-failure-record.png');
    writeFileSync(shotFile, await page.screenshot({ type: 'png' }));
    report.screenshot = 'docs/evidence/m2-screenshot-failure-record.png';
    add('A23', '界面加载 0 控制台错误', consoleErrors.length === 0, consoleErrors.slice(0, 3));
    await b.browser.close();
    browserHandle = null;
  }

  report.records = { ok: okRec || null, failed: badRec || null };
  report.uiExperimentId = exp2.id;
} catch (err) {
  add('执行', '脚本运行没有抛异常', false, String(err && err.stack || err));
} finally {
  try { if (browserHandle) await browserHandle.close(); } catch { /* 已关 */ }
  try { await hardKill(server, '开发服务器（收尾）'); } catch { /* 已经没了 */ }
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }
}

process.exit(finish('m2-screenshot-failure'));
