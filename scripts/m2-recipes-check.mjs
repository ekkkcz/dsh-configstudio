/**
 * A03 的另一半：**历史配方不被覆盖** —— 从界面完整走一遍。
 *
 * 单测（tests/recipes.test.js）证明的是存储与接口的性质；这个脚本证明的是
 * "用户真的能在界面上做出这件事、也真的能看见历史版本还在"：
 *
 *   ① 候选卡上保存配方 → 配方页出现第 1 版；
 *   ② 改一处（只改系统提示词）再存 → 出现第 2 版，第 1 版被标成"历史，只读"且内容没变；
 *   ③ 用第 1 版开新一轮 → 对比页的"展开配置"里写明"配方来源：第 1 版"；
 *   ④ 之后再把配方改成第 3 版 → 那条历史实验的配置**一个字都没变**。
 *
 * 全程零费用：开发服务器 + 模拟模型。
 *
 * 用法：node scripts/m2-recipes-check.mjs
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchBrowser } from '../src/preview/browser.js';
import {
  EVIDENCE_DIR, sleep, freePort, api, startDevServer, waitHealthy, hardKill, makeChecker,
} from './lib/devhost.mjs';

const { add, report, finish } = makeChecker({
  what: 'A03：配方快照与版本 —— 每次修改追加新版本，历史配方不被覆盖（界面全流程）',
  note: '模拟模型，零费用',
});

const V1_PROMPT = '你是第 1 版的系统提示词：先想清楚布局再写代码。';
const V2_PROMPT = '你是第 2 版的系统提示词：改成移动优先。';

const dataDir = mkdtempSync(join(tmpdir(), 'arena-recipes-'));
const port = await freePort();
const base = 'http://127.0.0.1:' + port + '/html-arena/api';
const server = startDevServer({ port, dataDir, latencyMs: 100 });
let browserHandle = null;

try {
  await waitHealthy(base);
  add('准备', '开发服务器已就绪', true, { port });

  const b = await launchBrowser();
  if (!b.ok) throw new Error('无法启动浏览器：' + b.reason);
  browserHandle = b.browser;
  const page = await b.browser.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200)); });
  page.on('pageerror', (e) => pageErrors.push(String(e.message).slice(0, 200)));

  await page.goto('http://127.0.0.1:' + port + '/html-arena/api/ui', { waitUntil: 'load', timeout: 30000 });
  await page.waitForSelector('#mode-badge', { timeout: 20000 });
  await page.waitForTimeout(900);

  // ── ① 在候选卡上保存配方（第 1 版） ─────────────────────────────
  await page.click('.tab[data-view="new"]');
  await page.waitForTimeout(500);
  await page.fill('#task-title', 'M2 配方版本（模拟模型）');
  await page.fill('#task-prompt', '做一个用来验证配方版本化的页面');
  const candA = page.locator('#candidates .cand').first();
  // 系统提示词在折叠区里：先展开（这也是真实用户路径，不能靠脚本直接改 state）
  await candA.locator('details summary').first().click();
  await page.waitForTimeout(300);
  await candA.locator('details textarea').first().fill(V1_PROMPT);
  await page.waitForTimeout(200);
  await candA.getByRole('button', { name: '保存为配方' }).click();
  await page.waitForTimeout(900);

  await page.click('.tab[data-view="recipes"]');
  await page.waitForTimeout(900);
  const list1 = await page.$$eval('#recipe-list .exp', (els) => els.map((e) => e.innerText.replace(/\s+/g, ' ').slice(0, 160)));
  add('A03', '保存后配方页出现这个配方（第 1 版）',
    list1.length === 1 && /共 1 版/.test(list1[0]) && /当前第 1 版/.test(list1[0]), list1);
  await page.click('#recipe-list .exp:first-child details summary');
  await page.waitForTimeout(300);
  const v1Row = await page.innerText('#recipe-list [data-recipe-version="1"]');
  add('A03', '第 1 版里存的是刚才那份系统提示词，并带内容指纹',
    v1Row.includes(V1_PROMPT) && /指纹 [0-9a-f]{10}/.test(v1Row), v1Row.replace(/\s+/g, ' ').slice(0, 200));
  const recipeId = await page.$eval('#recipe-list .exp', (e) => e.getAttribute('data-recipe'));
  const v1HashBefore = (await api(base, '/recipes/' + recipeId)).body.recipe.versions.find((v) => v.version === 1).contentHash;

  // ── ② 改一处再存 → 追加第 2 版，第 1 版保持"历史，只读" ──────────
  await page.click('.tab[data-view="new"]');
  await page.waitForTimeout(400);
  // 保存配方会重画候选卡（显式动作触发，不是轮询），折叠区会回到收起状态 —— 再展开一次。
  // 记一笔：这是"重绘丢展开状态"的同类现象，只是这里由用户点击触发、代价很小。
  await candA.locator('details summary').first().click();
  await page.waitForTimeout(300);
  await candA.locator('details textarea').first().fill(V2_PROMPT);
  await page.waitForTimeout(200);
  await candA.getByRole('button', { name: /存为第 2 版/ }).click();
  await page.waitForTimeout(900);
  await page.click('.tab[data-view="recipes"]');
  await page.waitForTimeout(900);
  const list2 = await page.$$eval('#recipe-list .exp', (els) => els.map((e) => e.innerText.replace(/\s+/g, ' ').slice(0, 200)));
  add('A03', '再存一次后变成 2 版（不是覆盖第 1 版）',
    /共 2 版/.test(list2[0]) && /当前第 2 版/.test(list2[0]), list2);
  await page.click('#recipe-list .exp:first-child details summary');
  await page.waitForTimeout(300);
  const rows = await page.evaluate(() => {
    const out = {};
    document.querySelectorAll('#recipe-list [data-recipe-version]').forEach((el) => {
      out[el.getAttribute('data-recipe-version')] = el.innerText.replace(/\s+/g, ' ').trim();
    });
    return out;
  });
  add('A03', '第 1 版被标成"历史，只读"，内容仍是第 1 版那份提示词',
    /历史，只读/.test(rows['1'] || '') && (rows['1'] || '').includes(V1_PROMPT), rows['1']);
  add('A03', '第 2 版是改后的内容，并标成"当前"',
    /（当前）/.test(rows['2'] || '') && (rows['2'] || '').includes(V2_PROMPT), rows['2']);
  const after = await api(base, '/recipes/' + recipeId);
  const v1HashAfter = after.body.recipe.versions.find((v) => v.version === 1).contentHash;
  add('A03', '第 1 版的内容指纹没有变（覆盖会立刻改掉它）', v1HashBefore === v1HashAfter,
    { before: String(v1HashBefore).slice(0, 12), after: String(v1HashAfter).slice(0, 12) });
  add('A03', '两个版本各自有独立的指纹', after.body.recipe.versions[0].contentHash !== after.body.recipe.versions[1].contentHash);

  // ── ③ 用第 1 版开新一轮 ────────────────────────────────────────
  await page.click('#recipe-list [data-recipe-version="1"] button:has-text("用这一版新建对比")');
  await page.waitForTimeout(900);
  const linkNote = await page.innerText('#candidates .cand:first-child');
  add('A03', '候选卡上写明它来自哪个配方的哪一版',
    /来自配方/.test(linkNote) && /第 1 版/.test(linkNote), linkNote.replace(/\s+/g, ' ').slice(0, 160));
  await page.fill('#task-title', 'M2 配方第 1 版实验（模拟模型）');
  await page.fill('#task-prompt', '用第 1 版配方跑一次');
  await page.click('#btn-start');
  await page.waitForSelector('#btn-goto-compare:not([disabled])', { timeout: 40000 });
  await page.click('#btn-goto-compare');
  await page.waitForSelector('#view-compare .frame-wrap', { timeout: 25000 });
  await page.waitForTimeout(800);
  await page.click('#compare-config summary');
  await page.waitForTimeout(400);
  const details = await page.innerText('#compare-details');
  add('A03', '对比页写明这一轮引用的是配方第 1 版（可核对来源）',
    /配方来源/.test(details) && /第 1 版/.test(details), details.replace(/\s+/g, ' ').match(/配方来源[^。]{0,40}/));

  // ── ④ 再把配方改成第 3 版：历史实验一个字都不许变 ─────────────────
  const expId = await page.evaluate(() => window.__htmlArena.state.current.experiment.id);
  const snapshotBefore = await page.evaluate(() => {
    const a = window.__htmlArena.state.current.attempts[0];
    return { systemPrompt: a.recipe.systemPrompt, model: a.recipe.model, name: a.recipe.name, link: a.recipeLink };
  });
  const v3 = await api(base, '/recipes/' + recipeId + '/versions', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ snapshot: { ...after.body.recipe.versions[1].snapshot, reasoningEffort: 'high' }, note: '第 3 版：改档位' }),
  });
  add('准备', '把配方改成第 3 版', v3.status === 201 && v3.body.version === 3, v3.body.version);

  await page.click('.tab[data-view="experiments"]');
  await page.waitForTimeout(600);
  await page.fill('#search', 'M2 配方第 1 版实验');
  await page.waitForTimeout(900);
  await page.click('#experiment-list .exp:first-child button:has-text("打开")');
  await page.waitForSelector('#view-compare .frame-wrap', { timeout: 25000 });
  await page.waitForTimeout(800);
  const snapshotAfter = await page.evaluate(() => {
    const a = window.__htmlArena.state.current.attempts[0];
    return { systemPrompt: a.recipe.systemPrompt, model: a.recipe.model, name: a.recipe.name, link: a.recipeLink };
  });
  add('A03', '配方改成第 3 版之后，那条历史实验的配置**一个字都没变**',
    JSON.stringify(snapshotBefore) === JSON.stringify(snapshotAfter),
    { before: snapshotBefore, after: snapshotAfter });
  add('A03', '历史实验仍然指向第 1 版（不会静默升级到最新版）',
    snapshotAfter.link && snapshotAfter.link.recipeVersion === 1, snapshotAfter.link);
  const finalRecipe = await api(base, '/recipes/' + recipeId);
  add('A03', '配方现在有 3 版，第 1 版内容与指纹依旧没变',
    finalRecipe.body.recipe.versions.length === 3
      && finalRecipe.body.recipe.versions.find((v) => v.version === 1).contentHash === v1HashBefore
      && finalRecipe.body.recipe.versions.find((v) => v.version === 1).snapshot.systemPrompt === V1_PROMPT,
    { versions: finalRecipe.body.recipe.versions.map((v) => v.version) });

  const shotFile = join(EVIDENCE_DIR, 'm2-recipes-versions.png');
  await page.click('.tab[data-view="recipes"]');
  await page.waitForTimeout(800);
  await page.click('#recipe-list .exp:first-child details summary');
  await page.waitForTimeout(400);
  writeFileSync(shotFile, await page.screenshot({ type: 'png' }));
  report.screenshot = 'docs/evidence/m2-recipes-versions.png';

  add('A03', '界面全程 0 控制台错误、0 页面异常',
    consoleErrors.length === 0 && pageErrors.length === 0, { consoleErrors: consoleErrors.slice(0, 3), pageErrors: pageErrors.slice(0, 3) });
  report.recipeId = recipeId;
  report.experimentId = expId;

  await b.browser.close();
  browserHandle = null;
} catch (err) {
  add('执行', '脚本运行没有抛异常', false, String(err && err.stack || err));
} finally {
  try { if (browserHandle) await browserHandle.close(); } catch { /* 已关 */ }
  try { await hardKill(server, '开发服务器（收尾）'); } catch { /* 已经没了 */ }
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }
}

process.exit(finish('m2-recipes'));
