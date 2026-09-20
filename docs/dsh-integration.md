# DSH 集成核查记录（M0）

核查日期：2026-09-18
核查对象：本机安装的 DSH 0.1.6-alpha.2（用户 AppData 下的 npm 全局安装）
源码依据：DSH checkout（同一版本 0.1.6-alpha.2，与安装包一致）

本文记录**实际验证过的接口**与**实测踩到的坑**。所有结论都来自源码阅读 + 在本机真实 DSH 里跑通，
不是推测。DSH 升级后，先复核本文第 4 节的清单。

---

## 1 插件形态

本插件是一个**外部 cordis bundle 包**，同时提供宿主半边与浏览器半边，
形态与已在本机可用的 `dsh-external/dsh-prompt-optimizer` 一致。

```json
{
  "name": "@dsh-external/configstudio",
  "main": "./src/index.js",
  "exports": {
    ".":        { "default": "./src/index.js" },
    "./client": { "default": "./src/client.js" }
  },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "platform": "web", "inject": ["@deepseek-ai/dsh-client-ui-slots"] }
  }
}
```

- 宿主半边：`cordis.patch.yml` 里一条 `insert`，把 `'@dsh-external/configstudio'` 插进根条目表。
- 浏览器半边：DSH 的 `client-modules` 扫描声明了 `dsh.client` 的包，通过
  `window.__ModuleLoader__.load({id, factory})` 在浏览器里加载 `exports["./client"]`。
  **声明了 `dsh.client` 但没有 `exports["./client"]` 会在启动时抛错**。

### 安装（已实测）

```powershell
dsh plugin --profile <profile> add <本目录绝对路径>
```

一条命令同时完成三件事（不需要手工编辑 profile）：
1. 在 profile 里加 `link:` 依赖；
2. 因为本包声明了 `dsh.bundle`，自动把包名追加进 `dsh.profile.bundles`；
3. 下一次启动时加载它的 patch 层。

卸载：`dsh plugin --profile <profile> remove '@dsh-external/configstudio'` —— 会同时移除依赖与
bundles 条目（实测 `--dump-config` 里不再出现本插件）。
**卸载不会删除数据目录**（`$DSH_HOME/configstudio`），用户的实验记录不会被静默清掉。

---

## 2 模型调用（F01 / F02 / F03）

### 2.1 取服务：必须用 ctx.get，不能直接读 ctx.llm

**实测踩坑**：真实 DSH 里 `/models` 返回 500 且响应体为空。

Cordis 只允许访问在 `inject` 里声明过的服务。直接写 `ctx.llm` 会抛
`cannot get property "llm" without inject`。而且 `llm` 是可选能力——某些组合不装模型插件，
插件仍应能加载，只是不能生成。

正确写法（见本插件 `src/index.js` 的 `llmOf()`）：

```js
function llmOf(ctx) {
  try { return ctx.get('llm') ?? null; } catch { return null; }
}
```

同理，**不要往 ctx 上挂属性**（例如 `ctx.htmlArena = runtime`）：会抛
`cannot set property "htmlArena" without provide`，导致整个插件树加载失败。
这个错误只在真实 DSH 启动时暴露，本地直接 import 模块发现不了。

### 2.2 单次逻辑请求

```js
const options = { provider, model, messages, signal };
if (system) options.system = system;
if (temperature !== null) options.temperature = temperature;
if (maxTokens !== null) options.maxTokens = maxTokens;
if (reasoningEffort) options.reasoningEffort = reasoningEffort;
// 刻意不设置 tools / sessionId / purpose
for await (const chunk of llm.stream(options)) { /* ... */ }
```

- **不传 `tools`** 即不启用工具循环。注意 Messages 协议下传 `[]` 会写出空 `tools: []`，
  所以"不启用"的正确写法是**完全省略该字段**。
- **不传 `sessionId` / `purpose`**：这是纯辅助调用，避免进入其它插件中间件的匹配面。
- `system` 是给一次性调用者的专用入口，适配器把它放进 provider 的 system 槽。
- **不要 `break` 出 `for await`**：那样流里没有终态 finish，会违反 DSH 开发期 invariant。
  要停就用 `AbortSignal`。

### 2.3 重试：插件直调不会被自动重试

`llm-retry` 只监听 `agent/request-error`，而该事件只由 agent loop 在终态失败后发出。
插件直调 `ctx.llm.stream()` 没有 turn/step，**因此不会被重试**
（官方文档原话：*direct `ctx.llm.stream()` callers remain single-attempt*）。

这对我们是好事：**逻辑请求数 = 网络请求数**，正是 F02 想要的。所以本插件记录
`observedRequests = 1`，并且"重试"一律新建 attempt，绝不复用旧请求。

### 2.4 取消

- `AbortSignal` 会一路传到适配器，适配器 `finally` 里 abort + `iterator.return`，
  **网络请求真的会停**。
- 取消**不抛异常**：得到 `finish { kind: 'aborted', failure: { code: 'ABORTED' } }`。
- 取消后没有"不能重试"的约束。
- 已上报的 usage 与已收到的正文照常保存（实测：取消后 `status=cancelled`、
  `finishReason=aborted`、未上报的 usage 保持 `null`）。

### 2.5 错误：都走 finish，不抛

**最容易踩的坑**：provider 错误（401 / 429 / 5xx / 无凭据 / 无适配器）全部以
`finish { kind: 'error', failure }` **到达**，不会抛异常。只写 `try/catch` 会漏掉**全部**
provider 错误。必须读终态 finish。

```js
if (finish && (finish.kind === 'error' || finish.kind === 'aborted')) {
  const f = finish.failure;   // { message, code, status?, requestId?, providerRetryAfterMs? }
}
```

只有中间件 / 消费者 / 清理失败才会 throw。两种情况本插件都处理了（见 `src/core/runner.js`）。

保存错误时只取白名单字段：`code` / `message`（截断）/ `status` / `requestId` /
`providerRetryAfterMs`。**不要用 `instanceof LlmError` 跨包判断**（会丢 class identity），
也不要解析 message 文本。

### 2.6 用量

`usage` chunk 在 `finish` 之前到达，字段为
`{ inputTokens, outputTokens, totalTokens?, cacheReadTokens?, cacheWriteTokens?, reasoningTokens? }`。
计数是 **DISJOINT**：`inputTokens` 只算未命中缓存的输入，**不要把它们相加**。
缺失字段一律保存为 `null`，界面显示"未上报"（F18 / A18）。

### 2.7 凭据

`GenerateOptions` 里**没有**任何 key / 凭据字段。适配器在每次请求时自己解析凭据引用
（DeepSeek 默认 `DEEPSEEK_API_KEY`）。插件只提供 `provider` + `model`，
不读、不复制、不保存明文凭据（F01）。

`reasoningEffort` 用错会 `UNSUPPORTED_REASONING_EFFORT`，所以开始前必须核对
`resolveModelInfo()` 的 `reasoning.efforts`；不上报时界面显示"未确认"，不猜（F04 / A04）。

### 2.8 实测记录（真实调用）

| 项 | 结果 |
| --- | --- |
| provider 目录 | 9 个（deepseek-official / opencode-go / deepseek / xkiro / atria / openrouter / wb / ccg / other-free） |
| 模型数 | 52 个，0 个读取错误 |
| 真实调用（deepseek-official / deepseek-flash，maxTokens 16384） | `completed`，`finish=stop`，1.2 s，输入 70 / 输出 305，提取成功（fenced） |
| 首事件 / 首正文延迟 | 均 0.35 s |
| 取消（3 s 后中止） | `cancelled`，`finish=aborted`，未上报 usage 保持 `null` |

---

## 3 界面承载

DSH 支持三条给外部包贡献 UI 的路径，本插件选了最抗版本破坏的组合：

| 路径 | 说明 | 本插件是否使用 |
| --- | --- | --- |
| `ctx.webServer.register` | 插件在自己的进程里注册 DSH 同端口 HTTP 路由 | **用**：`/configstudio/api/*` |
| `dsh.client` + `exports["./client"]` | 运行时装浏览器半边，可注册插槽 | **用**：注册 `main` 整页 + `sidebar.panellist` 入口 |
| `host/open-in-app` | 只能拉起本机 exe 打开目录 | 不用（做不到自定义页面） |

**关键取舍**：DSH 不替外部包构建前端产物，平台模块表白名单是冻结的（只有 `react` /
`react-dom` / `cordis` / `client-store` / `ui-slots` / `ui-primitives` / `ui-dockkit`）。
因此：

- 浏览器半边（`src/client.js`，手写闭包工厂）只 `require('react')`，并且只声明
  `inject: ['slots']`。它**不依赖** `dsh.client.inject` 的到达顺序（那个只做工厂到达顺序，
  不保证 `require` 可用，不在图里的会被静默跳过）。
- **整页本体是我们自己路由吐的普通 HTML/JS/CSS**（`web/` 目录），用 iframe 嵌进 `main` 插槽。
  这样 DSH 侧唯一的耦合点是"一个 iframe 入口"，DSH 前端升级最多影响入口，
  不影响页面内部实现。

### 实测：在真实 DSH 里渲染成功

| 项 | 结果 |
| --- | --- |
| DSH 启动 | `dsh --profile arena-test --port 8901` 正常 |
| API 路由（同端口、同源） | `/configstudio/api/meta` 200，`dshVersion=0.1.6-alpha.2` |
| 界面资源 | `/configstudio/api/ui` 200（8017 字节）、`app.js` 200 |
| 浏览器半边 | `__DSH_BOOT__` 含 configstudio；`window.__HTML_ARENA_ACTIVE__` 已设置 |
| 侧栏入口 | 出现「配置对比」 |
| 点击入口 | 出现 iframe，`src=/configstudio/api/ui` |
| 控制台 | `[configstudio] 就绪：预览源 ...，浏览器能力 可用`，**0 个错误、0 个异常** |

### 命令形式（踩坑）

```powershell
dsh --profile arena-test --port 8901 --no-open   # 正确
dsh web --profile arena-test ...                 # 错：web 已隐含 profile，会报 "select a profile only once"
dsh --profile arena-test web ...                 # 错：参数位置不对，会报 "too many arguments"
```

DSH Web 需要 `?token=...`（启动时打印在 stdout），没有 token 会返回
`dsh web authentication required`。插件自己的 API 路由不走这个 token（它有自己的本机校验）。

---

## 4 升级 DSH 时优先复核的清单

以下是**当前实测有效但不在 semver 保证内**的契约：

1. `ctx.get('llm')` 与 `llm.stream(options)` 的字段集（`GenerateOptions`）。
2. 错误仍以 `finish { kind: 'error' | 'aborted', failure }` 到达，而不是抛异常。
3. `ctx.webServer.register({ kind: 'prefix', path, handler })` 的签名。
4. `window.__ModuleLoader__.load({ id, factory })` 与 `dsh.client.platform = 'web'`。
5. `main` / `sidebar.panellist` 插槽仍然存在，且 `register` 签名不变。
6. 平台模块白名单是否新增/改名（影响 `src/client.js` 里允许 `require` 的模块）。

复核方式：`node scripts/dsh-contract-check.mjs`（本目录），只做只读探测，
不发模型调用、不产生费用。
