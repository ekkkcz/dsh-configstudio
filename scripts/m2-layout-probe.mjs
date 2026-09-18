/**
 * 对比页布局与数据探针 —— **零费用**，只读。
 *
 * 用途（第三轮反馈的复现工具）：
 *   1. 用户反馈"要能水平展开比对"，但截图里是上下堆叠、而我在 1983px 下量到的是并排。
 *      先量清楚**在什么宽度下会堆叠**，再决定怎么改 —— 不要靠猜。
 *   2. 顺带把"最终页面要显示的 token / 速度"数据来源也打出来，
 *      确认服务端到底给了哪些字段、能不能算出速度。
 *
 * 用法：
 *   node scripts/m2-layout-probe.mjs --base http://127.0.0.1:8902 --title "写个秦始皇骑北极熊"
 *   node scripts/m2-layout-probe.mjs --base http://127.0.0.1:8902 --title "..." --width 880
 */
import { launchBrowser } from '../src/preview/browser.js';

const args = process.argv.slice(2);
const getArg = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const BASE = getArg('--base', 'http://127.0.0.1:8902');
const TITLE = getArg('--title', '');
const ONE_WIDTH = getArg('--width', null);

const b = await launchBrowser();
if (!b.ok) { console.log('无法启动浏览器：' + b.reason); process.exitCode = 1; }
else {
  const browser = b.browser;
  const ctx = await browser.newContext({ viewport: { width: 1983, height: 1156 } });
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200)); });

  try {
    await page.goto(BASE + '/html-arena/api/ui', { waitUntil: 'load', timeout: 30000 });
    await page.waitForSelector('#mode-badge', { timeout: 20000 });
    await page.waitForTimeout(1500);
    if (TITLE) {
      await page.fill('#search', TITLE);
      await page.waitForTimeout(1400);
    }
    const rows = await page.$$eval('#experiment-list .exp', (els) => els.map((e) => e.innerText.replace(/\s+/g, ' ').trim().slice(0, 90)));
    if (rows.length === 0) {
      console.log(JSON.stringify({ error: '按标题没找到实验', title: TITLE, base: BASE }, null, 1));
      await browser.close();
    } else {
      await page.click('#experiment-list .exp:first-child button:has-text("打开")');
      await page.waitForSelector('#view-compare:not([hidden])', { timeout: 20000 });
      await page.waitForTimeout(3000);

      // ── 布局 ────────────────────────────────────────────────
      const measure = async () => page.evaluate(() => {
        const grid = document.getElementById('compare-grid');
        const wraps = [...document.querySelectorAll('.frame-wrap')].map((e) => {
          const r = e.getBoundingClientRect();
          return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
        });
        return {
          cssWidth: window.innerWidth,
          dpr: window.devicePixelRatio,
          zoom: Math.round((window.outerWidth / window.innerWidth) * 100) / 100,
          gridClass: grid.className,
          gridCols: getComputedStyle(grid).gridTemplateColumns,
          cardCount: wraps.length,
          stacked: wraps.length > 1 ? wraps[0].y !== wraps[1].y : null,
          cards: wraps.map((w) => 'w' + w.w + '@' + w.x + ',' + w.y),
          logicalIframe: [...document.querySelectorAll('.frame-wrap iframe')].map((e) => e.style.width),
          scalerHeight: [...document.querySelectorAll('.scaler')].map((e) => e.style.height),
          under900: window.matchMedia('(max-width: 900px)').matches,
          under1100: window.matchMedia('(max-width: 1100px)').matches,
        };
      });

      console.log('=== 当前窗口 ===');
      console.log(JSON.stringify(await measure(), null, 1));

      if (!ONE_WIDTH) {
        console.log('=== 扫描宽度（找堆叠断点）===');
        for (const w of [1983, 1600, 1400, 1200, 1100, 1000, 950, 900, 880, 700]) {
          await page.setViewportSize({ width: w, height: 1000 });
          await page.waitForTimeout(450);
          const m = await measure();
          console.log('  ' + String(m.cssWidth).padStart(5) + 'px -> ' + (m.stacked ? '上下堆叠' : '左右并排') +
            '  cols=' + m.gridCols + '  卡片=' + JSON.stringify(m.cards));
        }
        await page.setViewportSize({ width: 1983, height: 1156 });
        await page.waitForTimeout(400);
      }

      // ── 数据（token / 速度）────────────────────────────────
      console.log('=== 每个候选可用的 token / 耗时数据 ===');
      const data = await page.evaluate(() => {
        const st = window.__htmlArena.state;
        const rows = st.current.attempts.map((a) => {
          const r = a.receipt || {};
          const u = r.usage || {};
          const totalMs = (r.startedAt && r.finishedAt) ? r.finishedAt - r.startedAt : null;
          const ttftMs = (r.startedAt && r.firstTextAt) ? r.firstTextAt - r.startedAt : null;
          const genMs = (r.firstTextAt && r.finishedAt) ? r.finishedAt - r.firstTextAt : null;
          // ★ 界面上用的口径（唯一正确的那个）：
          //     totalSpeed = outputTokens / (finishedAt - startedAt) —— 整个调用的墙上时间。
          //   **不要**用 outputTokens / (finishedAt - firstTextAt)（下面的 wrongSpeed）：
          //   推理型模型先吐完 reasoning token 才出正文，实测能虚高到 3703 tok/s。
          //   这里把它原样打出来，就是为了让这个错误口径一眼可见、不要再被抄进界面。
          const totalSpeed = (u.outputTokens && totalMs) ? Math.round((u.outputTokens / (totalMs / 1000)) * 10) / 10 : null;
          const wrongSpeed = (u.outputTokens && genMs) ? Math.round((u.outputTokens / (genMs / 1000)) * 10) / 10 : null;
          return {
            slot: a.slot, attemptNo: a.attemptNo, status: a.status,
            inputTokens: u.inputTokens ?? null, outputTokens: u.outputTokens ?? null,
            totalTokens: u.totalTokens ?? null, reasoningTokens: u.reasoningTokens ?? null,
            cacheReadTokens: u.cacheReadTokens ?? null,
            totalMs, ttftMs, genMs,
            totalSpeed,                                  // ← 界面显示的口径
            wrongSpeed_DO_NOT_USE: wrongSpeed,           // ← 首正文之后的时间当分母：失真
            hasHtml: Boolean(a.canPreview),
          };
        });
        return { experiment: st.current.experiment.title, attempts: rows, view: st.view };
      });
      console.log(JSON.stringify(data, null, 1));

      console.log('=== 结论提示 ===');
      console.log('· 数据是否够算速度：' + (data.attempts.every((a) => a.totalSpeed !== null) ? '够（outputTokens / 开始到结束）' : '部分缺失，界面上要如实写"未上报"'));
      console.log('· 界面口径 = totalSpeed；wrongSpeed_DO_NOT_USE 是失真值，只用于对照，不要抄进界面');
      console.log('· 用量摘要已放到每个作品卡头部下方（第三轮反馈 2），不再只藏在折叠的「展开配置」里');
      console.log('· 布局：列数由 renderCompare() 写死为"1 个候选 1 列、2–4 个候选始终每行 2 列"，');
      console.log('  窄视口不再退化成单列（第三轮反馈 1）；上面的扫描里应该看不到"上下堆叠"');
    }
  } catch (err) {
    console.log('中断：' + String(err && err.message || err).slice(0, 300));
    process.exitCode = 1;
  } finally {
    console.log('控制台错误：' + consoleErrors.length);
    await browser.close();
  }
}
