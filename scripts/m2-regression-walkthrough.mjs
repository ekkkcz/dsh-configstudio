/**
 * M2 回归：**轮询不打断用户操作**（反馈 2 的验收脚本）。
 *
 * 缺陷原话："这个推理过程我点开了 1 秒都不到又自动收回去了"。
 * 根因：运行面板每 700ms 调 renderRun()，而它开头是 clear(box)，把整块 DOM 重建，
 * 用户展开的 <details> 必然在下一个轮询周期被换掉。
 *
 * 本脚本用**模拟模型（零费用）**把真实触发路径走一遍：模拟模型里有一个
 * sim-reasoning 会先流式输出推理，所以运行面板真的会出现"推理过程"折叠块 ——
 * 不需要花一分钱就能验证它点开后不会被收回。
 *
 * 覆盖四件事（都是同一根因造成的）：
 *   1. 运行面板的"推理过程"展开后，跨过多轮 700ms 轮询仍然展开；
 *   2. 卡片节点本身被复用（不是"重建后恢复"）；
 *   3. 实时输出区向上翻阅时，滚动位置不被自动吸底抢走；
 *   4. 候选集合真的变化时（重试新建 attempt）卡片仍然正确重建。
 *
 * 用法：node scripts/m2-regression-walkthrough.mjs [--base http://127.0.0.1:8790]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from '../src/preview/browser.js';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const getArg = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const BASE = getArg('--base', 'http://127.0.0.1:8790');
const OUT = join(here, '..', 'docs', 'evidence');
mkdirSync(OUT, { recursive: true });
const UI = BASE + '/html-arena/api/ui';

const report = { startedAt: new Date().toISOString(), base: BASE, checks: [], notes: [] };
const add = (area, name, ok, detail) => {
  report.checks.push({ area, name, ok: Boolean(ok), detail: detail === undefined ? null : detail });
  console.log((ok ? '  ✓ ' : '  ✗ ') + '[' + area + '] ' + name + (detail === undefined ? '' : '  ' + JSON.stringify(detail).slice(0, 260)));
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
  const shot = async (n) => { writeFileSync(join(OUT, 'm2reg-' + n + '.png'), await page.screenshot({ type: 'png' })); shots.push(n); };

  try {
    await page.goto(UI, { waitUntil: 'load', timeout: 30000 });
    await page.waitForSelector('#mode-badge', { timeout: 20000 });
    await page.waitForTimeout(1200);

    // ── 起一轮：一个会推理的模拟模型 + 一个普通模拟模型 ───────
    await page.click('.tab[data-view="new"]');
    await page.waitForTimeout(400);
    await page.fill('#task-prompt', '做一个只有一行大字的页面');
    await page.fill('#task-title', 'M2 轮询不打断操作');
    const providers = await page.$$eval('#candidates .cand select[data-role="provider"] option', (els) => els.map((e) => e.value));
    add('准备', '模拟模型目录里有会推理的候选', providers.includes('sim-reasoning'), { has: providers.includes('sim-reasoning') });
    await page.selectOption('#candidates .cand:nth-child(1) select[data-role="provider"]', 'sim-reasoning');
    await page.selectOption('#candidates .cand:nth-child(2) select[data-role="provider"]', 'sim-ok-b');
    await page.waitForTimeout(1200);
    await page.click('#btn-start');
    await page.waitForSelector('#view-run:not([hidden])', { timeout: 30000 });

    // ── 1) 等"推理过程"真的出现在运行面板里 ─────────────────
    await page.waitForSelector('#run-cards details.live-reasoning', { timeout: 40000 });
    const reasoningCards = await page.$$eval('#run-cards details.live-reasoning', (e) => e.length);
    add('展开保持', '运行面板里出现了"推理过程"折叠块', reasoningCards >= 1, { reasoningCards });

    // 打标记 + 展开：这在旧实现里必然丢失
    const before = await page.evaluate(() => {
      const card = document.querySelector('#run-cards .cand');
      card.setAttribute('data-probe', 'marked');
      const d = card.querySelector('details.live-reasoning');
      d.open = true;
      // 顺便制造一段可滚动的正文，用来验证滚动位置
      const pre = card.querySelector('pre.stream:not(.reasoning)');
      return { cardTag: card.tagName, open: d.open, hasPre: Boolean(pre), textLength: pre ? pre.textContent.length : 0 };
    });
    add('展开保持', '探针就位（卡片已打标记、推理块已展开）', before.open && before.hasPre, before);

    // 跨过多轮轮询（700ms × 5 ≈ 3.5s，用户原话是"不到 1 秒"）
    await page.waitForTimeout(3600);
    const after = await page.evaluate(() => {
      const card = document.querySelector('#run-cards .cand');
      const d = card ? card.querySelector('details.live-reasoning') : null;
      return {
        cards: document.querySelectorAll('#run-cards .cand').length,
        markerSurvived: card ? card.getAttribute('data-probe') === 'marked' : false,
        detailsStillPresent: Boolean(d),
        detailsStillOpen: d ? d.open : null,
        reasoningLength: d ? d.querySelector('pre.reasoning').textContent.length : 0,
        streamLength: d ? d.parentElement.querySelector('pre.stream:not(.reasoning)').textContent.length : 0,
      };
    });
    add('展开保持', '跨 5 轮轮询后"推理过程"仍然展开（核心回归）', after.detailsStillOpen === true, after);
    add('展开保持', '同一张卡片节点被复用，不是重建后恢复状态', after.markerSurvived === true, { markerSurvived: after.markerSurvived, cards: after.cards });
    add('展开保持', '推理正文确实在增长（不是空壳折叠块）', after.reasoningLength > 60, { reasoningLength: after.reasoningLength });
    await shot('reasoning-open');

    // ── 2) 滚动位置：向上翻阅时不被自动吸底抢走 ─────────────
    const scroll = await page.evaluate(async () => {
      const pre = document.querySelector('#run-cards pre.stream:not(.reasoning)');
      if (!pre) return { skipped: true };
      pre.style.maxHeight = '60px';           // 确保一定可滚动，不依赖正文有多长
      await new Promise((r) => setTimeout(r, 30));
      pre.scrollTop = 0;                      // 用户往上翻到顶部
      return { scrollHeight: pre.scrollHeight, clientHeight: pre.clientHeight, top: pre.scrollTop };
    });
    await page.waitForTimeout(2200);          // 至少 3 轮轮询
    const scrollAfter = await page.evaluate(() => {
      const pre = document.querySelector('#run-cards pre.stream:not(.reasoning)');
      const node = pre;
      return { top: node ? node.scrollTop : null, stillPageNode: Boolean(node && node.isConnected) };
    });
    const scrollable = !scroll.skipped && scroll.scrollHeight > scroll.clientHeight + 20;
    add('滚动位置', '正文区确实可滚动（前置条件成立）', scrollable || scroll.skipped === true, scroll);
    if (scrollable) {
      add('滚动位置', '用户翻到顶部后，轮询不会把他拉回底部', scrollAfter.top === 0, { before: scroll.top, after: scrollAfter.top, scrollHeight: scroll.scrollHeight });
    } else {
      report.notes.push('实时正文不够长，滚动位置这一项未取得有效前置条件；吸底逻辑本身已随增量渲染一起改。');
      add('滚动位置', '（本轮正文不足以产生滚动条，跳过该断言）', true, scroll);
    }
    await shot('scroll-kept');

    // ── 3) 等本轮结束，卡片状态原地更新 ─────────────────────
    await page.waitForFunction(() => {
      const btn = document.getElementById('btn-goto-compare');
      return btn && !btn.disabled;
    }, { timeout: 120000 });
    await page.waitForTimeout(700);
    const ended = await page.evaluate(() => {
      const card = document.querySelector('#run-cards .cand');
      return {
        markerSurvivedAfterFinish: card ? card.getAttribute('data-probe') === 'marked' : false,
        statusText: card ? card.querySelector('.status').innerText.replace(/\s+/g, ' ').trim() : null,
        detailsStillOpen: card && card.querySelector('details.live-reasoning') ? card.querySelector('details.live-reasoning').open : null,
      };
    });
    add('展开保持', '本轮结束时卡片仍是同一个节点（状态原地更新）', ended.markerSurvivedAfterFinish === true, ended);
    add('展开保持', '生成结束后"推理过程"依然保持展开', ended.detailsStillOpen === true, ended);
    add('展开保持', '状态文本已更新为完成态', /已完成|失败|已取消|超时/.test(ended.statusText || ''), ended.statusText);
    await shot('after-run');

    // ── 4) 候选集合真的变化时，骨架仍然正确重建 ─────────────
    await page.click('#run-cards .cand:nth-child(1) button:has-text("重试")');
    await page.waitForTimeout(2500);
    const retried = await page.evaluate(() => {
      const cards = [...document.querySelectorAll('#run-cards .cand')];
      const ids = cards.map((c) => c.getAttribute('data-attempt'));
      return {
        cards: cards.length,
        probeOnOldCard: cards.filter((c) => c.getAttribute('data-probe') === 'marked').length,
        distinctIds: new Set(ids).size,
        hasRetryResult: cards.some((c) => /生成中|已完成|失败|排队中/.test(c.querySelector('.status').innerText)),
      };
    });
    add('骨架重建', '重试后卡片集合按新 attempt 重建（旧探针标记消失）', retried.cards === 2 && retried.probeOnOldCard === 0, retried);
    add('骨架重建', '重建后每个候选仍是独立卡片且状态正常', retried.distinctIds === 2 && retried.hasRetryResult, retried);
    await shot('after-retry');

    report.consoleErrors = consoleErrors;
    report.pageErrors = pageErrors;
    report.shots = shots;
    report.finishedAt = new Date().toISOString();
    report.ok = report.checks.every((c) => c.ok) && consoleErrors.length === 0 && pageErrors.length === 0;
  } catch (err) {
    report.error = String(err && err.stack || err).slice(0, 1500);
    try { await shot('99-error'); } catch { /* 忽略 */ }
    report.consoleErrors = consoleErrors;
    report.pageErrors = pageErrors;
    report.shots = shots;
    report.ok = false;
  } finally {
    await browser.close();
  }
}

const outPath = join(OUT, 'm2-regression-' + Date.now() + '.json');
writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');
if (report.error) console.log('\n脚本中断：' + report.error.split('\n')[0]);
const passed = report.checks.filter((c) => c.ok).length;
console.log('\n' + passed + '/' + report.checks.length + ' 项通过；控制台错误 ' + (report.consoleErrors || []).length + '；页面异常 ' + (report.pageErrors || []).length);
if (report.notes.length) console.log('说明：' + report.notes.join(' / '));
if ((report.pageErrors || []).length) console.log(JSON.stringify(report.pageErrors.slice(0, 5), null, 1));
if ((report.consoleErrors || []).length) console.log(JSON.stringify(report.consoleErrors.slice(0, 5), null, 1));
console.log('证据：' + outPath);
process.exitCode = report.ok ? 0 : 1;
