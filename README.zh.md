English | [中文](./README.zh.md)

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
- Windows 辅助脚本，可复用 Codex 自带的 Node 运行时。

---

## 暴露给 ChatGPT 的工具

| 工具 | 用途 |
| --- | --- |
| `codex_local_status` | 显示服务器状态、访问模式、允许路径、容量限制。 |
| `codex_workspace_open` | 打开 `CTM_ALLOWED_ROOTS` 下的项目文件夹。 |
| `codex_list_dir` | 列出打开的工作区文件。 |
| `codex_read_file` | 读取 UTF-8 文本文件（带输出上限）。 |
| `codex_search_files` | 在工作区搜索文本。 |
| `codex_git_status` | 运行 `git status --short`。 |
| `codex_git_diff` | 运行 `git diff --stat` 和 `git diff`。 |
| `codex_apply_patch_preview` | 创建待应用的替换 patch。 |
| `codex_apply_patch_confirm` | 按 action id 确认应用 patch。 |
| `codex_shell_preview` | 创建待执行的 shell 操作。 |
| `codex_shell_confirm` | 确认执行 shell 操作。 |
| `codex_shell` | 运行本地命令（受 `CTM_ACCESS_MODE` 限制）。 |

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

`review` 模式会拦截危险命令，只允许 `git status`、`git diff`、`dir`、`ls`、`node --version`、`npm run ...` 等低风险检测命令。

写入 git 或发布到远程的命令（如 `git add`、`git commit`、`git push`、`gh repo create`）在 `review` 模式下不允许直接执行，需要通过 `codex_shell_preview` 先创建待执行操作，再通过 `codex_shell_confirm` 确认执行。

---

## 安装要求

- Node.js 20+
- npm
- ChatGPT 自定义连接器（支持连接 MCP server）
- 如需 ChatGPT 连接本机，还需要 OpenAI `tunnel-client`

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

## Windows 辅助脚本

首次使用运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\init-windows.ps1 `
  -AllowedRoots "D:\Projects" `
  -OpenTunnelDownloadPages
```

该脚本会：
1. 安装依赖并构建 `dist/server.js`。
2. 保存允许的工作区根目录到本地启动脚本。
3. 查找 `tunnel-client.exe`。
4. 缺少时打开 OpenAI tunnel 设置/最新发布页。
5. 创建本机专用的 `start-mcp.local.cmd`、`start-tunnel.local.cmd`、`start-tunnel.local.ps1`。

生成的 `*.local.cmd` 和 `*.local.ps1` 已被 `.gitignore` 排除，不会提交到 git。

初始化后，双击 `start-all.cmd` 会打开两个窗口：
1. MCP server（通过 `start-mcp.local.cmd` 或 fallback `start-mcp.cmd`）
2. 私有 tunnel（通过 `start-tunnel.local.cmd`）

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
set "CTM_ALLOWED_ROOTS=E:\codex,E:\openclaw\github_project"
set "OPENCLAW_NODE_BIN=C:\Tools\openclaw\runtime\node"
set "CTM_NPM_CACHE=E:\npm-cache"
start-mcp.cmd
```

---

## 私有 tunnel 和 ChatGPT 连接器

这个项目设计为本地运行。如果 ChatGPT 需要连接它，请使用 OpenAI Secure MCP Tunnel，不要将 HTTP server 直接暴露到公网。

Tunnel 前提条件：
1. 在 OpenAI Platform tunnel 设置中创建或选择一个 tunnel。
2. 下载 `tunnel-client`（从 OpenAI Platform tunnel 设置或 `openai/tunnel-client` 发布页）。
3. 从 ChatGPT 测试时保持 tunnel client 运行。

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

`env.example` 包含一个示例配置。复制后本地修改，不要发布自己的环境文件。

---

## 常见问题

### `/mcp` 返回 400 是不是坏了？

不是。裸访问 `/mcp` 返回 `No valid MCP session` 很正常，说明 server 活着，但你没有发 MCP 初始化请求。

### 为什么不用 OAuth？

这个公开模板默认给个人本机 + 私有 tunnel 使用，所以 No Auth 更简单。安全边界来自 localhost、私有 tunnel、allowed roots、deny rules、review mode。多人或生产环境请自行加认证。

### 我能不能设成 full 模式？

可以，但不建议。除非你完全信任本地环境和调用方，否则保持 `review`。
