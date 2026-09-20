/**
 * DSH 后端插件：把 configstudio 的模拟 LLM 注册成 provider route（**零费用、不联网**）。
 *
 * 它只在**验证**时用 `dsh --patch` 挂进一个独立 profile —— 这样可以在一个
 * "装的是交付 tgz"的真实 DSH 里走完整的「生成 → 对比」路径，而不花一分钱模型费。
 *
 * 与 scripts/simulated-llm.mjs 的分工：那份是**模拟实现**（四个方法），这份只做**适配**：
 * 把它包装成 DSH 的 LlmAdapter 注册进去。模拟逻辑一份都没有抄过来。
 *
 * 挂载：dsh --profile <name> --patch <本文件同级>/sim-llm.overlay.yml
 *
 * 两个必须做的适配（依据 DSH 0.1.6-alpha.2 源码核查，见 docs/dsh-integration.md）：
 *  1. `LlmReasoningEffortInfo.name` 是**必填**的（llm/src/types.ts:357-364，
 *     服务在 llm/src/index.ts:820-822 校验 name 非空），而模拟实现只给了 `{ id: 'low' }`。
 *     不补 name，`/models/resolve` 只会显示"无法解析"（容易被忽略），
 *     但生成时 normalizeModelInfo 会在派发路径上抛错 → 永远是 failed，出不来 HTML。
 *  2. 未注册的 provider 要抛 LlmError（而不是裸 Error），否则出错时与服务自己的
 *     NO_ADAPTER 混在一起，排查时分不清是谁拒的。
 */
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, isAbsolute } from 'node:path';

export const name = 'dsh-external/configstudio-sim-llm';
export const inject = ['llm'];

/** 模拟实现的默认位置：仓库里 configstudio/scripts/simulated-llm.mjs（可被 config.mockPath 覆盖）。 */
const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_MOCK_PATH = join(HERE, '..', 'simulated-llm.mjs');

export function apply(ctx, config = {}) {
  const mockPath = typeof config.mockPath === 'string' && config.mockPath.length > 0
    ? config.mockPath
    : DEFAULT_MOCK_PATH;
  const latencyMs = Number.isInteger(config.latencyMs) ? config.latencyMs : 20;
  const callLog = typeof config.callLog === 'string' && config.callLog.length > 0 ? config.callLog : null;

  const require = createRequire(import.meta.url);
  const { LlmAdapter, LlmError } = require('@deepseek-ai/dsh-llm');
  // require 要的是**路径**不是 URL：传 file:// 进来会变成 "Cannot find module 'file:///...'"（实测踩过）。
  // 绝对 Windows 路径（D:\...）直接交给 require 就行；包名也原样交给它。
  const mockSpecifier = isAbsolute(mockPath) ? mockPath : mockPath;
  const { makeSimulatedLlm, SIMULATED_PROVIDERS } = require(mockSpecifier);

  const llm = ctx.get('llm');
  if (!llm) throw new Error('configstudio-sim-llm：组合树里没有 llm 服务（需要 @deepseek-ai/dsh-llm）');

  const sim = makeSimulatedLlm({ latencyMs, callLog });
  const infoOf = new Map(SIMULATED_PROVIDERS.map((p) => [p.id, p]));
  const providerIds = SIMULATED_PROVIDERS.map((p) => p.id);

  class SimulatedAdapter extends LlmAdapter {
    providerInfo(provider) {
      const hit = infoOf.get(provider);
      return hit ? { id: hit.id, name: hit.name } : { id: provider, name: provider };
    }

    listModels(provider) {
      if (!infoOf.has(provider)) {
        throw new LlmError('configstudio-sim-llm：没有这个模拟来源 "' + provider + '"', 'NO_ADAPTER');
      }
      return sim.listModels(provider);
    }

    async resolveModel(provider, model) {
      let raw;
      try {
        raw = await sim.resolveModelInfo(provider, model);
      } catch {
        throw new LlmError('configstudio-sim-llm：没有这个模拟来源 "' + provider + '"', 'NO_ADAPTER');
      }
      const out = { provider, id: model, name: raw.name };
      if (raw.inputModalities) out.inputModalities = raw.inputModalities;
      if (raw.context) out.context = raw.context;
      if (Number.isInteger(raw.defaultMaxTokens)) out.defaultMaxTokens = raw.defaultMaxTokens;
      // 适配 1：efforts 的 name 是必填的，模拟实现只给了 id —— 不补会让生成 100% 失败。
      if (raw.reasoning) {
        out.reasoning = { efforts: raw.reasoning.efforts.map((e) => ({ id: e.id, name: e.name || e.id })) };
        if (raw.reasoning.defaultEffort) out.reasoning.defaultEffort = raw.reasoning.defaultEffort;
      }
      return out;
    }

    stream(options) {
      return sim.stream(options);
    }
  }

  const handle = llm.registerAdapter(providerIds, new SimulatedAdapter());
  console.info('[configstudio-sim-llm] 已注册 ' + providerIds.length + ' 个模拟来源：' + providerIds.join(', ')
    + '（零费用，不会联网）');

  ctx.on('dispose', () => { try { handle(); } catch { /* fiber 已释放 */ } });
}
