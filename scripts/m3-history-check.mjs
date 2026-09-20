/**
 * M3：历史搜索与筛选、复制实验、列表里的导出入口（F：历史列表）。
 *
 * 覆盖的口径：按标题搜索、按类型筛选、**按评价筛选**（已评价 / 未评价 / 已揭晓 / 未揭晓 / 具体结论）、
 * 组合筛选、无结果时的空状态、复制实验（复制到"新建对比"表单而不是偷偷新建一条记录）、
 * 以及列表行上的导出入口。
 *
 * 全程零费用：开发服务器 + 模拟模型；评价直接用接口写（不花模型钱）。
 *
 * 用法：node scripts/m3-history-check.mjs
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchBrowser } from '../src/preview/browser.js';
import {
  EVIDENCE_DIR, sleep, freePort, api, postJson, startDevServer, waitHealthy, hardKill, makeChecker,
} from './lib/devhost.mjs';

const { add, report, finish } = makeChecker({
  what: 'M3：历史搜索与筛选 / 复制实验 / 列表导出入口',
  note: '模拟模型，零费用',
});

const dataDir = mkdtempSync(join(tmpdir(), 'arena-history-'));
let server = null;
let browserHandle = null;

async function waitIdle(base, id, timeoutMs = 30000) {
  const t0 = Date.now();
  for (;;) {
    const r = await api(base, '/experiments/' + id);
    const running = r.body.attempts.filter((a) => a.running || a.status === 'running' || a.status === 'queued');
    if (running.length === 0) return r.body;
    if (Date.now() - t0 > timeoutMs) throw new Error('等待生成超时');
    await sleep(80);
  }
}

try {
  const port = await freePort();
  const base = 'http://127.0.0.1:' + port + '/configstudio/api';
  server = startDevServer({ port, dataDir, latencyMs: 40 });
  await waitHealthy(base);

  // ── 准备三条实验：两条同题材不同类型、一条不同题材 ────────────────
  const makeExp = async (title, category) => {
    const r = await postJson(base, '/experiments', {
      title, category, prompt: '做一个' + title + '的页面', outputPolicy: { timeoutMs: 20000 },
    });
    const id = r.body.experiment.id;
    const s = await postJson(base, '/experiments/' + id + '/start', {
      candidates: [{ name: '甲', provider: 'sim-ok-a', model: 'sim-fast' }, { name: '乙', provider: 'sim-ok-b', model: 'sim-slow' }],
    });
    if (s.status !== 202) throw new Error('启动失败：' + JSON.stringify(s.body));
    await waitIdle(base, id);
    return id;
  };
  const e1 = await makeExp('番茄钟对比', 'prototype');
  const e2 = await makeExp('番茄钟夜版', 'game');
  const e3 = await makeExp('天气仪表盘', 'dashboard');
  add('准备', '三条实验都已跑完（2 候选各自完成）',
    (await api(base, '/experiments')).body.experiments.length === 3);

  // 评价：E1 未揭晓的偏好 A；E2 已揭晓的平局；E3 不评价
  await postJson(base, '/experiments/' + e1 + '/vote', { choice: 'A', tags: ['视觉'], note: '左边更清楚' });
  await postJson(base, '/experiments/' + e2 + '/vote', { choice: 'tie', tags: ['交互'], note: '各有长短' });
  await postJson(base, '/experiments/' + e2 + '/reveal', {});
  const votes = (await api(base, '/experiments')).body.experiments.map((x) => [x.title, x.vote && x.vote.choice, x.vote && x.vote.revealed]);
  add('准备', '三条实验的评价状态符合预期（未揭晓 / 已揭晓 / 未评价）',
    JSON.stringify(votes.find((v) => v[0] === '番茄钟对比')) === JSON.stringify(['番茄钟对比', 'A', false])
      && JSON.stringify(votes.find((v) => v[0] === '番茄钟夜版')) === JSON.stringify(['番茄钟夜版', 'tie', true])
      && votes.find((v) => v[0] === '天气仪表盘')[1] === null,
    votes);

  const b = await launchBrowser();
  if (!b.ok) throw new Error('无法启动浏览器：' + b.reason);
  browserHandle = b.browser;
  const page = await b.browser.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200)); });
  page.on('pageerror', (e) => pageErrors.push(String(e.message).slice(0, 200)));
  await page.goto('http://127.0.0.1:' + port + '/configstudio/api/ui', { waitUntil: 'load', timeout: 30000 });
  await page.waitForSelector('#mode-badge', { timeout: 20000 });
  await page.waitForTimeout(900);

  const rows = async () => page.$$eval('#experiment-list .exp', (els) => els.map((e) => e.innerText.replace(/\s+/g, ' ')));
  const setFilter = async (sel, value) => {
    await page.selectOption(sel, value);
    await page.waitForTimeout(700);
  };
  const typeSearch = async (text) => {
    await page.fill('#search', text);
    await page.waitForTimeout(800);
  };
  const titles = async () => (await rows()).map((t) => t.split(' ')[0]);

  // ── 搜索 / 类型 / 评价筛选 ───────────────────────────────────────
  await page.waitForTimeout(500);
  add('历史', '初始列表显示全部三条', (await rows()).length === 3, await titles());

  await typeSearch('番茄钟');
  add('历史', '按标题搜索"番茄钟"→ 2 条', (await rows()).length === 2, await titles());
  await typeSearch('夜版');
  add('历史', '搜索是子串匹配（"夜版"→ 1 条）', (await rows()).length === 1, await titles());
  await typeSearch('不存在的题目');
  const emptyText = await page.innerText('#experiment-list');
  add('历史', '搜不到时给出空状态文案，而不是空白列表',
    (await rows()).length === 0 && /还没有实验|没有找到|换个条件/.test(emptyText), emptyText.replace(/\s+/g, ' ').slice(0, 80));
  await typeSearch('');

  await setFilter('#filter-category', 'prototype');
  add('历史', '按类型筛选 prototype → 1 条（番茄钟对比）', (await rows()).length === 1 && (await titles())[0] === '番茄钟对比', await titles());
  await setFilter('#filter-category', 'game');
  add('历史', '按类型筛选 game → 1 条（番茄钟夜版）', (await rows()).length === 1 && (await titles())[0] === '番茄钟夜版', await titles());
  await setFilter('#filter-category', '');

  await setFilter('#filter-vote', 'any');
  add('历史', '按评价筛"已评价"→ 2 条', (await rows()).length === 2, await titles());
  await setFilter('#filter-vote', 'none');
  add('历史', '按评价筛"未评价"→ 1 条（天气仪表盘）', (await rows()).length === 1 && (await titles())[0] === '天气仪表盘', await titles());
  await setFilter('#filter-vote', 'revealed');
  add('历史', '按评价筛"已揭晓"→ 1 条', (await rows()).length === 1 && (await titles())[0] === '番茄钟夜版', await titles());
  await setFilter('#filter-vote', 'unrevealed');
  add('历史', '按评价筛"未揭晓"→ 1 条', (await rows()).length === 1 && (await titles())[0] === '番茄钟对比', await titles());
  await setFilter('#filter-vote', 'A');
  add('历史', '按结论筛"偏好 A"→ 1 条', (await rows()).length === 1 && (await titles())[0] === '番茄钟对比', await titles());
  await setFilter('#filter-vote', 'tie');
  add('历史', '按结论筛"平局"→ 1 条', (await rows()).length === 1 && (await titles())[0] === '番茄钟夜版', await titles());
  await setFilter('#filter-vote', 'B');
  add('历史', '按结论筛"偏好 B"→ 0 条（没有就是没有，不退回全部）', (await rows()).length === 0, await titles());

  // 组合筛选：搜索 + 类型 + 评价
  await setFilter('#filter-vote', 'any');
  await typeSearch('番茄钟');
  await setFilter('#filter-category', 'game');
  add('历史', '组合筛选（已评价 + 搜索"番茄钟" + 类型 game）→ 1 条',
    (await rows()).length === 1 && (await titles())[0] === '番茄钟夜版', await titles());
  const metaText = (await rows())[0];
  add('历史', '列表行显示评价与揭晓状态（筛选之外还能看出为什么被列出来）',
    /已评价：平局/.test(metaText) && /已揭晓/.test(metaText), metaText.slice(0, 120));

  // 让服务端确认筛选口径一致（界面不是"前端自己过滤"）
  const serverFiltered = await api(base, '/experiments?vote=any&search=' + encodeURIComponent('番茄钟') + '&category=game');
  add('历史', '服务端筛选口径与界面一致（同样的条件返回同样的 1 条）',
    serverFiltered.body.experiments.length === 1 && serverFiltered.body.experiments[0].title === '番茄钟夜版');

  // ── 复制实验 ────────────────────────────────────────────────────
  await setFilter('#filter-category', '');
  await typeSearch('番茄钟对比');
  const beforeCount = (await api(base, '/experiments')).body.experiments.length;
  await page.click('#experiment-list .exp:first-child button:has-text("复制实验")');
  await page.waitForTimeout(1200);
  const copied = await page.evaluate(() => ({
    title: document.getElementById('task-title').value,
    prompt: document.getElementById('task-prompt').value,
    candidates: document.querySelectorAll('#candidates .cand').length,
    view: window.__htmlArena.state.view,
    category: document.getElementById('task-category').value,
  }));
  add('历史', '复制实验：跳到"新建对比"并填好题目（标题带"（副本）"）',
    copied.view === 'new' && /（副本）$/.test(copied.title) && copied.prompt.includes('番茄钟对比'), copied);
  add('历史', '复制实验：候选配置一并带过来（2 个候选）且类型一致',
    copied.candidates === 2 && copied.category === 'prototype', copied);
  add('历史', '复制实验**不会**偷偷新建一条记录（服务端实验数不变）',
    (await api(base, '/experiments')).body.experiments.length === beforeCount, { before: beforeCount });

  // ── 列表行上的导出入口 ──────────────────────────────────────────
  await page.click('.tab[data-view="experiments"]');
  await page.waitForTimeout(800);
  // 评价筛选还停在"已评价"上：天气仪表盘没有评价，会被正确地过滤掉。
  // 这里如实把条件清干净再搜（第一版漏了这一步，于是列表为空、点不到导出按钮）。
  await page.selectOption('#filter-vote', '');
  await page.fill('#search', '天气仪表盘');
  await page.waitForTimeout(900);
  add('历史', '额外确认：筛选条件确实在起作用（"已评价" + 搜天气仪表盘 = 0 条）',
    (await api(base, '/experiments?vote=any&search=' + encodeURIComponent('天气仪表盘'))).body.experiments.length === 0);
  await page.click('#experiment-list .exp:first-child button:has-text("导出")');
  await page.waitForSelector('#export-modal:not([hidden])', { timeout: 10000 });
  await page.waitForTimeout(900);
  const modal = await page.innerText('#export-modal');
  add('历史', '列表行上的"导出"能打开导出对话框，并指向这条实验',
    /天气仪表盘/.test(modal) && /展示包/.test(modal) && /复测包/.test(modal), modal.replace(/\s+/g, ' ').slice(0, 120));
  await page.click('#btn-export-close');

  await page.screenshot({ path: join(EVIDENCE_DIR, 'm3-history-filters.png') });
  report.screenshot = 'docs/evidence/m3-history-filters.png';
  add('界面', '全程 0 控制台错误、0 页面异常',
    consoleErrors.length === 0 && pageErrors.length === 0,
    { consoleErrors: consoleErrors.slice(0, 3), pageErrors: pageErrors.slice(0, 3) });

  report.experiments = { e1, e2, e3 };
  await b.browser.close();
  browserHandle = null;
} catch (err) {
  add('执行', '脚本运行没有抛异常', false, String(err && err.stack || err).slice(0, 1200));
} finally {
  try { if (browserHandle) await browserHandle.close(); } catch { /* 已关 */ }
  try { await hardKill(server, '开发服务器'); } catch { /* 已经没了 */ }
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }
}

process.exit(finish('m3-history'));
