/**
 * M1 真实模型对比流程脚本（A02 / A30 的第一批真实证据）。
 *
 * 它通过插件自己的 HTTP API（本机校验，不走 DSH 的 ?token）驱动真实 DSH 实例，
 * 因此跑的是**真实 provider + 真实凭据**，不是模拟模型。
 *
 * 用法：
 *   node scripts/m1-real-compare.mjs catalog
 *   node scripts/m1-real-compare.mjs resolve <provider> <model> [effort]
 *   node scripts/m1-real-compare.mjs run --prompt-file <文件> --a <p/m> --b <p/m> [--concurrency 2] [--out <json>]
 *   node scripts/m1-real-compare.mjs status <experimentId>
 *
 * 环境变量：ARENA_BASE（默认 http://127.0.0.1:8901/html-arena/api）
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.ARENA_BASE || 'http://127.0.0.1:8901/html-arena/api';

async function call(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON 就保留原文 */ }
  return { status: res.status, json, text };
}

const argv = process.argv.slice(2);
const cmd = argv[0] ?? 'catalog';
const opt = (name, dflt = null) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 ? argv[i + 1] : dflt;
};

function pm(s) {
  const i = s.indexOf('/');
  return { provider: s.slice(0, i), model: s.slice(i + 1) };
}

if (cmd === 'catalog') {
  const r = await call('GET', '/models');
  if (!r.json) { console.log('非 JSON 响应', r.status, r.text.slice(0, 400)); process.exit(1); }
  console.log('available =', r.json.available, '| providers =', (r.json.providers ?? []).length, '| errors =', (r.json.errors ?? []).length);
  for (const p of r.json.providers ?? []) {
    const models = r.json.modelsByProvider?.[p.id] ?? [];
    console.log('  ' + p.id + '  (' + models.length + ' 模型)');
  }
  const want = ['deepseek-official', 'xkiro'];
  for (const w of want) {
    const models = r.json.modelsByProvider?.[w] ?? [];
    console.log('\n[' + w + '] 模型：');
    for (const m of models) console.log('   ' + (m.id ?? m.model ?? JSON.stringify(m)));
  }
} else if (cmd === 'resolve') {
  const [provider, model, effort] = [argv[1], argv[2], argv[3]];
  const r = await call('POST', '/models/resolve', { provider, model, reasoningEffort: effort ?? null });
  console.log(JSON.stringify(r.json, null, 2));
} else if (cmd === 'status') {
  const r = await call('GET', '/experiments/' + argv[1]);
  console.log(JSON.stringify(r.json, null, 2));
} else if (cmd === 'run') {
  const promptFile = opt('prompt-file');
  const prompt = promptFile ? readFileSync(promptFile, 'utf8').trim() : '做一个只有一句话的 HTML 页面。';
  const concurrency = Number(opt('concurrency', '2'));
  const maxTokens = opt('max-tokens') === null ? null : Number(opt('max-tokens'));
  // 候选来源：优先用可重复的 --c（支持 2–4 个，供 A06 的四候选排队观测）；
  // 没有 --c 时退回原来的 --a / --b 两个。
  const allArgs = argv.slice(argv.indexOf('run'));
  const cList = [];
  for (let i = 0; i < allArgs.length; i += 1) {
    if (allArgs[i] === '--c' && allArgs[i + 1]) cList.push(allArgs[i + 1]);
  }
  const specs = cList.length > 0
    ? cList.map((s) => pm(s))
    : [pm(opt('a')), pm(opt('b'))];
  if (specs.length < 1 || specs.length > 4) { console.log('候选数量必须是 1–4 个'); process.exit(1); }
  const candidates = specs.map((s, i) => ({
    name: String.fromCharCode(65 + i), provider: s.provider, model: s.model,
    reasoningEffort: opt('effort-' + String.fromCharCode(97 + i)) || null, maxTokens,
  }));
  const created = await call('POST', '/experiments', {
    title: opt('title', 'M1 真实对比'), category: 'M1',
    prompt, outputRequirements: opt('requirements', ''),
    outputPolicy: { concurrency },
    previewPolicy: { networkPolicy: 'offline', viewport: 'desktop' },
  });
  if (created.status !== 201) { console.log('创建实验失败', created.status, created.text.slice(0, 600)); process.exit(1); }
  const id = created.json.experiment.id;
  console.log('实验：' + id + '  taskHash=' + created.json.taskHash);

  // 先做一次解析核对（A04），再正式发起
  for (const c of candidates) {
    const r = await call('POST', '/models/resolve', { provider: c.provider, model: c.model, reasoningEffort: c.reasoningEffort });
    console.log('  resolve ' + c.name + ' ' + c.provider + '/' + c.model + ' → ' + JSON.stringify(r.json?.resolved ?? r.json));
  }
  const started = await call('POST', '/experiments/' + id + '/start', { candidates, concurrency });
  console.log('start →', started.status, JSON.stringify(started.json));
  if (started.status !== 202) process.exit(1);

  const t0 = Date.now();
  let detail = null;
  // 并发时间线：每帧记录"此刻有几个在 running / 几个在排队"。
  // 这是 A06（并发设为 2 时仅两路同时生成、完成后队列推进）的直接证据。
  const timeline = [];
  while (Date.now() - t0 < Number(opt('timeout-ms', '240000'))) {
    await new Promise((r) => setTimeout(r, 1000));
    const r = await call('GET', '/experiments/' + id);
    detail = r.json;
    const attempts = detail.attempts ?? [];
    const running = attempts.filter((a) => a.running).length;
    const gate = detail.concurrency ?? null;
    timeline.push({ atMs: Date.now() - t0, running, queued: attempts.filter((a) => a.status === 'queued').length, statuses: attempts.map((a) => a.slot + ':' + a.status).join(' ') });
    process.stdout.write('  [' + ((Date.now() - t0) / 1000).toFixed(1) + 's] running=' + running
      + (gate ? ' (闸门 ' + gate.active + '/' + gate.limit + (gate.pending ? ' 排队 ' + gate.pending : '') + ')' : '')
      + '  ' + attempts.map((a) => a.slot + ':' + a.status).join(' ') + '\n');
    if (attempts.length >= candidates.length && running === 0 && attempts.every((a) => a.status !== 'pending')) break;
  }
  const maxConcurrent = timeline.reduce((m, t) => Math.max(m, t.running), 0);

  const out = {
    at: new Date().toISOString(), base: BASE, experimentId: id,
    taskHash: created.json.taskHash, prompt, concurrency,
    candidateCount: candidates.length,
    maxConcurrentObserved: maxConcurrent,
    timeline,
    attempts: (detail?.attempts ?? []).map((a) => ({
      id: a.id, slot: a.slot, status: a.status,
      recipe: a.recipe, resolved: a.resolved,
      finishReason: a.receipt?.finishReason, error: a.error,
      extraction: a.extraction, usage: a.receipt?.usage,
      firstEventAt: a.receipt?.first_event_at ?? null, firstTextAt: a.receipt?.first_text_at ?? null,
      startedAt: a.receipt?.started_at ?? null,
      htmlHash: a.extraction?.htmlHash, rawHash: a.extraction?.rawTextHash,
    })),
  };
  const outPath = opt('out');
  if (outPath) {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify(out, null, 2), 'utf8');
    console.log('证据写入：' + outPath);
  }
  console.log(JSON.stringify(out, null, 2));
} else {
  console.log('未知命令：' + cmd);
  process.exit(1);
}
