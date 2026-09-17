# HTML Arena 验收记录（A01–A30）

> 标准定义见 `方案区/ACCEPTANCE.md`。本文件只记录**实际执行结果**。
> 状态取值：通过 / 失败 / 未测 / 阻塞。
> **没有证据不能标通过**；模拟与真实调用分开标注。

记录版本：插件 0.0.1（未发布，M0）　DSH 0.1.6-alpha.2　Node v24.15.0
参考机器：Windows 11 桌面，Chromium（Playwright 捆绑 chromium-1243）
证据目录：`docs/evidence/`

---

## 参考机器（M0 自动记录）

| 项 | 值 |
| --- | --- |
| 操作系统 | Windows（`process.platform win32`） |
| Node | v24.15.0 |
| DSH | 0.1.6-alpha.2（`dsh --version` 与安装包 package.json 一致） |
| Chromium | Playwright chromium-1243 + headless shell（两个 playwright 候选均可启动） |
| 数据目录 | `$DSH_HOME/html-arena`（开发时用 `html-arena/dev-data`） |

---

## 状态总览

| 状态 | 数量 |
| --- | --- |
| 通过 | 9 |
| 部分通过 | 5 |
| 未测 | 15 |
| 失败 | 0 |
| 阻塞 | 0 |

> 说明：M0 只覆盖"接入与边界"。大量条目属于 M1–M4 范围，此时标"未测"是如实记录，
> 不是遗漏。**完整 V1 要求全部必需项有通过证据**，当前远未达到。

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
- 状态：**通过**（401 实测；429/500 走同一代码路径）
- 步骤：模拟 llm 让第 2 个候选返回 `finish{kind:'error',failure:{code:'AUTH',status:401}}`。
- 实际结果：候选 B `status=failed`、`error.code=AUTH`、附带人能读懂的原因与下一步；
  候选 A 正常 `completed` 并有作品；实验列表显示"成功 1 失败/中断 1"。
  保存的字段只有白名单（code/message/status/requestId），额外的自定义字段被丢弃。
- 证据：`tests/api.e2e.test.js`「一个候选 401 失败，另一个继续成功」；`tests/runner.test.js`
- 未覆盖：429 与 500 的真实响应。列入 M1（真实模型验证批次）。

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
- 状态：**通过**（身份隐藏；映射稳定；绑定作品 hash）
- 实际结果：揭晓前响应里**不出现**模型 id 与配方名（测试断言序列化结果中不含 `pa-m1` 与自定义配方名）；
  匿名映射按候选槽排序固定，重复读取一致；投票条目带 64 位作品 hash；
  揭晓后才返回 provider / model / name。
- 证据：`tests/api.e2e.test.js`「盲选：揭晓前不出现模型身份…」
- 备注：作品页面内容本身可能写出模型名，所以产品称"隐藏配置身份"，不承诺严格双盲（与 PRD 4.4 一致）。

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
- **未测**：温度与输出上限的"不受支持"判定——适配器没有上报这两个维度的支持情况，
  界面对温度统一显示"未指定"，没有伪造支持结论。列入 M2。
- 证据：`tests/api.e2e.test.js`「开始前阻止不受支持的思考档位」

#### A06 四候选并发设置为二
- 状态：**部分通过**
- 已实现：并发闸门默认 2、可选 1；四候选受理与排队逻辑存在（`ConcurrencyGate`）。
- **未测**：四候选 + 并发 2 下"仅两路同时生成、完成后队列推进"的真实观测。列入 M2。
- 证据：`src/api.js` 的 `ConcurrencyGate`

#### A08 中途取消与超时
- 状态：**部分通过**
- 已通过：**真实模型**取消——3 s 后中止，`status=cancelled`、`finish=aborted`、
  已收到的内容保留、未上报的用量保持 null、不自动重试。
- **未测**：超时路径（`defaultTimeoutMs` 已配置但没有触发过真实超时）；
  "后续输出不污染新 attempt"依赖"重试新建 attempt"的设计（已实现，未做并发观测）。列入 M2。
- 证据：真实调用验证 C 段（见 `docs/evidence/` 与本节"实际结果"）；`tests/runner.test.js`

#### A23 生成截图并重放
- 状态：**部分通过**
- 已通过：截图带视口（1280x720）、DPR、等待时间、网络策略与"初始状态"说明文字；
  从初始状态重新加载获得；本机浏览器不可用时如实报告"未检查"而不是伪造成功。
  浏览器演练中成功生成 1 张截图。
- **未测**：截图失败路径的显式记录（例如故意让页面永不 load）；死循环作品的截图超时行为已观测到
  （`screenshot_failed` + 硬终止），但未纳入 A23 正式记录。列入 M2。
- 证据：`docs/evidence/ui-walkthrough-*.json` 步骤「初始截图」；`docs/evidence/m0-isolation-*.json` 的 E6

---

### 未测（属于后续里程碑）

| ID | 场景 | 计划 |
| --- | --- | --- |
| A02 | 两个真实模型跑同一题 | M1（第一批真实证据） |
| A09 | 生成中重启宿主 | M2（目前只做了状态标记 `interrupted`） |
| A10 | 输入超过大小限制 | 已实现并有单测（题目 5 万字符、起始 HTML 2MB，明确拒绝且不截断），**真实界面未手工验证** → M1 |
| A13 | 六类样例 HTML 逐一可操作 | M1（样例已就位：`scripts/samples.mjs`） |
| A14 | 切换左右作品与不同视口 | M1（视口切换与独立重置已实现，浏览器演练已验证手机视口与缩放） |
| A16 | 一个作品不能预览 | M1（失败占位已实现并被演练覆盖，需正式记录） |
| A17 | 外部 CDN 资源不可达 | M3（CDN 白名单与策略已实现，未在真实网络下验证） |
| A18 | 模型不返回 Token | M1（已实现：缺失字段存 null、界面显示"未上报"；模拟模型中第二候选故意不报 usage） |
| A20 | 作品弹窗 / 顶层跳转 / 请求本机 API | M1（隔离试验已验证：无弹窗、`top.location` 抛 SecurityError、本机 API 不可达） |
| A21 | 无限循环与大量日志 | M1（隔离试验已验证：4 s 硬上限终止、主进程仍可响应，`responsiveLatencyMs=11`） |
| A24 | 展示包在干净机器打开 | M3 |
| A25 | 复测包导入另一安装 | M3 |
| A26 | ZIP 路径穿越 / 超大压缩包 | M3 |
| A27 | 导出包与日志不含私密数据 | M3（当前保存的错误字段已是白名单） |
| A28 | 连续十轮并停止全部预览 | M2 |
| A29 | 更新插件后打开旧实验 | M2（目前有 schema 版本守卫：未来版本的数据目录拒绝打开并给出提示） |
| A30 | 两个真实模型完整流程 | M1（导出 / 导入属 M3，届时补齐） |

---

## 附：模拟与真实的分界

| 类型 | 用在哪儿 | 是否可作验收证据 |
| --- | --- | --- |
| 模拟模型（`scripts/simulated-llm.mjs`） | 队列、失败、多块、无 HTML、截断等边界的稳定复现 | **不能**单独作为真实调用验收；只用于稳定复现边界 |
| 真实模型（deepseek-official / deepseek-flash） | 真实调用、提取、取消 | 是 |
| 固定样例（`scripts/samples.mjs`） | 预览隔离与六类作品可操作性 | 是（明确标注为固定测试样本，不是模型输出） |

模拟模型返回的文本里带「这是模拟模型的说明」，产物不会被误认为真实结果。
