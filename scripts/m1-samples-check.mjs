/**
 * A13 实测脚本 —— 六类固定样例作品逐一加载，确认真实渲染且可交互。
 *
 * 它走的是产品真正的预览通路：独立源的预览服务 + iframe sandbox + 响应头 CSP，
 * 浏览器是真实的 Chromium。样例是**固定测试样本**，不是模型输出，也不产生模型费用。
 *
 * 用法：node scripts/m1-samples-check.mjs
 * 产物：docs/evidence/m1-samples-<时间戳>.json 与 docs/evidence/sample-<key>.png
 */
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SAMPLES, SAMPLE_CATALOG } from './samples.mjs';
import { createPreviewServer } from '../src/preview/server.js';
import { sandboxAttribute } from '../src/preview/policy.js';
import { launchBrowser } from '../src/preview/browser.js';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, '..', 'docs', 'evidence');
mkdirSync(OUT, { recursive: true });

/** 预览服务只接受 att_ + 20 位十六进制的 ID（防路径穿越）。给每个样例一个固定 ID。 */
const idOf = (key) => 'att_' + Buffer.from('sample:' + key).toString('hex').padEnd(20, '0').slice(0, 20);

const byId = new Map(SAMPLE_CATALOG.map((s) => [idOf(s.key), SAMPLES[s.key]]));

const preview = createPreviewServer({ getHtml: (id) => byId.get(id) ?? null });
const paddr = await preview.listen();

// 宿主页：作品必须被 http://127.0.0.1:* 的页面用 sandbox iframe 嵌入（frame-ancestors 策略）。
const host = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const key = url.searchParams.get('k') ?? '';
  const src = paddr.origin + '/preview/' + idOf(key) + '?token=t-' + key + '&network=offline';
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end('<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>样例宿主</title>'
    + '<style>html,body{margin:0;height:100%}iframe{width:100%;height:100vh;border:0;display:block}</style></head><body>'
    + '<iframe id="f" sandbox="' + sandboxAttribute() + '" src="' + src + '"></iframe></body></html>');
});
await new Promise((r) => host.listen(0, '127.0.0.1', r));
const hostOrigin = 'http://127.0.0.1:' + host.address().port;

const report = {
  startedAt: new Date().toISOString(),
  previewOrigin: paddr.origin, hostOrigin, sandbox: sandboxAttribute(),
  note: '六类固定样例（非模型输出）；走真实预览隔离通路与真实 Chromium',
  samples: [],
};

const b = await launchBrowser();
if (!b.ok) {
  console.log(JSON.stringify({ error: '无法启动浏览器：' + b.reason, attempts: b.attempts }, null, 2));
  process.exit(1);
}
const browser = b.browser;
const context = await browser.newContext({ viewport: { width: 1024, height: 720 } });
const page = await context.newPage();
const consoleErrors = [];
const pageErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push({ sample: current, text: m.text().slice(0, 300) }); });
page.on('pageerror', (e) => pageErrors.push({ sample: current, text: String(e.message).slice(0, 300) }));

let current = '';
/** 每个样例的检查项：每项是 {name, ok, detail}。 */
async function runSample(s) {
  current = s.key;
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail: detail === undefined ? null : detail });
  await page.goto(hostOrigin + '/?k=' + s.key, { waitUntil: 'load', timeout: 20000 });
  await page.waitForTimeout(700);
  const frame = page.frames().find((f) => f !== page.mainFrame());
  add('iframe 建立', Boolean(frame), frame ? frame.url().slice(0, 80) : null);
  if (!frame) return { key: s.key, label: s.label, ok: false, checks };

  const title = await frame.title().catch(() => null);
  add('子文档标题可读', Boolean(title), title);

  if (s.key === 'landing') {
    const before = await frame.evaluate(() => getComputedStyle(document.body).backgroundColor);
    await frame.click('#go');
    await page.waitForTimeout(300);
    const after = await frame.evaluate(() => getComputedStyle(document.body).backgroundColor);
    add('渲染：落地页元素', await frame.evaluate(() => Boolean(document.querySelector('header h1') && document.querySelector('.grid .card'))));
    add('交互：点按钮切换主题', before !== after, before + ' → ' + after);
  } else if (s.key === 'dashboard') {
    const t0 = await frame.textContent('#temp');
    await frame.selectOption('#city', 'shanghai');
    await page.waitForTimeout(300);
    const t1 = await frame.textContent('#temp');
    add('渲染：温度与曲线', Boolean(t0) && (await frame.evaluate(() => document.querySelector('#chart polyline') !== null)), t0);
    add('交互：切换城市更新数据', t0 !== t1, t0 + ' → ' + t1);
    await frame.click('#theme');
    await page.waitForTimeout(250);
    add('交互：切换昼夜', await frame.evaluate(() => document.body.classList.contains('day')));
  } else if (s.key === 'animation') {
    const n = await frame.textContent('#n');
    add('渲染：canvas 存在', await frame.evaluate(() => Boolean(document.getElementById('c'))));
    add('渲染：粒子已初始化', n === '220', '粒子=' + n);
    const ink = await frame.evaluate(() => {
      const c = document.getElementById('c');
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let sum = 0;
      for (let i = 0; i < d.length; i += 4 * 97) sum += d[i] + d[i + 1] + d[i + 2];
      return sum;
    });
    add('渲染：画布确有像素', ink > 0, '像素和=' + ink);
    await page.waitForTimeout(1300);
    const fps = await frame.textContent('#f');
    add('动画：帧率计数器在工作', Number(fps) > 0, 'FPS=' + fps);
    await frame.click('#reset');
    await page.waitForTimeout(300);
    add('交互：重置按钮可用', (await frame.textContent('#n')) === '220');
  } else if (s.key === 'dataviz') {
    const stats = await frame.evaluate(() => ({
      rects: document.querySelectorAll('#s rect.bar').length,
      texts: document.querySelectorAll('#s text').length,
      legend: Boolean(document.querySelector('.legend')),
    }));
    add('渲染：柱状图已绘制', stats.rects === 6 && stats.texts >= 6, JSON.stringify(stats));
    add('渲染：图例存在', stats.legend);
    const hover = await frame.evaluate(() => {
      const bar = document.querySelector('#s rect.bar');
      const before = getComputedStyle(bar).fill;
      bar.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      return { before, hasTitle: Boolean(bar.querySelector('title')) };
    });
    add('交互：柱子带悬停提示', hover.hasTitle, JSON.stringify(hover));
  } else if (s.key === 'prototype') {
    const t0 = await frame.textContent('#title');
    await frame.click('#view button');
    await page.waitForTimeout(250);
    const t1 = await frame.textContent('#title');
    add('渲染：原型首屏', t0 === '选择方案', t0);
    add('交互：第一步可前进', t1 === '确认信息', t0 + ' → ' + t1);
    await frame.click('#view button:last-child');
    await page.waitForTimeout(250);
    const t2 = await frame.textContent('#title');
    add('交互：可返回上一步', t2 === '选择方案', t1 + ' → ' + t2);
  } else if (s.key === 'game') {
    add('渲染：画布存在', await frame.evaluate(() => Boolean(document.getElementById('c'))));
    const ink = await frame.evaluate(() => {
      const c = document.getElementById('c');
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let sum = 0;
      for (let i = 0; i < d.length; i += 4 * 97) sum += d[i] + d[i + 1] + d[i + 2];
      return sum;
    });
    add('渲染：画布确有像素', ink > 0, '像素和=' + ink);
    const a = await frame.evaluate(() => document.getElementById('c').toDataURL().length);
    await page.waitForTimeout(400);
    const b2 = await frame.evaluate(() => document.getElementById('c').toDataURL());
    add('动画：球在移动（画面变化）', b2.length !== a, '长度 ' + a + ' → ' + b2.length);
    await frame.click('#r');
    await page.waitForTimeout(200);
    const hud = await frame.evaluate(() => ({ s: document.getElementById('s').textContent, l: document.getElementById('l').textContent }));
    add('交互：重新开始按钮', hud.s === '0' && hud.l === '3', JSON.stringify(hud));
  }

  writeFileSync(join(OUT, 'sample-' + s.key + '.png'), await page.screenshot({ type: 'png' }));
  const ok = checks.every((c) => c.ok);
  return { key: s.key, label: s.label, ok, title, checks };
}

for (const s of SAMPLE_CATALOG) {
  const r = await runSample(s);
  report.samples.push(r);
  console.log((r.ok ? 'PASS' : 'FAIL') + '  ' + r.label + ' (' + r.key + ')  ' + r.checks.map((c) => (c.ok ? '✓' : '✗') + c.name).join(' '));
  for (const c of r.checks) if (!c.ok) console.log('        ✗ ' + c.name + '  ' + (c.detail ?? ''));
}

await browser.close();
await preview.close();
await new Promise((r) => host.close(r));

report.consoleErrors = consoleErrors;
report.pageErrors = pageErrors;
report.passed = report.samples.filter((s) => s.ok).length;
report.total = report.samples.length;
report.ok = report.passed === report.total && consoleErrors.length === 0 && pageErrors.length === 0;
report.finishedAt = new Date().toISOString();
const outPath = join(OUT, 'm1-samples-' + Date.now() + '.json');
writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');
console.log('\n' + report.passed + '/' + report.total + ' 类样例通过；控制台错误 ' + consoleErrors.length + '；页面异常 ' + pageErrors.length);
console.log('证据：' + outPath);
process.exitCode = report.ok ? 0 : 1;
