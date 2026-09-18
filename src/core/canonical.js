/**
 * 规范序列化 —— "同一份内容必须算出同一个指纹"的**唯一口径**。
 *
 * 为什么单独抽一个模块：此前 stableStringify 只存在于 core/runtime.js。
 * 配方版本要按内容算 hash，如果再抄一份公式，就会重演 frameScale 那类漂移
 * （同一份逻辑写两遍 → 两处慢慢不一致，缺陷只在其中一条路径上出现）。
 * 因此所有需要"内容指纹"的地方都从这里取。
 *
 * @module html-arena/core/canonical
 */
import { createHash } from 'node:crypto';

/**
 * 稳定序列化：对象键排序，保证"同样的内容算出同样的字符串"。
 * 只处理 JSON 可表达的值；undefined 与函数按 JSON.stringify 的语义处理。
 */
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}

/** 内容指纹：先规范序列化再取 SHA-256，避免"键顺序不同 → 指纹不同"。 */
export function contentHash(value) {
  return createHash('sha256').update(stableStringify(value), 'utf8').digest('hex');
}
