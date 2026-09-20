/**
 * 演示录制脚本 —— 走一遍**首发演示路线**，并全程录屏。
 *
 * 首发演示选的是同一道有视觉与交互差异的题目，展示"输入 → 两个作品 → 匿名选择 →
 * 揭晓 → 导出"全过程（IMPLEMENTATION.md 第 5 节）。这个脚本把那条路线变成**可重放**的操作。
 *
 * ── 关于视频 ──────────────────────────────────────────────────────────────
 * 录制用 Playwright 内置的视频能力（它自带 ffmpeg）。**没有生成视频就是没有生成**：
 * 脚本会明确报告 `video: null` 且说明原因，不会假装录了。
 * 如果使用 `--no-video`，则只出分镜截图。
 *
 * ── 费用 ──────────────────────────────────────────────────────────────────
 * 默认用 `--base` 指到**模拟 provider** 的实例上（零费用）。
 * 要用真实模型时显式给 `--base http://127.0.0.1:8902`，并且你必须知道那会花钱。
 *
 * 用法：
 *   node scripts/m4-demo-record.mjs --base http://127.0.0.1:8910 --out ../交付区/v0.5.0/演示
 *   node scripts/m4-demo-record.mjs --base http://127.0.0.1:8902 --out ./docs/evidence/demo --real
 */
import { mkdirSync, existsSync, renameSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from '../src/preview/browser.js';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const getArg = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const BASE = getArg('--base', 'http://127.0.0.1:8910');
const OUT = join(here, '..', getArg('--out', 'docs/evidence/demo'));
const REAL = args.includes('--real');
const NO_VIDEO = args.includes('--no-video');
/** 真实模型时的两个候选（只在 --real 下用）。 */
const REAL_PAIR = [
  { provider: getArg('--a-provider', 'deepseek-official'), model: getArg('--a-model', 'deepseek-flash') },
  { provider: getArg('--b-provider', 'deepseek'), model: getArg('--b-model', 'deepseek-v4-pro') },
];
const SIM_PAIR = [
  { provider: 'sim-ok-a', model: 'sim-fast' },
  { provider: 'sim-ok-b', model: 'sim-fast' },
];

mkdirSync(OUT, { recursive: true });
const log = [];
const say = (line) => { log.push(line); console.log(line); };

if (REAL) {
  say('⚠ --real：这次会给**真实模型**发请求，会产生费用。候选：'
    + REAL_PAIR.map((c) => c.provider + '/' + c.model).join(' , '));
} else {
  say('模拟 provider（零费用）。要真实模型请加 --real 并确认预算。');
}

const b = await launchBrowser();
if (!b.ok) { console.log('无法启动浏览器：' + b.reason); process.exitCode = 1; }
else {
  const browser = b.browser;
  // 录屏需要固定的视口（视频尺寸跟着来），用 16:9 便于直接上传
  const ctx = await browser.newContext({
    viewport: { width: 1600, height: 900 },
    recordVideo: NO_VIDEO ? undefined : { dir: join(OUT, '.video-tmp'), size: { width: 1600, height: 900 } },
  });
  const page = await ctx.newPage();
  const shots = [];
  const step = async (name, note) => {
    const file = join(OUT, name + '.png');
    await page.screenshot({ path: file });
    shots.push({ name, note, file });
    say('  · 分镜 ' + name + ' —— ' + note);
  };

  try {
    // ── 分镜 0：落地页（让观众先看到"这是个插件入口"）
    await page.goto(BASE + '/html-arena/api/ui', { waitUntil: 'load', timeout: 40000 });
    await page.waitForSelector('#mode-badge', { timeout: 25000 });
    await page.waitForTimeout(2500);
    await step('01-落地页', '插件主界面：新建对比 / 试一个示例 / 导入复测包');

    // ── 分镜 1：填题（演示要让人看清"输入是一道题"）
    await page.click('.tab[data-view="new"]');
    await page.waitForSelector('#view-new:not([hidden])', { timeout: 20000 });
    await page.waitForTimeout(1200);
    await page.fill('#task-prompt', '做一个可以切换昼夜主题的天气仪表盘：显示当前温度、未来 5 天的折线趋势，'
      + '再放一个能拖动的时间滑块，拖动时数据和配色都跟着变。要求单文件、无外部依赖、用内置示例数据。');
    await page.fill('#task-title', '演示：天气仪表盘对比');
    await page.waitForTimeout(600);
    await step('02-填题', '同一道题，交给两个候选');

    // 选候选来源
    const picked = await page.evaluate((pair) => {
      const st = window.__htmlArena.state;
      while (st.candidates.length < 2) document.getElementById('btn-add-candidate').click();
      st.candidates.forEach((c, i) => {
        c.provider = pair[i % pair.length].provider;
        c.model = pair[i % pair.length].model;
        c.name = '候选 ' + String.fromCharCode(65 + i);
      });
      if (window.__htmlArena.renderCandidates) window.__htmlArena.renderCandidates();
      return st.candidates.map((c) => ({ name: c.name, provider: c.provider, model: c.model }));
    }, REAL ? REAL_PAIR : SIM_PAIR);
    say('  候选：' + picked.map((c) => c.name + '=' + c.provider + '/' + c.model).join(' , '));
    await page.waitForTimeout(2000);
    await step('03-两个候选', '两个候选各自独立选模型与参数');

    // ── 分镜 2：生成中（运行面板实时流是重点观感）
    await page.click('#btn-start');
    await page.waitForSelector('#view-run:not([hidden])', { timeout: 30000 });
    await page.waitForTimeout(1800);
    await step('04-生成中', '实时流：能看到两个候选同时在吐内容');

    await page.waitForFunction(() => {
      const st = window.__htmlArena.state;
      const a = st.current && st.current.attempts;
      return a && a.length >= 2 && a.every((x) => ['completed', 'failed', 'cancelled', 'timed_out'].includes(x.status));
    }, { timeout: REAL ? 600000 : 120000 });
    await page.waitForTimeout(1500);
    await step('05-生成完成', '两个候选各自完成；失败也会如实标注（本次：'
      + (await page.evaluate(() => window.__htmlArena.state.current.attempts.map((a) => a.status).join(' / '))) + '）');

    // ── 分镜 3：对比页（作品是主角）
    await page.click('#btn-goto-compare');
    await page.waitForSelector('#view-compare:not([hidden])', { timeout: 20000 });
    await page.waitForTimeout(5000);
    await step('06-并排对比', '同一逻辑视口下并排操作，用量与速度就在卡片上');

    // ── 分镜 4：匿名选择 → 揭晓
    await page.click('#btn-blind');
    await page.waitForTimeout(2000);
    await step('07-隐藏配置身份', '评分前隐藏模型与配方名');

    await page.evaluate(() => {
      const btn = [...document.querySelectorAll('#vote-row button')].find((x) => (x.textContent || '').includes('偏好 A'));
      if (btn) btn.click();
    });
    await page.waitForTimeout(2500);
    await step('08-记录偏好', '记下偏好；选择绑定具体作品 hash');

    await page.click('#btn-reveal');
    await page.waitForTimeout(2500);
    await step('09-揭晓', '揭晓：看到两个候选分别是谁（揭晓不可逆）');

    // ── 分镜 5：导出（分享给别人）
    await page.click('#btn-export');
    await page.waitForSelector('#export-modal:not([hidden])', { timeout: 15000 });
    await page.waitForTimeout(1800);
    await step('10-导出对话框', '先列清"包里有什么"，再决定下载');

    const expId = await page.evaluate(() => window.__htmlArena.state.current.experiment.id);
    await page.click('#btn-export-close');
    await page.waitForTimeout(600);

    // ── 分镜 6：历史（能找回来）
    await page.click('.tab[data-view="experiments"]');
    await page.waitForSelector('#view-experiments:not([hidden])', { timeout: 20000 });
    await page.waitForTimeout(2000);
    await step('11-历史列表', '跑过的对比都在历史里，可搜索、可筛选、可再导出');

    // ── 收尾：把视频从 Playwright 的临时名改成有意义的名字
    let video = null;
    if (!NO_VIDEO) {
      await page.close();
      const v = page.video();
      if (v) {
        const tmpPath = await v.path().catch(() => null);
        if (tmpPath && existsSync(tmpPath)) {
          const finalPath = join(OUT, 'html-arena-演示.webm');
          try { renameSync(tmpPath, finalPath); video = finalPath; } catch { video = tmpPath; }
          const size = statSync(video).size;
          say('  · 视频：' + video + '（' + Math.round(size / 1024) + ' KB，webm）');
          say('    转 mp4（可选，需要 ffmpeg）：ffmpeg -i "' + video + '" -c copy html-arena-演示.mp4');
        }
      }
    }

    writeFileSync(join(OUT, 'demo-record.json'), JSON.stringify({
      startedAt: new Date().toISOString(), base: BASE, real: REAL,
      experimentId: expId, candidates: picked, shots, video,
      note: REAL ? '真实模型调用，会产生费用' : '模拟 provider，零费用；作品是模拟结果',
    }, null, 2), 'utf8');

    say('');
    say('分镜：' + shots.length + ' 张 → ' + OUT);
    say('视频：' + (video ? video : (NO_VIDEO ? '（--no-video，本次没录）' : '未生成 —— 录屏失败，未假装成功')));
    say('清单：' + join(OUT, 'demo-record.json'));
    // 临时视频目录如果空了就删掉，别留空壳
    try {
      const leftover = readdirSync(join(OUT, '.video-tmp'));
      if (leftover.length === 0) { const { rmdirSync } = await import('node:fs'); rmdirSync(join(OUT, '.video-tmp')); }
    } catch { /* 目录不存在就算了 */ }
  } catch (err) {
    say('✗ 录制中断：' + String(err && err.message || err).slice(0, 300));
    try { await page.screenshot({ path: join(OUT, 'demo-failed.png') }); } catch { /* 忽略 */ }
    process.exitCode = 1;
  } finally {
    await ctx.close().catch(() => {});
    await browser.close();
  }
}
