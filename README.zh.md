[English](./README.md) | 中文

# chatgpt-codex-tools-mcp

一个本地 HTTP MCP server，用来把一组类似 Codex 的本地项目工具暴露给 ChatGPT。

ChatGPT 负责思考和写方案，这个 MCP server 负责受限制地读文件、看 git、预览修改、确认修改、跑少量低风险命令。

> 不是 OpenAI 或 Codex 的官方项目。这是一个社区工具层，让 ChatGPT 能像使用一个小型 Codex 工具箱一样操作你允许的工作区。

---

## 适合谁

- 你想让 ChatGPT 看本地项目代码。
- 你想让 ChatGPT 帮你改文件，但希望先 preview 再确认。
- 你不想把本地 MCP server 暴露到公网。
- 你想通过私有 MCP tunnel 让 ChatGPT 连接本机。
- 你想限制 ChatGPT 只能访问指定目录。

---

## 功能

- 默认只绑定 `127.0.0.1`，不外露。
- 通过 `CTM_ALLOWED_ROOTS` 限制工作区边界。
- 内置敏感路径屏蔽规则。
- 读文件、列表、搜索工具。
- Git status/diff 工具。
- Patch 预览 + 确认流程。
- `review` 模式 shell 白名单，只允许低风险验证命令。
- 工具输出会做尽力而为的敏感值脱敏。
- Windows 辅助脚本，可复用 Codex 自带的 Node 运行时。
- 可选 web 工具（默认关闭）：SearXNG 搜索、HTTP 页面抓取。
- 可选 SQLite/OpenClaw cron 工具（默认关闭）：白名单数据库只读查询，以及 cron 任务 preview/confirm 修改。

---

## 暴露给 ChatGPT 的工具

| 工具 | 用途 |
| --- | --- |
| `local_status` | 显示服务器状态、访问模式、允许路径、容量限制及 web tools 配置。 |
| `open_workspace` | 打开 `CTM_ALLOWED_ROOTS` 下的项目文件夹。 |
| `list_dir` | 列出打开的工作区文件。 |
| `read_file` | 读取 UTF-8 文本文件（带输出上限）。 |
| `search_files` | 在工作区搜索文本。 |
| `git_status` | 运行 `git status --short`。 |
| `git_diff` | 运行 `git diff --stat` 和 `git diff`。 |
| `preview_patch` | 创建待应用的替换 patch。 |
| `confirm_patch` | 按 action id 确认应用 patch。 |
| `preview_shell` | 创建待执行的 shell 操作。 |
| `confirm_shell` | 确认执行 shell 操作。 |
| `shell` | 运行本地命令（受 `CTM_ACCESS_MODE` 限制）。 |
| `sqlite_status` | 显示 SQLite 工具配置。始终可用。 |
| `sqlite_schema` * | 查看白名单 SQLite 数据库 schema。需 `CTM_SQLITE_TOOLS=1`。 |
| `sqlite_select` * | 对白名单 SQLite 数据库执行单条只读 `SELECT`/`WITH` 或安全 `PRAGMA`。需 `CTM_SQLITE_TOOLS=1`。 |
| `cron_list_jobs` * | 从白名单 OpenClaw cron SQLite 数据库列出任务。需 `CTM_SQLITE_TOOLS=1`。 |
| `cron_get_job` * | 读取单个 OpenClaw cron 任务。需 `CTM_SQLITE_TOOLS=1`。 |
| `cron_preview_update_job` * | 预览单个 OpenClaw cron 任务修改。需 `CTM_SQLITE_TOOLS=1`。 |
| `cron_confirm_update_job` * | 按 action id 应用已预览的 cron 修改。需 `CTM_SQLITE_TOOLS=1`。 |
| `web_status` | 显示 web tools 配置。始终可用。 |
| `web_search` * | 通过 SearXNG 搜索网络。需 `CTM_WEB_TOOLS=1` 和 `CTM_SEARCH_PROVIDER=searxng`。 |
| `web_fetch` * | 获取公开 HTTP(S) 页面。阻止本机/内网地址和凭据。需 `CTM_WEB_TOOLS=1`。 |

\* _可选工具，默认关闭，需开启对应 feature flag。_

---

## 安全模型

默认配置保守：

```text
HOST=127.0.0.1
PORT=3333
CTM_ACCESS_MODE=review
```

重要规则：

- 保持 `HOST=127.0.0.1` 仅本机使用。
- 保持 `CTM_ACCESS_MODE=review`，除非你完全理解风险。
- `CTM_ALLOWED_ROOTS` 只写你想让 ChatGPT 操作的项目目录。
- 不要设置到整个盘或系统根目录。
- 通过私有 tunnel 使用，不要公开 HTTP 地址。
- ChatGPT 创建连接器时选择 **No Authentication / 未授权**。
- 输出脱敏只是兜底，不应替代较窄的 `CTM_ALLOWED_ROOTS`、deny rules 和 SQLite 白名单。

`review` 模式会拦截危险命令，只允许 `git status`、`git diff`、`dir`、`ls`、`node --version`、`npm run ...` 等低风险检测命令。

写入 git 或发布到远程的命令（如 `git add`、`git commit`、`git push`、`gh repo create`）在 `review` 模式下不允许直接执行，需要通过 `preview_shell` 先创建待执行操作，再通过 `confirm_shell` 确认执行。

---

## 安装要求

- Node.js 20+
- npm
- ChatGPT 自定义连接器（支持连接 MCP server）
- 如需 ChatGPT 连接本机，还需要 OpenAI `tunnel-client`
- 可选 SQLite 工具需要支持 `node:sqlite` 的 Node.js 运行时；建议 Node.js 24+。

Windows 辅助脚本查找 Node 的顺序：
1. Codex 自带的 Node 运行时（`%LOCALAPPDATA%\OpenAI\Codex\runtimes\cua_node`）
2. `OPENCLAW_NODE_BIN` 环境变量
3. `PATH` 上的 `node`

---

## 安装

```bash
git clone https://github.com/Kerberos255/chatgpt-codex-tools-mcp.git
cd chatgpt-codex-tools-mcp
npm install
npm run build
```

### Windows PowerShell

```powershell
$env:CTM_ALLOWED_ROOTS = "D:\Projects"
$env:CTM_ACCESS_MODE = "review"
npm run build
node dist/server.js
```

### macOS / Linux

```bash
export CTM_ALLOWED_ROOTS="$HOME/projects"
export CTM_ACCESS_MODE="review"
npm run build
node dist/server.js
```

启动后应看到类似输出：

```text
chatgpt-codex-tools-mcp listening on http://127.0.0.1:3333/mcp
allowed roots: D:\Projects
access mode: review
auth: no authentication (use only behind a private/local tunnel)
```

---

## Windows 快速开始

普通 Windows 用户优先使用根目录下的 `.cmd` 文件。`scripts/` 里的 PowerShell 脚本是具体实现和高级入口。

### 1. 首次初始化

运行：

```text
init-windows.cmd
```

初始化脚本会询问或配置：

1. 允许访问的工作区根目录，例如 `D:\Projects`。
2. npm 依赖和 `dist/server.js` 构建产物。
3. 本机 `tunnel-client.exe` 路径。
4. 本机专用启动脚本。

它会生成这些本机启动文件：

```text
start-mcp.local.cmd
start-tunnel.local.cmd
start-tunnel.local.ps1
```

初始化脚本不会保存 runtime key。启动 tunnel 时，如果当前环境有 `CONTROL_PLANE_API_KEY` 就直接使用；否则会用隐藏 PowerShell 输入提示临时输入。

如果缺少 `tunnel-client.exe`，初始化脚本会打开下载页面并提示推荐放置路径。下载后放到提示的位置，重新运行 `init-windows.cmd`，然后再运行 `start-all.cmd`。

高级初始化用法：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\init-windows.ps1 `
  -AllowedRoots "D:\Projects" `
  -OpenTunnelDownloadPages
```

### 2. 启动 MCP + tunnel

初始化完成后运行：

```text
start-all.cmd
```

它会打开两个窗口：

1. MCP server 窗口，使用 `start-mcp.local.cmd` 或 fallback `start-mcp.cmd`。
2. tunnel 窗口，使用 `start-tunnel.local.cmd`。

使用 ChatGPT 连接器期间，请保持两个窗口都在运行。

### 3. 可选的单独启动入口

```text
start-mcp.cmd       # 只启动本地 MCP server
start-tunnel.cmd    # 只启动私有 tunnel，需先完成初始化
```

常用环境变量：

| 变量 | 含义 |
| --- | --- |
| `CTM_ALLOWED_ROOTS` | 逗号分隔的允许工作区根目录。 |
| `CTM_ACCESS_MODE` | `review` 或 `full`。默认 `review`。 |
| `PORT` | 本地 HTTP 端口。默认 `3333`。 |
| `OPENCLAW_NODE_BIN` | 可选，包含 `node.exe` 的文件夹路径。 |
| `CTM_NPM_CACHE` | 可选，npm 缓存目录位置。 |

示例：

```cmd
set "CTM_ALLOWED_ROOTS=D:\Projects"
set "OPENCLAW_NODE_BIN=C:\Tools\nodejs"
set "CTM_NPM_CACHE=D:\npm-cache"
start-mcp.cmd
```

---

## 私有 tunnel 和 ChatGPT 连接器

这个项目设计为本地运行。如果 ChatGPT 需要连接它，请使用 OpenAI Secure MCP Tunnel，不要将 HTTP server 直接暴露到公网。

Tunnel 前提条件：
1. 在 OpenAI Platform tunnel 设置中创建或选择一个 tunnel。
2. 在 tunnel 详情页复制 tunnel id 和 runtime key。启动 tunnel 时脚本会在需要时询问 runtime key。
3. 下载 `tunnel-client`（从 OpenAI Platform tunnel 设置或 `openai/tunnel-client` 发布页）。
4. 从 ChatGPT 测试时保持 tunnel client 运行。

本地 MCP server 地址：

```text
http://127.0.0.1:3333/mcp
```

可选 profile 初始化：

```powershell
$env:CONTROL_PLANE_API_KEY = "***"
.\tools\tunnel-client\tunnel-client.exe init `
  --sample sample_mcp_stdio_local `
  --profile codex_MCP `
  --tunnel-id tunnel_xxx `
  --mcp-server-url http://127.0.0.1:3333/mcp
```

ChatGPT 连接器设置：

```text
连接类型：Tunnel
身份验证：No Authentication / 未授权
MCP 地址：http://127.0.0.1:3333/mcp（通过 tunnel profile）
```

浏览器直接访问 `/mcp` 返回 `No valid MCP session` 是正常现象，说明 server 活着但你没有发 MCP 初始化请求。

---

## 配置参考

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | 保持本机，除非你加了额外保护。 |
| `PORT` | `3333` | 本地 HTTP 端口。 |
| `CTM_ALLOWED_ROOTS` | 当前工作目录 | 逗号分隔的允许根目录。 |
| `CTM_ACCESS_MODE` | `review` | `review` 或 `full`。 |
| `CTM_DENY_GLOBS` | 内置拒绝列表 | 逗号分隔的屏蔽规则。 |
| `CTM_MAX_READ_BYTES` | `200000` | 文件读取最大字节数。 |
| `CTM_MAX_OUTPUT_BYTES` | `200000` | shell/git 输出最大字节数。 |
| `CTM_WEB_TOOLS` | (未设置) | 设为 `1` 启用可选 web 工具（`web_search`、`web_fetch`）。`web_status` 始终可用，不受此设置影响。 |
| `CTM_SEARCH_PROVIDER` | `none` | `none` 或 `searxng`。需 `CTM_WEB_TOOLS=1`。 |
| `CTM_SEARXNG_URL` | (无) | SearXNG 实例地址。`CTM_SEARCH_PROVIDER=searxng` 时必须设置。 |
| `CTM_WEB_MAX_BYTES` | `200000` | web_fetch 返回最大字节数。 |
| `CTM_WEB_TIMEOUT_MS` | `15000` | 每个 web 请求的超时时间。 |
| `CTM_SQLITE_TOOLS` | (未设置) | 设为 `1` 启用可选 SQLite 和 cron 工具。 |
| `CTM_SQLITE_ALLOWED_DBS` | (无) | 逗号分隔的 SQLite 数据库绝对路径白名单。 |
| `CTM_SQLITE_MAX_ROWS` | `100` | SQLite 和 cron list 工具最多返回行数。 |
| `CTM_CRON_DB_PATH` | (无) | OpenClaw cron SQLite 数据库路径，通常也要列入 `CTM_SQLITE_ALLOWED_DBS`。 |
| `CTM_CRON_STORE_KEY` | (无) | OpenClaw cron store key，例如原始 `jobs.json` 路径。 |

`env.example` 包含一个示例配置。复制后本地修改，不要发布自己的环境文件。

### SQLite 和 OpenClaw cron

SQLite 工具需要显式开启，并且只能打开 `CTM_SQLITE_ALLOWED_DBS` 白名单里的数据库。`sqlite_select` 只读，只允许单条 `SELECT`/`WITH` 或少量安全 `PRAGMA`。不会暴露通用 SQLite 写入能力。

OpenClaw cron 修改请走专用 preview/confirm 流程：

```text
cron_list_jobs
cron_get_job
cron_preview_update_job
cron_confirm_update_job
```

本机 OpenClaw 示例配置：

```cmd
set "CTM_SQLITE_TOOLS=1"
set "CTM_SQLITE_ALLOWED_DBS=E:\openclaw\.openclaw\state\openclaw.sqlite"
set "CTM_CRON_DB_PATH=E:\openclaw\.openclaw\state\openclaw.sqlite"
set "CTM_CRON_STORE_KEY=E:\openclaw\.openclaw\cron\jobs.json"
```

---

## 常见问题

### `/mcp` 返回 400 是不是坏了？

不是。裸访问 `/mcp` 返回 `No valid MCP session` 很正常，说明 server 活着，但你没有发 MCP 初始化请求。

### 为什么不用 OAuth？

这个公开模板默认给个人本机 + 私有 tunnel 使用，所以 No Auth 更简单。安全边界来自 localhost、私有 tunnel、allowed roots、deny rules、review mode。多人或生产环境请自行加认证。

### 我能不能设成 full 模式？

可以，但不建议。除非你完全信任本地环境和调用方，否则保持 `review`。

### SQLite 工具不可用

设置 `CTM_SQLITE_TOOLS=1`，把数据库加入 `CTM_SQLITE_ALLOWED_DBS`，使用支持 `node:sqlite` 的 Node.js 运行时，然后重启 MCP server。
