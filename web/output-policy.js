/* ConfigStudio 前端 · 运行上限（M5）。
 *
 * 为什么单独一个文件：这块逻辑有两个使用方（新建对比页的运行上限下拉、
 * 对比页失败卡片上的「应用并重试」），而且它的**默认值算法必须与超时提示说的是同一个数**。
 * index.html 原来只加载 app.js 一个文件，这里新增一个普通 <script> 就好 ——
 * 没有构建步骤，也不需要改任何工具链。
 *
 * 设计原则（与 app.js 一致）：不写模板字符串，全部用字符串拼接。
 *
 * 口径来源：服务端 /meta 的 outputPolicy（core/output-policy.js），界面**不**再抄一份。
 */
'use strict';

/** 服务端策略视图；没拿到时给一个最小的兜底（仍然是同样的数，只是没有选项表）。 */
function arenaOutputPolicy() {
  return (window.__htmlArena.state.outputPolicy) || {
    defaultMs: 180000, defaultLabel: '3 分钟',
    choices: [{ ms: 180000, label: '3 分钟' }],
    effortFloors: { off: 0, low: 0, medium: 0, high: 600000, max: 900000 },
  };
}

function arenaFormatMs(ms) {
  var n = Number(ms);
  if (!isFinite(n) || n <= 0) return '未记录';
  if (n < 60000) {
    var seconds = n / 1000;
    return (seconds === Math.floor(seconds) ? String(seconds) : seconds.toFixed(1)) + ' 秒';
  }
  var minutes = n / 60000;
  return (minutes === Math.floor(minutes) ? String(minutes) : minutes.toFixed(1)) + ' 分钟';
}

/** 与 core/output-policy.js 的 normalizeEffortId 同一套归一（认不出就说认不出）。 */
function arenaNormalizeEffort(effort) {
  if (typeof effort !== 'string') return null;
  var s = effort.trim().toLowerCase();
  if (s === '') return null;
  if (s === 'none' || s === 'off' || s === 'disabled') return 'off';
  if (s === 'minimal' || s === 'min' || s === 'low') return 'low';
  if (s === 'medium' || s === 'mid' || s === 'moderate') return 'medium';
  if (s === 'high' || s === 'max' || s === 'xhigh' || s === 'ultra' || s === 'extreme') return s;
  return null;
}

/**
 * 按当前候选的思考档位算默认运行上限。
 *
 * 实测依据：真实对比里开了 max 档的候选，首正文等了 112 秒 —— 3 分钟这个默认值
 * 本来就不够（另一个候选就因此被中止，0 字节）。所以档位越高，默认值越大。
 * 规则的数字只有服务端那一份（effortFloors），这里只做"取最大值"。
 */
function arenaDefaultTimeout(candidates) {
  var policy = arenaOutputPolicy();
  var floors = policy.effortFloors || {};
  var floor = 0;
  var maxEffort = null;
  for (var i = 0; i < (candidates || []).length; i++) {
    var id = arenaNormalizeEffort(candidates[i].reasoningEffort);
    if (id === null) continue;
    if (id === 'high' || id === 'max') maxEffort = (maxEffort === 'max' || id === 'max') ? 'max' : id;
    floor = Math.max(floor, floors[id] || 0);
  }
  var timeMs = Math.max(policy.defaultMs || 180000, floor);
  return {
    timeMs: timeMs,
    elevated: timeMs > (policy.defaultMs || 180000),
    maxEffort: maxEffort,
  };
}

/** 当前生效的运行上限：用户选过就用它，否则按档位自动算。 */
function arenaEffectiveTimeout(candidates) {
  if (typeof window.__htmlArena.state.timeoutMs === 'number' && window.__htmlArena.state.timeoutMs > 0) {
    return { timeMs: window.__htmlArena.state.timeoutMs, source: 'chosen', elevated: false, maxEffort: null };
  }
  var auto = arenaDefaultTimeout(candidates);
  auto.source = 'auto';
  return auto;
}

/** 渲染新建对比页的那一排：运行上限下拉 + 一句为什么是这个数。 */
function arenaRenderTimeoutRow() {
  var policy = arenaOutputPolicy();
  var sel = document.getElementById('timeout');
  var note = document.getElementById('timeout-note');
  if (!sel || !note) return;

  var auto = arenaDefaultTimeout(window.__htmlArena.state.candidates);
  var chosen = window.__htmlArena.state.timeoutMs;
  var effective = chosen === null ? auto.timeMs : chosen;

  // 只在"选项集合"变化时重建 option（其余时候只改 selected，避免打断用户）
  var sig = (policy.choices || []).map(function (c) { return c.ms + ':' + c.label; }).join(',')
    + '|' + auto.timeMs + '|' + (auto.elevated ? '1' : '0');
  if (sel.getAttribute('data-sig') !== sig) {
    sel.setAttribute('data-sig', sig);
    sel.innerHTML = '';
    var autoOpt = document.createElement('option');
    autoOpt.value = '';
    autoOpt.textContent = '自动（当前 ' + arenaFormatMs(auto.timeMs) + '）'
      + (auto.elevated ? '·按思考档位' : '');
    sel.appendChild(autoOpt);
    (policy.choices || []).forEach(function (c) {
      var o = document.createElement('option');
      o.value = String(c.ms);
      o.textContent = c.label;
      sel.appendChild(o);
    });
  }
  sel.value = chosen === null ? '' : String(chosen);

  var parts = ['本次候选最多等 ' + arenaFormatMs(effective) + '；到点尽力中止，已收到的正文仍保存。'];
  if (chosen === null && auto.elevated) {
    parts.push('默认值已按思考档位'
      + (auto.maxEffort === 'max' ? '（最高档）' : '（较高档）')
      + '自动抬到 ' + arenaFormatMs(auto.timeMs) + '：开档位的模型要先吐完推理才出正文，实测首正文可能等将近两分钟。');
  } else if (chosen !== null) {
    var loose = (policy.choices || []).filter(function (c) { return c.ms === chosen && c.loose; }).length > 0;
    parts.push(loose
      ? '这是一个很宽的上限：它只影响"等多久才放弃"，模型该跑多久还是多久 —— 慢的候选会让你等满这么久。'
      : '想给推理档位留更多时间，可以选更大的档。');
  }
  note.textContent = parts.join(' ');
}

/**
 * 对比页头部的"运行上限"下拉。
 *
 * 为什么放在这里：用户是**在对比页上**看到"超过本轮运行上限"这句话的。
 * 就地能改，就不用回新建页把整道题重建一遍（题目与候选快照都还在，
 * 没有任何一样需要重来）。
 */
function arenaRenderCompareTimeout() {
  var sel = document.getElementById('compare-timeout');
  if (!sel) return;
  var cur = window.__htmlArena.state.current;
  if (!cur) return;
  var policy = arenaOutputPolicy();
  var exp = cur.experiment.outputPolicy || {};
  var currentMs = exp.timeoutMs || policy.defaultMs;
  var choices = (policy.choices || []);
  var known = choices.some(function (c) { return c.ms === currentMs; });
  var sig = choices.map(function (c) { return c.ms; }).join(',') + '|' + currentMs;
  if (sel.getAttribute('data-sig') !== sig) {
    sel.setAttribute('data-sig', sig);
    sel.innerHTML = '';
    // 导入的复测包可能带着一个不在下拉档位里的值：如实显示它，不偷偷改成别的数
    if (!known) {
      var o0 = document.createElement('option');
      o0.value = String(currentMs);
      o0.textContent = arenaFormatMs(currentMs) + '（这个实验自己的值）';
      sel.appendChild(o0);
    }
    choices.forEach(function (c) {
      var o = document.createElement('option');
      o.value = String(c.ms);
      o.textContent = c.label;
      sel.appendChild(o);
    });
  }
  sel.value = String(currentMs);
  var label = document.getElementById('compare-timeout-label');
  if (label) {
    var timeoutCount = (cur.attempts || []).filter(function (a) { return a.error && a.error.code === 'TIMEOUT'; }).length;
    label.textContent = timeoutCount > 0
      ? '运行上限（有 ' + timeoutCount + ' 个候选超时）'
      : '运行上限';
  }
}

/** 挂事件（只在 boot 时调一次）。 */
function arenaBindTimeoutRow() {
  var sel = document.getElementById('timeout');
  if (!sel) return;
  sel.addEventListener('change', function () {
    window.__htmlArena.state.timeoutMs = sel.value === '' ? null : Number(sel.value);
    arenaRenderTimeoutRow();
  });
  arenaRenderTimeoutRow();
}

// ── 多块选择：extraction.status === 'multiple' 时让用户真的能选一个 ──────────

/** 打开选择面板（拉候选清单 → 让用户挑 → 落盘成作品）。 */
function arenaOpenPick(attemptId, label) {
  window.__htmlArena.state.picked = { attemptId: attemptId, label: label || '', loading: true, candidates: [], chosen: null, error: null };
  arenaRenderPick();
  window.__htmlArena.api('/experiments/' + encodeURIComponent(window.__htmlArena.state.current.experiment.id)
    + '/attempts/' + encodeURIComponent(attemptId) + '/candidates')
    .then(function (r) {
      var p = window.__htmlArena.state.picked;
      if (!p || p.attemptId !== attemptId) return;   // 用户已经切走了
      p.loading = false;
      p.candidates = r.candidates || [];
      p.status = r.status;
      p.note = r.note;
      arenaRenderPick();
    })
    .catch(function (err) {
      var p = window.__htmlArena.state.picked;
      if (!p || p.attemptId !== attemptId) return;
      p.loading = false;
      p.error = err.message;
      arenaRenderPick();
    });
}

function arenaClosePick() {
  window.__htmlArena.state.picked = null;
  arenaRenderPick();
}

/** 确认：把选中的那一块存成这个候选的作品。 */
function arenaConfirmPick() {
  var p = window.__htmlArena.state.picked;
  if (!p || p.chosen === null || p.busy) return;
  p.busy = true;
  arenaRenderPick();
  window.__htmlArena.api('/experiments/' + encodeURIComponent(window.__htmlArena.state.current.experiment.id)
    + '/attempts/' + encodeURIComponent(p.attemptId) + '/pick', {
    method: 'POST', body: { candidateIndex: p.chosen },
  }).then(function () {
    window.__htmlArena.toast('已把第 ' + (p.chosen + 1) + ' 块存成作品');
    window.__htmlArena.state.picked = null;
    return window.__htmlArena.openExperiment(window.__htmlArena.state.current.experiment.id);
  }).catch(function (err) {
    var q = window.__htmlArena.state.picked;
    if (q) { q.busy = false; q.error = err.message; arenaRenderPick(); }
    window.__htmlArena.toast('选择失败：' + err.message, true);
  });
}

/** 面板是一个独立浮层：属于"这次要不要落盘"的决定，不该混进作品区的重绘里。 */
function arenaRenderPick() {
  var host = document.getElementById('pick-modal');
  if (!host) return;
  var p = window.__htmlArena.state.picked;
  if (!p) { host.hidden = true; host.innerHTML = ''; return; }
  host.hidden = false;
  host.innerHTML = '';

  var box = document.createElement('div');
  box.className = 'modal-box';
  host.appendChild(box);

  var head = document.createElement('div');
  head.className = 'row gap wrap';
  head.style.alignItems = 'center';
  var title = document.createElement('h3');
  title.className = 'h3';
  title.textContent = '选择要作为作品的 HTML 块';
  head.appendChild(title);
  var spacer = document.createElement('span');
  spacer.className = 'spacer';
  head.appendChild(spacer);
  var close = document.createElement('button');
  close.className = 'btn small';
  close.textContent = '取消';
  close.addEventListener('click', arenaClosePick);
  head.appendChild(close);
  box.appendChild(head);

  var sub = document.createElement('p');
  sub.className = 'muted';
  sub.textContent = (p.label ? p.label + '：' : '')
    + '模型这一次返回了多个 HTML 块，插件不会替你挑（拼接或猜一个都可能毁掉作品）。你说哪一块就是哪一块。';
  box.appendChild(sub);

  if (p.loading) {
    var l = document.createElement('div');
    l.className = 'muted';
    l.textContent = '正在列出这一次返回的块…';
    box.appendChild(l);
    return;
  }
  if (p.error) {
    var e = document.createElement('div');
    e.className = 'problems';
    e.textContent = p.error;
    box.appendChild(e);
  }

  (p.candidates || []).forEach(function (c, i) {
    var card = document.createElement('label');
    card.className = 'pick-card' + (p.chosen === i ? ' is-chosen' : '');
    card.setAttribute('data-pick-index', String(i));
    var radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'pick-candidate';
    radio.checked = p.chosen === i;
    radio.addEventListener('change', function () {
      window.__htmlArena.state.picked.chosen = i;
      arenaRenderPick();
    });
    card.appendChild(radio);
    var meta = document.createElement('div');
    meta.style.flex = '1';
    meta.style.minWidth = '0';
    var t = document.createElement('div');
    t.style.fontWeight = '600';
    t.textContent = '第 ' + (i + 1) + ' 块 · ' + c.language
      + (c.closed ? '' : ' · 未闭合（模型可能被截断）')
      + ' · 约 ' + (c.end - c.start) + ' 字符';
    meta.appendChild(t);
    var prev = document.createElement('pre');
    prev.className = 'stream';
    prev.style.maxHeight = '110px';
    prev.textContent = c.preview;
    meta.appendChild(prev);
    card.appendChild(meta);
    box.appendChild(card);
  });

  if ((p.candidates || []).length === 0 && !p.loading) {
    var none = document.createElement('div');
    none.className = 'muted';
    none.textContent = '这一次没有可选的块（提取状态：' + (p.status || '未知') + '）。';
    box.appendChild(none);
  }

  if (p.note) {
    var note = document.createElement('p');
    note.className = 'muted';
    note.textContent = p.note;
    box.appendChild(note);
  }

  var actions = document.createElement('div');
  actions.className = 'row gap wrap';
  actions.style.alignItems = 'center';
  var ok = document.createElement('button');
  ok.className = 'btn primary';
  ok.textContent = p.chosen === null ? '先选一块' : ('把第 ' + (p.chosen + 1) + ' 块存成作品');
  ok.disabled = p.chosen === null || Boolean(p.busy);
  ok.addEventListener('click', arenaConfirmPick);
  actions.appendChild(ok);
  var hint = document.createElement('span');
  hint.className = 'muted';
  hint.textContent = p.busy ? '正在保存…' : '原始正文不会因此被改写，仍然可以整份下载。';
  actions.appendChild(hint);
  box.appendChild(actions);
}

// ── 从失败/超时现场直接改上限并重跑 ──────────────────────────────────────

/**
 * 只改这一个实验的运行上限（可选：顺带把刚才失败的那个候选重跑一遍）。
 *
 * 为什么要有它：超时提示说的是"调大运行上限"，而用户此刻正站在对比页看着一条失败的记录。
 * 让他回新建页重建一遍整道题，属于工具自己制造的返工 —— 题目、候选快照、
 * 已经跑成功的另一件作品都还在，没有一样需要重来。
 */
function arenaApplyTimeout(timeoutMs, retryAttemptId) {
  var expId = window.__htmlArena.state.current && window.__htmlArena.state.current.experiment.id;
  return window.__htmlArena.api('/experiments/' + encodeURIComponent(expId) + '/output-policy', {
    method: 'PATCH', body: { timeoutMs: timeoutMs },
  }).then(function (r) {
    window.__htmlArena.toast('运行上限已改为 ' + arenaFormatMs(r.after) + '（历史尝试记录的是它们当时的值）');
    if (!retryAttemptId) return window.__htmlArena.openExperiment(expId);
    return window.__htmlArena.api('/experiments/' + encodeURIComponent(expId)
      + '/attempts/' + encodeURIComponent(retryAttemptId) + '/retry', {
      method: 'POST', body: { timeoutMs: timeoutMs },
    }).then(function (t) {
      window.__htmlArena.toast('已用新的上限重跑这个候选（第 ' + t.attemptNo + ' 轮，原记录保留）');
      return window.__htmlArena.openExperiment(expId);
    });
  }).catch(function (err) {
    window.__htmlArena.toast('没能改掉运行上限：' + err.message, true);
  });
}
