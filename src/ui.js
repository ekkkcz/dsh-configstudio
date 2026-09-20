/**
 * 界面路由 —— 提供 SPA 的 HTML/JS/CSS。
 *
 * 为什么把界面做成独立静态资源而不是 React 组件：
 *  DSH 不替外部包构建前端产物，而平台模块表白名单是冻结的。把整页放在我们自己
 * 路由吐的普通 HTML/JS 里，对 DSH 内部契约的依赖只剩"一个 iframe 入口"。
 *
 * @module configstudio/ui
 */
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = join(here, '..', 'web');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

/**
 * 建立界面路由。
 * @param {object} runtime
 * @returns {Promise<{handle: (req, res) => boolean, assets: string[]}>}
 */
export async function createUiRouter(runtime) {
  // 白名单：只允许这几个文件名（杜绝路径穿越）。新增界面脚本必须同时加到这里，
  // 否则改完界面会发现"脚本 404、按钮没反应"——那也是 dsh-contract-check 检查的一项。
  const NAMES = ['app.js', 'app.css', 'index.html', 'output-policy.js'];

  // 按 mtime 缓存：插件被更新（或开发时正在改界面）后，下一次请求就能拿到新内容，
  // 不需要重启 DSH。这样也避免"改了文件但页面还是旧的"这类假故障。
  const cache = new Map();

  function readAsset(name) {
    if (!NAMES.includes(name)) return null;
    const p = join(WEB_DIR, name);
    if (!existsSync(p)) return null;
    let mtime;
    try { mtime = statSync(p).mtimeMs; } catch { return null; }
    const hit = cache.get(name);
    if (hit && hit.mtime === mtime) return hit.text;
    const text = readFileSync(p, 'utf8');
    cache.set(name, { mtime, text });
    return text;
  }

  /**
   * @returns {boolean} 是否已经处理（true = 已响应，调用方不要再走 API）
   */
  function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    let path = url.pathname;
    if (path.startsWith('/configstudio')) path = path.slice('/configstudio'.length);
    if (path.startsWith('/api')) path = path.slice('/api'.length);
    if (path === '') path = '/';

    // 界面入口
    if (path === '/' || path === '/ui' || path === '/index.html') {
      const body = readAsset('index.html') ?? missingUiPage();
      res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' });
      res.end(body);
      return true;
    }

    // 静态资源（只允许白名单文件名，杜绝路径穿越）
    const name = path.replace(/^\/+/, '');
    if (/^[a-zA-Z0-9_.-]+$/.test(name)) {
      const text = readAsset(name);
      if (text !== null) {
        const ext = name.slice(name.lastIndexOf('.'));
        res.writeHead(200, {
          'Content-Type': MIME[ext] ?? 'application/octet-stream',
          'Cache-Control': 'no-store',
        });
        res.end(text);
        return true;
      }
    }

    return false;
  }

  return { handle, assets: NAMES };
}

function missingUiPage() {
  return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>ConfigStudio</title>'
    + '<style>body{font:14px/1.6 system-ui,sans-serif;background:#0d1117;color:#c9d1d9;padding:32px}'
    + 'code{background:#161b22;padding:2px 6px;border-radius:4px}</style></head><body>'
    + '<h2>界面资源缺失</h2><p>插件包里没有找到 <code>web/index.html</code>。'
    + '这是打包问题，不是你的操作问题。宿主 API 仍然可用。</p></body></html>';
}
