# 变更记录

## 0.1.0 —— M1 首次可玩版（阶段试玩，非完整 V1）

首次用**两个不同的真实模型**跑通同一道题的完整对比流程（A02 / A30 的第一批真实证据）。

修正（全部来自 M1 的真实浏览器 / 真实模型实测）：
- 保存评价后"揭晓身份"按钮不出现，盲选流程卡住（`web/app.js` 的 `saveVote` 没有刷新按钮）。
- 隐藏配置身份期间，折叠的"配置差异"面板仍直接写出 provider / model（点开即泄露）。
- 揭晓后作品卡只显示候选名 A / B，看不出谁是谁；现在直接写出 provider / model。
- 开发服务器缺少 `runtime.llmOf`，`/models` 与 `/models/resolve` 返回 500，界面拿不到模型目录。

新增：
- M1 实测脚本 `scripts/m1-*.mjs` 与对应 npm 脚本（`m1:compare` / `m1:probe` / `m1:a02` / `m1:samples` / `m1:walkthrough`）。

## 0.0.1 （未发布，M0 开发中）
- 项目初始化：DSH 外部 bundle 插件骨架、自有 HTTP 服务、预览隔离、HTML 提取器、SQLite 存储。
