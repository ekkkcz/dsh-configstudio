# ConfigStudio · 配置实验室

**比较什么，由你决定。效果如何，并排看。**

一个 DSH（DeepSeek Harness）Web 插件：同一道题，交给 2–4 套自定义配置生成，并排体验、盲选、保存与分享复测。

同模型换提示词或参数，不同模型保持其他设置一致，或自由搭配整套方案——你选择要改变的变量。当前支持单文件 HTML，适合动画、交互原型与创意页面。

[快速开始](#快速开始) · [使用指南](docs/usage.md) · [更新记录](CHANGELOG.md) · [开发文档](docs/development.md)

![同题生成：两套配置各自完成「鹈鹕骑自行车」，并排体验结果](docs/evidence/pelican-compare-page.png)

## 核心功能

- **自定义对照**：独立设置模型、系统提示词、提示词片段、温度、输出上限与思考档位，可用项取决于模型与 DSH 的支持情况。
- **并排体验**：统一预览尺寸，切换手机 / 桌面视口，直接操作作品；同时查看用量与耗时。
- **盲选与揭晓**：隐藏配置身份和用量信息，先凭作品记录偏好，再揭晓配置。
- **保存与复测**：配置保存为可复用的「配方」，保留版本与实验历史；导出展示包供人查看，或导出复测包供人重跑。

<details>
<summary>更多截图：四套配置对照 / 隐藏身份盲选</summary>

**四套配置，同一道「秦始皇骑北极熊」。**

![四套配置的生成结果，每行两个作品](docs/evidence/m2-four-candidates.png)

**隐藏配置身份，先体验，再选择。**

![动态太阳系：隐藏模型身份与用量信息后进行盲选](docs/evidence/m2-usage-strip-blind.png)

</details>

## 快速开始

需要 **Node.js ≥ 22.5**、已安装的 **DSH**，以及至少一个可调用的模型服务。当前验证环境为 Windows 11 + Chromium，DSH `0.1.6-alpha.2`。

插件直接从源码目录安装，无需构建。以下命令使用 PowerShell。

```powershell
git clone https://github.com/ekkkcz/dsh-configstudio.git
cd dsh-configstudio

# 安装到已有的 Web profile（将 web 替换为你的 profile 名）
dsh plugin --profile web add (Get-Location).Path
```

重启对应 profile 的 DSH，在 Web 侧栏打开 **配置对比**：

1. 写一道题，或点击 **试一个示例**。
2. 设置 2–4 套配置，点击 **开始生成**。
3. 进入对比，体验作品、盲选并保存评价；按需保存配方或导出。

> 新建 profile 时，请先从默认 Web 配置创建，再安装插件，避免缺少 Web 界面。详见[安装与排查](docs/usage.md#安装与排查)。

想先体验流程，可以运行模拟模式，无需调用模型：

```powershell
node scripts/dev-server.mjs --port 8790
```

打开 <http://127.0.0.1:8790/configstudio/api/ui>。该模式使用模拟结果，不产生模型调用费用。

## 使用说明

- **费用**：插件免费，模型调用按所用服务计费。每个候选每轮一次调用，失败不自动重试。
- **数据**：实验保存在本机，凭据由 DSH 管理；模型请求发送至你配置的服务。导出包由你自行分享。
- **当前范围**：支持单次生成对照，尚不支持参考图输入、批量多次采样、交互后截图或真实工具 / Skill 调用对照。

更多操作、截图依赖、超时与空白作品排查，见[使用指南](docs/usage.md)。最新变更见[更新记录](CHANGELOG.md)。

## 文档

| 文档 | 内容 |
| --- | --- |
| [使用指南](docs/usage.md) | 安装、对照、配方、导出与常见问题 |
| [开发与验证](docs/development.md) | 本地运行、测试与回归检查 |
| [架构说明](docs/architecture.md) | 模块分工与数据流 |
| [DSH 接入](docs/dsh-integration.md) | 宿主接口与兼容性记录 |
| [验收记录](docs/acceptance.md) | 验证结果与已知缺口 |
| [截图与演示](docs/evidence/demo/) | 实际生成结果与演示素材 |

## 许可

[MIT](LICENSE) · [第三方说明](docs/third-party-notices.md)

本项目为独立插件，与 DeepSeek Harness 官方仓库无隶属关系。
