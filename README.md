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
> `127.0.0.1` and connect through a private MCP tunnel. Do not expose it directly
> to the public internet.

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
- Windows initializer and launchers for the MCP server and private tunnel

## Requirements

- Node.js 20 or newer for the core server; Node.js 24 is recommended
- npm
- A ChatGPT custom connector with Secure MCP Tunnel support
- OpenAI `tunnel-client` when ChatGPT must reach this local endpoint
- SQLite tools require a runtime with `node:sqlite` support (Node.js 22.5+;
  Node.js 24+ recommended)

On Windows, `scripts/start-mcp.ps1` looks for Node in this order:

1. Codex bundled runtime under `%LOCALAPPDATA%\OpenAI\Codex\runtimes\cua_node`
2. `OPENCLAW_NODE_BIN`
3. `node` on `PATH`

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
- locates your local `tunnel-client.exe`
- creates an ignored local `config.json`
- creates local-only MCP and tunnel launchers

Generated local files include:

```text
config.json
start-mcp.local.cmd
start-tunnel.local.cmd
start-tunnel.local.ps1
```

`CONTROL_PLANE_API_KEY` is not stored. The tunnel launcher reads it from the
current environment or asks for it using a hidden prompt.

### 3. Start MCP and tunnel

Run:

```text
start-all.cmd
```

Keep both opened windows running while the ChatGPT connector is in use.

Single-purpose launchers are also available:

```text
start-mcp.cmd       # local MCP server only
start-tunnel.cmd    # private tunnel only, after initialization
```

### 4. Configure ChatGPT

Create a custom connector that uses the private tunnel and choose
**No Authentication**. The local server itself should remain bound to
`127.0.0.1`.

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

Environment variables and explicit PowerShell parameters override
`config.json`. Without a config file, conservative defaults are used.

## Connection path

```text
ChatGPT custom connector
  -> private Secure MCP Tunnel
  -> tunnel-client on your machine
  -> http://127.0.0.1:3333/mcp
  -> chatgpt-codex-tools-mcp
  -> allowed local workspaces only
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

| Group | Tools | Purpose |
| --- | --- | --- |
| Meta | `local_status` | Show version, access mode, roots, limits, and optional feature status. |
| Workspace | `open_workspace` | Open a directory under `CTM_ALLOWED_ROOTS` and return a `workspaceId`. |
| Read | `list_dir`, `read_file`, `search_files`, `find_files`, `project_tree` | Inspect project content without writing. |
| Git | `git_status`, `git_diff` | Review working-tree state and staged/unstaged diffs. |
| Edit | `preview_edit`, `confirm_edit` | Preview and then apply bounded multi-file edits. |
| Process | `exec_process`, `process_start`, `process_read`, `process_stop` | Run structured local executables without a shell. |
| SQLite | `sqlite_status`, `sqlite_schema`, `sqlite_select`, `sqlite_preview_change`, `sqlite_confirm_change` | Optional allowlisted database inspection and structured writes. |
| Web | `web_status`, `web_search`, `web_fetch` | Optional SearXNG search and public HTTP fetch. |

Optional web and SQLite tools are registered only when enabled. Their status
tools remain available for diagnostics.

## Recommended workflow

```text
open_workspace
  -> inspect with read/search/tree and git tools
  -> preview_edit
  -> review the diff
  -> confirm_edit
```

For processes, pass a real executable and an argv array:

```json
{
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
    "denyGlobs": ["**/.env", "**/key.txt"],
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
| Extra deny rules | `CTM_DENY_GLOBS` | built-in deny list |
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

Do not put tunnel runtime keys in `config.json`. Keep
`CONTROL_PLANE_API_KEY` in the current environment or another private local
mechanism.

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

- `web_search` queries only the configured SearXNG instance.
- `web_fetch` accepts public HTTP(S) URLs and blocks localhost, private network
  targets, embedded credentials, and unsafe redirects.
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

- `sqlite_schema` reads schema metadata.
- `sqlite_select` accepts one read-only `SELECT`/`WITH` or safe `PRAGMA`.
- Writes use `sqlite_preview_change` followed by `sqlite_confirm_change`.
- Insert, bounded update/delete, expected-field revalidation, and `jsonSet`
  dot paths such as `job_json.enabled` are supported.
- Raw write SQL and subqueries are not exposed.

## File edit operations

`preview_edit` accepts multi-file batches with these operation types:

```text
replace_text   replace_range   insert_before   insert_after
append         create          overwrite       rename         delete
```

The preview returns an action id and per-file diffs. `confirm_edit` rechecks
workspace and deny boundaries before applying the batch. File batches are not
transactional, so keep related edits small and review the entire preview.

## Security rules

- Keep `HOST=127.0.0.1`.
- Use narrow allowed roots; never use an entire system drive or `/`.
- Keep `review` mode unless broader process execution is required.
- Do not expose the endpoint directly to the internet.
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

Pushing a tag that exactly matches `package.json`, such as `v0.4.9`, triggers
the Release workflow. It verifies that the tagged commit belongs to `main`,
runs the full checks, builds a ZIP containing source plus compiled `dist`,
generates `SHA256SUMS.txt`, and creates the GitHub Release.

## Troubleshooting

### ChatGPT asks for login

Create a new connector and choose **No Authentication**. Old connector settings
may retain a previous OAuth choice.

### Path is outside allowed roots

Add the project parent directory to `mcp.allowedRoots` or
`CTM_ALLOWED_ROOTS`, then restart the server.

### Process command is blocked

Use specialized tools first. In `review` mode, only the small process allowlist
is accepted. Shell executables and shell syntax are blocked in every mode.

### SQLite tools are unavailable

Enable SQLite, add an exact database path, and use a Node runtime with
`node:sqlite` support. `sqlite_status` reports whether the current runtime has
that module.

### `dist/server.js` is missing

```bash
npm ci
npm run build
```

### Tunnel client is missing

Download `tunnel-client` from OpenAI Platform tunnel settings, place it at the
path shown by `init-windows.cmd`, and rerun initialization.

## Repository boundaries

The repository and Release package do not include:

- `node_modules`
- local `config.json`
- tunnel runtime keys
- generated local launchers
- logs or workspace data

## License

MIT. See [`LICENSE`](LICENSE).
