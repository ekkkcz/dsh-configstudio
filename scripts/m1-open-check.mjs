/**
 * 只读探针：确认 DSH 实例在真实浏览器里能打开、并且「配置对比」入口在位。不发模型调用。
 *
 * 用法：node scripts/m1-open-check.mjs [带 token 的完整地址]
 *
 * ★ 地址里的 token **绝不写进代码**：那是一个**访问凭据**，写死等于把它提交进仓库
 *   （本仓库要公开）。这里改为从已 gitignore 的 `docs/evidence/.dsh-token-<端口>.txt` 读；
 *   也可以直接用第一个参数显式传一个地址。
 *
 *   2026-09-21 修：这一行以前硬编码过一个真实 token（历史提交 354f387 里仍有），
 *   公开仓库前必须处理掉 —— 见 `交付区/下一对话指令.md`。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from '../src/preview/browser.js';

const here = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.DSH_PORT || '8902';

/** 从本地令牌文件读（该文件在 .gitignore 里，不会进仓库）。 */
function tokenFromFile(port) {
  const p = join(here, '..', 'docs', 'evidence', '.dsh-token-' + port + '.txt');
  if (!existsSync(p)) return null;
  try { return readFileSync(p, 'utf8').trim() || null; } catch { return null; }
}

const explicit = process.argv[2];
const token = tokenFromFile(PORT);
const base = explicit || ('http://127.0.0.1:' + PORT + '/' + (token ? '?token=' + token : ''));
if (!explicit && !token) {
  console.log('提示：没有找到 docs/evidence/.dsh-token-' + PORT + '.txt，也没给地址参数；'
    + '将直接打开 http://127.0.0.1:' + PORT + '/（没有 token 很可能打不开）。');
}
const b = await launchBrowser();
if (!b.ok) { console.log('无法启动浏览器：' + b.reason); process.exitCode = 1; }
else {
  const browser = b.browser;
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(String(e.message).slice(0, 150)));
  const r = await p.goto(base, { waitUntil: 'load', timeout: 30000 });
  await p.waitForTimeout(3000);
  const entryCount = await p.locator('text=配置对比').count();
  const body = (await p.textContent('body') || '').replace(/\s+/g, ' ').slice(0, 260);
  const cookies = (await ctx.cookies()).map((c) => c.name);
  console.log(JSON.stringify({
    status: r && r.status(), title: await p.title(), url: p.url().replace(/token=[^&]+/, 'token=***'),
    arenaEntry: entryCount, cookies, pageErrors: errs, bodyText: body,
  }, null, 1));

  // 点进插件入口，确认 iframe 真的起来了
  if (entryCount > 0) {
    await p.click('text=配置对比');
    await p.waitForTimeout(4000);
    const iframeSrc = await p.evaluate(() => {
      const f = document.querySelector('iframe[src*="configstudio"]');
      return f ? f.getAttribute('src') : null;
    });
    const frames = p.frames().filter((f) => f !== p.mainFrame()).map((f) => f.url().replace(/token=[^&]+/, 'token=***'));
    console.log('点开入口后：iframe=' + iframeSrc + '  frames=' + JSON.stringify(frames));
  }
  await browser.close();
}
