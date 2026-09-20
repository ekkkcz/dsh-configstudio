/**
 * 每候选运行上限（PRD F04"可调整的超时"）—— 默认值、可选项、上限，以及"推理档位高时
 * 该给多大"的**唯一一份**口径。
 *
 * 为什么单独成模块：这个缺口本身就是"两处各写一半"的产物 ——
 * 超时的提示写着"调大该候选的运行上限"，而界面上**根本没有**这个控件；
 * 默认值写死在 `src/index.js`，只有建实验时手写 API 才改得动。
 * 如果默认值、可选项、界面文案再各存一份，"改了一处、另一处没改"两轮之内必然重演
 * （frameScale / canonical.js / core/redact.js / core/usage.js 都是同一理由抽出来的）。
 *
 * 谁读这一份：
 *  ① `src/index.js`       默认配置（DEFAULT_CONFIG.defaultTimeoutMs）
 *  ② `src/api.js`         `/meta` 里的 outputPolicy 视图，界面下拉照它渲染
 *  ③ `web/app.js`         没有显式选择时，按本次候选的思考档位算一个更大的默认值
 *  ④ `src/core/pack.js`   复测包里 timeoutMs 的合理区间
 *
 * @module configstudio/core/output-policy
 */

/** 兜底默认：180 秒。没有选模型、或清单还没到位时用它。 */
export const DEFAULT_TIMEOUT_MS = 180000;

/**
 * 允许写入的区间。
 *
 * 下限刻意放得很低（100 毫秒）：它只用来挡住"0 / 负数 / 大得离谱的值"这类**不可能是上限**的输入，
 * 不是"推荐值"。真正的操作范围由界面下拉给（3–60 分钟），而接口与复测包必须留出
 * 小值 —— 验收脚本正是用几百毫秒来**真实触发**超时路径的（1 秒的下限会让这类测试
 * 只能绕过接口去做，那就不是端到端验证了）。
 * 上限 1 小时：再大就等于"永远不会到点"，A08 的超时语义会失去意义。
 */
export const TIMEOUT_MIN_MS = 100;
export const TIMEOUT_MAX_MS = 60 * 60 * 1000;

/**
 * 界面下拉里给的档位。
 *
 * `loose`：这一档大到足以覆盖"推理档位开很高"的情形，选中它就给一句提示。
 * 只提供 6 档而不是任意输入：这个值决定"这一轮会不会被超时打断"，
 * 让人手写一个 7 分钟既没有意义，也容易写出 0 或负数。
 */
export const TIMEOUT_CHOICES = Object.freeze([
  Object.freeze({ ms: 180000, label: '3 分钟' }),
  Object.freeze({ ms: 300000, label: '5 分钟' }),
  Object.freeze({ ms: 600000, label: '10 分钟', loose: true }),
  Object.freeze({ ms: 900000, label: '15 分钟', loose: true }),
  Object.freeze({ ms: 1800000, label: '30 分钟', loose: true }),
  Object.freeze({ ms: 3600000, label: '60 分钟', loose: true }),
]);

/** 把推理档位字符串归一成 off / low / medium / high / max。 */
export function normalizeEffortId(effort) {
  if (typeof effort !== 'string') return null;
  const s = effort.trim().toLowerCase();
  if (s.length === 0) return null;
  if (s === 'none' || s === 'off' || s === 'disabled') return 'off';
  if (s === 'minimal' || s === 'min' || s === 'low') return 'low';
  if (s === 'medium' || s === 'mid' || s === 'moderate') return 'medium';
  if (s === 'high' || s === 'max' || s === 'xhigh' || s === 'ultra' || s === 'extreme') return s;
  // 认不出来就说认不出来：不替它猜一个档位（A04 的同一原则）
  return null;
}

/** 档位 → 最小可接受的默认上限。没开档位时不需要为推理额外预留时间。 */
const FLOOR_BY_EFFORT = Object.freeze({
  off: 0, low: 0, medium: 0, high: 600000, max: 900000,
});

/**
 * 计算"这一轮该给多大的运行上限"。
 *
 * 依据是**实测**：上一轮用真实模型跑「写一个动态的鹈鹕骑自行车」时，候选 A 花了 125.5 秒
 * 才出正文（其中首正文延迟 112 秒），候选 B 直接卡死在 180 秒的默认值上、0 字节。
 * 也就是说 3 分钟的默认值**对开了推理档位的模型本来就不够** ——
 * 这不是用户操作问题，是默认值没跟着档位走。
 *
 * 规则（刻意保守）：
 *  · 没有候选、或所有候选都没选档位 → 180 秒（行为与 0.6.0 完全一致）；
 *  · 有候选开了 high / max → 抬到至少 10 / 15 分钟；
 *  · lo（low / off）不提供下限 —— 那些候选不需要为推理额外预留时间。
 *
 * **只上不下**：抬上去的值不小于 180 秒，且只取不低于基准默认值的门槛，
 * 免得把基准默认值调小之后，这里反而算出一个比它还小的数。
 *
 * @param {Array<{reasoningEffort?: string|null}>} [candidates]
 * @returns {{ timeMs: number, elevated: boolean, maxEffort: string|null, reason: string|null }}
 */
export function effectiveDefaultTimeout(candidates) {
  const list = Array.isArray(candidates) ? candidates : [];
  let maxEffort = null;
  let floor = 0;
  let sawAny = false;
  for (const c of list) {
    if (!c || typeof c !== 'object') continue;
    const id = normalizeEffortId(c.reasoningEffort);
    if (id === null) continue;
    sawAny = true;
    if (id === 'high' || id === 'max') maxEffort = maxEffort === 'max' ? 'max' : (maxEffort === null ? id : 'max');
    floor = Math.max(floor, FLOOR_BY_EFFORT[id] ?? 0);
  }
  // 只取不低于基准默认值的门槛：基准被调小时，这里不会反过来算出一个更小的值
  const timeMs = Math.max(DEFAULT_TIMEOUT_MS, floor);
  if (!sawAny || maxEffort === null || timeMs <= DEFAULT_TIMEOUT_MS) {
    return { timeMs: DEFAULT_TIMEOUT_MS, elevated: false, maxEffort, reason: null };
  }
  return {
    timeMs,
    elevated: timeMs > DEFAULT_TIMEOUT_MS,
    maxEffort,
    reason: '有候选开了' + (maxEffort === 'max' ? '最高' : '较高') + '推理档位：'
      + '开档位的模型会先吐完推理才开始出正文，'
      + formatMs(DEFAULT_TIMEOUT_MS) + '在实测里不够（真实对比中一个候选就这样被中止了，0 字节）。',
  };
}

/**
 * 把任意输入钳成合法的运行上限。
 * 非法值一律返回 null，由调用方决定用默认值还是别的 —— 不猜、不静默改写成某个数。
 */
export function clampTimeoutMs(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isInteger(n)) return null;
  if (n < TIMEOUT_MIN_MS || n > TIMEOUT_MAX_MS) return null;
  return n;
}

/**
 * 毫秒 → 人话：1500 → "1.5 秒"；90000 → "1.5 分钟"；180000 → "3 分钟"。
 *
 * 小于一分钟时保留一位小数：去整会把 1.2 秒写成"1 秒" ——
 * 这个数字会出现在超时提示里，用户要拿它跟界面上的下拉比对，少一位就对不上了。
 * 给人看的，不参与任何计算。
 */
export function formatMs(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '未记录';
  if (n < 60000) {
    const seconds = n / 1000;
    return (Number.isInteger(seconds) ? String(seconds) : seconds.toFixed(1)) + ' 秒';
  }
  const minutes = n / 60000;
  return (Number.isInteger(minutes) ? String(minutes) : minutes.toFixed(1)) + ' 分钟';
}

/** 给界面用的视图（`/meta` 原样返回，前端不再自己维护一份选项表）。 */
export function timeoutPolicyView() {
  return {
    defaultMs: DEFAULT_TIMEOUT_MS,
    defaultLabel: formatMs(DEFAULT_TIMEOUT_MS),
    minMs: TIMEOUT_MIN_MS,
    maxMs: TIMEOUT_MAX_MS,
    choices: TIMEOUT_CHOICES.map((c) => ({ ...c, label: c.label })),
    // 推理档位 → 更大的默认值（前端拿它算"自动"档到底是多少，规则只有这一份）
    effortFloors: { ...FLOOR_BY_EFFORT },
    note: '运行上限就是"这一次调用最多等多久"。到点会尽力中止这次调用，'
      + '已收到的正文仍然保存；这次尝试记成"超时"（与"取消"分开）。'
      + '开推理档位的模型要先吐完推理才出正文，实测首正文可能要等近两分钟，'
      + '所以档位越高越该给足时间。',
  };
}
