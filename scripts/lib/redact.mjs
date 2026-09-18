/**
 * 证据脱敏 —— 写进 docs/evidence 的 JSON 在落盘前统一过一遍。
 *
 * 规则本身在 src/core/redact.js（M3 起导出包也用同一份口径，所以口径必须在产品侧），
 * 这里只负责"写文件"这一件事。以前规则写在脚本里，于是导出包要脱敏时只能再抄一份 ——
 * 与 canonical.js / frameScale 那两次同类，故上移。
 *
 * @module scripts/lib/redact
 */
import { writeFileSync } from 'node:fs';
import { redactValue } from '../../src/core/redact.js';

export { redactText, redactValue, findSensitive } from '../../src/core/redact.js';

/**
 * 写证据文件：先脱敏，再以 2 空格缩进写盘。
 * @param {string} filePath
 * @param {object} report
 */
export function writeEvidence(filePath, report) {
  const safe = redactValue(report);
  writeFileSync(filePath, JSON.stringify(safe, null, 2), 'utf8');
  return filePath;
}
