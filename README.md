# Antigravity 专用反代与桌面管理中心

本系统采用 **Core 核心反代服务 + Tauri 桌面管理端** 的彻底解耦架构：
- **Core 核心引擎 (`core/`)**：纯 TypeScript / Bun 反代核心，提供 OpenAI 兼容端点、多账号调度及 **Windows Named Pipe JSON-RPC 2.0 服务**与**事件订阅系统**。
- **GUI 客户端 (`gui/`)**：基于 **Tauri 2 + React + TypeScript** 的原生 Windows 客户端，内置系统托盘、进程管理、Named Pipe 实时日志流与账号管理。
- **云端自动化构建**：通过 GitHub Actions 自动化编译打包，保持 Git 仓库纯净轻量，预编译二进制文件直接在 [GitHub Releases](https://github.com/MaaBlock/AntigravityProxy/releases) 托管下载。

---

## 目录结构说明

```text
AntigravityProxy/
├── .github/
│   └── workflows/              # GitHub Actions 自动化构建与发布流
├── antigravity-gui.cmd         # 便捷启动脚本（自动检测构建环境或启动已编译客户端）
├── core/                       # 反代核心引擎 (TypeScript / Bun)
│   ├── src/                    # 代理核心源码 (IPC、路由、OAuth、协议转换等)
│   ├── tests/                  # 单元测试与功能测试
│   ├── package.json
│   └── tsconfig.json
├── gui/                        # 桌面管理客户端源码 (Tauri 2 + React + TypeScript)
│   ├── src-tauri/              # Rust 宿主工程 (Named Pipe 通信、进程生命周期托管)
│   ├── src/                    # 前端渲染层与视图组件 (服务总览、日志、账号、设置)
│   ├── package.json
│   └── vite.config.ts
├── data/                       # 本地配置与数据存储（Git 忽略敏感账号信息）
│   ├── .gitkeep
│   └── antigravity-accounts.example.json  # 账号配置模板
├── README.md                   # 项目使用与部署文档
└── SECURITY-AUDIT.md           # 安全审计报告与使用规范
```

---

## 通信技术栈 (IPC Architecture)

```text
┌──────────────────────────────────────────────────────────────┐
│             Tauri 桌面管理客户端 (antigravity-proxy.exe)       │
│  - Windows 原生系统托盘常驻 (关闭窗口自动隐藏至托盘)          │
│  - 开机自启动管理 (注册表 HKCU Run 启动项与静默最小化)          │
│  - 实时日志流终端 (分级高亮/关键词搜索/导出)                 │
│  - 核心生命周期托管 (启动/停止/一键重启/WatchMode 热重载)     │
└──────────────────────────────┬───────────────────────────────┘
                               │
                【 Windows Named Pipe IPC 】
            \\.\pipe\antigravity_proxy_ipc
                               │
     • JSON-RPC 2.0 / Typed RPC (ping, status.get, config.set...)
     • Zod Schema 全链路类型定义与入参校验
     • Pub/Sub 事件订阅 (events.subscribe / event.logs / event.accounts)
                               │
                               ▼
┌──────────────────────────────────────────────────────────────┐
│                 Core 反代核心引擎 (core/)                     │
│  - 监听 http://127.0.0.1:8317/v1 (OpenAI 兼容接口)           │
│  - Google Cloud Code API 协议转换与模型路由                   │
│  - 多账号 Token 轮询、健康评分、429 自动冷却退避              │
│  - 开启 Windows Named Pipe IPC 服务广播实时事件              │
└──────────────────────────────────────────────────────────────┘
```

---

## 快速上手

### 环境准备

1. **操作系统**：Windows 10 / 11 (x64)
2. **反代运行时**：安装 [Bun](https://bun.sh/)（用于运行 Core 反代核心）
   ```powershell
   powershell -c "irm bun.sh/install.ps1 | iex"
   ```

### 账号配置

在 `data/` 目录下创建 `antigravity-accounts.json`（可参考 `data/antigravity-accounts.example.json`），或启动桌面客户端后在 GUI 的【账号与额度】界面中一键绑定 Google 账号。

---

## 启动与运行方式

### 方式 1：下载预编译客户端 (推荐，开箱即用)

从 [GitHub Releases](https://github.com/MaaBlock/AntigravityProxy/releases) 下载最新的发布包（`.exe` 安装程序或绿色版），直接运行即可。

也可直接双击运行根目录启动脚本：
```powershell
.\antigravity-gui.cmd
```
脚本将自动寻找已编译的二进制程序；若本地未编译但安装有开发环境，将自动执行编译启动。

### 方式 2：从源码编译与开发 GUI 客户端

开发环境需要安装 [Node.js](https://nodejs.org/)、[pnpm](https://pnpm.io/) 和 [Rust](https://rustup.rs/)：

```powershell
# 1. 安装前端依赖并构建前端产物
cd gui
pnpm install
pnpm build

# 2. 编译并打包 Tauri 原生安装包
pnpm tauri build

# 或以开发者热重载模式运行
pnpm tauri dev
```

### 方式 3：终端单独启动 Core 核心服务（无 GUI 运行）

如需脱离 GUI 在终端中独立运行核心服务：

```powershell
cd core
$env:HOST = "127.0.0.1"
$env:PORT = "8317"
$env:ACCOUNTS_FILE = "..\data\antigravity-accounts.json"
bun run src/server.ts
```

---

## 核心解耦与开发热重载

* **修改 Core 代码无需重新打包 GUI**：
  GUI 不绑定任何固定业务代码，每次点击【重启服务】即自动读取 `core/` 下最新的 TypeScript 源码。
* **🔥 核心代码热重载 (Watch Mode)**：
  在 GUI【系统与设置】中开启 `核心代码热重载`，每次修改 `core/` 下的 TS 源码时，Bun 会自动实时热重载，GUI 通过 Named Pipe 实时获取最新日志与状态。

---

## 客户端接入配置

| 项目 | 值 |
| --- | --- |
| Base URL | `http://127.0.0.1:8317/v1` |
| API Key | 任意非空字符串（本地代理不校验） |
| Model | `gemini-3.1-pro-low`、`gemini-3.1-pro-high`、`claude-sonnet-4-6` 等 |

### Claude Code 接入
```bash
export CLAUDE_CODE_API_BASE="http://127.0.0.1:8317/v1"
claude --model gemini-3.1-pro-low
```

### OpenCode 接入 (`~/.config/opencode/opencode.json`)
```json
{
  "provider": {
    "antigravity-proxy": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Antigravity Proxy",
      "options": {
        "baseURL": "http://127.0.0.1:8317/v1"
      }
    }
  }
}
```

---

## 安全提醒

不要把 8317 端口映射到 `0.0.0.0`、公网或隧道服务。它没有客户端鉴权，暴露后等同于把你的 Antigravity 额度和 OAuth 登录态交给网络上的任何人。
详情请参阅 [SECURITY-AUDIT.md](SECURITY-AUDIT.md)。
