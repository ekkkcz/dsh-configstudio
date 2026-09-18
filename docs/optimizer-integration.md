# 提示词优化器对接记录（M2）

核查日期：2026-09-18
核查对象：`@dsh-external/dsh-prompt-optimizer` 0.4.5-beta.2（用户 web profile 里已装）
核查方式：只读源码阅读 + **真实调用实测**（不是推测）

本文记录"HTML Arena 如何与它协作"。我们**不修改它一个字节**。

---

## 1 为什么是 HTTP 而不是 ctx.get()

只读核查（含源码级确认）结论：

| 问题 | 结论 |
| --- | --- |
| 它有没有 `ctx.provide` 服务？ | **没有**。`lib/index.js` 只有 3 个模块级导出：`name` / `inject` / `apply`。全文 grep `provide` 命中 0。 |
| 它有没有导出可 import 的优化函数？ | **没有**。宿主半边没有任何 `optimizePrompt()` 之类的导出。 |
| 那它有什么可编程入口？ | 注册在同一个 DSH webServer 上的 prefix 路由 `/prompt-optimizer/api/*`。这是**唯一**入口。 |
| 许可证 | **BSD-3-Clause**，标准三条款，无附加限制。我们只是调用它的 HTTP 接口，连版权声明都不涉及再分发。 |

所以对接方式定为：**我们的宿主半边在生成前，把题目 POST 给它自己的 API，拿回优化稿**。

### 为什么不用配端口

插件与它跑在**同一个 DSH 进程、同一个 webServer** 上。
我们从进来的请求自己的 `Host` 头推导基地址（`baseUrlFromRequest()`），
因此不需要用户配置任何端口，也避免把题目发到别的机器 —— 只接受回环主机名。

---

## 2 实测确认的调用契约

```text
探活：GET  <base>/prompt-optimizer/api/models
      → { ok, current:{provider,model,reasoningEffort}, groups:[{id,models[]}] }

发起：POST <base>/prompt-optimizer/api/run
      body { request, tier, provider?, model? }
      → { ok:true, runId:'run2', tier:'basic', forceError:false }

取结果：GET <base>/prompt-optimizer/api/stream?runId=<id>   (text/event-stream)

取消：POST <base>/prompt-optimizer/api/run/abort  { runId }
```

**认证**：实测**不需要 token / CSRF**（核查时列为"未验证前提"，现已验证：从插件宿主半边
直接 fetch 它自己的回环地址返回 200）。它依赖 DSH webServer 自己的信任栅栏。

**档位**：只有 `basic` / `advanced` / `extreme`。`'off'` 只是它客户端的概念，
传下去会**静默落到 basic** —— 不要传。

---

## 3 实测踩到的两个坑

### 3.1 事件类型在 JSON 载荷里，不在 SSE 的 `event:` 行

我第一版按标准 SSE 写，读 `event:` 行判断类型，结果**一个事件都没匹配上**，
优化永远返回空文本。真实流长这样：

```text
data: {"type":"snapshot","status":"running","reasoning":"","text":"","error":null,...}

data: {"type":"usage","text":"{\"inputTokens\":0,\"outputTokens\":0,\"totalTokens\":0}"}

data: {"type":"error","message":"llm-error: {\"message\":\"...\",\"code\":\"QUOTA\"}"}
```

修法：类型取 `data.type`。另外 `usage` 事件把统计放在**字符串化的 `text` 字段**里，
不是对象，需要再 JSON.parse 一次。

### 3.2 它的默认模型可能没有额度

`GET /models` 报它当前用 `wb/deepseek-v4.1-flash`（跟随会话当前模型）。
实测调用直接失败：

```text
{"type":"error","message":"llm-error: {\"message\":\"OpenAI API error (400):
 {\\\"message\\\":\\\"You have insufficient credits to make this request...\\\"}\" ,
 \"code\":\"QUOTA\"}"}
```

**这是上游额度问题，不是两个插件的缺陷。** 但它意味着"开箱即用"不成立。

应对：界面上加了**优化模型下拉**（默认选中它当前用的那个，可改成任意已配置模型），
把选择通过 `provider` / `model` 传参覆盖掉它的默认选择
（优先级：传参 > 它的落盘 state > 会话当前模型 —— 核查确认）。
实测指定 `deepseek-official/deepseek-flash` 后：**7.1 秒返回 1130 字优化稿，输出 1154 tok，成功**。

---

## 4 我们的失败策略：一律 fail-open

优化是**可选步骤**，绝不能因为它拦住主流程：

| 情况 | 行为 |
| --- | --- |
| 没装优化器 | `/optimizer/status` 返回 `available:false`，界面整块隐藏，其它功能不受影响 |
| 它返回 401/403 | 如实报告"要求认证，本插件不代为绕过"，不尝试绕过 |
| 上游报错（如额度不足） | 界面显示**上游原文**与"换个模型再试"，题目保持不变 |
| 流没正常结束（半截稿） | **不采用**半截稿，如实报"没有正常结束"，改回用原文 |
| 超时 | 120 秒上限，超时按失败处理 |
| 优化结果 | **先给用户看**，用户点"替换 / 追加 / 丢弃"才生效 —— 不自动改题目 |

---

## 5 版本风险

该包是 **beta**，且路由注册标签写的是 `'prompt-optimizer: selftest api'` ——
属自检/探针性质的 API，**子路径与字段未承诺向后兼容**。

因此集成层做了能力探测而不是硬依赖：
先 `GET /models` 探活，拿到 `ok:true` 才认为可用；任何一步失败都退回"没有优化功能"的形态。
它升级后如果接口变了，表现是**优化功能自动隐藏**，而不是报错或崩溃。

发现方式：`GET /html-arena/api/optimizer/status`。

---

## 6 相关代码

| 位置 | 作用 |
| --- | --- |
| `src/core/optimizer.js` | 对接实现：探活 / 发起 / SSE 解析 / 取消 / fail-open |
| `src/api.js` 的 `/optimizer/status`、`/optimizer/optimize` | 转发给界面；错误如实返回而不是 500 |
| `src/api.js` 的 `/meta` 的 `optimizer` 字段 | 首帧就知道可不可用，避免按钮闪现 |
| `web/index.html` 的 `#optimizer-box` | 界面：档位、模型选择、优化、替换/追加/丢弃 |
| `web/app.js` 的 `applyOptimizerStatus` / `optimizeTask` | 界面逻辑 |
