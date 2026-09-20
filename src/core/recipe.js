/**
 * 配方（recipe）—— 一次候选调用的"可复用配置"，以及它的**版本化**规则。
 *
 * 依据 PRD F19：配方保存模型引用、提示词、可选参数及说明，**每次修改生成版本**；
 * 本轮继续引用启动时的快照，不能随着配方后来变化而改变历史。
 *
 * 因此本模块的要点是"内容口径"：
 *  - 哪些字段算配方内容（会改变这次调用的东西）；
 *  - 哪些字段不算（槽位、时间戳这类运行期信息 —— 它们不该让指纹变化）。
 * 指纹口径只有这一份，存储层与 API 层都用它。
 *
 * @module configstudio/core/recipe
 */
import { contentHash, stableStringify } from './canonical.js';

/**
 * 配方内容的字段清单，顺序即界面展示顺序。
 * 少一个字段就意味着"改了它却不算新版本"，所以新增可调参数时必须同步加到这里。
 */
export const RECIPE_FIELDS = Object.freeze([
  'name',              // 候选名（用户可见的配方名）
  'provider',          // 模型来源
  'model',             // 模型
  'systemPrompt',      // 系统提示词
  'promptSegments',    // 提示词片段
  'temperature',       // 温度
  'maxTokens',         // 输出上限
  'reasoningEffort',   // 思考档位
]);

/** 只保留配方内容的字段；槽位、userText、requestedAt 等运行期信息一律丢弃。 */
export function normalizeRecipeContent(source) {
  const src = source ?? {};
  const out = {};
  for (const f of RECIPE_FIELDS) {
    const v = src[f];
    if (f === 'promptSegments') {
      out[f] = Array.isArray(v)
        ? v.filter((s) => typeof s === 'string' && s.trim().length > 0).map((s) => String(s))
        : [];
    } else if (f === 'temperature' || f === 'maxTokens') {
      out[f] = typeof v === 'number' && Number.isFinite(v) ? v : null;
    } else {
      out[f] = typeof v === 'string' && v.length > 0 ? v : (v === null || v === undefined ? null : String(v));
    }
  }
  return out;
}

/** 配方内容指纹。用途：判断"这次保存和上一版是不是同一份内容"。 */
export function recipeHash(source) {
  return contentHash(normalizeRecipeContent(source));
}

/** 两份配方内容是否完全一致（同一口径，避免各写一遍比较逻辑）。 */
export function sameRecipeContent(a, b) {
  return stableStringify(normalizeRecipeContent(a)) === stableStringify(normalizeRecipeContent(b));
}
