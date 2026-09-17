/**
 * 回归测试：取消 / 失败的真实原因不能被后续诊断覆盖。
 *
 * 来源：M0 真实调用验证中，取消一个候选后它的 errorCode 被
 * "推理吃光预算" 的诊断改写成了 EMPTY_RESPONSE，掩盖了 ABORTED。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/core/store.js';
import { explainError } from '../src/core/runner.js';

/** 复刻生产代码里的判定：只有 completed 且无正文时才给出该诊断。 */
function diagnosticFor(result) {
  if (result.status !== 'completed') return result.receipt.error?.code ?? null;
  if ((result.text ?? '').length === 0 && (result.reasoning ?? '').length > 0) return 'EMPTY_RESPONSE';
  return null;
}

function mk() {
  const dir = mkdtempSync(join(tmpdir(), 'arena-diag-'));
  const store = new Store(dir);
  return { store, dir };
}
function cleanup(dir) { for (let i = 0; i < 3; i += 1) { try { rmSync(dir, { recursive: true, force: true }); return; } catch { /* retry */ } } }

test('取消：errorCode 保持 ABORTED，不被诊断覆盖', () => {
  const { store, dir } = mk();
  const e = store.createExperiment({ title: 't', category: '', taskSnapshot: {}, taskHash: 'h', outputPolicy: {}, previewPolicy: {} });
  const att = store.createAttempt({ experimentId: e.id, candidateSlot: 0, attemptNo: 1, recipeSnapshot: {}, requestedConfig: {} });
  store.updateAttemptStatus(att, 'cancelled');
  const code = diagnosticFor({ status: 'cancelled', text: '', reasoning: '很长的推理', receipt: { error: { code: 'ABORTED' } } });
  assert.equal(code, 'ABORTED');
  store.finishReceipt(att, { finishReason: 'aborted', errorCode: code, usage: null, observedRequests: 1 });
  const got = store.getAttempt(att);
  assert.equal(got.status, 'cancelled');
  assert.equal(got.receipt.errorCode, 'ABORTED');
  assert.equal(got.receipt.usage, null, '取消时未上报的用量保持 null');
  assert.equal(explainError({ code: got.receipt.errorCode }).title.includes('取消'), true, '取消要翻译成人能读懂的话');
  store.close(); cleanup(dir);
});

test('失败：provider 错误码优先于诊断', () => {
  const code = diagnosticFor({ status: 'failed', text: '', reasoning: 'x', receipt: { error: { code: 'AUTH' } } });
  assert.equal(code, 'AUTH');
});

test('完成但无正文：才给出推理吃光预算的诊断', () => {
  const code = diagnosticFor({ status: 'completed', text: '', reasoning: '很长的推理', receipt: { error: null } });
  assert.equal(code, 'EMPTY_RESPONSE');
  assert.ok(explainError({ code }).hint.includes('输出预算'));
});

test('完成且有正文：不给诊断', () => {
  const code = diagnosticFor({ status: 'completed', text: '<html></html>', reasoning: 'x', receipt: { error: null } });
  assert.equal(code, null);
});

test('完成但无正文也无推理：不误报为推理问题', () => {
  const code = diagnosticFor({ status: 'completed', text: '', reasoning: '', receipt: { error: null } });
  assert.equal(code, null, '没有推理就不该说"推理吃光预算"');
});
