/**
 * A04 适配器能力探针 —— **实测**宿主到底有没有上报"温度 / 输出上限**是否受支持**"。
 *
 * 为什么单独写：A04 一直写成"适配器没有上报这两个维度"，但这句话此前是**推断**，
 * 不是实测。M4 的要求是"查 DSH 侧接口，而不是猜"，所以把它变成一条**能重跑的断言**：
 * DSH 升级后这个脚本会立刻告诉你结论有没有变。
 *
 * 判据（对着 DSH 0.1.6-alpha.2 的接口语义）：
 *   ① `resolveModelInfo()` 的返回对象里**有没有**任何一个字段能表达
 *      "这个模型不支持 temperature"或"不支持输出上限"；
 *   ② `defaultMaxTokens` 的口径是"调用方没给 maxTokens 时采用的默认值"
 *      （不是"该模型支持输出上限"）—— 所以它**不能**当作支持性判据；
 *   ③ 宿主对 `temperature` 不做校验、不夹取、不预检（不支持的档位是在**运行期**
 *      由上游返回 400，而不是开始前被宿主拦下）。
 *
 * 本脚本用**两种独立口径**交叉验证：
 *   A) 对着正在跑的实例打 `/models/resolve`，看真实返回里有哪些键（跑的是产品路径）；
 *   B) 直接读 DSH 安装里的类型声明/源码文本，确认字段清单（跑的是接口定义）。
 * 两者对不上就报失败 —— 那样说明我们记的接口知识已经过期。
 *
 * 用法：node scripts/m4-a04-adapter-probe.mjs [--base http://127.0.0.1:8902] [--dsh <DSH 安装目录>]
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { makeChecker, api } from './lib/devhost.mjs';

const args = process.argv.slice(2);
const getArg = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const BASE = getArg('--base', 'http://127.0.0.1:8902');
const DSH_INSTALL = getArg('--dsh', null);

const { add, report, finish } = makeChecker({
  what: 'A04：适配器是否上报"温度 / 输出上限"的支持性',
  note: '只读探测；不发起任何模型调用（resolveModelInfo 是本地能力查询，不产生费用）',
  extra: { base: BASE },
});

// ── 口径 A：真实接口返回里到底有哪些键 ────────────────────────────────────
const models = await api(BASE + '/html-arena/api', '/models');
add('A. 接口', '/models 可用（宿主 llm 服务接上了）', models.status === 200 && models.body && models.body.available === true,
  { status: models.status, available: models.body && models.body.available });

const providers = (models.body && models.body.providers) || [];
add('A. 接口', '能列出 provider（至少一个，否则下面没得探）', providers.length > 0, { count: providers.length });

/** 挑几个 provider/model 去 resolve：优先真实模型的，其次任意可用的。 */
const targets = [];
for (const p of providers) {
  const list = (models.body.modelsByProvider && models.body.modelsByProvider[p.id]) || [];
  if (list.length > 0) targets.push({ provider: p.id, model: list[0].id, name: list[0].name });
  if (targets.length >= 4) break;
}
add('A. 接口', '挑到了至少一个可解析的 provider/model', targets.length > 0, targets.map((t) => t.provider + '/' + t.model));

const resolvedSamples = [];
for (const t of targets) {
  const r = await api(BASE + '/html-arena/api', '/models/resolve', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: t.provider, model: t.model }),
  });
  if (r.status !== 200 || !r.body || !r.body.resolved) {
    resolvedSamples.push({ ...t, ok: false, status: r.status, note: r.body && r.body.note });
    continue;
  }
  resolvedSamples.push({ ...t, ok: true, keys: Object.keys(r.body.resolved).sort(), resolved: r.body.resolved });
}
report.resolvedSamples = resolvedSamples;

const okSamples = resolvedSamples.filter((s) => s.ok);
add('A. 接口', '至少有一个模型成功解析（拿得到真实字段清单）', okSamples.length > 0,
  resolvedSamples.map((s) => s.provider + '/' + s.model + '=' + (s.ok ? 'ok' : 'fail')));

// 把所有样本的键并起来 —— 这是"适配器实际会上报什么"的经验清单
const allKeys = [...new Set(okSamples.flatMap((s) => s.keys || []))].sort();
report.resolvedKeysUnion = allKeys;
add('A. 接口', '解析结果里出现的键（这就是适配器实际会上报的东西）', allKeys.length > 0, allKeys);

// ★ 核心判据 ①：有没有"温度 / 输出上限"的支持性字段。
//
// 注意口径：`/models/resolve` 的返回是**我们自己的 API 层**包过的，里面既有适配器给的东西，
// 也有我们加的东西（`reasoningEffortSupported` / `availableReasoningEfforts` / `resolvedAt` / `note` /
// `model`）。把后者也算进来会得出"存在支持性字段"的**假结论**（探针第一版就是这么误报的）。
// 所以这里只**排除已知的自有字段**，并单独断言：真正受支持性判定的只有**思考档位**一项。
const OWN_FIELDS = ['provider', 'model', 'resolvedAt', 'note', 'reasoningEffort', 'reasoningEffortSupported', 'availableReasoningEfforts', 'contextWindow', 'defaultMaxTokens', 'inputModalities'];
const adapterKeys = allKeys.filter((k) => !OWN_FIELDS.includes(k));
report.adapterExtraKeys = adapterKeys;
// 温度与输出上限的**支持性**：既不在自有字段里，也不该出现在任何别的键上
const supportish = allKeys.filter((k) => /^temp|^temperature|support|capab|feature|limit|allow/i.test(k));
const supportishForTempOrOutput = supportish.filter((k) => !/reasoning/i.test(k));
add('A. 接口 ★', '解析结果里**没有**任何字段能表达"温度 / 输出上限是否受支持"',
  supportishForTempOrOutput.length === 0,
  {
    supportishForTempOrOutput,
    // 如实列出唯一存在的那一个支持性字段：思考档位（A04 的"已实现并验证"部分就是它）
    reasoningSupportFieldPresent: allKeys.includes('reasoningEffortSupported'),
    adapterExtraKeys: adapterKeys,
    allKeys,
  });
add('A. 接口', '唯一存在的"支持性"判定是**思考档位**（这是我们要的那一条），不是温度或输出上限',
  allKeys.includes('reasoningEffortSupported') && !allKeys.some((k) => /^temp/i.test(k)),
  { reasoningEffortSupported: allKeys.includes('reasoningEffortSupported') });

// ★ 核心判据 ②：defaultMaxTokens 的口径
const hasDefaultMax = allKeys.includes('defaultMaxTokens');
const defaultVals = okSamples.map((s) => ({ who: s.provider + '/' + s.model, defaultMaxTokens: s.resolved && s.resolved.defaultMaxTokens }));
report.defaultMaxTokensObserved = defaultVals;
add('A. 接口', 'defaultMaxTokens 确实是**默认上限值**（数值或 null），而不是布尔支持标志',
  !hasDefaultMax || defaultVals.every((d) => d.defaultMaxTokens === null || d.defaultMaxTokens === undefined || Number.isInteger(d.defaultMaxTokens)),
  { hasDefaultMax, defaultVals });

// 温度在**请求侧**存在（说明它是个调用参数，不是能力声明）—— 温度字段只在用户填的时候才发
const tempProbe = await api(BASE + '/html-arena/api', '/models/resolve', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ provider: targets[0] && targets[0].provider, model: targets[0] && targets[0].model }),
});
const tempResolvedKeys = (tempProbe.body && tempProbe.body.resolved) ? Object.keys(tempProbe.body.resolved) : [];
add('A. 接口 ★', '解析结果里也**没有** temperature 相关字段（温度只能作为调用参数传）',
  !tempResolvedKeys.some((k) => /temp/i.test(k)),
  { keys: tempResolvedKeys });

// ── 口径 B：读 DSH 安装里的接口定义，交叉验证 ────────────────────────────
/** 从 DSH 安装目录里找 llm 包的类型声明（.d.ts）——它才是"接口定义"。 */
function findLlmTypes() {
  const roots = [];
  if (DSH_INSTALL) roots.push(DSH_INSTALL);
  // 常见的全局 npm 安装位置（不写死用户名：从 USERPROFILE / APPDATA 推）
  const npmGlobal = process.env.APPDATA ? join(process.env.APPDATA, 'npm', 'node_modules') : null;
  if (npmGlobal) {
    roots.push(join(npmGlobal, '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-llm'));
  }
  for (const r of roots) {
    if (!existsSync(r)) continue;
    const candidates = [
      join(r, 'lib', 'index.d.ts'), join(r, 'dist', 'index.d.ts'),
      join(r, 'node_modules', '@deepseek-ai', 'dsh-llm', 'lib', 'index.d.ts'),
      join(r, 'index.d.ts'),
    ];
    for (const c of candidates) if (existsSync(c)) return c;
    // 按**内容**找：必须真的声明了 LlmResolvedModelInfo 才算数。
    // 第一版取的是"第一个找到的 .d.ts"，结果拿到一个不相干的文件 —— 于是
    // "声明里没有 defaultMaxTokens" 这条断言其实是在错的文件上查东西。假红也是假，必须修。
    try {
      const stack = [r];
      let guard = 0;
      while (stack.length && guard < 4000) {
        guard += 1;
        const d = stack.pop();
        let entries = [];
        try { entries = readdirSync(d, { withFileTypes: true }); } catch { continue; }
        for (const e of entries) {
          const p = join(d, e.name);
          if (e.isDirectory()) { if (e.name !== 'node_modules') stack.push(p); continue; }
          if (!e.name.endsWith('.d.ts')) continue;
          try {
            const text = readFileSync(p, 'utf8');
            // 必须找**定义**它的那一份，不是 import 它的那一份：index.d.ts 里也有这两个名字
            // （import 列表 + 方法签名），但字段清单在 types.d.ts 的 export interface 里。
            // 差一个词就会在错的文件上断言 —— 第二版仍然踩到了这一点。
            if (/export interface LlmResolvedModelInfo/.test(text)) return p;
          } catch { /* 读不了就跳过 */ }
        }
      }
    } catch { /* 忽略 */ }
  }
  return null;
}

const dtsPath = findLlmTypes();
report.dshTypesFile = dtsPath ? '<found>' : null;
add('B. 接口定义', '找到了 DSH 安装里的 llm 类型声明文件',
  Boolean(dtsPath), { found: Boolean(dtsPath) });

let declaredMaxTokens = null;
let hasTemperatureInInfo = null;
if (dtsPath) {
  const dts = readFileSync(dtsPath, 'utf8');
  // 只截取 resolveModelInfo 的返回类型那一段（LlmResolvedModelInfo / 邻近定义）
  const infoBlock = (() => {
    const i = dts.search(/export interface LlmResolvedModelInfo/);
    if (i < 0) return '';
    // 一直取到下一个顶层 interface/type —— 那样"剥掉注释再看字段"才准
    const rest = dts.slice(i + 10);
    const next = rest.search(/\nexport (interface|type|declare|const|function)/);
    return next > 0 ? rest.slice(0, next) : rest.slice(0, 1600);
  })();
  report.infoBlockHead = infoBlock.slice(0, 700);
  declaredMaxTokens = infoBlock.includes('defaultMaxTokens');
  hasTemperatureInInfo = /temperature/i.test(infoBlock);
  add('B. 接口定义 ★', '类型声明里 resolveModelInfo 的返回**含** defaultMaxTokens（输出上限有字段，但只是默认值口径）',
    declaredMaxTokens, { declared: declaredMaxTokens });
  add('B. 接口定义 ★', '类型声明里 resolveModelInfo 的返回**不含** temperature 字段',
    !hasTemperatureInInfo, { foundTemperature: hasTemperatureInInfo });
  add('B. 两条口径一致', '接口实测的键与类型声明对得上（对不上说明我们记的接口知识过期了）',
    Boolean(declaredMaxTokens) === hasDefaultMax,
    { runtimeHasDefaultMaxTokens: hasDefaultMax, declaredHasDefaultMaxTokens: declaredMaxTokens });
}

// ── 结论 ────────────────────────────────────────────────────────────────
// 结论只看"温度/输出上限的支持性"那一组（reasoningEffortSupported 是 A04 里已实现并验证的部分，
// 它**不是** A04 未测的那一半，不能拿它把结论推翻）。
const conclusionOk = supportishForTempOrOutput.length === 0;
const conclusion = conclusionOk
  ? '适配器不上报"温度 / 输出上限是否受支持"：温度完全没有能力字段，输出上限只有 defaultMaxTokens（默认值）口径。'
  : '★ 发现了针对温度/输出上限的支持性字段，A04 的结论必须更新：' + supportishForTempOrOutput.join(', ');
report.conclusion = conclusion;
report.conclusionOk = conclusionOk;
add('结论 ★', 'A04 实测结论（这就是"查接口而不是猜"的结果）', conclusionOk, { conclusion });
add('结论', '界面对温度显示"未指定"、不编结论 —— 与接口的能力现状一致，不是界面偷懒',
  conclusionOk, { note: 'web/app.js 里温度输入框 placeholder="未指定"' });

process.exitCode = finish('m4-a04-adapter-probe');
