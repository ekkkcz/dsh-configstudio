/**
 * 题目（task）快照与它的指纹 —— **唯一一份**口径。
 *
 * 为什么单独抽出来：题目 hash 原先在 api.js 里被算了两遍（创建实验、请求预览各一处），
 * 而且用的是同一段 JSON.stringify。M3 的展示包 / 复测包还要在**导出**与**导入**两侧
 * 各算一次（A25：导入后题目与配方 hash 必须一致），四处各写一遍必然漂移。
 *
 * @module html-arena/core/task
 */
import { sha256Hex } from './extract.js';

/** 起始 HTML 的空值口径：空字符串与 undefined 都算"没有起始 HTML"（存 null）。 */
export function normalizeStartHtml(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * 归一化题目快照。createdAt 这类运行期字段**不参与**指纹（否则同一道题会算出不同 hash）。
 * @param {{prompt?: string, startHtml?: string|null, outputRequirements?: string}} input
 * @returns {{prompt: string, startHtml: string|null, outputRequirements: string}}
 */
export function normalizeTaskSnapshot(input) {
  const t = input ?? {};
  return {
    prompt: String(t.prompt ?? ''),
    startHtml: normalizeStartHtml(t.startHtml),
    outputRequirements: String(t.outputRequirements ?? ''),
  };
}

/**
 * 题目指纹。口径自 M1 起未变（kind+三个字段的 JSON），所以历史实验的 taskHash 仍然对得上。
 * @param {{prompt?: string, startHtml?: string|null, outputRequirements?: string}} task
 * @returns {Promise<string>}
 */
export function taskHashOf(task) {
  const t = normalizeTaskSnapshot(task);
  return sha256Hex(JSON.stringify({
    kind: 'task', prompt: t.prompt, startHtml: t.startHtml, outputRequirements: t.outputRequirements,
  }));
}

/** 两份题目是否完全一致（导入校验用，不比较运行期字段）。 */
export function sameTaskContent(a, b) {
  return JSON.stringify(normalizeTaskSnapshot(a)) === JSON.stringify(normalizeTaskSnapshot(b));
}
