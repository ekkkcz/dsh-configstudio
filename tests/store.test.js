/**
 * 存储层测试（对应 A06 的部分、A09 的恢复、A29 的 schema 守卫）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, newId, newToken, SCHEMA_VERSION } from '../src/core/store.js';

/** 临时目录清理是尽力而为：Windows 上残留目录不应让测试失败。 */
function cleanup(dir) {
  for (let i = 0; i < 3; i += 1) {
    try { rmSync(dir, { recursive: true, force: true }); return; } catch { /* 稍后重试 */ }
  }
}

function freshStore() {
  const dir = mkdtempSync(join(tmpdir(), 'arena-test-'));
  return { store: new Store(dir), dir };
}

test('ID 由服务端生成且带类型前缀', () => {
  const a = newId('exp');
  const b = newId('exp');
  assert.notEqual(a, b);
  assert.ok(a.startsWith('exp_'));
  assert.equal(newToken().length, 32);
});

test('实验创建、读取与列表', () => {
  const { store, dir } = freshStore();
  const e = store.createExperiment({
    title: '天气仪表盘', category: 'dashboard',
    taskSnapshot: { prompt: '做一个天气仪表盘' }, taskHash: 'abc',
    outputPolicy: { maxTokens: 8000 }, previewPolicy: { networkPolicy: 'offline' },
  });
  assert.ok(e.id.startsWith('exp_'));
  assert.equal(e.title, '天气仪表盘');
  assert.equal(e.taskHash, 'abc');
  assert.deepEqual(e.taskSnapshot, { prompt: '做一个天气仪表盘' });

  const got = store.getExperiment(e.id);
  assert.deepEqual(got.previewPolicy, { networkPolicy: 'offline' });

  store.createExperiment({ title: '落地页', category: 'landing', taskSnapshot: {}, taskHash: 'h', outputPolicy: {}, previewPolicy: {} });
  assert.equal(store.listExperiments().length, 2);
  assert.equal(store.listExperiments({ search: '天气' }).length, 1);
  assert.equal(store.listExperiments({ category: 'landing' }).length, 1);
  assert.equal(store.listExperiments({ search: '不存在' }).length, 0);

  store.close();
  cleanup(dir);
});

test('原始正文文件落盘并给出稳定 hash；HTML 作为派生作品单独存放', async () => {
  const { store, dir } = freshStore();
  const e = store.createExperiment({ title: 't', category: '', taskSnapshot: {}, taskHash: 'h', outputPolicy: {}, previewPolicy: {} });
  const att = store.createAttempt({ experimentId: e.id, candidateSlot: 0, attemptNo: 1, recipeSnapshot: {}, requestedConfig: {} });

  const rawText = '前置说明\n<html><body>hello</body></html>';
  const html = '<html><body>hello</body></html>';
  const raw = await store.writeRaw(att, rawText);
  const h = await store.writeHtml(att, html);
  assert.notEqual(raw.hash, h.hash, '原文 hash 与 HTML hash 必须不同（F06）');
  assert.equal(raw.bytes, Buffer.byteLength(rawText, 'utf8'));

  store.createArtifact({
    id: att, attemptId: att, rawHash: raw.hash, htmlHash: h.hash,
    extractionVersion: '1', extractionMode: 'raw', extractionRange: { start: 5, end: 5 + html.length },
    extractionStatus: 'ok', extractionWarnings: [], rawPath: raw.path, htmlPath: h.path, bytes: raw.bytes,
  });

  const got = store.getAttempt(att);
  assert.equal(got.artifact.rawTextHash, raw.hash);
  assert.equal(got.artifact.htmlHash, h.hash);
  assert.deepEqual(got.artifact.extractionRange, { start: 5, end: 5 + html.length });
  assert.equal(store.readRaw(att), rawText);
  assert.equal(store.readHtml(att), html);
  assert.equal(store.hasHtml(att), true);

  store.close();
  cleanup(dir);
});

test('收据时间戳按顺序记录，未知字段被拒绝', () => {
  const { store, dir } = freshStore();
  const e = store.createExperiment({ title: 't', category: '', taskSnapshot: {}, taskHash: 'h', outputPolicy: {}, previewPolicy: {} });
  const att = store.createAttempt({ experimentId: e.id, candidateSlot: 0, attemptNo: 1, recipeSnapshot: {}, requestedConfig: {} });
  const now = Date.now();
  store.stampReceipt(att, 'started_at', now);
  store.stampReceipt(att, 'first_text_at', now + 10);
  assert.throws(() => store.stampReceipt(att, 'usage', 'x'), /不允许写入/);
  store.finishReceipt(att, { finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 20 }, observedRequests: 1 });
  const got = store.getAttempt(att);
  assert.equal(got.receipt.finishReason, 'stop');
  assert.deepEqual(got.receipt.usage, { inputTokens: 10, outputTokens: 20 });
  assert.equal(got.receipt.queuedAt > 0, true);
  store.close();
  cleanup(dir);
});

test('用量缺失保存为 null，不伪造 0（A18）', () => {
  const { store, dir } = freshStore();
  const e = store.createExperiment({ title: 't', category: '', taskSnapshot: {}, taskHash: 'h', outputPolicy: {}, previewPolicy: {} });
  const att = store.createAttempt({ experimentId: e.id, candidateSlot: 0, attemptNo: 1, recipeSnapshot: {}, requestedConfig: {} });
  store.finishReceipt(att, { finishReason: 'stop', usage: null, observedRequests: null });
  const got = store.getAttempt(att);
  assert.equal(got.receipt.usage, null);
  assert.equal(got.receipt.observedRequests, null);
  store.close();
  cleanup(dir);
});

test('未完成尝试保留为 interrupted，已完成的可恢复（A09）', () => {
  const { store, dir } = freshStore();
  const e = store.createExperiment({ title: 't', category: '', taskSnapshot: {}, taskHash: 'h', outputPolicy: {}, previewPolicy: {} });
  const a1 = store.createAttempt({ experimentId: e.id, candidateSlot: 0, attemptNo: 1, recipeSnapshot: {}, requestedConfig: {} });
  const a2 = store.createAttempt({ experimentId: e.id, candidateSlot: 1, attemptNo: 1, recipeSnapshot: {}, requestedConfig: {} });
  store.updateAttemptStatus(a1, 'completed');
  store.finishReceipt(a1, { finishReason: 'stop' });
  store.updateAttemptStatus(a2, 'running');

  // 模拟宿主重启：找 running 的标记 interrupted，已完成的保持
  const running = store.listAttempts(e.id).filter((a) => a.status === 'running');
  assert.equal(running.length, 1);
  for (const a of running) store.updateAttemptStatus(a.id, 'interrupted');

  const after = store.listAttempts(e.id);
  assert.equal(after.find((a) => a.id === a1).status, 'completed');
  assert.equal(after.find((a) => a.id === a2).status, 'interrupted');
  store.close();
  cleanup(dir);
});

test('删除实验会移除记录与作品文件，但配方表不受影响', async () => {
  const { store, dir } = freshStore();
  const e = store.createExperiment({ title: 't', category: '', taskSnapshot: {}, taskHash: 'h', outputPolicy: {}, previewPolicy: {} });
  const att = store.createAttempt({ experimentId: e.id, candidateSlot: 0, attemptNo: 1, recipeSnapshot: {}, requestedConfig: {} });
  const raw = await store.writeRaw(att, '<html></html>');
  store.createArtifact({ id: att, attemptId: att, rawHash: raw.hash, extractionStatus: 'none', rawPath: raw.path, bytes: raw.bytes });
  assert.equal(store.getAttempt(att) !== null, true);

  store.deleteExperiment(e.id);
  assert.equal(store.getExperiment(e.id), null);
  assert.equal(store.getAttempt(att), null);
  store.close();
  cleanup(dir);
});

test('schema 版本守卫：未来版本的数据目录拒绝打开（A29）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'arena-test-'));
  const s1 = new Store(dir);
  s1.db.prepare('UPDATE meta SET value = ? WHERE key = ?').run(String(SCHEMA_VERSION + 5), 'schema_version');
  s1.close();
  assert.throws(() => new Store(dir), /更新版本的 HTML Arena/);
  cleanup(dir);
});

test('投票保存与揭晓', () => {
  const { store, dir } = freshStore();
  const e = store.createExperiment({ title: 't', category: '', taskSnapshot: {}, taskHash: 'h', outputPolicy: {}, previewPolicy: {} });
  store.saveVote({ experimentId: e.id, anonymousMapping: { A: 'att_1', B: 'att_2' }, choice: 'A', tags: ['视觉'], note: '更清爽' });
  let v = store.getVote(e.id);
  assert.equal(v.choice, 'A');
  assert.equal(v.revealedAt, null);
  assert.deepEqual(v.tags, ['视觉']);
  store.revealVote(e.id);
  v = store.getVote(e.id);
  assert.ok(v.revealedAt > 0);
  // 重复保存是更新而非新增
  store.saveVote({ experimentId: e.id, anonymousMapping: { A: 'att_1', B: 'att_2' }, choice: 'B' });
  assert.equal(store.getVote(e.id).choice, 'B');
  store.close();
  cleanup(dir);
});
