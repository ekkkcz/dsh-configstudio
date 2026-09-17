/**
 * M0 关键隔离试验。
 *
 * 目标（IMPLEMENTATION M0 的"关键隔离试验有结果"）：
 *  E1 独立源 + iframe sandbox（无 allow-same-origin）时，作品读不到宿主凭据/存储
 *  E2 作品弹窗 / 顶层跳转 / 请求本机 API 被预览策略阻止
 *  E3 死循环作品能被独立终止，且不卡住其它工作
 *  E4 CSP 切断外部请求；离线模式无外发
 *  E5 伪造 postMessage 不能获得宿主操作权限
 *  E6 截图标注视口/DPR/等待时间/网络策略，且能从初始状态重放
 *  E7 生成与预览互不影响：预览失败不改变生成记录
 *
 * 运行：node scripts/m0-isolation-experiment.mjs
 * 输出：docs/evidence/m0-isolation-<时间戳>.json + 控制台摘要
 *
 * 本脚本启动两个本地服务：
 *  - "宿主"模拟页（端口 A）：持有 cookie、localStorage、并暴露一个只有父界面才能调用的
 *    投票接口 —— 用来验证作品无法越权。
 *  - 预览服务（端口 B）：真实使用 src/preview 的实现。
 */
import { createServer } from 'node:http';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPreviewServer } from '../src/preview/server.js';
import { sandboxAttribute, buildPreviewHeaders, injectBridge, validateBridgeMessage } from '../src/preview/policy.js';
import { capturePreviewInSubprocess, loadPlaywright, launchBrowser, resetPlaywrightCache } from '../src/preview/browser.js';

const here = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(here, '..', 'docs', 'evidence');

const results = {
  startedAt: new Date().toISOString(),
  node: process.version,
  platform: process.platform + ' ' + process.arch,
  experiments: {},
  environment: {},
};

// ── 造几个测试作品 ────────────────────────────────────────────────────────────

// 换行用常量拼，避免源码里出现真正的多行字符串字面量。
const NL = String.fromCharCode(10);

const WORKS = {
  // 正常作品
  att_aaaaaaaaaaaaaaaaaaaa: '<!DOCTYPE html><html><head><title>正常作品</title></head><body><h1>ok</h1></body></html>',
  // 尝试读取宿主凭据与存储，并把结果写到页面上供截图取证
  att_bbbbbbbbbbbbbbbbbbbb: [
    '<!DOCTYPE html><html><head><title>越权尝试</title></head><body><pre id="r"></pre><script>',
    'var out = {};',
    'try { out.cookie = document.cookie || "(空)"; } catch (e) { out.cookie = "抛异常: " + e.name; }',
    'try { localStorage.setItem("leak", "1"); out.localStorage = "可写:" + localStorage.getItem("leak"); } catch (e) { out.localStorage = "抛异常: " + e.name; }',
    'try { out.parentTitle = parent.document.title; } catch (e) { out.parentTitle = "抛异常: " + e.name; }',
    'try { out.topHref = top.location.href; } catch (e) { out.topHref = "抛异常: " + e.name; }',
    'try { out.hostApi = "尝试中"; } catch (e) { out.hostApi = String(e); }',
    'fetch("/host-vote", { method: "POST" }).then(function(r){ out.hostApi = "竟然成功 " + r.status; })',
    '  .catch(function(e){ out.hostApi = "被阻止: " + String(e); })',
    '  .then(function(){',
    '    try { window.open("https://example.com", "_blank"); out.popup = "window.open 未抛异常"; } catch (e) { out.popup = "被阻止: " + e.name; }',
    '    try { top.location.href = "https://example.com"; out.topNav = "赋值未抛异常"; } catch (e) { out.topNav = "被阻止: " + e.name; }',
    '    document.getElementById("r").textContent = JSON.stringify(out, null, 2);',
    '    try { parent.postMessage({ __expReport: out }, "*"); } catch (e) {}',
    '  });',
    '</script></body></html>',
  ].join(NL),
  // 死循环 + 大量日志
  att_cccccccccccccccccccc: [
    '<!DOCTYPE html><html><head><title>死循环</title></head><body>',
    '<script>',
    'var n = 0;',
    'for (;;) { n++; if (n % 1000000 === 0) console.log("spam " + n); }',
    '</script></body></html>',
  ].join(NL),
  // 尝试外发到未授权域名（验证 CSP connect-src 'none'）
  att_dddddddddddddddddddd: [
    '<!DOCTYPE html><html><head><title>外发尝试</title></head><body><pre id="r"></pre><script>',
    'var out = {};',
    'fetch("https://example.com/steal").then(function(){ out.external = "竟然成功"; })',
    '  .catch(function(e){ out.external = "被阻止: " + String(e); })',
    '  .then(function(){',
    '    var img = new Image(); img.src = "https://example.com/pixel.png";',
    '    img.onerror = function(){ out.image = "图片加载失败（被 CSP 阻止）"; };',
    '    img.onload = function(){ out.image = "图片竟然加载成功"; };',
    '    setTimeout(function(){',
    '      document.getElementById("r").textContent = JSON.stringify(out, null, 2);',
    '      try { parent.postMessage({ __expReport: out }, "*"); } catch (e) {}',
    '    }, 500);',
    '  });',
    '</script></body></html>',
  ].join(NL),
};

// ── 宿主模拟页：持有凭据，并暴露一个"只有父界面才能调用"的接口 ────────────────

function startHostSimulation() {
  const server = createServer((req, res) => {
    if (req.url === '/host-vote') {
      // 这个接口故意不校验任何东西：只要能请求到，就说明隔离失败。
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ voted: true, secret: 'HOST_SECRET_VALUE' }));
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Set-Cookie': 'host_session=HOST_SECRET_COOKIE; Path=/; HttpOnly=false; SameSite=Lax',
    });
    res.end('<!DOCTYPE html><html><head><title>宿主页面</title></head><body>'
      + '<script>localStorage.setItem("hostToken","HOST_LOCALSTORAGE_TOKEN");</script>'
      + 'HOST</body></html>');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
  });
}

// ── 主流程 ───────────────────────────────────────────────────────────────────

const pwInfo = await loadPlaywright();
const probeLaunch = pwInfo.ok ? await launchBrowser() : { ok: false, reason: pwInfo.reason, attempts: pwInfo.tried };
results.environment.playwright = pwInfo.ok
  ? { ok: probeLaunch.ok, candidates: pwInfo.candidates.map((c) => c.resolvedFrom), usedForProbe: probeLaunch.resolvedFrom ?? null, launchError: probeLaunch.ok ? null : probeLaunch.reason, attempts: probeLaunch.attempts ?? [] }
  : { ok: false, reason: pwInfo.reason, tried: pwInfo.tried };
if (probeLaunch.ok) { try { await probeLaunch.browser.close(); } catch { /* 已关闭 */ } }

const host = await startHostSimulation();
const preview = createPreviewServer({ getHtml: (id) => WORKS[id] ?? null });
const previewAddr = await preview.listen();
results.environment.hostOrigin = 'http://127.0.0.1:' + host.port;
results.environment.previewOrigin = previewAddr.origin;
results.environment.sandboxAttribute = sandboxAttribute();

if (!probeLaunch.ok) {
  results.summary = '没有可用的浏览器，浏览器相关试验全部标记为未测（不伪造通过）。原因：' + (probeLaunch.reason || '未知');
  mkdirSync(OUT_DIR, { recursive: true });
  const p = join(OUT_DIR, 'm0-isolation-' + Date.now() + '.json');
  writeFileSync(p, JSON.stringify(results, null, 2), 'utf8');
  console.log(JSON.stringify(results, null, 2));
  console.log('证据已写入', p);
  process.exit(0);
}

/** 在宿主页面里创建 iframe 承载作品，并把作品页面的越权尝试结果读回来。 */
async function runInIsolatedIframe(attemptId, { useSandbox = true, timeoutMs = 8000 } = {}) {
  const b = await launchBrowser();
  if (!b.ok) throw new Error('无法启动浏览器：' + b.reason);
  const browser = b.browser;
  const context = await browser.newContext({ viewport: { width: 900, height: 600 } });
  const page = await context.newPage();
  const mainFrameConsole = [];
  page.on('console', (m) => mainFrameConsole.push({ type: m.type(), text: m.text().slice(0, 300) }));
  const popups = [];
  context.on('page', (p) => popups.push(p.url()));
  let dialogText = null;
  page.on('dialog', async (d) => { dialogText = d.message(); await d.dismiss().catch(() => {}); });
  const navigationAttempts = [];
  page.on('framenavigated', (f) => { if (f !== page.mainFrame()) navigationAttempts.push(f.url()); });

  // 先访问宿主页，让宿主 cookie / localStorage 真实存在
  await page.goto(results.environment.hostOrigin, { waitUntil: 'load' });

  const url = previewAddr.origin + '/preview/' + attemptId + '?token=tok-test&network=offline';
  // 作品通过 postMessage 自报结果：即便它处在不透明源里也能送出（这正是我们要的取证通道）
  const reported = [];
  page.on('message', (msg) => {
    const d = msg.data;
    if (d && typeof d === 'object' && d.__expReport) reported.push(d.__expReport);
  });

  const sandboxAttr = useSandbox ? sandboxAttribute() : 'allow-scripts allow-same-origin';
  await page.evaluate(({ url, sandboxAttr }) => {
    const f = document.createElement('iframe');
    f.id = 'arena-frame';
    f.setAttribute('sandbox', sandboxAttr);
    f.style.cssText = 'width:700px;height:400px';
    f.src = url;
    document.body.appendChild(f);
    return new Promise((resolve) => { f.onload = resolve; setTimeout(resolve, 3000); });
  }, { url, sandboxAttr });

  await page.waitForTimeout(Math.min(1500, timeoutMs));

  // 读 iframe 内部报告（如果它在 DOM 里写了结果）。跨源时 evaluate 会抛异常，这也是证据。
  let innerReport = null;
  let innerReportError = null;
  try {
    const handle = await page.$('#arena-frame');
    const frame = await handle.contentFrame();
    if (frame) {
      innerReport = await frame.evaluate(() => {
        const el = document.getElementById('r');
        return el ? el.textContent : null;
      });
    }
  } catch (err) {
    innerReportError = String(err && err.message || err).slice(0, 300);
  }

  const hostStorage = await page.evaluate(() => ({
    cookie: document.cookie,
    hostToken: localStorage.getItem('hostToken'),
  }));

  // 真正尝试从宿主页直接请求自己的投票接口，作为"可访问性"对照基线
  const hostApiFromHost = await page.evaluate(async () => {
    try { const r = await fetch('/host-vote', { method: 'POST' }); return { ok: true, status: r.status }; }
    catch (e) { return { ok: false, error: String(e) }; }
  });

  await browser.close();
  // 首选 postMessage 报告（跨源可用）；其次才是同源 DOM 读取（对照组能成功）
  const fromPostMessage = reported.length > 0 ? reported[reported.length - 1] : null;
  return {
    innerReport: fromPostMessage ?? (innerReport ? safeJson(innerReport) : null),
    innerReportSource: fromPostMessage ? 'postMessage' : (innerReport ? 'same-origin-dom' : 'none'),
    innerReportRaw: innerReport,
    innerReportError,
    hostStorage,
    hostApiFromHost,
    popupsOpened: popups,
    popupCount: popups.length,
    dialogText,
    frameNavigations: navigationAttempts,
    consoleSample: mainFrameConsole.slice(0, 10),
  };
}

function safeJson(s) { try { return JSON.parse(s); } catch { return null; } }

// ── E1/E2/E4/E5：越权尝试 ────────────────────────────────────────────────────
results.experiments.E1_E2_E4_E5_hostile_work = await runInIsolatedIframe('att_bbbbbbbbbbbbbbbbbbbb');

// 对照组：如果去掉 sandbox 的隔离（加上 allow-same-origin），会发生什么？
// 这不是我们要的配置，只是用来证明我们的配置确实起了作用。
results.experiments.control_unsafe_sandbox = await runInIsolatedIframe('att_bbbbbbbbbbbbbbbbbbbb', { useSandbox: false });

// ── E4：CSP 外发阻断 ─────────────────────────────────────────────────────────
results.experiments.E4_external_request = await runInIsolatedIframe('att_dddddddddddddddddddd');

// ── E3：死循环可被独立终止 ───────────────────────────────────────────────────
{
  const t0 = Date.now();
  const cap = await capturePreviewInSubprocess({
    url: previewAddr.origin + '/preview/att_cccccccccccccccccccc?token=tok-loop&network=offline',
    viewport: { width: 800, height: 600 },
    timeoutMs: 4000,
    screenshot: true,
  });
  const elapsed = Date.now() - t0;
  // 再证明主进程没被卡住：立刻做一次普通 HTTP 请求
  const t1 = Date.now();
  const health = await fetch(previewAddr.origin + '/healthz').then((r) => r.json());
  results.experiments.E3_infinite_loop = {
    captureStatus: cap.status,
    durationMs: elapsed,
    hardTerminated: cap.status === 'timeout' || cap.status === 'screenshot_failed' || cap.status === 'navigation_failed',
    stillResponsiveAfter: health.ok === true,
    responsiveLatencyMs: Date.now() - t1,
    detail: cap.status === 'timeout' ? cap.reason : { hasScreenshot: Boolean(cap.screenshotBase64), pageErrors: cap.pageErrors?.slice(0, 3) },
  };
}

// ── E6：正常作品截图，含视口/DPR/等待时间/网络策略标注 ────────────────────────
{
  const cap = await capturePreviewInSubprocess({
    url: previewAddr.origin + '/preview/att_aaaaaaaaaaaaaaaaaaaa?token=tok-ok&network=offline',
    viewport: { width: 1280, height: 720 },
    dpr: 2,
    timeoutMs: 10000,
    screenshot: true,
  });
  results.experiments.E6_screenshot = {
    status: cap.status,
    viewport: cap.viewport,
    dpr: cap.dpr,
    waitUntil: cap.waitUntil,
    durationMs: cap.durationMs,
    stateNote: cap.stateNote,
    title: cap.title,
    screenshotBytes: cap.screenshotBase64 ? Math.floor(cap.screenshotBase64.length * 3 / 4) : 0,
    hasScreenshot: Boolean(cap.screenshotBase64),
  };
}

// ── E5：伪造 postMessage ─────────────────────────────────────────────────────
{
  const b = await launchBrowser();
  if (!b.ok) throw new Error('无法启动浏览器：' + b.reason);
  const browser = b.browser;
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(results.environment.hostOrigin, { waitUntil: 'load' });

  const realToken = 'real-token-123';
  const iframeSource = await page.evaluate(() => {
    const f = document.createElement('iframe');
    f.setAttribute('sandbox', 'allow-scripts');
    f.id = 'f';
    document.body.appendChild(f);
    return f.contentWindow === null ? 'null' : 'set';
  });

  // 分别用 4 种伪造方式试探父界面的校验函数
  const trials = await page.evaluate(async ({ previewOriginUrl, token }) => {
    const results = [];
    const iframe = document.getElementById('f');
    await new Promise((r) => { iframe.onload = r; iframe.src = 'about:blank'; setTimeout(r, 500); });

    const cases = [
      { name: '正确来源+错误令牌', source: iframe.contentWindow, data: { __htmlArena: 'wrong-token', type: 'error', payload: {} } },
      { name: '正确来源+未知类型', source: iframe.contentWindow, data: { __htmlArena: token, type: 'vote', payload: { choice: 'A' } } },
      { name: '外部窗口+正确令牌', source: window.opener || window.top, data: { __htmlArena: token, type: 'error', payload: {} } },
      { name: '正确来源+正确令牌', source: iframe.contentWindow, data: { __htmlArena: token, type: 'error', payload: { message: 'x' } } },
    ];
    for (const c of cases) {
      // 复制校验逻辑的输入形状：这里只记录来源是否等于我们期望的 iframe
      results.push({
        name: c.name,
        sourceIsExpectedIframe: c.source === iframe.contentWindow,
        tokenMatches: c.data.__htmlArena === token,
        typeKnown: ['error', 'unhandledrejection', 'console', 'ready', 'domcontentloaded', 'load'].includes(c.data.type),
      });
    }
    return results;
  }, { previewOriginUrl: previewAddr.origin, token: realToken });

  await browser.close();

  // 再用真正的实现函数验证一遍（这是权威结论）
  const iframeWin = { id: 'iframe' };
  const otherWin = { id: 'other' };
  const implResults = {
    externalSourceRejected: validateBridgeMessage({ event: { source: otherWin, data: { __htmlArena: realToken, type: 'error' } }, expectedSource: iframeWin, expectedToken: realToken }),
    wrongTokenRejected: validateBridgeMessage({ event: { source: iframeWin, data: { __htmlArena: 'nope', type: 'error' } }, expectedSource: iframeWin, expectedToken: realToken }),
    unknownTypeRejected: validateBridgeMessage({ event: { source: iframeWin, data: { __htmlArena: realToken, type: 'vote' } }, expectedSource: iframeWin, expectedToken: realToken }),
    validAccepted: validateBridgeMessage({ event: { source: iframeWin, data: { __htmlArena: realToken, type: 'error', payload: { message: 'boom' } } }, expectedSource: iframeWin, expectedToken: realToken }),
  };

  results.experiments.E5_forged_postmessage = { browserTrials: trials, implementationResults: implResults };
}

// ── E7：响应头实测 ───────────────────────────────────────────────────────────
{
  const r = await fetch(previewAddr.origin + '/preview/att_aaaaaaaaaaaaaaaaaaaa?token=t&network=offline');
  const headers = {};
  r.headers.forEach((v, k) => { headers[k] = v; });
  results.experiments.E7_response_headers = { status: r.status, headers };
}

// ── E8：错误页不留白屏 ───────────────────────────────────────────────────────
{
  const r = await fetch(previewAddr.origin + '/preview/att_xxxxxxxxxxxxxxxxxxxx?token=t');
  const body = await r.text();
  results.experiments.E8_missing_work = {
    status: r.status,
    hasHumanReadableMessage: body.includes('还没有可预览的 HTML'),
    bodyPreview: body.slice(0, 200),
  };
}

// ── E9：非法 ID 被拒（路径穿越防护） ─────────────────────────────────────────
{
  const attempts = [];
  for (const bad of ['../../etc/passwd', 'att_short', '..%2F..%2Fpackage.json', 'att_' + 'f'.repeat(20) + 'x']) {
    const r = await fetch(previewAddr.origin + '/preview/' + encodeURIComponent(bad) + '?token=t');
    attempts.push({ id: bad, status: r.status, rejected: r.status === 400 || r.status === 404 });
  }
  results.experiments.E9_path_traversal = { attempts, allRejected: attempts.every((a) => a.rejected) };
}

// ── 收尾 ─────────────────────────────────────────────────────────────────────
preview.close();
host.server.close();

// 汇总判定
const e = results.experiments;
const hostile = e.E1_E2_E4_E5_hostile_work.innerReport;
results.summary = {
  'E1 宿主存储不可读': {
    pass: hostile ? (String(hostile.cookie || '').includes('(空)') || String(hostile.cookie || '').includes('抛异常')) : null,
    detail: hostile ? hostile.cookie : '未取到内部报告',
  },
  'E1b localStorage 不可用': {
    pass: hostile ? String(hostile.localStorage || '').includes('抛异常') : null,
    detail: hostile ? hostile.localStorage : null,
  },
  'E2 parent DOM 不可访问': {
    pass: hostile ? String(hostile.parentTitle || '').includes('抛异常') : null,
    detail: hostile ? hostile.parentTitle : null,
  },
  'E2b 宿主 API 不可达': {
    pass: hostile ? String(hostile.hostApi || '').includes('被阻止') : null,
    detail: hostile ? hostile.hostApi : null,
  },
  'E2c 无弹窗': { pass: e.E1_E2_E4_E5_hostile_work.popupCount === 0, detail: e.E1_E2_E4_E5_hostile_work.popupsOpened },
  'E4 外部请求被阻断': {
    pass: (() => { const r = e.E4_external_request.innerReport; return r ? String(r.external || '').includes('被阻止') || String(r.image || '').includes('失败') : null; })(),
    detail: e.E4_external_request.innerReport,
  },
  'E3 死循环可终止且主进程不受影响': {
    pass: e.E3_infinite_loop.hardTerminated && e.E3_infinite_loop.stillResponsiveAfter,
    detail: e.E3_infinite_loop,
  },
  'E6 截图带完整标注': {
    pass: e.E6_screenshot.status === 'ok' && e.E6_screenshot.dpr === 2 && Boolean(e.E6_screenshot.stateNote),
    detail: e.E6_screenshot,
  },
  'E5 伪造消息被拒': {
    pass: Object.values(e.E5_forged_postmessage.implementationResults).every((r, i) => (i === 3 ? r.ok === true : r.ok === false)),
    detail: e.E5_forged_postmessage.implementationResults,
  },
  'E9 路径穿越被拒': { pass: e.E9_path_traversal.allRejected, detail: e.E9_path_traversal.attempts },
  '对照：不安全 sandbox 确实更弱': {
    pass: e.control_unsafe_sandbox.innerReport
      ? String(e.control_unsafe_sandbox.innerReport.localStorage || '').includes('可写')
      : null,
    detail: e.control_unsafe_sandbox.innerReport,
  },
};

results.finishedAt = new Date().toISOString();
mkdirSync(OUT_DIR, { recursive: true });
const outPath = join(OUT_DIR, 'm0-isolation-' + Date.now() + '.json');
writeFileSync(outPath, JSON.stringify(results, null, 2), 'utf8');

console.log(JSON.stringify({ summary: results.summary, environment: results.environment }, null, 2));
console.log('\n完整证据：' + outPath);
