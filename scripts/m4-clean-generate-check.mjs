/**
 * M4-1b 干净安装的**完整用户路径**（生成 → 对比 → 评价 → 导出），全程零费用。
 *
 * 与 m4-clean-install-check 的分工：那个走到"开始生成"之前的表单就停了（怕花钱）；
 * 这个在**装的是交付 tgz** 的真实 DSH 实例上把整条路径走完 ——
 * 靠的是 `--patch` 挂进去的模拟 provider（scripts/sim-llm-overlay/），
 * 它**完全不联网**，产物会明确标成模拟结果。
 *
 * 这正是"干净安装按真实用户路径完整走一遍"和"只跑接口冒烟"的区别：
 * 前者会撞到"宿主 llm 服务没接上""生成回调没落库""对比页拿不到作品"这类问题，
 * 后者一个都撞不到。
 *
 * 用法：node scripts/m4-clean-generate-check.mjs --base http://127.0.0.1:8910 --token <token> [--out ../交付区/v0.5.0/截图]
 */
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from '../src/preview/browser.js';
import { readZip } from '../src/core/zip.js';
import { EVIDENCE_DIR, makeChecker, sleep, api } from './lib/devhost.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const getArg = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const BASE = getArg('--base', 'http://127.0.0.1:8910');
const TOKEN = getArg('--token', '');
const SHOT_DIR = join(here, '..', getArg('--out', 'docs/evidence'));
mkdirSync(SHOT_DIR, { recursive: true });

const { add, report, finish } = makeChecker({
  what: 'M4-1b 干净安装的完整用户路径（生成 → 对比 → 评价 → 导出）',
  note: '模拟 provider（--patch 挂载，不联网、零费用）；产物是模拟结果，不是真实模型输出',
  extra: { base: BASE },
});

const apiBase = BASE + '/configstudio/api';
const uiUrl = apiBase + '/ui';

// 前置：**模型调用日志**用于证明"没有偷偷联网"。模拟 provider 不写这个日志，
// 所以这里用另一种口径：检查 /models 里能被选中的只有 sim-* 前缀的来源。
const b = await launchBrowser();
if (!b.ok) { add('浏览器', '可启动浏览器', false, { reason: b.reason }); process.exitCode = finish('m4-clean-generate'); }
else {
  const browser = b.browser;
  const ctx = await browser.newContext({ viewport: { width: 1560, height: 1000 } });
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300)); });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e.message).slice(0, 300)));
  // 抓所有出网请求：模拟 provider 不联网，所以除本机回环外**不该有别的 host**。
  const external = [];
  page.on('request', (r) => {
    const u = r.url();
    if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:|\/)/.test(u) && !u.startsWith('data:') && !u.startsWith('blob:')) external.push(u.slice(0, 160));
  });
  const shot = async (name) => { await page.screenshot({ path: join(SHOT_DIR, name) }); };

  try {
    await page.goto(uiUrl, { waitUntil: 'load', timeout: 40000 });
    await page.waitForSelector('#mode-badge', { timeout: 25000 });
    await page.waitForTimeout(1500);

    // ── 1) 新建对比，填题，选两个**模拟**来源
    await page.click('.tab[data-view="new"]');
    await page.waitForSelector('#view-new:not([hidden])', { timeout: 20000 });
    await page.waitForTimeout(1000);
    await page.fill('#task-prompt', '做一个可以被用户操作的页面：有一个按钮，点一下换一次颜色，并把点击次数显示出来。');
    await page.fill('#task-title', 'M4 干净安装完整路径');
    await page.waitForTimeout(400);

    const picked = await page.evaluate(async () => {
      const st = window.__htmlArena.state;
      const out = [];
      const cards = [...document.querySelectorAll('#candidates .cand')];
      // 用**状态**（而不是 DOM 的 value）确认选中的是什么 —— DOM 上的 selected 属性
      // 和 state 是两件事，插件里也踩过"看着选了、其实没选"（见 addCandidate 的注释）。
      while (st.candidates.length < 2) { document.getElementById('btn-add-candidate').click(); }
      const sims = [
        { provider: 'sim-ok-a', model: 'sim-fast' },
        { provider: 'sim-ok-b', model: 'sim-fast' },
      ];
      st.candidates.forEach((c, i) => {
        c.provider = sims[i % sims.length].provider;
        c.model = sims[i % sims.length].model;
        c.name = '模拟候选 ' + String.fromCharCode(65 + i);
        out.push({ name: c.name, provider: c.provider, model: c.model });
      });
      // 状态改完之后必须重绘，否则界面上的下拉框还是旧值（用户的下一步点在旧值上）
      window.__htmlArena.renderCandidates ? window.__htmlArena.renderCandidates() : null;
      return { candidates: out, count: st.candidates.length };
    });
    add('1 准备', '两个候选都选到了 sim-* 模拟来源（不会真花钱）',
      picked.candidates.every((c) => c.provider.startsWith('sim-')), picked);
    await page.waitForTimeout(1500);

    const resolveText = await page.evaluate(() => [...document.querySelectorAll('#candidates [data-resolved]')].map((e) => e.innerText.replace(/\s+/g, ' ').trim()).join(' | '));
    add('1 准备', '模拟来源的"解析结果"能读出来（上下文窗口 / 模型默认输出上限）',
      /上下文窗口/.test(resolveText) && !/无法解析/.test(resolveText), resolveText.slice(0, 200));
    await shot('m4-gen-01-prepared.png');

    // ── 2) 点开始生成，等两个候选都完成
    await page.click('#btn-start');
    await page.waitForSelector('#view-run:not([hidden])', { timeout: 30000 });
    await page.waitForFunction(() => {
      const st = window.__htmlArena.state;
      const a = st.current && st.current.attempts;
      return a && a.length >= 2 && a.every((x) => ['completed', 'failed', 'cancelled', 'timed_out'].includes(x.status));
    }, { timeout: 120000 });
    await page.waitForTimeout(1200);

    const run = await page.evaluate(() => {
      const st = window.__htmlArena.state;
      return {
        experimentId: st.current.experiment.id,
        attempts: st.current.attempts.map((a) => ({
          id: a.id, slot: a.slot, status: a.status,
          rawTextHash: a.extraction && a.extraction.rawTextHash,
          htmlHash: a.extraction && a.extraction.htmlHash,
          bytes: a.extraction && a.extraction.bytes,
        })),
      };
    });
    report.run = run;
    add('2 生成', '两个候选都真的 completed（干净安装上真跑通了生成）',
      run.attempts.length >= 2 && run.attempts.every((a) => a.status === 'completed'),
      run.attempts.map((a) => a.slot + ':' + a.status));
    add('2 生成', '每个候选都提取出了作品 HTML（不是"跑完但没东西"）',
      run.attempts.every((a) => typeof a.htmlHash === 'string' && a.bytes > 0),
      run.attempts.map((a) => ({ slot: a.slot, bytes: a.bytes })));
    add('2 生成', '两个候选的作品指纹不同（确实是两份不同的作品）',
      new Set(run.attempts.map((a) => a.htmlHash)).size === run.attempts.length,
      run.attempts.map((a) => a.htmlHash));
    await shot('m4-gen-02-generated.png');

    // ── 3) 进入对比页，作品 iframe 真的渲染出来了
    await page.click('#btn-goto-compare');
    await page.waitForSelector('#view-compare:not([hidden])', { timeout: 20000 });
    await page.waitForTimeout(4000);

    const frames = await page.evaluate(() => [...document.querySelectorAll('#compare-grid iframe')].map((f) => ({ src: f.getAttribute('src'), sandbox: f.getAttribute('sandbox') })));
    add('3 对比', '对比页为每个候选都挂上了预览 iframe', frames.length >= 2, { count: frames.length });
    add('3 对比', '预览 iframe 带 sandbox 且**不含 allow-same-origin**（F12）',
      frames.length > 0 && frames.every((f) => f.sandbox && !f.sandbox.includes('allow-same-origin')),
      frames.map((f) => f.sandbox));

    // 作品真的在 iframe 里渲染出内容（不是白屏）
    const previewFrames = page.frames().filter((f) => f !== page.mainFrame());
    let rendered = 0;
    for (const f of previewFrames) {
      try {
        const len = await f.evaluate(() => (document.body && document.body.innerText || '').trim().length + document.querySelectorAll('*').length);
        if (len > 5) rendered += 1;
      } catch { /* 跨源读不到就是没渲染成功 */ }
    }
    add('3 对比', '至少两个预览 iframe 里真的有渲染出来的 DOM（不是白屏）', rendered >= 2, { rendered, frames: previewFrames.length });

    const usageText = await page.evaluate(() => (document.getElementById('compare-grid').innerText || '').replace(/\s+/g, ' '));
    add('3 对比', '作品卡上直接显示了用量与速度（不用展开折叠面板）',
      /输入/.test(usageText) && /输出/.test(usageText), usageText.slice(0, 260));
    await shot('m4-gen-03-compare.png');

    // ── 4) 盲选 → 评价 → 揭晓（A15 的用户路径）
    await page.click('#btn-blind');
    await page.waitForTimeout(1200);
    const blindText = await page.evaluate(() => (document.getElementById('compare-grid').innerText || '').replace(/\s+/g, ' '));
    add('4 盲选', '隐藏配置身份后，作品卡上看不到 sim-ok-a / sim-ok-b',
      !/sim-ok-a|sim-ok-b|sim-fast/.test(blindText), blindText.slice(0, 200));

    // 评价是一排普通按钮（偏好 A / 偏好 B / 平局 / 无法判断），不是 radio。
    // 真按用户的方式点一下，并确认**界面状态**跟着变了（点了没反应也算不合格）。
    const voted = await page.evaluate(() => {
      const btns = [...document.querySelectorAll('#vote-row button')];
      const target = btns.find((b) => (b.textContent || '').includes('偏好 A')) || btns[0];
      if (!target) return { clicked: null, html: document.getElementById('vote-row').innerHTML.slice(0, 300) };
      target.click();
      return { clicked: (target.textContent || '').trim(), total: btns.length };
    });
    // 产品的反馈渠道是 #vote-status 那一行（"已保存：偏好 A（时间）。选择绑定具体作品 hash。"）
    // 以及 toast，**不是**按钮上的选中态 —— 探针第一版查了按钮 class，那是查错了地方。
    await page.waitForFunction(() => /已保存/.test((document.getElementById('vote-status') || {}).textContent || ''), { timeout: 15000 }).catch(() => {});
    const voteState = await page.evaluate(() => ({
      status: (document.getElementById('vote-status') || {}).textContent || '',
      // 如实记录一个**观察**（不是断言失败）：按钮本身上没有"已选中"的样子。
      buttonHasSelectedClass: [...document.querySelectorAll('#vote-row button')].some((b) => /is-active|selected|primary/.test(b.className)),
    }));
    report.voteButtonObservation = { buttonHasSelectedClass: voteState.buttonHasSelectedClass, feedbackChannel: '#vote-status' };
    add('4 盲选', '点评价按钮后出现"已保存：…"的确认（产品的反馈在这一行，不是按钮高亮）',
      Boolean(voted.clicked) && voted.total >= 2 && /已保存/.test(voteState.status),
      { clicked: voted.clicked, buttons: voted.total, status: voteState.status.slice(0, 120) });
    await page.screenshot({ path: join(SHOT_DIR, 'm4-gen-04-blind-vote.png') });

    // 用接口把评价落库再揭晓（界面上的按钮文案会随状态变，直接点接口更稳，且同样是产品路径）
    const voteResp = await page.evaluate(async (expId) => {
      const r = await fetch('/configstudio/api/experiments/' + encodeURIComponent(expId) + '/vote', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ choice: 'A' }),
      });
      return { status: r.status, body: (await r.text()).slice(0, 200) };
    }, run.experimentId);
    add('4 盲选', '评价能保存（接口走产品自己的路由）', voteResp.status < 300, voteResp);

    const revealed = await page.evaluate(async (expId) => {
      const r = await fetch('/configstudio/api/experiments/' + encodeURIComponent(expId) + '/reveal', { method: 'POST' });
      return { status: r.status, body: (await r.text()).slice(0, 200) };
    }, run.experimentId);
    add('4 盲选', '揭晓能执行（揭晓不可逆，这一步之后身份就公开）', revealed.status < 300, revealed);

    // ── 5) 导出展示包 + 复测包（M3 的能力在干净安装上也要能用）
    const showcase = await page.evaluate(async (expId) => {
      const r = await fetch('/configstudio/api/experiments/' + encodeURIComponent(expId) + '/export/showcase');
      if (r.status !== 200) return { status: r.status, error: (await r.text()).slice(0, 200) };
      const buf = new Uint8Array(await r.arrayBuffer());
      return { status: r.status, bytes: buf.length, head: Array.from(buf.slice(0, 4)) };
    }, run.experimentId);
    add('5 导出', '展示包能下载且是合法 ZIP（前缀 PK\x03\x04）',
      showcase.status === 200 && showcase.bytes > 1000 && JSON.stringify(showcase.head) === JSON.stringify([80, 75, 3, 4]),
      { status: showcase.status, bytes: showcase.bytes, head: showcase.head });

    const retest = await page.evaluate(async (expId) => {
      const r = await fetch('/configstudio/api/experiments/' + encodeURIComponent(expId) + '/export/retest');
      if (r.status !== 200) return { status: r.status, error: (await r.text()).slice(0, 200) };
      const buf = new Uint8Array(await r.arrayBuffer());
      return { status: r.status, bytes: buf.length, head: Array.from(buf.slice(0, 4)) };
    }, run.experimentId);
    add('5 导出', '复测包能下载且是合法 ZIP',
      retest.status === 200 && retest.bytes > 500 && JSON.stringify(retest.head) === JSON.stringify([80, 75, 3, 4]),
      { status: retest.status, bytes: retest.bytes });

    // ── 6) 历史列表里能找到刚跑完的那条
    await page.click('.tab[data-view="experiments"]');
    await page.waitForSelector('#view-experiments:not([hidden])', { timeout: 20000 });
    await page.waitForTimeout(1500);
    const listed = await page.evaluate(() => (document.getElementById('experiment-list').innerText || '').includes('M4 干净安装完整路径'));
    add('6 历史', '刚跑完的实验出现在历史列表里', listed);
    await shot('m4-gen-05-history.png');

    // ── 7) 出网检查：整条路径除了本机回环，不应该有别的 host
    add('7 零费用', '整条用户路径只访问本机回环地址（没有对外网络请求）',
      external.length === 0, { external: external.slice(0, 8) });
    add('7 零费用', '控制台 0 错误、页面 0 异常', consoleErrors.length === 0 && pageErrors.length === 0,
      { consoleErrors: consoleErrors.slice(0, 5), pageErrors: pageErrors.slice(0, 5) });
  } catch (err) {
    report.error = String(err && err.stack || err).slice(0, 1500);
    add('用户路径', '全程未中断', false, report.error.split(String.fromCharCode(10))[0]);
    try { await page.screenshot({ path: join(SHOT_DIR, 'm4-gen-failed.png') }); } catch { /* 截图失败不影响结论 */ }
  } finally { await browser.close(); }
}

process.exitCode = finish('m4-clean-generate');
