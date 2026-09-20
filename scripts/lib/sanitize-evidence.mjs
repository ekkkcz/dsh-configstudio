/**
 * 一次性清洗：把已有证据文件里的"运行期痕迹"统一抹掉。
 *
 * 为什么需要：M2 期间发现旧的证据 JSON 里带着开发机的绝对路径
 * （Playwright 的报错文本里有 "D:\\开发\\dsh插件\\configstudio\\scripts\\x.mjs:123"）。
 * 这类内容不该出现在将来会公开的验收证据里。规则已经加进 `redact.mjs`，
 * 这个脚本用来**回头把历史文件也过一遍**（幂等：没变化的文件不会被改写）。
 *
 * ⚠ M4 发布前自检抓到的一个漏洞：本脚本原来**只扫 .json**，于是
 * `m0-dsh-boot.txt`（手写的证据文本）里的用户主目录绝对路径一直留到发布前，
 * 而且已经进了全部提交的历史。手写文本同样会公开，也必须过同一套规则。
 * 现在 .txt 也扫；.png 是二进制，不在此列（截图靠"拍之前先量"保证，见 m3-delivery-shots.mjs）。
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
  const isJson = name.endsWith('.json');
  // .txt 也扫（手写的证据文本同样会公开）。
  if (!isJson && !name.endsWith('.txt')) continue;
  // 本机的临时访问令牌：它不是"运行期痕迹"，是**凭据** —— 直接跳过，不写进任何地方。
  if (name.startsWith('.dsh-token-')) continue;
  scanned += 1;
  const file = join(dir, name);
  const raw = readFileSync(file, 'utf8');
  let out;
  if (isJson) {
    let parsed;
    try { parsed = JSON.parse(raw); } catch { console.log('跳过（不是合法 JSON）：' + name); continue; }
    out = JSON.stringify(redactValue(parsed), null, 2);
  } else {
    // 纯文本证据：整段过一遍规则，保持原样换行，不重新格式化（它不是 JSON）。
    out = redactValue(raw);
  }
  if (out !== raw) {
    writeFileSync(file, out, 'utf8');
    changed += 1;
    console.log('已清洗：' + name);
  }
}
console.log('扫描 ' + scanned + ' 个文件，改写 ' + changed + ' 个');
