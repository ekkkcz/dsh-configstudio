/**
 * M4 交付截图 —— 本轮的**新增能力**与**修好的缺陷**，全部零费用。
 *
 * ★ 一条硬规矩（这是实测踩出来的）：**只拍插件自己的界面，绝不拍 DSH 本体。**
 *   第一版拍了一张"从 DSH 侧栏点进插件"的图，侧栏里带着用户自己的工作区名与会话标题
 *   —— 那是他的个人使用痕迹，不该进交付物与 GitHub。现在"干净安装"这件事改由
 *   **插件界面里能自证的东西**来表达（版本号 + 预览源 + 实验列表），
 *   而不是靠拍 DSH 的外壳。拍 DSH 外壳这件事本身就不该做。
 *
 * 每张图拍之前都**先自证合格**，不合格就抛错拒绝出图（沿用 M2 / M3 的做法）：
 *  - 干净安装：插件必须自报 **0.6.0**（说明装的是这一版交付包）；
 *  - 失败候选的用量：界面上必须写"未上报"而**不是 0**（这是本轮的修复本身）；
 *  - 每一张都必须是**插件自己的页面**（URL 含 /configstudio/api/ui），否则直接抛错。
 *
 * 用法：node scripts/m4-delivery-shots.mjs --out "../交付区/v0.6.0/截图"
 *       [--clean-base http://127.0.0.1:8909]  # 装了交付 tgz 的干净实例
 *       [--real-base  http://127.0.0.1:8902]  # 有真实模型数据的测试实例
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from '../src/preview/browser.js';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const getArg = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const OUT = join(here, '..', getArg('--out', 'docs/evidence'));
const CLEAN_BASE = getArg('--clean-base', 'http://127.0.0.1:8909');
const REAL_BASE = getArg('--real-base', 'http://127.0.0.1:8902');
const EXPECT_VERSION = getArg('--expect-version', '0.6.0');
mkdirSync(OUT, { recursive: true });

const saved = [];
const b = await launchBrowser();
if (!b.ok) { console.log('无法启动浏览器：' + b.reason); process.exit(1); }
const browser = b.browser;

/** 拍之前的三道闸：必须是插件页面 + 调用方给的前置条件 + 不许有页面异常。 */
function makeShooter(page, errs) {
  return async (name, assertFn) => {
    const url = page.url();
    if (!url.includes('/configstudio/api/ui')) {
      throw new Error('拒绝出图 ' + name + '：当前不是插件自己的页面（' + url + '）—— 交付截图不拍 DSH 外壳');
    }
    const verdict = await assertFn();
    if (verdict && verdict.ok === false) throw new Error('拒绝出图 ' + name + '：' + (verdict.reason || '前置条件不满足'));
    if (errs.length > 0) throw new Error('拒绝出图 ' + name + '：页面有异常 ' + JSON.stringify(errs.slice(0, 2)));
    writeFileSync(join(OUT, name + '.png'), await page.screenshot({ type: 'png' }));
    console.log('  ✓ ' + name + (verdict && verdict.note ? '  —— ' + verdict.note : ''));
    saved.push(name);
  };
}

try {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 200)); });
  page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 200)));
  const shot = makeShooter(page, errs);

  // ── 1) 干净安装：装的是交付 tgz 的那个实例，插件自报 0.6.0
  await page.goto(CLEAN_BASE + '/configstudio/api/ui', { waitUntil: 'load', timeout: 45000 });
  await page.waitForSelector('#mode-badge', { timeout: 25000 });
  await page.waitForTimeout(2500);

  await shot('01-干净安装-插件自报0.6.0与实验列表', async () => {
    const note = String(await page.textContent('#env-note'));
    if (EXPECT_VERSION && !note.includes('ConfigStudio ' + EXPECT_VERSION)) {
      return { ok: false, reason: '环境行里没有 0.6.0：' + note };
    }
    const list = await page.evaluate(() => (document.getElementById('experiment-list').innerText || '').trim().length);
    if (list < 10) return { ok: false, reason: '实验列表是空的，图上看不出东西' };
    return { ok: true, note: note.slice(0, 76) };
  });

  // ── 2) 干净安装上的完整用户路径产物：一条真的跑完的实验 + 对比页
  await page.evaluate(() => { document.querySelector('.tab[data-view="experiments"]').click(); });
  await page.waitForTimeout(1200);
  const openedClean = await page.evaluate(() => {
    const row = [...document.querySelectorAll('#experiment-list .exp')].find((r) => r.innerText.includes('M4 干净安装完整路径'));
    if (!row) return false;
    const btn = [...row.querySelectorAll('button')].find((x) => x.textContent.trim() === '打开');
    if (!btn) return false;
    btn.click();
    return true;
  });
  if (!openedClean) throw new Error('干净实例上找不到「M4 干净安装完整路径」这条实验（先跑 m4-clean-generate-check）');
  await page.waitForTimeout(4000);
  await page.evaluate(() => { const t = document.querySelector('.tab[data-view="compare"]:not([disabled])'); if (t) t.click(); });
  await page.waitForTimeout(5000);

  await shot('02-干净安装-生成到对比全流程的产物', async () => {
    const frames = await page.evaluate(() => document.querySelectorAll('#compare-grid iframe').length);
    const text = await page.evaluate(() => (document.getElementById('compare-grid').innerText || '').replace(/\s+/g, ' '));
    if (frames < 2) return { ok: false, reason: '对比页只有 ' + frames + ' 个预览 iframe' };
    if (!/输入 .* tok/.test(text)) return { ok: false, reason: '作品卡上没有用量数据' };
    return { ok: true, note: frames + ' 个作品预览 + 用量与速度' };
  });
  await browser.close();

  // ── 3) 本轮修复的视觉证据：失败候选写"未上报"而不是 0
  const b2 = await launchBrowser();
  const ctx2 = await b2.browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const p2 = await ctx2.newPage();
  const errs2 = [];
  p2.on('console', (m) => { if (m.type() === 'error') errs2.push(m.text().slice(0, 200)); });
  p2.on('pageerror', (e) => errs2.push(String(e.message).slice(0, 200)));
  const shot2 = makeShooter(p2, errs2);

  await p2.goto(REAL_BASE + '/configstudio/api/ui', { waitUntil: 'load', timeout: 45000 });
  await p2.waitForSelector('#mode-badge', { timeout: 25000 });
  await p2.waitForTimeout(2000);
  await p2.evaluate(() => { document.querySelector('.tab[data-view="experiments"]').click(); });
  await p2.waitForTimeout(1800);
  const openedReal = await p2.evaluate(() => {
    // 那条里有 QUOTA 失败的候选（真实模型、真实失败）
    const row = [...document.querySelectorAll('#experiment-list .exp')].find((r) => r.innerText.includes('M2 四候选对比'));
    if (!row) return false;
    const btn = [...row.querySelectorAll('button')].find((x) => x.textContent.trim() === '打开');
    if (!btn) return false;
    btn.click();
    return true;
  });
  if (!openedReal) throw new Error('找不到「M2 四候选对比」这条实验（需要里面有 QUOTA 失败的候选）');
  await p2.waitForTimeout(4000);
  await p2.evaluate(() => { const t = document.querySelector('.tab[data-view="compare"]:not([disabled])'); if (t) t.click(); });
  await p2.waitForTimeout(5000);

  await shot2('03-失败候选显示未上报而不是0tok', async () => {
    const text = await p2.evaluate(() => (document.getElementById('compare-grid').innerText || '').replace(/\s+/g, ' '));
    const i = text.indexOf('额度或余额不足');
    if (i < 0) return { ok: false, reason: '这条实验里没有额度不足的失败候选' };
    const seg = text.slice(Math.max(0, i - 60), i + 330);
    if (/输入 0 tok|输出 0 tok|总速度 0\.0 tok\/s/.test(seg)) {
      return { ok: false, reason: '图上仍然显示 0 tok —— 修复没生效：' + seg.slice(0, 140) };
    }
    if (!/输入 未上报 tok/.test(seg)) {
      return { ok: false, reason: '失败候选的用量没显示成"未上报"：' + seg.slice(0, 140) };
    }
    return { ok: true, note: seg.slice(seg.indexOf('输入'), seg.indexOf('输入') + 44) };
  });
  await browser.close();
  await b2.browser.close().catch(() => {});
} catch (err) {
  console.log('✗ 出图中断：' + String(err && err.message || err));
  process.exitCode = 1;
} finally {
  try { await browser.close(); } catch { /* 已关 */ }
}
console.log('');
console.log('已出图 ' + saved.length + ' 张 → ' + OUT);
