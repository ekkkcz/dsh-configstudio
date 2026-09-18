/**
 * 模型可达性探针 —— 用极小请求确认某个 provider/model 真的能调通。
 *
 * 背景：模型目录里列出的模型不一定在上游真实存在（实测 xkiro/deepseek/deepseek-v4-pro
 * 返回 404 "Model does not exist"，但目录里有它）。M1 选真实候选前先用本脚本筛一遍。
 *
 * 用法：
 *   node scripts/m1-probe-models.mjs provider/model provider/model ...
 * 环境变量：ARENA_BASE（默认 http://127.0.0.1:8901/html-arena/api）
 */
const BASE = process.env.ARENA_BASE || 'http://127.0.0.1:8901/html-arena/api';
const PROMPT = '只回复两个字：可以';
const MAX_TOKENS = Number(process.env.PROBE_MAX_TOKENS || 1200);

async function call(method, path, body) {
  const res = await fetch(BASE + path, {
    method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  try { return { status: res.status, json: JSON.parse(text) }; } catch { return { status: res.status, json: null, text }; }
}

const targets = process.argv.slice(2).map((s) => {
  const i = s.indexOf('/');
  return { provider: s.slice(0, i), model: s.slice(i + 1), raw: s };
});

const rows = [];
for (const t of targets) {
  const created = await call('POST', '/experiments', {
    title: 'probe ' + t.raw, category: 'probe', prompt: PROMPT,
    outputPolicy: { concurrency: 1 }, previewPolicy: { networkPolicy: 'offline', viewport: 'desktop' },
  });
  const id = created.json.experiment.id;
  const started = await call('POST', '/experiments/' + id + '/start', {
    candidates: [{ name: 'probe', provider: t.provider, model: t.model, maxTokens: MAX_TOKENS }], concurrency: 1,
  });
  if (started.status !== 202) {
    rows.push({ target: t.raw, ok: false, status: started.status, error: JSON.stringify(started.json).slice(0, 300) });
    console.log(t.raw + ' → 发起被拒 ' + started.status + ' ' + JSON.stringify(started.json).slice(0, 300));
    continue;
  }
  let a = null;
  for (let i = 0; i < 60; i += 1) {
    await new Promise((r) => setTimeout(r, 1000));
    const d = await call('GET', '/experiments/' + id);
    a = d.json.attempts[0];
    if (!a.running && a.status !== 'pending') break;
  }
  const row = {
    target: t.raw, ok: a.status === 'completed', status: a.status,
    finishReason: a.receipt?.finishReason, errorCode: a.receipt?.errorCode,
    errorMessage: a.receipt?.errorMessage, usage: a.receipt?.usage,
    extraction: a.extraction?.status, elapsedMs: (a.receipt?.finishedAt ?? 0) - (a.receipt?.startedAt ?? 0),
    experimentId: id,
  };
  rows.push(row);
  console.log(t.raw + ' → ' + row.status + ' finish=' + row.finishReason
    + ' err=' + (row.errorCode ?? '-') + ' ' + (row.errorMessage ? String(row.errorMessage).slice(0, 160) : '')
    + ' out=' + (row.usage?.outputTokens ?? '?') + 'tok ' + row.elapsedMs + 'ms');
}
console.log('\n' + JSON.stringify(rows, null, 2));
