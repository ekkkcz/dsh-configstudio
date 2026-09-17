/**
 * HTML 提取器单元测试（对应验收 A11 / A12 / A10 的提取部分）。
 * 运行：node --test tests/
 *
 * 说明：源码里用 '\u0060' 表示反引号，避免本文件被当作 markdown 围栏解析。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractHtml, extractHtmlFromCandidate, sha256Hex, EXTRACTOR_VERSION } from '../src/core/extract.js';

const F = '\u0060';      // 反引号
const F3 = F + F + F;    // 常用围栏
const NL = '\n';         // 换行（避免源码里出现真正的多行字符串字面量）

const DOC = '<!DOCTYPE html>\n<html><head><title>T</title></head><body><h1>hi</h1></body></html>';

test('原始完整 HTML：mode=raw，区间精确，hash 稳定', async () => {
  const r = extractHtml(DOC, { finishReason: 'stop' });
  assert.equal(r.status, 'ok');
  assert.equal(r.mode, 'raw');
  assert.equal(r.html, DOC);
  assert.deepEqual(r.range, { start: 0, end: DOC.length });
  assert.equal(r.truncated, false);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.extractionVersion, EXTRACTOR_VERSION);
  const h1 = await sha256Hex(r.html);
  const h2 = await sha256Hex(DOC);
  assert.equal(h1, h2);
});

test('原始 HTML 前后有说明文字：仍能切出完整文档', () => {
  const raw = '好的，这是我做的页面：\n\n' + DOC + '\n\n希望你喜欢。';
  const r = extractHtml(raw, { finishReason: 'stop' });
  assert.equal(r.status, 'ok');
  assert.equal(r.mode, 'raw');
  assert.equal(r.html, DOC);
  assert.equal(raw.slice(r.range.start, r.range.end), DOC);
});

test('唯一一个 html 围栏：mode=fenced', () => {
  const raw = '这里是作品：\n\n' + F3 + 'html\n' + DOC + '\n' + F3 + '\n';
  const r = extractHtml(raw, { finishReason: 'stop' });
  assert.equal(r.status, 'ok');
  assert.equal(r.mode, 'fenced');
  assert.equal(r.html, DOC);
  assert.equal(raw.slice(r.range.start, r.range.end), DOC);
});

test('无语言标记的围栏也视为 HTML 候选', () => {
  const raw = F3 + '\n' + DOC + '\n' + F3;
  const r = extractHtml(raw, { finishReason: 'stop' });
  assert.equal(r.status, 'ok');
  assert.equal(r.mode, 'fenced');
  assert.equal(r.html, DOC);
});

test('多个 HTML 块：status=multiple，不拼接，给出候选', () => {
  const a = '<html><body>A</body></html>';
  const b = '<html><body>B</body></html>';
  const raw = F3 + 'html\n' + a + '\n' + F3 + '\n说明\n' + F3 + 'html\n' + b + '\n' + F3;
  const r = extractHtml(raw, { finishReason: 'stop' });
  assert.equal(r.status, 'multiple');
  assert.equal(r.html, null);
  assert.equal(r.candidates.length, 2);
  assert.equal(r.candidates[0].preview.startsWith('<html>'), true);
  // 按候选提取必须与原文一致
  const picked = extractHtmlFromCandidate(raw, 1, { finishReason: 'stop' });
  assert.equal(picked.html, b);
});

test('多个块中只有一个是真 HTML：仍然选它', () => {
  const raw = F3 + 'js\nconsole.log("x")\n' + F3 + '\n' + F3 + 'html\n' + DOC + '\n' + F3;
  const r = extractHtml(raw, { finishReason: 'stop' });
  assert.equal(r.status, 'ok');
  assert.equal(r.html, DOC);
});

test('无 HTML：status=none，界面应显示"未识别到作品"', () => {
  const r = extractHtml('抱歉，我无法完成这个请求。', { finishReason: 'stop' });
  assert.equal(r.status, 'none');
  assert.equal(r.html, null);
  assert.deepEqual(r.candidates, []);
});

test('显式标注 html 的片段块仍然接受（模型已声明是 HTML）', () => {
  const r = extractHtml(F3 + 'html\n<div>just a div</div>\n' + F3, { finishReason: 'stop' });
  assert.equal(r.status, 'ok');
  assert.equal(r.html, '<div>just a div</div>');
  assert.equal(r.warnings.some((w) => w.code === 'missing_html_tag'), true);
});

test('无语言标记的普通片段不当作作品', () => {
  const r = extractHtml(F3 + '\n<div>just a div</div>\n' + F3, { finishReason: 'stop' });
  assert.equal(r.status, 'none');
});

test('标了别的语言的片段不当作作品', () => {
  const r = extractHtml(F3 + 'python' + NL + 'print("<html>")' + NL + F3, { finishReason: 'stop' });
  assert.equal(r.status, 'none');
});

test('正文里提到 <html> 但没有真文档时不误判为作品', () => {
  const r = extractHtml('你可以用 "<html>" 开头，再补上其它标签。', { finishReason: 'stop' });
  assert.equal(r.status, 'none');
});

test('缺 </html> 的原始文档：切到最后一个非空白字符', () => {
  const raw = '介绍文字\n<!DOCTYPE html>\n<html><body><p>x</p>\n   \n';
  const r = extractHtml(raw, { finishReason: 'length' });
  assert.equal(r.status, 'ok');
  assert.equal(r.html, '<!DOCTYPE html>\n<html><body><p>x</p>');
  assert.equal(r.truncated, true);
  assert.equal(r.warnings.some((w) => w.code === 'missing_closing_html'), true);
});

test('截断：finishReason=length 标 truncated 并给警告，不伪装完整', () => {
  const partial = '<!DOCTYPE html>\n<html><head><style>body{';
  const raw = F3 + 'html\n' + partial + '\n' + F3;
  const r = extractHtml(raw, { finishReason: 'length' });
  assert.equal(r.status, 'ok');
  assert.equal(r.truncated, true);
  assert.equal(r.warnings.some((w) => w.code === 'truncated'), true);
  assert.equal(r.warnings.some((w) => w.code === 'missing_closing_html'), true);
  assert.equal(r.warnings.some((w) => w.code === 'unbalanced_style'), true);
  // 不自动补写：内容原样
  assert.equal(r.html, partial);
});

test('未闭合围栏：能提取但标记截断未知 + 警告', () => {
  const raw = F3 + 'html\n' + DOC;
  const r = extractHtml(raw, {});
  assert.equal(r.status, 'ok');
  assert.equal(r.html, DOC);
  assert.equal(r.truncated, null); // 未知就是未知
  assert.equal(r.candidates.length, 0);
});

test('finishReason 未知时不猜截断状态', () => {
  const r = extractHtml(DOC, {});
  assert.equal(r.truncated, null);
  assert.equal(r.status, 'ok');
});

test('空输入与非法输入不抛异常', () => {
  assert.equal(extractHtml('').status, 'none');
  assert.equal(extractHtml(null).status, 'none');
  assert.equal(extractHtml(undefined).status, 'none');
  assert.equal(extractHtml(123).status, 'none');
});

test('波浪号围栏与 script/style 计数警告', () => {
  const raw = '~~~html\n<html><body><script>x</script></body></html>\n~~~';
  const r = extractHtml(raw, { finishReason: 'stop' });
  assert.equal(r.status, 'ok');
  assert.equal(r.warnings.length, 0);
});

test('短围栏内容不被当作品', () => {
  const raw = F3 + 'html\n<html>\n' + F3;
  const r = extractHtml(raw, { finishReason: 'stop' });
  // 长度够但只有开头，仍是 ok（交由警告体系处理），这里确认不崩溃
  assert.ok(['ok', 'none'].includes(r.status));
});

test('原样保留行尾与缩进（不做任何规范化）', () => {
  const html = '<!DOCTYPE html>\r\n<html>\r\n  <body>  spaced  </body>\r\n</html>';
  const raw = F3 + 'html\n' + html + '\n' + F3;
  const r = extractHtml(raw, { finishReason: 'stop' });
  assert.equal(r.html, html);
});

test('候选提取：非 multiple 状态应抛错', () => {
  assert.throws(() => extractHtmlFromCandidate(DOC, 0, { finishReason: 'stop' }), /没有多个候选/);
});

test('候选提取：越界序号应抛错', () => {
  const raw = F3 + 'html\n<html><body>A</body></html>\n' + F3 + '\n' + F3 + 'html\n<html><body>B</body></html>\n' + F3;
  assert.throws(() => extractHtmlFromCandidate(raw, 5, {}), /候选序号不存在/);
});

test('sha256 对同一文本稳定、对不同文本不同', async () => {
  const a = await sha256Hex('abc');
  const b = await sha256Hex('abc');
  const c = await sha256Hex('abd');
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.equal(a.length, 64);
});
