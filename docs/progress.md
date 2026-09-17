# HTML Arena 进度记录

> 本文件是运行状态的权威记录。固定需求见 `方案区/PRD.md`，
> 验收标准见 `方案区/ACCEPTANCE.md`，实际测试证据见 `docs/acceptance.md`。
> 本文不复制需求内容，只记录"现在到哪了、下一步做什么"。

最后更新：2026-09-18（M0 完成）

---

## 当前阶段

**M0 接入与边界 —— 已完成。**

下一阶段：**M1 首次可玩版**（两候选同题生成 → 原始输出与 HTML 落盘 → 并排预览 →
独立失败与重置 → 简单历史）。M0 的实现已经覆盖了 M1 的绝大部分内容，M1 的剩余工作是
补齐并实测这些流程的边角与试玩包。

---

## 已完成

### 阶段与流程

| 里程碑 | 状态 | 说明 |
| --- | --- | --- |
| M0 接入与边界 | **完成** | DSH 版本已确认；插件在真实 DSH 中安装、加载、渲染、卸载均已实测 |
| M1 首次可玩版 | 进行中 | 生成 / 落盘 / 并排预览 / 独立失败 / 历史均已在真实浏览器中走通；待补试玩包 |
| M2 核心稳定性 | 未开始 | 配方版本、四候选排队、重启恢复、盲选已部分实现 |
| M3 复用与分享 | 未开始 | |
| M4 发布准备 | 未开始 | |

### 已打通的纵向流程

同一道题 → 两个候选各自一次模型调用 → 原始正文与提取出的 HTML 分别落盘 →
并排在同一逻辑视口里操作 → 隐藏配置身份 → 记录偏好 → 历史列表复现。
整条链路用过真实模型（deepseek-official）与模拟模型各验证过一遍。

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
│   ├── ui-walkthrough.mjs    真实浏览器端到端演练
│   └── dsh-contract-check.mjs        DSH 契约只读探测（升级后用）
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
| M0 隔离试验 | `node scripts/m0-isolation-experiment.mjs` | **10 项全部通过**（含对照组） |
| 真实浏览器界面演练 | `node scripts/ui-walkthrough.mjs` | **18 步全通过，0 控制台错误** |
| DSH 契约探测 | `node scripts/dsh-contract-check.mjs` | **8 项全部通过** |
| 真实模型调用 | 通过插件 API，deepseek-official / deepseek-flash | `completed`，1.2 s，输入 70 / 输出 305，提取成功 |
| 真实取消 | 3 s 后中止 | `cancelled`，`finish=aborted`，未上报 usage 保持 null |
| 真实 DSH 安装 / 卸载 | `dsh plugin --profile arena-test add/remove` | 装入后入口可用；卸载后配置里不再出现本插件，数据目录保留 |
| 交付产物冒烟测试 | 全新 profile 安装交付区 tgz 后启动 | 4 个路由全部 200；9 个 provider / 52 个模型 / 0 错误 |
| 交付物安检 | 全仓密钥与硬编码路径扫描 | 0 处密钥痕迹；源码无绝对本地路径；存储层 0 处凭据类内容 |

---

## 当前错误与已知限制

### 已修复（都是本阶段实测暴露出来的）

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

### 环境注意事项（给后续接手者）

- **PowerShell 控制台会显示中文乱码**（例如 `Get-Content` 的输出看起来像乱码），
  但文件本身是正确的 UTF-8。判断文件内容请用 `read` 工具或设置
  `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8`，不要被控制台显示误导。
- 通过 PowerShell 向 node 传中文参数会被转成 `?`（踩过一次，产生了一条标题为 `???????` 的
  测试实验记录）。需要传中文时请写成 .mjs 脚本文件再执行。
- 本机装有两份 playwright（DSH checkout 内 1.61.1 与全局 @playwright/cli 内的 1.63）。
  **只有 1.63 对应的浏览器修订号在本机存在**，插件已实现"逐个候选尝试启动"，
  所以两份都在也能正常工作。

### 阻塞项

无。M0 期间没有遇到需要用户提供权限或预算才能继续的工作。

---

## 运行中的任务与本地服务

| 服务 | 端口 | 如何停止 |
| --- | --- | --- |
| HTML Arena 开发服务器 | 127.0.0.1:8790 | `job_kill` 或结束 node `scripts/dev-server.mjs` 进程 |
| DSH 测试实例（arena-test profile） | 127.0.0.1:8901 | 结束带 `arena-test` 的 node 进程 |

两者都是本地回环监听，不对外开放。用户日常使用的 DSH（端口 3080）**没有被本阶段改动过**；
所有实验都在独立 profile `arena-test` 中进行。

---

## 下一步（M1 的第一件事）

1. 用 M0 的实测数据冻结参考机器的测试条件，填入 `docs/acceptance.md` 的 A01/A02 记录。
2. 用**两个真实模型**（例如 deepseek-official/deepseek-flash 与 xkiro/deepseek-v4-pro）
   跑一遍完整的"同题两候选 → 并排 → 盲选 → 下载"，作为 A02 / A30 的第一批真实证据。
3. 补 A13（六类样例作品逐一可操作）与 A14（视口切换 + 独立重置）的实测记录。
4. 打包 M1 试玩包，写试玩说明，交用户评价手感。

通过条件：两个真实模型在同一题上各自产出可操作的作品，界面能并排显示、能独立重置、
能下载原始 HTML，且用户能在 3 分钟内完成第一次实验设置。
