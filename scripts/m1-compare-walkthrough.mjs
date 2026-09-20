/**
 * M1 对比页实测 —— 在**真实 DSH 实例**上驱动真实插件界面，测 A14 / A15 / A16 / A23。
 *
 * 它不发起任何模型调用（不点"重试"、不点"开始"），只打开已存在的真实实验并操作对比页，
 * 所以零模型费用。作品是真实模型产出的。
 *
 * 用法：
 *   node scripts/m1-compare-walkthrough.mjs --base http://127.0.0.1:8901 \
 *     --title "M1 番茄钟对比" --fail-title "M1 真实对比" --out docs/evidence
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from '../src/preview/browser.js';
import { writeEvidence } from './lib/redact.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const getArg = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
// 默认端口从 8901 改成 8902：8901 已被本机无关程序（与本插件无关）占用，
// 不带 --base 跑到别的服务上会得到莫名其妙的失败（2026-09-18 实测）。
const BASE = getArg('--base', 'http://127.0.0.1:8902');
const OUT = join(here, '..', getArg('--out', 'docs/evidence'));
const OK_TITLE = getArg('--title', 'M1 番茄钟对比');
const FAIL_TITLE = getArg('--fail-title', 'M1 真实对比');
const UI = BASE + '/html-arena/api/ui';

const report = { startedAt: new Date().toISOString(), base: BASE, okTitle: OK_TITLE, failTitle: FAIL_TITLE, checks: [], notes: [] };
mkdirSync(OUT, { recursive: true });
const add = (area, name, ok, detail) => {
  report.checks.push({ area, name, ok: Boolean(ok), detail: detail === undefined ? null : detail });
  console.log((ok ? '  ✓ ' : '  ✗ ') + '[' + area + '] ' + name + (detail === undefined ? '' : '  ' + JSON.stringify(detail)));
};

const b = await launchBrowser();
if (!b.ok) { console.log(JSON.stringify({ error: '无法启动浏览器：' + b.reason }, null, 2)); process.exit(1); }
const browser = b.browser;
const context = await browser.newContext({ viewport: { width: 1500, height: 950 } });
const page = await context.newPage();
const consoleErrors = [];
const pageErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300)); });
page.on('pageerror', (e) => pageErrors.push(String(e.message).slice(0, 300)));
const shots = [];
async function shot(name) {
  const file = join(OUT, 'm1-' + name + '.png');
  writeFileSync(file, await page.screenshot({ type: 'png' }));
  shots.push(name);
}

/** 用搜索框把列表收敛到一条实验，再点"打开"。真实用户路径，不碰内部函数。 */
async function openExperimentByTitle(title) {
  await page.click('.tab[data-view="experiments"]');
  await page.waitForTimeout(600);
  await page.fill('#search', title);
  await page.waitForTimeout(900);
  const rows = await page.$$eval('#experiment-list .exp', (els) => els.map((e) => e.innerText.replace(/\s+/g, ' ').trim().slice(0, 120)));
  if (rows.length === 0) return { opened: false, rows };
  await page.click('#experiment-list .exp:first-child button:has-text("打开")');
  await page.waitForSelector('#view-compare:not([hidden])', { timeout: 20000 });
  await page.waitForTimeout(2200);
  // 注意：此时已经在对比页，#search 不可见；下一次调用进入列表页时会重新填写。
  return { opened: true, rows };
}

/** 预览 iframe 的 URL 里带 attempt id，用它认领 frame，避免顺序假设。 */
function frameUrlMap() {
  return page.frames().filter((f) => f !== page.mainFrame()).map((f) => f.url());
}
function frameFor(attemptId) {
  return page.frames().find((f) => f.url().includes('/preview/' + attemptId));
}
async function frameShape() {
  return page.$$eval('.frame-wrap', (els) => els.map((e) => {
    const ifr = e.querySelector('iframe');
    return {
      head: e.querySelector('.frame-head') ? e.querySelector('.frame-head').innerText.replace(/\s+/g, ' ').trim() : '',
      w: ifr ? ifr.style.width : null, h: ifr ? ifr.style.height : null,
      id: ifr ? (ifr.src.match(/\/preview\/([^?]+)/) || [])[1] : null,
      hasError: Boolean(e.querySelector('.frame-error')),
    };
  }));
}

try {
  await page.goto(UI, { waitUntil: 'load', timeout: 30000 });
  await page.waitForSelector('#mode-badge', { timeout: 20000 });
  await page.waitForTimeout(900);
  add('环境', '界面加载且无致命错误', !(await page.isVisible('#fatal')), await page.textContent('#env-note'));

  // ══ 打开两真实模型的对比实验 ══════════════════════════════
  const opened = await openExperimentByTitle(OK_TITLE);
  add('准备', '按标题找到并打开真实实验', opened.opened, opened.rows);
  const title = await page.textContent('#compare-title');
  // 注意：state.current.attempts 是**所有轮次的行**，追加过一轮的实验会有 3–4 行。
  // 对比页渲染的是"每个候选槽位的最新一轮"，所以前置条件必须按槽位取最后一行来算，
  // 否则会拿"轮次行数"去要求"候选数"（2026-09-18 在一条追加过轮次的实验上误报过一次）。
  const attempts = await page.evaluate(() => {
    const last = {};
    window.__htmlArena.state.current.attempts.forEach((a) => {
      if (!last[a.slot] || a.attemptNo > last[a.slot].attemptNo) last[a.slot] = a;
    });
    return Object.keys(last).sort().map((k) => {
      const a = last[k];
      return { id: a.id, slot: a.slot, provider: a.recipe.provider, model: a.recipe.model, canPreview: a.canPreview, status: a.status };
    });
  });
  add('准备', '实验含两个可预览候选', attempts.length === 2 && attempts.every((a) => a.canPreview), attempts);

  const viewports = await page.evaluate(() => window.__htmlArena.state.meta.viewports);
  const shapeDesktop = await frameShape();
  add('A14', '桌面视口下两个 iframe 都在', shapeDesktop.length === 2 && shapeDesktop.every((s) => s.id), shapeDesktop.map((s) => s.id));

  // ── A14：切换视口 ─────────────────────────────────────────
  await page.click('.seg-btn[data-vp="mobile"]');
  await page.waitForTimeout(1500);
  const shapeMobile = await frameShape();
  add('A14', '切到手机视口后两个 iframe 同步改尺寸',
    shapeMobile.every((s) => s.w === viewports.mobile.width + 'px' && s.h === viewports.mobile.height + 'px'),
    { mobile: viewports.mobile, got: shapeMobile.map((s) => s.w + 'x' + s.h) });
  add('A14', '视口标签同步更新', (await page.$$eval('.vp-label', (e) => e.map((x) => x.textContent))).every((t) => t === viewports.mobile.width + 'x' + viewports.mobile.height));
  await shot('a14-mobile');

  // ── A14：独立重置（手机视口下重置 A，B 不受影响） ─────────
  const idA = shapeMobile[0].id, idB = shapeMobile[1].id;
  const fA = frameFor(idA), fB = frameFor(idB);
  await fA.evaluate(() => { window.__m1probe = 'A'; });
  await fB.evaluate(() => { window.__m1probe = 'B'; });
  const before = { a: await fA.evaluate(() => window.__m1probe ?? null), b: await fB.evaluate(() => window.__m1probe ?? null) };
  add('A14', '重置前两个作品各自持有自己的运行态', before.a === 'A' && before.b === 'B', before);

  await page.click('.frame-wrap:nth-child(1) .frame-head button:has-text("重置")');
  await page.waitForTimeout(2200);
  const after = {
    a: await frameFor(idA).evaluate(() => window.__m1probe ?? null).catch(() => '(frame 未就绪)'),
    b: await frameFor(idB).evaluate(() => window.__m1probe ?? null).catch(() => '(frame 未就绪)'),
  };
  add('A14', '重置候选 A 只重置 A（A 的执行态被清空）', after.a === null, after);
  add('A14', '重置候选 A 时候选 B 完全不受影响', after.b === 'B', after);
  const shapeAfterReset = await frameShape();
  add('A14', '重置后视口尺寸保持不变（重置不重置视口）',
    shapeAfterReset.every((s) => s.w === viewports.mobile.width + 'px'), shapeAfterReset.map((s) => s.w + 'x' + s.h));
  await shot('a14-reset-mobile');

  // ── A14：重置 B，A 不受影响；再切回桌面 ───────────────────
  await frameFor(idA).evaluate(() => { window.__m1probe = 'A2'; });
  await page.click('.frame-wrap:nth-child(2) .frame-head button:has-text("重置")');
  await page.waitForTimeout(2200);
  const cross = {
    a: await frameFor(idA).evaluate(() => window.__m1probe ?? null).catch(() => '(frame 未就绪)'),
    b: await frameFor(idB).evaluate(() => window.__m1probe ?? null).catch(() => '(frame 未就绪)'),
  };
  add('A14', '重置候选 B 时候选 A 完全不受影响', cross.a === 'A2' && cross.b === null, cross);

  await page.click('.seg-btn[data-vp="desktop"]');
  await page.waitForTimeout(1500);
  const shapeBack = await frameShape();
  add('A14', '切回桌面视口尺寸恢复', shapeBack.every((s) => s.w === viewports.desktop.width + 'px'), shapeBack.map((s) => s.w + 'x' + s.h));
  await shot('a14-desktop');

  // ── A15：隐藏身份 → 保存评价 → 揭晓 ───────────────────────
  const identityWords = attempts.flatMap((a) => [a.provider, a.model]);
  const alreadyRevealed = await page.evaluate(() => window.__htmlArena.state.revealed === true);
  if (alreadyRevealed) {
    // 揭晓是不可逆的：这个实验已经走完流程。能验证的是"揭晓后一眼看出谁是谁"。
    const heads = await page.$$eval('.frame-head', (els) => els.map((e) => e.innerText.replace(/\s+/g, ' ').trim()));
    add('A15', '（本实验已揭晓）揭晓后作品卡头部直接写出 provider / model',
      attempts.every((a) => heads.some((t) => t.includes(a.provider) && t.includes(a.model))), heads);
    report.notes.push('A15 的盲选主流程在本次运行被跳过：实验已处于揭晓状态（揭晓不可逆）。盲选主流程证据见同目录更早一次运行。');
    console.log('  · [A15] 已揭晓，跳过盲选主流程');
  } else {
  await page.click('#btn-blind');
  await page.waitForTimeout(700);
  const blindText = await page.evaluate(() => {
    const box = document.getElementById('compare-grid').innerText + ' ' + document.getElementById('compare-note').innerText;
    return box.replace(/\s+/g, ' ').trim();
  });
  const leaked = identityWords.filter((w) => blindText.includes(w));
  add('A15', '隐藏身份后对比区不出现 provider / model', leaked.length === 0, { leaked, sample: blindText.slice(0, 160) });
  const headLabels = await page.$$eval('.frame-head', (els) => els.map((e) => e.innerText.replace(/\s+/g, ' ').trim()));
  add('A15', '隐藏身份后两张卡都标注"身份已隐藏"',
    headLabels.length === 2 && headLabels.every((t) => t.includes('（身份已隐藏）')), headLabels);

  // 折叠的"配置差异"面板点开也不能泄露身份（实测缺陷：曾经一直显示 provider / model）
  await page.evaluate(() => {
    const d = document.querySelector('#view-compare details.more');
    if (d) d.open = true;
  });
  await page.waitForTimeout(400);
  const detailsText = (await page.textContent('#compare-details')).replace(/\s+/g, ' ').trim();
  const detailLeak = identityWords.filter((w) => detailsText.includes(w));
  add('A15', '隐藏身份时展开"配置差异"面板也不泄露身份', detailLeak.length === 0,
    { leaked: detailLeak, sample: detailsText.slice(0, 200) });
  await shot('a15-blind-details');
  await page.evaluate(() => {
    const d = document.querySelector('#view-compare details.more');
    if (d) d.open = false;
  });
  await shot('a15-blind');

  const voteButtons = await page.$$eval('#vote-row button', (els) => els.map((e) => e.textContent.trim()));
  add('A15', '评价按钮齐备（A/B/平局/无法判断）', voteButtons.length >= 4, voteButtons);
  await page.click('#vote-row button:nth-child(1)');
  await page.waitForTimeout(1200);
  const voteStatus = (await page.textContent('#vote-status')).replace(/\s+/g, ' ').trim();
  add('A15', '评价已保存', /已保存|已记录/.test(voteStatus), voteStatus);
  const revealVisible = await page.isVisible('#btn-reveal');
  add('A15', '保存评价后出现"揭晓身份"', revealVisible);

  const preReveal = await page.evaluate(() => JSON.stringify(window.__htmlArena.state.current.vote));
  add('A15', '揭晓前接口返回的映射里没有 provider / model',
    !identityWords.some((w) => preReveal.includes(w)), preReveal.slice(0, 220));

  if (revealVisible) {
    await page.click('#btn-reveal');
    await page.waitForTimeout(1200);
    const revealedText = await page.evaluate(() => document.getElementById('compare-grid').innerText.replace(/\s+/g, ' ').trim());
    const shown = identityWords.filter((w) => revealedText.includes(w));
    // 揭晓的意义是"一眼看出 A/B 各是哪套配置"，所以必须落在作品卡头部，而不是藏在折叠面板里。
    const revealedHeads = await page.$$eval('.frame-head', (els) => els.map((e) => e.innerText.replace(/\s+/g, ' ').trim()));
    add('A15', '揭晓后每个作品卡头部直接写出 provider / model',
      shown.length >= 4 && revealedHeads.length === 2
      && attempts.every((a) => revealedHeads.some((t) => t.includes(a.provider) && t.includes(a.model))),
      { shown, revealedHeads });
    await shot('a15-reveal');
  } else {
    add('A15', '揭晓后对比区出现真实 provider / model', false, '揭晓按钮不可见，无法继续');
  }
  }

  // ── A23：截图 ─────────────────────────────────────────────
  await page.click('#btn-screenshots');
  await page.waitForTimeout(14000);
  const shotInfo = await page.evaluate(() => {
    const imgs = [...document.querySelectorAll('img[src^="data:image/png"]')];
    const panel = [...document.querySelectorAll('.panel')].find((p) => /初始截图/.test(p.innerText));
    return {
      images: imgs.length,
      sizes: imgs.map((i) => i.src.length),
      meta: panel ? panel.innerText.replace(/\s+/g, ' ').trim().slice(0, 400) : null,
    };
  });
  add('A23', '截图面板生成图片', shotInfo.images >= 1, { images: shotInfo.images });
  add('A23', '截图带有视口 / DPR / 等待时间 / 网络策略标注',
    Boolean(shotInfo.meta) && /DPR/.test(shotInfo.meta) && /网络策略/.test(shotInfo.meta) && /等待/.test(shotInfo.meta),
    shotInfo.meta);
  await shot('a23-screenshots');

  // ── A16：一个候选失败时仍是失败占位 ──────────────────────
  const openedFail = await openExperimentByTitle(FAIL_TITLE);
  add('A16', '打开"一成功一失败"的真实实验', openedFail.opened, openedFail.rows);
  await page.waitForTimeout(1200);
  const failShape = await page.$$eval('.frame-wrap', (els) => els.map((e) => ({
    hasIframe: Boolean(e.querySelector('iframe')),
    hasError: Boolean(e.querySelector('.frame-error')),
    errorText: e.querySelector('.frame-error') ? e.querySelector('.frame-error').innerText.replace(/\s+/g, ' ').trim().slice(0, 220) : null,
    buttons: [...e.querySelectorAll('.frame-error button')].map((b) => b.textContent.trim()),
  })));
  const errCard = failShape.find((s) => s.hasError);
  const okCard = failShape.find((s) => s.hasIframe);
  add('A16', '失败候选显示失败占位（不空白）', Boolean(errCard) && errCard.errorText.length > 0, errCard ? errCard.errorText : null);
  add('A16', '失败占位给出下一步（下载原始输出 / 重试）',
    Boolean(errCard) && errCard.buttons.includes('下载原始输出') && errCard.buttons.includes('重试'), errCard ? errCard.buttons : null);
  add('A16', '另一个候选照常可预览（失败不影响成功方）', Boolean(okCard));
  add('A16', '页面未卡死：仍可切页签', await page.evaluate(() => { document.querySelector('.tab[data-view="experiments"]').click(); return true; }));
  await page.waitForTimeout(800);
  await page.click('.tab[data-view="compare"]');
  await page.waitForTimeout(1200);
  await shot('a16-failure-placeholder');

  report.consoleErrors = consoleErrors;
  report.pageErrors = pageErrors;
  report.shots = shots;
  report.finishedAt = new Date().toISOString();
  report.ok = report.checks.every((c) => c.ok) && consoleErrors.length === 0 && pageErrors.length === 0;
} catch (err) {
  report.error = String(err && err.stack || err).slice(0, 2000);
  try { await shot('99-失败现场'); } catch { /* 截图失败就算了 */ }
  report.consoleErrors = consoleErrors;
  report.pageErrors = pageErrors;
  report.shots = shots;
  report.ok = false;
} finally {
  await browser.close();
}

const outPath = join(OUT, 'm1-compare-walkthrough-' + Date.now() + '.json');
writeEvidence(outPath, report);
const passed = report.checks.filter((c) => c.ok).length;
if (report.error) console.log('\n脚本中断：' + report.error.split('\n')[0]);
console.log('\n' + passed + '/' + report.checks.length + ' 项通过；控制台错误 ' + (report.consoleErrors ?? []).length + '；页面异常 ' + (report.pageErrors ?? []).length);
if ((report.consoleErrors ?? []).length) console.log(JSON.stringify(report.consoleErrors.slice(0, 6), null, 2));
if ((report.pageErrors ?? []).length) console.log(JSON.stringify(report.pageErrors.slice(0, 6), null, 2));
console.log('证据：' + outPath);
process.exitCode = report.ok ? 0 : 1;