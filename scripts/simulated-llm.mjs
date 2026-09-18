/**
 * 模拟模型 —— 用于开发与测试，**零费用**，所有产物必须明确标记为模拟结果。
 *
 * 它模拟三种真实行为，方便稳定复现边界：
 *  - 正常返回一个完整的单文件 HTML（按题目关键词换不同样例）
 *  - 按需返回多个 HTML 块（验证"多块要用户选择"）
 *  - 按需返回 provider 错误 / 无 HTML / 截断
 *
 * 通过 provider id 选择行为：sim-ok / sim-multi / sim-fail / sim-empty / sim-truncate
 *
 * 另外两类用于 M2 的取消/超时验证（A08/A09）：
 *  - sim-slow：慢慢吐很长的正文，**遵守中止信号**（真实适配器的行为）——
 *    用它可以在零费用下触发"运行上限到了"的真实超时路径；
 *  - sim-ignore-abort：故意**忽略**中止信号继续吐（带唯一标记），
 *    用来验证"已经被中止/超时的那次尝试，迟到的输出不会写进新 attempt"。
 *
 * 传 callLog（文件路径）时，每次 stream() 调用追加一行 JSON ——
 * 这样"重启后没有自动重新调用模型"就有跨进程的、可核对的证据（A09 不自动重付费）。
 */
import { SAMPLES } from './samples.mjs';
import { appendFileSync } from 'node:fs';

const NL = String.fromCharCode(10);
const F = String.fromCharCode(96);
const FENCE = F + F + F;

/** 模拟的 provider 目录。名字里带"模拟"，避免和真实 provider 混淆。 */
export const SIMULATED_PROVIDERS = [
  { id: 'sim-ok-a', name: '【模拟】普通模型 A' },
  { id: 'sim-ok-b', name: '【模拟】普通模型 B' },
  { id: 'sim-multi', name: '【模拟】多块输出' },
  { id: 'sim-fail', name: '【模拟】鉴权失败' },
  { id: 'sim-empty', name: '【模拟】无 HTML' },
  { id: 'sim-truncate', name: '【模拟】输出截断' },
  { id: 'sim-reasoning', name: '【模拟】先推理再输出' },
  { id: 'sim-slow', name: '【模拟】慢速长输出（遵守中止）' },
  { id: 'sim-ignore-abort', name: '【模拟】忽略中止（用于验证迟到输出不污染）' },
];

const BEHAVIOR = {
  'sim-ok-a': { kind: 'ok', sample: 'dashboard' },
  'sim-ok-b': { kind: 'ok', sample: 'landing' },
  'sim-multi': { kind: 'multi' },
  'sim-fail': { kind: 'fail' },
  'sim-empty': { kind: 'empty' },
  'sim-truncate': { kind: 'truncate' },
  'sim-reasoning': { kind: 'reasoning', sample: 'dashboard' },
  'sim-slow': { kind: 'slow' },
  'sim-ignore-abort': { kind: 'late' },
};

const MODEL_IDS = {
  'sim-ok-a': ['sim-fast', 'sim-pro'],
  'sim-ok-b': ['sim-fast', 'sim-pro'],
  'sim-multi': ['sim-fast'],
  'sim-fail': ['sim-fast'],
  'sim-empty': ['sim-fast'],
  'sim-truncate': ['sim-fast'],
  'sim-reasoning': ['sim-think'],
  'sim-slow': ['sim-slow-1'],
  'sim-ignore-abort': ['sim-late-1'],
};

export function makeSimulatedLlm({ latencyMs = 900, callLog = null } = {}) {
  return {
    listProviders: () => SIMULATED_PROVIDERS.map((p) => ({ ...p })),
    async listModels(provider) {
      const ids = MODEL_IDS[provider];
      if (!ids) throw Object.assign(new Error('no adapter for ' + provider), { code: 'NO_ADAPTER' });
      return ids.map((id) => ({ provider, id, name: id + '（模拟）' }));
    },
    async resolveModelInfo(provider, model) {
      if (!MODEL_IDS[provider]) throw Object.assign(new Error('no adapter for ' + provider), { code: 'NO_ADAPTER' });
      return {
        provider, id: model, name: model,
        context: { contextWindow: 128000 },
        defaultMaxTokens: 16384,
        reasoning: { efforts: [{ id: 'low' }, { id: 'high' }], defaultEffort: 'low' },
        inputModalities: ['text'],
      };
    },
    stream(options) {
      const b = BEHAVIOR[options.provider] ?? { kind: 'ok', sample: 'dashboard' };
      const delay = latencyMs;
      const signal = options.signal;
      const aborted = () => Boolean(signal && signal.aborted);
      // 只有 sim-ignore-abort 故意不理会中止；其余按真实适配器的行为尽快收尾。
      const ignoreAbort = b.kind === 'late';
      if (callLog) {
        try {
          appendFileSync(callLog, JSON.stringify({
            at: Date.now(), pid: process.pid, provider: options.provider, model: options.model,
            messages: Array.isArray(options.messages) ? options.messages.length : null,
          }) + String.fromCharCode(10));
        } catch { /* 记不上日志不影响生成 */ }
      }
      return (async function* () {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const abortFinish = () => ({
          type: 'finish',
          reason: { kind: 'aborted', failure: { code: 'ABORTED', message: '模拟：收到中止信号（尽力中止）' } },
        });
        await sleep(delay);
        if (!ignoreAbort && aborted()) { yield abortFinish(); return; }
        if (b.kind === 'fail') {
          yield { type: 'finish', reason: { kind: 'error', failure: { code: 'AUTH', message: 'simulated: invalid api key', status: 401 } } };
          return;
        }
        // 推理型模型：先流式吐推理，再吐正文。真实界面上"推理过程"折叠块就是这样出现的，
        // 反馈 2（点开不到 1 秒被收回）必须能被零费用复现，所以模拟模型要覆盖这条路径。
        if (b.kind === 'reasoning') {
          const think = '先想清楚要做成什么样：' + NL
            + '1) 题目要一个可交互的单文件页面，不能有外部依赖。' + NL
            + '2) 布局用弹性盒子，窄屏要能退化成一列。' + NL
            + '3) 数据用内置示例，避免联网。' + NL
            + '4) 最后写完整的 HTML，放在一个代码块里返回。' + NL;
          const CH = 48;
          for (let i = 0; i < think.length; i += CH) {
            yield { type: 'reasoning-delta', index: 1, text: think.slice(i, i + CH) };
            await sleep(6);
          }
        }

        // 慢速长输出：正文很长、每块之间间隔明显，足够触发运行上限（A08 的超时路径）
        if (b.kind === 'slow') {
          const long = '这是模拟模型的说明（慢速长输出，用于验证运行上限）。' + NL + NL + FENCE + 'html' + NL
            + SAMPLES.dashboard + NL + FENCE + NL + '<!-- 填充：' + 'x'.repeat(4000) + ' -->' + NL;
          const CH = 64;
          for (let i = 0; i < long.length; i += CH) {
            if (!ignoreAbort && aborted()) { yield abortFinish(); return; }
            yield { type: 'text-delta', index: 0, text: long.slice(i, i + CH) };
            await sleep(120);
          }
          yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 2000, totalTokens: 2100 } };
          yield { type: 'finish', reason: { kind: 'stop' } };
          return;
        }
        // 忽略中止：中止之后继续吐带标记的迟到内容（验证它不会跑进新 attempt）
        if (b.kind === 'late') {
          const LATE_MARKER = 'LATE-OUTPUT-OF-ATTEMPT-ONE';
          // 故意很长：超时之后它还要吐十几秒，"已到运行上限、正在尽力中止"这个中间态
          // 才有足够宽的窗口被真实浏览器观察到（A08 的界面断言需要它）。
          const text2 = '这是模拟模型的说明（忽略中止）。' + NL + NL + FENCE + 'html' + NL
            + (SAMPLES.landing + NL).repeat(4) + FENCE + NL + LATE_MARKER + NL;
          const CH2 = 64;
          for (let i = 0; i < text2.length; i += CH2) {
            yield { type: 'text-delta', index: 0, text: text2.slice(i, i + CH2) };
            await sleep(150);
          }
          yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 } };
          yield { type: 'finish', reason: { kind: 'stop' } };
          return;
        }

        let text;
        if (b.kind === 'ok' || b.kind === 'reasoning') text = '这是模拟模型的说明。' + NL + NL + FENCE + 'html' + NL + SAMPLES[b.sample] + NL + FENCE + NL;
        else if (b.kind === 'multi') {
          text = '我做了两个版本：' + NL + NL + FENCE + 'html' + NL + SAMPLES.landing + NL + FENCE + NL + NL
            + '另一个思路：' + NL + NL + FENCE + 'html' + NL + SAMPLES.dashboard + NL + FENCE + NL;
        } else if (b.kind === 'empty') text = '抱歉，我无法完成这个请求。';
        else if (b.kind === 'truncate') text = FENCE + 'html' + NL + SAMPLES.dashboard.slice(0, Math.floor(SAMPLES.dashboard.length * 0.4));

        const CHUNK = 64;
        for (let i = 0; i < text.length; i += CHUNK) {
          if (!ignoreAbort && aborted()) { yield abortFinish(); return; }
          yield { type: 'text-delta', index: 0, text: text.slice(i, i + CHUNK) };
          await sleep(6);
        }
        if (b.kind === 'truncate') {
          yield { type: 'finish', reason: { kind: 'max-tokens' } };
        } else if (b.kind === 'empty') {
          yield { type: 'usage', usage: { inputTokens: 42, outputTokens: 12, totalTokens: 54 } };
          yield { type: 'finish', reason: { kind: 'stop' } };
        } else {
          if (options.provider === 'sim-ok-b') {
            // 故意不报 usage，用来验证"未上报"显示（A18）
            yield { type: 'finish', reason: { kind: 'stop' } };
          } else {
            yield { type: 'usage', usage: { inputTokens: 1280, outputTokens: 4096, totalTokens: 5376, cacheReadTokens: 512, reasoningTokens: 300 } };
            yield { type: 'finish', reason: { kind: 'stop' } };
          }
        }
      })();
    },
  };
}
