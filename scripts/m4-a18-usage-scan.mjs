/**
 * A18 扫描器 —— 在所有**真实模型**的 attempt 里找"模型没有上报用量"的实例。
 *
 * 为什么单独写：A18 要求"模型不返回 Token 或价格未知 → 显示未上报或未知，**不显示零 Token 零费用**"。
 * 这一条**只有真实模型自己不上报用量时才算测到**，拿模拟结果顶替不算数。
 * 所以需要的不是"造一个场景"，而是**去已有数据里找真实发生过的场景**，并把它钉成证据。
 *
 * 判据（对着 src/core/store.js 与收据结构）：
 *   - 用量在 `receipt.usage` 下（不是 receipt 顶层）；
 *   - "未上报" = `inputTokens` 与 `outputTokens` 都是 null（**不是 0**）；
 *   - 0 与 null 必须分得开：0 是"模型说这次是 0"，null 是"模型没说"。
 *
 * 本脚本**只读**，不发模型调用、零费用。它做两件事：
 *   ① 统计真实 attempt 里有多少"已上报"、多少"未上报"；
 *   ② 如果找到了"未上报"的实例，就把它作为 A18 的**真实证据**记下来（含 attempt id 与界面口径）。
 *      找不到就**如实说没找到**，不编一个。
 *
 * 用法：node scripts/m4-a18-usage-scan.mjs [--base http://127.0.0.1:8902]
 */
import { makeChecker, api } from './lib/devhost.mjs';

const args = process.argv.slice(2);
const getArg = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const BASE = getArg('--base', 'http://127.0.0.1:8902') + '/configstudio/api';

const { add, report, finish } = makeChecker({
  what: 'A18：真实模型的用量上报情况扫描（找"模型没上报用量"的真实实例）',
  note: '只读扫描已有数据；不发起任何模型调用（零费用）',
  extra: { base: BASE.replace('/configstudio/api', '') },
});

const list = await api(BASE, '/experiments?limit=500');
add('扫描', '能列出实验', list.status === 200 && Array.isArray(list.body.experiments), { status: list.status, count: list.body && list.body.experiments && list.body.experiments.length });

const all = [];
for (const e of (list.body.experiments || [])) {
  const d = await api(BASE, '/experiments/' + e.id);
  if (d.status !== 200 || !d.body) continue;
  for (const a of d.body.attempts || []) {
    const provider = (a.requested && a.requested.provider) || '';
    const usage = (a.receipt && a.receipt.usage) || null;
    all.push({
      experimentId: e.id, experimentTitle: e.title, attemptId: a.id, slot: a.slot,
      provider, model: (a.requested && a.requested.model) || '',
      status: a.status, finishReason: (a.receipt && a.receipt.finishReason) || null,
      simulated: provider.startsWith('sim-'),
      usage,
      // "未上报"的口径：两个主字段都是 null。**不是 0**
      usageUnreported: usage === null || (usage.inputTokens === null && usage.outputTokens === null),
      usageIsZero: Boolean(usage) && usage.inputTokens === 0 && usage.outputTokens === 0,
    });
  }
}

const real = all.filter((a) => !a.simulated);
const sim = all.filter((a) => a.simulated);
report.counts = {
  attemptsTotal: all.length, real: real.length, simulated: sim.length,
  realReported: real.filter((a) => !a.usageUnreported).length,
  realUnreported: real.filter((a) => a.usageUnreported).length,
  realZeroed: real.filter((a) => a.usageIsZero).length,
  realNoUsageObject: real.filter((a) => a.usage === null).length,
};
add('扫描', '扫到了真实模型的 attempt（否则这条根本无从谈起）', real.length > 0, report.counts);

// ★ 关键区分：null 与 0 必须是两件事
add('扫描 ★', '"未上报"（null）与"确实是 0"（0）在数据里是**分得开**的两种状态',
  !real.some((a) => a.usageUnreported && a.usageIsZero),
  { usageNullExamples: report.counts.realUnreported, usageZeroExamples: report.counts.realZeroed });

// ★★ 这条是**实测撞出来的真缺陷**的回归断言：
// 宿主 TokenUsage 的 inputTokens/outputTokens 是必填 number，失败调用只能填 0。
// 修复前，界面会把这种占位 0 显示成"输入 0 tok / 输出 0 tok / 总速度 0.0 tok/s"，
// 直接违反 A18（"不显示零 Token 零费用"）。现在读取侧会把它归一成"未上报"。
// 断言口径：**没有成功收尾的真实 attempt，不该出现"全 0"的用量**。
const failedWithZero = real.filter((a) => a.status !== 'completed' && a.usageIsZero);
report.failedWithZeroUsage = failedWithZero.map((a) => ({
  experimentTitle: a.experimentTitle, attemptId: a.attemptId, provider: a.provider, model: a.model,
  status: a.status, finishReason: a.finishReason, usage: a.usage,
}));
add('扫描 ★★', '没有成功收尾的真实 attempt 不再显示"全 0"用量（A18 的实测缺陷回归）',
  failedWithZero.length === 0,
  {
    count: failedWithZero.length,
    // 修复前这里是 4（QUOTA / AUTH / PI_AI_ERROR ×2），界面上显示成 0 tok。
    examples: report.failedWithZeroUsage.slice(0, 4),
    fixedBefore: '读数来自 src/core/usage.js 的 normalizeUsage()：没成功收尾 + 全 0 → 记为未上报',
  });

// 反向保证：这些"未上报"的失败记录必须能看出**为什么**是未上报，而不是"字段丢了"
const failedUnreported = real.filter((a) => a.status !== 'completed' && a.usageUnreported && a.usage !== null);
const explained = failedUnreported.filter((a) => typeof a.usage.unreportedBecause === 'string');
report.failedUnreportedCount = failedUnreported.length;
add('扫描', '被判为"未上报"的失败记录带着可核对的原因（不是静默丢字段）',
  failedUnreported.length === 0 || explained.length === failedUnreported.length,
  { unreported: failedUnreported.length, explained: explained.length });

// ★ A18 真正要的那种实例：真实模型**跑成功了**却没上报用量
const realCompletedWithoutUsage = real.filter((a) => a.status === 'completed' && a.usageUnreported);
const realCompletedWithUsage = real.filter((a) => a.status === 'completed' && !a.usageUnreported);
report.realCompletedWithUsage = realCompletedWithUsage.length;
report.realCompletedWithoutUsage = realCompletedWithoutUsage.map((a) => ({
  experimentId: a.experimentId, attemptId: a.attemptId, provider: a.provider, model: a.model, finishReason: a.finishReason,
}));

add('扫描', '确实存在"真实模型跑成功并上报了用量"的实例（对照组）', realCompletedWithUsage.length > 0,
  { count: realCompletedWithUsage.length });
// 注意：这一条**不是不合格**。A18 要求"只有真实模型自己不上报用量才算测到"，
// 所以"没找到正样本"是**如实的结论**（保持未测），不该让脚本报失败 ——
// 否则为了让它变绿，迟早有人会拿模拟结果顶替。这里用 add 的第三个参数记事实，
// 合格性由下一条"结论"来判（它永远返回 true，只负责把话说清楚）。
add('扫描', '真实模型跑成功却**没有上报用量**的实例（有就是 A18 的正样本）',
  true,
  {
    found: realCompletedWithoutUsage.length,
    verdict: realCompletedWithoutUsage.length > 0 ? '找到正样本' : '未找到（A18 保持未测，不用模拟顶替）',
    count: realCompletedWithoutUsage.length,
    examples: realCompletedWithoutUsage.slice(0, 5).map((a) => a.attemptId + ' ' + a.provider + '/' + a.model),
    // 这一条**可以为 0**：那样说明"还没遇到真实的不上报"，A18 保持未测而不是伪造通过。
    note: realCompletedWithoutUsage.length === 0
      ? '没有找到：真实模型目前都上报了用量。A18 保持"未测"，不用模拟结果顶替。'
      : '找到了真实的不上报实例 —— 可以据此把 A18 归档。',
  });

// 未完成/失败的真实 attempt 里，未上报是**预期**的（取消、上游错误），不该混进上面的判据
const realNotCompleted = real.filter((a) => a.status !== 'completed');
report.realNotCompletedBreakdown = realNotCompleted.reduce((acc, a) => {
  const k = a.status + '/' + (a.finishReason || '-');
  acc[k] = (acc[k] || 0) + 1;
  return acc;
}, {});
add('扫描', '未完成/失败的真实 attempt 单独归类（取消与上游错误本来就不会有用量）',
  true, report.realNotCompletedBreakdown);

add('结论', realCompletedWithoutUsage.length > 0
  ? 'A18：找到了真实模型不上报用量的实例 → 可以归档为通过'
  : 'A18：仍未遇到真实模型不上报用量的情形 → 保持未测（不用模拟结果顶替）',
  true,
  {
    verdict: realCompletedWithoutUsage.length > 0 ? 'pass' : 'still-untested',
    realCompletedWithUsage: realCompletedWithUsage.length,
    realCompletedWithoutUsage: realCompletedWithoutUsage.length,
  });

process.exitCode = finish('m4-a18-usage-scan');
