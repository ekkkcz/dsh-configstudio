# 第三方来源与许可证清单

本插件**自身**（`html-arena/` 下的源码）以 MIT 许可发布，见仓库根目录 `LICENSE`。

这份文件回答一个具体问题：**我装了这个插件之后，机器上多了哪些别人的东西、它们各是什么许可。**

---

## 1 运行期依赖：没有第三方运行时依赖

这是本插件的一个刻意选择，不是偶然结果。

| 类别 | 实际情况 |
| --- | --- |
| npm 运行时依赖 | **0 个**（`package.json` 里没有 `dependencies`） |
| 打包进交付 tgz 的第三方代码 | **0 个**（`files` 只有 `src` / `web` / `cordis.patch.yml` / `README.md` / `CHANGELOG.md`） |
| 前端构建产物 | **无构建步骤**（`web/` 下就是三个手写文件，浏览器直接跑） |
| 源码里的 `import` | 全部来自 Node 内置模块（见第 3 节） |

因此：**装本插件不会引入任何需要单独遵守许可的第三方包**。

> 为什么能做到：存储用 Node 内置的 `node:sqlite`（不引原生模块），
> ZIP 读写在 `src/core/zip.js` 里自己实现（不引 archiver/jszip），
> 前端不引框架（DSH 的浏览器半边只 `require('react')`，那是宿主提供的）。

---

## 2 peerDependencies：由宿主提供，不随本插件分发

这些是**宿主 DSH 的组成部分**。本插件声明为 peer（且全部标记 optional），
意思是"我希望你在这儿，但不由我安装、也不打包我的副本"。

| 包 | 版本要求 | 用途 | 许可 |
| --- | --- | --- | --- |
| `@deepseek-ai/dsh-llm` | `>=0.1.6-alpha <2` | 模型目录与流式调用（`ctx.get('llm')`） | 见 DSH 自身仓库 |
| `@deepseek-ai/dsh-tools` | `>=0.1.6-alpha <2` | 宿主工具面（可选能力探测） | 见 DSH 自身仓库 |
| `cordis` | `>=4.0.0-rc <5` | 插件框架（宿主已提供） | 见 DSH 自身仓库 |
| `schemastery` | `^3.18.0` | 配置模式校验（宿主已提供） | 见 DSH 自身仓库 |

本插件**不复制、不重新分发**这些包的任何代码。它们的许可证与版权归各自作者，
具体条款请以你安装的 DSH 发行物为准（本插件不改动、也不代表它们声明许可）。

---

## 3 Node 内置模块（不是第三方）

源码里出现的全部 `import ... from 'node:...'`，都属于 Node.js 自身，随 Node 分发：

| 模块 | 用在哪 |
| --- | --- |
| `node:sqlite` | `src/core/store.js`（实验/配方/收据的索引） |
| `node:crypto` | 各处 hash（原始正文、作品 HTML、包清单、令牌随机数） |
| `node:fs` / `node:path` / `node:url` | 文件落盘与路径处理 |
| `node:http` / `node:net` | 预览服务与 API 路由 |
| `node:zlib` | ZIP 的 deflate/inflate |
| `node:child_process` | 截图用的独立浏览器子进程（可硬杀） |
| `node:os` / `node:module` / `node:events` 等 | 临时目录、模块解析、事件 |

`node:sqlite` 需要 **Node >= 22.5**（`package.json` 的 `engines` 已声明）。

---

## 4 可选外部工具：Playwright / Chromium

**只影响"初始截图"这一个功能。** 不装它插件照常工作，截图会明确标注"未检查"，
生成与预览完全不受影响。

| 项 | 说明 |
| --- | --- |
| 谁提供 | **你的环境**，不是本插件。插件不安装、不打包它 |
| 怎么找到 | 依次尝试：`HTML_ARENA_PLAYWRIGHT_ANCHOR` 指定的目录 → DSH checkout 内 → 全局 `npm` 下的 `playwright` |
| Playwright 许可 | Apache-2.0 |
| Chromium 许可 | BSD-3-Clause 及若干第三方许可（见 Chromium 发行物内的 `LICENSES`） |
| 本插件对它的用法 | 只调公开 API（`launch` / `newContext` / `screenshot`），在**独立子进程**里跑，可被硬杀 |

---

## 5 受控 CDN 白名单（作品可以引用的外部资源）

作品本身可以由模型写成引用 CDN 的形式。**默认策略是离线**（外部请求被 CSP 挡下）；
只有你显式选"受控 CDN"时，才放行下面这些域：

| 域 | 常见内容 | 许可形态 |
| --- | --- | --- |
| `cdn.jsdelivr.net` | 各种 npm 包的前端构建产物 | **因包而异**（每个库自己的许可） |
| `unpkg.com` | 同上 | **因包而异** |
| `cdnjs.cloudflare.com` | 常见前端库 | **因库而异** |
| `fonts.googleapis.com` / `fonts.gstatic.com` | Google Fonts | **因字体而异**（多为 OFL / Apache-2.0） |

⚠️ **重要**：白名单只控制"能连到哪些域"，**不判断、也不保证**被引用的那个库的许可是否适合你的用途。
如果你的作品要发布，请自行核对该库的许可证。

---

## 6 本插件里源自 DSH 的接口知识

`docs/dsh-integration.md` 记录的是**接口签名与行为**（函数名、参数、返回值、实测到的报错），
用于让本插件正确对接宿主。这里没有复制 DSH 的源代码。

---

## 7 六类示例作品

`scripts/samples.mjs` 里的六个样例页面（落地页 / 仪表盘 / 动画 / 数据可视化 / 交互原型 / 小游戏）
是**本项目原创**，随本插件以 MIT 发布。它们**不是**模型输出，仅用于演示与隔离测试。

---

## 8 一句话总结

本插件**本身不含任何第三方运行时代码**；需要单独注意许可的只有两处：
① 你选择的 CDN 上那些库（受控 CDN 模式下作品会去下载它们）；
② 可选的 Playwright/Chromium（截图能力）。
