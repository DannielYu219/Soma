# Soma 桌面封装实现

2026-11-03：已选 Tauri 2，仅支持 macOS Apple Silicon 桌面版本。本文件替代最初的方案调研。

## 运行架构

- Tauri Rust 外壳加载随 App 分发的 UI、Node 后端与 SearXNG 搜索运行时，不依赖项目目录、Homebrew、系统 Python 或用户安装 Node。
- UI 与 API 仍然同源：Rust 启动本机 Node 服务，然后 WebView 加载该服务提供的网页。不存在“改成 Tauri 自定义协议后必须跨域”的问题。
- 后端固定绑定 127.0.0.1:8787，保持网页 origin 稳定，以保留本机对话存储；已占用时不复用未知服务。搜索使用临时空闲本机端口。
- 启动时生成随机本机会话令牌，WebView 首次引导换取 HttpOnly / SameSite=Strict cookie；本机 API 不接受无令牌调用。
- Rust 负责两个子进程；正常退出、启动失败都清理子进程；父进程意外结束后，子进程通过 stdin EOF 看门狗自行结束。
- 日志与缓存写在 Application Support 的应用数据目录，不写入只读 App 资源。

## 打包组件

- Node：官方 macOS arm64 独立运行时，版本与下载 SHA-256 固定在 scripts/package-backend.mjs；服务端 TypeScript 使用 esbuild 输出单个 ESM，运行时没有 npm 外部依赖。
- 搜索：SearXNG 官方固定源码、共享代理选择逻辑、Python 与依赖冻结为 PyInstaller onedir 可执行包。整个目录必须一起分发。
- UI：Vite 构建资源直接复制进 Contents/Resources/runtime/ui。Creator Mode、三种流式协议和搜索工具均通过本机网关工作。
- 搜索组件许可证及对应上游源码压缩包位于 Contents/Resources/runtime/licenses。

## 复现构建

1. npm install
2. 配置搜索构建 Python，并运行 npm run package:search。搜索打包脚本允许通过 SOMA_PACKAGE_PYTHON 指向兼容运行时。
3. npm run app:build：构建 UI、Node 包、准备资源、Tauri release App、临时签名并生成 DMG 和 SHA-256 文件。
4. 成品位于 releases/Soma_0.1.3_aarch64.dmg。

## 后台验证

- npm test：协议、请求校验、取消、章节不变量、代理发现与真实 SearXNG 网络配置。
- build-resources/backend/node --test tests/packaged-backend.test.mjs：移到含空格的临时路径，在受限 PATH 下验证 Node、cookie、API 与退出清理。
- node --experimental-strip-types tests/creator-smoke.mjs：独立无头 Chrome 验证 Creator UI、流式文稿更新、会话隔离、本机恢复与两种主题，不使用用户前台浏览器。
- Soma.app/Contents/MacOS/soma --self-test：不创建任何窗口，验证 App 自带搜索、后端、UI 资源与进程清理。DMG 挂载后复制到临时路径、清空环境、从项目外执行此测试。

## 发布边界

- 当前使用本机临时签名，没有 Apple Developer ID 公证。系统可能需要在隐私与安全性中允许本次打开；不应关闭系统安全保护。
- 不包含用户的模型 API 密钥，需在服务设置中填写。用模拟模型验证了协议与 Creator 操作，未使用用户的真实计费凭据。
- 系统代理与本地端口自动发现已内置；PAC/WPAD 脚本尚不执行。搜索引擎实际可达性仍依赖代理、网络和验证码。
