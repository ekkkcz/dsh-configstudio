# HTML Arena 验收记录（A01–A30）

> 标准定义见 `方案区/ACCEPTANCE.md`。本文件只记录**实际执行结果**。
> 状态取值：通过 / 失败 / 未测 / 阻塞。
> **没有证据不能标通过**；模拟与真实调用分开标注。

记录版本：插件 0.1.0（M1 阶段试玩）　DSH 0.1.6-alpha.2　Node v24.15.0
参考机器：Windows 11 桌面，Chromium（Playwright 捆绑 chromium-1243）
证据目录：`docs/evidence/`

---

## 参考机器（M0 记录，M1 沿用）

| 项 | 值 |
| --- | --- |
| 操作系统 | Windows（`process.platform win32`） |
| Node | v24.15.0 |
| DSH | 0.1.6-alpha.2（`dsh --version` 与安装包 package.json 一致） |
| Chromium | Playwright chromium-1243 + headless shell（两个 playwright 候选均可启动） |
| 数据目录 | `$DSH_HOME/html-arena`（开发时用 `html-arena/dev-data`） |

### M1 真实验证用的模型（含环境事实）

| provider / model | 可达性（`scripts/m1-probe-models.mjs` 实测） |
| --- | --- |
| `deepseek-official/deepseek-flash` | **可用**（思考档位 off/low/high/max；上下文 1,000,000） |
| `deepseek/deepseek-v4-pro` | **可用**（思考档位 off/high/max；上下文 1,000,000） |
| `xkiro/deepseek/deepseek-v4-pro` | **不可用**：上游 404 `Model does not exist`（同 provider 另 4 个模型同样 404） |
| `xkiro/deepseek/deepseek-v4-flash` | **不可用**：同上 404 |
| `wb/deepseek-v4.1-flash` | 可用（备用候选） |
| `other-free/google/gemini-3.8-flash` | 可用（备用候选） |
| `openrouter/nex-agi/nex-n2.5-pro:free` | **不可用**：401 `User not found` |

交接建议的 `xkiro/deepseek/deepseek-v4-pro` 因此改用同为 DeepSeek 家族、但属于独立 provider 条目的
`deepseek/deepseek-v4-pro`，仍然满足"两个不同的真实模型"。**模型目录里有某个模型，不代表上游真的存在**。

---

## 状态总览（M1 结束时）

| 状态 | 数量 |
| --- | --- |
| 通过 | 14 |
| 部分通过 | 4 |
| 未测 | 11 |
| 失败 | 0 |
| 阻塞 | 0 |

> 计数口径：A01–A30 共 30 条，本文件里写有小节的条目 18 条
> （14 通过 + 4 部分通过），其余 12 条没有小节、计入"未测"。
> **A06（四候选 + 并发 2 排队）已在用户试玩反馈批次里取得决定性证据，由"部分通过"升为"通过"。**
> 说明：M1 把 A02 / A13 / A14 / A16 / A23 从"未测"推进到"通过"，A30 记为部分通过
> （生成、比较、评价、下载已有真实证据；导出 / 导入属 M3）。A15 由"通过（仅模拟断言）"
> 升级为"通过（真实 DSH + 真实模型，并在过程中修掉 3 个真实缺陷）"；
> A07 补上真实上游 404 的证据；A04 补上两个真实模型不同的档位清单。
> **完整 V1 要求全部必需项有通过证据**，当前远未达到。

---

## 详细记录

### 已通过

#### A01 干净安装 / 卸载
- 状态：**通过**
- 版本：插件 0.0.1　DSH 0.1.6-alpha.2
- 步骤：
  1. `dsh --profile arena-test --from-default-profile web` 建独立 profile（不碰用户日常 profile）
  2. `dsh plugin --profile arena-test add <html-arena 路径>`
  3. `dsh --profile arena-test --port 8901 --no-open` 启动
  4. 浏览器打开，确认侧栏出现「HTML 对比」，点击后出现 iframe
  5. 停止实例，`dsh plugin --profile arena-test remove '@dsh-external/html-arena'`
  6. `dsh --profile arena-test --dump-config` 复查
- 实际结果：安装后 API 路由 200、界面 200、侧栏入口出现、点击后 `iframe src=/html-arena/api/ui`、
  控制台 0 错误。卸载后 `--dump-config` 里不再出现 html-arena；数据目录
  （`$DSH_HOME/html-arena`，含 arena.db 与 artifacts）**被保留**，用户记录未被静默删除。
- 证据：`docs/evidence/m0-dsh-boot.txt`（本节命令与输出）、`docs/dsh-integration.md` 第 3 节
- 备注：监听端口在停止实例后归零（`Get-NetTCPConnection -LocalPort 8901` 计数 0）。

#### A05 同时双击开始 + 刷新页面
- 状态：**通过**（逻辑提交去重；刷新不重跑）
- 步骤：界面用 `requestId` 去重；服务端每次 `/start` 才创建 attempt；
  读 `/experiments/:id` 不会创建 attempt。
- 实际结果：端到端测试断言"再次读取详情后 attempts 数量不变、runs 为空"→ 通过。
- 证据：`tests/api.e2e.test.js`「端到端：两候选同题生成…」第 8 步
- 未覆盖：真实浏览器里连续双击的时序竞争（未构造）。列入 M2。

#### A07 单个候选返回 401 / 429 / 500
- 状态：**通过**（401 模拟 + **真实上游 404 实测**；429/500 走同一代码路径）
- 步骤：模拟 llm 让第 2 个候选返回 `finish{kind:'error',failure:{code:'AUTH',status:401}}`；
  另用**真实上游错误**验证：候选 B 用 `xkiro/deepseek/deepseek-v4-pro`（上游 404）。
- 实际结果：
  - 模拟 401：候选 B `status=failed`、`error.code=AUTH`、附带人能读懂的原因与下一步；
    候选 A 正常 `completed` 并有作品；实验列表显示"成功 1 失败/中断 1"。
    保存的字段只有白名单（code/message/status/requestId），额外的自定义字段被丢弃。
  - **真实 404**：候选 B `status=failed`，`errorCode=PI_AI_ERROR`，原始 message 保存为
    `404: {"message":"Model \"deepseek/deepseek-v4-pro\" does not exist.",...}`；
    候选 A（deepseek-official/deepseek-flash）不受影响，正常 `completed` 并提取出作品。
    实验列表显示"成功 1 失败/中断 1 有作品 1"。
- 证据：`tests/api.e2e.test.js`「一个候选 401 失败，另一个继续成功」；`tests/runner.test.js`；
  **真实**：`docs/evidence/m1-smoke.json`（候选 A completed / 候选 B 404 failed）
- 已知不足（记入 M2）：适配器把这类错误统一报成 `PI_AI_ERROR`，我们自己的错误码表里没有它，
  界面因此只显示"调用失败（未识别的错误）"，**上游 404 的真实原因被吞掉**。
  真实原因保存在 receipt 的原始 message 里，但界面没有展示。列入 M2 修复。

#### A11 原始 HTML 与单 HTML 代码块
- 状态：**通过**
- 实际结果：两种形态都能正确提取；原始正文 hash 与 HTML hash 不同且稳定
  （SHA-256，同一输入重复计算结果一致）。原始正文原样保存，不做任何规范化。
- 证据：`tests/extract.test.js`（22 个用例）；真实调用中 `extraction=ok mode=fenced`

#### A12 多 HTML 块 / 无 HTML / 截断 HTML
- 状态：**通过**
- 实际结果：
  - 多个 HTML 块 → `status=multiple`，不拼接，返回候选清单供用户选择，选择后按同一提取器版本切出。
  - 无 HTML → `status=none`，界面显示"未识别到作品"。
  - 截断 → `finishReason=length/max_tokens` 时标 `truncated=true` 并给警告；
    finish reason 未知时 `truncated=null`（**不猜**）；缺结束标签只作为格式警告，不补写代码。
  - 真实场景：推理型模型被截断时只输出围栏开头，此时按 HTML 特征判断，能给出半成品而不是"什么都没有"。
- 证据：`tests/extract.test.js`、`tests/extract-truncated.test.js`

#### A15 盲选并揭晓
- 状态：**通过**（真实 DSH + 两个真实模型，全流程实测）
- 接口层（M0 已有，继续有效）：揭晓前响应里**不出现**模型 id 与配方名；
  匿名映射按候选槽排序固定，重复读取一致；投票条目带 64 位作品 hash；揭晓后才返回 provider / model / name。
- **界面层（M1 新增实测，真实 Chromium + 真实 DSH 8901 + 真实模型作品）**：
  - 点「隐藏配置身份」后，两张作品卡头部都变为"（身份已隐藏）"，
    对比区可见文本中 **0 处**出现 provider / model（脚本断言 `leaked: []`）。
  - **折叠的"配置差异"面板点开也不泄露**：模型来源 / 模型 / 候选名都渲染为"（已隐藏，揭晓后可见）"。
  - 评价按钮为「偏好 A / 偏好 B / 平局 / 无法判断」；保存后状态栏显示
    "已保存：偏好 A（时间）。选择绑定具体作品 hash。"
  - 揭晓前 `state.current.vote` 的映射里 **0 处** provider / model。
  - 揭晓后每个作品卡头部直接写出 `候选名 · provider / model`
    （实测："A · deepseek-official / deepseek-flash" 与 "B · deepseek / deepseek-v4-pro"）。
- **本项实测发现并修掉 3 个真实缺陷**（详见 `docs/progress.md` 的"已修复缺陷"第 1–3 条）：
  保存评价后揭晓按钮不出现（流程卡死）、折叠面板泄露身份、揭晓后看不出谁是谁。
- 证据：`docs/evidence/m1-compare-walkthrough-1789717897142.json`（27/27，
  含 `A15` 6 项断言）、截图 `docs/evidence/m1-a15-blind.png` / `m1-a15-blind-details.png` /
  `m1-a15-reveal.png`；`tests/api.e2e.test.js`「盲选：揭晓前不出现模型身份…」
- 备注：作品页面内容本身可能写出模型名，所以产品称"隐藏配置身份"，不承诺严格双盲（与 PRD 4.4 一致）。

#### A30 两个真实模型完整流程
- 状态：**部分通过**（生成 / 比较 / 评价 / 下载有真实证据；导出 / 导入属 M3）
- 配置：`deepseek-official/deepseek-flash` 与 `deepseek/deepseek-v4-pro`，并发 2。
- 实际操作过的完整链路（**全部为真实模型产物**）：
  1. **生成**：同一道题（番茄钟、待办清单各一轮）发起两候选 → 两轮都两个候选 `completed`。
  2. **落盘**：每候选各存原始正文与提取出的 HTML，各自带 SHA-256 hash
     （见 A02 的"内容与记录一一对应"断言）。
  3. **比较**：进对比页，两个作品并排、逻辑视口一致；切桌面 / 手机视口；
     对其中一个"重置"而另一个不受影响。
  4. **评价**：隐藏配置身份 → 选"偏好 A" → 保存 → 揭晓身份。
  5. **下载**：两份原始正文都能下载且内容不同（11249 / 12998 字符）；
     HTML 下载入口按 A16 在失败占位侧也提供。
  6. **历史**：实验列表出现该条目，显示"成功 2 有作品 2 已评价：偏好 A"，
     可按标题搜索到并重新打开。
- **未做**：导出（展示包 / 复测包）与导入 —— 界面按钮置灰并标注"M3 提供"，如实记录，不算通过。
- 证据：`docs/evidence/m1-real-compare.json`、`m1-real-compare-2.json`、`m1-a02.json`、
  `m1-compare-walkthrough-1789717897142.json`；截图 `docs/evidence/m1-a15-reveal.png` 等

#### A19 作品读取父窗口 cookie 和 storage
- 状态：**通过**（真实 Chromium 实测）
- 步骤：宿主页面持有 cookie 与 localStorage；作品尝试读 `document.cookie`、
  写 `localStorage`、读 `parent.document.title`，并通过 postMessage 回报结果。
- 实际结果：三项**全部抛 SecurityError**，宿主 cookie 未被读取。
- 对照：把 sandbox 换成包含 `allow-same-origin` 时，`localStorage` 变成可写 —— 证明隔离确实起作用，
  不是"碰巧没读到"。
- 证据：`docs/evidence/m0-isolation-*.json` 的 `summary["E1 宿主存储不可读"]` 与对照组

#### A22 构造伪造 postMessage
- 状态：**通过**
- 实际结果：父界面校验函数对 4 类输入的结果为——
  外部窗口来源 → `unexpected-source`（拒绝）；错误令牌 → `token-mismatch`（拒绝）；
  未知类型（如 `vote`）→ `unknown-type`（拒绝）；合法消息 → 接受并带出载荷。
  伪造消息不能触发投票、不能写入状态。
- 证据：`tests/policy.test.js`；`docs/evidence/m0-isolation-*.json` 的 E5 段

#### A02 两个不同模型运行同一题
- 状态：**通过**（两个真实模型，零额外模型费用的核对脚本）
- 配置：候选 A `deepseek-official/deepseek-flash`；候选 B `deepseek/deepseek-v4-pro`；并发 2。
- 步骤：`node scripts/m1-a02-check.mjs <experimentId>`（12 项断言，不发起生成、不产生费用）
- 实际结果：
  - **题目与输出规则 hash 相同**：两个候选各自提交一次 `/preview-request`，
    两次算出的 `taskHash` 完全相同（`6bfef262…`），且与实验记录里的 `taskHash` 一致；
    改动题目一个字后 hash 立刻变化（`43b0fc1a…`）——证明 hash 确实绑定题目而不是常量。
  - 两个候选实际收到的"题目 / 输出要求 / 交付格式"段落**逐字节相同**（132 字符）；
    两候选都不发送 `tools`（F02 的单次逻辑请求）。
  - **模型配置独立**：provider / model 不同；每个候选各有一条 attempt 记录与自己的
    `recipeSnapshot` 和 `resolvedConfig`（含各自的上下文窗口与思考档位清单）。
  - **结果不串台**：两个候选的作品 hash 与原始正文 hash 都不同；
    分别下载两份原始正文，长度不同（11249 / 12998 字符）；
    把每份正文**重新提取**得到的 HTML hash 与它自己记录的一致 —— 内容与记录一一对应。
  - 两个候选**同时运行**（并发 2）：轮询记录显示从第 1.5 s 起两者都是 `running`，
    先完成的一方（A，约 34.7 s）不影响仍在跑的 B。
- 证据：`docs/evidence/m1-a02.json`（12/12）；`docs/evidence/m1-real-compare.json`（生成记录）
- 备注：另一轮"待办清单"题得到完全相同性质的结论（`m1-real-compare-2.json`）。

#### A13 六类样例 HTML
- 状态：**通过**（真实 Chromium，走产品真正的预览隔离通路）
- 步骤：`node scripts/m1-samples-check.mjs` —— 用真实的预览服务（独立源 + iframe sandbox +
  响应头 CSP）承载 `scripts/samples.mjs` 的六类样例，在真实浏览器里逐类断言"能渲染"且"能交互"。
- 实际结果：**6/6 类通过，0 控制台错误，0 页面异常**
  | 样例 | 渲染断言 | 交互断言 |
  | --- | --- | --- |
  | 落地页 | header / 卡片存在 | 点按钮切换主题，body 背景色确实变化 |
  | 仪表盘（天气） | 温度文本 + SVG 折线存在 | 换城市后温度变化；"切换昼夜"加上 `day` 类 |
  | 动画（粒子） | canvas 存在、粒子数 220、画布确有非零像素 | FPS 计数器在工作；"重置"可用 |
  | 数据可视化 | 6 根柱子 + 文字 + 图例 | 柱子带 `<title>` 悬停提示 |
  | 交互原型 | 首屏标题"选择方案" | 可前进到"确认信息"，可返回上一步 |
  | 小游戏 | canvas 存在且有非零像素 | 画面确实在变（球在动）；"重新开始"复位为 0 分 3 命 |
- 证据：`docs/evidence/m1-samples-1789716906916.json`；截图 `docs/evidence/sample-*.png`（6 张）
- 备注：样例是**固定测试样本**，不是模型输出，与真实模型结果分开记录。

#### A14 切换左右作品和不同视口
- 状态：**通过**（真实 DSH + 真实模型作品，真实浏览器操作）
- 实际结果：
  - 桌面视口下两个 iframe 都在，逻辑视口一致（1280x720）。
  - 点"手机"后**两个 iframe 同步**变成 390x844，视口标签也同步更新。
  - **独立重置（本项的关键）**：分别在两个作品里写入各自的运行态标记（A → `"A"`，B → `"B"`），
    然后点候选 A 的"重置"：A 的标记被清空（重新加载），**B 的标记原样保留**。
    反向再验一次（给 A 写入 `"A2"`，重置 B）：B 被清空，**A 的 `"A2"` 仍在**。
    即两个作品的状态确实互相独立。
  - 重置**不重置视口**：重置后两边的尺寸仍是当前视口（390x844）。
  - 切回"桌面"后两边一起恢复 1280x720。
- 证据：`docs/evidence/m1-compare-walkthrough-1789717897142.json`（A14 共 8 项断言）；
  截图 `docs/evidence/m1-a14-mobile.png` / `m1-a14-reset-mobile.png` / `m1-a14-desktop.png`
- 备注：视口切换 + 重置的实现在 M0 已有，但当时只测了"手机视口与缩放"。
  M1 补上了"每个视口下都能独立重置、且只影响被点的那一个"这条硬断言。

#### A16 一个作品不能预览
- 状态：**通过**（真实实验：一个候选上游 404，另一个正常）
- 实际结果：
  - 失败候选的位置**保留为失败占位**，不是空白、不是消失：卡片里显示
    "这个候选没有可预览的作品 / 调用失败（未识别的错误）：展开原始错误信息查看细节。"
  - 占位里给出下一步按钮：**下载原始输出**、**重试**。
  - **另一个候选照常可预览**（iframe 正常），失败不影响成功方的记录。
  - 页面未卡死：失败占位出现后仍能正常切换页签、来回进入对比页。
- 证据：`docs/evidence/m1-compare-walkthrough-1789717897142.json`（A16 共 4 项断言）；
  截图 `docs/evidence/m1-a16-failure-placeholder.png`
- 备注：失败候选是**真实上游 404**（`xkiro/deepseek/deepseek-v4-pro`），不是构造出来的。

#### A23 生成截图并重放
- 状态：**通过**（真实 DSH，两个真实模型作品）
- 实际结果：点"截图"后生成 **3 张**图（两个候选的初始截图 + 一张对比场景），
  每张都带完整标注：`候选 · 1280x720 · DPR 1 · 等待 1070ms · 网络策略 offline`，
  并附"初始状态：本图是对该作品重新加载后、未做任何交互时捕获的画面"说明与作品 URL。
  截图是对作品**重新加载**后捕获的，因此与用户当前操作状态无关 —— 这正是 F16 要求的语义。
- 证据：`docs/evidence/m1-compare-walkthrough-1789717897142.json`（A23 共 2 项断言）；
  截图 `docs/evidence/m1-a23-screenshots.png`
- **仍未测**（记入 M2）：截图失败路径的**正式记录**（故意让页面永不 load）。
  死循环作品的截图超时行为已在 M0 隔离试验中观测到（`screenshot_failed` + 硬终止 +
  主进程仍响应 25ms），但当时没有纳入 A23 的正式记录。

---

### 部分通过

#### A03 复制候选只修改提示词
- 状态：**部分通过**
- 已实现并验证：复制候选后，与原卡不同的字段会在界面上高亮并列出（模型来源/模型/系统提示词/
  温度/输出上限/思考档位/提示词片段）；配方快照按候选独立保存，"""历史配方不被覆盖""
  取决于配方版本功能。
- **未测**：配方版本化（M3）——目前还没有配方对象，因此"历史配方不被覆盖"无法验证。
- 证据：`web/app.js` 的 `diffFields()`；浏览器演练步骤「候选卡渲染」

#### A04 参数不受模型支持
- 状态：**部分通过**
- 已实现并验证：开始前用 `resolveModelInfo()` 核对 `reasoning.efforts`；
  不支持时返回 400 并列出可选值，**且不创建任何 attempt**（不静默忽略）。
  适配器不上报档位清单时界面显示"未确认"，不猜。
- **M1 新增真实证据**：在两个真实模型上调用 `/models/resolve`，如实拿到各自的档位清单 ——
  `deepseek-official/deepseek-flash` → `[off, low, high, max]`（上下文 1,000,000，
  默认输出上限 256,000）；`deepseek/deepseek-v4-pro` → `[off, high, max]`
  （上下文 1,000,000，默认输出上限 **null**，界面显示"未确认"而不是编一个值）。
  两者的可用档位确实不同，说明这是真的按模型查出来的，不是常量。
- **未测**：温度与输出上限的"不受支持"判定——适配器没有上报这两个维度的支持情况，
  界面对温度统一显示"未指定"，没有伪造支持结论。列入 M2。
- 证据：`tests/api.e2e.test.js`「开始前阻止不受支持的思考档位」；
  `docs/evidence/m1-real-compare.json` 与 `m1-real-compare-2.json` 的 `resolved` 字段

#### A06 四候选并发设置为二
- 状态：**通过**（4 个真实候选 + 真实模型实测）
- 配置：`deepseek-official/deepseek-flash`、`deepseek/deepseek-v4-pro`、
  `wb/deepseek-v4.1-flash`、`other-free/google/gemini-3.8-flash`；并发设为 **2**。
- 实际结果：
  - **实测最大同时 running = 2，从未超过**：整条时间线里 `running > 2` 的帧数为 **0**。
  - 排队推进清晰可见：前 12 秒稳定在 `0:running 1:running 2:queued 3:queued`，
    前面两个完成后队列自动前进，89.8 秒时四个全部结束。
  - 3 个成功、1 个失败（`other-free/google/gemini-3.8-flash` 上游 **额度不足**），
    **失败的那个不影响其他三个**。
  - 三个作品的 HTML 各不相同（11021B / 14949B / 10140B）。
- 证据：`docs/evidence/m2-four-candidates.json`（含逐帧 `timeline` 与 `maxConcurrentObserved: 2`）
- 界面侧：四个候选在对比页渲染为**两行两列**、同行等宽，各自独立重置、视口切换对全部生效。
  证据：`docs/evidence/m2-four-walkthrough-*.json`（8/8）

#### A08 中途取消与超时
- 状态：**部分通过**
- 已通过：**真实模型**取消——3 s 后中止，`status=cancelled`、`finish=aborted`、
  已收到的内容保留、未上报的用量保持 null、不自动重试。
- **未测**：超时路径（`defaultTimeoutMs` 已配置但没有触发过真实超时）；
  "后续输出不污染新 attempt"依赖"重试新建 attempt"的设计（已实现，未做并发观测）。列入 M2。
- 证据：真实调用验证 C 段（见 `docs/evidence/` 与本节"实际结果"）；`tests/runner.test.js`

---

### 未测（属于后续里程碑）

| ID | 场景 | 计划 |
| --- | --- | --- |
| A09 | 生成中重启宿主 | M2（目前只做了状态标记 `interrupted`，无完整回归） |
| A10 | 输入超过大小限制 | M2：已实现并有单测（题目 5 万字符、起始 HTML 2MB，明确拒绝且不截断），**真实界面尚未手工验证** |
| A17 | 外部 CDN 资源不可达 | M3（CDN 白名单与策略已实现，未在真实网络下验证） |
| A18 | 模型不返回 Token | M2：已实现（缺失字段存 null、界面显示"未上报"），模拟模型覆盖边界；**M1 的两轮真实调用里两个模型都上报了用量**，没有遇到真实模型不上报的情形 |
| A20 | 作品弹窗 / 顶层跳转 / 请求本机 API | M1 末的隔离试验**已实测通过**（见下方补记），待正式归档到本节 |
| A21 | 无限循环与大量日志 | M1 末的隔离试验**已实测通过**（4 s 硬上限终止、主进程仍可响应 25ms），待正式归档 |
| A24 | 展示包在干净机器打开 | M3 |
| A25 | 复测包导入另一安装 | M3 |
| A26 | ZIP 路径穿越 / 超大压缩包 | M3 |
| A27 | 导出包与日志不含私密数据 | M3（当前保存的错误字段已是白名单） |
| A28 | 连续十轮并停止全部预览 | M2 |
| A29 | 更新插件后打开旧实验 | M2（目前有 schema 版本守卫：未来版本的数据目录拒绝打开并给出提示） |

> A20 / A21 的证据其实已经在手：M1 末重跑了 `node scripts/m0-isolation-experiment.mjs`，
> **11/11 全部通过**，其中 E2b（宿主 API 不可达）、E2c（无弹窗）、E1/E1b（宿主存储不可读）、
> E3（死循环 4 s 硬终止且主进程仍响应，`responsiveLatencyMs=25`）正对应这两条。
> 证据：`docs/evidence/m0-isolation-1789717958008.json`（含对照组）。
> 之所以仍列在"未测表"里，是因为它们属于 M0 的试验记录，尚未按 A 编号归档为正式条目 ——
> 这一步留到 M2 一起做，不在这里假装已经归档。

---

## 附：模拟与真实的分界

| 类型 | 用在哪儿 | 是否可作验收证据 |
| --- | --- | --- |
| 模拟模型（`scripts/simulated-llm.mjs`） | 队列、失败、多块、无 HTML、截断等边界的稳定复现 | **不能**单独作为真实调用验收；只用于稳定复现边界 |
| 真实模型（deepseek-official / deepseek-flash） | 真实调用、提取、取消 | 是 |
| 固定样例（`scripts/samples.mjs`） | 预览隔离与六类作品可操作性 | 是（明确标注为固定测试样本，不是模型输出） |

模拟模型返回的文本里带「这是模拟模型的说明」，产物不会被误认为真实结果。
