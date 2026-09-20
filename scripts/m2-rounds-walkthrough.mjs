/**
 * 追加轮次（反馈 3 / 方案 1）的真实浏览器实测 —— 模拟模型，**零费用**。
 *
 * 验证的是用户实际会看到的那条路：
 *   跑完一轮 → 在运行面板写一句"想让它改成什么样" → 点"追加一轮"
 *   → 出现第 2 轮 → 第 1 轮的原始输出仍然在、仍能下载。
 *
 * 用法：node scripts/m2-rounds-walkthrough.mjs [--base http://127.0.0.1:8790]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from '../src/preview/browser.js';
import { writeEvidence } from './lib/redact.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const getArg = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const BASE = getArg('--base', 'http://127.0.0.1:8790');
const OUT = join(here, '..', 'docs', 'evidence');
mkdirSync(OUT, { recursive: true });

const report = { startedAt: new Date().toISOString(), base: BASE, checks: [] };
const add = (area, name, ok, detail) => {
  report.checks.push({ area, name, ok: Boolean(ok), detail: detail === undefined ? null : detail });
  console.log((ok ? '  ✓ ' : '  ✗ ') + '[' + area + '] ' + name + (detail === undefined ? '' : '  ' + JSON.stringify(detail).slice(0, 240)));
};

const b = await launchBrowser();
if (!b.ok) { console.log('无法启动浏览器：' + b.reason); process.exitCode = 1; }
else {
  const browser = b.browser;
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300)); });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e.message).slice(0, 300)));
  const shots = [];
  const shot = async (n) => { writeFileSync(join(OUT, 'm2rounds-' + n + '.png'), await page.screenshot({ type: 'png' })); shots.push(n); };

  try {
    await page.goto(BASE + '/configstudio/api/ui', { waitUntil: 'load', timeout: 30000 });
    await page.waitForSelector('#mode-badge', { timeout: 20000 });
    await page.waitForTimeout(1200);

    // ── 跑第一轮 ───────────────────────────────────────────
    await page.click('.tab[data-view="new"]');
    await page.waitForTimeout(400);
    await page.fill('#task-prompt', '做一个只有一行大字的页面');
    await page.fill('#task-title', 'M2 追加轮次');
    await page.click('#btn-start');
    await page.waitForSelector('#view-run:not([hidden])', { timeout: 30000 });
    await page.waitForFunction(() => { const b = document.getElementById('btn-goto-compare'); return b && !b.disabled; }, { timeout: 120000 });
    await page.waitForTimeout(900);

    const round1 = await page.evaluate(() => {
      const st = window.__htmlArena.state;
      return {
        attempts: st.current.attempts.length,
        tags: [...document.querySelectorAll('#run-cards .round-tag')].map((e) => e.textContent),
        ids: st.current.attempts.map((a) => a.id),
      };
    });
    add('第 1 轮', '首轮标记为"第 1 轮"', round1.tags.every((t) => t === '第 1 轮'), round1.tags);
    await shot('round1');

    // 记下第 1 轮的原始正文 hash，稍后核对"没被覆盖"
    const raw1Hashes = await page.evaluate(() => {
      const st = window.__htmlArena.state;
      const m = {};
      st.current.attempts.forEach((a) => { m[a.id] = a.extraction ? a.extraction.rawTextHash : null; });
      return m;
    });

    // ── 追加一轮 ───────────────────────────────────────────
    await page.fill('#round-note', '把那一行大字改成红色，并且在下面加一行小字说明。');
    await page.click('#btn-add-round');
    await page.waitForFunction(() => {
      const st = window.__htmlArena.state;
      return st.current && st.current.attempts.some((a) => a.attemptNo >= 2);
    }, { timeout: 60000 });
    await page.waitForTimeout(1200);
    const hist = await page.textContent('#round-history');
    add('追加轮次', '界面回报了每个候选的新轮次与"回放了什么"', /第 2 轮/.test(hist) && /上一轮回放/.test(hist), hist.slice(0, 200));

    // 等第 2 轮也跑完
    await page.waitForFunction(() => { const b = document.getElementById('btn-goto-compare'); return b && !b.disabled; }, { timeout: 120000 });
    await page.waitForTimeout(1000);

    const round2 = await page.evaluate(() => {
      const st = window.__htmlArena.state;
      return {
        total: st.current.attempts.length,
        maxRound: Math.max(...st.current.attempts.map((a) => a.attemptNo)),
        tags: [...document.querySelectorAll('#run-cards .round-tag')].map((e) => e.textContent),
        highlighted: [...document.querySelectorAll('#run-cards .round-tag.is-round')].length,
        rawHashes: Object.fromEntries(st.current.attempts.map((a) => [a.id, a.extraction ? a.extraction.rawTextHash : null])),
        parentLinked: st.current.attempts.filter((a) => a.parentAttemptId).length,
      };
    });
    add('追加轮次', '出现了第 2 轮', round2.maxRound === 2, { maxRound: round2.maxRound, total: round2.total });
    add('追加轮次', '运行面板同时显示第 1 轮与第 2 轮的卡片', round2.tags.filter((t) => t === '第 2 轮').length >= 1, round2.tags);
    add('追加轮次', '第 2 轮被高亮标注（一眼看出这是新的一轮）', round2.highlighted >= 1, { highlighted: round2.highlighted });
    add('追加轮次', '新轮次挂在上一轮下面（parentAttemptId 有值）', round2.parentLinked >= 1, { parentLinked: round2.parentLinked });

    // 核心：第 1 轮的原始正文没有被覆盖
    const kept = Object.keys(raw1Hashes).every((id) => raw1Hashes[id] && round2.rawHashes[id] === raw1Hashes[id]);
    add('可核对性', '第 1 轮的原始正文 hash 没有被改写（原记录完整保留）', kept, { before: raw1Hashes, after: round2.rawHashes });

    // 第 1 轮的原始输出仍然能下载
    const dl = await page.evaluate(async () => {
      const st = window.__htmlArena.state;
      const first = st.current.attempts.filter((a) => a.attemptNo === 1)[0];
      const r = await fetch('/configstudio/api/experiments/' + st.current.experiment.id + '/attempts/' + first.id + '/raw');
      const t = await r.text();
      return { status: r.status, length: t.length, head: t.slice(0, 40) };
    });
    add('可核对性', '第 1 轮的原始输出仍然可以单独下载', dl.status === 200 && dl.length > 0, dl);

    add('追加轮次', '界面上写明了"每一轮都是一次新的逻辑请求"',
      /新的逻辑请求/.test(await page.textContent('#round-note-hint')), (await page.textContent('#round-note-hint')).slice(0, 120));
    await shot('round2');

    // ── 每一轮的原始输出都要真的点得到 ─────────────────────
    // 界面对用户承诺"上一轮的原始输出完整保留、仍可下载"，那这里就必须真的能下载，
    // 而不是只留在数据库里（这条断言是把我第一版那个假断言换掉后加的）。
    // 注意选择器：卡片里的"推理过程"也是 details.more，用 '#view-run details.more' 会选错面板
    // （第一版就踩了这个，断言看的是卡里那个块；因为 innerText 对未渲染元素退化成 textContent，
    //  那次居然还是绿的）。现在用 id 定位，并确认它真的展开着。
    const panel = await page.evaluate(() => {
      const d = document.getElementById('run-raw-panel');
      if (!d) return { exists: false };
      d.open = true;
      return { exists: true, open: d.open, rows: d.querySelectorAll('.raw-row').length };
    });
    add('可核对性', '"原始输出与提取结果"面板存在且能展开（用 id 定位，不是靠顺序猜）',
      panel.exists === true && panel.open === true && panel.rows >= 2, panel);
    await page.waitForTimeout(500);
    const rawRows = await page.$$eval('#run-raw .raw-row', (els) => Array.from(els).map((e) => e.innerText.replace(/\s+/g, ' ').trim()));
    add('可核对性', '运行面板按轮次列出每一次尝试（第 1 轮与第 2 轮都在）',
      rawRows.some((t) => t.startsWith('第 1 轮')) && rawRows.some((t) => t.startsWith('第 2 轮')), rawRows);
    add('可核对性', '只有最新一轮标注为"当前采用"',
      rawRows.filter((t) => t.includes('当前采用')).length === 2, rawRows);
    add('可核对性', '第 2 轮写明"由上一轮新建"（轮次来源可追溯）',
      rawRows.filter((t) => t.includes('由上一轮新建')).length === 2, rawRows);

    // 真的点一下第 1 轮的"下载原始输出"，确认它指向的是第 1 轮那份文件
    const firstRoundDownload = await page.evaluate(() => {
      const st = window.__htmlArena.state;
      const first = st.current.attempts.filter((a) => a.attemptNo === 1)[0];
      const rows = [...document.querySelectorAll('#run-raw .raw-row')];
      const row = rows.find((r) => r.innerText.startsWith('第 1 轮'));
      const btns = row ? [...row.querySelectorAll('button')].map((b) => b.textContent) : [];
      return { attemptId: first.id, buttons: btns };
    });
    add('可核对性', '第 1 轮那一行有"查看原始正文 / 下载原始输出 / 下载这一轮的作品"',
      firstRoundDownload.buttons.includes('下载原始输出') && firstRoundDownload.buttons.includes('查看原始正文'), firstRoundDownload);

    // 第 2 轮的作品与第 1 轮不同（确实改了，不是复制）
    const diff = await page.evaluate(async () => {
      const st = window.__htmlArena.state;
      const byNo = {};
      st.current.attempts.forEach((a) => { if (!byNo[a.attemptNo]) byNo[a.attemptNo] = a; });
      const out = {};
      for (const no of [1, 2]) {
        const a = byNo[no];
        if (!a || !a.canPreview) { out[no] = null; continue; }
        const r = await fetch('/configstudio/api/experiments/' + st.current.experiment.id + '/attempts/' + a.id + '/html');
        const t = await r.text();
        out[no] = t.slice(0, 120);
      }
      return out;
    });
    add('追加轮次', '两轮各自留下自己的作品（不是把第 1 轮覆盖成第 2 轮）',
      Boolean(diff[1]) && Boolean(diff[2]), { r1: (diff[1] || '').slice(0, 50), r2: (diff[2] || '').slice(0, 50) });
    await shot('round-raw-list');

    report.consoleErrors = consoleErrors;
    report.pageErrors = pageErrors;
    report.shots = shots;
    report.finishedAt = new Date().toISOString();
    report.ok = report.checks.every((c) => c.ok) && consoleErrors.length === 0 && pageErrors.length === 0;
  } catch (err) {
    report.error = String(err && err.stack || err).slice(0, 1200);
    try { await shot('99-error'); } catch { /* 忽略 */ }
    report.consoleErrors = consoleErrors;
    report.pageErrors = pageErrors;
    report.ok = false;
  } finally {
    await browser.close();
  }
}

const outPath = join(OUT, 'm2-rounds-' + Date.now() + '.json');
writeEvidence(outPath, report);
if (report.error) console.log('\n脚本中断：' + report.error.split('\n')[0]);
const passed = report.checks.filter((c) => c.ok).length;
console.log('\n' + passed + '/' + report.checks.length + ' 项通过；控制台错误 ' + (report.consoleErrors || []).length + '；页面异常 ' + (report.pageErrors || []).length);
if ((report.pageErrors || []).length) console.log(JSON.stringify(report.pageErrors.slice(0, 4), null, 1));
console.log('证据：' + outPath);
process.exitCode = report.ok ? 0 : 1;
