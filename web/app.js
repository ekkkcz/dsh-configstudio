/* HTML Arena 前端。
 *
 * 设计原则（PRD 4）：
 *  - 作品是主视觉；配置与数据放次要位置，可折叠。
 *  - 不做假数据：未运行不显示成功结果，未上报显示"未上报"，未知显示"未知"。
 *  - 出错的候选保留原来的位置，不让成功样本挤掉失败记录。
 *  - 失败、超时、无 HTML 都给出人能读懂的原因与下一步。
 *
 * 本文件不使用模板字符串（历史原因：便于在生成工具里处理），全部用字符串拼接。
 */
'use strict';

var API = '/html-arena/api';
var state = {
  view: 'experiments',
  meta: null,
  models: null,
  experiments: [],
  current: null,          // { experiment, attempts, vote }
  candidates: [],         // 新建实验的候选草稿
  candidateSeq: 0,
  lastCopied: null,       // 用于差异高亮
  viewport: 'desktop',
  blind: false,
  revealed: false,
  timers: [],
  runPollTimer: null,
  requestId: null,        // 防止双击开始重复提交
  startedRequestId: null,
  streams: {},            // attemptId -> { text, reasoning, truncated, done, textLength }
  livePollTimer: null,
  requirements: { presets: [], selected: [] },
  optimizer: { available: true, lastRunId: null, running: false },
  screenshots: {},        // attemptId -> { base64, meta }
};

// ── 工具 ────────────────────────────────────────────────────

function $(id) { return document.getElementById(id); }
function el(tag, attrs, children) {
  var e = document.createElement(tag);
  if (attrs) for (var k in attrs) {
    if (k === 'class') e.className = attrs[k];
    else if (k === 'text') e.textContent = attrs[k];
    else if (k === 'html') e.innerHTML = attrs[k];
    else if (k.indexOf('on') === 0) e.addEventListener(k.slice(2), attrs[k]);
    else if (attrs[k] === true) e.setAttribute(k, '');
    else if (attrs[k] !== false && attrs[k] !== null && attrs[k] !== undefined) e.setAttribute(k, attrs[k]);
  }
  if (children) for (var i = 0; i < children.length; i++) {
    var c = children[i];
    if (c === null || c === undefined) continue;
    e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return e;
}
function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

function toast(msg, bad) {
  var t = $('toast');
  t.textContent = msg;
  t.className = 'toast' + (bad ? ' bad' : '');
  t.hidden = false;
  clearTimeout(t._timer);
  t._timer = setTimeout(function () { t.hidden = true; }, bad ? 5200 : 2600);
}

function fatal(title, lines) {
  var box = $('fatal');
  clear(box);
  box.appendChild(el('h3', { text: title }));
  var ul = el('ul');
  for (var i = 0; i < lines.length; i++) ul.appendChild(el('li', { text: lines[i] }));
  box.appendChild(ul);
  box.hidden = false;
}
function clearFatal() { $('fatal').hidden = true; }

function fmtTime(ms) {
  if (!ms) return '—';
  var d = new Date(ms);
  var p = function (n) { return (n < 10 ? '0' : '') + n; };
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}
function fmtDuration(a, b) {
  if (!a || !b) return '—';
  return ((b - a) / 1000).toFixed(1) + ' 秒';
}
function fmtBytes(n) {
  if (n === null || n === undefined) return '—';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(2) + ' MB';
}
/** 用量字段：缺失显示"未上报"，绝不显示 0（F18 / A18）。 */
function usageField(usage, key, label) {
  if (!usage) return label + ' 未上报';
  var v = usage[key];
  return label + ' ' + (v === null || v === undefined ? '未上报' : v);
}

// ── API ─────────────────────────────────────────────────────

function api(path, options) {
  var url = API + path;
  var opts = options || {};
  if (opts.body && typeof opts.body !== 'string') {
    opts.headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
    opts.body = JSON.stringify(opts.body);
  }
  return fetch(url, opts).then(function (r) {
    return r.text().then(function (text) {
      var body = null;
      try { body = JSON.parse(text); } catch (e) { body = { error: '响应不是合法 JSON', raw: text.slice(0, 500) }; }
      if (!r.ok) {
        var err = new Error(body.error || ('HTTP ' + r.status));
        err.status = r.status;
        err.body = body;
        throw err;
      }
      return body;
    });
  });
}

// ── 视图切换 ─────────────────────────────────────────────────

function showView(name) {
  state.view = name;
  var views = ['experiments', 'new', 'run', 'compare'];
  for (var i = 0; i < views.length; i++) {
    $('view-' + views[i]).hidden = views[i] !== name;
  }
  // 列表是本次会话里最容易被改动的东西（新建、删除、评价），每次进入都刷新，
  // 否则用户会看到过期的行。
  if (name === 'experiments') loadExperiments();
  var tabs = document.querySelectorAll('.tab');
  for (var j = 0; j < tabs.length; j++) {
    var v = tabs[j].getAttribute('data-view');
    tabs[j].className = 'tab' + (v === name ? ' is-active' : '');
    if (v === 'compare') tabs[j].disabled = !state.current;
  }
}

// ── 启动 ─────────────────────────────────────────────────────

function boot() {
  api('/meta').then(function (meta) {
    state.meta = meta;
    state.models = {
      providers: (meta.providers || []),
    };
    var badge = $('mode-badge');
    badge.textContent = 'DSH ' + (meta.dshVersion || '版本未知');
    badge.className = 'badge ' + (meta.browser && meta.browser.available ? 'ok' : '');
    var notes = [];
    notes.push('预览源 ' + (meta.previewOrigin || '未知'));
    notes.push('截图能力 ' + (meta.browser && meta.browser.available ? '可用' : '不可用（会标注未检查）'));
    $('env-note').textContent = notes.join(' · ');
    if (!(meta.browser && meta.browser.available)) {
      $('btn-screenshots').title = '本机没有可用的浏览器，截图会标注"未检查"';
    }
    applyOptimizerStatus(meta.optimizer);
    return loadModels();
  }).then(function () {
    ensureDefaultCandidates();
    return Promise.all([loadExperiments(), loadRequirementPresets().catch(function () {})]);
  }).catch(function (err) {
    $('mode-badge').textContent = '连接失败';
    $('mode-badge').className = 'badge bad';
    fatal('无法连接插件后端', [
      err.message,
      '确认 DSH 正在运行且本插件已安装进当前 profile。',
      '接口地址：' + API + '/meta',
    ]);
  });

  bindEvents();
  $('task-prompt').value = '';
  updatePromptCount();
}

/** 候选必须在模型目录到位之后再建，否则 provider / model 会是空的。
 *  模型目录可能晚于或早于首帧到达，所以两条路都要能补上默认值。 */
function ensureDefaultCandidates() {
  if (state.candidates.length === 0) {
    addCandidate('A');
    addCandidate('B');
    return;
  }
  // 已经建过卡但当时没有目录：把空的 provider/model 补上
  var providers = (state.models && state.models.providers) || [];
  var changed = false;
  state.candidates.forEach(function (c) {
    if (!c.provider && providers.length) {
      c.provider = providers[0].id;
      var ms = (state.models.modelsByProvider && state.models.modelsByProvider[c.provider]) || [];
      c.model = ms[0] ? ms[0].id : '';
      changed = true;
    }
  });
  if (changed) {
    renderCandidates();
    state.candidates.forEach(function (c) { resolveCandidate(c); });
  }
}

/**
 * 提示词优化：对接本机已装的 dsh-prompt-optimizer（可选能力）。
 *
 * 那个插件没有提供 cordis 服务、也没有导出函数，只有它自己的 HTTP API，
 * 所以由我们的宿主半边代为转发（见 src/core/optimizer.js）。
 * 这里的原则：**优化结果先给用户看，绝不自动替换题目** —— 用户点哪个按钮才生效。
 */
function applyOptimizerStatus(info) {
  state.optimizer.available = Boolean(info && info.available);
  state.optimizer.currentKey = info && info.current && info.current.provider ? info.current.provider + '/' + info.current.model : null;
  var box = $('optimizer-box');
  if (!box) return;
  box.hidden = !state.optimizer.available;
  if (!state.optimizer.available) return;
  var note = $('optimizer-note');
  note.textContent = '优化会额外产生一次模型调用费用。'
    + (state.optimizer.currentKey ? '（优化器当前用的是 ' + state.optimizer.currentKey + '）' : '');
  // 下拉要等模型目录到位才能填满 —— /meta 到达时目录往往还是空的（实测只填出 1 项）。
  fillOptimizerModels();
}

/** 用模型目录填充"优化模型"下拉。目录晚于优化器状态到达，所以两处都要调。 */
function fillOptimizerModels() {
  var sel = $('optimizer-model');
  if (!sel) return;
  var providers = (state.models && state.models.providers) || [];
  var hasCatalog = providers.some(function (p) {
    return ((state.models.modelsByProvider && state.models.modelsByProvider[p.id]) || []).length > 0;
  });
  if (!hasCatalog) {
    // 目录还没到：先占位，等 loadModels() 之后再填，不要用空目录覆盖用户的选择
    if (sel.options.length === 0) sel.appendChild(el('option', { value: '', text: '（正在读取模型目录…）' }));
    return;
  }
  var keep = sel.value;
  clear(sel);
  var currentKey = state.optimizer.currentKey;
  var anyOption = false;
  providers.forEach(function (p) {
    var ms = (state.models.modelsByProvider && state.models.modelsByProvider[p.id]) || [];
    ms.forEach(function (m) {
      var key = p.id + '/' + m.id;
      var o = el('option', { value: key, text: p.id + ' / ' + m.id });
      if (key === currentKey) o.selected = true;
      sel.appendChild(o);
      anyOption = true;
    });
  });
  if (!anyOption) {
    sel.appendChild(el('option', { value: '', text: '（还没有可用的模型）' }));
    return;
  }
  // 优先沿用用户已经选过的；其次优化器当前用的；最后退回一个通常可用的
  if (keep && sel.querySelector('option[value="' + keep.replace(/"/g, '\\"') + '"]')) sel.value = keep;
  else if (currentKey) sel.value = currentKey;
  else sel.value = 'deepseek-official/deepseek-flash';
}

function optimizeTask() {
  var prompt = $('task-prompt').value.trim();
  if (!prompt) { toast('先写题目，再优化', true); return; }
  var btn = $('btn-optimize');
  btn.disabled = true;
  $('optimizer-note').textContent = '正在优化（会调用一次模型，请稍候）…';
  state.optimizer.running = true;
  // 把用户选的模型传给优化器（它的优先级：传参 > 它的落盘 state > 会话当前模型）
  var chosen = $('optimizer-model').value || '';
  var slash = chosen.indexOf('/');
  var prov = slash > 0 ? chosen.slice(0, slash) : null;
  var mod = slash > 0 ? chosen.slice(slash + 1) : null;
  $('optimizer-error').hidden = true;
  api('/optimizer/optimize', {
    method: 'POST',
    body: { request: prompt, tier: $('optimizer-tier').value, provider: prov, model: mod },
  }).then(function (r) {
    btn.disabled = false;
    state.optimizer.running = false;
    if (!r.ok) {
      // fail-open：优化失败不影响你原来的题目。但要把上游原因摆出来，不然用户只能干瞪眼。
      $('optimizer-result').hidden = true;
      $('optimizer-note').textContent = '优化失败，原题目保持不变。';
      var box = $('optimizer-error');
      clear(box);
      box.appendChild(el('div', { text: '优化没有成功：' + (r.reason || '未知原因') }));
      var ul = el('ul');
      if (r.upstreamError) ul.appendChild(el('li', { text: '上游返回：' + String(r.upstreamError).slice(0, 400) }));
      if (mod) ul.appendChild(el('li', { text: '当前选用的优化模型：' + chosen }));
      ul.appendChild(el('li', { text: '换个模型再试一次，或直接用手写的题目继续 —— 优化只是可选步骤。' }));
      box.appendChild(ul);
      box.hidden = false;
      toast('优化失败，继续用原题目即可', true);
      return;
    }
    state.optimizer.text = r.text;
    state.optimizer.runId = r.runId;
    $('optimizer-text').textContent = r.text;
    $('optimizer-result').hidden = false;
    $('optimizer-note').textContent = '';
    $('optimizer-meta').textContent = '档位 ' + r.tier + ' · 用时 ' + (r.ms / 1000).toFixed(1) + ' 秒'
      + (r.usage && r.usage.outputTokens ? ' · 输出 ' + r.usage.outputTokens + ' tok' : '')
      + (r.reasoningChars ? ' · 推理 ' + r.reasoningChars + ' 字' : '');
  }).catch(function (err) {
    btn.disabled = false;
    state.optimizer.running = false;
    $('optimizer-result').hidden = true;
    $('optimizer-note').textContent = '优化请求失败，原题目保持不变：' + err.message;
  });
}

/**
 * 输出要求预设：点一下把这段文字**追加**到"输出要求"里（不覆盖用户已经写的东西）。
 * 再次点击则移除，方便对比"有/没有这条要求"的差别。
 */
function loadRequirementPresets() {
  return api('/requirement-presets').then(function (r) {
    state.requirements.presets = r.presets || [];
    renderRequirementPresets();
  }).catch(function () { /* 预设是辅助功能，拿不到就不显示 */ });
}

function renderRequirementPresets() {
  var box = $('requirement-presets');
  if (!box) return;
  clear(box);
  box.appendChild(el('span', { class: 'muted', text: '常用要求（点一下追加，可继续手写）：' }));
  state.requirements.presets.forEach(function (p) {
    var on = state.requirements.selected.indexOf(p.key) >= 0;
    box.appendChild(el('button', {
      class: 'chip-btn' + (on ? ' is-on' : ''),
      type: 'button',
      title: p.text,
      text: (on ? '✓ ' : '') + p.label,
      onclick: function () { toggleRequirement(p); },
    }));
  });
}

function toggleRequirement(preset) {
  var i = state.requirements.selected.indexOf(preset.key);
  var area = $('task-requirements');
  var current = area.value;
  if (i >= 0) {
    state.requirements.selected.splice(i, 1);
    var next = current.split('\n\n').filter(function (block) { return block.trim() !== preset.text.trim(); });
    area.value = next.join('\n\n');
  } else {
    state.requirements.selected.push(preset.key);
    area.value = current.trim() ? current.replace(/\s+$/, '') + '\n\n' + preset.text : preset.text;
  }
  renderRequirementPresets();
}

function loadModels() {
  return api('/models').then(function (m) {
    state.models = m;
    if (!m.available) {
      toast('这个 DSH 组合没有提供 llm 服务：' + (m.reason || ''), true);
    }
    // 目录到位后重画候选卡（首帧可能在目录之前就渲染过一版）
    if (state.candidates.length > 0) renderCandidates();
    // 优化模型下拉也依赖目录（否则只有占位项）
    fillOptimizerModels();
    return m;
  });
}

// ── 实验列表 ─────────────────────────────────────────────────

function loadExperiments() {
  var search = $('search').value.trim();
  var category = $('filter-category').value;
  var qs = [];
  if (search) qs.push('search=' + encodeURIComponent(search));
  if (category) qs.push('category=' + encodeURIComponent(category));
  return api('/experiments' + (qs.length ? '?' + qs.join('&') : '')).then(function (r) {
    state.experiments = r.experiments;
    renderExperiments();
  });
}

function renderExperiments() {
  var box = $('experiment-list');
  clear(box);
  if (state.experiments.length === 0) {
    box.appendChild(el('div', {
      class: 'empty',
      text: '还没有实验。点"试一个示例"用内置示例题开始第一次对比，或点"新建对比"写自己的题目。',
    }));
    return;
  }
  state.experiments.forEach(function (e) {
    var meta = el('div', { class: 'exp-meta' });
    meta.appendChild(el('span', { text: fmtTime(e.createdAt) }));
    meta.appendChild(el('span', { text: e.candidateCount + ' 个候选' }));
    if (e.succeeded) meta.appendChild(el('span', { class: 'pill ok', text: '成功 ' + e.succeeded }));
    if (e.failed) meta.appendChild(el('span', { class: 'pill bad', text: '失败/中断 ' + e.failed }));
    if (e.withHtml) meta.appendChild(el('span', { text: '有作品 ' + e.withHtml }));
    if (e.vote) meta.appendChild(el('span', { text: '已评价：' + voteLabel(e.vote.choice) + (e.vote.revealed ? '（已揭晓）' : '') }));

    var left = el('div', null, [
      el('div', { class: 'exp-title', text: e.title }),
      meta,
    ]);
    var actions = el('div', { class: 'exp-actions' }, [
      el('button', { class: 'btn small', text: '打开', onclick: function () { openExperiment(e.id); } }),
      el('button', {
        class: 'btn small', text: '复制实验',
        onclick: function () { duplicateExperiment(e.id); },
      }),
      el('button', {
        class: 'btn small danger', text: '删除',
        onclick: function () { confirmDelete(e.id, e.title); },
      }),
    ]);
    box.appendChild(el('div', { class: 'exp' }, [left, actions]));
  });
}

function voteLabel(choice) {
  if (choice === 'tie') return '平局';
  if (choice === 'undecided') return '无法判断';
  return '偏好 ' + choice;
}

function confirmDelete(id, title) {
  var msg = '删除实验「' + title + '」？\n\n将移除：本地的实验记录、原始输出与作品文件。\n不会移除：保存的配方（配方是独立对象）。\n\n此操作不可撤销。';
  if (!window.confirm(msg)) return;
  api('/experiments/' + encodeURIComponent(id), { method: 'DELETE' }).then(function () {
    toast('已删除');
    loadExperiments();
  }).catch(function (err) { toast('删除失败：' + err.message, true); });
}

function openExperiment(id) {
  return api('/experiments/' + encodeURIComponent(id)).then(function (r) {
    state.current = r;
    state.blind = false;
    state.revealed = Boolean(r.vote && r.vote.revealed);
    state.streams = {};
    state.screenshots = {};
    renderRun();
    renderCompare();
    if (r.attempts.length === 0) {
      toast('这个实验还没有候选记录');
      showView('new');
      return;
    }
    var running = r.attempts.some(function (a) { return a.running || a.status === 'queued' || a.status === 'running'; });
    if (running) { showView('run'); startRunPolling(); }
    else { showView('compare'); }
  }).catch(function (err) {
    toast('打开失败：' + err.message, true);
  });
}

function duplicateExperiment(id) {
  var src = state.experiments.filter(function (e) { return e.id === id; })[0];
  if (!src) return;
  api('/experiments/' + encodeURIComponent(id)).then(function (r) {
    $('task-title').value = r.experiment.title + '（副本）';
    $('task-category').value = r.experiment.category || 'dashboard';
    $('task-prompt').value = r.experiment.taskSnapshot.prompt || '';
    $('task-requirements').value = r.experiment.taskSnapshot.outputRequirements || '';
    $('task-starthtml').value = r.experiment.taskSnapshot.startHtml || '';
    $('preview-network').value = r.experiment.previewPolicy.networkPolicy || 'offline';
    updatePromptCount();
    state.candidates = [];
    state.candidateSeq = 0;
    var seen = {};
    r.attempts.forEach(function (a) {
      if (seen[a.slot]) return;
      seen[a.slot] = true;
      addCandidate(a.recipe.name || String.fromCharCode(65 + a.slot), {
        provider: a.recipe.provider, model: a.recipe.model,
        systemPrompt: a.recipe.systemPrompt, promptSegments: a.recipe.promptSegments,
        temperature: a.recipe.temperature, maxTokens: a.recipe.maxTokens,
        reasoningEffort: a.recipe.reasoningEffort,
      });
    });
    showView('new');
    toast('已复制题目与候选配置；因为要复用已冻结的题目，请确认后点开始生成新的实验');
  }).catch(function (err) { toast('复制失败：' + err.message, true); });
}

// ── 新建实验 ─────────────────────────────────────────────────

var EXAMPLE_TASK = '制作一个可切换城市与日期的天气仪表盘，使用内置示例数据，包含折线图和昼夜主题，所有内容放在一个 HTML 中。';

function updatePromptCount() {
  var n = $('task-prompt').value.length;
  var span = $('prompt-count');
  span.textContent = n + ' / 50000';
  span.style.color = n > 50000 ? 'var(--bad)' : '';
}

function addCandidate(name, preset) {
  if (state.candidates.length >= 4) { toast('最多 4 个候选'); return; }
  var providers = (state.models && state.models.providers) || [];
  var firstProvider = providers[0] ? providers[0].id : '';
  var models = (state.models && state.models.modelsByProvider && state.models.modelsByProvider[firstProvider]) || [];
  var seq = state.candidateSeq++;
  var c = {
    id: 'c' + seq,
    name: name || String.fromCharCode(65 + state.candidates.length),
    provider: (preset && preset.provider) || firstProvider,
    model: (preset && preset.model) || (models[0] ? models[0].id : ''),
    systemPrompt: (preset && preset.systemPrompt) || '',
    promptSegments: (preset && preset.promptSegments) || [],
    temperature: preset && typeof preset.temperature === 'number' ? preset.temperature : null,
    maxTokens: preset && typeof preset.maxTokens === 'number' ? preset.maxTokens : null,
    reasoningEffort: (preset && preset.reasoningEffort) || null,
    resolved: null,
    diff: [],
  };
  state.candidates.push(c);
  resolveCandidate(c);
  renderCandidates();
}

/**
 * 再添加一个候选，并自动挑一个"当前还没被用过"的模型。
 * 加候选本身是 M1 就有的能力；这里只是省掉"每次都要手选一遍模型"的重复劳动，
 * 让 3–4 套配置比对不必点很多次下拉框。
 */
function addCandidateUnusedModel() {
  if (state.candidates.length >= 4) { toast('最多 4 个候选', true); return; }
  var used = {};
  state.candidates.forEach(function (c) { used[c.provider + '/' + c.model] = true; });
  var providers = (state.models && state.models.providers) || [];
  var pick = null;
  for (var i = 0; i < providers.length && !pick; i++) {
    var ms = (state.models.modelsByProvider && state.models.modelsByProvider[providers[i].id]) || [];
    for (var j = 0; j < ms.length; j++) {
      var key = providers[i].id + '/' + ms[j].id;
      if (!used[key]) { pick = { provider: providers[i].id, model: ms[j].id }; break; }
    }
  }
  if (!pick) { toast('没找到还没用过的模型，请手动选择', true); return; }
  addCandidate(null, pick);
  toast('已添加候选：' + pick.provider + ' / ' + pick.model);
}

function removeCandidate(id) {
  if (state.candidates.length <= 1) { toast('至少保留一个候选'); return; }
  state.candidates = state.candidates.filter(function (c) { return c.id !== id; });
  renderCandidates();
}

function copyCandidate(id) {
  var src = state.candidates.filter(function (c) { return c.id === id; })[0];
  if (!src) return;
  if (state.candidates.length >= 4) { toast('最多 4 个候选'); return; }
  var idx = state.candidates.indexOf(src);
  var copy = JSON.parse(JSON.stringify(src));
  copy.id = 'c' + (state.candidateSeq++);
  copy.name = src.name + ' 副本';
  state.candidates.splice(idx + 1, 0, copy);
  state.lastCopied = copy.id;
  toast('已复制候选。改动后的字段会高亮显示它与原卡的差异。');
  renderCandidates();
}

/** 找出复制出来的卡相对原卡的差异字段（F：复制候选只修改提示词时差异可见）。 */
function diffFields(c) {
  if (!state.lastCopied || c.id !== state.lastCopied) return [];
  var src = state.candidates.filter(function (x) { return x.name === c.name.replace(' 副本', ''); })[0];
  if (!src) return [];
  var out = [];
  var fields = [['provider', '模型来源'], ['model', '模型'], ['systemPrompt', '系统提示词'], ['temperature', '温度'], ['maxTokens', '输出上限'], ['reasoningEffort', '思考档位']];
  for (var i = 0; i < fields.length; i++) {
    if (JSON.stringify(src[fields[i][0]]) !== JSON.stringify(c[fields[i][0]])) out.push(fields[i][1]);
  }
  if (JSON.stringify(src.promptSegments) !== JSON.stringify(c.promptSegments)) out.push('提示词片段');
  return out;
}

/** 每张卡的"解析结果"区域是独立容器，异步回来后只刷新它，
 *  绝不整表重绘 —— 否则用户正在编辑的文本、已选的下拉值都会被丢掉。 */
function resolvedSlotId(c) { return 'resolved-' + c.id; }

function resolveCandidate(c) {
  c.resolved = null;
  c.resolving = true;
  renderResolvedArea(c);
  if (!c.provider || !c.model) { c.resolving = false; renderResolvedArea(c); return; }
  api('/models/resolve', { method: 'POST', body: { provider: c.provider, model: c.model, reasoningEffort: c.reasoningEffort } })
    .then(function (r) { c.resolved = r.resolved; c.resolving = false; renderResolvedArea(c); })
    .catch(function () { c.resolved = { note: '无法解析（连接失败）' }; c.resolving = false; renderResolvedArea(c); });
}

/** 只重画这一张卡的解析结果区域。 */
function renderResolvedArea(c) {
  var slot = document.getElementById(resolvedSlotId(c));
  if (!slot) return;
  clear(slot);
  buildResolvedArea(c, slot);
}

/** 解析结果区域包含：思考档位选择、解析出的配置、以及"未确认"提示。 */
function buildResolvedArea(c, slot) {
  if (c.resolving) { slot.appendChild(el('div', { class: 'muted', text: '正在核查这个模型的可用参数…' })); return; }
  var resolved = c.resolved;

  var efforts = (resolved && resolved.availableReasoningEfforts) || null;
  if (efforts && efforts.length) {
    var effSel = el('select', { class: 'input', 'data-role': 'reasoning' });
    effSel.appendChild(el('option', { value: '', text: '（不指定）' }));
    efforts.forEach(function (e) {
      var o = el('option', { value: e, text: e });
      if (e === c.reasoningEffort) o.selected = true;
      effSel.appendChild(o);
    });
    effSel.addEventListener('change', function () { c.reasoningEffort = effSel.value || null; resolveCandidate(c); });
    slot.appendChild(el('div', null, [el('span', { class: 'label', text: '思考档位' }), effSel]));
    if (c.reasoningEffort && resolved.reasoningEffortSupported === false) {
      slot.appendChild(el('div', { class: 'diff-note', style: 'color:var(--bad)', text: '这个模型不支持该档位，开始会被阻止' }));
    }
  } else {
    slot.appendChild(el('div', { class: 'muted', text: '思考档位：未确认（该适配器没有上报档位清单）' }));
  }

  if (resolved) {
    var kv = el('dl', { class: 'kv' });
    kv.appendChild(el('dt', { text: '上下文窗口' }));
    kv.appendChild(el('dd', { text: resolved.contextWindow === null || resolved.contextWindow === undefined ? '未知' : String(resolved.contextWindow) }));
    kv.appendChild(el('dt', { text: '模型默认输出上限' }));
    kv.appendChild(el('dd', { text: resolved.defaultMaxTokens === null || resolved.defaultMaxTokens === undefined ? '未知' : String(resolved.defaultMaxTokens) }));
    if (resolved.note) {
      kv.appendChild(el('dt', { text: '说明' }));
      kv.appendChild(el('dd', { text: resolved.note }));
    }
    slot.appendChild(kv);
  }
}

function renderCandidates() {
  var box = $('candidates');
  clear(box);
  var modelData = state.models || { providers: [], modelsByProvider: {} };

  state.candidates.forEach(function (c, i) {
    var diffs = diffFields(c);
    var card = el('div', { class: 'cand' + (diffs.length ? ' diff' : ''), 'data-cand-id': c.id });

    // 头：名称 + 序号 + 操作
    var nameInput = el('input', { class: 'cand-name', value: c.name });
    nameInput.addEventListener('input', function () { c.name = nameInput.value; });
    card.appendChild(el('div', { class: 'cand-head' }, [
      el('span', { class: 'cand-tag', text: '候选 ' + String.fromCharCode(65 + i) }),
      nameInput,
      el('button', { class: 'btn small', text: '复制', onclick: function () { copyCandidate(c.id); } }),
      el('button', { class: 'btn small danger', text: '删除', onclick: function () { removeCandidate(c.id); } }),
    ]));
    if (diffs.length) card.appendChild(el('div', { class: 'diff-note', text: '与原卡的差异：' + diffs.join('、') }));

    // provider / model
    var provSel = el('select', { class: 'input', 'data-role': 'provider' });
    modelData.providers.forEach(function (p) {
      var o = el('option', { value: p.id, text: p.name || p.id });
      if (p.id === c.provider) o.selected = true;
      provSel.appendChild(o);
    });
    provSel.addEventListener('change', function () {
      c.provider = provSel.value;
      var ms = (modelData.modelsByProvider && modelData.modelsByProvider[c.provider]) || [];
      c.model = ms[0] ? ms[0].id : '';
      resolveCandidate(c);
      renderCandidates();
    });

    var models = (modelData.modelsByProvider && modelData.modelsByProvider[c.provider]) || [];
    var modelSel = el('select', { class: 'input', 'data-role': 'model' });
    models.forEach(function (m) {
      var o = el('option', { value: m.id, text: m.name || m.id });
      if (m.id === c.model) o.selected = true;
      modelSel.appendChild(o);
    });
    if (models.length === 0) modelSel.appendChild(el('option', { value: '', text: '（这个来源没有可用模型）' }));
    modelSel.addEventListener('change', function () { c.model = modelSel.value; resolveCandidate(c); });

    card.appendChild(el('div', { class: 'row gap' }, [
      el('div', { style: 'flex:1' }, [el('span', { class: 'label', text: '模型来源' }), provSel]),
      el('div', { style: 'flex:1' }, [el('span', { class: 'label', text: '模型' }), modelSel]),
    ]));

    // 解析结果区域：单独容器，异步回来后只重画这里
    var resolvedSlot = el('div', { id: resolvedSlotId(c), 'data-resolved': '1' });
    buildResolvedArea(c, resolvedSlot);
    card.appendChild(resolvedSlot);

    // 展开区域：系统提示词、参数、片段
    var details = el('details', { class: 'more' });
    details.appendChild(el('summary', { text: '系统提示词、参数与片段' }));

    var sysArea = el('textarea', { class: 'input area', rows: 3, placeholder: '可选：这个候选专属的系统提示词' });
    sysArea.value = c.systemPrompt || '';
    sysArea.addEventListener('input', function () { c.systemPrompt = sysArea.value; });
    details.appendChild(el('span', { class: 'label', text: '系统提示词' }));
    details.appendChild(sysArea);

    var segArea = el('textarea', { class: 'input area', rows: 2, placeholder: '可选：提示词片段（只是文本拼接，不是 Skill 加载）' });
    segArea.value = (c.promptSegments || []).join('\n---\n');
    segArea.addEventListener('input', function () {
      c.promptSegments = segArea.value.split('\n---\n').map(function (s) { return s.trim(); }).filter(Boolean);
    });
    details.appendChild(el('span', { class: 'label', text: '提示词片段（用一行 --- 分隔多段）' }));
    details.appendChild(segArea);

    var tempInput = el('input', { class: 'input', type: 'number', step: '0.1', min: '0', max: '2', value: c.temperature === null ? '' : String(c.temperature), placeholder: '未指定' });
    tempInput.addEventListener('input', function () {
      var v = tempInput.value.trim();
      c.temperature = v === '' ? null : Number(v);
    });
    var maxInput = el('input', { class: 'input', type: 'number', min: '1', value: c.maxTokens === null ? '' : String(c.maxTokens), placeholder: c.resolved && c.resolved.defaultMaxTokens ? String(c.resolved.defaultMaxTokens) + '（模型默认）' : '未指定' });
    maxInput.addEventListener('input', function () {
      var v = maxInput.value.trim();
      c.maxTokens = v === '' ? null : Number(v);
    });
    details.appendChild(el('div', { class: 'row gap' }, [
      el('div', { style: 'flex:1' }, [el('span', { class: 'label', text: '温度' }), tempInput]),
      el('div', { style: 'flex:1' }, [el('span', { class: 'label', text: '输出上限' }), maxInput]),
    ]));
    card.appendChild(details);

    box.appendChild(card);
  });

  $('candidate-hint').textContent = state.candidates.length + ' / 4 套。' +
    (state.candidates.length < 2 ? '至少需要 2 套才能对比。' : '复制候选后差异会高亮显示。');
}

function startExperiment() {
  // 防双击：同一个 requestId 只提交一次（A05）
  if (state.requestId && state.startedRequestId === state.requestId) {
    toast('这一轮已经开始了');
    return;
  }
  var errBox = $('start-errors');
  errBox.hidden = true;
  clear(errBox);

  var title = $('task-title').value.trim() || meaningfulTitle($('task-prompt').value) || '未命名实验';
  var snap = currentTaskSnapshot();
  if (snap.prompt.trim().length === 0) {
    $('start-errors').hidden = false;
    clear($('start-errors'));
    $('start-errors').appendChild(el('div', { text: '请先填写题目。' }));
    toast('请先填写题目', true);
    return;
  }
  var body = {
    title: title,
    category: $('task-category').value,
    prompt: snap.prompt,
    outputRequirements: snap.outputRequirements,
    startHtml: snap.startHtml,
    previewPolicy: { networkPolicy: $('preview-network').value },
    outputPolicy: { concurrency: Number($('concurrency').value) },
  };

  state.requestId = 'req_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  $('btn-start').disabled = true;
  $('start-note').textContent = '正在创建…';

  api('/experiments', { method: 'POST', body: body }).then(function (created) {
    var expId = created.experiment.id;
    var candidates = state.candidates.map(function (c) {
      return {
        name: c.name, provider: c.provider, model: c.model,
        systemPrompt: c.systemPrompt, promptSegments: c.promptSegments,
        temperature: c.temperature, maxTokens: c.maxTokens, reasoningEffort: c.reasoningEffort,
      };
    });
    return api('/experiments/' + encodeURIComponent(expId) + '/start', {
      method: 'POST',
      body: { candidates: candidates, concurrency: Number($('concurrency').value), requestId: state.requestId },
    }).then(function (r) {
      state.startedRequestId = state.requestId;
      $('start-note').textContent = '';
      $('btn-start').disabled = false;
      toast('已开始 ' + r.started.length + ' 个候选（并发 ' + r.concurrency + '）');
      return openExperiment(expId);
    });
  }).catch(function (err) {
    $('btn-start').disabled = false;
    $('start-note').textContent = '';
    state.requestId = null;
    var lines = [];
    if (err.body && err.body.problems) lines = err.body.problems;
    else lines = [err.message];
    clear(errBox);
    errBox.appendChild(el('div', { text: '开始前检查未通过：' }));
    var ul = el('ul');
    lines.forEach(function (l) { ul.appendChild(el('li', { text: l })); });
    errBox.appendChild(ul);
    errBox.hidden = false;
    errBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });
}

function meaningfulTitle(prompt) {
  var t = (prompt || '').trim().replace(/\s+/g, ' ');
  if (!t) return '';
  return t.length > 26 ? t.slice(0, 26) + '…' : t;
}

function currentTaskSnapshot() {
  return {
    prompt: $('task-prompt').value,
    outputRequirements: $('task-requirements').value,
    startHtml: $('task-starthtml').value,
  };
}

function previewRequest() {
  var box = $('request-preview');
  // 用无状态接口：不会为了预览而创建空实验（否则实验列表会被"预览用"垃圾填满）。
  api('/preview-request', {
    method: 'POST',
    body: {
      task: currentTaskSnapshot(),
      candidates: state.candidates.map(function (c) {
        return { provider: c.provider, model: c.model, systemPrompt: c.systemPrompt, promptSegments: c.promptSegments };
      }),
    },
  }).then(function (r) {
    clear(box);
    box.appendChild(el('div', { class: 'muted', text: '拼接规则版本 ' + r.compilerVersion + ' · 题目 hash ' + r.taskHash.slice(0, 16) + '…' }));
    r.requests.forEach(function (req) {
      box.appendChild(el('div', { class: 'muted', style: 'margin-top:10px', text: '候选 ' + String.fromCharCode(65 + req.slot) + '（' + req.provider + ' / ' + req.model + '）' }));
      box.appendChild(el('div', { text: '── system ──' }));
      box.appendChild(el('div', { text: req.system === null ? '（不发送 system 消息）' : req.system }));
      box.appendChild(el('div', { text: '── user ──' }));
      box.appendChild(el('div', { text: req.user }));
      box.appendChild(el('div', { class: 'muted', text: '温度 ' + (req.temperature === null ? '未指定' : req.temperature) +
        ' · 输出上限 ' + (req.maxTokens === null ? '未指定' : req.maxTokens) +
        ' · 思考档位 ' + (req.reasoningEffort === null ? '未指定' : req.reasoningEffort) +
        ' · tools 不发送' }));
    });
    box.hidden = false;
  }).catch(function (err) { toast('生成预览失败：' + err.message, true); });
}

// ── 运行面板 ─────────────────────────────────────────────────

function startRunPolling() {
  stopRunPolling();
  state.runPollTimer = setInterval(function () {
    if (!state.current) return;
    var expId = state.current.experiment.id;
    api('/experiments/' + encodeURIComponent(expId)).then(function (r) {
      state.current = r;
      renderRun();
      var running = r.attempts.some(function (a) { return a.running || a.status === 'queued' || a.status === 'running'; });
      if (!running) {
        stopRunPolling();
        state.streams = {};
        renderCompare();
        $('btn-goto-compare').disabled = false;
        loadExperiments();
        toast('本轮结束，可以进入对比');
      }
    }).catch(function () { /* 保持上一次显示，不要因为一次轮询失败就清空 */ });
    // 实时流单独拉：失败就沿用上一帧，不影响主轮询
    api('/experiments/' + encodeURIComponent(expId) + '/live').then(function (r) {
      var map = {};
      (r.streams || []).forEach(function (s) { map[s.attemptId] = s; });
      state.streams = map;
      if (state.view === 'run') renderRun();
    }).catch(function () { /* 忽略：实时流只是锦上添花 */ });
  }, 700);
}
function stopRunPolling() {
  if (state.runPollTimer) { clearInterval(state.runPollTimer); state.runPollTimer = null; }
}

function lastAttemptPerSlot(attempts) {
  var map = {};
  attempts.forEach(function (a) { map[a.slot] = a; });
  return Object.keys(map).sort(function (x, y) { return Number(x) - Number(y); }).map(function (k) { return map[k]; });
}

function statusLabel(a) {
  var map = {
    queued: '排队中', running: '生成中', completed: '已完成', failed: '失败',
    cancelled: '已取消', timed_out: '超时', interrupted: '已中断（宿主重启）',
  };
  return map[a.status] || a.status;
}

function renderRun() {
  if (!state.current) return;
  var r = state.current;
  $('run-title').textContent = r.experiment.title;
  var box = $('run-cards');
  clear(box);
  var rawBox = $('run-raw');
  clear(rawBox);

  lastAttemptPerSlot(r.attempts).forEach(function (a, i) {
    var card = el('div', { class: 'cand' });
    card.appendChild(el('div', { class: 'cand-head' }, [
      el('span', { class: 'cand-tag', text: '候选 ' + String.fromCharCode(65 + i) }),
      el('span', { style: 'flex:1;font-weight:600', text: a.recipe.name }),
    ]));
    card.appendChild(el('div', { class: 'status' }, [
      el('span', { class: 'dot ' + a.status }),
      el('span', { text: statusLabel(a) }),
      a.status === 'running' && a.receipt && a.receipt.firstTextAt
        ? el('span', { class: 'muted', text: '首正文 ' + ((a.receipt.firstTextAt - a.receipt.startedAt) / 1000).toFixed(1) + ' 秒' })
        : null,
    ]));
    card.appendChild(el('div', { class: 'muted', text: a.recipe.provider + ' / ' + a.recipe.model }));

    // 实时正文流：内容来自 /live（宿主在 text-delta 时缓冲的尾部文本）。
    // 以前这里读一个从没被写过的 state.streams，所以永远看不到生成过程（M1 实测缺陷）。
    var live = state.streams[a.id];
    if (live && (live.text || live.reasoning)) {
      var liveBox = el('div', { class: 'live' });
      var head = el('div', { class: 'live-head' }, [
        el('span', { class: 'live-dot' + (a.status === 'running' ? ' on' : '') }),
        el('span', { text: a.status === 'running' ? '实时输出（还在生成）' : '本次生成的正文' }),
        el('span', { class: 'muted', text: '正文 ' + (live.textLength || 0) + ' 字'
          + (live.reasoningLength ? ' · 推理 ' + live.reasoningLength + ' 字' : '')
          + (live.truncated ? ' · 只显示尾部' : '') }),
      ]);
      liveBox.appendChild(head);
      if (live.reasoning) {
        var rdet = el('details', { class: 'more live-reasoning' });
        rdet.appendChild(el('summary', { text: '推理过程（' + live.reasoningLength + ' 字）' }));
        rdet.appendChild(el('pre', { class: 'stream reasoning', text: live.reasoning, 'data-live': a.id + ':r' }));
        liveBox.appendChild(rdet);
      }
      liveBox.appendChild(el('pre', { class: 'stream', text: live.text, 'data-live': a.id }));
      card.appendChild(liveBox);
      // 生成中自动吸到底部，方便盯着看
      if (a.status === 'running') {
        setTimeout(function () {
          var nodes = document.querySelectorAll('pre[data-live="' + a.id + '"]');
          for (var n = 0; n < nodes.length; n++) { nodes[n].scrollTop = nodes[n].scrollHeight; }
        }, 0);
      }
    } else if (a.status === 'running') {
      card.appendChild(el('div', { class: 'muted', text: '正在等待模型返回第一个字…' }));
    }

    // 失败：给出可读原因与下一步
    if (a.error) {
      card.appendChild(el('div', { class: 'diff-note', style: 'color:var(--bad)', text: a.error.title }));
      card.appendChild(el('div', { class: 'muted', text: a.error.hint }));
      if (a.error.status) card.appendChild(el('div', { class: 'muted', text: 'HTTP 状态：' + a.error.status }));
    }

    // 提取结果
    if (a.extraction) {
      var ex = a.extraction;
      var label = ex.status === 'ok' ? '已提取作品' : ex.status === 'multiple' ? '有多个 HTML 块，需要你选择' : '未识别到作品';
      card.appendChild(el('div', { class: 'muted', text: label + ' · 提取器 v' + (ex.version || '?') + (ex.mode ? ' · 方式 ' + ex.mode : '') }));
      if (ex.warnings && ex.warnings.length) {
        ex.warnings.forEach(function (w) { card.appendChild(el('div', { class: 'muted', text: '⚠ ' + w.message })); });
      }
      if (ex.status === 'multiple') {
        card.appendChild(el('div', { class: 'muted', text: '请在下方"原始输出"里选择要作为作品的块。' }));
      }
    }

    // 收据
    if (a.receipt) {
      var rc = a.receipt;
      var kv = el('dl', { class: 'kv' });
      kv.appendChild(el('dt', { text: '用时' }));
      kv.appendChild(el('dd', { text: fmtDuration(rc.startedAt, rc.finishedAt) }));
      kv.appendChild(el('dt', { text: '收尾原因' }));
      kv.appendChild(el('dd', { text: rc.finishReason === null ? '未知' : rc.finishReason }));
      kv.appendChild(el('dt', { text: '用量' }));
      kv.appendChild(el('dd', { text: [usageField(rc.usage, 'inputTokens', '输入'), usageField(rc.usage, 'outputTokens', '输出'), usageField(rc.usage, 'cacheReadTokens', '缓存命中'), usageField(rc.usage, 'reasoningTokens', '推理')].join(' · ') }));
      card.appendChild(kv);
    }

    var actions = el('div', { class: 'row gap wrap' }, []);
    if (a.running || a.status === 'queued') {
      actions.appendChild(el('button', { class: 'btn small danger', text: '停止这个候选', onclick: function () { cancelAttempt(a.id); } }));
    } else {
      actions.appendChild(el('button', { class: 'btn small', text: '重试', onclick: function () { retryAttempt(a.id); } }));
    }
    actions.appendChild(el('button', { class: 'btn small', text: '下载原始输出', onclick: function () { download(a.id, 'raw'); } }));
    if (a.canPreview) actions.appendChild(el('button', { class: 'btn small', text: '下载作品 HTML', onclick: function () { download(a.id, 'html'); } }));
    card.appendChild(actions);
    box.appendChild(card);

    // 原始输出详情
    var det = el('div', { style: 'margin-bottom:14px' });
    det.appendChild(el('div', { class: 'muted', text: '候选 ' + String.fromCharCode(65 + i) + ' · ' + a.recipe.name + ' · ' + statusLabel(a.status) }));
    if (a.extraction && a.extraction.status === 'multiple') {
      det.appendChild(el('div', { class: 'muted', text: '这个候选有多个 HTML 块，请选择要保存为作品的那个：' }));
    }
    det.appendChild(el('button', {
      class: 'btn small', text: '查看原始正文',
      onclick: function () { viewRaw(a.id); },
    }));
    rawBox.appendChild(det);
  });

  $('btn-goto-compare').disabled = lastAttemptPerSlot(r.attempts).every(function (a) { return !a.canPreview; });
}

function viewRaw(attemptId) {
  fetch(API + '/experiments/' + encodeURIComponent(state.current.experiment.id) + '/attempts/' + encodeURIComponent(attemptId) + '/raw')
    .then(function (r) { return r.text(); })
    .then(function (text) {
      var win = window.open('', '_blank');
      if (!win) { toast('浏览器拦截了新窗口，请允许弹出窗口', true); return; }
      win.document.title = '原始输出 ' + attemptId;
      var pre = win.document.createElement('pre');
      pre.style.cssText = 'white-space:pre-wrap;word-break:break-word;font:12px/1.5 monospace;padding:16px';
      pre.textContent = text;
      win.document.body.appendChild(pre);
    }).catch(function (err) { toast('读取失败：' + err.message, true); });
}

function download(attemptId, kind) {
  window.open(API + '/experiments/' + encodeURIComponent(state.current.experiment.id)
    + '/attempts/' + encodeURIComponent(attemptId) + '/' + kind, '_blank');
}

function cancelAttempt(attemptId) {
  api('/experiments/' + encodeURIComponent(state.current.experiment.id) + '/cancel', { method: 'POST', body: { attemptId: attemptId } })
    .then(function () { toast('已请求停止'); })
    .catch(function (err) { toast('停止失败：' + err.message, true); });
}

function retryAttempt(attemptId) {
  api('/experiments/' + encodeURIComponent(state.current.experiment.id) + '/attempts/' + encodeURIComponent(attemptId) + '/retry', { method: 'POST' })
    .then(function (r) {
      toast('已新建尝试 #' + r.attemptNo + '（原记录保留）');
      return openExperiment(state.current.experiment.id);
    })
    .catch(function (err) { toast('重试失败：' + err.message, true); });
}

// ── 作品对比 ─────────────────────────────────────────────────

function visibleAttempts() {
  if (!state.current) return [];
  return lastAttemptPerSlot(state.current.attempts).filter(function (a) { return a.canPreview || a.error || a.extraction; });
}

function renderCompare() {
  if (!state.current) return;
  var r = state.current;
  $('compare-title').textContent = r.experiment.title;
  var attempts = lastAttemptPerSlot(r.attempts);
  var shown = attempts.slice(0, 4);

  var noteParts = [];
  if (r.experiment.previewPolicy.networkPolicy === 'cdn') noteParts.push('预览使用受控 CDN 模式：需要联网，资源失败会标注"外部资源失败"。');
  else noteParts.push('预览为离线模式：外部请求被禁用。');
  noteParts.push('两份作品使用相同的逻辑视口，因此落到同一响应式断点。');
  if (state.blind && !state.revealed) noteParts.push('配置身份已隐藏；作品页面内容本身可能仍写出模型名，因此这是"隐藏配置身份"，不是严格双盲。');
  $('compare-note').textContent = noteParts.join(' ');

  var grid = $('compare-grid');
  clear(grid);
  // 2 个候选：并排两列（原行为）。3–4 个：用 multi 走两行，否则四份会挤在一条里看不清。
  grid.className = 'compare-grid' + (shown.length <= 1 ? ' single' : '') + (shown.length >= 3 ? ' multi' : '');

  shown.forEach(function (a, i) {
    var wrap = el('div', { class: 'frame-wrap' });
    var head = el('div', { class: 'frame-head' });
    head.appendChild(el('span', { class: 'cand-tag', text: String.fromCharCode(65 + i) }));
    // 揭示后必须一眼看出 A/B 到底是哪套配置。候选默认名就是 "A"/"B"，
    // 只显示名字等于没揭晓（实测缺陷：揭晓后卡片仍只写 A 和 B）。
    head.appendChild(el('span', {
      style: 'font-weight:600',
      text: state.blind && !state.revealed
        ? '（身份已隐藏）'
        : a.recipe.name + ' · ' + a.recipe.provider + ' / ' + a.recipe.model,
    }));
    head.appendChild(el('span', { class: 'spacer' }));
    head.appendChild(el('span', { class: 'vp-label', text: vpLabel() }));
    if (a.canPreview) {
      head.appendChild(el('button', { class: 'btn small', text: '重置', onclick: function () { resetFrame(a.id); } }));
      head.appendChild(el('button', { class: 'btn small', text: '全屏', onclick: function () { fullscreen(a.id); } }));
      head.appendChild(el('button', { class: 'btn small', text: '静音', onclick: function () { muteFrame(a.id); } }));
    }
    wrap.appendChild(head);

    var body = el('div', { class: 'frame-body' });
    if (a.canPreview) {
      body.appendChild(buildFrame(a));
    } else {
      var msg = el('div', { class: 'frame-error' });
      msg.appendChild(el('b', { text: '这个候选没有可预览的作品' }));
      msg.appendChild(el('div', { text: a.error ? a.error.title + '：' + a.error.hint : (a.extraction && a.extraction.status === 'none' ? '未从模型输出里识别到 HTML。' : '作品尚未生成完成。') }));
      var acts = el('div', { style: 'margin-top:10px;display:flex;gap:8px;flex-wrap:wrap' });
      acts.appendChild(el('button', { class: 'btn small', text: '下载原始输出', onclick: function () { download(a.id, 'raw'); } }));
      acts.appendChild(el('button', { class: 'btn small', text: '重试', onclick: function () { retryAttempt(a.id); } }));
      msg.appendChild(acts);
      body.appendChild(msg);
    }
    wrap.appendChild(body);
    grid.appendChild(wrap);
  });

  // 截图区
  var shots = Object.keys(state.screenshots);
  if (shots.length) {
    var shotPanel = el('div', { class: 'panel', style: 'margin-top:12px' });
    shotPanel.appendChild(el('h3', { class: 'h3', text: '初始截图' }));
    shotPanel.appendChild(el('div', { class: 'muted', text: '截图是对作品重新加载后、未做任何交互时捕获的初始画面，不等于你现在看到的状态。' }));
    shots.forEach(function (id) {
      var s = state.screenshots[id];
      var d = el('div', { style: 'margin-top:12px' });
      var rec = attempts.filter(function (x) { return x.id === id; })[0];
      d.appendChild(el('div', { class: 'muted', text: (rec ? rec.recipe.name : id) + ' · ' + (s.meta.viewport ? s.meta.viewport.width + 'x' + s.meta.viewport.height : '?')
        + ' · DPR ' + (s.meta.dpr === null || s.meta.dpr === undefined ? '?' : s.meta.dpr)
        + ' · 等待 ' + (s.meta.durationMs === null ? '?' : s.meta.durationMs + 'ms')
        + ' · 网络策略 ' + (s.meta.networkPolicy || '?') }));
      if (s.meta.stateNote) d.appendChild(el('div', { class: 'muted', text: s.meta.stateNote }));
      if (s.base64) {
        d.appendChild(el('img', { src: 'data:image/png;base64,' + s.base64, style: 'max-width:100%;border:1px solid var(--line);border-radius:8px;margin-top:6px' }));
      } else {
        d.appendChild(el('div', { class: 'diff-note', style: 'color:var(--warn)', text: '截图未成功：' + (s.meta.reason || s.meta.status || '未知原因') + '（作品本身仍可预览）' }));
      }
      shotPanel.appendChild(d);
    });
    grid.parentNode.insertBefore(shotPanel, grid.nextSibling);
  }

  renderVoteRow(shown);
  renderCompareDetails(attempts);
  updateIdentityControls();
}

/**
 * 只刷新"隐藏配置身份 / 揭晓身份"两个按钮，**不重绘作品区**。
 * 重绘会重建 iframe，把用户在作品里的操作状态全部丢掉，所以这里必须做最小刷新。
 * 保存评价后也要调用它：否则揭晓按钮要等到下一次重绘才出现（实测缺陷）。
 */
function updateIdentityControls() {
  var vote = state.current && state.current.vote;
  $('btn-reveal').hidden = !(vote && vote.revealed === null);
  $('btn-blind').textContent = state.blind ? '显示配置身份' : '隐藏配置身份';
}

function vpLabel() {
  var vp = (state.meta && state.meta.viewports && state.meta.viewports[state.viewport]) || { width: 1280, height: 720 };
  return vp.width + 'x' + vp.height;
}

function buildFrame(a) {
  var vp = (state.meta && state.meta.viewports && state.meta.viewports[state.viewport]) || { width: 1280, height: 720 };
  var wrap = el('div', { class: 'scaler' });
  var inner = el('div', { id: 'frame-' + a.id });
  wrap.appendChild(inner);
  // 固定逻辑视口后按容器宽度等比缩放：左右两个候选使用同一个逻辑宽度，
  // 因此同一份响应式页面必然落到相同断点（PRD 4.4）。
  var scale = 1;
  var apply = function () {
    var avail = wrap.clientWidth || vp.width;
    scale = Math.min(1, avail / vp.width);
    inner.style.transform = 'scale(' + scale + ')';
    inner.style.width = vp.width + 'px';
    inner.style.height = vp.height + 'px';
    wrap.style.height = Math.round(vp.height * scale) + 'px';
  };
  var iframe = document.createElement('iframe');
  var token = 'tk_' + Math.random().toString(36).slice(2);
  iframe.setAttribute('sandbox', (state.meta && state.meta.sandbox) || 'allow-scripts allow-forms');
  iframe.setAttribute('referrerpolicy', 'no-referrer');
  iframe.setAttribute('data-arena-token', token);
  iframe.style.width = vp.width + 'px';
  iframe.style.height = vp.height + 'px';
  iframe.src = (state.meta.previewOrigin || '') + '/preview/' + a.id + '?token=' + token + '&network=' + encodeURIComponent(state.current.experiment.previewPolicy.networkPolicy);
  inner.appendChild(iframe);
  // 只接受来自我们自己创建的 iframe、且令牌匹配的消息（F12 的消息校验）
  if (!window.__arenaListening) {
    window.__arenaListening = true;
    window.addEventListener('message', function (ev) {
      onFrameMessage(ev);
    });
  }
  var frames = window.__arenaFrames = window.__arenaFrames || {};
  frames[a.id] = { iframe: iframe, token: token };
  setTimeout(apply, 0);
  window.addEventListener('resize', apply);
  return wrap;
}

function onFrameMessage(ev) {
  var frames = window.__arenaFrames || {};
  var found = null;
  for (var id in frames) {
    if (frames[id].iframe.contentWindow === ev.source && frames[id].token === (ev.data && ev.data.__htmlArena)) { found = { id: id, f: frames[id] }; break; }
  }
  if (!found) return; // 来源或令牌不符：丢弃，不获得任何权限
  var d = ev.data;
  if (d.type === 'error') {
    var det = state.frameErrors = state.frameErrors || {};
    det[found.id] = det[found.id] || [];
    if (det[found.id].length < 20) det[found.id].push(d.payload && d.payload.message ? d.payload.message : '(无消息)');
    renderCompareDetails(lastAttemptPerSlot(state.current.attempts));
  } else if (d.type === 'console' && d.payload && d.payload.level === 'error') {
    var det2 = state.frameErrors = state.frameErrors || {};
    det2[found.id] = det2[found.id] || [];
    if (det2[found.id].length < 20) det2[found.id].push('console.error: ' + d.payload.text);
    renderCompareDetails(lastAttemptPerSlot(state.current.attempts));
  }
}

function resetFrame(attemptId) {
  var frames = window.__arenaFrames || {};
  var f = frames[attemptId];
  if (!f) return;
  f.iframe.src = f.iframe.src; // 重新加载 = 重置到初始状态
  toast('已重置候选 ' + attemptId.slice(-4));
}
function muteFrame(attemptId) {
  var frames = window.__arenaFrames || {};
  var f = frames[attemptId];
  if (!f) return;
  f.muted = !f.muted;
  try { f.iframe.contentWindow.postMessage({ __arenaCommand: 'mute', muted: f.muted }, '*'); } catch (e) { /* 忽略 */ }
  toast(f.muted ? '已请求静音（作品若不响应则该作品不支持）' : '已请求取消静音');
}
function fullscreen(attemptId) {
  var frames = window.__arenaFrames || {};
  var f = frames[attemptId];
  if (!f) return;
  var wrap = f.iframe.closest('.frame-wrap');
  var others = document.querySelectorAll('.frame-wrap');
  for (var i = 0; i < others.length; i++) others[i].hidden = others[i] !== wrap;
  $('compare-grid').className = 'compare-grid single';
  toast('已切换到单作品全屏；再点一次"重置"或切页可恢复并排');
}

function renderVoteRow(shown) {
  var row = $('vote-row');
  clear(row);
  if (shown.length < 2) {
    row.appendChild(el('div', { class: 'muted', text: '至少需要两个有作品的候选才能评价。' }));
    return;
  }
  shown.forEach(function (a, i) {
    var letter = String.fromCharCode(65 + i);
    row.appendChild(el('button', {
      class: 'btn small', text: '偏好 ' + letter,
      onclick: function () { saveVote(letter); },
    }));
  });
  row.appendChild(el('button', { class: 'btn small', text: '平局', onclick: function () { saveVote('tie'); } }));
  row.appendChild(el('button', { class: 'btn small', text: '无法判断', onclick: function () { saveVote('undecided'); } }));
}

function saveVote(choice) {
  var tags = [];
  var boxes = document.querySelectorAll('#view-compare .chip input:checked');
  for (var i = 0; i < boxes.length; i++) tags.push(boxes[i].value);
  api('/experiments/' + encodeURIComponent(state.current.experiment.id) + '/vote', {
    method: 'POST',
    body: { choice: choice, tags: tags, note: $('vote-note').value },
  }).then(function (r) {
    state.current.vote = r.vote;
    $('vote-status').textContent = '已保存：' + voteLabel(choice) + '（' + fmtTime(r.vote.createdAt) + '）。选择绑定具体作品 hash。';
    updateIdentityControls();
    toast('已保存评价');
  }).catch(function (err) { toast('保存失败：' + err.message, true); });
}

function renderCompareDetails(attempts) {
  var box = $('compare-details');
  if (!box) return;
  clear(box);
  var anchor = attempts[0];
  if (!anchor) { clear(box); return; }
  // 隐藏身份期间这个折叠面板也必须脱敏：它只是折叠，点一下就能看见（实测缺陷）。
  var hideIdentity = state.blind && !state.revealed;
  var HIDDEN = '（已隐藏，揭晓后可见）';

  attempts.forEach(function (a, i) {
    var d = el('div', { style: 'margin-bottom:16px' });
    d.appendChild(el('div', { style: 'font-weight:600', text: String.fromCharCode(65 + i) + ' · ' + (hideIdentity ? HIDDEN : a.recipe.name) }));
    var kv = el('dl', { class: 'kv' });
    kv.appendChild(el('dt', { text: '模型来源' }));
    kv.appendChild(el('dd', { text: hideIdentity ? HIDDEN : a.recipe.provider }));
    kv.appendChild(el('dt', { text: '模型' }));
    kv.appendChild(el('dd', { text: hideIdentity ? HIDDEN : a.recipe.model }));
    kv.appendChild(el('dt', { text: '思考档位' }));
    kv.appendChild(el('dd', { text: a.recipe.reasoningEffort || '未指定' }));
    kv.appendChild(el('dt', { text: '温度' }));
    kv.appendChild(el('dd', { text: a.recipe.temperature === null ? '未指定' : String(a.recipe.temperature) }));
    kv.appendChild(el('dt', { text: '输出上限' }));
    kv.appendChild(el('dd', { text: a.recipe.maxTokens === null ? '模型默认' : String(a.recipe.maxTokens) }));
    kv.appendChild(el('dt', { text: '作品 hash' }));
    kv.appendChild(el('dd', { text: a.extraction && a.extraction.htmlHash ? a.extraction.htmlHash.slice(0, 16) + '…' : '无' }));
    kv.appendChild(el('dt', { text: '原始正文 hash' }));
    kv.appendChild(el('dd', { text: a.extraction && a.extraction.rawTextHash ? a.extraction.rawTextHash.slice(0, 16) + '…' : '无' }));
    d.appendChild(kv);

    // 与第一个候选的差异
    var diffs = [];
    var fields = [['provider', '模型来源'], ['model', '模型'], ['reasoningEffort', '思考档位'], ['temperature', '温度'], ['maxTokens', '输出上限'], ['systemPrompt', '系统提示词']];
    fields.forEach(function (f) {
      if (JSON.stringify(a.recipe[f[0]]) !== JSON.stringify(anchor.recipe[f[0]])) diffs.push(f[1]);
    });
    if (JSON.stringify(a.recipe.promptSegments) !== JSON.stringify(anchor.recipe.promptSegments)) diffs.push('提示词片段');
    d.appendChild(el('div', { class: 'muted', text: i === 0 ? '作为对照组' : '与 A 的差异：' + (diffs.length ? diffs.join('、') : '（无）') }));

    // 运行错误（页面内捕获）
    var errs = (state.frameErrors || {})[a.id];
    if (errs && errs.length) {
      d.appendChild(el('div', { class: 'muted', style: 'margin-top:6px', text: '作品运行时报告的错误：' }));
      errs.forEach(function (e) { d.appendChild(el('div', { class: 'muted', text: '· ' + e })); });
    } else if (a.canPreview) {
      d.appendChild(el('div', { class: 'muted', text: '运行时错误：未捕获到（没有报错不代表功能正确）' }));
    }

    d.appendChild(el('button', { class: 'btn small', text: '查看原始正文', onclick: function () { viewRaw(a.id); } }));
    box.appendChild(d);
  });
}

function takeScreenshots() {
  var attempts = lastAttemptPerSlot(state.current.attempts).filter(function (a) { return a.canPreview; });
  if (attempts.length === 0) { toast('没有可截图的作品', true); return; }
  toast('正在截图（每个候选最多 10 秒）…');
  var done = 0;
  attempts.forEach(function (a) {
    api('/experiments/' + encodeURIComponent(state.current.experiment.id) + '/attempts/' + encodeURIComponent(a.id) + '/screenshot', {
      method: 'POST', body: { viewport: state.viewport },
    }).then(function (r) {
      state.screenshots[a.id] = { base64: r.screenshotBase64, meta: r };
      if (r.status !== 'ok') toast('候选 ' + a.recipe.name + ' 截图：' + (r.reason || r.status), true);
    }).catch(function (err) {
      state.screenshots[a.id] = { base64: null, meta: { status: 'error', reason: err.message } };
      toast('候选 ' + a.recipe.name + ' 截图失败：' + err.message, true);
    }).then(function () {
      done += 1;
      renderCompare();
      if (done === attempts.length) toast('截图完成');
    });
  });
}

// ── 事件绑定 ─────────────────────────────────────────────────

function bindEvents() {
  var tabs = document.querySelectorAll('.tab');
  for (var i = 0; i < tabs.length; i++) {
    tabs[i].addEventListener('click', function (ev) {
      var v = ev.currentTarget.getAttribute('data-view');
      if (v === 'compare' && !state.current) return;
      showView(v);
    });
  }

  $('btn-new').addEventListener('click', function () { showView('new'); });
  $('btn-sample').addEventListener('click', function () {
    $('task-prompt').value = EXAMPLE_TASK;
    $('task-requirements').value = '单文件、无外部依赖、使用内置示例数据、包含折线图与昼夜主题切换';
    $('task-title').value = '天气仪表盘对比';
    $('task-category').value = 'dashboard';
    updatePromptCount();
    showView('new');
    toast('已填入示例题。选好两个候选后点"开始生成"。');
  });
  $('btn-optimize').addEventListener('click', optimizeTask);
  $('btn-optimize-apply').addEventListener('click', function () {
    if (!state.optimizer.text) return;
    // 替换前把原题目留一份，误点可以撤回来
    state.optimizer.prevPrompt = $('task-prompt').value;
    $('task-prompt').value = state.optimizer.text;
    updatePromptCount();
    toast('已用优化后的题目替换（原题目已暂存）');
  });
  $('btn-optimize-append').addEventListener('click', function () {
    if (!state.optimizer.text) return;
    var area = $('task-prompt');
    area.value = area.value.replace(/\s+$/, '') + '\n\n' + state.optimizer.text;
    updatePromptCount();
    toast('已追加到原题目后面');
  });
  $('btn-optimize-discard').addEventListener('click', function () {
    $('optimizer-result').hidden = true;
    state.optimizer.text = null;
    toast('已丢弃优化结果，题目未改动');
  });

  $('btn-example-task').addEventListener('click', function () {
    $('task-prompt').value = EXAMPLE_TASK;
    updatePromptCount();
  });
  $('task-prompt').addEventListener('input', updatePromptCount);
  $('search').addEventListener('input', function () { loadExperiments(); });
  $('filter-category').addEventListener('change', function () { loadExperiments(); });
  $('btn-add-candidate').addEventListener('click', function () { addCandidate(); });
  $('btn-add-candidate-api').addEventListener('click', function () { addCandidateUnusedModel(); });
  $('btn-start').addEventListener('click', startExperiment);
  $('btn-preview-request').addEventListener('click', previewRequest);

  $('task-starthtml-file').addEventListener('change', function (ev) {
    var f = ev.target.files && ev.target.files[0];
    if (!f) return;
    if (f.size > 2 * 1024 * 1024) {
      toast('这个文件 ' + fmtBytes(f.size) + '，超过 2MB 上限。工具不会替你截断，请自行精简。', true);
      ev.target.value = '';
      return;
    }
    var reader = new FileReader();
    reader.onload = function () {
      $('task-starthtml').value = String(reader.result);
      $('starthtml-size').textContent = '已读入 ' + fmtBytes(f.size);
    };
    reader.readAsText(f);
  });

  $('btn-cancel-all').addEventListener('click', function () {
    api('/experiments/' + encodeURIComponent(state.current.experiment.id) + '/cancel', { method: 'POST' })
      .then(function (r) { toast('已请求停止 ' + r.cancelled + ' 个候选'); })
      .catch(function (err) { toast('停止失败：' + err.message, true); });
  });
  $('btn-goto-compare').addEventListener('click', function () { showView('compare'); renderCompare(); });

  var segs = document.querySelectorAll('.seg-btn');
  for (var j = 0; j < segs.length; j++) {
    segs[j].addEventListener('click', function (ev) {
      state.viewport = ev.currentTarget.getAttribute('data-vp');
      var all = document.querySelectorAll('.seg-btn');
      for (var k = 0; k < all.length; k++) all[k].className = 'seg-btn' + (all[k].getAttribute('data-vp') === state.viewport ? ' is-active' : '');
      renderCompare();
    });
  }

  $('btn-blind').addEventListener('click', function () {
    state.blind = !state.blind;
    renderCompare();
  });
  $('btn-reveal').addEventListener('click', function () {
    api('/experiments/' + encodeURIComponent(state.current.experiment.id) + '/reveal', { method: 'POST' })
      .then(function (r) {
        state.current.vote = r.vote;
        state.revealed = true;
        state.blind = false;
        renderCompare();
        toast('已揭晓配置身份');
      }).catch(function (err) { toast('揭晓失败：' + err.message, true); });
  });
  $('btn-screenshots').addEventListener('click', takeScreenshots);
  $('btn-save-vote').addEventListener('click', function () { saveVote(state.current && state.current.vote ? state.current.vote.choice : 'undecided'); });
}

// 调试入口：便于在浏览器控制台检查真实状态（也方便排查"按钮没反应"这类问题）
window.__htmlArena = { state: state, api: api, reload: loadExperiments };

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
