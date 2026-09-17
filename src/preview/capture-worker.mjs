/**
 * 采集子进程入口：从 stdin 读参数，用 capturePreview 采一帧，把结果写回 stdout。
 * 独立进程的意义是"能被硬杀"（F14）。
 */
import { capturePreview } from './browser.js';

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', async () => {
  let result;
  try {
    const params = JSON.parse(input || '{}');
    const r = await capturePreview(params);
    result = { ...r };
    if (r.screenshotPng) {
      result.screenshotBase64 = Buffer.from(r.screenshotPng).toString('base64');
      delete result.screenshotPng;
    }
  } catch (err) {
    result = { status: 'error', reason: String(err && err.message || err) };
  }
  process.stdout.write('__HTML_ARENA_RESULT__' + JSON.stringify(result));
  process.exit(0);
});
