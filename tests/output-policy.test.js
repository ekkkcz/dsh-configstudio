/**
 * 运行上限（PRD F04"可调整的超时"）—— 默认值、可选项、以及"改上限真的生效"的回归。
 *
 * 这一组测试存在的理由是一个**真实缺口**：超时提示写着"调大该候选的运行上限"，
 * 而界面上根本没有那个控件（defaultTimeoutMs 写死在 src/index.js，只有手写 API 才改得动）。
 * 所以这里不只测"接口收得下这个字段"，更要钉住三件事：
 *  ① 默认值**跟着思考档位走**（开高档的模型首正文可能等两分钟以上，3 分钟本来就不够）；
 *  ② 改了上限，下一次真的按新的等（并且历史尝试记的仍是它当时的值）；
 *  ③ 非法值明确拒绝，不静默替换成别的数。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_TIMEOUT_MS, TIMEOUT_CHOICES, TIMEOUT_MIN_MS, TIMEOUT_MAX_MS,
  clampTimeoutMs, effectiveDefaultTimeout, formatMs, normalizeEffortId, timeoutPolicyView,
} from '../src/core/output-policy.js';
import { startHarness, call, postJson, newExperiment, waitIdle, asModelOutput } from './lib/arena-harness.js';

test('运行上限的口径只有一份：默认值、档位门槛、区间都从同一个模块来', () => {
  const view = timeoutPolicyView();
  assert.equal(view.defaultMs, DEFAULT_TIMEOUT_MS);
  assert.equal(DEFAULT_TIMEOUT_MS, 180000, '默认 3 分钟（与 0.6.0 行为一致）');
  assert.deepEqual(view.choices.map((c) => c.ms), TIMEOUT_CHOICES.map((c) => c.ms));
  assert.ok(view.choices.every((c) => typeof c.label === 'string' && c.label.length > 0));
  assert.equal(view.minMs, TIMEOUT_MIN_MS);
  assert.equal(view.maxMs, TIMEOUT_MAX_MS);
  // 界面下拉要能覆盖"推理档位开很高"的情形
  assert.ok(view.choices.some((c) => c.ms >= 1800000), '至少有一档到 30 分钟以上');
});

test('默认值跟着思考档位走：没档位仍是 3 分钟，开了高档就抬上去', () => {
  assert.equal(effectiveDefaultTimeout([]).timeMs, DEFAULT_TIMEOUT_MS);
  assert.equal(effectiveDefaultTimeout([{}]).timeMs, DEFAULT_TIMEOUT_MS);
  assert.equal(effectiveDefaultTimeout([{ reasoningEffort: null }]).timeMs, DEFAULT_TIMEOUT_MS);
  // low / off 不需要为推理额外预留时间 —— 不能因为"选了档位"就一律变慢
  assert.equal(effectiveDefaultTimeout([{ reasoningEffort: 'low' }]).timeMs, DEFAULT_TIMEOUT_MS);
  assert.equal(effectiveDefaultTimeout([{ reasoningEffort: 'off' }]).timeMs, DEFAULT_TIMEOUT_MS);

  const high = effectiveDefaultTimeout([{ reasoningEffort: 'high' }]);
  assert.equal(high.elevated, true);
  assert.equal(high.timeMs, 600000, 'high → 至少 10 分钟');
  assert.match(high.reason, /推理/);

  const max = effectiveDefaultTimeout([{ reasoningEffort: 'max' }]);
  assert.equal(max.timeMs, 900000, 'max → 至少 15 分钟');
  assert.equal(max.maxEffort, 'max');

  // 多候选取最高的那一档，且只上不下
  const mixed = effectiveDefaultTimeout([{ reasoningEffort: 'max' }, { reasoningEffort: 'low' }]);
  assert.equal(mixed.timeMs, 900000);
  assert.equal(mixed.elevated, true);
});

test('认不出的档位不猜：不因为有字符串就抬默认值（A04 的同一原则）', () => {
  assert.equal(normalizeEffortId('balanced-ish'), null);
  assert.equal(normalizeEffortId(''), null);
  assert.equal(normalizeEffortId(null), null);
  const r = effectiveDefaultTimeout([{ reasoningEffort: 'balanced-ish' }]);
  assert.equal(r.timeMs, DEFAULT_TIMEOUT_MS, '认不出就不动默认值');
  assert.equal(r.elevated, false);
  // 大小写与常见别名要认（provider 之间写法不一致）
  assert.equal(normalizeEffortId('HIGH'), 'high');
  assert.equal(normalizeEffortId('max'), 'max');
  assert.equal(normalizeEffortId('medium'), 'medium');
});

test('钳制：0 / 负数 / 小数 / 超上限一律判为非法，不猜一个数顶上', () => {
  assert.equal(clampTimeoutMs(180000), 180000);
  assert.equal(clampTimeoutMs(TIMEOUT_MIN_MS), TIMEOUT_MIN_MS);
  assert.equal(clampTimeoutMs(TIMEOUT_MAX_MS), TIMEOUT_MAX_MS);
  for (const bad of [0, -1, 1.5, TIMEOUT_MAX_MS + 1, 'abc', {}, [], NaN, Infinity, null, undefined, '']) {
    assert.equal(clampTimeoutMs(bad), null, '非法值必须返回 null：' + JSON.stringify(bad));
  }
  // 数字字符串仍然接受（表单传过来就是字符串）
  assert.equal(clampTimeoutMs('300000'), 300000);
  assert.equal(formatMs(180000), '3 分钟');
  // 秒级的值保留一位小数：去整会把 1.2 秒写成"1 秒"，而超时提示要拿它跟界面对账
  assert.equal(formatMs(1500), '1.5 秒');
  assert.equal(formatMs(1200), '1.2 秒');
  assert.equal(formatMs(2000), '2 秒');
  assert.equal(formatMs(90000), '1.5 分钟');
});

test('建实验：不给就用默认值；给了非法值**明确拒绝**而不是悄悄换成默认值', async (t) => {
  const h = await startHarness({ streams: { pa: { text: asModelOutput('<html></html>') } } });
  t.after(() => h.close());

  // harness 自己的默认值就是它传进去的那个（别把"宿主配置"和"模块默认值"混为一谈）
  const def = await newExperiment(h.base, { title: '默认上限' });
  assert.equal(def.outputPolicy.timeoutMs, 60000);
  assert.equal(DEFAULT_TIMEOUT_MS, 180000, '不传配置时插件用的默认值就是它');

  const ok = await newExperiment(h.base, { title: '指定上限', outputPolicy: { timeoutMs: 600000 } });
  assert.equal(ok.outputPolicy.timeoutMs, 600000);

  for (const bad of [0, -5, 12.5, TIMEOUT_MAX_MS + 1]) {
    const r = await postJson(h.base, '/experiments', { title: '非法上限', prompt: 'x', outputPolicy: { timeoutMs: bad } });
    assert.equal(r.status, 400, '非法上限必须被拒绝：' + bad);
    assert.match(r.body.error, /运行上限/);
    assert.equal(r.body.field, 'outputPolicy.timeoutMs');
  }
});

test('改运行上限：真的改到实验上，且不碰题目指纹与候选快照', async (t) => {
  const h = await startHarness({
    streams: { pa: { text: asModelOutput('<html><body>ok</body></html>') } },
    defaultTimeoutMs: 60000,
  });
  t.after(() => h.close());

  const exp = await newExperiment(h.base, { title: '改上限' });
  assert.equal(exp.outputPolicy.timeoutMs, 60000);

  const before = await call(h.base, '/experiments/' + exp.id);
  const r = await postJson(h.base, '/experiments/' + exp.id + '/output-policy', { timeoutMs: 900000 });
  assert.equal(r.status, 200);
  assert.equal(r.body.before, 60000);
  assert.equal(r.body.after, 900000);
  assert.equal(r.body.changed, true);
  assert.equal(r.body.experiment.outputPolicy.timeoutMs, 900000);
  // 只有上限变了 —— 题目、预览策略、候选与指纹一个都不能动
  assert.equal(r.body.experiment.taskHash, before.body.experiment.taskHash);
  assert.deepEqual(r.body.experiment.taskSnapshot, before.body.experiment.taskSnapshot);
  assert.equal(r.body.experiment.outputPolicy.concurrency, before.body.experiment.outputPolicy.concurrency);

  const bad = await postJson(h.base, '/experiments/' + exp.id + '/output-policy', { timeoutMs: 0 });
  assert.equal(bad.status, 400);
  const after = await call(h.base, '/experiments/' + exp.id);
  assert.equal(after.body.experiment.outputPolicy.timeoutMs, 900000, '被拒绝的改动不能落地');
});

test('两次尝试记下**各自当时**的运行上限：改上限不会篡改历史记录', async (t) => {
  const h = await startHarness({
    streams: { pa: { text: asModelOutput('<html><body>round</body></html>'), chunkDelayMs: 5 } },
    defaultTimeoutMs: 60000,
  });
  t.after(() => h.close());

  const exp = await newExperiment(h.base, { title: '历史上限', outputPolicy: { timeoutMs: 60000 } });
  await postJson(h.base, '/experiments/' + exp.id + '/start', {
    candidates: [{ name: 'A', provider: 'pa', model: 'pa-m1' }],
  });
  const d1 = await waitIdle(h.base, exp.id);
  const firstId = d1.attempts[0].id;
  assert.equal(d1.attempts[0].timeoutMs, 60000, '第一次尝试记的是它当时用的上限');

  // 用户看了超时提示之后把上限调大，再重试这一个候选
  await postJson(h.base, '/experiments/' + exp.id + '/output-policy', { timeoutMs: 600000 });
  const retry = await postJson(h.base, '/experiments/' + exp.id + '/attempts/' + firstId + '/retry', {});
  assert.equal(retry.status, 202);
  assert.equal(retry.body.timeoutMs, 600000, '重试回执里带回这次真正用的上限');

  const d2 = await waitIdle(h.base, exp.id);
  const first = d2.attempts.find((a) => a.id === firstId);
  const second = d2.attempts.find((a) => a.id === retry.body.attemptId);
  assert.equal(first.timeoutMs, 60000, '历史尝试的上限**不被后来的改动改写**');
  assert.equal(second.timeoutMs, 600000);
  assert.equal(d2.experiment.outputPolicy.timeoutMs, 600000);
});

test('重试可以只给这一次换上限：不传就跟着实验走，传了非法值明确拒绝', async (t) => {
  const h = await startHarness({
    streams: { pa: { text: asModelOutput('<html><body>x</body></html>'), chunkDelayMs: 5 } },
    defaultTimeoutMs: 60000,
  });
  t.after(() => h.close());

  const exp = await newExperiment(h.base, { title: '重试覆盖', outputPolicy: { timeoutMs: 60000 } });
  await postJson(h.base, '/experiments/' + exp.id + '/start', {
    candidates: [{ name: 'A', provider: 'pa', model: 'pa-m1' }],
  });
  const d1 = await waitIdle(h.base, exp.id);
  const firstId = d1.attempts[0].id;

  // 只给这一次重试一个更宽的上限，实验级的值不动
  const r = await postJson(h.base, '/experiments/' + exp.id + '/attempts/' + firstId + '/retry', { timeoutMs: 300000 });
  assert.equal(r.status, 202);
  assert.equal(r.body.timeoutMs, 300000);
  const d2 = await waitIdle(h.base, exp.id);
  assert.equal(d2.attempts.find((a) => a.id === r.body.attemptId).timeoutMs, 300000);
  assert.equal(d2.experiment.outputPolicy.timeoutMs, 60000, '实验级的上限不因为单次覆盖而改变');

  const bad = await postJson(h.base, '/experiments/' + exp.id + '/attempts/' + firstId + '/retry', { timeoutMs: -1 });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /运行上限/);
});

/** 一段足够长的正文：分块之间有间隔，保证"上限设小了就跑不完"是真发生的（不是靠等超时）。 */
function longBody(marker) {
  return '<html><body><h1>' + marker + '</h1><p>' + 'x'.repeat(3000) + '</p></body></html>';
}

test('超时提示指路：说出这次等了多久、去哪儿改，且指向真实存在的控件', async (t) => {
  const h = await startHarness({
    streams: { pa: { text: asModelOutput(longBody('slow')), chunkDelayMs: 60, honorAbort: true } },
    defaultTimeoutMs: 60000,
  });
  t.after(() => h.close());

  const exp = await newExperiment(h.base, { title: '超时提示', outputPolicy: { timeoutMs: 250 } });
  await postJson(h.base, '/experiments/' + exp.id + '/start', {
    candidates: [{ name: '慢的', provider: 'pa', model: 'pa-m1' }],
  });
  const d = await waitIdle(h.base, exp.id);
  const a = d.attempts[0];
  assert.equal(a.status, 'timed_out');
  // 这条提示以前让人"去调大一个界面上不存在的值"。现在必须：① 说出实际值；② 指到哪里改。
  assert.match(a.error.hint, /250 毫秒|0\.3 分钟|0 分钟/);
  assert.match(a.error.hint, /新建对比/);
  assert.match(a.error.hint, /运行上限/);
  // 提示指向的那个控件必须真的存在于界面上（"说了但做不到"就是这次要修的缺口）
  const { readFileSync } = await import('node:fs');
  const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  assert.ok(html.includes('id="timeout"'), '提示指向的「运行上限」下拉必须真的在新建对比页上');
  assert.ok(html.includes('id="compare-timeout"'), '对比页上也要能就地改（用户看到提示的地方）');
});

test('验收断言：上限短的跑不完，给足时间的同一个候选跑得完', async (t) => {
  // 同一条内容、同一个模拟 provider；只改运行上限，结果必须不同 ——
  // 这就是"改运行上限真的生效"这条验收的判据（零费用，模拟模型）。
  const slow = { text: asModelOutput(longBody('慢的')), chunkDelayMs: 90, honorAbort: true };
  const h = await startHarness({ streams: { pa: slow }, defaultTimeoutMs: 60000 });
  t.after(() => h.close());

  // ① 上限设小：必然超时
  const shortExp = await newExperiment(h.base, { title: '上限 0.6 秒', outputPolicy: { timeoutMs: 600 } });
  await postJson(h.base, '/experiments/' + shortExp.id + '/start', {
    candidates: [{ name: '慢的', provider: 'pa', model: 'pa-m1' }],
  });
  const shortDone = await waitIdle(h.base, shortExp.id, 30000);
  assert.equal(shortDone.attempts[0].status, 'timed_out');
  // 注意：这里**不**断言"没有作品"—— 被中止时刚好收完一整块 HTML 是有可能的，
  // 那件事由"超时也要保留已收到的正文"那一组测试负责。这条只测"上限到了就停"。
  assert.ok(shortDone.attempts[0].receipt.finishReason === 'timeout');

  // ② 上限给足：同一条内容能跑完
  const longExp = await newExperiment(h.base, { title: '上限 30 秒', outputPolicy: { timeoutMs: 30000 } });
  await postJson(h.base, '/experiments/' + longExp.id + '/start', {
    candidates: [{ name: '慢的', provider: 'pa', model: 'pa-m1' }],
  });
  const longDone = await waitIdle(h.base, longExp.id, 40000);
  assert.equal(longDone.attempts[0].status, 'completed', '上限给足之后同一条内容应当跑得完');
  assert.equal(longDone.attempts[0].canPreview, true);
  assert.equal(longDone.attempts[0].timeoutMs, 30000);
});
