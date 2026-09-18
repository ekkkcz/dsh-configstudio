# HTML Arena

把**同一道创作题**交给 2–4 套模型 / 提示词配置，各自生成一个单文件 HTML，
然后并排操作、隐藏配置身份做偏好选择、下载原始输出、保存配方。

这是一个 **DSH（DeepSeek Harness）Web 插件**。当前版本 `0.3.1`，
状态是 **M1 首次可玩版 + 三轮试玩反馈已落地**（见 `docs/progress.md`），**不是完整 V1**。

---

## 它做什么

- **一道题，多路生成**：为每个候选独立选择 DSH 里已配置的 provider 与 model，
  可分别填写系统提示词、提示词片段、温度、输出上限、思考档位。
- **一次逻辑请求**：每个候选走一次单次模型调用，不开启工具循环、不自动修复结果。
  逻辑请求数 = 网络请求数（插件直调不会被宿主自动重试）。
- **作品是主角**：对比页**始终**每行两个作品、同行等宽、使用同一个逻辑视口，
  因此同一份响应式页面必然落到相同断点。窄视口不再自动改成上下堆叠 ——
  改为「缩小看全」（默认）与「1:1 横向展开 + 左右同步滚动」两种读法，
  并按需切换手机 / 桌面视口、重置、放大单个作品。
- **用量与速度就在作品卡下面**：输入 / 输出 / 合计 / 推理 tokens、总速度、首正文延迟、总耗时，
  不用展开折叠面板。速度口径是 `outputTokens ÷ (结束 − 开始)` ——
  **不**用"首正文之后的时间"当分母（推理型模型会先吐大量 reasoning token，那样会虚高数倍）。
  未上报的字段写"未上报"，不写 0。
- **隐藏配置身份**：评分前隐藏模型与配方名（不承诺严格双盲——作品内容本身可能写出模型名），
  事后可揭晓。
- **如实记录**：截断、识别失败、模型报错、用量缺失都显式标注。
  用量缺失显示"未上报"，不显示 0；收尾原因未知就显示未知，不猜。
- **不偷偷改你的东西**：题目或起始 HTML 超限会**明确拒绝**，绝不静默截断后发送。
  多块 HTML 不拼接，交给你选。

## 它不做什么（当前版本）

- 没有展示包 / 复测包的导入导出（界面按钮置灰并标注"M3 提供"）。
- 没有配方版本管理。
- 没有参考图输入、多次采样、交互后截图（属 V1.1）。
- 不做真实 Skill 加载或工具使用对比。

---

## 安装

前置：已安装 DSH（本插件针对 `0.1.6-alpha.2` 开发并验证），
并且你已经配置好至少两个模型 provider。

```powershell
# 装进你日常使用的 web profile
dsh plugin --profile web add <本目录的绝对路径>

# 或者先建一个隔离的测试 profile（推荐先这样试）
dsh --profile arena-test --from-default-profile web --dump-config
dsh plugin --profile arena-test add <本目录的绝对路径>
```

安装后**重启 DSH**，然后在 Web 界面左侧找到「HTML 对比」入口。

卸载：

```powershell
dsh plugin --profile <profile> remove '@dsh-external/html-arena'
```

卸载**不会**删除你的实验记录（数据在 `$DSH_HOME/html-arena`）。

### 可选的截图能力

初始截图功能需要一个可用的浏览器运行时。本机若有 Playwright + Chromium 会自动发现
（插件会依次尝试 DSH checkout 内、全局 `npm` 下的 `playwright`）；
找不到时截图会明确标注"未检查"，**生成与预览不受影响**。

```powershell
npm i -g playwright
npx playwright install chromium
# 或者指定一个已知含 playwright 的目录：
#   设置环境变量 HTML_ARENA_PLAYWRIGHT_ANCHOR
```

---

## 试玩（3–5 步）

1. 打开 DSH Web，点左侧「**HTML 对比**」。
2. 点「**试一个示例**」→ 题目和输出要求自动填好。
3. 在两张候选卡上各选一个**不同的**模型（候选卡上可展开填写系统提示词与参数）。
4. 点「**开始生成**」。运行面板会显示排队 / 生成中 / 已完成 / 失败。
5. 两个都完成后点「**进入对比**」。可以切视口、隐藏配置身份、选偏好并保存。

想验证"一个失败不影响另一个"：把候选 B 的模型换成一个凭据不对的 provider，
两边会各自给出结果。

---

## 界面之外：命令行验证

```powershell
node --test "tests/**/*.test.js"          # 单元与集成测试（模拟模型，零费用）
node scripts/dsh-contract-check.mjs       # DSH 契约只读探测（升级 DSH 后跑）
node scripts/dev-server.mjs --port 8790   # 不开 DSH 也能跑完整插件（模拟模型）
```

开发服务器起来后打开 <http://127.0.0.1:8790/html-arena/api/ui>。

---

## 数据与隐私

- 实验记录、原始输出、作品 HTML 都在本机 `$DSH_HOME/html-arena`。
- **插件不读、不保存、不复制你的 API key**。调用时只给出 `provider` 与 `model`，
  凭据由 DSH 的适配器自己解析（见 `docs/dsh-integration.md` 第 2.7 节）。
- 保存的模型错误只取白名单字段（code / message / status / requestId），不外泄完整请求头。

---

## 文档

| 文件 | 内容 |
| --- | --- |
| `docs/progress.md` | 当前进度、关键决定、已知限制、下一步 |
| `docs/acceptance.md` | A01–A30 的实际执行证据 |
| `docs/dsh-integration.md` | DSH 接口核查结果与实测踩到的坑 |
| `docs/evidence/` | 机器可读的实测证据（JSON）与截图 |

---

## 许可

MIT（待发布前最终确认并与仓库 LICENSE 一致）。
本项目为独立插件，与 DeepSeek Harness 官方仓库无隶属关系。
