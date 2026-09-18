/**
 * A03 的另一半：配方快照与版本 —— **历史配方不被覆盖**（M2）。
 *
 * 依据 PRD F19：配方保存模型引用、提示词、可选参数及说明，每次修改生成版本；
 * 本轮继续引用启动时的快照，不能随着配方后来变化而改变历史。
 *
 * 全部零模型费用（假 llm，走真实 API 与真实存储）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, SCHEMA_VERSION } from '../src/core/store.js';
import { recipeHash, normalizeRecipeContent, sameRecipeContent } from '../src/core/recipe.js';
import { startHarness, call, postJson, newExperiment, waitIdle, asModelOutput } from './lib/arena-harness.js';

const BASE_CFG = {
  name: '候选 A', provider: 'pa', model: 'pa-m1',
  systemPrompt: '你是前端工程师', promptSegments: ['不要用框架'],
  temperature: 0.7, maxTokens: 4096, reasoningEffort: 'low',
};

test('配方只追加版本：改内容生成新版本，历史版本原样保留', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'arena-recipe-'));
  const store = new Store(dir);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

  const created = store.createRecipe({ name: '前端对比配方', note: '第一版', snapshot: BASE_CFG, source: 'manual' });
  assert.equal(created.latestVersion, 1);
  assert.equal(created.versions.length, 1);
  const v1 = created.versions[0];
  assert.equal(v1.version, 1);
  assert.equal(v1.contentHash, recipeHash(BASE_CFG));

  // 改一处（只改系统提示词 —— A03 的原始场景）→ 追加第 2 版
  const changed = { ...BASE_CFG, systemPrompt: '你是资深前端工程师，先想清楚布局' };
  const r2 = store.addRecipeVersion(created.id, { snapshot: changed, note: '改了系统提示词', source: 'manual' });
  assert.equal(r2.ok, true);
  assert.equal(r2.unchanged, false);
  assert.equal(r2.version, 2);

  const after = store.getRecipe(created.id);
  assert.equal(after.latestVersion, 2);
  assert.equal(after.versions.length, 2);

  // 关键断言：第 1 版的**内容与指纹**都没被改写
  const rereadV1 = store.getRecipeVersion(created.id, 1);
  assert.equal(rereadV1.contentHash, v1.contentHash);
  assert.deepEqual(rereadV1.snapshot, normalizeRecipeContent(BASE_CFG));
  assert.equal(rereadV1.snapshot.systemPrompt, '你是前端工程师');
  // 第 2 版是改后的内容
  assert.equal(store.getRecipeVersion(created.id, 2).snapshot.systemPrompt, changed.systemPrompt);
});

test('内容没变就不制造新版本，并如实回报 unchanged', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'arena-recipe-same-'));
  const store = new Store(dir);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

  const created = store.createRecipe({ name: '配方', snapshot: BASE_CFG });
  // 键顺序不同、且带上一堆运行期字段 —— 内容口径相同就不算变化
  const noisy = { reasoningEffort: 'low', maxTokens: 4096, temperature: 0.7, promptSegments: ['不要用框架'], systemPrompt: '你是前端工程师', model: 'pa-m1', provider: 'pa', name: '候选 A', slot: 1, userText: 'xx', requestedAt: 123 };
  const r = store.addRecipeVersion(created.id, { snapshot: noisy });
  assert.equal(r.unchanged, true);
  assert.equal(r.version, 1);
  assert.equal(store.getRecipe(created.id).versions.length, 1);

  // 指纹口径：槽位/时间戳不该影响内容指纹
  assert.equal(recipeHash(BASE_CFG), recipeHash(noisy));
  assert.equal(sameRecipeContent(BASE_CFG, noisy), true);
  assert.equal(sameRecipeContent(BASE_CFG, { ...BASE_CFG, temperature: 0.8 }), false);
});

test('本轮引用启动时的快照：配方后来改了，历史尝试逐字节不变', async (t) => {
  const h = await startHarness({
    streams: { pa: { text: asModelOutput('<html><body>A</body></html>'), chunkDelayMs: 1 }, pb: { text: asModelOutput('<html><body>B</body></html>'), chunkDelayMs: 1 } },
  });
  t.after(() => h.close());

  // 保存配方 v1
  const saved = await postJson(h.base, '/recipes', { name: '对比配方', snapshot: BASE_CFG });
  assert.equal(saved.status, 201);
  const recipeId = saved.body.recipe.id;
  assert.equal(saved.body.version, 1);

  // 用这个配方的第 1 版发起生成（候选只带引用 + 一个不同的槽位名）
  const exp = await newExperiment(h.base, { title: '配方快照' });
  const started = await postJson(h.base, '/experiments/' + exp.id + '/start', {
    concurrency: 1,
    candidates: [
      { recipeId, recipeVersion: 1, name: '甲', provider: 'pa', model: 'pa-m1' },
      { name: '乙', provider: 'pb', model: 'pb-m1' },
    ],
  });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  assert.deepEqual(started.body.recipeLinks[0], { recipeId, recipeVersion: 1 });
  await waitIdle(h.base, exp.id);

  const before = await call(h.base, '/experiments/' + exp.id);
  const att = before.body.attempts.find((a) => a.slot === 0);
  assert.deepEqual(att.recipeLink, { recipeId, recipeVersion: 1 });
  const snapshotBefore = JSON.stringify(att.recipe);
  const hashBefore = recipeHash(att.recipe);
  assert.equal(att.recipe.name, '甲');   // 候选体里的字段优先（"复制配方后只改提示词"）
  assert.equal(att.recipe.systemPrompt, '你是前端工程师'); // 配方里的字段被带进来

  // 现在**改配方**（两版）
  await postJson(h.base, '/recipes/' + recipeId + '/versions', { snapshot: { ...BASE_CFG, systemPrompt: '改过的提示词' }, note: 'v2' });
  await postJson(h.base, '/recipes/' + recipeId + '/versions', { snapshot: { ...BASE_CFG, model: 'pa-m2' }, note: 'v3' });
  const recipe = await call(h.base, '/recipes/' + recipeId);
  assert.equal(recipe.body.recipe.latestVersion, 3);
  assert.equal(recipe.body.recipe.versions.length, 3);

  // 历史实验的尝试：内容与指纹一个字都没变
  const after = await call(h.base, '/experiments/' + exp.id);
  const att2 = after.body.attempts.find((a) => a.slot === 0);
  assert.equal(JSON.stringify(att2.recipe), snapshotBefore);
  assert.equal(recipeHash(att2.recipe), hashBefore);
  assert.equal(att2.recipe.systemPrompt, '你是前端工程师');
  assert.equal(att2.recipe.model, 'pa-m1');

  // 用第 1 版再起一轮：拿到的仍是第 1 版的内容（不会静默升级到最新版）
  const exp2 = await newExperiment(h.base, { title: '再引用第 1 版' });
  const s2 = await postJson(h.base, '/experiments/' + exp2.id + '/start', {
    concurrency: 1,
    candidates: [{ recipeId, recipeVersion: 1, provider: 'pa', model: 'pa-m1' }],
  });
  assert.equal(s2.status, 202, JSON.stringify(s2.body));
  await waitIdle(h.base, exp2.id);
  const detail2 = await call(h.base, '/experiments/' + exp2.id);
  assert.equal(detail2.body.attempts[0].recipe.systemPrompt, '你是前端工程师');
});

test('引用不存在的配方版本：明确拒绝，且不创建任何 attempt', async (t) => {
  const h = await startHarness({ streams: { pa: { text: asModelOutput('<html></html>') } } });
  t.after(() => h.close());

  const exp = await newExperiment(h.base, { title: '坏引用' });
  const r = await postJson(h.base, '/experiments/' + exp.id + '/start', {
    candidates: [{ recipeId: 'rcp_notexist', recipeVersion: 7, provider: 'pa', model: 'pa-m1' }],
  });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /配方版本不存在/);
  assert.equal(h.store.listAttempts(exp.id).length, 0, '被拒绝的请求不能留下半个 attempt');

  // 缺少版本号同样拒绝
  const r2 = await postJson(h.base, '/experiments/' + exp.id + '/start', {
    candidates: [{ recipeId: 'rcp_notexist', provider: 'pa', model: 'pa-m1' }],
  });
  assert.equal(r2.status, 400);
  assert.match(r2.body.error, /没有指定版本号/);
  assert.equal(h.store.listAttempts(exp.id).length, 0);
});

test('从某次尝试保存配方：存的是那一轮的快照，之后改配方不影响它', async (t) => {
  const h = await startHarness({ streams: { pa: { text: asModelOutput('<html><body>ok</body></html>') } } });
  t.after(() => h.close());

  const exp = await newExperiment(h.base, { title: '从尝试保存' });
  await postJson(h.base, '/experiments/' + exp.id + '/start', {
    candidates: [{ name: '甲', provider: 'pa', model: 'pa-m1', systemPrompt: '原始系统提示词' }],
  });
  const detail = await waitIdle(h.base, exp.id);
  const attemptId = detail.attempts[0].id;

  const saved = await postJson(h.base, '/recipes', { name: '来自尝试', fromAttemptId: attemptId });
  assert.equal(saved.status, 201);
  assert.equal(saved.body.recipe.versions[0].snapshot.systemPrompt, '原始系统提示词');
  assert.equal(saved.body.recipe.versions[0].source, 'attempt:' + attemptId);

  // 删掉配方也不影响历史实验（配方是独立对象，PRD 4.1）
  const del = await call(h.base, '/recipes/' + saved.body.recipe.id, { method: 'DELETE' });
  assert.equal(del.status, 200);
  const after = await call(h.base, '/experiments/' + exp.id);
  assert.equal(after.body.attempts[0].recipe.systemPrompt, '原始系统提示词');
});

test('schema 1 → 当前版本迁移：老数据目录原样保留，只补新表与新列', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'arena-migrate-'));
  t.after(() => { rmSync(dir, { recursive: true, force: true }); });

  // 造一个"老库"：schema 版本写 1，且 attempts 表没有配方引用列
  const old = new Store(dir);
  const exp = old.createExperiment({
    title: '旧实验', category: '', taskSnapshot: { prompt: 'p' }, taskHash: 'h',
    outputPolicy: {}, previewPolicy: {},
  });
  const attId = old.createAttempt({
    experimentId: exp.id, candidateSlot: 0, attemptNo: 1,
    recipeSnapshot: BASE_CFG, requestedConfig: {}, resolvedConfig: null, parentAttemptId: null,
  });
  old.db.exec('ALTER TABLE attempts DROP COLUMN recipe_id;');
  old.db.exec('ALTER TABLE attempts DROP COLUMN recipe_version;');
  old.db.prepare('UPDATE meta SET value = ? WHERE key = ?').run('1', 'schema_version');
  old.close();

  // 新版本打开同一个目录
  const migrated = new Store(dir);
  t.after(() => migrated.close());
  assert.equal(migrated.migratedFrom, 1, '要如实报告"这个目录被迁移过"');
  const row = migrated.db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version');
  // 断言"升到当前版本"，而不是写死某一个数字 —— 否则每次加表都要改这条测试，
  // 而它真正要证明的是"老目录能被升到最新并可读"，不是"版本号恰好等于 2"。
  assert.equal(row.value, String(SCHEMA_VERSION));
  const cols = migrated.db.prepare('PRAGMA table_info(attempts)').all().map((c) => c.name);
  assert.ok(cols.includes('recipe_id') && cols.includes('recipe_version'));
  // M3 新增的表也要在迁移后可用（1 → 3 一步到位）
  assert.ok(migrated.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='pack_imports'").get());

  // 老记录没被动过：正文快照、状态都还在
  const att = migrated.getAttempt(attId);
  assert.equal(att.status, 'queued');
  assert.equal(att.recipeId, null);
  assert.deepEqual(att.recipeSnapshot, normalizeRecipeContent(BASE_CFG));
  assert.ok(migrated.getExperiment(exp.id));

  // 再打开一次不会重复迁移，也不报错（幂等）
  migrated.close();
  const again = new Store(dir);
  assert.equal(again.migratedFrom, null);
  again.close();
});

test('schema 2 → 3 迁移：M2 的数据目录升到 M3 后配方与截图记录原样', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'arena-migrate-23-'));
  t.after(() => { rmSync(dir, { recursive: true, force: true }); });

  // 先造一个 M2 形状的库：有配方与截图表，但没有 pack_imports，版本写 2
  const old = new Store(dir);
  const created = old.createRecipe({ name: 'M2 配方', note: null, snapshot: BASE_CFG, source: 'test' });
  const exp = old.createExperiment({
    title: 'M2 实验', category: '', taskSnapshot: { prompt: 'p' }, taskHash: 'h',
    outputPolicy: {}, previewPolicy: {},
  });
  const attId = old.createAttempt({
    experimentId: exp.id, candidateSlot: 0, attemptNo: 1,
    recipeSnapshot: BASE_CFG, requestedConfig: {}, resolvedConfig: null, parentAttemptId: null,
  });
  old.recordScreenshot({ experimentId: exp.id, attemptId: attId, viewport: 'desktop', status: 'ok', reason: null, durationMs: 12, detail: {} });
  old.db.exec('DROP TABLE pack_imports;');
  old.db.prepare('UPDATE meta SET value = ? WHERE key = ?').run('2', 'schema_version');
  const versionHash = old.getRecipe(created.id).versions[0].contentHash;
  const shotCount = old.listScreenshots(exp.id).length;
  old.close();

  const migrated = new Store(dir);
  t.after(() => migrated.close());
  assert.equal(migrated.migratedFrom, 2);
  assert.equal(migrated.db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version').value, String(SCHEMA_VERSION));
  assert.equal(migrated.getRecipe(created.id).versions[0].contentHash, versionHash, '配方内容与指纹不能被迁移改动');
  assert.equal(migrated.listScreenshots(exp.id).length, shotCount);
  // 新表可用：写一条导入记录再读回来
  migrated.recordPackImport({
    experimentId: exp.id, kind: 'retest', schemaVersion: 1, packHash: 'abc',
    sourceTitle: '来源', candidates: [{ slot: 0 }], matches: [{ letter: 'A', status: 'matched' }],
  });
  assert.equal(migrated.getPackImport(exp.id).packHash, 'abc');
  migrated.close();
  const again = new Store(dir);
  assert.equal(again.migratedFrom, null, '再打开一次不该重复迁移');
  again.close();
});
