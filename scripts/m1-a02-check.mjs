/**
 * A02 实测脚本 —— 配置两个不同模型运行同一题：题目与输出规则 hash 相同、模型配置独立、结果不串台。
 *
 * 设计为**零模型费用**：只调用 /preview-request（不起生成），再读取已经跑完的真实实验记录。
 * 真实生成证据来自 scripts/m1-real-compare.mjs 产出的 JSON。
 *
 * 用法：node scripts/m1-a02-check.mjs <experimentId> [--out docs/evidence/xxx.json]
 * 端口默认 8902（DSH 测试实例）。**不要写 8901** —— 那个端口是本机另一个程序（与本插件无关）的，
 * 打到它会得到 ECONNRESET 而不是"插件没起来"（实测踩过）。
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.ARENA_BASE || 'http://127.0.0.1:8902/html-arena/api';
const expId = process.argv[2];
const outArg = process.argv.indexOf('--out');

async function call(method, path, body) {
  const res = await fetch(BASE + path, {
    method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  try { return { status: res.status, json: JSON.parse(text) }; } catch { return { status: res.status, json: null, text }; }
}

const checks = [];
const add = (name, ok, detail) => {
  checks.push({ name, ok: Boolean(ok), detail: detail === undefined ? null : detail });
  console.log((ok ? '  ✓ ' : '  ✗ ') + name + (detail === undefined ? '' : '  ' + JSON.stringify(detail)));
};

const d = await call('GET', '/experiments/' + expId);
if (d.status !== 200) { console.log('读不到实验 ' + expId + '：' + d.status); process.exit(1); }
const exp = d.json.experiment;
const attempts = d.json.attempts;

console.log('实验 ' + expId + '：' + exp.title);
console.log('题目：' + exp.taskSnapshot.prompt.slice(0, 80));
console.log('输出要求：' + (exp.taskSnapshot.outputRequirements || '（空）'));
console.log('');

// ── 1 题目与输出规则 hash 相同 ────────────────────────────────
// 用同一份题目两次请求 /preview-request，分别带 A / B 的候选配置：
// 如果 hash 只由题目 + 输出规则决定，两次必须相等。
const cands = attempts.map((a) => ({
  name: a.recipe.name, provider: a.recipe.provider, model: a.recipe.model,
  systemPrompt: a.recipe.systemPrompt, promptSegments: a.recipe.promptSegments,
  temperature: a.recipe.temperature, maxTokens: a.recipe.maxTokens, reasoningEffort: a.recipe.reasoningEffort,
}));
const task = {
  prompt: exp.taskSnapshot.prompt,
  startHtml: exp.taskSnapshot.startHtml ?? '',
  outputRequirements: exp.taskSnapshot.outputRequirements ?? '',
};
const hashes = [];
const reqs = [];
for (const c of cands) {
  const r = await call('POST', '/preview-request', { task, candidates: [c] });
  hashes.push(r.json?.taskHash ?? null);
  reqs.push(r.json?.requests?.[0] ?? null);
}
add('两个候选各自的题目 hash 相同', hashes.length === 2 && hashes[0] !== null && hashes[0] === hashes[1], hashes);
add('题目 hash 与实验记录里的 taskHash 一致', hashes[0] === exp.taskHash, { computed: hashes[0], stored: exp.taskHash });

// 改一个字就必须换 hash（证明它真的绑定题目，不是常量）
const mut = await call('POST', '/preview-request', { task: { ...task, prompt: task.prompt + '（改一个字）' }, candidates: [cands[0]] });
add('改动题目后 hash 变化（hash 确实绑定题目）', mut.json?.taskHash !== hashes[0],
  { before: hashes[0], after: mut.json?.taskHash });

// ── 2 输出规则一致：实际发出去的题目段落逐字节相同 ────────────
const userTexts = reqs.map((r) => r?.user ?? null);
add('两候选收到的题目/输出要求/交付格式段落逐字节相同', userTexts[0] !== null && userTexts[0] === userTexts[1],
  { sameLength: userTexts[0] ? userTexts[0].length : null });
add('两候选都不发送 tools（单次逻辑请求）', reqs.every((r) => r && r.tools === null));

// ── 3 模型配置独立 ────────────────────────────────────────────
const cfg = reqs.map((r) => ({ provider: r?.provider, model: r?.model, maxTokens: r?.maxTokens, reasoningEffort: r?.reasoningEffort }));
add('两候选的 provider / model 不同', cfg[0].provider !== cfg[1].provider || cfg[0].model !== cfg[1].model, cfg);
add('每个候选各自保存了独立的配置快照',
  attempts.length === 2 && new Set(attempts.map((a) => a.id)).size === 2
  && attempts.every((a) => a.recipe && a.recipe.provider && a.recipe.model)
  && new Set(attempts.map((a) => a.recipe.provider + '/' + a.recipe.model)).size === 2,
  attempts.map((a) => ({ slot: a.slot, id: a.id, cfg: a.recipe.provider + '/' + a.recipe.model })));
add('每个候选各有自己的 resolved 配置', attempts.every((a) => a.resolved && a.resolved.provider === a.recipe.provider));

// ── 4 结果不串台 ──────────────────────────────────────────────
const arts = attempts.map((a) => ({ slot: a.slot, html: a.extraction?.htmlHash ?? null, raw: a.extraction?.rawTextHash ?? null, bytes: a.extraction?.bytes ?? 0 }));
add('两个候选的作品 hash 不同（不是同一份结果）', arts[0].html && arts[1].html && arts[0].html !== arts[1].html, arts);
add('两个候选的原始正文 hash 不同', arts[0].raw && arts[1].raw && arts[0].raw !== arts[1].raw, arts);

// 真正下载两份原始正文，确认内容确实属于各自的候选
const texts = [];
for (const a of attempts) {
  const res = await fetch(BASE + '/experiments/' + expId + '/attempts/' + a.id + '/raw');
  texts.push({ slot: a.slot, status: res.status, body: await res.text() });
}
add('两份原始正文都能下载且内容不同',
  texts.every((t) => t.status === 200) && texts[0].body !== texts[1].body,
  texts.map((t) => ({ slot: t.slot, status: t.status, len: t.body.length })));

// 逐份核对：下载到的正文真的来自它自己那次调用（用正文里提取出的 HTML 反算 hash）
const { extractHtml, sha256Hex } = await import('../src/core/extract.js');
const recomputed = [];
for (let i = 0; i < texts.length; i += 1) {
  const ex = extractHtml(texts[i].body, { finishReason: attempts[i].receipt?.finishReason ?? null });
  const h = ex.html === null ? null : await sha256Hex(ex.html);
  recomputed.push({ slot: attempts[i].slot, ok: h === arts[i].html, recomputed: h, stored: arts[i].html });
}
add('每份正文重新提取后的 HTML hash 与它自己记录的一致（内容与记录一一对应）',
  recomputed.every((r) => r.ok), recomputed);

const report = {
  at: new Date().toISOString(), base: BASE, experimentId: expId, title: exp.title,
  taskHash: exp.taskHash, computedHashes: hashes,
  candidates: attempts.map((a) => ({ slot: a.slot, attemptId: a.id, provider: a.recipe.provider, model: a.recipe.model, status: a.status })),
  checks, passed: checks.filter((c) => c.ok).length, total: checks.length,
};
report.ok = report.passed === report.total;
if (outArg >= 0) {
  const p = join(here, '..', process.argv[outArg + 1]);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(report, null, 2), 'utf8');
  console.log('\n证据：' + p);
}
console.log(report.passed + '/' + report.total + ' 项通过');
// 用 exitCode 而不是 process.exit：keep-alive 连接未关时强退会在 Windows 上打出 libuv 断言噪音。
process.exitCode = report.ok ? 0 : 1;