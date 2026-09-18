/**
 * 展示包 / 复测包的单测（M3 / F20 / F21 / F22 / A24–A27）。
 *
 * 这一层要钉住的是**可核对性**：
 *  - 题目与配方的 hash 在导出 → 导入之间必须逐字节一致；
 *  - 包里不能有绝对路径、推理全文、凭据（A27）；
 *  - 任何一条对不上（内容、清单、schema、类型）都要**整包拒绝**，不能"尽量读"。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeZip, readZip, ZipError } from '../src/core/zip.js';
import {
  PACK_SCHEMA_VERSION, buildRetestPack, buildShowcasePack, parseRetestPack, describeExport,
  detectExternalRefs, normalizeExportOptions,
} from '../src/core/pack.js';
import { taskHashOf } from '../src/core/task.js';
import { recipeHash, normalizeRecipeContent } from '../src/core/recipe.js';

const TOOL = { name: 'HTML Arena', version: '9.9.9-test' };
const NOW = '2026-09-18T00:00:00.000Z';

function makeExperiment(over = {}) {
  return {
    id: 'exp_test', title: '测试实验', category: 'dashboard', status: 'completed',
    taskSnapshot: { prompt: '做一个天气仪表盘，使用内置示例数据。', startHtml: '<html><body>起始</body></html>', outputRequirements: '单文件、无外部依赖' },
    taskHash: 'placeholder', outputPolicy: { maxTokens: 8192, timeoutMs: 120000, concurrency: 2 },
    previewPolicy: { networkPolicy: 'offline', viewport: 'desktop' },
    version: 1, createdAt: 1, updatedAt: 2,
    ...over,
  };
}

function makeAttempt(slot, over = {}) {
  return {
    id: 'att_' + slot + 'x', slot, attemptNo: 1, status: 'completed',
    recipe: {
      slot, name: '候选 ' + String.fromCharCode(65 + slot), provider: 'prov' + slot, model: 'model-' + slot,
      systemPrompt: '系统提示词 ' + slot, promptSegments: ['片段 1'], temperature: 0.7, maxTokens: 4096,
      reasoningEffort: 'high', userText: '（完整输入文本，不该被导出）', roundNote: null, requestedAt: 123,
    },
    resolved: null, requested: {}, recipeLink: null, parentAttemptId: null,
    createdAt: 1, updatedAt: 2,
    receipt: { queuedAt: 1, startedAt: 10, firstEventAt: 20, firstTextAt: 20, finishedAt: 1010, finishReason: 'stop', errorCode: null, errorMessage: null, errorStatus: null, usage: { inputTokens: 10, outputTokens: 20 }, observedRequests: 1 },
    extraction: { status: 'ok', mode: 'single', warnings: [], range: null, version: '1', htmlHash: 'hash' + slot, rawTextHash: 'raw' + slot, bytes: 100 },
    error: null, canPreview: true, partial: null, running: false,
    ...over,
  };
}

/** 递归收集包里所有文本条目（用于"包里有没有私密内容"的扫描）。 */
function allText(entries) {
  return entries.map((e) => e.name + '\n' + e.data.toString('utf8')).join('\n');
}

test('复测包：结构与清单自洽，往返解析后题目 hash 与配方 hash 完全一致', async () => {
  const experiment = makeExperiment();
  const attempts = [makeAttempt(0), makeAttempt(1)];
  const built = await buildRetestPack({ experiment, attempts, options: {}, tool: TOOL, now: NOW });
  const names = built.entries.map((e) => e.name).sort();
  assert.deepEqual(names, ['README.txt', 'pack.json', 'recipes.json', 'task.json']);
  assert.equal(built.manifest.schemaVersion, PACK_SCHEMA_VERSION);
  assert.equal(built.manifest.kind, 'retest');
  assert.equal(built.manifest.contents.length, 3, 'pack.json 自己不列入 contents');

  const zip = readZip(writeZip(built.entries));
  const parsed = await parseRetestPack(zip);
  const expectedTaskHash = await taskHashOf(experiment.taskSnapshot);
  assert.equal(parsed.summary.taskHash, expectedTaskHash);
  assert.equal(parsed.manifest.task.hash, expectedTaskHash);
  assert.equal(parsed.recipes.candidates.length, 2);
  for (const c of parsed.recipes.candidates) {
    const original = attempts.find((a) => a.slot === c.slot);
    assert.equal(c.contentHash, recipeHash(original.recipe));
    assert.equal(c.recipe.systemPrompt, original.recipe.systemPrompt);
    assert.equal(c.recipe.model, original.recipe.model);
  }
  assert.equal(parsed.summary.candidateCount, 2);
  assert.equal(parsed.warnings.length, 0);
});

test('复测包：不含绝对路径、推理全文、凭据，也不含完整输入文本（A27）', async () => {
  const experiment = makeExperiment();
  // 恶意构造：错误信息里带本机路径与疑似密钥，看导出会不会把它带出去
  const attempts = [
    makeAttempt(0, { error: { reason: 'Playwright 在 D:\\开发\\secret\\x.mjs 失败', title: 'x' } }),
    makeAttempt(1),
  ];
  const built = await buildRetestPack({ experiment, attempts, options: {}, tool: TOOL, now: NOW });
  const text = allText(built.entries);
  assert.equal(/D:\\|D:\//.test(text), false, '不该出现本机绝对路径');
  assert.equal(/sk-[A-Za-z0-9]{16,}/.test(text), false);
  assert.equal(text.includes('（完整输入文本，不该被导出）'), false, 'userText 不参与配方内容');
  assert.equal(built.manifest.privacy.containsReasoning, false);
  assert.equal(built.manifest.privacy.containsCredentials, false);
  assert.equal(built.manifest.privacy.containsAbsolutePaths, false);
});

test('复测包：按用户选择排除题目时，hash 变的是"这份包的内容"而不是原题（并如实给出警告）', async () => {
  const experiment = makeExperiment();
  const attempts = [makeAttempt(0)];
  const full = await buildRetestPack({ experiment, attempts, options: {}, tool: TOOL, now: NOW });
  const partial = await buildRetestPack({ experiment, attempts, options: { prompt: false, startHtml: false }, tool: TOOL, now: NOW });
  assert.notEqual(full.manifest.task.hash, partial.manifest.task.hash);
  assert.equal(partial.manifest.task.fullHash, full.manifest.task.hash, 'fullHash 仍然是原题的指纹');
  assert.equal(partial.manifest.task.included.prompt, false);
  const zip = readZip(writeZip(partial.entries));
  const parsed = await parseRetestPack(zip);
  assert.ok(parsed.warnings.some((w) => w.includes('没有题目原文')), parsed.warnings);
  assert.equal(parsed.task.prompt, '');
  assert.equal(parsed.task.startHtml, null);
});

test('复测包：排除配方时包里没有可复用配置，解析后给出警告', async () => {
  const built = await buildRetestPack({
    experiment: makeExperiment(), attempts: [makeAttempt(0)], options: { recipes: false }, tool: TOOL, now: NOW,
  });
  const parsed = await parseRetestPack(readZip(writeZip(built.entries)));
  assert.equal(parsed.recipes.candidates.length, 0);
  assert.ok(parsed.warnings.some((w) => w.includes('没有配方')));
  assert.equal(built.manifest.candidates[0].recipeIncluded, false);
});

test('复测包：内容被改过一律拒绝（task / recipes / 清单 / 多文件 / 少文件）', async () => {
  const built = await buildRetestPack({ experiment: makeExperiment(), attempts: [makeAttempt(0), makeAttempt(1)], options: {}, tool: TOOL, now: NOW });
  const tamper = (name, mutate) => {
    const entries = built.entries.map((e) => ({ name: e.name, data: Buffer.from(e.data) }));
    mutate(entries.find((e) => e.name === name));
    return readZip(writeZip(entries));
  };
  // 等长改写：先撞到 hash 校验（这才是"包被改过"的判定）
  await assert.rejects(
    () => parseRetestPack(tamper('task.json', (e) => { e.data = Buffer.from(e.data.toString('utf8').replace('天气仪表盘', '天气仪表板')); })),
    (err) => err instanceof ZipError && err.code === 'hash-mismatch');
  // 不等长改写：应该在大小那一步就被拦下（同样拒绝，只是先撞到哪一条不同）
  await assert.rejects(
    () => parseRetestPack(tamper('task.json', (e) => { e.data = Buffer.from(e.data.toString('utf8').replace('天气仪表盘', '别的题')); })),
    (err) => err instanceof ZipError && (err.code === 'size-mismatch' || err.code === 'hash-mismatch'));
  await assert.rejects(
    () => parseRetestPack(tamper('recipes.json', (e) => { e.data = Buffer.from(e.data.toString('utf8').replace('"temperature": 0.7', '"temperature": 1.5')); })),
    (err) => err instanceof ZipError && err.code === 'hash-mismatch');

  const extra = [...built.entries.map((e) => ({ name: e.name, data: e.data })), { name: 'extra.json', data: Buffer.from('{}') }];
  await assert.rejects(() => parseRetestPack(readZip(writeZip(extra))), (err) => err.code === 'extra-entry');
  const missing = built.entries.filter((e) => e.name !== 'README.txt').map((e) => ({ name: e.name, data: e.data }));
  await assert.rejects(() => parseRetestPack(readZip(writeZip(missing))), (err) => err.code === 'missing-entry');
});

test('复测包：schemaVersion 比本插件新就明确拒绝，不猜着读', async () => {
  const built = await buildRetestPack({ experiment: makeExperiment(), attempts: [makeAttempt(0)], options: {}, tool: TOOL, now: NOW });
  const entries = built.entries.map((e) => ({ name: e.name, data: Buffer.from(e.data) }));
  const pack = entries.find((e) => e.name === 'pack.json');
  const manifest = JSON.parse(pack.data.toString('utf8'));
  manifest.schemaVersion = PACK_SCHEMA_VERSION + 1;
  pack.data = Buffer.from(JSON.stringify(manifest, null, 2));
  await assert.rejects(() => parseRetestPack(readZip(writeZip(entries))),
    (err) => err instanceof ZipError && err.code === 'schema-too-new');
});

test('复测包：包内出现不该有的文件类型就拒绝（拒绝未知载荷）', async () => {
  const built = await buildRetestPack({ experiment: makeExperiment(), attempts: [makeAttempt(0)], options: {}, tool: TOOL, now: NOW });
  const entries = built.entries.map((e) => ({ name: e.name, data: e.data }));
  entries.push({ name: 'payload.js', data: Buffer.from('alert(1)') });
  assert.throws(() => readZip(writeZip(entries)), (err) => err.code === 'executable-payload');
  entries.pop();
  entries.push({ name: 'native.dll', data: Buffer.from('MZ') });
  assert.throws(() => readZip(writeZip(entries)), (err) => err.code === 'executable-payload');
});

test('展示包：报告无脚本、作品走受限 iframe、清单与文件齐全', async () => {
  const html = '<html><body><h1>A</h1><script>document.title="A"</script></body></html>';
  const built = await buildShowcasePack({
    experiment: makeExperiment(), attempts: [makeAttempt(0), makeAttempt(1)], shots: [], options: { screenshots: false },
    tool: TOOL, now: NOW, readHtml: () => html, readRaw: () => 'raw text',
  });
  const names = built.entries.map((e) => e.name);
  assert.ok(names.includes('index.html'));
  assert.ok(names.includes('pack.json'));
  assert.equal(names.filter((n) => n.startsWith('works/')).length, 2);
  const report = built.entries.find((e) => e.name === 'index.html').data.toString('utf8');
  assert.equal(/<script/i.test(report), false, '报告主体不能有脚本（F20）');
  assert.equal((report.match(/<iframe/g) || []).length, 2);
  assert.ok(/sandbox="allow-scripts"/.test(report));
  assert.equal(/allow-same-origin/.test(report), false);
  assert.equal(/D:\\|file:\/\//.test(report), false, '报告不依赖原本地路径');
  // 报告抬头那句说明里本来就有"需要联网"四个字，所以这里按**候选卡上的标记**数，而不是全文搜索
  assert.equal((report.match(/<span class="pill warn">需要联网<\/span>/g) || []).length, 0, '离线作品不该被标成需要联网');
  assert.equal((report.match(/<span class="pill">离线自包含<\/span>/g) || []).length, 2);
});

test('展示包：未揭晓时隐藏模型身份（盲选不能被导出包泄底）', async () => {
  const vote = { experimentId: 'exp_test', anonymousMapping: { A: 'att_0x' }, choice: 'A', tags: null, note: null, createdAt: 5, revealedAt: null };
  const built = await buildShowcasePack({
    experiment: makeExperiment(), attempts: [makeAttempt(0), makeAttempt(1)], shots: [], vote,
    options: { screenshots: false }, tool: TOOL, now: NOW, readHtml: () => '<html><body>x</body></html>',
  });
  assert.equal(built.manifest.identitiesHidden, true);
  const report = built.entries.find((e) => e.name === 'index.html').data.toString('utf8');
  assert.equal(report.includes('model-0'), false, '报告里不能出现模型名');
  assert.equal(report.includes('prov0'), false, '报告里不能出现来源名');
  assert.ok(report.includes('尚未揭晓') || report.includes('还没揭晓'));

  const revealed = await buildShowcasePack({
    experiment: makeExperiment(), attempts: [makeAttempt(0)], shots: [],
    vote: { ...vote, revealedAt: 6 }, options: { screenshots: false }, tool: TOOL, now: NOW,
    readHtml: () => '<html><body>x</body></html>',
  });
  assert.equal(revealed.manifest.identitiesHidden, false);
  assert.ok(revealed.entries.find((e) => e.name === 'index.html').data.toString('utf8').includes('model-0'));
});

test('展示包：引用外部 CDN 的作品被标成"需要联网"（按内容判定，不猜）', async () => {
  const cdnHtml = '<html><head><script src="https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.min.js"></script></head><body>x</body></html>';
  const built = await buildShowcasePack({
    experiment: makeExperiment(), attempts: [makeAttempt(0), makeAttempt(1)], shots: [],
    options: { screenshots: false }, tool: TOOL, now: NOW,
    readHtml: (id) => (id === 'att_0x' ? cdnHtml : '<html><body>local</body></html>'),
  });
  const report = built.entries.find((e) => e.name === 'index.html').data.toString('utf8');
  assert.equal(built.manifest.candidates[0].needsNetwork, true);
  assert.equal(built.manifest.candidates[1].needsNetwork, false);
  assert.equal((report.match(/<span class="pill warn">需要联网<\/span>/g) || []).length, 1);
  assert.equal((report.match(/<span class="pill">离线自包含<\/span>/g) || []).length, 1);
  assert.deepEqual(detectExternalRefs('<img src="https://a.example/x.png"><p>ok</p>'), ['https://a.example/x.png']);
});

test('展示包：把展示包当复测包导入时给出人话（而不是"文件类型不对"）', async () => {
  const built = await buildShowcasePack({
    experiment: makeExperiment(), attempts: [makeAttempt(0)], shots: [], options: { screenshots: false },
    tool: TOOL, now: NOW, readHtml: () => '<html><body>x</body></html>',
  });
  await assert.rejects(() => parseRetestPack(readZip(writeZip(built.entries))),
    (err) => err instanceof ZipError && err.code === 'not-a-retest-pack' && err.message.includes('展示包'));
});

test('导出清单：默认包含题目与配方，默认不含推理与调试日志（F22）', () => {
  const described = describeExport({
    kind: 'retest', experiment: makeExperiment(), attempts: [makeAttempt(0)], vote: null, options: {},
  });
  const byKey = Object.fromEntries(described.rows.map((r) => [r.key, r]));
  assert.equal(byKey.prompt.included, true);
  assert.equal(byKey.recipes.included, true);
  assert.equal(byKey.reasoning.included, false);
  assert.equal(byKey.logs.included, false);
  assert.equal(byKey.credentials.included, false);
  assert.equal(byKey.rawOutput.included, false, '复测包不含作品结果');

  const showcase = describeExport({
    kind: 'showcase', experiment: makeExperiment(), attempts: [makeAttempt(0)],
    vote: { choice: 'A', revealedAt: null }, options: {},
  });
  assert.ok(showcase.warnings.some((w) => w.includes('尚未揭晓')));
  assert.equal(normalizeExportOptions({ prompt: 0 }).prompt, false);
  assert.equal(normalizeExportOptions({}).screenshots, true);
});

test('展示包：包含条目清单（F22 的"显示包含内容"要能对上实际文件）', async () => {
  const built = await buildShowcasePack({
    experiment: makeExperiment(), attempts: [makeAttempt(0)], shots: [
      { file: 'shots/a-desktop.png', data: Buffer.from([0x89, 0x50]), viewport: 'desktop', caption: 'A · 桌面', meta: {} },
    ], options: {}, tool: TOOL, now: NOW, readHtml: () => '<html><body>x</body></html>',
    screenshotRecords: [{ id: 'shot_1', status: 'ok', viewport: 'desktop' }],
  });
  const paths = built.manifest.contents.map((c) => c.path).sort();
  const entries = built.entries.map((e) => e.name).filter((n) => n !== 'pack.json').sort();
  assert.deepEqual(paths, entries, '清单里的文件与实际文件必须一一对应');
  assert.ok(paths.includes('shots/a-desktop.png'));
  assert.ok(paths.includes('shots/records.json'));
  assert.equal(built.manifest.privacy.containsRawOutput, false);
});
