[中文](./README.zh.md) | English

# chatgpt-codex-tools-mcp

Codex-style local workspace tools exposed to ChatGPT through MCP.

ChatGPT does the reasoning. This server only provides constrained local tools: open a workspace, list/read/search/tree files, inspect git state, preview-then-confirm file edits, run a small allowlisted set of local commands, and optionally query/change SQLite databases with a structured preview-then-confirm workflow.

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
- Read/list/search/find/tree tools for inspection.
- Preview-then-confirm file editing with 9 edit types and multi-file batches.
- Git status/diff tools for review.
- `review` mode shell allowlist for low-risk verification commands.
- Best-effort secret redaction on tool output.
- Windows-friendly helper script that can reuse Codex's bundled Node runtime if present.
- Optional web tools (disabled by default): SearXNG search and public HTTP fetch.
- Optional SQLite tools (disabled by default): allowlisted read-only queries + structured preview-then-confirm updates with jsonSet support.

---

## Tools exposed to ChatGPT

| Tool | Purpose |
| --- | --- |
| `local_status` | Server status, access mode, allowed roots, caps, and feature flags. |
| `open_workspace` | Open a local project folder under `CTM_ALLOWED_ROOTS` and get a reusable workspaceId. |
| `list_dir` | List files in an open workspace. |
| `read_file` | Read a UTF-8 text file with output caps. |
| `search_files` | Full-text search in a workspace. Supports caseSensitive, contextLines, maxMatches, include/exclude globs. |
| `find_files` | Find files by glob pattern (e.g. `*.ts`, `**/config*`). |
| `project_tree` | Show a visual directory tree (depth-limited, skips node_modules/dist/.git). |
| `git_status` | Run `git status --short`. |
| `git_diff` | Run `git diff --stat` and `git diff`. |
| `preview_edit` | **(recommended)** Create a pending multi-file edit batch. Supports replace_text, replace_range, insert_before, insert_after, append, create, overwrite, rename, delete. |
| `confirm_edit` | Apply a pending edit batch by action id. |
| `preview_shell` | Queue a shell command for review. |
| `confirm_shell` | Execute a queued shell command. |
| `shell` | Run a local command, restricted by `CTM_ACCESS_MODE`. |
| `sqlite_status` | Show SQLite tools configuration. Always available. |
| `sqlite_schema` * | Inspect schema for an allowlisted database. |
| `sqlite_select` * | Run one read-only `SELECT`/`WITH` or safe `PRAGMA`. |
| `sqlite_preview_change` * | Preview a structured insert/update/delete on an allowed database. Supports jsonSet via dot-path keys (e.g. `job_json.enabled`). Does not write until confirmed. |
| `sqlite_confirm_change` * | Apply a pending SQLite change by action id. Re-verifies 'expected' fields before writing. |
| `web_status` | Show web tools configuration. Always available. |
| `web_search` * | Search the web via SearXNG. |
| `web_fetch` * | Fetch a public HTTP(S) page. Blocks localhost, private networks, and credentials. |

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
- Large edit, shell, and SQLite change payloads are rejected; split them into smaller preview calls.

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
| `CTM_WEB_TOOLS` | (not set) | Set to `1` to enable optional web tools (`web_search`, `web_fetch`). `web_status` is always available. |
| `CTM_SEARCH_PROVIDER` | `none` | `none` or `searxng`. Requires `CTM_WEB_TOOLS=1`. |
| `CTM_SEARXNG_URL` | (none) | SearXNG instance URL. Required when `CTM_SEARCH_PROVIDER=searxng`. |
| `CTM_WEB_MAX_BYTES` | `200000` | Max bytes returned by web_fetch. |
| `CTM_WEB_TIMEOUT_MS` | `15000` | Timeout for each web request. |
| `CTM_SQLITE_TOOLS` | (not set) | Set to `1` to enable optional SQLite tools. |
| `CTM_SQLITE_ALLOWED_DBS` | (none) | Comma-separated absolute SQLite database paths that tools may open. |
| `CTM_SQLITE_MAX_ROWS` | `100` | Max rows returned by SQLite tools. |

`env.example` contains a starter configuration. Copy it and adapt it locally, but do not publish your local environment file.

### SQLite tools

SQLite tools are opt-in and path-allowlisted. `sqlite_select` is read-only: it accepts one `SELECT`/`WITH` statement or a small set of safe `PRAGMA` statements.

Structured writes use a preview-then-confirm flow:

```text
sqlite_preview_change  →  returns action_id + before/after diff
sqlite_confirm_change  →  applies by action_id, re-verifies expected fields
```

Supported change types:
- **insert** – `table`, `columns`, `values`
- **update** – `table`, `set`, `where` (AND only), `limit` (default 1), `expected` (re-verify on confirm)
- **delete** – `table`, `where`, `limit` (default 1), `expected`
- **jsonSet** – use dot-path keys like `job_json.enabled` in `set` to update individual fields in a JSON text column via SQLite `json_set()`. The part before the first dot is the column name; the path after the dot navigates the JSON structure.

Table and column names are validated as safe SQL identifiers. WHERE only allows simple AND-joined conditions with parameterized values. No raw write SQL or subqueries.

Example:

```json
{
  "change": {
    "type": "update",
    "table": "cron_jobs",
    "set": { "name": "new-name", "job_json.enabled": false },
    "where": [{ "column": "job_id", "operator": "=", "value": "job_xxx" }],
    "expected": { "name": "old-name", "updated_at": 1712345678000 }
  }
}
```

### File editing tools

File edits use a preview-then-confirm flow:

```text
preview_edit  →  returns action_id + diffs per change
confirm_edit  →  applies all changes in the batch
```

Supported edit types (`changes[].type`):

| Type | Fields | Use case |
| --- | --- | --- |
| `replace_text` | `path`, `oldText`, `newText` | Find and replace exact text (backward compat with old patch flow). |
| `replace_range` | `path`, `startLine`, `endLine`, `newText` | Replace a line range with new content. |
| `insert_before` | `path`, `anchor`, `text` | Insert text before first occurrence of anchor. |
| `insert_after` | `path`, `anchorAfter`, `text` | Insert text after first occurrence of anchor. |
| `append` | `path`, `text` | Append text to end of file. |
| `create` | `path`, `text` | Create a new file (errors if exists). |
| `overwrite` | `path`, `newText` | Overwrite entire file content. |
| `rename` | `path`, `newPath` | Rename/move a file. |
| `delete` | `path` | Delete a file. |

### Search globs

`search_files.include`, `search_files.exclude`, and `find_files.pattern` accept common glob patterns:

- `*.ts` matches basenames anywhere in the searched tree.
- `src/**/*.ts` matches both `src/app.ts` and nested files such as `src/lib/app.ts`.
- Comma-separated patterns and brace alternatives are supported, for example `*.ts,*.tsx` or `{*.ts,*.tsx}`.

---

## Troubleshooting

### `No valid MCP session`

Normal for a raw GET request to `/mcp`. It only means the server is alive but no MCP session was initialized.

### ChatGPT asks for login

Create a fresh connector and choose **No Authentication / 未授权**. Old connector settings may still remember an OAuth flow.

### Path is outside allowed roots

Add the project parent folder to `CTM_ALLOWED_ROOTS`, then restart the MCP server.

### Shell command is blocked

You are in `review` mode. Use read/search/git/edit tools where possible. Only switch to `full` for trusted local use.

### SQLite tools are not available

Set `CTM_SQLITE_TOOLS=1`, add the database to `CTM_SQLITE_ALLOWED_DBS`, use a Node.js runtime with `node:sqlite`, then restart the MCP server.

### `dist/server.js not found`

Run:

```bash
npm install
npm run build
```
