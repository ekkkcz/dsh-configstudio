/**
 * M4-1 干净安装验收 —— 在**全新 profile** 上装交付区的 tgz，按**真实用户路径**完整走一遍。
 *
 * 与 delivery-smoke 的分工：那个只验证"装起来能用"（接口 + 页面存在性）；
 * 这个验证"用户真的能做完一件事"：从 DSH 侧栏入口点进插件 → 新建对比 →
 * 添第二个候选 → 填写题目 → 保存配方 → 看历史 → 打开设置。
 *
 * ★ 本脚本**不发起任何模型调用**（零费用）：只走到"开始生成"之前的表单部分，
 *   以及不花钱的浏览路径（历史 / 配方 / 设置 / 导入检视失败路径）。
 *   生成路径由 m4-clean-generate-check 用模拟 provider 覆盖。
 *
 * 用法：node scripts/m4-clean-install-check.mjs --base http://127.0.0.1:8909 --token <token> --expect-version 0.5.0
 */
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from '../src/preview/browser.js';
import { EVIDENCE_DIR, makeChecker } from './lib/devhost.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const getArg = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };

const BASE = getArg('--base', 'http://127.0.0.1:8909');
/**
 * 打开 DSH 本体需要一个启动时打印的 token（插件自己的 /html-arena/api/* 不受它管，
 * 但侧栏入口在 DSH 的页面里）。token 每次启动都不一样，所以有三种给法：
 *   1. --token <值>                     直接给
 *   2. --token-file <路径>              从文件读
 *   3. 什么都不给                        按端口找默认文件 docs/evidence/.dsh-token-<端口>.txt
 * 找不到就不带 token 打开 —— 那样会拿到 401，脚本会**如实报失败**而不是假装通过。
 */
function readToken() {
  const direct = getArg('--token', '');
  if (direct) return { token: direct, from: '--token' };
  const explicit = getArg('--token-file', null);
  const port = (() => { try { return new URL(BASE).port || '80'; } catch { return '80'; } })();
  const candidates = [explicit, join(here, '..', 'docs', 'evidence', '.dsh-token-' + port + '.txt')].filter(Boolean);
  for (const p of candidates) {
    try { const t = readFileSync(p, 'utf8').trim(); if (t) return { token: t, from: p }; } catch { /* 试下一个 */ }
  }
  return { token: '', from: null };
}
const TOKEN_SRC = readToken();
const TOKEN = TOKEN_SRC.token;
// 下面对 401 的判定要用到它：DSH 本体是带 token 打开的，插件自己的 API 不带。
const DSHELL_AUTH = TOKEN ? '?token=' + TOKEN : '';
const EXPECT = getArg('--expect-version', null);
const SHOT_DIR = join(here, '..', getArg('--out', 'docs/evidence'));
mkdirSync(SHOT_DIR, { recursive: true });

const { add, report, finish } = makeChecker({
  what: 'M4-1 干净安装：全新 profile 装交付 tgz，按真实用户路径走查',
  note: '零模型费用：只走表单与浏览路径，不点「开始生成」',
  extra: { base: BASE, expectVersion: EXPECT },
});

/**
 * ★ 出图铁律：**绝不截 DSH 本体**。
 *
 * 这个脚本必须先打开 DSH 外壳才能验证"侧栏入口在不在"（那是真实用户的第一步），
 * 但 DSH 的侧栏会显示**用户自己的工作区名与会话标题** —— 那是个人使用痕迹。
 * 第一版就是直接 `page.screenshot()` 拍了几张，四张图里全带着用户的目录名，
 * 还进了提交与上传包（发布前自检抓出来的）。
 *
 * 所以这里只拍**插件自己的 iframe 区域**（`frame.locator('body')`），
 * 并且用一个显式开关把"拍外壳"变成一件做不到的事。
 */
const PLUGIN_PAGE_ONLY = true;

/**
 * 只拍**插件自己的 iframe 区域**。传进来的必须是插件 frame，不是 page。
 *
 * 用 `frame.locator('body').screenshot()` 而不是 `page.screenshot()`：
 * 后者的画面里有 DSH 的侧栏。前者只包含 iframe 内部的像素。
 * 另外再做一次**运行时校验**：如果传进来的是个 page（而不是插件 frame），直接抛错 ——
 * 让"拍外壳"这件事在代码层面做不到，而不是靠记得。
 */
async function shotPlugin(frame, name) {
  const url = frame.url ? frame.url() : '';
  if (!url.includes('/html-arena/api/ui')) {
    throw new Error('拒绝出图 ' + name + '：目标不是插件页面（' + url + '）—— 交付证据不拍 DSH 外壳');
  }
  if (PLUGIN_PAGE_ONLY !== true) throw new Error('PLUGIN_PAGE_ONLY 被关掉了，拒绝出图');
  await frame.locator('body').screenshot({ path: join(SHOT_DIR, name + '.png') });
}

const url = BASE + '/' + (TOKEN ? '?token=' + TOKEN : '');
if (!TOKEN) {
  add('前置', '拿到了打开 DSH 本体所需的 token（没有就只能看到 401，走不到侧栏入口）', false,
    { lookedAt: TOKEN_SRC.from, hint: '启动实例时把打印出来的 token 写进 docs/evidence/.dsh-token-<端口>.txt，或用 --token 传入' });
} else {
  add('前置', '拿到了打开 DSH 本体所需的 token', true, { from: String(TOKEN_SRC.from).slice(-60) });
}
const b = await launchBrowser();
if (!b.ok) {
  add('浏览器', '可启动浏览器', false, { reason: b.reason });
  process.exitCode = finish('m4-clean-install');
} else {
  const browser = b.browser;
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300)); });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e.message).slice(0, 300)));

  try {
    // ── 第 1 步：打开 DSH 本体，找到侧栏入口（真实用户的第一眼）
    await page.goto(url, { waitUntil: 'load', timeout: 45000 });
    await page.waitForTimeout(6000);
    const entry = page.locator('text=HTML 对比').first();
    add('用户路径 1', 'DSH 侧栏出现「HTML 对比」入口', await entry.count() > 0);
    const shell401 = consoleErrors.filter((t) => /401/.test(t));
    add('用户路径 1', '打开 DSH 本体时没有非 401 的控制台错误、没有页面异常',
      consoleErrors.filter((t) => !shell401.includes(t)).length === 0 && pageErrors.length === 0,
      { consoleErrors, pageErrors, unauthorized: shell401.slice(0, 3) });
    // 第 1 步**不出图** —— 这一步的页面就是 DSH 外壳，出了图就会带上用户自己的工作区名。
    // 这里只留一条断言（入口在不在），出图从第 2 步（插件自己的页面）才开始。

    // ── 第 2 步：点入口，插件整页 iframe 起来
    await entry.click();
    await page.waitForTimeout(5000);
    const iframeSrc = await page.evaluate(() => {
      const f = document.querySelector('iframe[src*="html-arena"]');
      return f ? f.getAttribute('src') : null;
    });
    add('用户路径 2', '点入口后出现指向插件的 iframe', iframeSrc === '/html-arena/api/ui', { iframeSrc });

    const frame = page.frames().find((f) => f.url().includes('/html-arena/api/ui'));
    add('用户路径 2', 'iframe 内部真的加载了插件界面', Boolean(frame));
    if (!frame) throw new Error('插件 iframe 没有加载出来，后面的用户路径无法继续');

    await frame.waitForSelector('#mode-badge', { timeout: 25000 });
    await frame.waitForTimeout(2000);
    const envNote = await frame.textContent('#env-note');
    add('用户路径 2', '环境行显示的是**插件自己的**版本号（不是 DSH 的）',
      EXPECT ? String(envNote).includes('HTML Arena ' + EXPECT) : /HTML Arena \d/.test(String(envNote)),
      String(envNote).slice(0, 100));
    add('用户路径 2', '没有致命错误横幅', !(await frame.isVisible('#fatal')));
    await shotPlugin(frame, 'm4-clean-01-plugin-entry');

    // ── 第 3 步：落地页上用户看到的第一屏 —— 三个主要动作必须都在
    const landing = await frame.evaluate(() => ({
      newBtn: Boolean(document.getElementById('btn-new')),
      sampleBtn: Boolean(document.getElementById('btn-sample')),
      importBtn: Boolean(document.getElementById('btn-import')),
      listRendered: (document.getElementById('experiment-list').innerText || '').trim().length > 0,
    }));
    add('用户路径 3', '落地页三个主要动作都在（新建对比 / 试一个示例 / 导入复测包）',
      landing.newBtn && landing.sampleBtn && landing.importBtn, landing);
    add('用户路径 3', '实验列表在干净安装上也有渲染（不是空白）', landing.listRendered);

    // ── 第 4 步：先点「试一个示例」——真实用户最可能的第一步（它自己会切到新建页）
    await frame.click('#btn-sample');
    await frame.waitForSelector('#view-new:not([hidden])', { timeout: 20000 });
    await frame.waitForTimeout(1200);
    const afterSample = await frame.evaluate(() => ({
      prompt: (document.getElementById('task-prompt').value || '').length,
      title: (document.getElementById('task-title').value || '').length,
      requirements: (document.getElementById('task-requirements').value || '').length,
    }));
    add('用户路径 4', '「试一个示例」真的把题目/标题/输出要求填进去了，并切到新建页',
      afterSample.prompt > 20 && afterSample.title > 0 && afterSample.requirements > 0, afterSample);

    // 字符计数与上限提示
    const countText = await frame.textContent('#prompt-count');
    add('用户路径 4', '字符计数器显示 n / 上限（用户能看到边界）', /\d+\s*\/\s*\d+/.test(String(countText)), String(countText).slice(0, 60));

    const candCount0 = await frame.evaluate(() => document.querySelectorAll('#candidates .cand').length);
    add('用户路径 4', '新建页默认已有候选卡（不是空列表让人懵）', candCount0 >= 1, { candCount0 });

    // 模型下拉真的从宿主拿到了模型目录（这是"干净安装"最容易断的地方）
    const modelOpts = await frame.evaluate(() => {
      const sel = document.querySelector('#candidates select[data-role="model"]');
      return sel ? { count: sel.options.length, first: sel.options[0] && sel.options[0].textContent, disabled: sel.disabled } : null;
    });
    add('用户路径 4', '候选卡的模型下拉从宿主拿到了模型目录（干净 profile 的核心断言）',
      Boolean(modelOpts && modelOpts.count > 1), modelOpts);
    add('用户路径 4', '模型下拉没有被禁用（宿主 llm 服务确实可用）',
      Boolean(modelOpts && modelOpts.disabled === false), modelOpts && { disabled: modelOpts.disabled });

    // 供应商下拉
    const provOpts = await frame.evaluate(() => {
      const sel = document.querySelector('#candidates select[data-role="provider"]');
      return sel ? { count: sel.options.length, first: sel.options[0] && sel.options[0].textContent } : null;
    });
    add('用户路径 4', '供应商下拉非空', Boolean(provOpts && provOpts.count >= 2), provOpts);

    // ── 第 5 步：加第二个候选 + 保存配方（A03 的用户入口）
    await frame.click('#btn-add-candidate');
    await frame.waitForTimeout(800);
    const candCount1 = await frame.evaluate(() => document.querySelectorAll('#candidates .cand').length);
    add('用户路径 5', '「添加候选」真的多出一张卡', candCount1 === candCount0 + 1, { before: candCount0, after: candCount1 });

    const cardBtns = await frame.evaluate(() => Array.from(document.querySelectorAll('#candidates .cand .cand-head button')).map((b) => b.textContent.trim()));
    add('用户路径 5', '候选卡上有「保存为配方 / 复制 / 删除」三个入口',
      cardBtns.length >= 3 && cardBtns.some((t) => t.indexOf('配方') >= 0), { cardBtns });
    await shotPlugin(frame, 'm4-clean-02-new-compare');

    // ── 第 6 步：请求预览（不花钱，纯本地编译预览）
    await frame.click('#btn-preview-request');
    await frame.waitForTimeout(2500);
    const previewVisible = await frame.isVisible('#request-preview');
    const previewText = previewVisible ? String(await frame.textContent('#request-preview')).slice(0, 400) : '';
    add('用户路径 6', '「预览请求」在干净安装上可用（本地编译，不调模型）',
      previewVisible && previewText.length > 40, { len: previewText.length, head: previewText.slice(0, 160) });

    // ── 第 7 步：走一遍不花钱的浏览路径（历史 / 配方 / 设置）
    const views = [
      { tab: 'experiments', view: 'view-experiments', label: '历史' },
      { tab: 'recipes', view: 'view-recipes', label: '配方' },
      { tab: 'settings', view: 'view-settings', label: '设置' },
    ];
    for (const v of views) {
      await frame.click('.tab[data-view="' + v.tab + '"]');
      await frame.waitForSelector('#' + v.view + ':not([hidden])', { timeout: 20000 });
      await frame.waitForTimeout(900);
      add('用户路径 7', '「' + v.label + '」页能打开且不空',
        (await frame.evaluate((id) => (document.getElementById(id).innerText || '').trim().length, v.view)) > 10);
    }

    // 设置页里"外部能力"必须能看出**探测到 vs 已启用**两件事（干净安装上优化器未装）
    const settingsText = await frame.textContent('#settings-caps');
    add('用户路径 7', '设置页写明外部能力的探测结果与开关状态（干净安装上优化器未装）',
      /未检测到|已启用|未启用/.test(String(settingsText)), String(settingsText).replace(/\s+/g, ' ').slice(0, 160));
    await shotPlugin(frame, 'm4-clean-03-settings');

    // ── 第 8 步：导入路径的"失败可读"（用户拿错文件时不能看到 500）
    await frame.click('.tab[data-view="experiments"]');
    await frame.waitForSelector('#view-experiments:not([hidden])', { timeout: 20000 });
    await frame.waitForTimeout(700);
    const badResp = await frame.evaluate(async () => {
      const r = await fetch('/html-arena/api/packs/inspect', {
        method: 'POST', headers: { 'Content-Type': 'application/zip' },
        body: new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4, 5]),
      });
      return { status: r.status, body: (await r.text()).slice(0, 200) };
    });
    add('用户路径 8', '喂一个损坏的 ZIP 给导入检视 → 4xx 且原因可读（不是 500）',
      badResp.status >= 400 && badResp.status < 500, badResp);

    // 第 8 步是我们**故意**喂的坏包，浏览器会为那个 400 记一条控制台错误 —— 那是本脚本自己造成的，
    // 不是产品缺陷。把它单独排除，剩下的才算干净安装上的真实噪音。
    const ownNoise = consoleErrors.filter((t) => t.indexOf('400') >= 0 && t.indexOf('Failed to load resource') >= 0);
    const realErrors = consoleErrors.filter((t) => ownNoise.indexOf(t) < 0);
    report.consoleErrors = consoleErrors;
    report.ownNoise = ownNoise;
    report.pageErrors = pageErrors;
    add('用户路径', '除本脚本故意触发的 400 外，控制台 0 错误、页面 0 异常',
      realErrors.length === 0 && pageErrors.length === 0,
      { realErrors: realErrors.slice(0, 5), ownNoise: ownNoise.slice(0, 5), pageErrors: pageErrors.slice(0, 5) });
  } catch (err) {
    report.error = String(err && err.stack || err).slice(0, 1500);
    add('用户路径', '走查未中断', false, report.error.split(String.fromCharCode(10))[0]);
  } finally { await browser.close(); }
}

process.exitCode = finish('m4-clean-install');
