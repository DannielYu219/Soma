# Soma

Soma 是一款 macOS 桌面 AI 对话与创作工具。对话界面保持安静，模型调用和搜索过程放在界面之下。Creator Mode 用于写作，支持章节编辑、选区引用、修改日志和 Word / Markdown 导出。

当前版本：0.1.2。仅支持 macOS（Apple Silicon，要求 macOS 13.5 及以上）。

## 功能

- **对话**：支持 OpenAI 兼容与 Anthropic 两类模型服务。可以添加、命名、切换多个服务配置，并为每个配置设置主模型和可选的检索模型。
- **搜索**：模型需要时调用自托管的 SearXNG 搜索，结果以折叠的来源列表显示在回复下方。搜索词会发送给搜索服务。
- **Creator Mode**：
  - 选中章节正文后可把原文作为带章节和位置的引用加入对话。
  - 修改日志记录作品改名、章节编辑、增删重排和已采纳的 AI 修改，并显示行差异。
  - AI 在下一次请求时能看到自上次以来的近期差异。
  - 导出全部章节为 `.docx` 或 `.md`。DOCX 在本地生成。
- **持久化**：配置、对话和文稿保存在 macOS Application Support 目录。更新应用不会删除数据。
- **后台续跑**：对话任务在网页端切到后台或 Safari 断开后，不会因此重跑。

## 安装

在 [Releases](https://github.com/DannielYu219/Soma/releases) 下载对应版本的 `Soma_<版本>_aarch64.dmg`，并用同名的 `.sha256` 文件核对校验值：

```bash
shasum -a 256 -c Soma_0.1.2_aarch64.dmg.sha256
```

## 从源码开发

需要 Node.js 和 npm。Tauri 打包还需要 Rust 工具链。

```bash
npm install
npm run dev        # 后端 127.0.0.1:8787 + 前端 Vite 5173，同源代理
npm test           # 运行 tests/ 下的单元测试
npm run build      # tsc 类型检查 + Vite 构建到 dist/
```

开发模式下浏览器访问 `http://127.0.0.1:5173`。

### 打包桌面应用

```bash
npm run app:prepare   # 构建前端、打包后端和搜索运行时、准备资源
npm run app           # 以 Tauri 开发模式启动桌面应用
npm run app:build     # 生成 .app，并通过 scripts/package-dmg.mjs 生成 DMG
```

`npm run package:search` 使用 `.searxng/venv` 中的 Python 构建 PyInstaller 搜索运行时。`.searxng/`、`build-resources/`、`releases/` 和 `artifacts/` 都是本地生成内容，不在仓库中。从干净的克隆构建前，需要先准备这些内容。

## 配置

后端通过环境变量读取配置，默认值适用于本机开发：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `SOMA_BACKEND_HOST` | `127.0.0.1` | 后端监听地址 |
| `SOMA_BACKEND_PORT` | `8787` | 后端端口 |
| `SOMA_OPENAI_BASE_URL` | `https://api.openai.com/v1` | OpenAI 兼容服务地址 |
| `SOMA_ANTHROPIC_BASE_URL` | `https://api.anthropic.com` | Anthropic 服务地址 |
| `SOMA_OPENAI_API_KEY` / `SOMA_ANTHROPIC_API_KEY` | 无 | 可选的后备密钥，客户端密钥优先 |
| `SOMA_SEARXNG_URL` | `http://127.0.0.1:8888` | 搜索实例地址 |
| `SOMA_SEARXNG_AUTOSTART` | `0` | 设为 `1` 时后端自动启动 SearXNG |
| `SOMA_SEARXNG_PROXY` | `auto` | `auto`、`direct` 或代理 URL，详见 [docs/proxy.md](docs/proxy.md) |
| `SOMA_MAX_SEARCH_ROUNDS` | `4` | 每次请求允许的搜索轮数 |

## 安全与数据

- 后端绑定 `127.0.0.1`。桌面应用启动时生成随机本机令牌，API 只接受带令牌的本机请求。
- 状态文件目录权限为 `0700`，文件权限为 `0600`，使用原子写入。
- **当前服务商密钥以明文保存在本机状态文件中，尚未迁移到 macOS Keychain，也不是加密存储。** 调试报告中不要附带该文件。
- 后端不保存客户端密钥。

## 文档

- [Creator Mode：导出与修改日志](docs/creator-mode.md)
- [持久化与提示缓存](docs/persistence-cache.md)
- [桌面封装实现](docs/app-packaging-research.md)
- [打包的搜索运行时](docs/packaging-search.md)
- [SearXNG 代理发现](docs/proxy.md)
- [搜索能力调研](docs/search-research.md)

## 许可

见 [LICENSE](LICENSE)。
