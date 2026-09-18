/**
 * 交付截图（v0.3.1 / 第三轮反馈）—— 从真实 DSH 实例抓代表图，零费用。
 * 只打开已有实验与设置页，**不发起任何模型调用**。
 *
 * 用法：
 *   node scripts/delivery-shots.mjs --base http://127.0.0.1:8902 --out "../交付区/v0.3.1/截图"
 *   （可选 --title 指定要用哪条真实实验；默认 "写个秦始皇骑北极熊"）
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from '../src/preview/browser.js';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const getArg = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
// 默认端口从 8901 改成 8902：8901 已被本机无关程序（本机另一个与本插件无关的程序）占用，
// 不带 --base 跑到别的服务上会得到莫名其妙的失败（2026-09-18 实测）。
const BASE = getArg('--base', 'http://127.0.0.1:8902');
const TITLE = getArg('--title', '写个秦始皇骑北极熊');
// 盲选那张图必须用一条**还没揭晓**的实验（揭晓不可逆）。
// 用户那条真实实验早就在手工试玩时揭晓了，所以单独指定一条。
const BLIND_TITLE = getArg('--blind-title', 'M2 实时监控验证');
// 那张"上游原始错误"的图要用一条**真的失败过**的实验（候选 B 上游 404）
const FAIL_TITLE = getArg('--fail-title', 'M1 真实对比');
const OUT = join(here, '..', getArg('--out', 'docs/evidence'));
mkdirSync(OUT, { recursive: true });

const b = await launchBrowser();
if (!b.ok) { console.log('无法启动浏览器：' + b.reason); process.exitCode = 1; }
else {
  const browser = b.browser;
  const saved = [];
  const skipped = [];
  const orig = await (await fetch(BASE + '/html-arena/api/settings')).json();

  /** 每种读法/尺寸单独开一个上下文，互不影响。 */
  const withPage = async (viewport, fn) => {
    const ctx = await browser.newContext({ viewport });
    const page = await ctx.newPage();
    const shot = async (n) => { writeFileSync(join(OUT, n + '.png'), await page.screenshot({ type: 'png' })); console.log('  ✓ ' + n); saved.push(n); };
    try {
      await page.goto(BASE + '/html-arena/api/ui', { waitUntil: 'load', timeout: 30000 });
      await page.waitForSelector('#mode-badge', { timeout: 20000 });
      await page.waitForTimeout(1400);
      await fn(page, shot);
    } finally { await ctx.close(); }
  };

  /**
   * 打开一条实验。rowIndex 用于"同名多条"的情况：
   * 盲选那张图必须找一条**还没揭晓**的，而列表里同名实验很多（第一条可能早就揭晓了）。
   */
  const openExperiment = async (page, title, rowIndex = 0) => {
    if (title) { await page.fill('#search', title); await page.waitForTimeout(1400); }
    const rows = page.locator('#experiment-list .exp');
    const count = await rows.count();
    if (count === 0) throw new Error('列表里没有匹配「' + title + '」的实验');
    const idx = Math.min(rowIndex, count - 1);
    await rows.nth(idx).locator('button:has-text("打开")').click();
    await page.waitForSelector('#view-compare:not([hidden])', { timeout: 20000 });
    await page.waitForTimeout(2800);
  };

  try {
    // ── 1) 设置页：外部能力的"探测到 / 已启用" ──────────────
    await withPage({ width: 1600, height: 1000 }, async (page, shot) => {
      await page.click('.tab[data-view="settings"]');
      await page.waitForSelector('#view-settings:not([hidden])', { timeout: 15000 });
      await page.waitForTimeout(900);
      await shot('01-设置-外部能力开关');
    });

    // ── 2) 对比页（宽屏）：用量摘要就在卡片上 ────────────────
    await withPage({ width: 1600, height: 1060 }, async (page, shot) => {
      await openExperiment(page, TITLE);
      await shot('02-对比页-用量与速度在卡片上');
      // 展开配置也来一张（反馈 4 的既有能力，本轮在里面补了盲选脱敏）
      await page.evaluate(() => { document.getElementById('compare-config').open = true; });
      await page.waitForTimeout(600);
      await page.evaluate(() => {
        const d = document.querySelector('#compare-details details.cfg-long');
        if (d) d.open = true;
        const box = document.getElementById('compare-config');
        window.scrollTo(0, Math.max(0, box.getBoundingClientRect().top + window.scrollY - 70));
      });
      await page.waitForTimeout(700);
      await shot('03-对比页-展开配置');
    });

    // ── 3) 窄视口（模拟用户那块 DPR 2.25 的屏）：仍然左右并排 ──
    await withPage({ width: 880, height: 1000 }, async (page, shot) => {
      await openExperiment(page, TITLE);
      await shot('04-窄视口880-仍然左右并排');
      // 手机视口"右边一堆空白"是用户第四轮报的缺陷，必须有图留证
      await page.click('.seg-btn[data-vp="mobile"]');
      await page.waitForTimeout(1200);
      const mobileFill = await page.evaluate(() => [...document.querySelectorAll('.frame-wrap')].filter((e) => !e.hidden).map((w) => {
        const sc = w.querySelector('.scaler');
        const ifr = w.querySelector('iframe');
        return Math.round(sc.clientWidth - parseFloat(ifr.style.width) * Number(sc.getAttribute('data-scale')));
      }));
      if (mobileFill.some((b) => Math.abs(b) > 2)) {
        throw new Error('手机视口下作品没有撑满卡片（右侧空白 ' + JSON.stringify(mobileFill) + 'px），拒绝出图');
      }
      await shot('04b-手机视口-已撑满不留空白');
      await page.click('.seg-btn[data-vp="desktop"]');
      await page.waitForTimeout(900);
      // 1:1 横向展开 + 同步滚动
      await page.click('.seg-btn[data-mode="wide"]');
      await page.waitForTimeout(800);
      await page.evaluate(() => {
        const sc = [...document.querySelectorAll('.frame-wrap .scaler')];
        if (sc[0]) { sc[0].scrollLeft = Math.round((sc[0].scrollWidth - sc[0].clientWidth) * 0.45); sc[0].dispatchEvent(new Event('scroll', { bubbles: true })); }
      });
      await page.waitForTimeout(700);
      await shot('05-窄视口880-1比1横向展开与同步滚动');
    });

    // ── 4) 盲选：用量摘要与配置面板一起脱敏 ──────────────────
    // 揭晓不可逆：已揭晓的实验上隐藏开关已被移除，这时**不能**拍一张假装脱敏的图
    //（第一版就是这么拍出一张"标题写着已脱敏、其实全是明文"的交付截图）。
    await withPage({ width: 1600, height: 1060 }, async (page, shot) => {
      // 同名实验可能有好几条：挨个试，直到找到一条**还没揭晓**的。
      // 揭晓不可逆，所以"换一条"是唯一正确的做法，不能拿已揭晓的凑一张假脱敏图。
      let st = null;
      for (let i = 0; i < 8; i += 1) {
        // 打开实验会跳到对比页，搜索框在列表页上 —— 每轮先回列表
        if (i > 0) { await page.click('.tab[data-view="experiments"]'); await page.waitForTimeout(700); }
        await openExperiment(page, BLIND_TITLE, i);
        st = await page.evaluate(() => ({
          revealed: window.__htmlArena.state.revealed,
          blindBtnVisible: document.getElementById('btn-blind').hidden === false,
          title: window.__htmlArena.state.current.experiment.title,
        }));
        if (st.revealed === false && st.blindBtnVisible) { st.rowIndex = i; break; }
        console.log('  · 第 ' + (i + 1) + ' 条「' + BLIND_TITLE + '」已揭晓，换下一条');
      }
      if (!st || st.revealed === true || !st.blindBtnVisible) {
        console.log('  · 「' + BLIND_TITLE + '」已揭晓，跳过盲选截图（揭晓不可逆）。'
          + '换一条未揭晓的实验：--blind-title "<标题>"；盲选脱敏的机器证据见 docs/evidence/m2-usage-metrics-*.json');
        skipped.push('06-对比页-盲选时用量与配置都脱敏（「' + BLIND_TITLE + '」已揭晓，跳过）');
        return;
      }
      const blind = await page.evaluate(() => window.__htmlArena.state.blind);
      if (blind !== true) { await page.click('#btn-blind'); await page.waitForTimeout(900); }
      const check = await page.evaluate(() => ({
        blind: window.__htmlArena.state.blind,
        strips: [...document.querySelectorAll('.usage-strip')].map((e) => e.getAttribute('data-blind')),
      }));
      if (check.blind !== true || !check.strips.every((v) => v === '1')) {
        throw new Error('盲选状态没生效，拒绝拍一张"看起来脱敏其实没有"的交付截图：' + JSON.stringify(check));
      }
      await shot('06-对比页-盲选时用量与配置都脱敏');
    });

    // ── 5) M2：配方版本历史（历史版本不被覆盖） ────────────────
    //
    // 拍之前先**造**出这条证据（零费用：配方只是把已有 attempt 的配置存下来，不发起调用），
    // 并在出图前核对"第 1 版仍在、内容没被改写"——不合格就抛错拒绝出图。
    await withPage({ width: 1600, height: 1060 }, async (page, shot) => {
      const listRes = await fetch(BASE + '/html-arena/api/experiments?search=' + encodeURIComponent(TITLE));
      const list = await listRes.json();
      const expId = list.experiments && list.experiments[0] ? list.experiments[0].id : null;
      if (!expId) throw new Error('找不到用于截图的实验：' + TITLE);
      const detail = await (await fetch(BASE + '/html-arena/api/experiments/' + expId)).json();
      const attempt = (detail.attempts || [])[0];
      if (!attempt) throw new Error('这条实验没有 attempt，无法保存配方');
      const created = await (await fetch(BASE + '/html-arena/api/recipes', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'M2 交付截图配方', fromAttemptId: attempt.id, note: '交付截图用（从真实实验的配置保存）' }),
      })).json();
      const recipeId = created.recipe.id;
      const v1 = created.recipe.versions[0];
      await fetch(BASE + '/html-arena/api/recipes/' + recipeId + '/versions', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ snapshot: { ...v1.snapshot, temperature: 0.9 }, note: '第 2 版：只改了温度' }),
      });
      const after = await (await fetch(BASE + '/html-arena/api/recipes/' + recipeId)).json();
      const v1After = after.recipe.versions.find((v) => v.version === 1);
      if (after.recipe.versions.length !== 2 || v1After.contentHash !== v1.contentHash) {
        throw new Error('配方版本不符合预期（要么没追加、要么第 1 版被改写），拒绝出图：'
          + JSON.stringify({ versions: after.recipe.versions.map((v) => v.version), same: v1After.contentHash === v1.contentHash }));
      }

      await page.click('.tab[data-view="recipes"]');
      await page.waitForSelector('#view-recipes:not([hidden])', { timeout: 15000 });
      await page.waitForTimeout(1200);
      const shown = await page.evaluate((id) => {
        const card = document.querySelector('#recipe-list .exp[data-recipe="' + id + '"]');
        if (!card) return null;
        const det = card.querySelector('details');
        if (det) det.open = true;
        const rows = [...card.querySelectorAll('[data-recipe-version]')].map((e) => e.innerText.replace(/\s+/g, ' ').trim());
        return { rows };
      }, recipeId);
      if (!shown || shown.rows.length !== 2 || !/历史，只读/.test(shown.rows[1]) || !/（当前）/.test(shown.rows[0])) {
        throw new Error('配方页没有正确显示"当前 + 历史只读"两版，拒绝出图：' + JSON.stringify(shown));
      }
      await page.evaluate((id) => {
        const card = document.querySelector('#recipe-list .exp[data-recipe="' + id + '"]');
        window.scrollTo(0, Math.max(0, card.getBoundingClientRect().top + window.scrollY - 80));
      }, recipeId);
      await page.waitForTimeout(600);
      await shot('07-配方-第1版历史只读与第2版当前');
    });

    // ── 6) M2：对比页的"本轮状态 / 收尾原因 / 上游原始错误" ─────
    // 用一条**真实失败**的实验（M1 真实对比：候选 B 上游 404），证明未识别的错误码
    // 也会把上游原文带出来，而不是只说"未识别"。
    await withPage({ width: 1600, height: 1060 }, async (page, shot) => {
      await openExperiment(page, FAIL_TITLE);
      const info = await page.evaluate(() => {
        const box = document.getElementById('compare-config');
        box.open = true;
        const txt = document.getElementById('compare-details').innerText;
        return {
          hasStatus: /本轮状态/.test(txt),
          hasReason: /收尾原因/.test(txt),
          hasRaw: /PI_AI_ERROR/.test(txt) && /does not exist|404/.test(txt),
        };
      });
      if (!info.hasStatus || !info.hasReason || !info.hasRaw) {
        console.log('  · 「' + FAIL_TITLE + '」里没有找到失败候选（'
          + JSON.stringify(info) + '），跳过这张图；A07 的机器证据见 docs/evidence/m1-smoke.json');
        skipped.push('08-对比页-本轮状态与上游原始错误（这条实验没有可展示的失败候选）');
        return;
      }
      await page.evaluate(() => {
        const box = document.getElementById('compare-config');
        window.scrollTo(0, Math.max(0, box.getBoundingClientRect().top + window.scrollY - 70));
      });
      await page.waitForTimeout(700);
      await shot('08-对比页-本轮状态与上游原始错误');
    });

    console.log(JSON.stringify({ out: OUT, saved, skipped }, null, 1));
  } catch (err) {
    console.log('中断：' + String(err && err.message || err).slice(0, 400));
    process.exitCode = 1;
  } finally {
    try {
      await fetch(BASE + '/html-arena/api/settings', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ capabilities: Object.fromEntries(orig.capabilities.map((c) => [c.key, c.enabled])) }),
      });
    } catch { /* 忽略 */ }
    await browser.close();
  }
}
