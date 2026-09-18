# HTML Arena 验收记录（A01–A30）

> 标准定义见 `方案区/ACCEPTANCE.md`。本文件只记录**实际执行结果**。
> 状态取值：通过 / 失败 / 未测 / 阻塞。
> **没有证据不能标通过**；模拟与真实调用分开标注。

记录版本：插件 0.4.0（**M2 核心稳定性**：配方版本 / 重启恢复 / 超时与取消 / 截图失败记录）　DSH 0.1.6-alpha.2　Node v24.15.0
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

## 状态总览（M2 结束时）

| 状态 | 数量 |
| --- | --- |
| 通过 | 20 |
| 部分通过 | 2 |
| 未测 | 8 |
| 失败 | 0 |
| 阻塞 | 0 |

> **M2 这一轮把 6 条推进到"通过"**：A03（配方版本 → 历史配方不被覆盖）、A08（超时路径与不污染新 attempt）、
> A09（生成中重启宿主，**真的 SIGKILL 再起来**）、A20 / A21（从 M0 试验记录按 A 编号正式归档）、
> A29（本轮 schema 1 → 2 是一次真实迁移）。
> 剩下的**部分通过 2 条**是 A04（温度的"不受支持"判定：适配器根本不上报这个维度，界面写"未指定"，
> 不伪造结论 —— 这是**环境限制**，不是没做）与 A30（导出/导入属 M3）。
> **未测 8 条**：A10（输入超限的真实界面手工验证）、A17（受控 CDN 真实网络）、A18（真实模型不上报用量）、
> A24–A28（展示包/复测包/路径穿越/私密数据/连续十轮，属 M3/M2 尾）。
> **这一轮没有把任何"未测"写成"通过"。**

> **M2（v0.4.0）的完整回归基线与逐项证据见本文件末尾的"附：M2 回归基线"。**
>
> **第四轮反馈（v0.3.2）只有一条**：手机逻辑视口下作品右侧留白 → 改为"等比缩放正好撑满"。
> 这是**上一轮引入的缺陷**（缩放公式里的 `min 1` 导致永不放大），已修并扩了 4 条断言，
> 详见 A14 条目下的"第四轮反馈补充"。**本轮没有把任何"未测"写成"通过"。**
>
> > **第三轮反馈（v0.3.1）同样没有把任何"未测"写成"通过"。** 两条都是体验改进：
> ① 窄视口下强制并排（根因是 CSS 断点在高 DPI 屏上把并排改成了堆叠）；
> ② token / 速度挪到显眼处（数据本来就有，只是藏在折叠面板里），并顺带把用量一起纳入盲选脱敏。
> 受影响的既有条目（A14 / A15 / A16 / A23）证据已**重新跑过并更新**，
> 详见各条目下的"第三轮反馈补充"。
>
> > 上一轮（第二轮反馈）没有把任何"未测"写成"通过"：修掉重绘丢操作状态、外部能力默认关、
> > 对比页展开配置、追加轮次；详见各条目下的"第二轮反馈补充"。

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
- **M2 已修**：适配器把这类错误统一报成 `PI_AI_ERROR`（我们的错误码表里没有它），
  界面原先只显示"调用失败（未识别的错误）"，**上游 404 的真实原因被吞掉**。
  现在 `explainError()` 对任何错误码都带上原始 `message`，界面把它放进可展开的
  "上游原始错误（PI_AI_ERROR）"里，运行面板与对比页两处都能看到 ——
  用户至少拿得到能搜索、能贴给别人的原文。
  实测：`tests/stability.test.js`「未识别的错误码要把上游原文带出来，不能只说'未识别'」
  （用真实的 404 原文 `404: {"message":"Model \"deepseek/deepseek-v4-pro\" does not exist."}` 断言）。

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

##### 第二轮反馈补充：脱敏范围扩大到对比页的新配置面板

对比页新增了"展开配置"（见 A14 的补充），里面会渲染**系统提示词与提示词片段** ——
这两项很可能直接写出模型名，是新的泄露面。已按同一约束处理并**重新实测**：

- 候选名 / provider / model → 渲染为"（已隐藏，揭晓后可见）"；
- **系统提示词与提示词片段在隐藏期间整段不显示**（宁可不显示也不泄露）；
- 题目 / 输出要求 / 起始 HTML / 解析说明里若出现身份字串，也整段隐藏；
- 身份字串只收 provider / model 与**长度 ≥ 3 的自定义候选名** ——
  默认候选名是单字母 "A"/"B"，拿它当身份字串会让含该字母的正常题目被误隐藏（实测踩到并修正）；
- **脱敏≠把整块藏掉**：盲选状态下仍然看得到题目原文（用户来对比时最需要的信息）。

实测（`m2-four-walkthrough.mjs`，四候选真实实验）：盲选状态下展开配置，
`leaked: []`（0 处 provider/model）；`m1-compare-walkthrough.mjs` 的 27 项
（含 A15 的 6 项断言）在改动后重跑仍然全绿。
证据：`docs/evidence/m2-four-walkthrough-1789723412284.json`、
`docs/evidence/m1-compare-walkthrough-1789724128369.json`；
截图 `docs/evidence/m2-four-config-blind.png`。

##### 第三轮反馈补充：盲选期间连用量与速度也一并隐藏

本轮把 token 消耗与速度提到"不用展开折叠面板就能看到"的显眼处（用户反馈 2），
于是多了一块新的泄露面。**判定与处理**（用户明确要求判断"这些数字会不会构成模型指纹"）：

- token 数与速度**不是强指纹** —— 不像上下文窗口那样与某个模型一一对应（换个题目数字全变）；
- 但仍按同一条约定处理，理由有两条：① 它们与上下文窗口 / 档位清单同属"调用元数据"，
  同一块面板里一半遮一半露很怪；② 盲选要的是"先看作品"，把 235.8 tok/s 摆出来会把对比
  变成跑分、反过来影响投票。所以**整块隐藏并写明"揭晓后可见"**。

**顺带修掉一个真实泄露**：v0.3.0 的「展开配置」在盲选期间**仍然把 token 数写出来了**
（旧代码只遮了 provider / model / 指纹，用量那一块漏了）。是本轮新增的
"指纹不得出现在盲选页面上"这条**跨面板整体断言**才抓到的 —— 只看那个面板自己的断言是绿的。

**实测**（`m2-usage-metrics-check.mjs` **22/22**，含反例断言）：
- 盲选期间 `leaked: []`，且上下文窗口 / 默认输出上限 / 档位清单 / **token 数**全部为 0 命中
  （`leakedFp: []`）；
- 用量摘要变成"用量与速度：盲选期间隐藏（揭晓后可见）"，**不是空白**，也带解释性 title；
- 取消盲选后数值立即回来（脱敏不是把功能关掉）；
- **错误口径值（如 3703.4 tok/s）不出现在页面上**（专门的反例断言）。

**本轮还修掉一个与脱敏有关的真缺陷**：揭晓不可逆，但"隐藏配置身份"按钮原先只翻转
`state.blind`，于是在**已揭晓**的实验上点它——画面什么都没变、文案却翻成"显示配置身份"，
是个没用的死开关。现在新增唯一判定入口 `identityHidden()`，**揭晓后按钮直接隐藏**；
并且把"实验未揭晓"写成盲选类断言的**硬前置条件**（以前会点一个不存在的按钮，
然后拿没脱敏的画面去断言脱敏 —— 最坏的一种假证据，本轮真踩到了）。

证据：`docs/evidence/m2-usage-metrics-1789735753042.json`（22/22）、
`docs/evidence/m2-four-walkthrough-1789735753567.json`（27/27）、
`docs/evidence/m1-compare-walkthrough-1789735803166.json`（27/27，A15 走完整盲选主流程）；
截图 `docs/evidence/m2-usage-strip-blind.png`。

#### A14 补充：窄视口强制并排（第三轮反馈 1）

见 A14 条目下方的"第三轮反馈补充"。核心：`.compare-grid` 列数改由 `renderCompare()` 行内写死，
CSS 里那条 `@media (max-width: 900px)` 单列规则已删除；窄视口提供
「缩小看全 / 1:1 横向展开 + 左右同步滚动」两种读法。

##### 第四轮反馈补充：作品帧自适应撑满（**上一轮引入的缺陷**）

用户原话（配截图）："这个手机这里怎么右边一堆空白，得自适应"。

**根因**：缩放公式里的 `min 1` ——
`scale = Math.min(1, avail / vp.width)`。手机逻辑视口只有 **390px**，
而卡片有 400–490px，`min 1` 意味着**永远不放大**，作品按 390px 原尺寸画出来，右边全空着。

**实测**（真实 Chromium 量 `getBoundingClientRect`）：

| 状态 | 卡片宽 | 作品渲染宽 | 右侧空白 | 缩放 |
| --- | --- | --- | --- | --- |
| 修复前 · 手机视口 | 488px | 390px | **98px** | 1（卡住） |
| 修复前 · 1600px 窗口 + 手机视口（1.6× 上限版） | 742px | 624px | **118px** | 1.6（被上限截断） |
| **修复后 · 1024px + 手机视口** | 486px | **486px** | **0** | 1.246 |
| **修复后 · 1600px + 手机视口** | 742px | **742px** | **0** | 1.903 |
| **修复后 · 880px + 手机视口** | 414px | **414px** | **0** | 1.062 |

**修法**：抽出唯一口径 `frameScale(vpWidth, avail, wide)`，`buildFrame()` 与 `refitFrames()` 共用
（这两处以前**各写了一份同样的公式**，正是漂移出这个缺陷的原因）。
「1:1 横向展开」且内容更宽时保持 1:1 并允许横滚；**其余情况等比缩放正好撑满**。

**一次被实测否掉的"想当然"**：先加了 1.6× 放大上限（怕插值糊），结果**在 1600px 窗口下
空白又以 118px 回来了** —— 等于把缺陷挪到别的分辨率上。最终**去掉上限**，
让"撑满"成为没有例外的规则。

**验收**（`m2-horizontal-compare-check` 从 18 项扩到 **22 / 22**）：
新增 4 条断言 —— 1600 / 1024 / 880px 三种窗口下手机视口的**作品渲染宽度 == 卡片宽度、
空白 ≤ 2px**，以及手机视口下切 1:1 也不留白。原有 18 条（含
**DPR 2.25 + 880 CSS 像素**复现用户屏幕）继续全部通过。

证据：`docs/evidence/m2-horizontal-compare-1789737093461.json`（交付实例）、
`docs/evidence/m2-horizontal-compare-1789736820208.json`（开发实例）；
截图 `docs/evidence/m2-horizontal-*.png`。

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

#### 附·反馈 1：外部插件能力必须由用户显式启用

> 这一条**不是 A01–A30 里的独立编号**，而是用户反馈 1 的直接要求的验收记录。
> 之所以不占用一个 A 编号，是因为 A01–A30 是固定验收标准（见`方案区/ACCEPTANCE.md`），
> 不能因为新增体验功能就改写编号。后续反馈类验收都按这个"附·反馈 N"的写法归档。

- 状态：**通过**（真实 DSH 8901，本机确实装着 `@dsh-external/dsh-prompt-optimizer`）
- 用户原话："提示词优化那个是一个插件来的，如果是别的插件的，得让用户自己选择是否加插件呀"
- 用户拍板的默认值：**默认关**（要用户自己去设置里打开）
- 实际结果（`m2-capability-walkthrough.mjs` **15/15**，全程**零模型费用**）：
  - 服务端确实探测到那个插件（`available: true`），但 `enabled: false` —— **探测 ≠ 启用**；
  - 关闭时"新建对比"页**不出现**优化区；
  - 关闭时即使**绕过界面直接打接口**也会被拒绝：`{ok:false, disabled:true}` 并说明原因
    （服务端兜底，不只是把界面藏起来）；
  - 设置页把"来源 / 作用 / 代价（会花钱）/ 当前状态"四件事都写给用户看；
  - 在设置里打开后优化区出现、按钮可用，且开关**放行**（用"空题目"在发起调用前被拒来证明
    已越过闸门，**没有花任何钱**）；
  - **重新加载页面后仍然是启用** —— 证明设置真的落盘，不是内存开关；
  - 关掉后优化区立刻消失，不用刷新页面。
- 持久化位置：**跟随数据目录**（`$DSH_HOME/html-arena/settings.json`），**不用 localStorage**。
  理由：换浏览器/换入口行为一致，且 M3 的展示包能把配置一起带走。
  单测 `tests/settings.test.js` **12/12**（含坏文件退回默认值、非布尔值不猜、未知键不写入）。
- 证据：`docs/evidence/m2-capability-1789724375376.json`；
  截图 `docs/evidence/m2cap-settings-off.png` / `m2cap-on-new-page.png`

#### 附·反馈 3：中途输入 = 追加轮次（与 F02 不冲突）

> 同样是用户反馈的直接要求（不是 A 编号），归档在这里说明它**为什么没有破坏 F02**，
> 以及为什么没有把 F02 改写成多轮对话。

- 状态：**通过**（接口级单测 + 浏览器全流程，全部零模型费用）
- 用户拍板方案：**方案 1 追加轮次**（原话："这个能不能就像正常的对话一样中途加东西能正常进行，方案1吧"）
- 关键结论：**流式接口上无法向已发出的请求追加消息**（消息在发起时已冻结）。
  所以"中途输入"实现为**新的一轮 attempt**，而不是插进当前这次流。
- **F02 未被改写**：每一轮仍然是一次逻辑请求 —— 实测两轮各自的 `observedRequests` 都是 **1**。
- 实际结果：
  - `tests/rounds.test.js` **6/6**：第 1 轮的原始正文 **hash 与内容逐字节不变**、
    第 2 轮的请求里确实带着"上一轮 user + 上一轮 assistant（**逐字节等于上一轮原始正文**）+ 本轮输入"、
    两轮各自 `observedRequests=1`；
  - **拒绝伪造**：上一轮没有正文（失败/取消）时返回 409 且**不留下半个 attempt**，
    绝不塞一条假的 assistant 消息；上一轮还在跑时也拒绝；空输入返回 400；
  - `m2-rounds-walkthrough.mjs` **15/15**（真实浏览器 + 模拟模型）：
    运行面板出现"第 2 轮"并高亮、新轮次挂在上一轮下、
    **"原始输出与提取结果"区按轮次逐行列出每一次尝试**、每行都能单独查看/下载、
    第 1 轮的原始正文 hash 未被改写、第 1 轮仍能单独下载。
- 没做什么（如实记录）：不做"只给差异片段再合并"，每一轮都要求模型给**完整**新版；
  不做多轮对话历史的管理界面（V1 范围内）。
- 证据：`docs/evidence/m2-rounds-1789723942932.json`；截图 `docs/evidence/m2rounds-round2.png`、`m2rounds-round-raw-list.png`

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

##### 第三轮反馈补充：水平展开比对（反馈 1，**根因是这个产品在窄屏上把并排关掉了**）

用户原话："这个得加一个水平展开比对的功能"。
**根因**：`web/app.css` 的 `@media (max-width: 900px) { .compare-grid { grid-template-columns: 1fr } }`。
用户截图是 1983 物理像素，但他那块屏 **DPR ≈ 2.25 → CSS 视口只有约 880px** → 命中该断点 →
插件把"并排比对"这个核心动作自动改成了上下堆叠。**这不是用户不会用，是真实的布局问题。**

**修法**：列数改由 `renderCompare()` **行内写死**（1 个候选 1 列，2–4 个候选**永远每行 2 个**、
同行 `minmax(0,1fr)` 等分），CSS 那条断点删除；窄视口另给两种读法
（「缩小看全」/「1:1 横向展开 + 左右同步滚动」）；"全屏"不再改网格列数（旧实现会改成单列，与并排冲突）。

**实测**（`node scripts/m2-horizontal-compare-check.mjs`，**18 / 18**，真实 Chromium 量 `getBoundingClientRect`）：

| 断言 | 结果 |
| --- | --- |
| 1983 / 900 / **880** / 700 / **480** px 下左右并排且同行等宽 | 全部通过（`900px → 426+426`，`880px → 416+416`，`480px → 216+216`，`y` 相同） |
| **DPR 2.25 + 880 CSS 像素（= 用户那块屏）下仍然左右并排** | 通过（`dpr: 2.25, cssWidth: 880, ys: [279, 279]`） |
| 1:1 横向展开：作品不再被缩小（scale = 1）、卡片可横滚（`overflow-x: auto`，`1280 > 414`） | 通过 |
| 同步滚动：拖左边 → 右边按同比例跟随（0.60 / 0.60） | 通过 |
| 同步滚动：**反向**拖右边 → 左边也跟随（0.15 / 0.15），不是单向 | 通过 |
| 关掉同步开关后左右不再联动（开关真的生效） | 通过 |
| 缩小看全：作品等比缩小放进卡片、卡片高度随之收窄、切模式不重建 iframe | 通过 |
| 全屏只隐藏别的卡片，**网格列数不变**（仍是 2 列），退出后恢复两个作品 | 通过 |

证据：`docs/evidence/m2-horizontal-compare-1789735758868.json`（18/18）；
截图 `docs/evidence/m2-horizontal-wide-880.png` / `m2-horizontal-wide-synced.png` /
`m2-horizontal-fit-880.png` / `m2-horizontal-dpr225.png` / `m2-horizontal-fullscreen.png`。

##### 第二轮反馈补充：对比页新增"展开配置"，且截图不再重置作品

- **新增"展开配置"面板**（用户反馈 4 的原话："最终的实验对比你得搞一个展开配置出来"）：
  实验级显示题目原文 / 输出要求 / 起始 HTML / taskHash / 运行上限 / 并发数 / 预览网络策略；
  每个候选显示 provider / model / 思考档位 / 温度 / 输出上限 / 第几轮 /
  **系统提示词与提示词片段** / 上下文窗口 / 可用思考档位 / 用量（缺失写"未上报"）/
  耗时（总/排队/首事件/首正文）/ 收尾原因 / **逻辑请求数** / 两个 hash / 字节数 /
  提取方式 / 提取告警 / 与 A 的差异 / 运行时错误；长文本一律可折叠。
  **服务端未改动** —— 这些字段本来就都在返回里，只是以前没渲染。
- **实测发现的同类缺陷（截图会重置作品）已修**：以前 `takeScreenshots()` 每完成一张截图
  就调一次 `renderCompare()`，四候选就是 4 次 `clear(compare-grid)` + 重建 iframe，
  用户在作品里的操作会被重置 4 次。现在截图面板在独立的 `#screenshot-panel` 里，
  **不碰作品网格**。
- 实测：`m2-four-walkthrough.mjs` **26/26**（原 8 项 + 18 项新断言，含盲选脱敏与"重绘后展开状态保持"）；
  `m2-screenshot-redraw-check.mjs` **6/6** —— 在三个作品里各写一个运行态标记、点截图、
  等全部完成，**标记全部存活**；并带对照组（主动点"重置"确实会清掉标记，证明探针有效）。
- 证据：`docs/evidence/m2-four-walkthrough-1789723412284.json`、
  `docs/evidence/m2-screenshot-redraw-1789723596183.json`；
  截图 `docs/evidence/m2-four-config-expanded.png`、`m2shot-after-screenshots.png`

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
##### 第二轮反馈补充：截图不再重建作品区

截图面板已从 `renderCompare()` 里拆出来（独立的 `#screenshot-panel`），
所以"每完成一张截图就重建一次作品 iframe"这个缺陷不再存在。
实测 `m2-screenshot-redraw-check.mjs` 6/6：三个作品里的运行态标记在整轮截图后全部存活，
iframe 的 **DOM 节点身份也被保留**（不是"重建后恢复"），并带对照组。
证据：`docs/evidence/m2-screenshot-redraw-1789723596183.json`。

##### M2 补充：截图失败也有正式记录（原"仍未测"这一半）

- **新增截图记录表**：每一次截图（成功与失败）都落一条，含视口、状态、原因、耗时与页面诊断计数。
  **只记状态与原因，不记图片本身**（图片是大对象，作品另有归档）。
- **实测**（`node scripts/m2-screenshot-failure-check.mjs`，**19/19**，零费用）：
  | 判据 | 实测 |
  | --- | --- |
  | 失败被判定，且原因可读 | 死循环作品：`status=timeout`、原因"子进程超过硬上限 15000ms 被强制终止" |
  | 失败也要尽力终止 | 整个调用 15.0 秒内返回，没有把插件拖死 |
  | 失败**落盘** | 重新读实验仍在（`screenshots[]`），带视口 `mobile`、状态、原因、耗时 15012ms |
  | 成功也留记录 | 对照组正常作品 `status=ok`，带视口与 1133ms 耗时 —— 记录不是"只有失败才写" |
  | 截图不动作品 | 失败前后作品 HTML 与原始正文的 hash **完全一致** |
  | 界面可见 | 刷新页面后，对比页截图区仍写着"截图未成功：子进程超过硬上限 15000ms 被强制终止（作品本身仍可预览）" |
- **顺带修掉两个由这套断言抓出来的界面缺陷**：
  1. 服务端记录**不保存图片**，于是刷新后"当时成功"的那条会被渲染成"截图未成功：未知原因" ——
     那是**假信息**；现在明确写"这条记录显示当时截图是成功的；图片没有随记录保存"。
  2. 截图记录可能属于**被重试顶掉的上一轮**，原先标签只会在"当前渲染的候选"里找，
     于是显示成一串 attempt id；现在在整个实验的尝试里找，标成"候选名 · 第 N 轮"。
- 证据：`docs/evidence/m2-screenshot-failure-*.json`、截图 `docs/evidence/m2-screenshot-failure-record.png`

#### A09 生成中重启宿主
- 状态：**通过**（真的把进程杀掉再起来，不是只跑一遍状态标记的逻辑）
- 脚本：`node scripts/m2-restart-recovery-check.mjs`，**23/23**（零费用，模拟模型）
- 做法：起一个开发服务器子进程跑两个候选（一个很快跑完、一个很慢），
  在"快的已完成、慢的正在流式输出"时 **SIGKILL** 掉整个进程，用**同一个数据目录**重新起一个，然后逐条核对：
  | 判据 | 实测 |
  | --- | --- |
  | 未完成标记中断 | 重启后那次尝试是 `interrupted`（不会永远停在 `running`），并写明"宿主重启、不会自动重跑、不会重新计费" |
  | 已完成作品可恢复 | 正文**逐字节不变**（3311 → 3311 字符），作品 HTML 仍可下载（3286 字节） |
  | 不自动重付费 | attempt 数量不变（2 → 2），**模型调用日志行数不变**（2 → 2）—— 重启后没有发生任何新的模型调用 |
  | 不伪造记录 | 中断那次 `finishedAt=null`、`usage=null`（没有编一个收尾时间或用量） |
  | 界面 | 对比页显示可读原因（"生成过程中宿主重启了…"），并给出"下载中断前的部分输出（64 字符）"按钮 |
  | 用户仍能继续 | 显式点"重试"才新建 attempt（2 → 3，模型调用 2 → 3），新一轮正常跑完并产出作品 |
- **本轮实测暴露并修掉的一个真缺陷**：`markInterrupted` 原先只写在宿主半边（`src/index.js`），
  开发服务器没有 —— 于是"重启后未完成仍标 running"这个缺陷在**零费用的开发服务器上根本复现不出来**。
  已抽成 `core/runtime.js` 的 `recoverUnfinishedAttempts()`，两边共用（与当年"实时流缓冲只有宿主半边有"是同一类错误）。
- **顺带补上的一件事**：宿主被**硬杀**时，内存里的实时缓冲会一起消失，而 `raw.txt` 要等流结束才写 ——
  原先"生成到一半被杀"留下的是一条**没有任何正文**的记录，而界面上却写着"已保留内容"。
  现在生成过程中每 1.5 秒把已收到的正文刷到 `partial` 文件（上限 256KB，超出则标记只留前段），
  跑完（无论成功失败）就删掉它，`raw.txt` 仍是唯一权威正文。实测：被杀之前磁盘上已有 64 字符的 partial，
  重启后仍能下载，界面按钮写的字符数与它一致。
- 证据：`docs/evidence/m2-restart-recovery-*.json`、截图 `docs/evidence/m2-restart-interrupted.png`；
  单测 `tests/stability.test.js` 的 A09 三条（标记、不新建 attempt、partial 生命周期）

#### A20 作品弹窗 / 顶层跳转 / 请求本机 API
- 状态：**通过**（真实 Chromium，走产品真正的预览通路）
- 实测（`node scripts/m0-isolation-experiment.mjs`，**11/11 全部通过**，含对照组）：
  - `window.open("https://example.com")` → **无弹窗产生**（实测弹窗列表为空）；
  - `top.location.href = "https://example.com"` → **被阻止：SecurityError**；
  - 作品向宿主本机 API 发 `fetch("/host-vote", {method:"POST"})` → **被阻止：TypeError: Failed to fetch**；
  - 对照组（故意换成含 `allow-same-origin` 的不安全 sandbox）：`localStorage` 变成可写 ——
    证明上面的"被阻止"是隔离真的起作用，不是碰巧没触发。
- 组合手段：独立源预览服务 + `sandbox="allow-scripts allow-forms"`（**不含** `allow-same-origin`）
  + 响应头 CSP + postMessage 校验。
- 证据：`docs/evidence/m0-isolation-1789740490125.json` 的 `summary`（`E2b 宿主 API 不可达`、
  `E2c 无弹窗`、`E1/E1b 宿主存储不可读`、`对照：不安全 sandbox 确实更弱`）；
  `tests/policy.test.js`
- 备注：这些证据 M1 末就已取得（当时记在"未测表"的注释里），本轮按 A 编号正式归档。

#### A21 作品无限循环与大量日志
- 状态：**通过**（硬上限终止 + 主进程仍可响应）
- 实测（同一次隔离试验）：
  - 死循环 + 大量日志的作品：采集在 **4 秒硬上限**被**强制终止**（`captureStatus=timeout`、
    `hardTerminated=true`，实测 9051ms 内返回 —— 含浏览器启动时间）；
  - 终止之后宿主进程**仍然可响应**：实测往返延迟 **25ms**；
  - 预览承载是**独立子进程**，所以"能不能终止"不依赖作品自己愿意停下（F14 的原始要求）。
- 另外（M2 补的正式记录）：把同一个死循环作品接到产品的截图接口上，失败会**落盘**成一条记录
  （状态 + 原因 + 耗时 + 视口），刷新页面仍看得到 —— 见 A23 的 M2 补充。
- 证据：`docs/evidence/m0-isolation-1789740490125.json` 的 `E3 死循环可终止且主进程不受影响`；
  `docs/evidence/m2-screenshot-failure-*.json`

#### A29 更新插件后打开旧实验
- 状态：**通过**（本轮数据 schema 从 1 升到 2，是一次**真实**的迁移）
- 实测：
  - **真实数据目录**：DSH 测试实例（8902）里已有 30 条实验、上百个 attempt，插件升级到 0.4.0
    重启后，全部照常列出、打开、下载，没有丢数据（迁移在打开时增量完成）。
  - **单测**：造一个"老库"（schema=1 且 attempts 表没有配方引用列）→ 新版本打开后：
    新表与两列被补上、`meta.schema_version` 变成 2、老记录的快照与状态**原样**、迁移只跑一次（幂等）。
  - 未来版本保护：数据目录被**更新**版本写过时，明确拒绝打开并提示升级，而不是猜着读。
- 证据：`tests/recipes.test.js`「schema 1 → 2 迁移」；`tests/store.test.js`「schema 版本守卫」

---

### 部分通过

#### A03 复制候选只修改提示词
- 状态：**通过**（M2 补齐了原"部分通过"里缺的那一半：配方对象与版本化）
- 差异可见（M1 已有，继续有效）：复制候选后，与原卡不同的字段会在界面上高亮并列出
  （模型来源/模型/系统提示词/温度/输出上限/思考档位/提示词片段）。
- **M2 新增：配方快照与版本（原来的"未测"部分）**
  - 新增配方对象：`recipes` + `recipe_versions` 两张表（数据 schema 1 → 2，增量迁移）。
    **版本只追加，没有任何 UPDATE 已有版本的代码路径**；每一版自带 `content_hash`。
  - attempt 里存的是**启动时那一版的快照**（深拷贝），另有 `recipe_id`/`recipe_version`
    只作溯源。所以"配方后来改了"永远不会回头改写历史实验（F19）。
  - 内容口径只有一份（`src/core/recipe.js`）：只把"会影响这次调用"的字段算作配方内容，
    槽位/时间戳这类运行期字段不参与指纹 —— 否则同一份内容会算出不同指纹。
  - 内容与当前版完全一致时**不新增版本**，并如实回 `unchanged`（不制造没有区别的版本，也不假装存了）。
- **实测（三层，全部零模型费用）**：
  | 层 | 脚本 | 结果 |
  | --- | --- | --- |
  | 存储/接口 | `tests/recipes.test.js` | **6/6**（含"改内容生成第 2 版后，第 1 版内容与指纹逐字节不变"、schema 1→2 迁移后老记录原样） |
  | 界面全流程 | `scripts/m2-recipes-check.mjs` | **15/15**（候选卡保存 → 第 1 版；只改系统提示词再存 → 第 2 版且第 1 版标"历史，只读"；用第 1 版开新一轮 → 对比页写明"配方来源：第 1 版"；再把配方改成第 3 版 → 那条历史实验的配置**一个字都没变**） |
  | 引用校验 | `tests/recipes.test.js` | 引用不存在的版本 → 400 且**不留下半个 attempt**（不用别的版本顶替） |
- 实测数据（界面脚本里的真实取值）：第 1 版指纹 `294b8c5ce8…` 在第 2、3 版之后**仍然是它**。
- 证据：`docs/evidence/m2-recipes-*.json`、截图 `docs/evidence/m2-recipes-versions.png`

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
- 状态：**通过**（M2 补齐了超时路径与"不污染新 attempt"）
- 取消（M1 已有，继续有效）：**真实模型**取消——3 s 后中止，`status=cancelled`、`finish=aborted`、
  已收到的内容保留、未上报的用量保持 null、不自动重试。
- **M2 新增：超时真正被执行**
  - 之前 `outputPolicy.timeoutMs` 只是**存下来了**，从没有人用它去中止调用（这正是"未测"的原因）。
    现在 `core/runtime.js` 按本轮上限起一个计时器，到点**尽力中止**（abort）并把这次尝试记成
    `timed_out` + `finishReason=timeout` + `errorCode=TIMEOUT`。
  - **超时与取消是两件事**：原因不同、下一步不同，界面与收据分别记录，互不覆盖。
  - 到点之后流可能还没收尾（服务端不一定立刻停），这段时间 `/live` 会报 `timedOut: true`，
    界面显示"已到运行上限，正在尽力中止…"，不会一直显示"生成中"。
- **"后续输出不污染新 attempt" 的实测口径**（不是"看起来没串台"）：
  - 同一批里放一个**忽略中止信号**的候选（超时后仍继续吐十几秒）和一个正常候选：
    正常候选的正文与作品 HTML 里 **0 处**出现那个候选的迟到标记；它照样 `completed`。
  - 在"已超时但仍在吐"的窗口里再开一轮（= 用户点重试）：新一轮的正文长度**等于一次完整输出**
    （没有把上一轮的迟到内容拼进来），并且它的正文 hash / 作品 hash 都能**从磁盘内容重新算出来**。
- 实测：`node scripts/m2-timeout-check.mjs` **24/24**（零费用，模拟模型；含取消与超时分开、
  超时不自动重试、界面显示"超时"与可读原因、展开配置里写明 `timeout`）；
  单测 `tests/stability.test.js` 里另有 3 条同口径断言（含"迟到输出仍在飞时开新 attempt"）。
- 证据：`docs/evidence/m2-timeout-*.json`、截图 `docs/evidence/m2-timeout-state.png`；
  `tests/runner.test.js`、`tests/stability.test.js`

---

### 未测（属于后续里程碑）

| ID | 场景 | 计划 |
| --- | --- | --- |
| A10 | 输入超过大小限制 | M2 尾 / M3：已实现并有单测（题目 5 万字符、起始 HTML 2MB，明确拒绝且不截断），**真实界面尚未手工验证** |
| A17 | 外部 CDN 资源不可达 | M3（CDN 白名单与策略已实现，未在真实网络下验证） |
| A18 | 模型不返回 Token | M2 尾：已实现（缺失字段存 null、界面显示"未上报"），模拟模型覆盖边界；**两轮真实调用里两个模型都上报了用量**，没有遇到真实模型不上报的情形 —— 这一条要等真实模型自己不上报才算测到 |
| A24 | 展示包在干净机器打开 | M3 |
| A25 | 复测包导入另一安装 | M3 |
| A26 | ZIP 路径穿越 / 超大压缩包 | M3 |
| A27 | 导出包与日志不含私密数据 | M3（当前保存的错误字段已是白名单） |
| A28 | 连续十轮并停止全部预览 | M2 尾（订阅去重与资源回收已实现，尚未做十轮连续实测） |

> M2 把 A09 / A20 / A21 / A29 从这张表里移走了 —— 它们现在都有按 A 编号写成的正式小节与实测证据
> （A20 / A21 的证据来自重跑的 `node scripts/m0-isolation-experiment.mjs`：**11/11 全部通过**，
> 其中 E2b / E2c / E1 / E1b 对应 A20，E3 对应 A21；证据 `docs/evidence/m0-isolation-1789740490125.json`）。
> 这张表里**只留真的没测的**。

---

## 附：本轮（第二轮反馈）回归基线

改动 `web/app.js` 与 `src/` 之后**整套重跑**，全部为实际执行结果：

| 套件 | 命令 | 结果 |
| --- | --- | --- |
| 单元与集成测试 | `node --test "tests/**/*.test.js"` | **95 / 95 通过**（原 77 + 12 设置 + 6 追加轮次） |
| 界面演练（模拟模型） | `node scripts/ui-walkthrough.mjs --base http://127.0.0.1:8790` | **19 步全通过**，0 控制台错误、0 页面异常、0 非 2xx |
| 第二轮反馈主验收 | `node scripts/m2-regression-walkthrough.mjs` | **13 / 13 通过** |
| 截图不重置作品 | `node scripts/m2-screenshot-redraw-check.mjs` | **6 / 6 通过**（含对照组） |
| 外部能力开关 | `node scripts/m2-capability-walkthrough.mjs --base :8901` | **15 / 15 通过** |
| 追加轮次 | `node scripts/m2-rounds-walkthrough.mjs` | **15 / 15 通过** |
| 四候选对比页（含展开配置 18 项新断言） | `node scripts/m2-four-walkthrough.mjs --base :8901 --title "M2 四候选对比"` | **26 / 26 通过** |
| 对比页 A14/A15/A16/A23（真实 DSH + 真实模型作品） | `node scripts/m1-compare-walkthrough.mjs --base :8901 --title "M2 实时监控验证" --fail-title "M1 真实对比"` | **27 / 27 通过**（含 A15 完整盲选主流程：隐藏 → 评价 → 揭晓） |
| 六类样例 | `node scripts/m1-samples-check.mjs` | **6 / 6 通过** |
| M2 界面三项 | `node scripts/m2-ui-walkthrough.mjs --base :8901 --skip-optimize` | **13 / 13 通过** |

**本轮没有发起任何真实模型调用的付费测试** —— 所有新功能都用模拟模型或已存在的实验数据验证。
其中"外部能力开关"那一套用"空题目在发起调用前被拒"来证明开关确实放行，**零费用**。


---

## 附：M2 回归基线（改动 `web/` 与 `src/` 后整套重跑）

**全部为实际执行结果，全部零模型费用。**

| 套件 | 命令 | 结果 |
| --- | --- | --- |
| 单元与集成测试 | `node --test "tests/**/*.test.js"` | **107 / 107 通过**（原 95 + 配方 6 + 稳定性 6） |
| M0 隔离试验（A20/A21 归档） | `node scripts/m0-isolation-experiment.mjs` | **11 / 11 通过**（含对照组） |
| 界面演练（模拟模型） | `node scripts/ui-walkthrough.mjs --base http://127.0.0.1:8790` | **19 步全通过**，0 控制台错误 / 0 页面异常 / 0 非 2xx |
| **配方版本界面全流程（本轮新增）** | `node scripts/m2-recipes-check.mjs` | **15 / 15 通过** |
| **宿主重启恢复（本轮新增，真 SIGKILL）** | `node scripts/m2-restart-recovery-check.mjs` | **23 / 23 通过** |
| **超时与取消（本轮新增）** | `node scripts/m2-timeout-check.mjs` | **24 / 24 通过** |
| **截图失败记录（本轮新增）** | `node scripts/m2-screenshot-failure-check.mjs` | **19 / 19 通过** |
| 重绘不打断操作 | `node scripts/m2-regression-walkthrough.mjs` | **13 / 13 通过** |
| 截图不重置作品 | `node scripts/m2-screenshot-redraw-check.mjs` | **6 / 6 通过**（含对照组） |
| 外部能力开关 | `node scripts/m2-capability-walkthrough.mjs --base :8902` | **15 / 15 通过** |
| 追加轮次 | `node scripts/m2-rounds-walkthrough.mjs` | **15 / 15 通过** |
| 四候选对比页 + 展开配置 | `node scripts/m2-four-walkthrough.mjs --base :8902 --title "M2 四候选对比"` | **27 / 27 通过** |
| 用量与速度（含"未上报不写 0"） | `node scripts/m2-usage-metrics-check.mjs` | **22 / 22 通过** |
| 水平展开比对 + 手机视口撑满 | `node scripts/m2-horizontal-compare-check.mjs --base :8902` | **22 / 22 通过** |
| 对比页 A14/A15/A16/A23（真实 DSH + 真实模型作品） | `node scripts/m1-compare-walkthrough.mjs --base :8902 --title "M2 实时监控验证" --fail-title "M1 真实对比"` | **27 / 27 通过**（含 A15 完整盲选主流程） |
| 六类样例 | `node scripts/m1-samples-check.mjs` | **6 / 6 类通过** |
| M2 界面三项 | `node scripts/m2-ui-walkthrough.mjs --base :8902 --skip-optimize` | **13 / 13 通过** |
| 交付包冒烟（**全新 profile 装 v0.4.0 的 tgz**） | `node scripts/delivery-smoke.mjs --base :8908 --expect-version 0.4.0` | **23 / 23 通过** |

**本轮没有发起任何真实模型调用的付费测试。** 新功能全部用模拟模型或**已存在的真实实验数据**验证。

> 一条留档的插曲：`m2-usage-metrics-check` 与 `m1-compare-walkthrough` 第一次跑时，
> 因为**盲选类断言的硬前置条件**（实验必须尚未揭晓）不满足而**主动跳过/中止** ——
> 这是上一轮加的守卫在起作用（宁可不测，也不拿已揭晓的画面去断言脱敏）。
> 换成一条未揭晓的实验后：**22/22** 与 **27/27**。

---

## 附：模拟与真实的分界

| 类型 | 用在哪儿 | 是否可作验收证据 |
| --- | --- | --- |
| 模拟模型（`scripts/simulated-llm.mjs`） | 队列、失败、多块、无 HTML、截断，以及本轮新增的**先推理再输出**（`sim-reasoning`）等边界的稳定复现 | **不能**单独作为真实调用验收；只用于稳定复现边界 |
| 已存在的真实模型实验数据 | 对比页 / 四候选 / 盲选等界面断言（打开旧实验，不发起新调用） | 是（作品是真实模型产出的，只是本轮没有重新付费调用） |
| 真实模型（deepseek-official / deepseek-flash） | 真实调用、提取、取消 | 是 |
| 固定样例（`scripts/samples.mjs`） | 预览隔离与六类作品可操作性 | 是（明确标注为固定测试样本，不是模型输出） |

模拟模型返回的文本里带「这是模拟模型的说明」，产物不会被误认为真实结果。
