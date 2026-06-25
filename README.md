[中文](./README.zh.md) | English

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
- Best-effort secret redaction on tool output.
- Windows-friendly helper script that can reuse Codex's bundled Node runtime if present.
- Optional web tools (disabled by default): SearXNG search and public HTTP fetch.
- Optional SQLite/OpenClaw cron tools (disabled by default): allowlisted read-only SQLite queries and preview/confirm cron job updates.

---

## Tools exposed to ChatGPT

| Tool | Purpose |
| --- | --- |
| `local_status` | Show server status, access mode, allowed roots, caps, and web tools config. |
| `open_workspace` | Open a local project folder under `CTM_ALLOWED_ROOTS`. |
| `list_dir` | List files in an open workspace. |
| `read_file` | Read a UTF-8 text file with output caps. |
| `search_files` | Search text in a workspace without requiring ripgrep. |
| `git_status` | Run `git status --short`. |
| `git_diff` | Run `git diff --stat` and `git diff`. |
| `preview_patch` | Create a pending replacement patch. |
| `confirm_patch` | Apply a pending patch by action id. |
| `preview_shell` | Create a pending shell action for write/publish commands. |
| `confirm_shell` | Execute a pending shell action after explicit confirmation. |
| `shell` | Run a local command, restricted by `CTM_ACCESS_MODE`. |
| `sqlite_status` | Show SQLite tools configuration. Always available. |
| `sqlite_schema` * | Inspect schema for an allowlisted SQLite database. Requires `CTM_SQLITE_TOOLS=1`. |
| `sqlite_select` * | Run one read-only `SELECT`/`WITH` or safe `PRAGMA` against an allowlisted SQLite database. Requires `CTM_SQLITE_TOOLS=1`. |
| `cron_list_jobs` * | List OpenClaw cron jobs from an allowlisted cron SQLite database. Requires `CTM_SQLITE_TOOLS=1`. |
| `cron_get_job` * | Read one OpenClaw cron job. Requires `CTM_SQLITE_TOOLS=1`. |
| `cron_preview_update_job` * | Preview changes to one OpenClaw cron job. Requires `CTM_SQLITE_TOOLS=1`. |
| `cron_confirm_update_job` * | Apply a pending cron update by action id. Requires `CTM_SQLITE_TOOLS=1`. |
| `web_status` | Show web tools configuration. Always available. |
| `web_search` * | Search the web via SearXNG. Requires `CTM_WEB_TOOLS=1` and `CTM_SEARCH_PROVIDER=searxng`. |
| `web_fetch` * | Fetch a public HTTP(S) page. Blocks localhost, private networks, and credentials. Requires `CTM_WEB_TOOLS=1`. |

\* _Optional tools, disabled by default unless their matching feature flag is enabled._

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
- Treat output redaction as a safety net, not a replacement for narrow `CTM_ALLOWED_ROOTS`, deny rules, and SQLite allowlists.

`review` mode blocks dangerous command patterns and only allows a small set of inspection/test commands such as `git status`, `git diff`, `dir`, `ls`, `node --version`, and `npm run ...`.

Commands that write to git history or publish to a remote, such as `git add`, `git commit`, `git remote`, `git push`, and `gh repo create`, are not allowed through direct shell in `review` mode. They must go through `preview_shell` first and then `confirm_shell` with the returned action id.

---

## Requirements

- Node.js 20+ recommended.
- npm.
- A ChatGPT custom connector that can connect to an MCP server.
- OpenAI `tunnel-client` if ChatGPT needs to reach this local server through Secure MCP Tunnel.
- A tunnel id and a runtime key for `tunnel-client`, created in OpenAI Platform tunnel settings.
- Optional SQLite tools require a Node.js runtime with `node:sqlite` support; Node.js 24+ is recommended for those tools.

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

## Windows quick start

For regular Windows users, use the root `.cmd` files. The PowerShell scripts under `scripts/` are implementation details and advanced entry points.

### 1. Initialize once

Run:

```text
init-windows.cmd
```

The initializer asks for or configures:

1. Allowed workspace roots, for example `D:\Projects`.
2. npm dependencies and `dist/server.js` build output.
3. The local `tunnel-client.exe` path.
4. Local-only startup files for this machine.

It creates these local startup files:

```text
start-mcp.local.cmd
start-tunnel.local.cmd
start-tunnel.local.ps1
```

The initializer does **not** save your runtime key. When the tunnel starts, it uses `CONTROL_PLANE_API_KEY` from the current environment if present; otherwise it asks for it with a hidden PowerShell prompt.

If `tunnel-client.exe` is missing, the initializer opens the download pages and shows the recommended local path. Download it, place it there, rerun `init-windows.cmd`, then run `start-all.cmd`.

Advanced initializer usage:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\init-windows.ps1 `
  -AllowedRoots "D:\Projects" `
  -OpenTunnelDownloadPages
```

### 2. Start MCP + tunnel

After initialization, run:

```text
start-all.cmd
```

It opens two windows:

1. MCP server window, using `start-mcp.local.cmd` or fallback `start-mcp.cmd`.
2. Tunnel window, using `start-tunnel.local.cmd`.

Keep both windows running while using the ChatGPT connector.

### 3. Optional single-purpose launchers

```text
start-mcp.cmd       # local MCP server only
start-tunnel.cmd    # private tunnel only, after initialization
```

PowerShell MCP-only entry point:

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
| `CTM_NPM_CACHE` | Optional npm cache folder location. |

Example:

```cmd
set "CTM_ALLOWED_ROOTS=D:\Projects"
set "OPENCLAW_NODE_BIN=C:\Tools\nodejs"
set "CTM_NPM_CACHE=D:\npm-cache"
start-mcp.cmd
```

---

## Private tunnel and ChatGPT connector

This project is meant to stay local. If ChatGPT needs to reach it, use OpenAI Secure MCP Tunnel rather than exposing the HTTP server publicly.

Tunnel prerequisites:

1. Create or choose a tunnel in OpenAI Platform tunnel settings.
2. Copy the tunnel id and runtime key from the tunnel details page. The tunnel startup script will ask for the runtime key when needed.
3. Download `tunnel-client` from OpenAI Platform tunnel settings or from the latest `openai/tunnel-client` release.
4. Keep the tunnel client running while testing from ChatGPT.

High-level tunnel setup:

```text
Local MCP server URL:
http://127.0.0.1:3333/mcp
```

Optional profile initialization:

```powershell
$env:CONTROL_PLANE_API_KEY = "YOUR_RUNTIME_KEY_HERE"
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
| `CTM_WEB_TOOLS` | (not set) | Set to `1` to enable optional web tools (`web_search`, `web_fetch`). `web_status` is always available regardless of this setting. |
| `CTM_SEARCH_PROVIDER` | `none` | `none` or `searxng`. Requires `CTM_WEB_TOOLS=1`. |
| `CTM_SEARXNG_URL` | (none) | SearXNG instance URL. Required when `CTM_SEARCH_PROVIDER=searxng`. |
| `CTM_WEB_MAX_BYTES` | `200000` | Max bytes returned by web_fetch. |
| `CTM_WEB_TIMEOUT_MS` | `15000` | Timeout for each web request. |
| `CTM_SQLITE_TOOLS` | (not set) | Set to `1` to enable optional SQLite and cron tools. |
| `CTM_SQLITE_ALLOWED_DBS` | (none) | Comma-separated absolute SQLite database paths that tools may open. |
| `CTM_SQLITE_MAX_ROWS` | `100` | Max rows returned by SQLite and cron list tools. |
| `CTM_CRON_DB_PATH` | (none) | OpenClaw cron SQLite database path, usually also listed in `CTM_SQLITE_ALLOWED_DBS`. |
| `CTM_CRON_STORE_KEY` | (none) | OpenClaw cron store key, for example the original `jobs.json` path. |

`env.example` contains a starter configuration. Copy it and adapt it locally, but do not publish your local environment file.

### SQLite and OpenClaw cron

SQLite tools are opt-in and path-allowlisted. `sqlite_select` is read-only: it accepts one `SELECT`/`WITH` statement or a small set of safe `PRAGMA` statements. Generic SQLite writes are intentionally not exposed.

OpenClaw cron changes should use the cron-specific preview/confirm flow:

```text
cron_list_jobs
cron_get_job
cron_preview_update_job
cron_confirm_update_job
```

Example local OpenClaw configuration:

```cmd
set "CTM_SQLITE_TOOLS=1"
set "CTM_SQLITE_ALLOWED_DBS=E:\openclaw\.openclaw\state\openclaw.sqlite"
set "CTM_CRON_DB_PATH=E:\openclaw\.openclaw\state\openclaw.sqlite"
set "CTM_CRON_STORE_KEY=E:\openclaw\.openclaw\cron\jobs.json"
```

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

### SQLite tools are not available

Set `CTM_SQLITE_TOOLS=1`, add the database to `CTM_SQLITE_ALLOWED_DBS`, use a Node.js runtime with `node:sqlite`, then restart the MCP server.

### `dist/server.js not found`

Run:

```bash
npm install
npm run build
```
