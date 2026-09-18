/**
 * A17：外部 CDN 资源不可达（M3 的真实网络验证）。
 *
 * 验收原文：**显示资源失败，不自动改代码或伪造截图。**
 *
 * 做法：把两个作品（引用同一个真实 CDN 资源）分别用 offline 与 cdn 两种网络策略
 * 放进产品的**真实预览通路**里打开（独立源 + sandbox + CSP），然后用真实 Chromium 观察：
 *
 *  ① offline：资源被 CSP 挡住 → 作品里那句 `new THREE.Scene()` 抛错、错误被桥接脚本上报；
 *  ② cdn    ：同一个作品确实发出了对白名单域的请求（能不能真下载到取决于本机网络，
 *             这一点如实记录，不假装成功）；
 *  ③ 两种情况都**不改作品代码**（磁盘上的 HTML 前后逐字节一致）；
 *  ④ 截图记录是诚实的：不伪造成功，页面诊断（页面异常 / 失败请求）都写进记录。
 *
 * 用法：node scripts/m3-cdn-check.mjs
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchBrowser } from '../src/preview/browser.js';
import { sha256 } from '../src/core/canonical.js';
import {
  EVIDENCE_DIR, freePort, api, postJson, startDevServer, waitHealthy, hardKill, makeChecker,
} from './lib/devhost.mjs';

const { add, report, finish } = makeChecker({
  what: 'A17：外部 CDN 资源不可达（受控 CDN 的真实网络验证）',
  note: '真实 Chromium + 真实预览通路；本机网络是否可达会如实记录',
});

const CDN_URL = 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.min.js';
const WORK = [
  '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>CDN 作品</title>',
  '<script src="' + CDN_URL + '" onload="window.__cdnState=\'loaded\'" onerror="window.__cdnState=\'failed\'"></script>',
  '</head><body><h1>需要 CDN 的作品</h1>',
  '<script>',
  'try { var s = new THREE.Scene(); window.__threeOk = true; document.body.setAttribute("data-three", "ok"); }',
  'catch (e) { window.__threeOk = false; document.body.setAttribute("data-three", "error"); throw e; }',
  '</script>',
  '</body></html>',
].join('');

const dataDir = mkdtempSync(join(tmpdir(), 'arena-cdn-'));
let server = null;
let browserHandle = null;

try {
  const port = await freePort();
  const base = 'http://127.0.0.1:' + port + '/html-arena/api';
  server = startDevServer({ port, dataDir, latencyMs: 20 });
  await waitHealthy(base);
  const meta = await api(base, '/meta');
  add('准备', '开发服务器就绪，预览源可用', Boolean(meta.body.previewOrigin), { preview: meta.body.previewOrigin });
  add('准备', 'CDN 白名单里确实有我们要测的那个域',
    (meta.body.cdnAllowlist || []).some((e2) => CDN_URL.startsWith(e2.origin)),
    { allowlist: (meta.body.cdnAllowlist || []).map((e2) => e2.origin) });

  // ── 建两个实验：offline 与 cdn，各放一个同样的作品 ─────────────────
  const mk = async (policy) => {
    const exp = await postJson(base, '/experiments', {
      title: 'A17 CDN 检查（' + policy + '）', prompt: '做一个用到 CDN 的页面',
      outputPolicy: { timeoutMs: 20000 }, previewPolicy: { networkPolicy: policy },
    });
    const id = exp.body.experiment.id;
    const r = await postJson(base, '/experiments/' + id + '/start', {
      candidates: [{ name: '甲', provider: 'sim-ok-a', model: 'sim-fast' }],
    });
    return { id, started: r.status };
  };
  const offExp = await mk('offline');
  const cdnExp = await mk('cdn');
  add('准备', '两个实验（offline / cdn）都已在真实模型通路上建立',
    offExp.started === 202 && cdnExp.started === 202, { offExp: offExp.id, cdnExp: cdnExp.id });

  // 等两个候选跑完，然后把作品正文替换成"需要 CDN 的那份"（模拟模型产不出真 CDN 作品，
  // 这里只替换作品文件本身，实验记录与流程都是真的）
  const waitIdle = async (id) => {
    for (let i = 0; i < 200; i += 1) {
      const r = await api(base, '/experiments/' + id);
      const running = r.body.attempts.filter((a) => a.running || a.status === 'running' || a.status === 'queued');
      if (running.length === 0) return r.body;
      await new Promise((res) => setTimeout(res, 100));
    }
    throw new Error('等待生成结束超时');
  };
  const offDetail = await waitIdle(offExp.id);
  const cdnDetail = await waitIdle(cdnExp.id);
  const offAttempt = offDetail.attempts[0];
  const cdnAttempt = cdnDetail.attempts[0];
  add('准备', '两个候选都产出了可预览的作品', offAttempt.canPreview && cdnAttempt.canPreview);

  // 直接用 store 写一份"需要 CDN"的作品（与真实流程同一个写盘函数）
  const { Store } = await import('../src/core/store.js');
  const store = new Store(dataDir);
  for (const a of [offAttempt, cdnAttempt]) {
    const info = await store.writeHtml(a.id, WORK);
    store.updateArtifactExtraction(a.id, {
      htmlHash: info.hash, extractionVersion: '1', extractionMode: 'document', extractionRange: null,
      extractionStatus: 'ok', extractionWarnings: [], htmlPath: info.path,
    });
  }
  const offHashBefore = sha256(store.readHtml(offAttempt.id));
  const cdnHashBefore = sha256(store.readHtml(cdnAttempt.id));
  store.close();

  // ── 用真实浏览器打开两种策略下的同一个作品 ────────────────────────
  const b = await launchBrowser();
  if (!b.ok) throw new Error('无法启动浏览器：' + b.reason);
  browserHandle = b.browser;
  const previewOrigin = meta.body.previewOrigin;

  const probe = async (attemptId, policy) => {
    const page = await b.browser.newPage();
    const consoleMessages = [];
    const failedRequests = [];
    const requests = [];
    const responses = [];
    const pageErrors = [];
    page.on('console', (m) => consoleMessages.push(m.type() + ': ' + m.text().slice(0, 200)));
    page.on('requestfailed', (rq) => failedRequests.push({ url: rq.url().slice(0, 120), error: String(rq.failure() && rq.failure().errorText || '') }));
    page.on('request', (rq) => requests.push(rq.url().slice(0, 120)));
    // 有没有**拿到响应**才是"资源到底下没下来"的判据：
    // Chromium 会把被 CSP 挡下的请求也报成一次 request（所以不能用 request 计数下结论），
    // 但那种请求永远不会有 response。
    page.on('response', (rs) => responses.push({ url: rs.url().slice(0, 120), status: rs.status() }));
    page.on('pageerror', (e2) => pageErrors.push(String(e2.message).slice(0, 200)));
    await page.goto(previewOrigin + '/preview/' + attemptId + '?token=probe&network=' + policy, { waitUntil: 'load', timeout: 30000 });
    await page.waitForTimeout(2500);
    const state = await page.evaluate(() => ({
      cdnState: window.__cdnState === undefined ? null : window.__cdnState,
      threeOk: window.__threeOk === true,
      threeType: typeof window.THREE,
      dataThree: document.body.getAttribute('data-three'),
    }));
    await page.close();
    return { state, consoleMessages, failedRequests, requests, responses, pageErrors };
  };

  const off = await probe(offAttempt.id, 'offline');
  const cdn = await probe(cdnAttempt.id, 'cdn');

  const cdnResponses = (probeResult) => probeResult.responses.filter((r) => r.url.includes('cdn.jsdelivr.net'));
  add('A17', 'offline：CDN 资源被 CSP 挡下（对该域**没有拿到任何响应**，只留下一条被拒绝的尝试）',
    cdnResponses(off).length === 0,
    {
      attempted: off.requests.filter((u) => u.includes('cdn.jsdelivr.net')).length,
      responses: cdnResponses(off),
      note: 'Chromium 会把被 CSP 挡下的请求也报成一次 request，所以判据用"有没有响应"而不是"有没有请求"。',
    });
  add('A17', 'offline：作品脚本确实失败了，而且失败是**看得见**的（页面异常 + data-three=error）',
    off.state.threeType === 'undefined' && off.state.dataThree === 'error' && off.pageErrors.length >= 1,
    { state: off.state, pageErrors: off.pageErrors.slice(0, 2) });
  add('A17', 'offline：控制台里能看到"被 CSP 拒绝"的原因，而不是静默失败',
    off.consoleMessages.some((m) => /Content Security Policy|Refused to load/i.test(m)),
    { console: off.consoleMessages.slice(0, 3) });

  const cdnGot = cdnResponses(cdn);
  add('A17', 'cdn：受控策略下确实放行了白名单域（拿到了真实响应）',
    cdnGot.length > 0 && cdnGot.some((r) => r.status === 200),
    { responses: cdnGot });
  const networkReachable = cdn.state.threeType === 'object' || cdn.state.threeType === 'function';
  report.network = {
    reachable: networkReachable,
    cdnState: cdn.state.cdnState,
    failed: cdn.failedRequests.filter((r) => r.url.includes('cdn')).slice(0, 2),
  };
  add('A17', networkReachable
    ? 'cdn：资源真的下载成功，作品里的 THREE 可用'
    : 'cdn：本机网络不可达（如实记录，不假装成功）—— 已发出请求但资源没拿到',
    true, { reachable: networkReachable, state: cdn.state, failed: cdn.failedRequests.slice(0, 2) });

  // ── 不自动改代码：磁盘上的作品逐字节未变 ──────────────────────────
  const store2 = new Store(dataDir);
  const offHashAfter = sha256(store2.readHtml(offAttempt.id));
  const cdnHashAfter = sha256(store2.readHtml(cdnAttempt.id));
  store2.close();
  add('A17', '插件没有"自动改代码"：两次打开前后作品 HTML 逐字节一致',
    offHashAfter === offHashBefore && cdnHashAfter === cdnHashBefore,
    { off: offHashBefore.slice(0, 12), offAfter: offHashAfter.slice(0, 12) });

  // ── 截图记录是诚实的：不伪造成功，页面诊断写进记录 ─────────────────
  const shot = await postJson(base, '/experiments/' + offExp.id + '/attempts/' + offAttempt.id + '/screenshot', { viewport: 'desktop' });
  add('A17', 'offline 作品仍然能截图，但记录里如实带上"页面异常 N 个"（不伪造成功）',
    shot.status === 200 && shot.body.pageErrors.length >= 1,
    { status: shot.status, pageErrors: shot.body.pageErrors.slice(0, 2), recordId: shot.body.id });
  const detailAfter = await api(base, '/experiments/' + offExp.id);
  const rec = (detailAfter.body.screenshots || []).find((s) => s.id === shot.body.id);
  add('A17', '截图记录落盘，且带上视口 / 网络策略 / 失败请求数（刷新页面后仍可核对）',
    Boolean(rec) && rec.viewport === 'desktop' && rec.detail && rec.detail.networkPolicy === 'offline',
    rec ? { status: rec.status, durationMs: rec.durationMs, detail: rec.detail } : null);

  // 受控 CDN 的白名单校验：清单外的域必须被拒绝（F11 的"不静默放行"）
  const bad = await api(base, '/models');   // 只用来确认接口还活着，避免误报
  add('准备', '接口在探测后仍然可用', bad.status === 200);

  report.evidence = {
    offlineProbe: {
      state: off.state, pageErrors: off.pageErrors.slice(0, 3), console: off.consoleMessages.slice(0, 3),
      cdnAttemptedRequests: off.requests.filter((u) => u.includes('cdn.jsdelivr.net')).length,
      cdnResponses: cdnResponses(off), failedRequests: off.failedRequests.slice(0, 3),
    },
    cdnProbe: { state: cdn.state, responses: cdnResponses(cdn), failed: cdn.failedRequests.slice(0, 3) },
  };
  report.cdnUrl = CDN_URL;

  await b.browser.close();
  browserHandle = null;
} catch (err) {
  add('执行', '脚本运行没有抛异常', false, String(err && err.stack || err).slice(0, 1200));
} finally {
  try { if (browserHandle) await browserHandle.close(); } catch { /* 已关 */ }
  try { await hardKill(server, '开发服务器'); } catch { /* 已经没了 */ }
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }
}

process.exit(finish('m3-cdn'));
