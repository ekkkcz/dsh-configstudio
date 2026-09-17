/**
 * 预览隔离策略测试（对应 A19 / A20 / A22 的策略部分）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sandboxAttribute, buildCsp, buildPreviewHeaders, validateCdnOrigins,
  injectBridge, validateBridgeMessage, CDN_ALLOWLIST, VIEWPORTS, isLoopbackOrigin,
} from '../src/preview/policy.js';

test('sandbox 不得同时开放 allow-scripts 与 allow-same-origin（F12）', () => {
  const s = sandboxAttribute();
  assert.ok(s.includes('allow-scripts'));
  assert.ok(!s.includes('allow-same-origin'), 'allow-same-origin 会让作品获得宿主源');
  assert.ok(!s.includes('allow-top-navigation'), '禁止顶层跳转');
  assert.ok(!s.includes('allow-popups'), '禁止弹窗');
  assert.ok(!s.includes('allow-downloads'), '下载由可信父界面提供');
  assert.ok(!s.includes('allow-modals'), 'alert 会阻塞渲染');
});

test('离线模式 CSP 切断一切外部连接', () => {
  const csp = buildCsp({ networkPolicy: 'offline' });
  assert.ok(csp.includes("default-src 'none'"));
  assert.ok(csp.includes("connect-src 'none'"), '必须禁止 fetch/WebSocket');
  assert.ok(csp.includes("object-src 'none'"));
  assert.ok(csp.includes("form-action 'none'"));
  assert.ok(!csp.includes('https://cdn.jsdelivr.net'), '离线模式不得放行 CDN');
});

test('CDN 模式只放行白名单域名，且仍然禁止 connect-src', () => {
  const csp = buildCsp({ networkPolicy: 'cdn' });
  for (const e of CDN_ALLOWLIST) assert.ok(csp.includes(e.origin), '缺少白名单源 ' + e.origin);
  assert.ok(csp.includes("connect-src 'none'"), 'CDN 模式仍禁用页面任意 fetch/WebSocket');
  assert.ok(csp.includes("frame-src 'none'"));
});

test('CDN 白名单之外的源被明确拒绝，不静默放行', () => {
  const bad = validateCdnOrigins(['https://evil.example.com']);
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.rejected, ['https://evil.example.com']);
  const good = validateCdnOrigins(['https://cdn.jsdelivr.net']);
  assert.equal(good.ok, true);
});

test('预览响应头包含全部离线必要头且不禁用脚本', () => {
  const h = buildPreviewHeaders({ networkPolicy: 'offline' });
  assert.equal(h['X-Content-Type-Options'], 'nosniff');
  assert.equal(h['Referrer-Policy'], 'no-referrer');
  assert.equal(h['Cache-Control'], 'no-store');
  assert.ok(h['Permissions-Policy'].includes('camera=()'));
  assert.ok(h['Permissions-Policy'].includes('microphone=()'));
  assert.ok(h['Content-Security-Policy'].includes("script-src 'unsafe-inline'"));
});

test('不设 X-Frame-Options：它无法表达"任意回环端口"（M0 实测）', () => {
  const h = buildPreviewHeaders({ networkPolicy: 'offline' });
  assert.equal(h['X-Frame-Options'], undefined);
});

test('默认只允许本机回环页面嵌入作品（M0 实测支持的写法）', () => {
  const csp = buildCsp({ networkPolicy: 'offline' });
  assert.ok(csp.includes('frame-ancestors http://127.0.0.1:* http://localhost:*'), '实际值：' + csp);
  // [::1]:* 经实测不被浏览器支持，不得出现在策略里（否则整条指令失效风险）
  assert.ok(!csp.includes('[::1]'), '不得使用浏览器不支持的 [::1]:* 写法');
  assert.ok(!csp.includes("frame-ancestors 'none'"), '宿主页面必须能嵌入作品');
});

test('可显式覆盖嵌入来源清单', () => {
  const csp = buildCsp({ networkPolicy: 'offline', frameAncestors: ["'none'"] });
  assert.ok(csp.includes("frame-ancestors 'none'"));
});

test('frame-ancestors 只接受回环 origin', () => {
  assert.equal(isLoopbackOrigin('http://127.0.0.1:3080'), true);
  assert.equal(isLoopbackOrigin('http://localhost:19387'), true);
  assert.equal(isLoopbackOrigin('http://[::1]:8080'), true);
  assert.equal(isLoopbackOrigin('https://evil.example.com'), false);
  assert.equal(isLoopbackOrigin('http://192.168.1.10:3080'), false);
  assert.equal(isLoopbackOrigin('file:///etc/passwd'), false);
  assert.equal(isLoopbackOrigin(undefined), false);
  assert.equal(isLoopbackOrigin('not a url'), false);
});

test('桥接脚本注入到 head 最前面', () => {
  const html = '<!DOCTYPE html><html><head><title>T</title></head><body></body></html>';
  const out = injectBridge(html, 'tok-1');
  assert.ok(out.indexOf('data-html-arena-bridge') < out.indexOf('<title>'), '桥接必须在作品脚本之前');
  assert.ok(out.includes('"tok-1"'));
  assert.ok(out.startsWith('<!DOCTYPE html><html><head>'));
});

test('没有 head 时也能注入（造一个 head）', () => {
  const out = injectBridge('<html><body>x</body></html>', 'tok-2');
  assert.ok(out.includes('<head>'));
  assert.ok(out.includes('data-html-arena-bridge'));
  const bare = injectBridge('<div>fragment</div>', 'tok-3');
  assert.ok(bare.startsWith('<script data-html-arena-bridge>'));
});

test('消息校验：来源窗口不符直接拒绝（A22 伪造 postMessage）', () => {
  const iframeWin = { name: 'iframe' };
  const attacker = { name: 'attacker' };
  const r = validateBridgeMessage({
    event: { source: attacker, data: { __htmlArena: 'tok', type: 'error', payload: {} } },
    expectedSource: iframeWin, expectedToken: 'tok',
  });
  assert.deepEqual(r, { ok: false, reason: 'unexpected-source' });
});

test('消息校验：令牌不符被拒绝', () => {
  const w = {};
  const r = validateBridgeMessage({
    event: { source: w, data: { __htmlArena: 'wrong', type: 'error' } },
    expectedSource: w, expectedToken: 'tok',
  });
  assert.deepEqual(r, { ok: false, reason: 'token-mismatch' });
});

test('消息校验：未知类型被拒绝（不获得宿主操作权限）', () => {
  const w = {};
  const r = validateBridgeMessage({
    event: { source: w, data: { __htmlArena: 'tok', type: 'setVote', payload: { choice: 'A' } } },
    expectedSource: w, expectedToken: 'tok',
  });
  assert.deepEqual(r, { ok: false, reason: 'unknown-type' });
});

test('消息校验：非对象数据被拒绝', () => {
  const w = {};
  for (const d of [null, 'x', 42, undefined]) {
    const r = validateBridgeMessage({ event: { source: w, data: d }, expectedSource: w, expectedToken: 'tok' });
    assert.equal(r.ok, false);
  }
});

test('消息校验：合法消息通过并带出载荷', () => {
  const w = {};
  const r = validateBridgeMessage({
    event: { source: w, data: { __htmlArena: 'tok', type: 'error', payload: { message: 'boom' } } },
    expectedSource: w, expectedToken: 'tok',
  });
  assert.equal(r.ok, true);
  assert.equal(r.type, 'error');
  assert.deepEqual(r.payload, { message: 'boom' });
});

test('视口预设含真实尺寸，供截图标注（F16）', () => {
  assert.equal(VIEWPORTS.desktop.width, 1280);
  assert.equal(VIEWPORTS.mobile.width, 390);
  assert.ok(VIEWPORTS.mobile.label.includes('390x844'));
});
