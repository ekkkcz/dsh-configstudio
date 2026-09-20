# 模块与数据流

这份文件回答：**东西都放在哪、一次点击之后数据在哪些东西之间流动。**

配合阅读：`docs/progress.md`（进度与决定）、`docs/dsh-integration.md`（DSH 接口核查）、
`docs/acceptance.md`（A01–A30 的实际证据）。

---

## 1 三个进程，两个半边

理解这个插件的关键是：它在**三个不同的进程/源**里都有代码。

```text
┌─ DSH 主进程（Node） ────────────────────────────────┐
│  src/index.js        宿主半边：起预览服务、注册 API 路由  │
│  src/api.js          HTTP API（所有业务动作都走这里）      │
│  src/core/*          纯计算：存储 / 提取 / 执行 / 包 / 脱敏  │
└──────────────────────────────────────────────────────┘
        │                                    ▲
        │ ① /configstudio/api/*  （同源，无 CORS）
        ▼                                    │
┌─ 浏览器里的 DSH 页面 ──────────────────────┴──────────┐
│  src/client.js       DSH 侧栏入口 + 一个整页 iframe      │
└──────────────────────────────────────────────────────┘
        │ ② iframe src=/configstudio/api/ui
        ▼
┌─ 浏览器里的插件 SPA（我们自己的路由吐静态文件）─────────┐
│  web/index.html + app.css + app.js   无构建步骤，手写     │
└──────────────────────────────────────────────────────┘
        │ ③ iframe src=http://127.0.0.1:<另一个端口>/p/<id>
        ▼
┌─ 预览服务（src/preview/server.js，**独立端口 = 独立源**）─┐
│  作品 HTML 在 sandbox iframe + CSP 响应头下执行          │
└──────────────────────────────────────────────────────┘
        │ ④ 截图时另起一个独立浏览器子进程（可硬杀）
        ▼
┌─ Playwright / Chromium 子进程（src/preview/browser.js）─┐
└──────────────────────────────────────────────────────┘
```

**为什么这样切**：作品是别人（模型）写的 HTML，绝不能让它在宿主页面的源里跑。
独立端口提供独立源，加上 iframe sandbox（**刻意不含 `allow-same-origin`**）、
响应头 CSP、postMessage 校验，四层组合。这条边界在 `docs/acceptance.md` 的 A19–A22 有实测证据。

---

## 2 目录速查

```text
configstudio/
├── src/
│   ├── index.js        宿主插件：生命周期、起服务、注册路由、探浏览器能力
│   ├── api.js          HTTP API —— 界面所有动作的落点（最大的一支）
│   ├── ui.js           界面的静态资源路由（按 mtime 重读，改完不用重启）
│   ├── client.js       DSH 浏览器半边（手写 __ModuleLoader__ 闭包工厂）
│   ├── core/           ★ 纯函数与存储，不依赖 DSH 界面，全部可单测
│   │   ├── store.js        SQLite 索引 + 文件系统大对象（schema 版本与迁移在这里）
│   │   ├── runtime.js      **宿主半边与开发服务器共用**的执行管线
│   │   ├── runner.js       单次模型调用的执行器（流式、取消、错误翻译）
│   │   ├── extract.js      HTML 提取（代码块识别、多块、截断判定）
│   │   ├── recipe.js       配方的"内容口径"与版本指纹（只此一份）
│   │   ├── canonical.js    规范化 JSON + sha256（只此一份）
│   │   ├── task.js         题目的规范化与 hash（只此一份）
│   │   ├── redact.js       脱敏规则（只此一份，导出包与证据共用）
│   │   ├── zip.js          零依赖 ZIP 读写 + 严格校验
│   │   ├── pack.js         展示包 / 复测包的结构与导入校验
│   │   ├── report.js       展示包报告生成（纯函数）
│   │   ├── html.js         报告用的小工具（转义、安全相对路径）
│   │   ├── settings.js     用户设置（跟随数据目录）
│   │   └── optimizer.js    可选外部能力（提示词优化）的对接
│   └── preview/
│       ├── policy.js       sandbox / CSP / CDN 白名单 / 消息校验（纯函数）
│       ├── server.js       预览服务（独立源）
│       ├── browser.js      浏览器承载（截图、可硬杀子进程）
│       └── capture-worker.mjs  子进程入口
├── web/                界面（index.html + app.css + app.js，**无构建步骤**）
├── scripts/            开发服务器 + 全部验收脚本（见第 5 节）
├── tests/              node --test 用例
└── docs/               本文件、progress、acceptance、dsh-integration、evidence/
```

---

## 3 一条主流程的数据流：从点"开始生成"到看见两个作品

这是产品的主干。**每一步都写明数据落在哪**，因为"有没有落盘"直接决定了刷新后还在不在。

| # | 动作 | 发生什么 | 落在哪 |
| --- | --- | --- | --- |
| 1 | 填题 → 点开始 | 界面 `POST /experiments` | 题目规范化 + hash → `experiments` 表 |
| 2 | | 界面 `POST /experiments/:id/start`（带候选） | 每个候选**先建 attempt**：快照、请求配置、配方引用 |
| 3 | | `core/runtime.js` 按并发闸门（默认 2）派发 | `runs` Map（内存里跟踪进行中） |
| 4 | | `core/runner.js` 走 `ctx.get('llm').stream()` | 流式增量同时进两处：内存 `live` 缓冲（尾部 64KB，给界面轮询）+ 定期落盘 partial |
| 5 | 跑完 | 原始正文写文件 | `<数据目录>/artifacts/<attemptId>.raw.txt`，返回 sha256 |
| 6 | | HTML 提取（`core/extract.js`） | 作品写 `<attemptId>.html`；提取状态/警告/截断判定进 `artifacts` 表 |
| 7 | | 用量、收尾原因、时间戳 | `receipts` 表（**未上报的字段存 null，不写 0**） |
| 8 | 点"进入对比" | 界面拉 `GET /experiments/:id` | 每张作品卡配一个预览 iframe |
| 9 | | iframe 指向**预览服务**（不是宿主源） | `src/preview/server.js` 从 `store` 读 HTML 返回，带 CSP 响应头 |
| 10 | 评价 | `POST /experiments/:id/vote` | `votes` 表，绑定**具体作品 hash** |

**关键设计**：第 4 步的 `live` 缓冲**不是权威数据**，只是给界面看的；
权威内容以第 5–7 步落盘的为准。这样进程被杀（A09）也不会出现"界面说有、磁盘上没有"。

---

## 4 数据目录

默认 `$DSH_HOME/configstudio`（开发时可用 `--data` 指向别处）。**按用户，不按 profile** ——
换 profile 看到的是同一份实验记录。

```text
<数据目录>/
├── arena.db        SQLite（索引与元数据；大对象不放这里）
├── artifacts/      原始正文 / 作品 HTML / 推理文本 / partial（按 attemptId 命名）
└── settings.json   用户设置（跟着数据目录走，所以换浏览器行为一致）
```

### 表与 schema 版本

`SCHEMA_VERSION` 在 `src/core/store.js`，改变表结构时提升。当前是 **3**。

| 表 | 装什么 |
| --- | --- |
| `experiments` | 实验（题目快照 + hash、输出与预览规则、状态） |
| `attempts` | 一次候选的一轮尝试（快照、请求/解析配置、配方引用、状态） |
| `artifacts` | 提取结果的元数据（状态、警告、范围、两种 hash、字节数） |
| `receipts` | 收尾收据（时间戳、用量、收尾原因、错误码与脱敏后的原文） |
| `votes` | 评价（选择、标签、理由、揭晓时间、作品映射） |
| `recipes` / `recipe_versions` | 配方与**只追加**的版本表（每一版带内容指纹） |
| `screenshots` | 截图记录（成功与失败都落盘） |
| `pack_imports` | 导入留痕（**schema 3 新增**，M3 导入功能） |
| `meta` | 键值，含 `schema_version` |

**迁移规则**：只加不改。升级时自动增量迁移（幂等，反复启动不会重复迁移）。
**降级边界**：旧版本插件看到更新的 schema 会**明确拒绝打开**并说明原因，不会静默按老结构读
（实测见 `scripts/m4-upgrade-uninstall-check.mjs`）。

---

## 5 脚本的分工（避免"这脚本到底测什么"）

```text
scripts/
├── dev-server.mjs        ★ 不开 DSH 也能跑完整插件（模拟模型，零费用）
├── simulated-llm.mjs     模拟模型实现（正常/多块/失败/无HTML/截断/慢速/忽略中止）
├── samples.mjs           六类固定示例作品
├── lib/
│   ├── devhost.mjs       验收脚本共用：起服务、断言收集、硬杀、就绪等待
│   └── redact.mjs        证据落盘（规则来自 src/core/redact.js）
├── m0-isolation-experiment.mjs    隔离边界试验（真实 Chromium）
├── ui-walkthrough.mjs             真实浏览器端到端演练（模拟模型）
├── m1-*.mjs                       真实模型同题对比、六类样例、对比页实测
├── m2-*.mjs                       配方 / 重启恢复 / 超时 / 截图失败 / 四候选 / 用量 / 水平展开
├── m3-*.mjs                       导出导入 / 历史筛选 / CDN / 十轮 / 输入超限 / 真实包
├── m4-*.mjs                       ★ M4：干净安装 / 升级卸载 / 完整回归
└── sim-llm-overlay/               ★ 零费用验证用：把模拟 provider 挂进真实 DSH（--patch）
```

**硬性约定**：`dev-server.mjs` 里**不抄**任何运行逻辑，它和宿主半边共用 `src/core/runtime.js`。
同样只留一份的还有 `frameScale` / `canonical.js` / `core/redact.js` / `core/task.js` / `core/recipe.js`。
这不是洁癖 —— 历史上"两份实现漂移"已经造成过"`/models` 在开发服务器上 500 但在 DSH 里正常"这类问题。

---

## 6 想改一处代码时去哪找

| 想改什么 | 去哪 |
| --- | --- |
| 界面交互、布局、文案 | `web/app.js`（+ `web/app.css`） |
| 某个 API 的行为 | `src/api.js` |
| 模型调用的方式（参数、流、取消） | `src/core/runner.js` |
| 生成的整体编排（并发、落盘顺序） | `src/core/runtime.js` |
| HTML 提取规则 | `src/core/extract.js` |
| 数据表结构 | `src/core/store.js`（**记得提升 SCHEMA_VERSION 并写迁移**） |
| 预览隔离策略（sandbox / CSP / CDN） | `src/preview/policy.js` |
| 导出包的格式与校验 | `src/core/pack.js` + `src/core/zip.js` |
| 脱敏口径 | `src/core/redact.js`（**只此一份**） |

改完 `web/app.js` 或 `src/` 之后要跑什么，见 `README.md` 的"改动之后跑什么"一节。
