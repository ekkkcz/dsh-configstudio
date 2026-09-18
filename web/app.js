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
  optimizer: { available: true, enabled: false, lastRunId: null, running: false },
  settings: null,         // 服务端返回的设置视图（外部插件能力开关）
  screenshots: {},        // attemptId -> { base64, meta }
  // 配方（M2 / A03）：list 是配方对象，detail 是"某一版的完整内容"，按需拉取
  recipes: { list: [], detail: {}, search: '' },
  // 对比页"水平展开比对"（第三轮反馈 1）：'fit' = 缩放到能看全；'wide' = 1:1 横向展开 + 横滚
  compareMode: 'fit',
  // 左右同步滚动：一个作品横滚，其余跟着滚到同一百分比
  syncScroll: true,
  // 全屏的候选 id：全屏只藏别的卡片、不改列数，否则会与"始终并排"互相打架
  fullscreenId: null,
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
  var views = ['experiments', 'new', 'run', 'compare', 'recipes', 'settings'];
  for (var i = 0; i < views.length; i++) {
    $('view-' + views[i]).hidden = views[i] !== name;
  }
  // 列表是本次会话里最容易被改动的东西（新建、删除、评价），每次进入都刷新，
  // 否则用户会看到过期的行。
  if (name === 'experiments') loadExperiments();
  if (name === 'settings') loadSettings();
  if (name === 'recipes') loadRecipes();
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
    // 插件版本要显示出来：用户报反馈时第一件事就是"我用的是哪一版"。
    // 读不到 package.json 时服务端返回 null，这里如实显示"未知"，不编一个号。
    notes.push('HTML Arena ' + (meta.pluginVersion || '版本未知'));
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
/**
 * 优化区只在**两层条件都成立**时显示：
 *   1. 探测到本机装了那个插件；
 *   2. 用户在「设置」里**明确启用**了这个能力（反馈 1：探测到 ≠ 应该启用）。
 * 只探测到但没启用时，这里什么都不显示，也不去加载模型下拉 —— 不替用户花任何钱。
 */
function applyOptimizerStatus(info) {
  state.optimizer.available = Boolean(info && info.available);
  state.optimizer.enabled = Boolean(info && info.enabled);
  state.optimizer.currentKey = info && info.current && info.current.provider ? info.current.provider + '/' + info.current.model : null;
  state.optimizer.note = (info && info.note) || '';
  var box = $('optimizer-box');
  if (!box) return;
  box.hidden = !(state.optimizer.available && state.optimizer.enabled);
  if (box.hidden) return;
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
  // 每次输入都发请求，响应可能乱序到达（"ab" 晚于 "abc" 就会把新结果覆盖回旧结果）。
  // 用一个序列号丢弃过期响应（审查发现的竞态）。
  state.listReqSeq = (state.listReqSeq || 0) + 1;
  var seq = state.listReqSeq;
  return api('/experiments' + (qs.length ? '?' + qs.join('&') : '')).then(function (r) {
    if (seq !== state.listReqSeq) return r;   // 已经有更新的请求发出，丢弃这一次
    state.experiments = r.experiments;
    renderExperiments();
    return r;
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
    // 显式清掉两份增量渲染的引用，不依赖"attempt id 恰好不同"这个隐式前提（审查建议）
    runRefs = { sig: null, cards: {}, rawById: {}, rawSig: null };
    compareRefs = { sig: null, blocks: {} };
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
    // 配方溯源：这一卡是从哪个配方的哪一版来的。只是"来源"，
    // 卡上的字段仍可任意改；开始时服务端按这一版的内容为准并把快照存进 attempt。
    recipeId: (preset && preset.recipeId) || null,
    recipeVersion: (preset && preset.recipeVersion) || null,
    recipeName: (preset && preset.recipeName) || null,
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

/** 这一卡的"配方内容"：只取会影响这次调用的字段（与 src/core/recipe.js 的字段清单一致）。 */
function candidateRecipeContent(c) {
  return {
    name: c.name, provider: c.provider, model: c.model,
    systemPrompt: c.systemPrompt, promptSegments: c.promptSegments,
    temperature: c.temperature, maxTokens: c.maxTokens, reasoningEffort: c.reasoningEffort,
  };
}

/** 把候选卡保存成配方：已经有来源配方就**追加新版本**，否则新建一个配方对象。 */
function saveCandidateAsRecipe(c) {
  var payload = { snapshot: candidateRecipeContent(c), source: 'candidate' };
  var url = '/recipes';
  var method = 'POST';
  if (c.recipeId) {
    url = '/recipes/' + encodeURIComponent(c.recipeId) + '/versions';
    payload.note = '从候选「' + c.name + '」保存';
  } else {
    payload.name = c.name || '未命名配方';
    payload.note = '从候选卡保存';
  }
  api(url, { method: method, body: payload }).then(function (r) {
    if (!c.recipeId) {
      c.recipeId = r.recipe.id;
      c.recipeVersion = 1;
      c.recipeName = r.recipe.name;
    } else {
      c.recipeVersion = r.version;
      c.recipeName = (r.recipe && r.recipe.name) || c.recipeName;
    }
    toast(r.unchanged
      ? '内容与第 ' + r.version + ' 版相同，没有生成新版本'
      : '已保存配方「' + c.recipeName + '」第 ' + (r.version || 1) + ' 版（历史版本保留）');
    renderCandidates();
  }).catch(function (err) { toast('保存配方失败：' + err.message, true); });
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
    var saveBtnText = c.recipeId
      ? '存为第 ' + ((c.recipeVersion || 1) + 1) + ' 版'
      : '保存为配方';
    card.appendChild(el('div', { class: 'cand-head' }, [
      el('span', { class: 'cand-tag', text: '候选 ' + String.fromCharCode(65 + i) }),
      nameInput,
      el('button', {
        class: 'btn small', text: saveBtnText,
        title: c.recipeId
          ? '把这一卡的配置追加成配方「' + (c.recipeName || c.recipeId) + '」的新版本（历史版本不会被覆盖）'
          : '把这一卡的配置保存成一个可复用配方（第 1 版）',
        onclick: function () { saveCandidateAsRecipe(c); },
      }),
      el('button', { class: 'btn small', text: '复制', onclick: function () { copyCandidate(c.id); } }),
      el('button', { class: 'btn small danger', text: '删除', onclick: function () { removeCandidate(c.id); } }),
    ]));
    if (c.recipeId) {
      card.appendChild(el('div', {
        class: 'muted', 'data-role': 'recipe-link',
        text: '来自配方「' + (c.recipeName || c.recipeId) + '」第 ' + (c.recipeVersion || 1) + ' 版；'
          + '这一卡改了字段也只影响本次实验，配方本身要你点上面那个按钮才会追加新版本。',
      }));
    }
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
        // 配方链接：服务端据此记下"这一轮用的是哪个配方的哪一版"（内容仍以本卡字段为准）
        recipeId: c.recipeId || null,
        recipeVersion: c.recipeVersion || null,
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

// ── 设置（外部插件能力开关） ─────────────────────────────────

/**
 * 设置页。目前只有一类东西：**别的插件提供的能力**。
 * 默认一律关（用户反馈 1 的原话："得让用户自己选择是否加插件呀"），
 * 这里把"探测到没有"和"要不要用"分成两件事讲清楚，不要含糊。
 */
function loadSettings() {
  return api('/settings').then(function (r) {
    state.settings = r;
    renderSettings();
  }).catch(function (err) {
    $('settings-where').textContent = '读取设置失败：' + err.message;
  });
}

function renderSettings() {
  var r = state.settings;
  var box = $('settings-caps');
  if (!r || !box) return;
  clear(box);

  if (r.error) box.appendChild(el('div', { class: 'diff-note', style: 'color:var(--warn)', text: r.error }));
  (r.notes || []).forEach(function (n) {
    box.appendChild(el('div', { class: 'muted', text: '· ' + n }));
  });

  var where = $('settings-where');
  if (where) {
    where.textContent = '位置：' + (r.file || 'settings.json（本插件数据目录）')
      + ' · 格式版本 ' + (r.version === undefined ? '?' : r.version)
      + ' · 这一份是服务端读到的当前值，界面只是它的视图。';
  }

  if (!r.capabilities || r.capabilities.length === 0) {
    box.appendChild(el('div', { class: 'empty', text: '本插件目前没有需要你单独授权的外部能力。' }));
    return;
  }

  r.capabilities.forEach(function (c) {
    var card = el('div', { class: 'exp', style: 'display:block' });
    var head = el('div', { class: 'row wrap gap' });
    head.appendChild(el('span', { class: 'exp-title', text: c.label }));
    head.appendChild(el('span', { class: 'cand-tag', text: '来自 ' + c.source }));
    head.appendChild(el('span', {
      class: 'pill ' + (c.detected ? 'ok' : 'bad'),
      text: c.detected ? '本机已检测到' : '本机未检测到',
    }));
    head.appendChild(el('span', { class: 'spacer' }));
    var toggle = el('button', {
      class: 'btn small' + (c.enabled ? '' : ' primary'),
      text: c.enabled ? '已启用（点一下关闭）' : '启用这个能力',
      onclick: function () { setCapability(c.key, !c.enabled); },
    });
    head.appendChild(toggle);
    card.appendChild(head);

    card.appendChild(el('div', { class: 'muted', style: 'margin-top:8px', text: c.what }));
    card.appendChild(el('div', { class: 'muted', text: '代价：' + c.cost }));
    if (!c.detected) {
      card.appendChild(el('div', { class: 'muted', text: '当前状态：本机没有检测到它（' + c.detectedReason + '）。开关可以先打开，等它装好后就会生效。' }));
    } else if (!c.enabled) {
      card.appendChild(el('div', { class: 'muted', text: '当前状态：已检测到但**没有启用**，所以界面上不会出现这个功能，也不会产生任何调用。' }));
    } else {
      card.appendChild(el('div', { class: 'muted', text: '当前状态：已启用。' + (c.detectedCurrent ? '它当前用的模型：' + (c.detectedCurrent.provider || '?') + '/' + (c.detectedCurrent.model || '?') : '') }));
    }
    box.appendChild(card);
  });
}

function setCapability(key, enabled) {
  var patch = { capabilities: {} };
  patch.capabilities[key] = enabled;
  api('/settings', { method: 'PUT', body: patch }).then(function (r) {
    state.settings = r;
    if (r.rejected && r.rejected.length) toast('有开关没有被接受：' + r.rejected.join('、'), true);
    renderSettings();
    // 开关会影响"新建对比"页的优化区，这里就地同步，否则要刷新页面才生效。
    // 直接问服务端要一份新的优化器状态，避免界面自己拼一套判断。
    if (key === 'prompt-optimizer') {
      return api('/optimizer/status').then(function (info) { applyOptimizerStatus(info); });
    }
    return null;
  }).then(function () {
    var cap = ((state.settings || {}).capabilities || []).filter(function (c) { return c.key === key; })[0];
    toast(enabled ? '已启用「' + (cap ? cap.label : key) + '」' : '已关闭「' + (cap ? cap.label : key) + '」');
  }).catch(function (err) { toast('保存设置失败：' + err.message, true); });
}

// ── 配方（M2 / A03） ─────────────────────────────────────────
//
// 界面上要让"历史配方不被覆盖"看得见：每个配方都列出全部版本，
// 每一版都显示自己的内容指纹与时间，并且可以直接拿某一版去开新一轮。

function loadRecipes() {
  var q = state.recipes.search ? '?full=1&search=' + encodeURIComponent(state.recipes.search) : '?full=1';
  return api('/recipes' + q).then(function (r) {
    state.recipes.list = r.recipes || [];
    renderRecipes(r.note);
  }).catch(function (err) {
    var box = $('recipe-list');
    if (box) { clear(box); box.appendChild(el('div', { class: 'empty', text: '读取配方失败：' + err.message })); }
  });
}

function recipeHashShort(h) {
  return h ? String(h).slice(0, 10) + '…' : '（无指纹）';
}

function renderRecipes(note) {
  var box = $('recipe-list');
  if (!box) return;
  clear(box);
  if (note) $('recipes-note').textContent = note;
  var list = state.recipes.list || [];
  if (!list.length) {
    box.appendChild(el('div', {
      class: 'empty',
      text: '还没有保存过配方。在「新建对比」的候选卡上点"保存为配方"即可；'
        + '以后每次修改都会追加一个新版本，第 1 版永远还在。',
    }));
    return;
  }

  list.forEach(function (r) {
    var card = el('div', { class: 'exp', style: 'display:block', 'data-recipe': r.id });
    var head = el('div', { class: 'row wrap gap' });
    head.appendChild(el('span', { class: 'exp-title', text: r.name }));
    head.appendChild(el('span', { class: 'cand-tag', text: '共 ' + r.versions.length + ' 版' }));
    head.appendChild(el('span', { class: 'pill ok', text: '当前第 ' + r.latestVersion + ' 版' }));
    head.appendChild(el('span', { class: 'spacer' }));
    head.appendChild(el('button', {
      class: 'btn small danger', text: '删除配方',
      title: '只删除这个配方对象；历史实验里存的是快照，不受影响',
      onclick: function () { deleteRecipe(r.id, r.name); },
    }));
    card.appendChild(head);
    if (r.note) card.appendChild(el('div', { class: 'muted', text: r.note }));

    var det = el('details', { class: 'more' });
    det.appendChild(el('summary', { text: '版本历史（' + r.versions.length + ' 版，最早的排在最下面）' }));
    r.versions.forEach(function (v) {
      var row = el('div', { style: 'margin-top:10px', 'data-recipe-version': String(v.version) });
      var sn = v.snapshot || {};
      row.appendChild(el('div', {
        class: 'row wrap gap',
        style: 'align-items:center',
      }, [
        el('span', { class: 'cand-tag round-tag' + (v.version === r.latestVersion ? ' is-round' : ''), text: '第 ' + v.version + ' 版' + (v.version === r.latestVersion ? '（当前）' : '（历史，只读）') }),
        el('span', { class: 'muted', text: fmtTime(v.createdAt) + ' · 指纹 ' + recipeHashShort(v.contentHash) }),
        el('span', { class: 'spacer' }),
        el('button', {
          class: 'btn small', text: '用这一版新建对比',
          onclick: function () { useRecipeVersion(r, v); },
        }),
      ]));
      row.appendChild(el('div', { class: 'muted', text: '模型来源 ' + (sn.provider || '—') + ' / ' + (sn.model || '—')
        + ' · 思考档位 ' + (sn.reasoningEffort || '未指定')
        + ' · 温度 ' + (sn.temperature === null || sn.temperature === undefined ? '未指定' : sn.temperature)
        + ' · 输出上限 ' + (sn.maxTokens === null || sn.maxTokens === undefined ? '模型默认' : sn.maxTokens)
        + ' · 提示词片段 ' + ((sn.promptSegments || []).length) + ' 段' }));
      if (sn.systemPrompt) {
        row.appendChild(el('div', { class: 'muted', text: '系统提示词：' + String(sn.systemPrompt).slice(0, 160) + (String(sn.systemPrompt).length > 160 ? '…' : '') }));
      }
      det.appendChild(row);
    });
    card.appendChild(det);
    box.appendChild(card);
  });
}

/** 用某一版配方开新一轮：把它放进"新建对比"的第一个候选（题目仍由你填）。 */
function useRecipeVersion(recipe, version) {
  var sn = version.snapshot || {};
  state.candidates = [];
  state.candidateSeq = 0;
  addCandidate(sn.name || recipe.name, {
    provider: sn.provider, model: sn.model,
    systemPrompt: sn.systemPrompt, promptSegments: sn.promptSegments,
    temperature: sn.temperature, maxTokens: sn.maxTokens, reasoningEffort: sn.reasoningEffort,
    recipeId: recipe.id, recipeVersion: version.version, recipeName: recipe.name,
  });
  // 至少两个候选才能对比 —— 第二个默认卡不带配方链接
  addCandidate('B');
  showView('new');
  toast('已把「' + recipe.name + '」第 ' + version.version + ' 版放进候选 A（这一版的内容已冻结，改配方不会影响它）');
}

function deleteRecipe(id, name) {
  if (!window.confirm('删除配方「' + name + '」？\n\n只删除这个配方对象与它的版本历史。\n已经跑过的实验不受影响：它们存的是当时的快照。')) return;
  api('/recipes/' + encodeURIComponent(id), { method: 'DELETE' }).then(function () {
    toast('已删除配方「' + name + '」');
    loadRecipes();
  }).catch(function (err) { toast('删除失败：' + err.message, true); });
}

/** 把某一次尝试的配置存成配方（运行面板/对比页用）。 */
function saveAttemptAsRecipe(attemptId, name) {
  api('/recipes', { method: 'POST', body: { name: name || '来自实验的配方', fromAttemptId: attemptId, note: '从一次已完成的尝试保存' } })
    .then(function (r) {
      toast('已保存配方「' + r.recipe.name + '」第 1 版（存的是这一轮实际发出去的快照）');
      return loadRecipes();
    })
    .catch(function (err) { toast('保存配方失败：' + err.message, true); });
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

/**
 * 运行面板的**增量渲染**。
 *
 * 背景（M2 实测缺陷）：轮询每 700ms 调一次 renderRun()，而它过去开头就是 clear(box)。
 * 整块重建的后果不止"推理过程点开不到 1 秒就自己收回去"：
 * 展开的任何 <details>（含"原始输出与提取结果"）、实时输出区的滚动位置、
 * 正在选中的文字，都会在下一个轮询周期被换掉。
 *
 * 所以改成 keyed 增量更新：
 *   - 卡片骨架只在**候选集合**（attempt id 列表）变化时重建，其余时候节点一直复用；
 *   - 文本一律走 setText() 原地改写文本节点的值，不重建子树（选区、滚动位置都挂在节点上）；
 *   - 实时输出只在"用户本来就贴着底部"时才自动吸底，向上翻阅时不抢滚动条。
 */
var runRefs = { sig: null, cards: {}, rawById: {}, rawSig: null };

function runItemsSig(items) {
  var parts = [];
  for (var i = 0; i < items.length; i++) parts.push(items[i].id);
  return parts.join(',');
}

/** 原地改写文本：只动文本节点的值，保留节点身份。 */
function setText(node, text) {
  if (!node) return;
  text = text === null || text === undefined ? '' : String(text);
  var t = node.firstChild;
  if (t && t.nodeType === 3 && node.childNodes.length === 1) {
    if (t.nodeValue !== text) t.nodeValue = text;
  } else {
    clear(node);
    node.appendChild(document.createTextNode(text));
  }
}

/** 实时正文/推理：用户贴着底部时继续跟随，否则保持他当前看到的位置。 */
function setStreamText(pre, text) {
  if (!pre) return;
  var atBottom = (pre.scrollHeight - pre.scrollTop - pre.clientHeight) < 48;
  setText(pre, text);
  if (atBottom) pre.scrollTop = pre.scrollHeight;
}

function buildRunCard(a, i, box) {
  var refs = { keys: {} };
  var card = el('div', { class: 'cand' });
  card.setAttribute('data-attempt', a.id);
  refs.roundTag = el('span', { class: 'cand-tag round-tag' });
  card.appendChild(el('div', { class: 'cand-head' }, [
    el('span', { class: 'cand-tag', text: '候选 ' + String.fromCharCode(65 + i) }),
    refs.roundTag,
    el('span', { style: 'flex:1;font-weight:600', text: a.recipe.name }),
  ]));
  refs.dot = el('span', { class: 'dot ' + a.status });
  refs.statusText = el('span', { text: statusLabel(a) });
  refs.firstText = el('span', { class: 'muted' });
  refs.firstText.hidden = true;
  card.appendChild(el('div', { class: 'status' }, [refs.dot, refs.statusText, refs.firstText]));
  card.appendChild(el('div', { class: 'muted', text: a.recipe.provider + ' / ' + a.recipe.model }));

  // 下面几个容器位置固定，内容按需原地更新 —— 位置固定是"展开状态与滚动位置不跳"的前提
  refs.liveSlot = el('div');
  refs.errorSlot = el('div');
  refs.extractSlot = el('div');
  refs.receiptSlot = el('div');
  refs.actions = el('div', { class: 'row gap wrap' });
  card.appendChild(refs.liveSlot);
  card.appendChild(refs.errorSlot);
  card.appendChild(refs.extractSlot);
  card.appendChild(refs.receiptSlot);
  card.appendChild(refs.actions);
  box.appendChild(card);
  refs.card = card;
  return refs;
}

function buildLiveBlock(a) {
  var box = el('div', { class: 'live' });
  var ref = { box: box };
  ref.dot = el('span', { class: 'live-dot' });
  ref.title = el('span');
  ref.meta = el('span', { class: 'muted' });
  box.appendChild(el('div', { class: 'live-head' }, [ref.dot, ref.title, ref.meta]));
  ref.pre = el('pre', { class: 'stream' });
  ref.pre.setAttribute('data-live', a.id);
  box.appendChild(ref.pre);
  return ref;
}

/** 实时输出区：存在性变化时才建/拆，内容一律原地改写。 */
function updateRunLive(a, refs) {
  var live = state.streams[a.id];
  var has = Boolean(live && (live.text || live.reasoning));
  if (!has) {
    var mode = a.status === 'running' ? 'waiting' : 'none';
    if (refs.keys.live !== mode) {
      clear(refs.liveSlot);
      refs.live = null;
      if (mode === 'waiting') refs.liveSlot.appendChild(el('div', { class: 'muted', text: '正在等待模型返回第一个字…' }));
      refs.keys.live = mode;
    }
    return;
  }
  if (refs.keys.live !== 'live' || !refs.live) {
    clear(refs.liveSlot);
    refs.live = buildLiveBlock(a);
    refs.liveSlot.appendChild(refs.live.box);
    refs.keys.live = 'live';
  }
  var ref = refs.live;
  ref.dot.className = 'live-dot' + (a.status === 'running' ? ' on' : '');
  setText(ref.title, a.status === 'running' ? '实时输出（还在生成）' : '本次生成的正文');
  setText(ref.meta, '正文 ' + (live.textLength || 0) + ' 字'
    + (live.reasoningLength ? ' · 推理 ' + live.reasoningLength + ' 字' : '')
    + (live.truncated ? ' · 只显示尾部' : ''));
  // 推理过程可能晚于正文到达：到了再插进正文前面，之后一直复用同一个 details 节点
  if (live.reasoning && !ref.rdet) {
    var rdet = el('details', { class: 'more live-reasoning' });
    rdet.appendChild(el('summary', { text: '推理过程（' + (live.reasoningLength || 0) + ' 字）' }));
    ref.rpre = el('pre', { class: 'stream reasoning' });
    ref.rpre.setAttribute('data-live', a.id + ':r');
    rdet.appendChild(ref.rpre);
    ref.box.insertBefore(rdet, ref.pre);
    ref.rdet = rdet;
  }
  if (ref.rdet) {
    setText(ref.rdet.firstChild, '推理过程（' + (live.reasoningLength || 0) + ' 字）');
    setStreamText(ref.rpre, live.reasoning || '');
  }
  setStreamText(ref.pre, live.text || '');
}

function updateRunCard(a, i, refs) {
  // 第 N 轮要写在卡上：用户需要一眼看出"这是改过之后的版本，第 1 轮还在"
  var roundText = '第 ' + (a.attemptNo || 1) + ' 轮';
  if (refs.roundTag.textContent !== roundText) setText(refs.roundTag, roundText);
  refs.roundTag.className = 'cand-tag round-tag' + ((a.attemptNo || 1) > 1 ? ' is-round' : '');
  refs.dot.className = 'dot ' + a.status;
  // 已过运行上限、但流还没收尾时，不能继续显示"生成中" —— 那会让人以为它还在正常跑。
  // 判定用的是服务端 /live 里的 timedOut（运行条目上的真实状态），不是界面自己掐表。
  var liveNow = state.streams && state.streams[a.id];
  var aborting = Boolean(liveNow && liveNow.timedOut && a.running);
  setText(refs.statusText, aborting ? '已到运行上限，正在尽力中止…' : statusLabel(a));
  var first = (a.status === 'running' && a.receipt && a.receipt.firstTextAt)
    ? '首正文 ' + ((a.receipt.firstTextAt - a.receipt.startedAt) / 1000).toFixed(1) + ' 秒' : '';
  if (first) { setText(refs.firstText, first); refs.firstText.hidden = false; }
  else { refs.firstText.hidden = true; setText(refs.firstText, ''); }   // 清掉旧文本，别留 stale 数据
  updateRunLive(a, refs);

  // 失败：给出可读原因与下一步
  var errKey = a.error ? [a.error.title, a.error.hint, a.error.status || '', a.error.message || ''].join('|') : '';
  if (refs.keys.error !== errKey) {
    clear(refs.errorSlot);
    if (a.error) {
      refs.errorSlot.appendChild(el('div', { class: 'diff-note', style: 'color:var(--bad)', text: a.error.title }));
      refs.errorSlot.appendChild(el('div', { class: 'muted', text: a.error.hint }));
      if (a.error.status) refs.errorSlot.appendChild(el('div', { class: 'muted', text: 'HTTP 状态：' + a.error.status }));
      // 未识别的错误码不能只说"未识别"：上游原文是用户唯一的线索（A07 记下的已知不足）
      if (a.error.message) {
        var rawDet = el('details', { class: 'more' });
        rawDet.appendChild(el('summary', { text: '上游原始错误（' + a.error.code + '）' }));
        rawDet.appendChild(el('pre', { class: 'stream', text: a.error.message }));
        refs.errorSlot.appendChild(rawDet);
      }
    }
    refs.keys.error = errKey;
  }

  // 提取结果
  var exKey = a.extraction ? JSON.stringify(a.extraction) : '';
  if (refs.keys.extraction !== exKey) {
    clear(refs.extractSlot);
    if (a.extraction) {
      var ex = a.extraction;
      var label = ex.status === 'ok' ? '已提取作品' : ex.status === 'multiple' ? '有多个 HTML 块，需要你选择' : '未识别到作品';
      refs.extractSlot.appendChild(el('div', { class: 'muted', text: label + ' · 提取器 v' + (ex.version || '?') + (ex.mode ? ' · 方式 ' + ex.mode : '') }));
      if (ex.warnings && ex.warnings.length) {
        ex.warnings.forEach(function (w) { refs.extractSlot.appendChild(el('div', { class: 'muted', text: '⚠ ' + w.message })); });
      }
      if (ex.status === 'multiple') {
        refs.extractSlot.appendChild(el('div', { class: 'muted', text: '请在下方"原始输出"里选择要作为作品的块。' }));
      }
    }
    refs.keys.extraction = exKey;
  }

  // 收据
  var rc = a.receipt;
  var rcKey = rc ? [rc.startedAt, rc.finishedAt, rc.finishReason, rc.firstTextAt,
    rc.usage ? [rc.usage.inputTokens, rc.usage.outputTokens, rc.usage.cacheReadTokens, rc.usage.reasoningTokens].join(',') : 'null'].join('|') : '';
  if (refs.keys.receipt !== rcKey) {
    clear(refs.receiptSlot);
    if (rc) {
      var kv = el('dl', { class: 'kv' });
      kv.appendChild(el('dt', { text: '用时' }));
      kv.appendChild(el('dd', { text: fmtDuration(rc.startedAt, rc.finishedAt) }));
      kv.appendChild(el('dt', { text: '收尾原因' }));
      kv.appendChild(el('dd', { text: rc.finishReason === null ? '未知' : rc.finishReason }));
      kv.appendChild(el('dt', { text: '用量' }));
      kv.appendChild(el('dd', { text: [usageField(rc.usage, 'inputTokens', '输入'), usageField(rc.usage, 'outputTokens', '输出'), usageField(rc.usage, 'cacheReadTokens', '缓存命中'), usageField(rc.usage, 'reasoningTokens', '推理')].join(' · ') }));
      refs.receiptSlot.appendChild(kv);
    }
    refs.keys.receipt = rcKey;
  }

  // 按钮：停止/重试会随状态切换，只在"该显示的动作"变化时重建
  var actKey = ((a.running || a.status === 'queued') ? 'cancel' : 'retry') + (a.canPreview ? '+html' : '') + (a.partial ? '+partial' : '');
  if (refs.keys.actions !== actKey) {
    clear(refs.actions);
    if (a.running || a.status === 'queued') {
      refs.actions.appendChild(el('button', { class: 'btn small danger', text: '停止这个候选', onclick: function () { cancelAttempt(a.id); } }));
    } else {
      refs.actions.appendChild(el('button', { class: 'btn small', text: '重试', onclick: function () { retryAttempt(a.id); } }));
    }
    refs.actions.appendChild(el('button', { class: 'btn small', text: '下载原始输出', onclick: function () { download(a.id, 'raw'); } }));
    if (a.canPreview) refs.actions.appendChild(el('button', { class: 'btn small', text: '下载作品 HTML', onclick: function () { download(a.id, 'html'); } }));
    if (a.partial) {
      refs.actions.appendChild(el('button', {
        class: 'btn small', text: '下载中断前的部分输出',
        title: '宿主重启或进程被杀之前，已经落盘的那一段正文（' + a.partial.chars + ' 字符'
          + (a.partial.truncated ? '，只保留了尾部' : '') + '）',
        onclick: function () { download(a.id, 'partial'); },
      }));
    }
    refs.actions.appendChild(el('button', {
      class: 'btn small', text: '存成配方',
      title: '把这一轮的配置（含实际发出去的提示词）保存成配方，供下一轮复用',
      onclick: function () { saveAttemptAsRecipe(a.id, (a.recipe && a.recipe.name) || '来自实验的配方'); },
    }));
    refs.keys.actions = actKey;
  }
}

/**
 * "原始输出与提取结果"区。
 *
 * 这里刻意列出**每一次尝试**（而不只是最新那一次）：追加轮次与重试都会新建 attempt，
 * 界面对用户承诺过"上一轮的原始输出完整保留、仍可下载"，那就必须在这里真的点得到，
 * 而不是只留在数据库里。骨架只在"尝试集合"变化时重建。
 */
function renderRunRaw(items) {
  var attempts = (state.current && state.current.attempts) || [];
  var sig = attempts.map(function (a) { return a.id + ':' + a.status; }).join(',') + '|' + runItemsSig(items);
  if (runRefs.rawSig === sig) return;
  var rawBox = $('run-raw');
  clear(rawBox);
  runRefs.rawById = {};
  if (attempts.length === 0) { runRefs.rawSig = sig; return; }

  // 按候选分组，组内按轮次升序
  var bySlot = {};
  attempts.forEach(function (a) { (bySlot[a.slot] = bySlot[a.slot] || []).push(a); });
  Object.keys(bySlot).sort(function (x, y) { return Number(x) - Number(y); }).forEach(function (slotKey) {
    var slot = Number(slotKey);
    var list = bySlot[slotKey].sort(function (x, y) { return (x.attemptNo || 1) - (y.attemptNo || 1); });
    var latest = list[list.length - 1];
    var group = el('div', { style: 'margin-bottom:16px' });
    group.appendChild(el('div', {
      style: 'font-weight:600',
      text: '候选 ' + String.fromCharCode(65 + slot) + ' · ' + latest.recipe.name + ' · 共 ' + list.length + ' 次尝试',
    }));
    if (list.length > 1) {
      group.appendChild(el('div', { class: 'muted', text: '下面每一轮都保留着原始输出，可以分别下载或查看（本轮作品取最新那一轮）。' }));
    }
    list.forEach(function (a, idx) {
      var isLatest = idx === list.length - 1;
      var row = el('div', { class: 'raw-row' });
      var label = el('span', { class: 'muted' });
      setText(label, rawRowLabel(a, isLatest));
      row.appendChild(label);
      row.appendChild(el('span', { class: 'spacer' }));
      row.appendChild(el('button', {
        class: 'btn small', text: '查看原始正文',
        onclick: function () { viewRaw(a.id); },
      }));
      row.appendChild(el('button', {
        class: 'btn small', text: '下载原始输出',
        onclick: function () { download(a.id, 'raw'); },
      }));
      if (a.canPreview) {
        row.appendChild(el('button', {
          class: 'btn small', text: '下载这一轮的作品',
          onclick: function () { download(a.id, 'html'); },
        }));
      }
      group.appendChild(row);
      if (a.extraction && a.extraction.status === 'multiple') {
        group.appendChild(el('div', { class: 'muted', text: '这一轮有多个 HTML 块，请选择要保存为作品的那个（在作品对比页操作）。' }));
      }
      runRefs.rawById[a.id] = { label: label, isLatest: isLatest };
    });
    rawBox.appendChild(group);
  });
  runRefs.rawSig = sig;
}

/** 一轮尝试在"原始输出"列表里的一行标题。 */
function rawRowLabel(a, isLatest) {
  return '第 ' + (a.attemptNo || 1) + ' 轮 · ' + statusLabel(a)
    + (a.parentAttemptId ? ' · 由上一轮新建' : '')
    + (isLatest ? ' · 当前采用' : '')
    + (a.canPreview ? ' · 有作品' : ' · 无作品');
}

function renderRun() {
  if (!state.current) return;
  var r = state.current;
  var titleEl = $('run-title');
  if (titleEl.textContent !== r.experiment.title) titleEl.textContent = r.experiment.title;
  var items = lastAttemptPerSlot(r.attempts);
  var sig = runItemsSig(items);

  if (runRefs.sig !== sig) {
    runRefs.cards = {};
    var box = $('run-cards');
    clear(box);
    items.forEach(function (a, i) { runRefs.cards[a.id] = buildRunCard(a, i, box); });
    renderRunRaw(items);
    runRefs.sig = sig;
  }

  items.forEach(function (a, i) {
    var refs = runRefs.cards[a.id];
    if (!refs) return;
    updateRunCard(a, i, refs);
    var rawRef = runRefs.rawById[a.id];
    if (rawRef) setText(rawRef.label, rawRowLabel(a, rawRef.isLatest));
  });

  var btn = $('btn-goto-compare');
  var disabled = items.every(function (a) { return !a.canPreview; });
  if (btn.disabled !== disabled) btn.disabled = disabled;
}

/**
 * 追加一轮（反馈 3，用户拍板的方案 1）。
 *
 * 为什么不是"插进当前这次请求"：流式接口上消息在发起时就冻结了，**无法**向已发出的请求追加内容。
 * 硬做只能变成多次请求，那就必须如实记录成多次。所以这里把它做成**新的一轮 attempt**：
 *  - 每一轮仍是一次逻辑请求，F02 与"请求数可核对"都不变；
 *  - 上一轮的原始输出完整保留，仍可单独下载；
 *  - 上一轮真正发生过的内容（用户输入 + 模型原始正文）作为上下文回放给下一轮，
 *    失败/取消的轮次不会被伪造进上下文（服务端会拒绝）。
 */
function addRound() {
  var note = $('round-note').value.trim();
  var errBox = $('round-error');
  errBox.hidden = true;
  clear(errBox);
  if (!note) { toast('先写一句要改什么', true); return; }
  if (!state.current) { toast('先打开一个实验', true); return; }

  var btn = $('btn-add-round');
  btn.disabled = true;
  $('round-note-hint').textContent = '正在创建这一轮…';
  api('/experiments/' + encodeURIComponent(state.current.experiment.id) + '/rounds', {
    method: 'POST', body: { note: note },
  }).then(function (r) {
    btn.disabled = false;
    $('round-note').value = '';
    $('round-note-hint').textContent = '每一轮都是一次新的逻辑请求；上一轮的原始输出会完整保留，仍可下载。';
    var parts = (r.started || []).map(function (s) {
      return '候选 ' + String.fromCharCode(65 + s.slot) + ' → 第 ' + s.attemptNo + ' 轮（' + s.contextWindowNote + '）';
    });
    $('round-history').textContent = '本次追加：' + parts.join('；');
    toast('已追加一轮，共 ' + r.started.length + ' 个候选在跑');
    return openExperiment(state.current.experiment.id);
  }).then(function () {
    startRunPolling();
  }).catch(function (err) {
    btn.disabled = false;
    $('round-note-hint').textContent = '';
    var lines = (err.body && err.body.problems) ? err.body.problems : [err.message];
    clear(errBox);
    errBox.appendChild(el('div', { text: '这一轮还不能追加：' }));
    var ul = el('ul');
    lines.forEach(function (l) { ul.appendChild(el('li', { text: l })); });
    errBox.appendChild(ul);
    errBox.hidden = false;
    toast('追加轮次失败', true);
  });
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
  return lastAttemptPerSlot(state.current.attempts).filter(function (a) { return a.canPreview || a.error || a.extraction || a.partial; });
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
  var hideId = identityHidden();
  if (hideId) noteParts.push('配置身份已隐藏；作品页面内容本身可能仍写出模型名，因此这是"隐藏配置身份"，不是严格双盲。');
  else if (state.revealed) noteParts.push('本次已揭晓配置身份（揭晓不可逆）。');
  $('compare-note').textContent = noteParts.join(' ');
  updateExpandUI();

  var grid = $('compare-grid');
  // 注意：这里**不再**摘 resize 处理器。摘掉它们并没有真的解决"监听器累积"，
  // 因为窗口 resize 根本不会触发元素的滚动/尺寸变化，重建出来的作品永远不会重新适配。
  // 现在统一在绑定阶段挂一个 refitFrames()，按当前 DOM 现场重建（见"事件绑定"）。
  var prevScroll = rememberScroll();
  clear(grid);
  // 列数在这里定死，不给 CSS 改的机会（第三轮反馈 1 的根因就是 CSS 在窄视口把它改成了单列）：
  //  1 个候选 = 1 列；2–4 个候选 = **始终**每行 2 个，永远左右并排。
  // 行内的卡片用 minmax(0,1fr) 等分，所以同行永远等宽。
  var cols = shown.length <= 1 ? 1 : 2;
  grid.className = 'compare-grid';
  grid.setAttribute('data-mode', state.compareMode === 'wide' ? 'wide' : 'fit');
  grid.style.gridTemplateColumns = 'repeat(' + cols + ', minmax(0, 1fr))';
  // 切模式 / 重建之后把横向位置放回去：同步滚动开了的话，重建不能让左右跑偏
  if (state.syncScroll) {
    if (prevScroll.grid) {
      var gsTot = Math.max(1, grid.scrollWidth - grid.clientWidth);
      grid.scrollLeft = prevScroll.grid.ratio * gsTot;   // 内容宽度变了就按比例还原
    }
  }

  shown.forEach(function (a, i) {
    var letter = String.fromCharCode(65 + i);
    var wrap = el('div', { class: 'frame-wrap' });
    // 稳定抓手：卡片顺序 = 候选顺序（验收脚本按 data-attempt 认领卡片，不靠位置猜）
    wrap.setAttribute('data-attempt', a.id);
    wrap.setAttribute('data-cand', letter);
    // 全屏（放大一个）：只藏别的卡片 + 让它跨两列，**不改网格列数** ——
    // 旧实现把 grid 类改成 single，正好和"始终并排"打架。
    var isFull = state.fullscreenId === a.id;
    if (state.fullscreenId && !isFull) wrap.hidden = true;
    if (isFull) wrap.style.gridColumn = '1 / -1';

    var head = el('div', { class: 'frame-head' });
    // 双击卡头 = 放大这一个 / 恢复并排（与"全屏"按钮同一条路径）
    head.ondblclick = function (ev) {
      if (ev.target && ev.target.tagName === 'BUTTON') return;
      fullscreen(a.id);
    };
    head.appendChild(el('span', { class: 'cand-tag', text: letter }));
    // 揭示后必须一眼看出 A/B 到底是哪套配置。候选默认名就是 "A"/"B"，
    // 只显示名字等于没揭晓（实测缺陷：揭晓后卡片仍只写 A 和 B）。
    head.appendChild(el('span', {
      style: 'font-weight:600',
      text: hideId
        ? '（身份已隐藏）'
        : a.recipe.name + ' · ' + a.recipe.provider + ' / ' + a.recipe.model,
    }));
    // 不是"正常跑完"的候选必须在卡片头上写出来：超时/取消/中断/失败的作品也可能有 HTML，
    // 只把状态留在运行面板里，用户在对比页就完全看不到了（A08 的界面断言抓到过这一点）。
    if (a.status !== 'completed') {
      head.appendChild(el('span', {
        class: 'pill bad', 'data-attempt-status': a.status,
        text: statusLabel(a),
        title: a.error ? (a.error.title + '：' + a.error.hint) : '这一轮没有正常跑完',
      }));
    }
    head.appendChild(el('span', { class: 'spacer' }));
    head.appendChild(el('span', { class: 'vp-label', text: vpLabel() }));
    if (a.canPreview) {
      head.appendChild(el('button', { class: 'btn small', text: '重置', onclick: function () { resetFrame(a.id); } }));
      head.appendChild(el('button', { class: 'btn small', text: isFull ? '退出全屏' : '全屏', 'data-act': 'fullscreen', onclick: function () { fullscreen(a.id); } }));
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
    if (a.error && a.error.message) {
      var rawDet = el('details', { class: 'more' });
      rawDet.appendChild(el('summary', { text: '展开原始错误信息（' + a.error.code + '）' }));
      rawDet.appendChild(el('pre', { class: 'stream', text: a.error.message }));
      msg.appendChild(rawDet);
    }
      var acts = el('div', { style: 'margin-top:10px;display:flex;gap:8px;flex-wrap:wrap' });
      acts.appendChild(el('button', { class: 'btn small', text: '下载原始输出', onclick: function () { download(a.id, 'raw'); } }));
      if (a.partial) {
        acts.appendChild(el('button', {
          class: 'btn small', text: '下载中断前的部分输出（' + a.partial.chars + ' 字符）',
          title: '宿主重启前已经落盘的那一段正文；它不是最终正文，可能只保留了尾部',
          onclick: function () { download(a.id, 'partial'); },
        }));
      }
      acts.appendChild(el('button', { class: 'btn small', text: '重试', onclick: function () { retryAttempt(a.id); } }));
      msg.appendChild(acts);
      body.appendChild(msg);
    }
    wrap.appendChild(body);
    // 用量摘要（第三轮反馈 2）：不用展开任何折叠面板就能看到 token 与速度
    wrap.appendChild(buildUsageStrip(a, hideId));
    grid.appendChild(wrap);
  });

  // 切模式 / 换视口之后重新适配，并把滚动位置放回同一比例（同步滚动）
  refitFrames();
  restoreFrameScroll(prevScroll);
  renderScreenshots(attempts);
  renderVoteRow(shown);
  renderCompareDetails(attempts);
  updateIdentityControls();
}

/**
 * 逻辑视口宽度 + 容器宽度 → 实际缩放比例的**唯一口径**。buildFrame() 与 refitFrames() 共用它。
 *
 * 以前两边各写一份 `Math.min(1, avail / vp.width)`，结果在"逻辑视口比卡片窄"的时候
 * （手机 390px 放进 488px 的卡片）scale 被卡在 1，作品只画 390px 宽，
 * **右边剩下 98px 死白** —— 用户截图指出来的就是这个。
 *
 * 规则（两种模式都**不留一点死白**）：
 *  - 「1:1 横向展开」且内容比容器宽：保持原始尺寸 1:1，横向滚动交给容器；
 *  - 其余情况：等比缩放，**正好撑满**容器宽度（小了就放大，大了就缩小）。
 *
 * 为什么不给放大留上限：留了上限就必然在窗口更宽时重新露出空白 ——
 * 实测 1.6 倍上限在 1600px 窗口下又留下 118px（卡片 742 / 内容 624），
 * 也就是用户报的那个问题会在另一种窗口宽度下回来。**"撑满"必须是一条没有例外的规则**，
 * 否则就等于把缺陷挪到别的分辨率上。真要按原始尺寸看，那是「1:1 横向展开」的职责。
 */
function frameScale(vpWidth, avail, wide) {
  if (!vpWidth || !avail) return 1;
  if (wide && vpWidth >= avail) return 1;   // 有东西可滚：保持 1:1
  return avail / vpWidth;                   // 否则正好撑满，不留空白
}

/**
 * 重新适配所有作品的缩放与横向位置。
 *
 * 为什么要显式做：以前每个作品只在**窗口** resize 时才重算缩放（window.addEventListener('resize')），
 * 但窗口没变、只是（a）切了桌面/手机逻辑视口、（b）在"缩小看全 / 1:1 横向展开"之间切换、
 * （c）同步滚动改了容器尺寸时，作品的缩放都不会更新 —— 窄视口下就会出现"并排了但看不清"。
 *
 * 旧实现的另一个问题：每次重建作品区都挂一个新的 resize 监听、却只在下一次重建时才摘掉，
 * 闭包还捕获着已经脱离 DOM 的节点。这里改为**按 DOM 现场重建**：只认还在文档里的节点。
 */
function refitFrames() {
  var all = document.querySelectorAll('.scaler');
  for (var i = 0; i < all.length; i++) {
    var node = all[i];
    var inner = node.firstElementChild;
    if (!inner) continue;
    var scaleNow = parseFloat(node.getAttribute('data-scale') || '1') || 1;
    var lastW = parseInt(node.getAttribute('data-scaler-width') || '-1', 10);
    var iframe = inner.querySelector('iframe');
    if (!iframe || !iframe.style.width) continue;
    var vp = { width: parseFloat(iframe.style.width) || 1280, height: parseFloat(iframe.style.height) || 720 };
    var wide = state.compareMode === 'wide';
    var avail = node.clientWidth || vp.width;
    var want = frameScale(vp.width, avail, wide);
    // 尺寸没变就不动 transform：频繁重排会让正在滚动的作品抖动
    if (lastW === node.clientWidth && Math.abs(scaleNow - want) < 0.001) continue;
    inner.style.transform = 'scale(' + want + ')';
    node.style.height = Math.round(vp.height * want) + 'px';
    node.setAttribute('data-scale', String(Math.round(want * 1000) / 1000));
    node.setAttribute('data-scaler-width', String(node.clientWidth));
  }
}

/**
 * 刷新"横向展开比对"那一条的状态与说明。
 *
 * 说明当前是哪种读法：窄视口下"并排了但糊成一团"和"上下堆叠"一样没用（反馈 1 的后半句），
 * 所以这里必须讲清楚现在看到的画面是哪一种，以及怎么切。
 */
function updateExpandUI() {
  var modeSegs = document.querySelectorAll('.seg-btn[data-mode]');
  for (var i = 0; i < modeSegs.length; i++) {
    modeSegs[i].className = 'seg-btn' + (modeSegs[i].getAttribute('data-mode') === state.compareMode ? ' is-active' : '');
  }
  var syncBox = $('sync-scroll');
  if (syncBox) syncBox.checked = Boolean(state.syncScroll);
  var note = $('expand-note');
  if (note) {
    var scalerEl = document.querySelector('.scaler');
    var cardW = scalerEl ? scalerEl.clientWidth : 0;
    var vpW = logicalVp().width;
    // 把当前缩放倍数如实写出来：手机视口在宽屏上会被放大，用户该知道这是放大后的样子
    var factor = cardW && vpW ? Math.round((cardW / vpW) * 100) / 100 : null;
    if (state.compareMode === 'wide') {
      note.textContent = vpW >= cardW
        ? '作品按 ' + vpW + 'px 原始宽度摆开，格子放不下就左右拖动' + (state.syncScroll ? '，两边同步滚。' : '。')
        : '当前逻辑视口（' + vpW + 'px）比卡片还窄，没有可横向滚动的内容，已按 ' + factor + '× 撑满卡片。';
    } else {
      note.textContent = '整份作品缩放进卡片，正好撑满、不留空白'
        + (factor ? '（当前 ' + factor + '×，' + vpW + 'px 逻辑视口）' : '')
        + '；想看原始尺寸就切 1:1。';
    }
  }
}

/**
 * 切换"缩小看全 ↔ 1:1 横向展开"。
 *
 * 只改缩放与滚动属性，**不重建 iframe**：重建会把用户在作品里的操作状态（滚到哪、点了什么）清掉，
 * 这个项目已经因为重绘吃过两次亏（推理过程被收回、截图重置作品）。
 * 切完之后把横向位置按比例放回去，左右仍然对得上。
 */
function applyCompareMode() {
  var grid = $('compare-grid');
  if (!grid) return;
  var prev = rememberScroll();
  grid.setAttribute('data-mode', state.compareMode === 'wide' ? 'wide' : 'fit');
  refitFrames();
  // 内容宽度变了，按比例还原滚动位置
  if (state.syncScroll) {
    var gm = Math.max(1, grid.scrollWidth - grid.clientWidth);
    if (prev.grid) grid.scrollLeft = Math.round(prev.grid.ratio * gm);
    restoreFrameScroll(prev);
  }
}

/** 所有"横向内容超出可视宽度"的滚动容器：网格本身 + 每个作品 + 可能的补丁层。 */
function horizontalScrollers() {
  var out = [];
  var grid = $('compare-grid');
  if (grid && grid.scrollWidth > grid.clientWidth + 1) out.push(grid);
  var nodes = document.querySelectorAll('.scaler, .frame-body');
  for (var i = 0; i < nodes.length; i++) {
    if (nodes[i].scrollWidth > nodes[i].clientWidth + 1) out.push(nodes[i]);
  }
  return out;
}

/**
 * 同步滚动：在任何一个横向滚动容器里滚动，其余容器按**百分比**跟到同一位置。
 *
 * 按百分比而不是抄 scrollLeft，是因为网格与作品容器的可滚距离并不相等
 * （网格还要减去卡片间距与内边距），抄同一个像素值会让左右两边的画面错开。
 * 用忙标志挡住回灌事件，避免两个容器互相触发形成抖动。
 */
function syncScrollFrom(source) {
  if (!state.syncScroll) return;
  if (window.__arenaScrollSync) return;
  window.__arenaScrollSync = true;
  try {
    var list = horizontalScrollers();
    var sMax = Math.max(1, source.scrollWidth - source.clientWidth);
    var ratio = source.scrollLeft / sMax;
    for (var i = 0; i < list.length; i++) {
      var n = list[i];
      if (n === source) continue;
      var m = Math.max(1, n.scrollWidth - n.clientWidth);
      n.scrollLeft = Math.round(ratio * m);
    }
  } finally {
    window.__arenaScrollSync = false;
  }
}

/** 记住当前的横向位置：重绘后按比例放回去（同步滚动开着时不能让左右跑偏）。 */
function rememberScroll() {
  var st = { grid: null, frames: {} };
  var grid = $('compare-grid');
  if (grid) {
    var gm = Math.max(1, grid.scrollWidth - grid.clientWidth);
    st.grid = { left: grid.scrollLeft, ratio: grid.scrollLeft / gm };
  }
  var wraps = document.querySelectorAll('.frame-wrap[data-attempt]');
  for (var i = 0; i < wraps.length; i++) {
    var scaler = wraps[i].querySelector('.scaler');
    if (!scaler) continue;
    var m = Math.max(1, scaler.scrollWidth - scaler.clientWidth);
    st.frames[wraps[i].getAttribute('data-attempt')] = { left: scaler.scrollLeft, ratio: scaler.scrollLeft / m };
  }
  return st;
}

/**
 * 用量与速度摘要（第三轮反馈 2，用户原话："然后最终页面也要写上消耗 token，速度，等数据"）。
 *
 * 这些数字服务端一直都返回了，v0.3.0 也渲染了，但只放在默认折叠的「展开配置」里 ——
 * 所以对用户来说等于没有。这里把它挪到作品卡头部下方的显眼处，**不展开任何面板就能看到**。
 *
 * ★ 速度口径（上一轮实测踩过的坑，别改回去）：
 *   总速度 = outputTokens / (finishedAt - startedAt)
 *   **不能**用 outputTokens / (finishedAt - firstTextAt)。推理型模型会先把大量 reasoning token
 *   吐完才出正文 —— 用户那条真实实验里"等待首正文"就花了 168.3 秒，而正文只写了 11.1 秒，
 *   拿后者当分母会算成 3703 tok/s（明显失真）。对用户有意义的等待时间是**首正文延迟**，
 *   所以两个口径分列显示，各自写清含义。
 *
 * ★ 盲选（F15 / A15）：这里只显示本次调用的用量与耗时，不写 provider / model / 候选名，
 *   文本上不泄露身份。但**数值组合是模型指纹**（上下文窗口/档位清单在 v0.3.0 已经按指纹处理），
 *   隐藏身份期间整条为空白态并写明原因 —— 揭晓后立即出现，不影响邀请大家盲选。
 */
function buildUsageStrip(a, hideIdentity) {
  var strip = el('div', { class: 'usage-strip' });
  strip.setAttribute('data-attempt', a.id);
  if (hideIdentity) {
    strip.setAttribute('data-blind', '1');
    strip.setAttribute('title', '盲选期间不显示：这些数字本身不写模型名，但数值组合可能形成模型指纹（与上下文窗口、思考档位清单同一类处理）。揭晓后立即出现。');
    strip.appendChild(el('span', { class: 'muted', text: '用量与速度：盲选期间隐藏（揭晓后可见）' }));
    return strip;
  }
  var rc = a.receipt;
  if (!rc) {
    strip.appendChild(el('span', { class: 'muted', text: a.canPreview ? '用量与速度：未上报（这个候选没有收据）' : '用量与速度：无（这个候选没有跑到收尾）' }));
    return strip;
  }

  var speed = totalSpeed(rc);
  strip.appendChild(usageCell('输入', usageValue(rc.usage, 'inputTokens') + ' tok'));
  strip.appendChild(usageCell('输出', usageValue(rc.usage, 'outputTokens') + ' tok'));
  strip.appendChild(usageCell('合计', usageValue(rc.usage, 'totalTokens') + ' tok'));
  strip.appendChild(usageCell('推理', usageValue(rc.usage, 'reasoningTokens') + ' tok'));
  strip.appendChild(usageCell('总速度', speed === null ? '未上报' : speed.toFixed(1) + ' tok/s'));
  strip.appendChild(usageCell('首正文延迟', fmtSeconds(rc.startedAt, rc.firstTextAt)));
  strip.appendChild(usageCell('总耗时', fmtDuration(rc.startedAt, rc.finishedAt)));
  return strip;
}

/** 一个"标签 值"小格。 */
function usageCell(label, value) {
  var c = el('span', { class: 'usage-cell' });
  c.appendChild(el('span', { class: 'usage-k', text: label }));
  c.appendChild(el('span', { class: 'usage-v', text: String(value) }));
  return c;
}

/**
 * 总速度 = outputTokens /（开始 → 结束 的墙上时间）。
 * 这里是**唯一**允许出现在界面上的速度口径；不要用"首正文之后的时间"当分母（见 buildUsageStrip 注释）。
 */
function totalSpeed(rc) {
  if (!rc || !rc.startedAt || !rc.finishedAt) return null;
  var ms = rc.finishedAt - rc.startedAt;
  var out = rc.usage ? rc.usage.outputTokens : null;
  if (!ms || ms <= 0) return null;
  if (out === null || out === undefined) return null;
  return out / (ms / 1000);
}

/** 毫秒差显示成秒；缺失写"未上报"，绝不写 0。 */
function fmtSeconds(from, to) {
  if (!from || !to) return '未上报';
  return ((to - from) / 1000).toFixed(1) + ' 秒';
}

/**
 * 截图面板：单独渲染，**绝不重建作品网格**。
 *
 * 以前 takeScreenshots() 每完成一张截图就调一次 renderCompare()，
 * 四候选就是四次 clear(grid) → buildFrame() → 重设 iframe.src，
 * 用户在作品里的操作状态被重置四次（与"推理过程被收回"同一类重绘缺陷）。
 */
function renderScreenshots(attempts) {
  var host = $('screenshot-panel');
  if (!host) return;
  clear(host);

  // 两张来源合并：
  //  ① 本次会话刚拍的（有图片）；
  //  ② 服务端**落盘的截图记录**（含失败）—— 刷新页面后仍然看得到"上次截图为什么没成"（A23）。
  // 记录只保存状态与原因，不保存图片本身，所以 ② 只显示文字。
  var persisted = (state.current && state.current.screenshots) || [];
  var ids = Object.keys(state.screenshots);
  persisted.forEach(function (rec) {
    if (state.screenshots[rec.attemptId]) return;
    state.screenshots[rec.attemptId] = { base64: null, meta: { persisted: true, record: rec } };
    ids.push(rec.attemptId);
  });
  if (!ids.length) return;

  var shotPanel = el('div', { class: 'panel', style: 'margin-top:12px' });
  shotPanel.appendChild(el('h3', { class: 'h3', text: '初始截图' }));
  shotPanel.appendChild(el('div', { class: 'muted', text: '截图是对作品重新加载后、未做任何交互时捕获的初始画面，不等于你现在看到的状态。'
    + '成功与失败都会记一条：失败原因保存在服务器上，刷新页面也还在。' }));
  ids.forEach(function (id) {
    var s = state.screenshots[id];
    var d = el('div', { style: 'margin-top:12px' });
    d.setAttribute('data-shot-attempt', id);
    // 记录可能属于**之前那一轮**（被重试顶掉的那次），所以标签要在整个实验的尝试里找，
    // 不能只在"当前渲染的那几个候选"里找 —— 否则一条真实记录会显示成一串 attempt id。
    var pool = ((state.current && state.current.attempts) || attempts || []);
    var rec = pool.filter(function (x) { return x.id === id; })[0];
    var m = s.meta || {};
    var where = m.record ? (m.record.viewport === 'mobile' ? '手机 390x844' : '桌面 1280x720') : (m.viewport ? m.viewport.width + 'x' + m.viewport.height : '?');
    var who = rec ? (rec.recipe.name + ' · 第 ' + (rec.attemptNo || 1) + ' 轮') : id;
    d.appendChild(el('div', { class: 'muted', text: who + ' · ' + where
      + ' · 状态 ' + (m.record ? m.record.status : (m.status || '?'))
      + ' · DPR ' + (m.dpr === null || m.dpr === undefined ? '?' : m.dpr)
      + ' · 等待 ' + (m.durationMs === null || m.durationMs === undefined ? '?' : m.durationMs + 'ms')
      + ' · 网络策略 ' + (m.networkPolicy || (m.record && m.record.detail ? m.record.detail.networkPolicy : '?') || '?')
      + (m.record ? ' · 记录于 ' + fmtTime(m.record.createdAt) : '') }));
    if (m.stateNote) d.appendChild(el('div', { class: 'muted', text: m.stateNote }));
    if (s.base64) {
      d.appendChild(el('img', { src: 'data:image/png;base64,' + s.base64, style: 'max-width:100%;border:1px solid var(--line);border-radius:8px;margin-top:6px' }));
    } else if (m.record && m.record.status === 'ok') {
      // 服务器上的记录只保存状态与原因，**不保存图片**（图片是大对象，作品另有归档）。
      // 所以"有记录但没图"不等于失败 —— 不能把它写成"截图未成功：未知原因"（那样是假信息）。
      d.appendChild(el('div', { class: 'muted', text: '这条记录显示当时截图是成功的；图片没有随记录保存（记录只存状态与原因）。想再看图就重新点一次「截图」。' }));
    } else {
      var reason = (m.record ? m.record.reason : m.reason) || m.status || '未知原因';
      d.appendChild(el('div', { class: 'diff-note', style: 'color:var(--warn)', text: '截图未成功：' + reason + '（作品本身仍可预览；这条记录已经存在服务器上）' }));
      if (m.record && m.record.detail) {
        d.appendChild(el('div', { class: 'muted', text: '页面诊断：脚本错误 ' + (m.record.detail.pageErrors || 0)
          + ' 条 · 控制台 ' + (m.record.detail.consoleMessages || 0) + ' 条 · 失败请求 ' + (m.record.detail.failedRequests || 0) + ' 个' }));
      }
    }
    shotPanel.appendChild(d);
  });
  host.appendChild(shotPanel);
}

/**
 * 现在是否处于"隐藏配置身份"状态。
 *
 * 唯一的判定入口。以前各处都写 `state.blind && !state.revealed`，
 * 而按钮只翻转 state.blind —— 于是在**已揭晓**的实验上点"隐藏配置身份"会出现：
 * state.blind 变成 true（按钮文案随之变成"显示配置身份"），但画面什么都没变（因为已揭晓）。
 * 那是自相矛盾的界面状态（实测踩到，见 delivery-shots 的盲选截图）。
 * 现在：揭晓之后**不再提供**这个开关，并且判定只走这一个函数。
 */
function identityHidden() {
  return Boolean(state.blind) && !state.revealed;
}

/**
 * 只刷新"隐藏配置身份 / 揭晓身份"两个按钮，**不重绘作品区**。
 * 重绘会重建 iframe，把用户在作品里的操作状态全部丢掉，所以这里必须做最小刷新。
 * 保存评价后也要调用它：否则揭晓按钮要等到下一次重绘才出现（实测缺陷）。
 */
function updateIdentityControls() {
  var vote = state.current && state.current.vote;
  $('btn-reveal').hidden = !(vote && vote.revealed === null);
  // 揭晓不可逆：已经揭晓的实验上不再提供"隐藏配置身份"，
  // 否则点了没反应、文案还会翻成"显示配置身份"，是个没用的开关。
  $('btn-blind').hidden = Boolean(state.revealed);
  $('btn-blind').textContent = state.blind ? '显示配置身份' : '隐藏配置身份';
  $('btn-blind').title = state.revealed ? '已揭晓，不能重新隐藏（揭晓不可逆）' : '';
}

/** 当前逻辑视口（桌面 1280x720 / 手机 390x844）。左右候选必须用同一个宽度，否则断点会不一致。 */
function logicalVp() {
  return (state.meta && state.meta.viewports && state.meta.viewports[state.viewport]) || { width: 1280, height: 720 };
}
function vpLabel() {
  var vp = logicalVp();
  return vp.width + 'x' + vp.height;
}

function buildFrame(a) {
  var vp = logicalVp();
  var wrap = el('div', { class: 'scaler' });
  var inner = el('div', { id: 'frame-' + a.id });
  wrap.appendChild(inner);
  // 固定逻辑视口后按容器宽度等比缩放：左右两个候选使用同一个逻辑宽度，
  // 因此同一份响应式页面必然落到相同断点（PRD 4.4）。
  //
  // 窄视口下"缩放到能看全"会把 1280px 的作品压成 ~400px，字全糊了 ——
  // 于是再给一种读法：1:1 横向展开（state.compareMode === 'wide'），
  // 按原始尺寸摆开，格子放不下就横向滚动（CSS 里 .compare-grid[data-mode=wide] .scaler）。
  // 两条路都**不重建 iframe**，所以切模式不会把用户在作品里的操作状态丢掉。
  var scale = 1;
  var apply = function () {
    var wide = state.compareMode === 'wide';
    var avail = wrap.clientWidth || vp.width;
    scale = frameScale(vp.width, avail, wide);
    inner.style.transform = 'scale(' + scale + ')';
    inner.style.width = vp.width + 'px';
    inner.style.height = vp.height + 'px';
    wrap.style.height = Math.round(vp.height * scale) + 'px';
    // 把当前缩放挂在 DOM 上：验收脚本要能分辨"缩小到能看全"与"1:1 横滚"两种读法
    wrap.setAttribute('data-scale', String(Math.round(scale * 1000) / 1000));
    wrap.setAttribute('data-scaler-width', String(wrap.clientWidth));
    // 撑满后剩余的不足 1px 取整误差直接由容器吸收，避免出现一条缝
    inner.style.marginLeft = '0px';
  };
  var iframe = document.createElement('iframe');
  var token = 'tk_' + Math.random().toString(36).slice(2);
  // 记住这个缩放处理器：重绘前要把它摘掉。以前每次 buildFrame 都挂一个永久 resize 监听，
  // 四候选截几次图就累积十几个，闭包还捕获已经脱离 DOM 的节点（审查发现）。
  (window.__arenaResizeHandlers = window.__arenaResizeHandlers || []).push(apply);
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
/**
 * 放大单个作品。
 *
 * 旧实现把 #compare-grid 的类直接改成 "compare-grid single"，那会**把网格改成单列** ——
 * 正是"始终并排"要干掉的东西，两者会互相打架（改了 CSS 断点后更明显）。
 * 现在只做两件事：隐藏其它卡片、让这一张跨满整行；列数始终由 renderCompare() 定死。
 */
function fullscreen(attemptId) {
  var frames = window.__arenaFrames || {};
  if (!frames[attemptId]) return;
  state.fullscreenId = state.fullscreenId === attemptId ? null : attemptId;
  var on = state.fullscreenId !== null;
  renderCompare();
  toast(on ? '已放大这一个作品（左右并排暂时隐藏；双击卡头或再点一次按钮可恢复）' : '已恢复并排比对');
}

/** 重建后把横向滚动按比例放回去 —— 同步滚动开着时，重绘不能让左右两边跑偏。 */
function restoreFrameScroll(prev) {
  if (!state.syncScroll || !prev || !prev.frames) return;
  var wraps = document.querySelectorAll('.frame-wrap[data-attempt]');
  for (var i = 0; i < wraps.length; i++) {
    var id = wraps[i].getAttribute('data-attempt');
    var rec = prev.frames[id];
    var scaler = wraps[i].querySelector('.scaler');
    if (!rec || !scaler) continue;
    var m = Math.max(1, scaler.scrollWidth - scaler.clientWidth);
    scaler.scrollLeft = Math.round(rec.ratio * m);
  }
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
    // 把服务端保存的内容回填到控件：不回填的话刷新页面标签与理由就"变空"了（审查发现）。
    var boxes2 = document.querySelectorAll('#view-compare .chip input');
    for (var j = 0; j < boxes2.length; j++) boxes2[j].checked = (r.vote.tags || []).indexOf(boxes2[j].value) >= 0;
    if (typeof r.vote.note === 'string' && $('vote-note').value !== r.vote.note) $('vote-note').value = r.vote.note;
    $('vote-status').textContent = '已保存：' + voteLabel(choice) + '（' + fmtTime(r.vote.createdAt) + '）。选择绑定具体作品 hash。';
    updateIdentityControls();
    toast('已保存评价');
  }).catch(function (err) { toast('保存失败：' + err.message, true); });
}

// 对比页"展开配置"的增量渲染节点（与运行面板同样的思路：骨架只在集合变化时重建）
var compareRefs = { sig: null, blocks: {} };

/**
 * 当前实验里所有可能暴露身份的字串。
 *
 * 只收 provider / model，以及**长度 ≥ 3 的自定义候选名**。
 * 默认候选名是 "A" / "B" 这种单字母，把它当身份字串会让任何含该字母的题目被误判隐藏
 *（实测：题目里的 "HTML" 之类一旦含 A 就整段不显示，那反而是坏体验）。
 */
function identityWords() {
  if (!state.current) return [];
  var words = [];
  lastAttemptPerSlot(state.current.attempts).forEach(function (a) {
    if (a.recipe.provider) words.push(a.recipe.provider);
    if (a.recipe.model) words.push(a.recipe.model);
    var name = a.recipe.name;
    if (name && name.length >= 3) words.push(name);
  });
  return words.filter(Boolean);
}

/** 隐藏身份期间，对"可能写出模型名"的文本做防御性检查（用户自己的题目也要查一遍）。 */
function blindSafeText(text) {
  if (text === null || text === undefined || text === '') return null;
  var str = String(text);
  var words = identityWords();
  for (var i = 0; i < words.length; i++) {
    if (str.indexOf(words[i]) >= 0) return null;   // 含身份字串：整段不显示
  }
  return str;
}

/** 键值对：值缺失时明确写"未上报 / 未指定"，绝不显示 undefined（PRD 7）。 */
function kvPair(dl, label, value) {
  dl.appendChild(el('dt', { text: label }));
  dl.appendChild(el('dd', { text: (value === null || value === undefined || value === '') ? '—' : String(value) }));
}
function kvPairNode(dl, label, node) {
  dl.appendChild(el('dt', { text: label }));
  var dd = el('dd');
  dd.appendChild(node);
  dl.appendChild(dd);
}

/**
 * 长文本折叠块。默认收起，摘要里给一行预览 —— 面板不能被系统提示词撑爆（PRD 4）。
 */
function longText(summary, text, emptyNote) {
  var body = el('div');
  if (!text) {
    body.appendChild(el('div', { class: 'muted', text: emptyNote || '（空）' }));
    return body;
  }
  var d = el('details', { class: 'more cfg-long' });
  var preview = String(text).replace(/\s+/g, ' ').trim();
  if (preview.length > 46) preview = preview.slice(0, 46) + '…';
  d.appendChild(el('summary', { text: summary + '（' + String(text).length + ' 字） · ' + preview }));
  d.appendChild(el('pre', { class: 'stream cfg-pre', text: String(text) }));
  body.appendChild(d);
  return body;
}

/**
 * 对比页的"展开配置"。
 *
 * 用户原话（反馈 4）："最终的实验对比你得搞一个展开配置出来，这样才能知道具体配置"。
 * 以前这里只渲染 6 个字段，题目、系统提示词、提示词片段、用量、耗时、上下文窗口
 * 这些**服务端早就返回了**的字段一个都没显示，用户没法解释"为什么两个作品不一样"。
 *
 * 两条硬约束（都是实测缺陷换来的，改这里必须继续满足）：
 *  1. **盲选脱敏**：identityHidden() 为真时，provider / model / 候选名一律隐藏；
 *     系统提示词与提示词片段可能写出模型名，隐藏期间整段不显示；
 *     题目 / 输出要求 / 起始 HTML 里若出现身份字串，也整段隐藏。
 *  2. **不引入新的重绘问题**：骨架只在候选集合或脱敏状态变化时重建，
 *     运行时错误那块单独原地更新，所以展开的折叠块与选区不会因为一条错误消息就丢。
 */
function renderCompareDetails(attempts) {
  var box = $('compare-details');
  if (!box) return;
  var anchor = attempts[0];
  if (!anchor) { clear(box); compareRefs = { sig: null, blocks: {} }; return; }

  var hideIdentity = identityHidden();
  var HIDDEN = '（已隐藏，揭晓后可见）';
  var exp = state.current.experiment;
  var task = exp.taskSnapshot || {};

  // 集合或脱敏状态变化时才重建骨架（否则用户展开的块会被收起）
  var sig = attempts.map(function (a) { return a.id; }).join(',') + '|' + hideIdentity;
  if (compareRefs.sig !== sig) {
    compareRefs = { sig: sig, blocks: {} };
    clear(box);
    box.appendChild(buildExperimentConfig(exp, task, hideIdentity, HIDDEN));
    attempts.forEach(function (a, i) {
      var blk = buildAttemptConfig(a, i, attempts, hideIdentity, HIDDEN);
      box.appendChild(blk.root);
      compareRefs.blocks[a.id] = blk;
    });
  }

  // 运行时错误单独原地更新：它随时可能来，不能因此重建上面的内容
  attempts.forEach(function (a) {
    var blk = compareRefs.blocks[a.id];
    if (!blk) return;
    var errs = (state.frameErrors || {})[a.id];
    var text = errs && errs.length
      ? '作品运行时报告的错误：' + errs.join(' / ')
      : (a.canPreview ? '运行时错误：未捕获到（没有报错不代表功能正确）' : '作品未能预览，无法捕获运行时错误');
    // 只在内容真的变了才改写：错误是随时可能到来的，每来一条都重写同一个文本节点
    // 会打断用户正在这段文字里的选区，也会让下方内容无故位移（审查发现）。
    if (blk.lastError !== text) {
      setText(blk.errText, text);
      blk.lastError = text;
    }
  });
}

/** 实验级配置：题目与输出要求放显眼处（对"为什么两个作品不一样"解释力最强）。 */
function buildExperimentConfig(exp, task, hideIdentity, HIDDEN) {
  var wrap = el('div', { class: 'cfg-block cfg-exp' });
  wrap.appendChild(el('div', { class: 'h3', text: '这次实验的配置' }));

  // ── 题目与输出要求：最显眼 ──────────────────────────────
  var promptBox = el('div', { class: 'cfg-prompt' });
  promptBox.appendChild(el('div', { class: 'label', text: '题目（所有候选收到的是同一份）' }));
  var promptText = blindSafeText(task.prompt);
  if (task.prompt && promptText === null) {
    promptBox.appendChild(el('div', { class: 'muted', text: HIDDEN + '（题目文本里出现了配置身份字串）' }));
  } else {
    promptBox.appendChild(longText('题目原文', promptText, '（没有记录题目）'));
  }

  promptBox.appendChild(el('div', { class: 'label', text: '输出要求' }));
  var reqText = blindSafeText(task.outputRequirements);
  if (task.outputRequirements && reqText === null) {
    promptBox.appendChild(el('div', { class: 'muted', text: HIDDEN }));
  } else {
    promptBox.appendChild(longText('输出要求', reqText, '（本题没有填写输出要求，只发题目）'));
  }

  if (task.startHtml) {
    promptBox.appendChild(el('div', { class: 'label', text: '起始 HTML（作为明确标记的文本材料发送，不是历史会话）' }));
    var shText = blindSafeText(task.startHtml);
    if (shText === null) promptBox.appendChild(el('div', { class: 'muted', text: HIDDEN }));
    else promptBox.appendChild(longText('起始 HTML', shText));
  } else {
    promptBox.appendChild(el('div', { class: 'muted', text: '起始 HTML：未使用' }));
  }
  wrap.appendChild(promptBox);

  // ── 冻结的策略与指纹 ───────────────────────────────────
  var kv = el('dl', { class: 'kv' });
  kvPair(kv, '题目指纹 taskHash', exp.taskHash ? exp.taskHash.slice(0, 16) + '…' : '未记录');
  kvPair(kv, '作品类型', exp.category || '未分类');
  var op = exp.outputPolicy || {};
  kvPair(kv, '运行上限', op.timeoutMs === null || op.timeoutMs === undefined ? '未记录' : (op.timeoutMs / 1000) + ' 秒');
  kvPair(kv, '并发数', op.concurrency === null || op.concurrency === undefined ? '未记录' : op.concurrency);
  kvPair(kv, '整轮输出上限', op.maxTokens === null || op.maxTokens === undefined ? '未设置（用各候选自己的）' : op.maxTokens);
  var pp = exp.previewPolicy || {};
  kvPair(kv, '预览网络策略', pp.networkPolicy === 'cdn' ? '受控 CDN（需要联网）' : '离线（外部请求被禁用）');
  kvPair(kv, '比较方式', '所有候选使用相同的逻辑视口，因此落到同一响应式断点');
  kvPair(kv, '数据版本', exp.version === null || exp.version === undefined ? '未记录' : exp.version);
  wrap.appendChild(kv);

  var hint = el('div', { class: 'muted', style: 'margin-top:6px' });
  hint.appendChild(el('span', { text: '下面每个候选可以单独展开看它自己的系统提示词、参数、用量与耗时。' }));
  wrap.appendChild(hint);
  return wrap;
}

/** 单个候选的完整配置。 */
function buildAttemptConfig(a, i, attempts, hideIdentity, HIDDEN) {
  var root = el('div', { class: 'cfg-block', style: 'margin-bottom:16px' });
  var headText = String.fromCharCode(65 + i) + ' · ' + (hideIdentity ? HIDDEN : a.recipe.name);
  root.appendChild(el('div', { style: 'font-weight:600', text: headText }));

  var kv = el('dl', { class: 'kv' });
  kvPair(kv, '模型来源', hideIdentity ? HIDDEN : (a.recipe.provider || '—'));
  kvPair(kv, '模型', hideIdentity ? HIDDEN : (a.recipe.model || '—'));
  kvPair(kv, '思考档位', a.recipe.reasoningEffort || '未指定');
  kvPair(kv, '温度', a.recipe.temperature === null || a.recipe.temperature === undefined ? '未指定' : a.recipe.temperature);
  kvPair(kv, '输出上限', a.recipe.maxTokens === null || a.recipe.maxTokens === undefined ? '模型默认' : a.recipe.maxTokens);
  kvPair(kv, '尝试轮次', '第 ' + (a.attemptNo || 1) + ' 轮' + (a.parentAttemptId ? '（由上一轮重试新建，上一轮的原始输出仍保留）' : ''));
  kvPair(kv, '状态', statusLabel(a));
  root.appendChild(kv);

  // ── 解析出的模型能力（服务端已返回，以前没渲染） ──────────
  //
  // 隐藏身份期间这几项也要遮：上下文窗口、默认输出上限、可用思考档位清单
  // 是**模型指纹** —— 比如 "1000000 / 256000 / off·low·high·max" 这一组
  // 基本就等于把 deepseek-flash 写出来了。只遮 provider/model 是不够的。
  var res = a.resolved || {};
  var kv2 = el('dl', { class: 'kv' });
  if (hideIdentity) {
    kvPair(kv2, '上下文窗口', HIDDEN);
    kvPair(kv2, '模型默认输出上限', HIDDEN);
    kvPair(kv2, '可用思考档位', HIDDEN);
  } else {
    kvPair(kv2, '上下文窗口', res.contextWindow === null || res.contextWindow === undefined ? '未知' : res.contextWindow);
    kvPair(kv2, '模型默认输出上限', res.defaultMaxTokens === null || res.defaultMaxTokens === undefined ? '未知' : res.defaultMaxTokens);
    kvPair(kv2, '可用思考档位', res.availableReasoningEfforts && res.availableReasoningEfforts.length ? res.availableReasoningEfforts.join(' / ') : '该适配器没有上报档位清单');
  }
  if (res.note) {
    var safeNote = hideIdentity ? blindSafeText(res.note) : res.note;
    kvPair(kv2, '解析说明', safeNote === null ? HIDDEN + '（说明文本里出现了配置身份字串）' : safeNote);
  }
  root.appendChild(kv2);

  // ── 系统提示词与提示词片段：候选之间差异的主要来源 ────────
  var blindNote = null;
  if (hideIdentity && (a.recipe.systemPrompt || (a.recipe.promptSegments && a.recipe.promptSegments.length))) {
    // 系统提示词里很可能写着"你是 X 模型"，隐藏身份期间整段不显示（宁可不显示也不泄露）
    blindNote = el('div', { class: 'muted', text: '系统提示词与提示词片段：' + HIDDEN + '（它们可能写出模型名）' });
    root.appendChild(blindNote);
  } else {
    root.appendChild(el('div', { class: 'label', text: '系统提示词' }));
    root.appendChild(longText('系统提示词原文', a.recipe.systemPrompt, '（没有设置系统提示词，本次只发题目与输出要求）'));
    root.appendChild(el('div', { class: 'label', text: '提示词片段' }));
    var segs = a.recipe.promptSegments || [];
    if (segs.length === 0) {
      root.appendChild(el('div', { class: 'muted', text: '（没有提示词片段）' }));
    } else {
      segs.forEach(function (seg, si) {
        root.appendChild(longText('片段 ' + (si + 1) + '/' + segs.length, seg));
      });
    }
  }

  // ── 用量与耗时（服务端已返回，以前没渲染） ────────────────
  var rc = a.receipt;
  root.appendChild(el('div', { class: 'label', text: '用量与耗时' }));
  if (!rc) {
    root.appendChild(el('div', { class: 'muted', text: '（还没有收据：这个候选没有跑到收尾）' }));
  } else if (hideIdentity) {
    // 盲选期间同样不写这些数字。判断依据（第三轮反馈 2 要求"判断会不会构成模型指纹"）：
    //  token 数与速度**不像**上下文窗口那样与某个模型一一对应（同一模型换个题目数字就全变），
    //  所以它们不是强指纹；但两件事仍然成立：
    //   ① 它们和上下文窗口 / 档位清单属于同一类"调用元数据"，同一块面板里一半遮一半露才是真的怪；
    //   ② 盲选的目的是"先看作品"，这时把 235.8 tok/s 摆出来会把对比变成跑分，反过来影响投票。
    //  所以按同一条约定整块隐藏，并写明"揭晓后可见"，给用户一个明确的恢复路径。
    root.appendChild(el('div', { class: 'muted', text: '盲选期间隐藏（揭晓后可见）：输入 / 输出 / 合计 / 缓存 / 推理 tokens、总速度、首正文延迟与各段耗时。' }));
    var kv3b = el('dl', { class: 'kv' });
    kvPair(kv3b, '收尾原因', rc.finishReason === null || rc.finishReason === undefined ? '未知（没有收到收尾信息）' : rc.finishReason);
    kvPair(kv3b, '逻辑请求数', rc.observedRequests === null || rc.observedRequests === undefined ? '未上报' : rc.observedRequests + '（插件直调不会被自动重试）');
    root.appendChild(kv3b);
  } else {
    var kv3 = el('dl', { class: 'kv' });
    kvPair(kv3, '总耗时', fmtDuration(rc.startedAt, rc.finishedAt));
    kvPair(kv3, '排队到开始', fmtDuration(rc.queuedAt, rc.startedAt));
    kvPair(kv3, '首事件', fmtDuration(rc.startedAt, rc.firstEventAt));
    kvPair(kv3, '首正文', fmtDuration(rc.startedAt, rc.firstTextAt));
    kvPair(kv3, '输入 tokens', usageValue(rc.usage, 'inputTokens'));
    kvPair(kv3, '输出 tokens', usageValue(rc.usage, 'outputTokens'));
    kvPair(kv3, '合计 tokens', usageValue(rc.usage, 'totalTokens'));
    kvPair(kv3, '缓存命中 tokens', usageValue(rc.usage, 'cacheReadTokens'));
    kvPair(kv3, '缓存写入 tokens', usageValue(rc.usage, 'cacheWriteTokens'));
    kvPair(kv3, '推理 tokens', usageValue(rc.usage, 'reasoningTokens'));
    kvPair(kv3, '收尾原因', rc.finishReason === null || rc.finishReason === undefined ? '未知（没有收到收尾信息）' : rc.finishReason);
    kvPair(kv3, '逻辑请求数', rc.observedRequests === null || rc.observedRequests === undefined ? '未上报' : rc.observedRequests + '（插件直调不会被自动重试）');
    kvPair(kv3, '开始时间', fmtTime(rc.startedAt));
    kvPair(kv3, '结束时间', fmtTime(rc.finishedAt));
    root.appendChild(kv3);
    // 速度口径写在展开配置里也要一致：总速度是唯一出现在界面上的速度（见 buildUsageStrip 注释）
    var spd = totalSpeed(rc);
    root.appendChild(el('div', { class: 'muted', text: '总速度 ' + (spd === null ? '未上报' : spd.toFixed(1) + ' tok/s')
      + ' = 输出 tokens ÷（开始→结束）。没有用"首正文之后的时间"当分母：推理型模型会先吐完 reasoning token 才出正文，那样算出来会虚高好几倍。' }));
  }

  // ── 产物指纹与提取告警 ────────────────────────────────────
  var ex = a.extraction || {};
  var kv4 = el('dl', { class: 'kv' });
  // hash 不暴露模型身份（投票就是绑在这个 hash 上的，藏了反而看不懂），照常显示；
  // 字节数只跟这次输出有关，也不涉及身份。
  kvPair(kv4, '作品 hash', ex.htmlHash ? ex.htmlHash.slice(0, 16) + '…' : '无');
  kvPair(kv4, '原始正文 hash', ex.rawTextHash ? ex.rawTextHash.slice(0, 16) + '…' : '无');
  kvPair(kv4, '作品字节数', ex.bytes === null || ex.bytes === undefined ? '未记录' : fmtBytes(ex.bytes));
  kvPair(kv4, '提取方式', ex.mode ? (ex.mode + '（提取器 v' + (ex.version || '?') + '）') : '未提取');
  root.appendChild(kv4);

  root.appendChild(el('div', { class: 'label', text: '提取告警' }));
  var warnBox = el('div');
  if (ex.warnings && ex.warnings.length) {
    ex.warnings.forEach(function (w) { warnBox.appendChild(el('div', { class: 'muted', text: '⚠ ' + (w.message || JSON.stringify(w)) })); });
  } else {
    warnBox.appendChild(el('div', { class: 'muted', text: '（没有告警）' }));
  }
  root.appendChild(warnBox);

  // 与第一个候选的差异
  var anchor = attempts[0];
  var diffs = [];
  var fields = [['provider', '模型来源'], ['model', '模型'], ['reasoningEffort', '思考档位'], ['temperature', '温度'], ['maxTokens', '输出上限'], ['systemPrompt', '系统提示词']];
  fields.forEach(function (f) {
    if (JSON.stringify(a.recipe[f[0]]) !== JSON.stringify(anchor.recipe[f[0]])) diffs.push(f[1]);
  });
  if (JSON.stringify(a.recipe.promptSegments) !== JSON.stringify(anchor.recipe.promptSegments)) diffs.push('提示词片段');
  root.appendChild(el('div', { class: 'muted', text: i === 0 ? '作为对照组' : '与 A 的差异：' + (diffs.length ? diffs.join('、') : '（无）') }));

  // 这一轮的状态与失败原因：超时/取消/中断/失败都要在这里看得到（含上游原始错误）
  var st = el('dl', { class: 'kv' });
  kvPair(st, '本轮状态', statusLabel(a) + '（' + a.status + '）');
  kvPair(st, '收尾原因', a.receipt && a.receipt.finishReason ? a.receipt.finishReason : '未记录');
  if (a.error) {
    kvPair(st, '失败原因', a.error.title);
    kvPair(st, '下一步', a.error.hint);
    // 带上错误码：未识别的码（如适配器统一的 PI_AI_ERROR）本身也是线索，用户搜索时用得上
    if (a.error.message) kvPair(st, '上游原始错误（' + a.error.code + '）', String(a.error.message).slice(0, 500));
  }
  if (a.partial) kvPair(st, '中断前落盘的部分输出', a.partial.chars + ' 字符（可下载）');
  root.appendChild(st);

  // 配方溯源：这一轮用的是哪个配方的哪一版（内容以 attempt 里的快照为准）
  if (a.recipeLink) {
    root.appendChild(el('div', { class: 'muted', text: '配方来源：' + a.recipeLink.recipeId + ' 第 ' + a.recipeLink.recipeVersion + ' 版'
      + '（这一轮引用的是启动时的快照，配方后来改了也不影响它）' }));
  }

  // 运行时错误：容器固定，内容由 renderCompareDetails 原地更新（不重建上面的内容）
  var errText = el('div', { class: 'muted', style: 'margin-top:6px' });
  root.appendChild(errText);

  var actions = el('div', { class: 'row gap wrap', style: 'margin-top:8px' });
  actions.appendChild(el('button', { class: 'btn small', text: '查看原始正文', onclick: function () { viewRaw(a.id); } }));
  if (a.canPreview) actions.appendChild(el('button', { class: 'btn small', text: '下载作品 HTML', onclick: function () { download(a.id, 'html'); } }));
  actions.appendChild(el('button', {
    class: 'btn small', text: '把这次的配置存成配方',
    title: '存的是这一轮实际发出去的快照，以后再改配方也不会改写它',
    onclick: function () { saveAttemptAsRecipe(a.id, (a.recipe && a.recipe.name) || '来自实验的配方'); },
  }));
  root.appendChild(actions);

  return { root: root, errText: errText, blindNote: blindNote };
}

/** 用量字段：未上报就写"未上报"，绝不写成 0（F18 / A18）。 */
function usageValue(usage, key) {
  if (!usage) return '未上报';
  var v = usage[key];
  if (v === null || v === undefined) return '未上报';
  return String(v);
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
      // 只刷新截图面板：重建作品区会把用户正在操作的作品重置（实测缺陷）
      renderScreenshots(lastAttemptPerSlot(state.current.attempts));
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
  // 搜索框加防抖：既省请求，也让竞态窗口更小（配合 loadExperiments 里的序列号守卫）
  var searchTimer = null;
  $('search').addEventListener('input', function () {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(function () { loadExperiments(); }, 180);
  });
  $('filter-category').addEventListener('change', function () { loadExperiments(); });
  // 配方页：搜索同样防抖；刷新按钮强制重读（版本历史可能在别处被追加）
  var recipeTimer = null;
  $('recipe-search').addEventListener('input', function () {
    state.recipes.search = $('recipe-search').value.trim();
    clearTimeout(recipeTimer);
    recipeTimer = setTimeout(function () { loadRecipes(); }, 180);
  });
  $('btn-recipes-reload').addEventListener('click', function () { loadRecipes(); });
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

  $('btn-add-round').addEventListener('click', addRound);
  $('btn-cancel-all').addEventListener('click', function () {
    api('/experiments/' + encodeURIComponent(state.current.experiment.id) + '/cancel', { method: 'POST' })
      .then(function (r) { toast('已请求停止 ' + r.cancelled + ' 个候选'); })
      .catch(function (err) { toast('停止失败：' + err.message, true); });
  });
  $('btn-goto-compare').addEventListener('click', function () { showView('compare'); renderCompare(); });

  var segs = document.querySelectorAll('.seg-btn[data-vp]');
  for (var j = 0; j < segs.length; j++) {
    segs[j].addEventListener('click', function (ev) {
      state.viewport = ev.currentTarget.getAttribute('data-vp');
      var all = document.querySelectorAll('.seg-btn[data-vp]');
      for (var k = 0; k < all.length; k++) all[k].className = 'seg-btn' + (all[k].getAttribute('data-vp') === state.viewport ? ' is-active' : '');
      renderCompare();
    });
  }

  // ── 水平展开比对（第三轮反馈 1）──────────────────────────
  // 两个独立开关，别混成一个：一个决定"多宽"，一个决定"左右跟不跟"。
  var modeSegs = document.querySelectorAll('.seg-btn[data-mode]');
  for (var mj = 0; mj < modeSegs.length; mj++) {
    modeSegs[mj].addEventListener('click', function (ev) {
      var mode = ev.currentTarget.getAttribute('data-mode');
      if (state.compareMode === mode) return;
      // 只改缩放与滚动属性，**不重建 iframe**（重建会把用户在作品里的操作状态清掉）
      state.compareMode = mode;
      applyCompareMode();
      updateExpandUI();
      toast(mode === 'wide'
        ? '已切到 1:1 横向展开：作品按原始尺寸摆开，格子放不下就左右拖动，两边会同步滚'
        : '已回到"缩小到能看全"：整份作品缩放进卡片，不用拖动');
    });
  }
  var syncBox = $('sync-scroll');
  if (syncBox) {
    state.syncScroll = syncBox.checked;
    syncBox.addEventListener('change', function () {
      state.syncScroll = syncBox.checked;
      updateExpandUI();
      toast(syncBox.checked ? '左右同步滚动已开启' : '左右同步滚动已关闭');
    });
  }
  // 只挂一次（事件委托）：作品是重建出来的，逐个 onscroll 会在重绘后丢
  if (!window.__arenaScrollBound) {
    window.__arenaScrollBound = true;
    document.addEventListener('scroll', function (ev) {
      var t = ev.target;
      if (!t || t === document || t === window) return;
      if (!t.classList) return;
      if (t.classList.contains('scaler') || t.classList.contains('frame-body') || t.id === 'compare-grid') {
        syncScrollFrom(t);
      }
    }, true);   // 捕获阶段：scroll 不冒泡，捕获才收得到
    window.addEventListener('resize', function () { refitFrames(); }, { passive: true });
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
