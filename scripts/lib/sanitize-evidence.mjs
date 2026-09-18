/**
 * 一次性清洗：把已有证据文件里的"运行期痕迹"统一抹掉。
 *
 * 为什么需要：M2 期间发现旧的证据 JSON 里带着开发机的绝对路径
 * （Playwright 的报错文本里有 "D:\\开发\\dsh插件\\html-arena\\scripts\\x.mjs:123"）。
 * 这类内容不该出现在将来会公开的验收证据里。规则已经加进 `redact.mjs`，
 * 这个脚本用来**回头把历史文件也过一遍**（幂等：没变化的文件不会被改写）。
 *
 * 用法：node scripts/lib/sanitize-evidence.mjs
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { redactValue } from './redact.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, '..', '..', 'docs', 'evidence');

let scanned = 0;
let changed = 0;
for (const name of readdirSync(dir)) {
  if (!name.endsWith('.json')) continue;
  scanned += 1;
  const file = join(dir, name);
  const raw = readFileSync(file, 'utf8');
  let parsed;
  try { parsed = JSON.parse(raw); } catch { console.log('跳过（不是合法 JSON）：' + name); continue; }
  const safe = redactValue(parsed);
  const out = JSON.stringify(safe, null, 2);
  if (out !== raw) {
    writeFileSync(file, out, 'utf8');
    changed += 1;
    console.log('已清洗：' + name);
  }
}
console.log('扫描 ' + scanned + ' 个文件，改写 ' + changed + ' 个');
