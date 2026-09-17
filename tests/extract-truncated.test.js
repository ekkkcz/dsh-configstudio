/**
 * 补充：真实模型场景下的截断提取（来自 M0 真实调用观察）。
 *
 * 观察：推理型模型在被 max_tokens 截断时，常常只输出了代码围栏的开头。
 * 此时不应报"未识别到作品"，而应给出能拿到的部分并明确标注截断。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractHtml } from '../src/core/extract.js';

const F3 = String.fromCharCode(96).repeat(3);

test('仅围栏开头（真实截断场景）：如实报告截断', () => {
  const raw = F3 + 'html';
  const r = extractHtml(raw, { finishReason: 'max_tokens' });
  assert.equal(r.truncated, true);
  assert.ok(['none', 'ok'].includes(r.status));
});

test('截断但有 HTML 特征：保留半成品而不是报没有作品', () => {
  const partial = F3 + 'html' + String.fromCharCode(10) + '<!DOCTYPE html>' + String.fromCharCode(10) + '<html>' + String.fromCharCode(10) + '<head><style>body{color:red';
  const r = extractHtml(partial, { finishReason: 'max_tokens' });
  assert.equal(r.status, 'ok', '应当保留能拿到的部分');
  assert.equal(r.truncated, true);
  assert.ok(r.html.includes('color:red'), '内容要原样保留，不补写');
  assert.ok(r.warnings.some((w) => w.code === 'truncated'));
  assert.ok(r.warnings.some((w) => w.code === 'missing_closing_html'));
});

test('未闭合围栏且有 body 标签：也保留', () => {
  const raw = F3 + 'html' + String.fromCharCode(10) + '<body><h1>半成品</h1>';
  const r = extractHtml(raw, { finishReason: 'length' });
  assert.equal(r.status, 'ok');
  assert.equal(r.html, '<body><h1>半成品</h1>');
});

test('未闭合围栏但内容是纯说明文字：不当作作品', () => {
  const raw = F3 + 'html' + String.fromCharCode(10) + '抱歉，我需要更多信息才能继续。';
  const r = extractHtml(raw, { finishReason: 'length' });
  assert.equal(r.status, 'none');
});
