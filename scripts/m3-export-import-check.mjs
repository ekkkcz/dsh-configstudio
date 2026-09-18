/**
 * M3 主验收：展示包与复测包的导出 / 导入往返（A24 / A25 / A26 / A27 + F20 / F21 / F22）。
 *
 * 做法：起**两个干净的数据目录**（A 与 B，各自一个开发服务器子进程，模拟模型零费用），
 * 用真实 Chromium 走界面完成"导出 → 另一个安装导入"的全过程，然后逐条核对：
 *
 *  ① A24：展示包解压到**另一个目录**后用 file:// 打开，报告可读、作品在受限沙箱里真的渲染出来；
 *  ② A25：题目 hash 与每个候选的配方 hash 在往返之后逐个一致，且导入方**没有发起任何调用**；
 *  ③ A26：路径穿越包 / 压缩炸弹 / 超大上传都被拒绝，且没有在插件目录外留下文件；
 *  ④ A27：两个包的所有条目里都没有绝对路径、密钥、推理全文或完整输入文本。
 *
 * 用法：node scripts/m3-export-import-check.mjs
 */
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { createServer as createHttpServer } from 'node:http';
import { launchBrowser } from '../src/preview/browser.js';
import { readZip, writeZip, crc32 } from '../src/core/zip.js';
import { recipeHash } from '../src/core/recipe.js';
import { buildRetestPack } from '../src/core/pack.js';
import {
  EVIDENCE_DIR, sleep, freePort, api, startDevServer, waitHealthy, hardKill, makeChecker, logLines,
} from './lib/devhost.mjs';

const { add, report, finish } = makeChecker({
  what: 'M3：展示包 / 复测包导出导入往返（A24–A27）',
  note: '两个干净数据目录 + 真实 Chromium + 模拟模型，零费用',
});

// 私密内容扫描用的模式（与 src/core/redact.js 同口径，这里只做"事后复验"）
const SENSITIVE = [
  { key: '绝对路径(Windows)', re: /[A-Za-z]:\\\\[^"'\r\n]{3,}/ },
  { key: '绝对路径(POSIX)', re: /(?:^|[\s"'(])\/(?:home|mnt|Users)\/[^"'\s]{3,}/ },
  { key: '疑似密钥', re: /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/ },
  { key: 'Bearer 令牌', re: /\bBearer\s+[A-Za-z0-9._-]{16,}/i },
];

const workA = mkdtempSync(join(tmpdir(), 'arena-m3-a-'));
const workB = mkdtempSync(join(tmpdir(), 'arena-m3-b-'));
const downloadDir = mkdtempSync(join(tmpdir(), 'arena-m3-dl-'));
const packDir = mkdtempSync(join(tmpdir(), 'arena-m3-unpack-'));
const outsideDir = mkdtempSync(join(tmpdir(), 'arena-m3-outside-'));
const llmLogA = join(workA, 'llm-a.log');
const llmLogB = join(workB, 'llm-b.log');
let serverA = null;
let serverB = null;
let browserHandle = null;

const baseA = async () => 'http://127.0.0.1:' + (await portA) + '/html-arena/api';
let portA = 0;
let portB = 0;

async function openUi(browser, port, tag) {
  const page = await browser.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200)); });
  page.on('pageerror', (e) => pageErrors.push(String(e.message).slice(0, 200)));
  await page.goto('http://127.0.0.1:' + port + '/html-arena/api/ui', { waitUntil: 'load', timeout: 30000 });
  await page.waitForSelector('#mode-badge', { timeout: 20000 });
  await page.waitForTimeout(800);
  return { page, consoleErrors, pageErrors, tag };
}

try {
  portA = await freePort();
  portB = await freePort();
  const baseAUrl = 'http://127.0.0.1:' + portA + '/html-arena/api';
  const baseBUrl = 'http://127.0.0.1:' + portB + '/html-arena/api';
  serverA = startDevServer({ port: portA, dataDir: workA, llmLog: llmLogA, latencyMs: 60 });
  serverB = startDevServer({ port: portB, dataDir: workB, llmLog: llmLogB, latencyMs: 60 });
  await waitHealthy(baseAUrl);
  await waitHealthy(baseBUrl);
  add('准备', '两个干净数据目录的开发服务器都已就绪（A 导出 / B 导入）', true, { portA, portB });

  const b = await launchBrowser();
  if (!b.ok) throw new Error('无法启动浏览器：' + b.reason);
  browserHandle = b.browser;

  // ── ① 在 A 上跑一个两候选实验（模拟模型） ────────────────────────
  const uiA = await openUi(b.browser, portA, 'A');
  const pageA = uiA.page;
  await pageA.click('.tab[data-view="new"]');
  await pageA.waitForTimeout(400);
  await pageA.fill('#task-title', 'M3 往返实验');
  await pageA.selectOption('#task-category', 'dashboard');
  await pageA.fill('#task-prompt', '做一个可切换城市的天气仪表盘，使用内置示例数据。');
  // 输出要求在折叠区里：真实用户也要先展开（脚本不能绕过界面状态直接改 DOM）
  await pageA.locator('#task-requirements').locator('xpath=ancestor::details[1]/summary').click();
  await pageA.waitForTimeout(250);
  await pageA.fill('#task-requirements', '单文件、无外部依赖、窄屏可用');
  await pageA.locator('#candidates .cand').first().locator('details summary').first().click();
  await pageA.waitForTimeout(250);
  await pageA.locator('#candidates .cand').first().locator('details textarea').first().fill('你是资深前端工程师，先想清楚布局再写代码。');
  await pageA.waitForTimeout(150);
  await pageA.click('#btn-start');
  await pageA.waitForSelector('#btn-goto-compare:not([disabled])', { timeout: 60000 });
  await pageA.click('#btn-goto-compare');
  await pageA.waitForSelector('#view-compare .frame-wrap', { timeout: 30000 });
  await pageA.waitForTimeout(900);

  const expId = await pageA.evaluate(() => window.__htmlArena.state.current.experiment.id);
  const detailA = await api(baseAUrl, '/experiments/' + expId);
  const worksA = detailA.body.attempts.filter((a) => a.canPreview).length;
  add('准备', 'A 上跑完一次两候选实验（模拟模型）', worksA === 2 && detailA.body.attempts.length === 2,
    { attempts: detailA.body.attempts.length, withWork: worksA });
  const callsA = logLines(llmLogA);
  add('准备', 'A 的模型调用日志已有记录（后面用它证明导入方没有新调用）', callsA === 2, { callsA });
  const callsB = logLines(llmLogB);
  const filesB = existsSync(join(workB, 'artifacts')) ? readdirSync(join(workB, 'artifacts')).length : 0;

  // ── ② 导出前的清单（F22：先显示包含内容） ────────────────────────
  const preview = await api(baseAUrl, '/experiments/' + expId + '/export/preview', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'retest', options: {} }),
  });
  const rows = Object.fromEntries((preview.body.rows || []).map((r) => [r.key, r]));
  add('F22', '导出前能拿到"包含什么"的清单（题目 / 配方默认包含）',
    preview.status === 200 && rows.prompt.included === true && rows.recipes.included === true,
    { rows: (preview.body.rows || []).map((r) => r.key + ':' + r.included) });
  add('F22', '清单里明确列出"不含推理全文 / 不含调试日志 / 不含凭据与绝对路径"',
    rows.reasoning.included === false && rows.logs.included === false && rows.credentials.included === false);

  // ── ③ 用界面导出复测包并下载 ────────────────────────────────────
  await pageA.click('#btn-export');
  await pageA.waitForSelector('#export-modal:not([hidden])', { timeout: 10000 });
  await pageA.waitForTimeout(700);
  const modalText = await pageA.innerText('#export-contents');
  // 默认打开的是展示包：清单里应当有报告 / 作品 / 截图 / 原始输出 / 推理与凭据（后者标"不含"）
  add('界面', '导出对话框列出包含内容（而不是只有一个下载按钮）',
    /index\.html 报告/.test(modalText) && /作品文件/.test(modalText) && /初始截图/.test(modalText)
      && /推理全文/.test(modalText) && /API key/.test(modalText),
    modalText.replace(/\s+/g, ' ').slice(0, 200));
  await pageA.click('#export-kind-seg .seg-btn[data-kind="retest"]');
  await pageA.waitForTimeout(800);
  const retestText = await pageA.innerText('#export-modal');
  add('F22', '切到复测包后文案说明"不含作品结果、导入方要重新匹配模型、不会自动执行"',
    /复测包/.test(retestText) && /重新匹配/.test(retestText) && /不会自动开始生成/.test(retestText));
  const [download] = await Promise.all([
    pageA.waitForEvent('download', { timeout: 30000 }),
    pageA.click('#btn-export-download'),
  ]);
  const retestPath = join(downloadDir, 'retest.zip');
  await download.saveAs(retestPath);
  await pageA.click('#btn-export-close');
  add('F21', '复测包已下载', existsSync(retestPath) && statSync(retestPath).size > 500,
    { bytes: existsSync(retestPath) ? statSync(retestPath).size : 0, name: download.suggestedFilename() });

  // 包结构 + 私密内容扫描（A27）
  const retestZip = readZip(readFileSync(retestPath));
  const retestNames = retestZip.entries.map((e) => e.name).sort();
  add('F21', '复测包结构正确（pack.json / task.json / recipes.json / README.txt）',
    JSON.stringify(retestNames) === JSON.stringify(['README.txt', 'pack.json', 'recipes.json', 'task.json']), retestNames);
  const retestManifest = JSON.parse(retestZip.entries.find((e) => e.name === 'pack.json').data.toString('utf8'));
  add('F21', '复测包清单带 schemaVersion / 题目 hash / 每个候选的配方 hash',
    retestManifest.schemaVersion === 1 && /^[0-9a-f]{64}$/.test(retestManifest.task.hash)
      && retestManifest.candidates.every((c) => /^[0-9a-f]{64}$/.test(c.recipeHash)),
    { schemaVersion: retestManifest.schemaVersion, taskHash: retestManifest.task.hash.slice(0, 12) });

  let sensitiveHits = [];
  for (const entry of retestZip.entries) {
    const text = entry.data.toString('utf8');
    for (const s of SENSITIVE) if (s.re.test(text)) sensitiveHits.push({ entry: entry.name, pattern: s.key });
  }
  const retestAllText = retestZip.entries.map((e) => e.data.toString('utf8')).join('\n');
  add('A27', '复测包里没有绝对路径 / 密钥 / 令牌',
    sensitiveHits.length === 0, { hits: sensitiveHits.slice(0, 5) });
  // 逐项查"不该有的东西"：完整输入文本（编译后的 userText 以 '# 题目' 开头）、
  // 推理全文（既不该有 reasoning 条目，清单里的声明也必须是 false）
  add('A27', '复测包不含完整输入文本（userText 不参与配方内容）',
    !retestAllText.includes('# 题目') && !retestAllText.includes('"userText"'),
    { hasPromptHeading: retestAllText.includes('# 题目'), hasUserTextField: retestAllText.includes('"userText"') });
  add('A27', '复测包不含推理全文（没有推理条目，清单也声明不含）',
    !retestZip.entries.some((e2) => /reasoning/i.test(e2.name)) && retestManifest.privacy.containsReasoning === false,
    { entries: retestNames });

  // ── ④ 在 B（另一个干净安装）用界面导入 ──────────────────────────
  const uiB = await openUi(b.browser, portB, 'B');
  const pageB = uiB.page;
  // 事件必须**先**挂上再点：filechooser 不会为"已经发生过"的事件补发（第一次写这个脚本时踩过）
  const [chooser] = await Promise.all([
    pageB.waitForEvent('filechooser', { timeout: 15000 }),
    pageB.click('#btn-import'),
  ]);
  await chooser.setFiles(retestPath);
  await pageB.waitForSelector('#import-panel:not([hidden])', { timeout: 20000 });
  await pageB.waitForTimeout(1500);
  const inspectText = await pageB.innerText('#import-panel');
  add('A25', '导入前先检视：显示题目指纹、候选表与"需重新匹配"的提示',
    /题目指纹/.test(inspectText) && /候选 A/.test(inspectText) && /本机/.test(inspectText),
    inspectText.replace(/\s+/g, ' ').slice(0, 220));
  add('A25', '检视阶段没有写任何东西（B 上仍然没有实验）',
    (await api(baseBUrl, '/experiments')).body.experiments.length === 0);
  add('F22', '界面写明"导入不会自动开始生成、模型调用 0 次"',
    /不会自动开始生成/.test(inspectText) && /模型调用 0 次/.test(inspectText));

  await pageB.click('#import-panel button:has-text("确认导入")');
  await pageB.waitForTimeout(2500);
  const doneText = await pageB.innerText('#import-panel');
  add('A25', '导入完成并如实说明是否需要重新选模型',
    /已导入/.test(doneText), doneText.replace(/\s+/g, ' ').slice(0, 200));
  const noticeText = await pageB.innerText('#import-notice');
  add('A25', '界面跳到"新建对比"并给出导入说明（题目指纹 + 待重选模型的候选）',
    /从复测包导入/.test(noticeText) && /题目指纹/.test(noticeText), noticeText.replace(/\s+/g, ' ').slice(0, 200));
  add('A25', '本机有对应模型时，候选卡直接填好（不出现"需要重选"的提示）',
    !/复测包里的这个候选原本用/.test(await pageB.innerText('#candidates')));
  // 趁第二次导入之前，先把这一次导入的结果锁定下来（后面还有一次"幽灵模型"导入）
  const firstImported = (await api(baseBUrl, '/experiments')).body.experiments
    .find((x) => x.importedFrom && x.importedFrom.unmatchedCount === 0);

  // ── ④b "模型不在这台机器上"这条路（A25 的核心要求：导入后要重新匹配模型） ──
  // 用同一个包子集手工造一个"来自另一台机器"的复测包：provider 与 model 本机都没有。
  const ghost = await buildRetestPack({
    experiment: {
      id: 'exp_other_machine', title: '来自另一台机器的复测包', category: 'dashboard',
      taskSnapshot: { prompt: '这道题来自另一台机器。', startHtml: null, outputRequirements: '' },
      outputPolicy: { maxTokens: null, timeoutMs: 120000, concurrency: 2 },
      previewPolicy: { networkPolicy: 'offline', viewport: 'desktop' },
    },
    attempts: [{
      slot: 0,
      recipe: {
        name: '候选 A', provider: 'provider-not-installed', model: 'ghost-model-1',
        systemPrompt: '来自别处的提示词', promptSegments: [], temperature: null, maxTokens: null, reasoningEffort: null,
      },
    }],
    options: {}, tool: { name: 'HTML Arena', version: '0.0.0-other-machine' }, now: new Date().toISOString(),
  });
  const ghostPath = join(downloadDir, 'ghost-retest.zip');
  writeFileSync(ghostPath, writeZip(ghost.entries));
  // 上一次导入之后界面停在"新建对比"，导入按钮在实验列表页 —— 先切回去（这也是真实用户路径）
  await pageB.click('.tab[data-view="experiments"]');
  await pageB.waitForTimeout(600);
  const [chooser2] = await Promise.all([
    pageB.waitForEvent('filechooser', { timeout: 15000 }),
    pageB.click('#btn-import'),
  ]);
  await chooser2.setFiles(ghostPath);
  await pageB.waitForTimeout(2000);
  const ghostInspect = await pageB.innerText('#import-panel');
  add('A25', '检视阶段就点明"本机没有这个模型来源"，而不是等到开始生成才报错',
    /本机没有这个模型来源/.test(ghostInspect) && /重新选择模型/.test(ghostInspect),
    ghostInspect.replace(/\s+/g, ' ').match(/候选 A[^。]{0,80}/));
  await pageB.click('#import-panel button:has-text("确认导入")');
  await pageB.waitForTimeout(2500);
  const ghostDone = await pageB.innerText('#import-panel');
  add('A25', '导入完成时也如实报告"有几个候选需要重新选模型"',
    /需要重新选模型/.test(ghostDone) && /原本 provider-not-installed/.test(ghostDone),
    ghostDone.replace(/\s+/g, ' ').match(/有 \d+ 个候选需要重新选模型[^。]{0,60}/));
  const cardText = await pageB.innerText('#candidates');
  add('A25', '候选卡写明"原本用哪个模型、必须重选"，不静默换一个模型顶上',
    /复测包里的这个候选原本用 provider-not-installed \/ ghost-model-1/.test(cardText)
      && /请在上面的下拉框里重新选择/.test(cardText) && /插件不会替你换一个模型顶上/.test(cardText),
    cardText.replace(/\s+/g, ' ').match(/复测包里的这个候选原本用[^。]{0,70}/));
  const ghostSelect = await pageB.$eval('#candidates select[data-role="model"]', (elm) => ({ value: elm.value, text: elm.options[elm.selectedIndex] ? elm.options[elm.selectedIndex].text : '' }));
  add('A25', '模型下拉框停在"请选择模型"占位项（不会看起来选好了、其实是空的）',
    ghostSelect.value === '' && /请选择模型/.test(ghostSelect.text), ghostSelect);
  // 系统提示词在折叠区里：按真实用户路径展开后再断言（innerText 读不到收起的内容）
  await pageB.locator('#candidates .cand').first().locator('details summary').first().click();
  await pageB.waitForTimeout(300);
  // 系统提示词是 textarea 的 value：innerText 读不到，要用 inputValue（第一版这里假红过）
  const ghostSysPrompt = await pageB.inputValue('#candidates .cand textarea');
  add('A25', '配方内容照常带进来（系统提示词来自包里）', ghostSysPrompt === '来自别处的提示词',
    { value: ghostSysPrompt.slice(0, 40) });

  // ── ⑤ A25：hash 一致 + 没有自动执行 ─────────────────────────────
  const listB = await api(baseBUrl, '/experiments');
  const importedRow = firstImported;
  const importedRows = listB.body.experiments.filter((x) => x.importedFrom);
  add('A25', 'B 上多了标着"由复测包导入"的实验记录（两次导入各一条，且如实标出需重选的候选数）',
    importedRows.length === 2 && importedRows.filter((x) => x.importedFrom.unmatchedCount === 1).length === 1,
    importedRows.map((x) => x.title + ' 需重选 ' + x.importedFrom.unmatchedCount));
  const detailB = await api(baseBUrl, '/experiments/' + importedRow.id);
  add('A25', '导入后题目 hash 与导出侧完全一致',
    detailB.body.experiment.taskHash === detailA.body.experiment.taskHash
      && detailB.body.experiment.taskHash === retestManifest.task.hash,
    { A: detailA.body.experiment.taskHash.slice(0, 16), B: detailB.body.experiment.taskHash.slice(0, 16), pack: retestManifest.task.hash.slice(0, 16) });
  add('A25', '题目正文逐字一致',
    detailB.body.experiment.taskSnapshot.prompt === detailA.body.experiment.taskSnapshot.prompt
      && detailB.body.experiment.taskSnapshot.outputRequirements === detailA.body.experiment.taskSnapshot.outputRequirements);
  add('A25', '导入的实验没有任何执行记录（不自动执行）', detailB.body.attempts.length === 0);
  add('A25', '导入方没有发生任何模型调用（模型调用日志行数不变）',
    logLines(llmLogB) === callsB && logLines(llmLogB) === 0, { before: callsB, after: logLines(llmLogB) });

  const recipesB = await api(baseBUrl, '/recipes?full=1');
  const hashPairs = [];
  for (const att of detailA.body.attempts) {
    const expected = recipeHash(att.recipe);
    const fromPack = retestManifest.candidates.find((c) => c.slot === att.slot);
    const local = recipesB.body.recipes.find((r) => r.versions.some((v) => v.contentHash === expected));
    hashPairs.push({
      slot: att.slot, source: expected,
      pack: String(fromPack && fromPack.recipeHash),
      local: local ? local.versions.find((v) => v.contentHash === expected).contentHash : null,
    });
  }
  add('A25', '每个候选的配方 hash 三方一致（源实验 / 包里 / 导入后本机）',
    hashPairs.every((p) => p.source === p.pack && p.local === p.source),
    hashPairs.map((p) => ({ slot: p.slot, source: p.source.slice(0, 12), pack: p.pack.slice(0, 12), local: p.local ? p.local.slice(0, 12) : null })));
  const localVersions = hashPairs.map((p) => {
    // 注意用完整 hash 比对（第一版这里用了截断后的展示值，结果永远找不到，断言假红）
    const recipe = recipesB.body.recipes.find((r) => r.versions.some((v) => v.contentHash === p.source));
    const version = recipe ? recipe.versions.find((v) => v.contentHash === p.source) : null;
    return { slot: p.slot, name: recipe ? recipe.name : null, latest: recipe ? recipe.latestVersion : null, source: version ? version.source : null };
  });
  add('A25', '导入的配方是本机独立对象（第 1 版、来源标注为导入、可继续追加版本）',
    localVersions.every((v) => v.latest === 1 && v.source === 'pack-import'), localVersions);

  const filesBAfter = existsSync(join(workB, 'artifacts')) ? readdirSync(join(workB, 'artifacts')).length : 0;
  add('A25', '导入没有伪造作品文件（B 的 artifacts 目录没有多出东西）', filesBAfter === filesB, { before: filesB, after: filesBAfter });

  // ── ⑤b A27：用户内容里含本机路径时，导出前**如实提示**而不是偷偷改写 ──
  const pathExp = await api(baseAUrl, '/experiments', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'M3 含路径的题目', prompt: '参考 D:\\开发\\dsh插件\\样例.html 的做法做一个页面。' }),
  });
  const pathPreview = await api(baseAUrl, '/experiments/' + pathExp.body.experiment.id + '/export/preview', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'retest', options: {} }),
  });
  add('A27', '题目里出现本机路径时，导出前明确提示"这是你自己的内容、插件不会替你改写"',
    (pathPreview.body.warnings || []).some((w) => /看起来像本机路径或密钥/.test(w) && /不会替你改写/.test(w)),
    { warnings: pathPreview.body.warnings, scan: pathPreview.body.privateScan });
  add('A27', '提示里不谎报"包是干净的"：题目 hash 仍然按原文算（内容不会被改写）',
    pathPreview.body.privateScan.count >= 1 && /^[0-9a-f]{64}$/.test(String(pathPreview.body.taskHash)));

  // ── ⑥ A26：路径穿越 / 压缩炸弹 / 超大上传 ───────────────────────
  const outsideBefore = readdirSync(outsideDir).length;
  // 造一个"等长改名"的穿越包：ab/x.txt -> ../x.txt
  const evilZip = Buffer.from(writeZip([{ name: 'pack.json', data: '{}' }, { name: 'ab/x.txt', data: 'evil' }]));
  for (const at of [evilZip.indexOf(Buffer.from('ab/x.txt')), evilZip.lastIndexOf(Buffer.from('ab/x.txt'))]) {
    if (at > 0) evilZip.write('../x.txt', at, 'utf8');
  }
  const traversal = await api(baseBUrl, '/packs/inspect', { method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: evilZip });
  add('A26', '路径穿越包被拒绝', traversal.status === 400 && traversal.body.code === 'bad-name',
    { status: traversal.status, code: traversal.body.code, error: traversal.body.error });
  add('A26', '拒绝时明确说明"没有写任何文件、没有执行任何东西"',
    /没有在本机写入任何文件/.test(String(traversal.body.hint || '')));

  const bomb = writeZip([{ name: 'pack.json', data: '{}' }, { name: 'bomb.json', data: 'A'.repeat(4 * 1024 * 1024) }]);
  const bombRes = await api(baseBUrl, '/packs/import', { method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: bomb });
  add('A26', '压缩炸弹被拒绝（按压缩比判定）', bombRes.status === 400 && bombRes.body.code === 'zip-bomb',
    { status: bombRes.status, code: bombRes.body.code, zipBytes: bomb.length });

  // 超大上传：声明的 Content-Length 就超过上限时立刻拒绝（不把 64MB 读进内存）
  const tooLarge = await new Promise((resolve) => {
    const req = createHttpServer;   // 占位，避免误用
    void req;
    import('node:http').then(({ request }) => {
      const r = request({
        host: '127.0.0.1', port: portB, path: '/html-arena/api/packs/inspect', method: 'POST',
        headers: { 'Content-Type': 'application/zip', 'Content-Length': String(100 * 1024 * 1024) },
      }, (res) => {
        let text = '';
        res.on('data', (c) => { text += c; });
        res.on('end', () => resolve({ status: res.statusCode, body: text }));
      });
      r.on('error', () => resolve({ status: 0, body: '' }));
      r.write(Buffer.from('PK'));
      setTimeout(() => { try { r.destroy(); } catch { /* 忽略 */ } }, 1500);
    });
  });
  add('A26', '超过大小上限的上传被拒绝', tooLarge.status === 400 && /MB 上限/.test(tooLarge.body),
    { status: tooLarge.status, body: String(tooLarge.body).slice(0, 120) });
  add('A26', '三种坏包都没有在插件数据目录之外留下文件',
    readdirSync(outsideDir).length === outsideBefore && readdirSync(workB).filter((f) => f.endsWith('.zip')).length === 0,
    { outside: readdirSync(outsideDir), workB: readdirSync(workB) });

  // ── ⑦ A24：展示包解压到另一个目录，用 file:// 打开 ───────────────
  await pageA.click('#btn-export');
  await pageA.waitForSelector('#export-modal:not([hidden])', { timeout: 10000 });
  await pageA.waitForTimeout(800);
  add('F20', '展示包清单默认包含报告 / 作品 / 截图 / 截图记录',
    /index\.html 报告/.test(await pageA.innerText('#export-contents')));
  const [download2] = await Promise.all([
    pageA.waitForEvent('download', { timeout: 90000 }),
    pageA.click('#btn-export-download'),
  ]);
  const showcasePath = join(downloadDir, 'showcase.zip');
  await download2.saveAs(showcasePath);
  await pageA.click('#btn-export-close');
  const showcaseZip = readZip(readFileSync(showcasePath));
  const showcaseNames = showcaseZip.entries.map((e) => e.name);
  add('F20', '展示包里有报告、作品、截图与公开元数据',
    showcaseNames.includes('index.html') && showcaseNames.includes('pack.json')
      && showcaseNames.some((n) => n.startsWith('works/'))
      && showcaseNames.some((n) => n.startsWith('shots/') && n.endsWith('.png')),
    showcaseNames);

  // 解压到"另一个目录"（模拟干净机器：与 A 的数据目录毫无关系）
  const unpacked = join(packDir, 'showcase');
  mkdirSync(unpacked, { recursive: true });
  for (const entry of showcaseZip.entries) {
    const target = join(unpacked, entry.name);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, entry.data);
  }
  const reportHtml = readFileSync(join(unpacked, 'index.html'), 'utf8');
  add('F20', '报告主体里没有任何脚本（作品脚本不会被注入报告）', !/<script/i.test(reportHtml));
  add('A24', '报告不依赖原本地路径', !/[A-Za-z]:\\\\[^"'\r\n]{3,}/.test(reportHtml) && !/file:\/\//.test(reportHtml));
  let showHits = [];
  for (const entry of showcaseZip.entries) {
    const text = entry.data.toString('utf8');
    for (const s of SENSITIVE) if (s.re.test(text)) showHits.push({ entry: entry.name, pattern: s.key });
  }
  add('A27', '展示包里没有绝对路径 / 密钥 / 令牌', showHits.length === 0, { hits: showHits.slice(0, 5) });
  const pngs = showcaseZip.entries.filter((e) => e.name.endsWith('.png'));
  add('F16', '截图是真实 PNG（魔数校验），且报告里引用了它们',
    pngs.length > 0 && pngs.every((p) => p.data[0] === 0x89 && p.data[1] === 0x50)
      && pngs.every((p) => reportHtml.includes(p.name)),
    { count: pngs.length, sizes: pngs.map((p) => p.size) });

  const pageC = await b.browser.newPage();
  const failedRequests = [];
  const externalRequests = [];
  pageC.on('requestfailed', (rq) => failedRequests.push(rq.url().slice(0, 120)));
  pageC.on('request', (rq) => { if (/^https?:/.test(rq.url())) externalRequests.push(rq.url().slice(0, 120)); });
  await pageC.goto('file:///' + join(unpacked, 'index.html').replace(/\\/g, '/'), { waitUntil: 'load', timeout: 30000 });
  await pageC.waitForTimeout(1500);
  const reportTitle = await pageC.title();
  const frameCount = pageC.frames().length;
  let frameText = '';
  for (const f of pageC.frames()) {
    if (f === pageC.mainFrame()) continue;
    try { frameText += await f.evaluate(() => document.body ? document.body.innerText.slice(0, 200) : ''); } catch { /* 跨源/未加载 */ }
  }
  add('A24', '展示包在另一个目录里用 file:// 打开就能读（报告标题正确）',
    /M3 往返实验/.test(reportTitle), { title: reportTitle });
  // 判断口径：两个作品 frame 里都读到了**作品自己的内容**（不是空白页，也不是报错页）。
  // 注意别拿"模拟模型的说明"当标记 —— 那句在代码块外面，不属于提取出的作品 HTML。
  const workFrameTexts = [];
  for (const f of pageC.frames()) {
    if (f === pageC.mainFrame()) continue;
    try { workFrameTexts.push(await f.evaluate(() => (document.body ? document.body.innerText.trim() : ''))); } catch { workFrameTexts.push(''); }
  }
  add('A24', '作品在受限沙箱里真的渲染出来了（两个 iframe 内都读到了作品内容）',
    frameCount >= 3 && workFrameTexts.filter((t) => t.length > 50).length === 2,
    { frames: frameCount, lengths: workFrameTexts.map((t) => t.length), sample: frameText.slice(0, 60) });
  add('A24', '打开报告不需要联网（0 个外部请求、0 个失败请求）',
    externalRequests.length === 0 && failedRequests.length === 0,
    { external: externalRequests.slice(0, 3), failed: failedRequests.slice(0, 3) });
  const bodyText = await pageC.innerText('body');
  add('F20', '报告里有题目、评价区与"包里有什么"的说明',
    /题目/.test(bodyText) && /人工评价/.test(bodyText) && /包里有|这个包里有什么/.test(bodyText));
  await pageC.screenshot({ path: join(EVIDENCE_DIR, 'm3-showcase-report.png'), fullPage: false });
  report.screenshot = 'docs/evidence/m3-showcase-report.png';
  await pageC.close();

  add('界面', 'A/B 两侧全程 0 控制台错误、0 页面异常',
    uiA.consoleErrors.length === 0 && uiA.pageErrors.length === 0 && uiB.consoleErrors.length === 0 && uiB.pageErrors.length === 0,
    { a: uiA.consoleErrors.slice(0, 2), b: uiB.consoleErrors.slice(0, 2), bPage: uiB.pageErrors.slice(0, 2) });

  report.refs = {
    experimentA: expId,
    importedExperiment: importedRow.id,
    retestPack: { bytes: statSync(retestPath).size, taskHash: retestManifest.task.hash, candidates: retestManifest.candidates.map((c) => c.recipeHash.slice(0, 16)) },
    showcaseEntries: showcaseNames,
    hashPairs,
  };
  report.notes = [
    'A24 的"干净机器"是同一台机器上的另一个目录 + file:// 打开（不用任何服务），不是真的第二台电脑。',
    '模拟模型产物都带"这是模拟模型的说明"字样，不会被误认为真实结果。',
  ];

  await pageA.close();
  await pageB.close();
  await b.browser.close();
  browserHandle = null;
} catch (err) {
  add('执行', '脚本运行没有抛异常', false, String(err && err.stack || err).slice(0, 1500));
} finally {
  try { if (browserHandle) await browserHandle.close(); } catch { /* 已关 */ }
  try { await hardKill(serverA, '开发服务器 A'); } catch { /* 已经没了 */ }
  try { await hardKill(serverB, '开发服务器 B'); } catch { /* 已经没了 */ }
  for (const dir of [workA, workB, downloadDir, packDir, outsideDir]) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }
  }
}

process.exit(finish('m3-export-import'));
