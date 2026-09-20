/**
 * 预览服务 —— 作品在独立源上运行，绝不放进宿主页面执行（F12）。
 *
 * 隔离设计（M0 关键试验，逐条对应验收）：
 *  1. 独立端口 = 独立 origin。浏览器同源策略下，作品的 origin 与宿主不同，
 *     因此作品的 document.cookie / localStorage / sessionStorage 都是它自己的空域，
 *     读不到宿主的任何凭据（A19）。
 *     ⚠️ 这不等于 cookie 隔离：cookie 按域而非端口隔离，所以本服务额外设置
 *     __Host- 前缀之外的做法是——不使用任何 cookie，并对每个作品加载使用独立的
 *     iframe sandbox（无 allow-same-origin），使 document.cookie 直接抛异常。
 *  2. iframe sandbox 不含 allow-same-origin：即使作品与预览服务同源，
 *     iframe 内文档也被当作不透明源，无法读写该源的存储、无法访问父窗口 DOM。
 *  3. 响应头 CSP：默认 default-src 'none'，切断外部请求、表单外发、弹窗框架。
 *  4. postMessage 校验：父界面只接受来自我们创建的 iframe 且令牌匹配的已知消息类型。
 *
 * 作品目录与 API 服务分端口，且作品目录只读、不可枚举。
 *
 * @module configstudio/preview/server
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { buildPreviewHeaders, injectBridge, VIEWPORTS, buildCsp } from './policy.js';
import { escapeHtml } from '../core/html.js';

/**
 * @param {object} options
 * @param {() => string|null} options.getHtml 用对象 ID 取作品 HTML 的回调（返回 null 表示没有）
 * @param {string} [options.host]
 * @param {number} [options.port] 0 = 由系统分配
 */
export function createPreviewServer({ getHtml, host = '127.0.0.1', port = 0 }) {
  const server = createServer((req, res) => {
    try {
      handle(req, res, getHtml);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('预览服务内部错误：' + (err && err.message ? err.message : String(err)));
    }
  });

  return {
    server,
    /** @returns {Promise<{port:number, origin:string}>} */
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          const addr = server.address();
          resolve({ port: addr.port, origin: 'http://' + host + ':' + addr.port });
        });
      });
    },
    close() {
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

/** 合法的作品 ID：服务端生成格式，拒绝一切其它形状（防路径穿越）。 */
const ID_RE = /^att_[a-f0-9]{20}$/;

function handle(req, res, getHtml) {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;

  if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' }).end('只允许 GET');
    return;
  }

  // /healthz —— 供宿主与测试探活
  if (path === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify({ ok: true }));
    return;
  }

  // /preview/<attemptId>?token=<runToken>&network=offline|cdn
  const m = /^\/preview\/([^/]+)$/.exec(path);
  if (m) {
    const id = decodeURIComponent(m[1]);
    if (!ID_RE.test(id)) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end('非法的作品 ID');
      return;
    }
    const html = getHtml(id);
    if (html === null || html === undefined) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' }).end(errorPage('这个作品还没有可预览的 HTML', '生成未完成或未被识别为作品。你仍可以在实验详情里下载原始输出。'));
      return;
    }
    const runToken = url.searchParams.get('token') || '';
    const networkPolicy = url.searchParams.get('network') === 'cdn' ? 'cdn' : 'offline';
    const body = injectBridge(html, runToken);
    const headers = buildPreviewHeaders({ networkPolicy });
    headers['Content-Length'] = Buffer.byteLength(body, 'utf8');
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : body);
    return;
  }

  // /selftest —— 隔离自检页（M0 证据收集用，不含任何宿主敏感数据）
  if (path === '/selftest') {
    const body = selftestPage();
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': buildCsp({ networkPolicy: 'offline' }),
      'Cache-Control': 'no-store',
    });
    res.end(body);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('未找到：' + path);
}

/** 失败时给出人能读懂的原因与下一步，不留白屏（PRD 7）。 */
function errorPage(title, hint) {
  return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">'
    + '<style>body{font:14px/1.6 system-ui,sans-serif;margin:0;padding:24px;color:#c9d1d9;background:#0d1117}'
    + 'h1{font-size:16px;margin:0 0 8px}p{margin:0;color:#8b949e}</style></head><body>'
    + '<h1>' + escapeHtml(title) + '</h1><p>' + escapeHtml(hint) + '</p></body></html>';
}

/** 隔离自检页：在作品同源的上下文里尝试各种越界动作，把结果报给父窗口。 */
function selftestPage() {
  return [
    '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>隔离自检</title></head><body>',
    '<pre id="out" style="font:12px/1.5 monospace;white-space:pre-wrap"></pre>',
    '<script>',
    'var results = {};',
    'function check(name, fn){ try { results[name] = { ok: true, value: String(fn()) }; } catch (e) { results[name] = { ok: false, error: String(e && e.name || e) + ": " + String(e && e.message || "") }; } }',
    'check("document.cookie", function(){ return document.cookie; });',
    'check("localStorage", function(){ localStorage.setItem("probe","1"); return localStorage.getItem("probe"); });',
    'check("parentDocument", function(){ return parent.document.title; });',
    'check("topLocation", function(){ return top.location.href; });',
    'check("indexedDB", function(){ return typeof indexedDB; });',
    'check("serviceWorker", function(){ return typeof navigator.serviceWorker; });',
    'check("mediaDevices", function(){ return typeof navigator.mediaDevices; });',
    'fetch("/healthz").then(function(r){ results.fetchSelf = { ok: true, value: "同源 fetch 允许(状态 "+r.status+")" }; })',
    '  .catch(function(e){ results.fetchSelf = { ok: false, error: String(e) }; })',
    '  .then(function(){',
    '    return fetch("https://example.com/should-be-blocked").then(function(){ results.fetchExternal = { ok: true, value: "外部 fetch 竟然成功了" }; })',
    '      .catch(function(e){ results.fetchExternal = { ok: false, error: "被阻止: " + String(e) }; });',
    '  })',
    '  .then(function(){',
    '    document.getElementById("out").textContent = JSON.stringify(results, null, 2);',
    '    try { parent.postMessage({ __htmlArenaSelftest: true, results: results }, "*"); } catch (e) {}',
    '  });',
    '</script></body></html>',
  ].join('\n');
}

/** 供测试使用：在给定 origin 上检查预览是否按策略返回。 */
export { VIEWPORTS };
