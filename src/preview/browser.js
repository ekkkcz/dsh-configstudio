/**
 * 浏览器承载 —— 初始截图与预启动检查。
 *
 * 对应 F14 / F16：
 *  - F14：预览不能无限重启；死循环或持续占用 CPU 的作品必须能被独立终止，
 *    不能只靠同线程 JavaScript 超时回调。这里用独立浏览器进程 + 上下文，
 *    超时后强制关闭，不影响生成与记录。
 *  - F16：截图必须标注视口、DPR、等待时间与网络策略，并且是从初始状态重新加载
 *    得到的画面，不冒充用户交互后的当前状态。
 *
 * playwright 是可选依赖：不同机器上它可能装在 DSH checkout、全局或本插件里。
 * 找不到时 screenshot 返回明确的 unavailable 状态，而不是抛一个看不懂的错误。
 *
 * @module configstudio/preview/browser
 */
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** 找 playwright 的候选位置：先就近，再环境变量指定的 checkout，最后全局。 */
function candidateRequirePaths() {
  const list = [];
  if (process.env.HTML_ARENA_PLAYWRIGHT_ANCHOR) list.push(join(process.env.HTML_ARENA_PLAYWRIGHT_ANCHOR, 'package.json'));
  if (process.env.HTML_ARENA_DSH_CHECKOUT) list.push(join(process.env.HTML_ARENA_DSH_CHECKOUT, 'package.json'));
  if (process.env.DSH_CHECKOUT) list.push(join(process.env.DSH_CHECKOUT, 'package.json'));
  // 常见的本机 checkout 位置（仅尝试，不存在就跳过）
  list.push('D:/agent/deepseek-harness/package.json');
  // 全局 npm 安装（@playwright/cli 自带一份 playwright）
  const appData = process.env.APPDATA;
  if (appData) {
    list.push(join(appData, 'npm', 'node_modules', '@playwright', 'cli', 'package.json'));
    list.push(join(appData, 'npm', 'node_modules', 'playwright', 'package.json'));
    list.push(join(appData, 'npm', 'package.json'));
  }
  // 与插件同级安装的场景
  list.push(join(process.cwd(), 'package.json'));
  return list.filter((x) => { try { return existsSync(x); } catch { return false; } });
}

/** 取字符串第一行。 */
function firstLine(s) {
  const i = s.indexOf(String.fromCharCode(10));
  return i < 0 ? s : s.slice(0, i);
}

let cached = null;

/**
 * 载入 playwright 候选列表。
 *
 * 一台机器上常常装有多份 playwright（checkout 内、全局 @playwright/cli 内），
 * 且不同版本要求不同的浏览器修订号。因此这里返回**所有**可解析的候选，
 * 由调用方逐个尝试启动；只要有一份能起来就可用。
 *
 * @returns {Promise<{ok: boolean, candidates: {chromium: object, resolvedFrom: string}[], reason?: string, tried: object[]}>}
 */
export async function loadPlaywright() {
  if (cached) return cached;
  const tried = [];
  const candidates = [];
  for (const anchor of candidateRequirePaths()) {
    try {
      const require = createRequire(pathToFileURL(anchor).href);
      const resolved = require.resolve('playwright');
      if (candidates.some((c) => c.resolvedFrom === resolved)) continue;
      const mod = await import(pathToFileURL(resolved).href);
      const chromium = mod.chromium ?? mod.default?.chromium;
      if (chromium) candidates.push({ chromium, resolvedFrom: resolved });
      else tried.push({ anchor, note: 'playwright 已解析但没有 chromium 导出' });
    } catch (err) {
      tried.push({ anchor, note: err && err.code ? err.code : String(err && err.message || err) });
    }
  }
  if (candidates.length === 0) {
    cached = {
      ok: false, candidates: [], tried,
      reason: '本机没有可用的 playwright。截图与预启动检查会被标记为"未检查"，生成与预览不受影响。'
        + '安装方式：npm i -g playwright && npx playwright install chromium，'
        + '或用 HTML_ARENA_PLAYWRIGHT_ANCHOR 指向含 playwright 的目录。',
    };
    return cached;
  }
  cached = { ok: true, candidates, tried };
  return cached;
}

/**
 * 启动一个可用的浏览器。逐个尝试候选，并把失败原因都记下来，
 * 这样"没有浏览器二进制"和"没有 playwright"是两种可区分的诊断。
 * @returns {Promise<{ok: true, browser: object, resolvedFrom: string} | {ok: false, reason: string, attempts: object[]}>}
 */
export async function launchBrowser() {
  const pw = await loadPlaywright();
  if (!pw.ok) return { ok: false, reason: pw.reason, attempts: pw.tried };
  const attempts = [];
  for (const candidate of pw.candidates) {
    try {
      const browser = await candidate.chromium.launch({
        headless: true,
        args: ['--no-first-run', '--disable-dev-shm-usage'],
      });
      return { ok: true, browser, resolvedFrom: candidate.resolvedFrom };
    } catch (err) {
      attempts.push({
        resolvedFrom: candidate.resolvedFrom,
        // 只保留第一行，避免把整段堆栈塞进诊断
        error: firstLine(String(err && err.message || err)).slice(0, 300),
      });
    }
  }
  return {
    ok: false,
    reason: '找到了 playwright，但没有一个版本能启动浏览器。'
      + '通常是有版本要求不匹配的浏览器修订号：对能用的那份执行 npx playwright install chromium。',
    attempts,
  };
}

/** 让测试可以重置缓存。 */
export function resetPlaywrightCache() { cached = null; }

/**
 * 用独立浏览器上下文打开一个 URL，等待到指定条件，返回诊断数据。
 * 每次都新建 context 并必定关闭，避免作品之间共享 localStorage 等状态（F13）。
 *
 * @param {object} params
 * @param {string} params.url
 * @param {{width:number,height:number}} params.viewport
 * @param {number} [params.timeoutMs] 总上限，默认 10000（PRD 7：初始截图单候选默认上限 10 秒）
 * @param {number} [params.dpr]
 * @param {boolean} [params.screenshot]
 * @param {'load'|'domcontentloaded'|'networkidle'} [params.waitUntil]
 * @returns {Promise<object>}
 */
export async function capturePreview({ url, viewport, timeoutMs = 10000, dpr = 1, screenshot = true, waitUntil = 'load' }) {
  const started = Date.now();
  const base = {
    url, viewport: { ...viewport }, dpr, waitUntil,
    startedAt: started, timeoutMs,
  };
  const launched = await launchBrowser();
  if (!launched.ok) {
    return {
      ...base, status: 'unavailable', reason: launched.reason,
      tried: launched.attempts ?? launched.tried, durationMs: Date.now() - started,
    };
  }

  let browser = launched.browser;
  let context = null;
  const consoleMessages = [];
  const pageErrors = [];
  const failedRequests = [];
  const crashed = [];
  try {
    // 独立浏览器实例：作品互相之间、以及与宿主之间不共享任何进程内状态。
    context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      deviceScaleFactor: dpr,
      // 不给任何权限；摄像头/麦克风等在预览策略里已被 Permissions-Policy 关闭
      permissions: [],
    });
    const page = await context.newPage();
    page.on('console', (msg) => {
      if (consoleMessages.length < 200) consoleMessages.push({ type: msg.type(), text: msg.text().slice(0, 2000) });
    });
    page.on('pageerror', (err) => {
      if (pageErrors.length < 100) pageErrors.push({ message: String(err && err.message || err).slice(0, 2000) });
    });
    page.on('requestfailed', (req) => {
      if (failedRequests.length < 100) failedRequests.push({ url: req.url().slice(0, 500), failure: req.failure()?.errorText || 'unknown' });
    });
    page.on('crash', () => crashed.push({ at: Date.now() }));

    let navigationError = null;
    try {
      await page.goto(url, { waitUntil, timeout: Math.max(1000, Math.floor(timeoutMs * 0.8)) });
    } catch (err) {
      navigationError = String(err && err.message || err).slice(0, 1000);
    }

    // 给渲染一点点稳定时间，但绝不超过剩余预算（动画无法保证固定帧，F16）
    const remaining = Math.max(0, timeoutMs - (Date.now() - started));
    if (!navigationError && remaining > 0) {
      await page.waitForTimeout(Math.min(300, remaining));
    }

    let shot = null;
    if (screenshot) {
      try {
        shot = await page.screenshot({ timeout: Math.max(1000, timeoutMs), type: 'png' });
      } catch (err) {
        return {
          ...base, status: 'screenshot_failed',
          error: String(err && err.message || err).slice(0, 1000),
          navigationError, consoleMessages, pageErrors, failedRequests, crashed,
          durationMs: Date.now() - started,
        };
      }
    }

    const finalUrl = page.url();
    const title = navigationError ? null : await page.title().catch(() => null);

    return {
      ...base,
      status: navigationError ? 'navigation_failed' : 'ok',
      navigationError,
      finalUrl,
      title,
      screenshotPng: shot,
      consoleMessages,
      pageErrors,
      failedRequests,
      crashed,
      durationMs: Date.now() - started,
      // 明确标注这是初始加载后的画面，不是用户交互后的状态（F16）
      stateNote: '初始状态：本图是对 ' + url + ' 重新加载后、未做任何交互时捕获的画面',
    };
  } catch (err) {
    return {
      ...base, status: 'error',
      error: String(err && err.message || err).slice(0, 1000),
      consoleMessages, pageErrors, failedRequests, crashed,
      durationMs: Date.now() - started,
    };
  } finally {
    // 无论成功失败都强制回收；死循环作品由这里的 close 负责终止（F14）
    try { if (context) await context.close(); } catch { /* 已关闭 */ }
    try { if (browser) await browser.close(); } catch { /* 已关闭 */ }
  }
}

/**
 * 在独立子进程里跑 capturePreview，超时可硬杀。
 * 用于"必须保证能终止"的场景（F14 的独立可终止预览承载方式）。
 * @param {object} params 同 capturePreview
 * @param {number} [params.hardTimeoutMs] 子进程硬上限，默认 timeoutMs + 5000
 * @returns {Promise<object>}
 */
export async function capturePreviewInSubprocess(params) {
  const { spawn } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const workerPath = fileURLToPath(new URL('./capture-worker.mjs', import.meta.url));
  const hardTimeoutMs = params.hardTimeoutMs ?? (params.timeoutMs ?? 10000) + 5000;

  return new Promise((resolve) => {
    const child = spawn(process.execPath, [workerPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let out = '';
    let err = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch { /* 已经退出 */ }
      resolve({ status: 'timeout', reason: '子进程超过硬上限 ' + hardTimeoutMs + 'ms 被强制终止', hardTimeoutMs });
    }, hardTimeoutMs);

    child.stdout.on('data', (d) => { out += d.toString('utf8'); });
    child.stderr.on('data', (d) => { err += d.toString('utf8'); });
    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ status: 'error', reason: '无法启动采集子进程：' + String(e && e.message || e) });
    });
    child.on('close', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const marker = '__HTML_ARENA_RESULT__';
      const idx = out.indexOf(marker);
      if (idx < 0) {
        resolve({ status: 'error', reason: '采集子进程没有返回结果', stderr: err.slice(0, 2000), stdout: out.slice(0, 2000) });
        return;
      }
      try {
        resolve(JSON.parse(out.slice(idx + marker.length).trim()));
      } catch (e) {
        resolve({ status: 'error', reason: '采集结果不是合法 JSON：' + String(e && e.message || e) });
      }
    });

    // 只传二进制截图以外的一切；截图用 base64 回传
    child.stdin.write(JSON.stringify(params));
    child.stdin.end();
  });
}
