# HTML Arena 进度记录

> 本文件是运行状态的权威记录。固定需求见 `方案区/PRD.md`，
> 验收标准见 `方案区/ACCEPTANCE.md`，实际测试证据见 `docs/acceptance.md`。
> 本文不复制需求内容，只记录"现在到哪了、下一步做什么"。

最后更新：2026-09-18（M1 完成）

---

## 当前阶段

**M1 首次可玩版 —— 已完成。**

M1 的目标（IMPLEMENTATION.md）：两候选同题生成 → 原始输出与 HTML 落盘 → 并排预览 →
独立失败与重置 → 简单历史。**已用两个不同的真实模型在真实 DSH 里跑通全流程**（两轮不同的题），
并交出首个试玩包 `交付区/v0.1.0-m1/`。

下一阶段：**M2 核心稳定性**（四候选与排队、取消超时、重启恢复、配方快照与版本、CDN 真实网络）。

---

## 已完成

### 阶段与流程

| 里程碑 | 状态 | 说明 |
| --- | --- | --- |
| M0 接入与边界 | **完成** | DSH 版本已确认；插件在真实 DSH 中安装、加载、渲染、卸载均已实测 |
| M1 首次可玩版 | **完成** | 两个真实模型同题对比跑通；对比页交互与六类样例实测；试玩包已交付 |
| M2 核心稳定性 | 未开始 | 配方版本、四候选排队、重启恢复、盲选已部分实现 |
| M3 复用与分享 | 未开始 | |
| M4 发布准备 | 未开始 | |

### 已打通的纵向流程

同一道题 → 两个候选各自一次**真实**模型调用 → 原始正文与提取出的 HTML 分别落盘 →
并排在同一逻辑视口里操作 → 切视口 / 独立重置 → 隐藏配置身份 → 记录偏好 → 揭晓 → 截图 → 历史列表复现。

M1 用两个真实模型跑了两轮完整的题（番茄钟、待办清单），每轮两候选都成功产出可操作的作品。
模拟模型继续用于队列、失败、多块、无 HTML、截断等边界的稳定复现。

### 关键决定（含理由）

| 决定 | 理由 |
| --- | --- |
| 形态：外部 cordis bundle，宿主半边 + 浏览器半边 | DSH 官方支持这条路径，且本机已有可用实例（dsh-prompt-optimizer）作为参照 |
| 整页用自己路由吐的静态 SPA，DSH 侧只挂一个 iframe 入口 | 外部包没有官方前端构建链，平台模块表白名单冻结。这样 DSH 侧耦合最小 |
| 浏览器半边只 `require('react')`，只 `inject: ['slots']` | `dsh.client.inject` 只保证工厂到达顺序，不保证 `require` 可用 |
| 模型调用用 `ctx.get('llm')` 而非 `ctx.llm` | 直接读会在真实 DSH 里抛错（实测 500）；且 llm 是可选能力 |
| 存储用 `node:sqlite`（Node 内置） | 零原生编译依赖，Windows 上开箱可用（已实测） |
| 预览承载：独立端口服务 + iframe sandbox + 响应头 CSP + postMessage 校验 | 四层组合；不把不同端口当成 cookie 隔离，也不开放 `allow-same-origin` |
| 截图用独立浏览器进程（可硬杀） | F14 要求"独立可终止"，不能只靠同线程超时回调 |
| **M1**：盲选脱敏要在"作品卡头部"和"配置差异折叠面板"两处都做 | 折叠面板只是折叠，点一下就能看见（实测缺陷） |
| **M1**：保存评价后只做最小刷新，不重绘作品区 | 重绘会重建 iframe，把用户在作品里的操作状态全部丢掉 |
| **M1**：揭晓后作品卡直接写出 provider / model | 候选默认名就是 A / B，只显示名字等于没揭晓（实测缺陷） |

### 代码结构

```
html-arena/
├── src/
│   ├── index.js              Cordis 宿主半边：起预览服务、注册 /html-arena/api 路由
│   ├── api.js                HTTP API（实验、生成、预览、下载、投票、截图）
│   ├── ui.js                 界面静态资源路由（按 mtime 重读，改完不用重启）
│   ├── client.js             DSH 浏览器半边（手写 __ModuleLoader__ 闭包工厂）
│   ├── core/
│   │   ├── extract.js        HTML 提取器（纯函数，可单测）
│   │   ├── runner.js         模型调用执行器（单次请求、流式、取消、错误翻译）
│   │   └── store.js          SQLite 索引 + 文件系统大对象
│   └── preview/
│       ├── policy.js         sandbox / CSP / CDN 白名单 / 消息校验（纯函数）
│       ├── server.js         预览服务（独立源）
│       └── browser.js        浏览器承载（截图、可硬杀子进程）
├── web/                      界面（index.html + app.css + app.js，无构建步骤）
├── scripts/
│   ├── dev-server.mjs        不开 DSH 也能跑完整插件（界面迭代用）
│   ├── simulated-llm.mjs     模拟模型（零费用，产物明确标注）
│   ├── samples.mjs           六类固定示例作品
│   ├── m0-isolation-experiment.mjs   隔离试验（真实 Chromium）
│   ├── ui-walkthrough.mjs    真实浏览器端到端演练（模拟模型）
│   ├── dsh-contract-check.mjs        DSH 契约只读探测（升级后用）
│   ├── m1-real-compare.mjs   **M1** 真实模型同题对比（catalog / resolve / run / status）
│   ├── m1-probe-models.mjs   **M1** 模型可达性探针（目录里有不代表上游真的存在）
│   ├── m1-a02-check.mjs      **M1** A02 核对（hash 相同 / 配置独立 / 结果不串台，零模型费用）
│   ├── m1-samples-check.mjs  **M1** A13 六类样例真实渲染与交互（零模型费用）
│   └── m1-compare-walkthrough.mjs    **M1** 对比页实测 A14/A15/A16/A23（真实 DSH，零模型费用）
├── tests/                    node --test，77 个用例
└── docs/
    ├── progress.md           本文件
    ├── acceptance.md         A01–A30 证据
    ├── dsh-integration.md    DSH 接口核查与踩坑记录
    └── evidence/             机器可读的实测证据（JSON）与截图
```

---

## 最近验证（全部为实际执行结果）

| 项目 | 命令 | 结果 |
| --- | --- | --- |
| 单元与集成测试 | `node --test "tests/**/*.test.js"` | **77 通过 / 0 失败** |
| M0 隔离试验 | `node scripts/m0-isolation-experiment.mjs` | **11 项全部通过**（含对照组） |
| 界面演练（模拟模型） | `node scripts/ui-walkthrough.mjs` | **19 步全通过，0 控制台错误** |
| DSH 契约探测 | `node scripts/dsh-contract-check.mjs` | **8 项全部通过** |
| **A02 两个真实模型同题** | `node scripts/m1-a02-check.mjs <expId>` | **12/12 通过**（hash 相同、配置独立、结果不串台） |
| **A13 六类样例** | `node scripts/m1-samples-check.mjs` | **6/6 通过**，0 控制台错误 |
| **A14/A15/A16/A23 对比页** | `node scripts/m1-compare-walkthrough.mjs --base http://127.0.0.1:8901 ...` | **27/27 通过**，0 控制台错误、0 页面异常 |
| **真实模型两轮完整题** | `node scripts/m1-real-compare.mjs run ...` | 两轮各 2 候选，**全部 completed** |
| 真实模型调用 | 通过插件 API，deepseek-official / deepseek-flash | `completed`，1.2 s，输入 70 / 输出 305，提取成功 |
| 真实取消 | 3 s 后中止 | `cancelled`，`finish=aborted`，未上报 usage 保持 null |
| 真实 DSH 安装 / 卸载 | `dsh plugin --profile arena-test add/remove` | 装入后入口可用；卸载后配置里不再出现本插件，数据目录保留 |
| 交付产物冒烟测试 | 全新 profile 安装交付区 tgz 后启动 | 4 个路由全部 200；9 个 provider / 52 个模型 / 0 错误 |
| 交付物安检 | 全仓密钥与硬编码路径扫描 | 0 处密钥痕迹；源码无绝对本地路径；存储层 0 处凭据类内容 |

### M1 真实模型实测记录（本阶段的核心证据）

| 轮次 | 题目 | 候选 A | 候选 B | 结果 |
| --- | --- | --- | --- | --- |
| 冒烟（极短题） | 只输出一行大字 | deepseek-official/deepseek-flash | xkiro/deepseek/deepseek-v4-pro | A completed / **B failed 404**（见下方环境事实） |
| 第一轮 | 番茄钟（倒计时 + 圆形进度条） | deepseek-official/deepseek-flash（输出 10250 tok / HTML 12290 B） | deepseek/deepseek-v4-pro（输出 4032 tok / HTML 14431 B） | **两候选都 completed** |
| 第二轮 | 待办清单（增删改 + 未完成计数） | deepseek-official/deepseek-flash（输出 7910 tok） | deepseek/deepseek-v4-pro（输出 3169 tok） | **两候选都 completed** |

并发数均为 2；轮询记录显示**两个候选从第 1.5 s 起同时处于 running**，先完成的一方不影响另一方。
证据：`docs/evidence/m1-smoke.json`、`m1-real-compare.json`、`m1-real-compare-2.json`、
`m1-a02.json`、`m1-samples-*.json`、`m1-compare-walkthrough-*.json`。

**为什么第二个候选换成了 `deepseek/deepseek-v4-pro`**：交接建议的
`xkiro/deepseek/deepseek-v4-pro` 在模型目录里存在，但上游返回
`404 Model "deepseek/deepseek-v4-pro" does not exist`；同 provider 的另外 4 个模型同样 404，
`openrouter` 的模型返回 `401 User not found`。这是**上游/凭据的环境事实，不是本插件的缺陷**，
已用 `scripts/m1-probe-models.mjs` 逐条探活记录。改用同为 DeepSeek 家族的
`deepseek/deepseek-v4-pro`（独立 provider 条目、独立模型、独立思考档位清单），
仍然满足"两个不同的真实模型"。

---

## 当前错误与已知限制

### M1 实测暴露并已修复的缺陷（4 个）

1. **保存评价后"揭晓身份"按钮不出现**，盲选流程走不下去。
   原因：`saveVote()` 更新了 `state.current.vote`，但揭晓按钮的显隐只在 `renderCompare()` 里算，
   保存评价不触发重绘。修法：抽出 `updateIdentityControls()`，保存评价后调用它
   （**刻意不整页重绘**——重绘会重建 iframe，丢掉用户在作品里的操作状态）。
2. **隐藏配置身份期间，折叠的"配置差异"面板仍写出 provider / model**。
   原因：`renderCompareDetails()` 不读 `state.blind`。折叠只是折叠，点一下就能看见。
   修法：`state.blind && !state.revealed` 时把模型来源 / 模型 / 候选名渲染成"（已隐藏，揭晓后可见）"。
3. **揭晓后作品卡仍只写 A / B**：候选默认名就是 "A"/"B"，用户看不出谁是谁，还得去翻折叠面板。
   修法：非隐藏状态下卡片头部直接显示 `候选名 · provider / model`。
4. **开发服务器 `/models` 与 `/models/resolve` 返回 500**：`runtime.llmOf is not a function`。
   原因：`api.js` 用 `runtime.llmOf()` 取模型服务，而 `scripts/dev-server.mjs` 自己拼的 runtime 漏了这个字段。
   **M0 的演练之所以一直是绿的，是因为当时那个开发服务器进程跑的是改动前的旧代码**；进程一重启就暴露。
   修法：给开发服务器 runtime 补 `llmOf: () => llm`。

第 1–3 个只在真实浏览器里点得出来，node 单测与模拟演练都覆盖不到；第 4 个说明"长期不重启的开发进程"
会让演练结果失真，已记入环境注意事项。

### M0 期间已修复的缺陷（保留记录）

1. **DSH 里 /models 返回 500**：直接读 `ctx.llm` 会抛"without inject"。已改用 `ctx.get('llm')`。
2. **插件树加载失败**：往 `ctx` 上挂属性会抛"without provide"。已移除。
3. **无法被 iframe 嵌入**：`X-Frame-Options: SAMEORIGIN` 会连宿主一起拒绝。
   已改为 CSP `frame-ancestors`，且实测确认 `http://127.0.0.1:*` 这种端口通配可用、
   `[::1]:*` 不被支持（已避免使用）。
4. **界面改动不生效**：界面资源在启动时被缓存。已改为按 mtime 重读。
5. **候选卡选不到模型**：候选在模型目录到达之前就被创建。已改为目录到位后再建卡。
6. **复制候选丢失输入**：异步解析回来后整表重绘，把用户正在编辑的内容冲掉。
   已改为只刷新该卡的解析结果区域。
7. **预览请求污染实验列表**：预览会创建空实验。已改为无状态接口。
8. **DSH 版本一直显示未知**：ESM 里用 `require()` 会静默失败。已改为正常 import。
9. **取消的原因被覆盖**：诊断逻辑把 `ABORTED` 改写成了 `EMPTY_RESPONSE`。已加状态守卫。
10. **实验列表不刷新**、**截断的 HTML 被报成"没有作品"**：都已修复并加测试。

### 当前限制（未完成，如实记录）

| 限制 | 影响 | 计划 |
| --- | --- | --- |
| 四候选并发与排队未在真实模型上跑过 | M2 范围 | M2 |
| 配方保存 / 历史搜索 / 展示包 / 复测包未实现 | 按钮置灰并标注"M3 提供" | M3 |
| 视口切换与盲选已实现，但只测过 2 个候选 | 4 候选布局未验证 | M2 |
| CDN 模式策略已实现，但未在真实网络下验证资源失败路径 | A17 未全测 | M3 |
| 截图功能实测可用，但未做过"故意让截图超时"的边界验证 | A23 部分 | M2 |
| 重启恢复只做了状态标记（interrupted），未做完整回归 | A09 部分 | M2 |
| 真实模型不上报用量的情形在本阶段没遇到 | A18 只有模拟覆盖 | M2 |
| `xkiro` 整个 provider 在上游都调不通（目录里 5 个模型全部 404）、`openrouter` 返回 401 | 选候选前要先探活 | 已用 `m1-probe-models.mjs` 记录为环境事实，不是本插件缺陷 |
| 上游 404 在界面上只显示"调用失败（未识别的错误）" | 适配器给的是 `PI_AI_ERROR`，我们没有它的语义；原始 message 里其实带着 404 与原因 | M2：把"未识别错误"的原始 message 直接显示出来 |

### 环境注意事项（给后续接手者）

- **PowerShell 控制台会显示中文乱码**（例如 `Get-Content` 的输出看起来像乱码），
  但文件本身是正确的 UTF-8。判断文件内容请用 `read` 工具或设置
  `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8`，不要被控制台显示误导。
- 通过 PowerShell 向 node 传中文参数会被转成 `?`（踩过一次，产生了一条标题为 `???????` 的
  测试实验记录）。需要传中文时请写成 .mjs 脚本文件再执行。
- 本机装有两份 playwright（DSH checkout 内 1.61.1 与全局 @playwright/cli 内的 1.63）。
  **只有 1.63 对应的浏览器修订号在本机存在**，插件已实现"逐个候选尝试启动"，
  所以两份都在也能正常工作。
- **后台作业会随工具调用被中断一起消失**（DSH 实例与开发服务器都会被带走）。
  两者都是无状态的本地回环服务，直接重启即可；重新启动 DSH 实例会打印新的 token。
- **不要相信一个长期不重启的开发服务器进程**：M0 的界面演练曾在旧代码上一直是绿的
  （见"已修复缺陷"第 4 条）。改了 `src/` 下任何非界面文件后，务必重启开发服务器。
  `web/` 下的界面资源是按 mtime 重读的，改界面不用重启。

### 阻塞项

无。M1 期间没有遇到需要用户提供权限或预算才能继续的工作。

---

## 运行中的任务与本地服务

| 服务 | 端口 | 如何停止 |
| --- | --- | --- |
| HTML Arena 开发服务器 | 127.0.0.1:8790 | `job_kill` 或结束 node `scripts/dev-server.mjs` 进程 |
| DSH 测试实例（arena-test profile） | 127.0.0.1:8901 | 结束带 `arena-test` 的 node 进程 |

两者都是本地回环监听，不对外开放。用户日常使用的 DSH（端口 3080）**没有被本阶段改动过**；
所有实验都在独立 profile `arena-test` 中进行。

---

## 下一步（M2 的第一件事）

1. 在真实模型上补**四候选 + 并发 2** 的排队观测（A06）：确认只有两路同时生成、完成后队列推进。
2. 补**超时路径**（A08 剩余部分）与**截图超时的正式记录**（A23 剩余部分）。
3. 实现**配方快照与版本**，落实 A03 的"历史配方不被覆盖"，并做一次**宿主重启恢复**的完整回归（A09）。
4. 顺带修掉"未识别错误只显示未识别"这条：把适配器的原始 message 显示出来
   （上游 404 的真实原因现在被吞掉了）。

通过条件：四候选在并发 2 下确实只有两路同时生成、完成后队列推进；超时与取消都能落盘且不污染新
attempt；重启后未完成的尝试仍标为"已中断"且不自动重付费；配方改动不覆盖历史版本。
