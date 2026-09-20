/**
 * 用户设置 —— **跟随数据目录持久化**（\$DSH_HOME/configstudio/settings.json）。
 *
 * 为什么不放 localStorage（M2 的决定，用户反馈 1 的直接要求）：
 *  1. 本插件的界面是普通 SPA，但状态属于"这台机器上的这份安装"，
 *     换个浏览器 / 换个入口访问应该看到同一份设置；
 *  2. M3 的展示包要能把配置一起带走，跟着数据目录才解释得通；
 *  3. 服务端才是唯一权威：界面只是读它的一个视图。
 *
 * 关于"外部插件能力开关"（用户反馈 1 的原话）：
 *   "提示词优化那个是一个插件来的，如果是别的插件的，得让用户自己选择是否加插件呀"
 *  所以这里登记的是**能力**而不是"某个功能号"：每个能力写明它来自哪个外部包、
 *  开启后会发生什么、以及默认值。**默认一律关**：探测到 ≠ 应该启用。
 *  探测结果只用来告诉用户"本机有这个能力可以开"，绝不替用户打开。
 *
 * @module configstudio/core/settings
 */
import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

/** 设置文件格式版本。字段结构变化时提升，并在这里写迁移。 */
export const SETTINGS_VERSION = 1;

/**
 * 本插件已知的**外部插件能力**清单。
 *
 * 加新能力时在这里加一项即可，界面与 API 会自动带上（M3 若要接别的东西，照这个形状填）。
 * 注意：这里只登记"需要用户显式同意"的外部能力；插件自己的功能不进这个清单。
 */
export const CAPABILITIES = Object.freeze([
  Object.freeze({
    key: 'prompt-optimizer',
    label: '提示词优化',
    source: '@dsh-external/dsh-prompt-optimizer',
    what: '在「新建对比」页显示优化区：把题目交给那个插件优化一次，结果先给你看，你点按钮才生效。',
    cost: '每点一次「优化题目」会额外产生一次模型调用费用。',
    defaultEnabled: false,
  }),
]);

/** 能力的默认开关表。 */
export function defaultCapabilities() {
  const out = {};
  for (const c of CAPABILITIES) out[c.key] = c.defaultEnabled === true;
  return out;
}

/** 一份全新的默认设置。 */
export function defaultSettings() {
  return { version: SETTINGS_VERSION, capabilities: defaultCapabilities() };
}

/**
 * 校验并归一从磁盘（或请求体）读来的设置。
 * 原则：**认不出来的一律忽略，不因为坏字段让整个插件起不来**。
 * @param {unknown} raw
 * @returns {{settings: object, notes: string[]}}
 */
export function normalizeSettings(raw) {
  const notes = [];
  const base = defaultSettings();
  if (!raw || typeof raw !== 'object') {
    if (raw !== undefined) notes.push('设置内容不是对象，已按默认值处理');
    return { settings: base, notes };
  }
  if (raw.version !== undefined && raw.version !== SETTINGS_VERSION) {
    notes.push('设置文件版本为 ' + String(raw.version) + '，当前为 ' + SETTINGS_VERSION + '；未知字段已忽略');
  }
  const caps = raw.capabilities;
  if (caps && typeof caps === 'object') {
    for (const c of CAPABILITIES) {
      // 只接受真正的布尔值：字符串 "false" 之类不猜
      if (typeof caps[c.key] === 'boolean') base.capabilities[c.key] = caps[c.key];
      else if (caps[c.key] !== undefined) notes.push('能力 ' + c.key + ' 的开关不是布尔值，已改用默认值');
    }
    for (const k of Object.keys(caps)) {
      if (!CAPABILITIES.some((c) => c.key === k)) notes.push('忽略了未知能力开关：' + k);
    }
  }
  return { settings: base, notes };
}

/**
 * 设置读写器。一个数据目录一个实例。
 * 写盘用"临时文件 + 改名"，避免写到一半被中断留下半截 JSON。
 */
export class SettingsStore {
  /** @param {string} dataDir 插件数据目录 */
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.path = join(dataDir, 'settings.json');
    this.notes = [];
    this.error = null;
  }

  /** 读设置。文件不存在 = 全新安装，返回默认值（**不写盘**，避免第一次启动就产生副作用）。 */
  read() {
    if (!existsSync(this.path)) { this.notes = []; this.error = null; return defaultSettings(); }
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(this.path, 'utf8'));
    } catch (err) {
      // 坏文件不能让插件不可用：退回默认值，但把原因留着如实告诉用户
      this.error = '设置文件无法解析（' + String(err && err.message || err).slice(0, 200) + '），当前使用默认值';
      this.notes = [];
      return defaultSettings();
    }
    const { settings, notes } = normalizeSettings(parsed);
    this.notes = notes;
    this.error = null;
    return settings;
  }

  /**
   * 合并写入。只接受已知能力键的布尔值，其它键忽略并回报。
   * @param {object} patch 形如 { capabilities: { 'prompt-optimizer': true } }
   */
  update(patch) {
    if (!patch || typeof patch !== 'object') return { ok: false, reason: '请求体不是对象' };
    const current = this.read();
    const next = { version: SETTINGS_VERSION, capabilities: { ...current.capabilities } };
    const rejected = [];
    if (patch.capabilities && typeof patch.capabilities === 'object') {
      for (const k of Object.keys(patch.capabilities)) {
        if (!CAPABILITIES.some((c) => c.key === k)) { rejected.push(k); continue; }
        const v = patch.capabilities[k];
        if (typeof v !== 'boolean') { rejected.push(k + '（不是布尔值）'); continue; }
        next.capabilities[k] = v;
      }
    }
    this.#write(next);
    return { ok: true, settings: next, rejected };
  }

  #write(settings) {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = this.path + '.tmp';
    writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n', 'utf8');
    renameSync(tmp, this.path);   // 同目录改名是原子的
    this.error = null;
  }

  /**
   * 给界面用的完整视图：每项能力的说明 + 是否探测到 + 是否已启用。
   * @param {Record<string, {available: boolean, reason?: string, current?: object}>} detected
   */
  view(detected = {}) {
    const settings = this.read();
    return {
      version: SETTINGS_VERSION,
      path: this.path,
      error: this.error,
      notes: this.notes,
      capabilities: CAPABILITIES.map((c) => {
        const d = detected[c.key] || { available: false, reason: '未探测' };
        return {
          key: c.key, label: c.label, source: c.source, what: c.what, cost: c.cost,
          enabled: settings.capabilities[c.key] === true,
          detected: d.available === true,
          detectedReason: d.available ? null : (d.reason ?? '未探测到'),
          detectedCurrent: d.current ?? null,
        };
      }),
    };
  }
}

/** 某个能力当前是否启用（读盘，不缓存）。 */
export function capabilityEnabled(settingsStore, key) {
  const s = settingsStore.read();
  return s.capabilities[key] === true;
}
