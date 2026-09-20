/**
 * 用量的"可信度"口径 —— 一处定义，写入侧与读取侧共用。
 *
 * 为什么需要它：宿主的 `TokenUsage` 把 `inputTokens` / `outputTokens` 声明成
 * **必填 number**（没有 null 这一说，见 DSH 的 llm 类型声明）。一次**没有成功收尾**的调用
 * （额度不足 / 鉴权失败 / 上游 500 / 取消 / 超时）根本没有用量可报，适配器只能填 0 ——
 * 那个 0 是"类型不允许表达未知"的产物，**不是**"模型说用了 0 个 token"。
 *
 * 直接照抄会在界面上显示"输入 0 tok / 输出 0 tok / 总速度 0.0 tok/s"，
 * 正好违反 A18（不得显示零 Token 零费用）。这是在真实实例上**实测撞到**的，
 * 不是假设（见 tests/runner.test.js 的 A18 一组）。
 *
 * 为什么要分两处调用：写入侧（runner）能保证**新**数据是对的；读取侧（api 的
 * describeAttempt）还能把**历史**数据与**导入包**里的旧数据一并修正回来。
 * 规则只有这一份，两边都调它，而且它是幂等的 —— 重复调用不会改变结果。
 *
 * @module html-arena/core/usage
 */

/** 六个用量字段的统一形状（缺失一律 null，绝不用 0 顶替）。 */
export const USAGE_KEYS = Object.freeze([
  'inputTokens', 'outputTokens', 'totalTokens',
  'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens',
]);

/**
 * 一次用量是否"全 0" —— 即所有**主**字段都是 0 或 null。
 *
 * 只看主字段（输入 / 输出 / 合计）：缓存与推理字段在正常调用里也经常是 null，
 * 把它们算进来会把"确实用了 12 个输入 token"误判成全 0。
 *
 * @param {object|null|undefined} usage
 * @returns {boolean}
 */
export function isAllZeroUsage(usage) {
  if (!usage || typeof usage !== 'object') return false;
  const zeroish = (v) => v === 0 || v === null || v === undefined;
  return zeroish(usage.inputTokens) && zeroish(usage.outputTokens) && zeroish(usage.totalTokens);
}

/** 全 null 的用量对象（"未上报"的规范形状）。 */
export function unreportedUsage(reason) {
  const out = {};
  for (const k of USAGE_KEYS) out[k] = null;
  if (reason) out.unreportedBecause = reason;
  return out;
}

/**
 * 按"这次调用有没有成功收尾"判断用量该不该信。
 *
 * - **成功收尾**（status === 'completed'）：上游给什么就是什么，**一个字都不改**
 *   —— 哪怕它报 0，那也是它的口径，我们不替上游改数。
 * - **没有成功收尾**且用量全 0：记成"未上报"，并留一句可核对的说明。
 * - **没有成功收尾**但确实有非 0 用量：照实保留（上游真的报过数）。
 *
 * @param {string} status  attempt 状态（completed / failed / cancelled / timed_out / interrupted）
 * @param {object|null|undefined} usage
 * @returns {object|null|undefined} 归一后的用量（null 仍返回 null）
 */
export function normalizeUsage(status, usage) {
  if (!usage || typeof usage !== 'object') return usage;
  if (status === 'completed') return usage;
  if (!isAllZeroUsage(usage)) return usage;
  // 已经是"未上报"形状的就不重复包一层（幂等）
  if (usage.unreportedBecause) return usage;
  return unreportedUsage('这次调用没有成功收尾，适配器上报的用量全为 0（宿主 TokenUsage 的必填字段不允许空），按 A18 记为未上报');
}
