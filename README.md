[简体中文](./README.zh.md) | English

# chatgpt-codex-tools-mcp

A local MCP server that gives ChatGPT a constrained, Codex-style toolbox for
working with your own projects.

ChatGPT does the reasoning. This server provides workspace-scoped file reading,
search, Git inspection, preview-before-confirm edits, structured process
execution without a shell, and optional web and SQLite tools.

> Community project; not affiliated with OpenAI or Codex.
>
> The MCP endpoint has no application-layer authentication. Keep it bound to
> `127.0.0.1` and place a trusted ingress in front of it. With Tailscale Funnel,
> expose only the OAuth gateway on `127.0.0.1:3334`, never MCP port `3333` directly.

## Highlights

- Local HTTP MCP endpoint: `http://127.0.0.1:3333/mcp`
- Workspace boundary through `CTM_ALLOWED_ROOTS`
- Built-in deny rules for common private files and sensitive paths
- Preview-then-confirm file and SQLite writes
- Structured `command` + `args[]` execution; no shell syntax or shell tool
- Foreground and managed background processes with time/output limits
- Best-effort secret redaction on tool output
- Optional SearXNG search and public HTTP fetch, disabled by default
- Optional allowlisted SQLite reads and bounded structured writes, disabled by default
- Windows initializer for OpenAI Secure MCP Tunnel, Tailscale Funnel, or both

## Requirements

- Node.js 20 or newer for the core server; Node.js 24 is recommended
- npm
- ChatGPT access that supports custom MCP apps / connectors in Developer Mode (availability depends on plan and workspace policy)
- OpenAI `tunnel-client` for the OpenAI Secure MCP Tunnel path, or Tailscale for the Funnel path
- SQLite tools require a runtime with `node:sqlite` support (Node.js 22.5+;
  Node.js 24+ recommended)

On Windows, `scripts/start-mcp.ps1` resolves Node from explicit PowerShell parameters first, then environment overrides, then `config.json`. If none of those select a runtime, it falls back to the Codex bundled runtime under `%LOCALAPPDATA%\OpenAI\Codex\runtimes\cua_node`, then `node` on `PATH`. Relevant settings are `runtime.codexRuntimeRoot` / `CTM_CODEX_RUNTIME_ROOT` and `runtime.fallbackNodeBin` / `OPENCLAW_NODE_BIN`.

## Windows quick start

### 1. Get the project

Download the ZIP attached to the latest GitHub Release and extract it, or clone:

```powershell
git clone https://github.com/Kerberos255/chatgpt-codex-tools-mcp.git
cd chatgpt-codex-tools-mcp
```

### 2. Initialize once

Run:

```text
init-windows.cmd
```

The initializer:

- asks for narrow allowed workspace roots, such as `D:\Projects`
- installs npm dependencies and builds `dist/server.js`
- lets you choose **OpenAI Secure MCP Tunnel**, **Tailscale Funnel**, or **Both**
- creates an ignored local `config.json` on first setup and preserves an existing one unless explicitly forced
- creates `tunnel\openai` and/or `tunnel\tailscale` for tunnel-specific binaries, profiles, and local state
- reuses an existing tunnel runtime when possible; otherwise downloads the selected runtime from its official distribution source
- verifies the downloaded OpenAI `tunnel-client` ZIP against the release `SHA256SUMS.txt`
- generates only the selected one-click launcher(s)

Depending on your selection, the project root gains:

```text
start-openai-mcp.cmd
start-tailscale-mcp.cmd
```

You can run `init-windows.cmd` again later and configure the other tunnel too; the existing launcher is kept, so both can coexist.

OpenAI-specific local files live under `tunnel\openai`. The launcher reads `CONTROL_PLANE_API_KEY` from the environment, then `tunnel\openai\control-plane-api-key.txt` when present, or asks for it with a hidden prompt.

First-time OpenAI setup also needs the OpenAI Tunnel ID used by ChatGPT and `tunnel-client`; `init-windows.cmd` asks for it when no matching local profile exists. The runtime API key should have Tunnels **Read + Use** permission for that tunnel; do not substitute a tunnel-admin key for the long-running runtime.

Tailscale-specific local files live under `tunnel\tailscale`. The initializer creates `owner-password.txt` for the local OAuth approval page and keeps OAuth state in the same directory.

### 3. Start MCP and your tunnel

For OpenAI Secure MCP Tunnel:

```text
start-openai-mcp.cmd
```

For Tailscale Funnel:

```text
start-tailscale-mcp.cmd
```

Each launcher starts the MCP server when needed, then starts only its own tunnel path. The Tailscale launcher exposes MCP as `HTTPS 443 -> OAuth gateway 3334 -> MCP 3333`.

On a normal cold start, the main visible console windows are:

- OpenAI mode: **Codex MCP Server** + **OpenAI MCP Tunnel** + **OpenAI MCP Tunnel Watchdog**.
- Tailscale mode: **Codex MCP Server** + **Tailscale OAuth Gateway** + **Tailscale Funnel** + **Tailscale MCP Watchdog**.

The Tailscale Funnel deliberately runs in the foreground. Keep its window open while using the Tailscale connection; closing it or pressing `Ctrl+C` stops the Funnel mapping on HTTPS 443. The watchdog monitors the MCP server, OAuth gateway, and Funnel route and can relaunch a missing foreground Funnel window. Components that are already healthy are reused instead of duplicated.

### 4. Configure ChatGPT

Create a custom MCP app in ChatGPT Developer Mode / Apps and provide the endpoint for the tunnel path you selected. Product availability and exact UI labels can vary by plan and workspace policy; see [OpenAI's current Developer Mode / MCP apps documentation](https://help.openai.com/en/articles/12584461).

For OpenAI Secure MCP Tunnel, choose **Connection: Tunnel** in ChatGPT and select the tunnel or paste the same Tunnel ID used during initialization. Because this MCP server itself has no application-layer authentication, choose **No Authentication** if the UI asks for MCP authentication.

For Tailscale Funnel, use:

```text
https://<your-machine>.<your-tailnet>.ts.net/mcp
```

Use OAuth discovery. When the approval page opens, enter the local Owner Password from `tunnel\tailscale\owner-password.txt`.

Tailscale Funnel is public internet ingress. First-time Funnel use can require tailnet permission plus MagicDNS/HTTPS enablement; see [Tailscale's Funnel requirements](https://tailscale.com/docs/features/tailscale-funnel).

The MCP server itself remains bound to `127.0.0.1` in both modes.

## Manual installation (Windows, macOS, Linux)

```bash
git clone https://github.com/Kerberos255/chatgpt-codex-tools-mcp.git
cd chatgpt-codex-tools-mcp
npm ci
npm run build
```

Create your local configuration from the public template:

```bash
cp config.example.json config.json
```

On Windows PowerShell:

```powershell
Copy-Item config.example.json config.json
```

Edit `config.json`, then start:

```bash
npm start
```

Core server settings are read from `config.json` and environment variables. Windows launcher-only settings under `runtime`, `proxy`, and `environment` are applied by `scripts/start-mcp.ps1`. Environment variables and explicit PowerShell parameters take precedence over matching `config.json` values. Without a config file, conservative defaults are used.

## Connection path

OpenAI path:

```text
ChatGPT -> OpenAI Secure MCP Tunnel -> tunnel\openai\tunnel-client.exe
        -> http://127.0.0.1:3333/mcp -> allowed local workspaces
```

Tailscale path:

```text
ChatGPT -> Tailscale Funnel HTTPS 443 -> OAuth gateway 127.0.0.1:3334
        -> MCP 127.0.0.1:3333 -> allowed local workspaces
```

Health endpoint:

```text
http://127.0.0.1:3333/healthz
```

A raw GET request to `/mcp` may return `No valid MCP session`; that is normal
until an MCP session has been initialized.

Initialized MCP sessions do not expire merely because a ChatGPT window is idle.
Memory is bounded with an LRU session cap (`mcp.maxSessions`, default `128`):
only the least-recently-used sessions are closed when the cap is exceeded. A
server restart still resets all sessions.

## Tools

| Group | Tool | Actions / purpose |
| --- | --- | --- |
| Meta | `local_status` | Show version, access mode, roots, limits, and Web/SQLite feature status. |
| Workspace | `open_workspace` | Open a directory under `CTM_ALLOWED_ROOTS` and return a `workspaceId`. |
| Files | `files` | `list`, `read`, `search`, `find`; recursive `list` with `depth` replaces the old project-tree tool. |
| Git | `git` | Local `status` and `diff` only. Use GitHub/`gh` tooling for remote operations. |
| Edit | `edit` | `preview` and `confirm` bounded multi-file edits. |
| Exec | `exec` | `run`, `start`, `read`, `stop` structured executables without a shell. |
| SQLite | `sqlite` | Optional allowlisted `schema`, `select`, `preview`, `confirm`. |
| Web | `web` | Optional `search` and public HTTP `fetch`. |
| Capture | `screenshot` | Windows `desktop`, `monitor`, `window`, or `region` capture; returns PNG image content directly. |

The public MCP surface is intentionally kept to these nine tools. Web and SQLite
actions report a clear disabled error when their feature is off; `local_status`
shows the current configuration.

## Recommended workflow

```text
open_workspace
  -> files / git
  -> edit(action="preview")
  -> review the diff
  -> edit(action="confirm", actionId=...)
```

For processes, pass an action, a real executable, and an argv array:

```json
{
  "action": "run",
  "workspaceId": "...",
  "command": "npm",
  "args": ["run", "build"]
}
```

Pipes, redirects, command chaining, shell expansion, and shell builtins are not
supported.

## Access modes

```text
CTM_ACCESS_MODE=review   # default
CTM_ACCESS_MODE=full
```

- `review` permits a small inspection/test process allowlist.
- `full` permits broader structured executables.
- Both modes still block direct shells (`cmd`, PowerShell, `sh`, `bash`) and
  dangerous process patterns.
- Specialized read, Git, edit, web, and SQLite tools should be preferred over
  generic process execution.

## Configuration

`config.example.json` is the public template. `config.json` is local, generated
or copied by the user, and ignored by Git.

```json
{
  "mcp": {
    "host": "127.0.0.1",
    "port": 3333,
    "allowedRoots": ["D:\\Projects"],
    "accessMode": "review",
    "maxReadBytes": 200000,
    "maxOutputBytes": 200000,
    "maxSessions": 128
  },
  "runtime": {
    "codexRuntimeRoot": "",
    "fallbackNodeBin": "",
    "npmCache": ""
  },
  "proxy": {
    "url": "",
    "noProxy": "127.0.0.1,localhost,::1",
    "nodeUseEnvProxy": false
  },
  "web": {
    "enabled": false,
    "searchProvider": "none",
    "searxngUrl": "",
    "maxBytes": 200000,
    "timeoutMs": 15000
  },
  "sqlite": {
    "enabled": false,
    "allowedDbs": [],
    "maxRows": 100
  },
  "environment": {}
}
```

Common environment overrides:

| Setting | Environment variable | Default |
| --- | --- | --- |
| Host / port | `HOST`, `PORT` | `127.0.0.1`, `3333` |
| Allowed roots | `CTM_ALLOWED_ROOTS` | current project directory |
| Access mode | `CTM_ACCESS_MODE` | `review` |
| Deny rules override | `CTM_DENY_GLOBS` | built-in deny list |
| Read/output caps | `CTM_MAX_READ_BYTES`, `CTM_MAX_OUTPUT_BYTES` | `200000` |
| MCP session cap | `CTM_MAX_SESSIONS` | `128` |
| Web tools | `CTM_WEB_TOOLS` | disabled |
| Search provider | `CTM_SEARCH_PROVIDER`, `CTM_SEARXNG_URL` | `none` |
| Web limits | `CTM_WEB_MAX_BYTES`, `CTM_WEB_TIMEOUT_MS` | `200000`, `15000` |
| SQLite tools | `CTM_SQLITE_TOOLS` | disabled |
| SQLite allowlist | `CTM_SQLITE_ALLOWED_DBS` | empty |
| SQLite row cap | `CTM_SQLITE_MAX_ROWS` | `100` |
| Config path | `CTM_CONFIG_PATH` | `<project>/config.json` |

See `env.example` for advanced runtime and proxy overrides.

`mcp.denyGlobs` and `CTM_DENY_GLOBS` **replace** the built-in deny list; they do not append to it. If you override them, include every default pattern you still want protected plus your additional rules.

Do not put tunnel runtime keys in `config.json`. For OpenAI Tunnel, keep
`CONTROL_PLANE_API_KEY` in the current environment or the Git-ignored local
`tunnel\openai\control-plane-api-key.txt` file.

## Optional web tools

Enable in `config.json`:

```json
{
  "web": {
    "enabled": true,
    "searchProvider": "searxng",
    "searxngUrl": "http://127.0.0.1:8888"
  }
}
```

- `web` with `action="search"` queries only the configured SearXNG instance.
- `web` with `action="fetch"` accepts public HTTP(S) URLs and blocks localhost,
  private network targets, embedded credentials, and unsafe redirects.
- No cookies, browser login state, authorization headers, or client certificates
  are forwarded.

## Optional SQLite tools

Enable SQLite and list exact database paths:

```json
{
  "sqlite": {
    "enabled": true,
    "allowedDbs": ["D:\\Data\\app.sqlite"],
    "maxRows": 100
  }
}
```

- `sqlite` with `action="schema"` reads schema metadata.
- `sqlite` with `action="select"` accepts one read-only `SELECT`/`WITH` or safe `PRAGMA`.
- Writes use `sqlite` with `action="preview"`, followed by `action="confirm"` with the returned `actionId`.
- Insert, bounded update/delete, expected-field revalidation, and `jsonSet`
  dot paths such as `job_json.enabled` are supported.
- Raw write SQL and subqueries are not exposed.

## File edit operations

`edit` with `action="preview"` accepts multi-file batches with these operation types:

```text
replace_text   replace_range   insert_before   insert_after
append         create          overwrite       rename         delete
```

The preview returns an action id and per-file diffs. `edit` with `action="confirm"`
rechecks workspace and deny boundaries before applying the batch. File batches are not
transactional, so keep related edits small and review the entire preview.

## Screenshot tool

`screenshot` is available on Windows and returns PNG pixels directly as MCP image content. By default it does not write a file.

- `mode="window"` accepts a case-insensitive `windowTitle` substring or a `windowHandle`; it uses Windows `PrintWindow`, so it can capture a window even when it is obscured.
- `mode="desktop"`, `monitor`, and `region` capture the interactive desktop. Windows may deny screen-surface access while the desktop is locked or switched away; the tool reports that condition instead of returning a blank image.
- Optional `savePath` is workspace-relative, requires `workspaceId`, and still passes the normal workspace and deny-path checks.

## Security rules

- Keep `HOST=127.0.0.1`.
- Use narrow allowed roots; never use an entire system drive or `/`.
- Keep `review` mode unless broader process execution is required.
- Do not expose the endpoint directly to the internet.
- Tailscale Funnel is public internet ingress; keep Funnel pointed at the OAuth gateway on `127.0.0.1:3334`, never directly at MCP port `3333`.
- Keep web and SQLite tools disabled unless needed.
- Treat redaction as a final safety net, not the primary boundary.
- Review every edit and SQLite preview before confirming.

See [`SECURITY.md`](SECURITY.md) for the full policy.

## Development

```bash
npm ci
npm run typecheck
npm run build
npm test
npm run check
```

The test suite covers configuration precedence, session LRU behavior, glob
matching, secret redaction, optional SQLite loading, repository/version
consistency, and CI/CD gates.

## CI and releases

Pull requests run CI on Node.js 20 and 24, smoke-test the HTTP server, parse all
PowerShell scripts on Windows, and perform a release-package dry run.

Pushing a tag that exactly matches `package.json`, such as `v0.6.0`, triggers
the Release workflow. It verifies that the tagged commit belongs to `main`,
runs the full checks, builds a ZIP containing source plus compiled `dist`,
generates `SHA256SUMS.txt`, and creates the GitHub Release.

## Troubleshooting

### Authentication behavior is unexpected

For OpenAI Secure MCP Tunnel, create or recreate the MCP app with **No Authentication**. For Tailscale Funnel, an OAuth authorization prompt is expected: use OAuth discovery and enter the Owner Password from `tunnel\tailscale\owner-password.txt`. Old app settings may retain a previous authentication choice.

### Path is outside allowed roots

Add the project parent directory to `mcp.allowedRoots` or
`CTM_ALLOWED_ROOTS`, then restart the server.

### Process command is blocked

Use specialized tools first. In `review` mode, only the small process allowlist
is accepted. Shell executables and shell syntax are blocked in every mode.

### SQLite tools are unavailable

Enable SQLite, add an exact database path, and use a Node runtime with
`node:sqlite` support. `local_status` reports whether SQLite is enabled and
which databases are allowlisted.

### `dist/server.js` is missing

```bash
npm ci
npm run build
```

### Tunnel runtime is missing

Rerun `init-windows.cmd` and select the affected tunnel. The initializer reuses
an installed runtime when possible. Otherwise it downloads OpenAI
`tunnel-client` from the official GitHub Release and verifies its SHA256, or
downloads the current stable Tailscale Windows installer from Tailscale.

## Repository boundaries

The repository and Release package do not include:

- `node_modules`
- local `config.json`
- the local `tunnel/` directory (binaries, profiles, OAuth state, and runtime keys)
- generated `start-openai-mcp.cmd` / `start-tailscale-mcp.cmd` launchers
- logs or workspace data

## License

MIT. See [`LICENSE`](LICENSE).
