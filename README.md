# chatgpt-codex-tools-mcp

Codex-style local workspace tools exposed to ChatGPT through MCP.

ChatGPT does the reasoning. This server only provides constrained local tools: open a workspace, list/read/search files, inspect git state, preview/apply text replacements, and run a small allowlisted set of local commands.

> Not affiliated with OpenAI or Codex. This is a community/local tool layer that behaves like a small Codex-style toolbox for ChatGPT.

---

## What this is

`chatgpt-codex-tools-mcp` is a local HTTP MCP server for people who want ChatGPT to inspect and edit local projects without giving it a broad shell or public network endpoint.

Recommended flow:

```text
ChatGPT custom connector
  -> private MCP tunnel
  -> tunnel client on your machine
  -> http://127.0.0.1:3333/mcp
  -> this local MCP server
  -> allowed local workspaces only
```

The default public template uses **No Authentication** at the MCP app layer. This is intentional for private/local tunnel usage, but it also means you should not expose this server directly to the public internet.

---

## Features

- Local-only HTTP server, bound to `127.0.0.1` by default.
- Workspace boundary via `CTM_ALLOWED_ROOTS`.
- Deny rules for common private files and sensitive paths.
- Read/list/search tools for inspection.
- Git status/diff tools for review.
- Patch preview + confirm flow for edits.
- `review` mode shell allowlist for low-risk verification commands.
- Windows-friendly helper script that can reuse Codex's bundled Node runtime if present.

---

## Tools exposed to ChatGPT

| Tool | Purpose |
| --- | --- |
| `codex_local_status` | Show server status, access mode, allowed roots, and caps. |
| `codex_workspace_open` | Open a local project folder under `CTM_ALLOWED_ROOTS`. |
| `codex_list_dir` | List files in an open workspace. |
| `codex_read_file` | Read a UTF-8 text file with output caps. |
| `codex_search_files` | Search text in a workspace without requiring ripgrep. |
| `codex_git_status` | Run `git status --short`. |
| `codex_git_diff` | Run `git diff --stat` and `git diff`. |
| `codex_apply_patch_preview` | Create a pending replacement patch. |
| `codex_apply_patch_confirm` | Apply a pending patch by action id. |
| `codex_shell_preview` | Create a pending shell action for write/publish commands. |
| `codex_shell_confirm` | Execute a pending shell action after explicit confirmation. |
| `codex_shell` | Run a local command, restricted by `CTM_ACCESS_MODE`. |

---

## Security model

Default settings are intentionally conservative:

```text
HOST=127.0.0.1
PORT=3333
CTM_ACCESS_MODE=review
```

Important rules:

- Keep `HOST=127.0.0.1` for personal use.
- Keep `CTM_ACCESS_MODE=review` unless you fully understand the risk.
- Set `CTM_ALLOWED_ROOTS` narrowly, for example `D:\Projects` or `/Users/me/projects`.
- Do not set allowed roots to a whole system drive.
- Use this behind a private tunnel rather than a public URL.
- In ChatGPT connector setup, choose **No Authentication** / **未授权**.

`review` mode blocks dangerous command patterns and only allows a small set of inspection/test commands such as `git status`, `git diff`, `dir`, `ls`, `node --version`, and `npm run ...`.

Commands that write to git history or publish to a remote, such as `git add`, `git commit`, `git remote`, `git push`, and `gh repo create`, are not allowed through direct shell in `review` mode. They must go through `codex_shell_preview` first and then `codex_shell_confirm` with the returned action id.

---

## Requirements

- Node.js 20+ recommended.
- npm.
- A ChatGPT custom connector that can connect to an MCP server.
- OpenAI `tunnel-client` if ChatGPT needs to reach this local server through Secure MCP Tunnel.
- A tunnel id and a runtime key for `tunnel-client`, created in OpenAI Platform tunnel settings.

On Windows, the helper script checks Node in this order:

1. Codex bundled Node runtime under `%LOCALAPPDATA%\OpenAI\Codex\runtimes\cua_node`.
2. `OPENCLAW_NODE_BIN`, if you set it.
3. `node` on `PATH`.

---

## Install

```bash
git clone https://github.com/Kerberos255/chatgpt-codex-tools-mcp.git
cd chatgpt-codex-tools-mcp
npm install
npm run build
```

Set your allowed workspace root before starting:

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

The server should print something like:

```text
chatgpt-codex-tools-mcp listening on http://127.0.0.1:3333/mcp
allowed roots: D:\Projects
access mode: review
auth: no authentication (use only behind a private/local tunnel)
```

---

## Windows helper scripts

For first-time Windows setup, use the initializer:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\init-windows.ps1 `
  -AllowedRoots "D:\Projects" `
  -OpenTunnelDownloadPages
```

What it does:

1. Installs npm dependencies and builds `dist/server.js`.
2. Stores your allowed workspace roots in local start scripts.
3. Looks for `tunnel-client.exe`.
4. Opens the OpenAI tunnel settings / latest release pages when the tunnel client is missing.
5. Creates `start-mcp.local.cmd`, `start-tunnel.local.cmd`, and `start-tunnel.local.ps1` for this machine.

The generated `*.local.cmd` and `*.local.ps1` files are intentionally ignored by git. The initializer does not save your runtime key into these files. When the tunnel starts, it uses `CONTROL_PLANE_API_KEY` from the current environment if present; otherwise it asks for it with a hidden PowerShell prompt.

After initialization, start both the local MCP server and the tunnel with:

```text
start-all.cmd
```

`start-all.cmd` opens two windows:

1. `start-mcp.local.cmd` or fallback `start-mcp.cmd` for the local MCP server.
2. `start-tunnel.local.cmd` for the private tunnel. This wrapper calls `start-tunnel.local.ps1`, which prompts for the runtime key when needed.

If `start-tunnel.local.cmd` or `start-tunnel.local.ps1` is missing, run the initializer first.

You can also start only the local MCP server with:

```text
start-mcp.cmd
```

or:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-mcp.ps1
```

Useful environment variables:

| Variable | Meaning |
| --- | --- |
| `CTM_ALLOWED_ROOTS` | Comma-separated allowed workspace roots. |
| `CTM_ACCESS_MODE` | `review` or `full`. Default: `review`. |
| `PORT` | Local HTTP port. Default: `3333`. |
| `OPENCLAW_NODE_BIN` | Optional folder containing `node.exe`. |
| `CTM_NPM_CACHE` | Optional npm cache folder, useful when C: drive is small. |

Example:

```cmd
set "CTM_ALLOWED_ROOTS=E:\codex,E:\openclaw\github_project"
set "OPENCLAW_NODE_BIN=C:\Tools\openclaw\runtime\node"
set "CTM_NPM_CACHE=E:\npm-cache"
start-mcp.cmd
```

---

## Private tunnel and ChatGPT connector

This project is meant to stay local. If ChatGPT needs to reach it, use OpenAI Secure MCP Tunnel rather than exposing the HTTP server publicly.

Tunnel prerequisites:

1. Create or choose a tunnel in OpenAI Platform tunnel settings.
2. Download `tunnel-client` from OpenAI Platform tunnel settings or from the latest `openai/tunnel-client` release.
3. Keep the tunnel client running while testing from ChatGPT.

High-level tunnel setup:

```text
Local MCP server URL:
http://127.0.0.1:3333/mcp
```

Optional profile initialization:

```powershell
$env:CONTROL_PLANE_API_KEY = "sk-..."
.\tools\tunnel-client\tunnel-client.exe init `
  --sample sample_mcp_stdio_local `
  --profile codex_MCP `
  --tunnel-id tunnel_xxx `
  --mcp-server-url http://127.0.0.1:3333/mcp
```

Then create a ChatGPT connector:

```text
Connection type: Tunnel
Authentication: No Authentication / 未授权
MCP server: http://127.0.0.1:3333/mcp through your tunnel profile
```

A plain browser request to `/mcp` may return HTTP 400 with `No valid MCP session`. That is normal. MCP clients must initialize a session with a proper MCP request.

Some tunnel doctor tools may still warn about OAuth metadata. For this No Auth template, that warning can be expected as long as the MCP server itself is reachable and your ChatGPT connector is configured as No Authentication.

---

## Configuration reference

| Variable | Default | Notes |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Keep local unless you add your own protection. |
| `PORT` | `3333` | Local HTTP port. |
| `CTM_ALLOWED_ROOTS` | current working directory | Comma-separated list of allowed roots. |
| `CTM_ACCESS_MODE` | `review` | `review` or `full`. |
| `CTM_DENY_GLOBS` | built-in deny list | Comma-separated deny rules. |
| `CTM_MAX_READ_BYTES` | `200000` | Max bytes returned by file reads. |
| `CTM_MAX_OUTPUT_BYTES` | `200000` | Max bytes returned by shell/git output. |

`env.example` contains a starter configuration. Copy it and adapt it locally, but do not publish your local environment file.

---

## Troubleshooting

### `No valid MCP session`

Normal for a raw GET request to `/mcp`. It only means the server is alive but no MCP session was initialized.

### ChatGPT asks for login

Create a fresh connector and choose **No Authentication / 未授权**. Old connector settings may still remember an OAuth flow.

### Path is outside allowed roots

Add the project parent folder to `CTM_ALLOWED_ROOTS`, then restart the MCP server.

### Shell command is blocked

You are in `review` mode. Use read/search/git/patch tools where possible. Only switch to `full` for trusted local use.

### `dist/server.js not found`

Run:

```bash
npm install
npm run build
```

---

# 中文说明

`chatgpt-codex-tools-mcp` 是一个本地 HTTP MCP server，用来把一组类似 Codex 的本地项目工具暴露给 ChatGPT。

简单理解：

```text
ChatGPT 负责思考和写方案
这个 MCP server 负责受限制地读文件、看 git、预览修改、确认修改、跑少量低风险命令
```

它不是 Codex 官方客户端，也不会调用 Codex agent。它只是一个本地工具层，让 ChatGPT 能像使用一个小型 Codex 工具箱一样操作你允许的工作区。

---

## 适合谁

适合这些场景：

- 你想让 ChatGPT 看本地项目代码。
- 你想让 ChatGPT 帮你改文件，但希望先 preview 再确认。
- 你不想把本地 MCP server 暴露到公网。
- 你想通过私有 MCP tunnel 让 ChatGPT 连接本机。
- 你想限制 ChatGPT 只能访问指定目录。

---

## 默认安全边界

默认配置：

```text
HOST=127.0.0.1
PORT=3333
CTM_ACCESS_MODE=review
```

建议保持：

- 只绑定 `127.0.0.1`。
- `CTM_ALLOWED_ROOTS` 只写你真正想让 ChatGPT 操作的项目目录。
- 不要写整个 C 盘、整个 E 盘或系统根目录。
- 默认用 `review` 模式。
- ChatGPT 创建连接器时选择 **未授权 / No Authentication**。
- 只通过私有 tunnel 使用，不要直接公开 HTTP 地址。

---

## 安装和启动

```bash
git clone https://github.com/Kerberos255/chatgpt-codex-tools-mcp.git
cd chatgpt-codex-tools-mcp
npm install
npm run build
```

Windows PowerShell 示例：

```powershell
$env:CTM_ALLOWED_ROOTS = "D:\Projects"
$env:CTM_ACCESS_MODE = "review"
node dist/server.js
```

Windows 也可以双击：

```text
start-mcp.cmd
```

如果你使用 OpenClaw 自带 Node，可以先设置：

```cmd
set "OPENCLAW_NODE_BIN=E:\openclaw\runtime\node"
```

如果 C 盘空间紧张，可以把 npm cache 放到 E 盘：

```cmd
set "CTM_NPM_CACHE=E:\npm-cache"
```

---

## ChatGPT 连接器设置

ChatGPT 要连到本机 MCP，需要先准备 OpenAI Secure MCP Tunnel。也就是说，除了这个 MCP server，还需要安装并运行 OpenAI 的 `tunnel-client`。

Windows 第一次使用可以运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\init-windows.ps1 -AllowedRoots "D:\Projects" -OpenTunnelDownloadPages
```

这个脚本会帮你构建项目、配置允许访问的目录，并检查 tunnel-client 是否已经放好。

创建 ChatGPT 自定义连接器时，核心选项是：

```text
连接类型：Tunnel
身份验证：未授权 / No Authentication
本地 MCP 地址：http://127.0.0.1:3333/mcp
```

README 不放截图是有意的：ChatGPT UI 可能变，文字步骤更不容易过期，也更不容易泄露本机 tunnel 名称或账号信息。

---

## 常见问题

### `/mcp` 返回 400 是不是坏了？

不是。裸访问 `/mcp` 返回 `No valid MCP session` 很正常，说明 server 活着，但你没有发 MCP 初始化请求。

### 为什么不用 OAuth？

这个公开模板默认给个人本机 + 私有 tunnel 使用，所以用 No Auth 更简单。安全边界来自 localhost、私有 tunnel、allowed roots、deny rules、review mode。多人或生产环境请自行加认证。

### 我能不能设成 full 模式？

可以，但不建议。`full` 意味着 shell 限制会少很多。除非你完全信任本地环境和调用方，否则保持 `review`。

### 可以上传截图吗？

可以，但第一版建议不放。文字说明已经够用，而且截图容易过期。
