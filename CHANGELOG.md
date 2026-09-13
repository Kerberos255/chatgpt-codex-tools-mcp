# Changelog

## Unreleased

### Fixes

- Updated runtime validation and web error messages to use the compact action-based tool names (`edit`, `sqlite`, `web`) instead of retired public tool names.
- Added a regression test that rejects retired tool vocabulary in runtime sources and current README/security documentation.

### Documentation

- Corrected English and Chinese setup guidance for ChatGPT MCP apps, OpenAI Tunnel IDs/runtime permissions, Tailscale Funnel OAuth/public-ingress behavior, visible watchdog windows, and Windows Node/config precedence.
- Clarified that `mcp.denyGlobs` / `CTM_DENY_GLOBS` replace the built-in deny list rather than append to it, and removed the unsafe partial override example.
- Updated `SECURITY.md` to the current nine-tool action-based interface.


## v0.6.0 (2026-09-13)

### Improvements

- Added declared MCP `outputSchema` contracts for all nine exposed tools, matching their existing `structuredContent` payloads so clients can consume typed tool results without output-schema warnings.

### Fixes

- Fixed a PowerShell parser error in `configure-tailscale-funnel.ps1` by bracing `${LASTEXITCODE}` before a colon in the warning message.

### Breaking changes

- Consolidated the exposed MCP surface into nine tools: `local_status`, `open_workspace`, `files`, `git`, `edit`, `exec`, `sqlite`, `web`, and `screenshot`.
- Replaced the previous individual file, Git, process, SQLite, and web tool names with action-based single tools while preserving their capabilities and preview/confirm write safety.

### Added

- Added a Windows `screenshot` tool for desktop, monitor, window, and region capture. PNG pixels are returned directly as MCP image content; writing a file is optional and remains workspace-scoped.
- Window capture uses `PrintWindow`, while desktop/monitor/region capture uses GDI screen capture and reports a clear error when the interactive desktop is unavailable.

### Changed

- Local Git inspection is now intentionally limited to `git` actions `status` and `diff`; GitHub remote operations remain the responsibility of GitHub/`gh` tooling.
- `local_status` remains the single place for optional Web/SQLite feature status.
- Tailscale Funnel now runs in a dedicated foreground console instead of persistent `--bg` mode. Startup safely converts this project's existing 443 mapping, refuses to overwrite conflicting 443 routes, and the watchdog relaunches the foreground Funnel if the mapping disappears.

## v0.5.0 (2026-09-12)

### Added

- Windows initializer can configure OpenAI Secure MCP Tunnel, Tailscale Funnel, or both.
- Tunnel-specific local state now lives under `tunnel/openai` and `tunnel/tailscale`.
- Tailscale OAuth gateway support is included in the public project; the one-click launcher exposes MCP on Funnel HTTPS 443.

### Changed

- `init-windows.cmd` now generates only the selected `start-openai-mcp.cmd` and/or `start-tailscale-mcp.cmd` launchers.
- Removed the old public `start-all.cmd`, `start-mcp.cmd`, and `start-tunnel.cmd` entry points.
- Tailscale startup removes the retired experimental HTTPS 10000 / local 3335 MCP route without touching unrelated Funnel routes.
- Documented the expected foreground console windows for OpenAI and Tailscale startup, including that Tailscale Funnel itself runs through the Tailscale service rather than a separate console.


## v0.4.9 (2026-09-12)

### Fixes

- Removed the 30-minute inactivity expiry for MCP HTTP sessions, so long-idle ChatGPT windows can resume without receiving `Unknown MCP session` solely because of inactivity.

### Improvements

- Added a bounded LRU session registry. Sessions stay alive while the server process remains running, but memory use remains capped by `mcp.maxSessions` / `CTM_MAX_SESSIONS` (default `128`).
- Added tests for idle-session persistence, LRU eviction, and session-cap configuration.
- Documented the new session behavior and configuration in both READMEs and the Windows launcher templates.

## v0.4.8 (2026-07-10)

### Fixes

- Load `node:sqlite` lazily, so the core MCP server can start on Node.js 20 when optional SQLite tools are disabled.
- Derive the MCP server version from `package.json` to prevent release/version drift.
- Replace the tracked local `config.json` with a public `config.example.json`; generated local configuration is now ignored by Git.

### Improvements

- Added automated CI for Node.js 20/24, Windows PowerShell parsing, tests, server smoke checks, and release-package dry runs.
- Added tag-triggered Release automation with package-version and `main` ancestry gates, ZIP packaging, and SHA-256 checksums.
- Refreshed the English/Chinese README and security policy to match the current no-shell process and generic SQLite workflows.

## v0.4.7 (2026-07-08)

### Fixes

- Added a 30-minute inactivity TTL and periodic cleanup for stale MCP HTTP sessions, preventing unbounded session-map growth after dropped connections.

## v0.4.6 (2026-07-03)

### Improvements

- Clarified `preview_edit` input schema with type-specific required fields for each edit operation.
- Clarified `sqlite_preview_change` input schema with a discriminated insert/update/delete shape.

## v0.4.5 (2026-07-03)

### Breaking changes

- Removed the exposed shell tools: `shell`, `preview_shell`, and `confirm_shell`.

### Improvements

- Added `exec_process` for short foreground execution using structured `command` + `args[]` with no shell.
- Added managed background process tools: `process_start`, `process_read`, and `process_stop`.
- `git_status` now uses the no-shell process runner.
- `local_status` now reports tool groups so clients can present tools by type.
- Updated English and Chinese README tool docs to use type-based grouping and document the no-shell process workflow.

## v0.4.4 (2026-07-01)

### Fixes

- Fixed `sqlite_confirm_change` for update/delete on SQLite builds that do not support `UPDATE/DELETE ... LIMIT` by resolving target `rowid`s first and then applying bounded writes.
- Limited SQLite update previews to the same default/max row bounds used by confirm.

### Improvements

- `dist/server.js` now reads `config.json` directly, so configurable feature flags such as `web.enabled` and `sqlite.enabled` work without relying only on the Windows launcher environment mapping.
- `scripts/start-mcp.ps1` now passes its resolved config path to the runtime via `CTM_CONFIG_PATH`, keeping custom launcher config paths aligned with the server process.
- Updated English and Chinese README configuration docs to clarify that `config.json` is the normal local config file, not only a launcher shim.

## v0.4.3 (2026-07-01)

### Improvements

- Added `config.json` support for MCP launcher settings.
- Moved local MCP launcher defaults out of `start-mcp.cmd`.
- Removed obsolete MCP launcher variables for the old OpenClaw cron-specific tools.

## v0.4.2 (2026-07-01)

### Improvements

- `git_diff` now supports `staged`, `path`, `statOnly`, and `maxBytes` parameters.
- `search_files` now uses ripgrep (`rg`) when available, with the existing Node search as a fallback.
- `search_files` passes include/exclude globs and deny globs to ripgrep, while still filtering denied paths before returning output.

## v0.4.1

### Breaking changes

- Removed deprecated `preview_patch` and `confirm_patch` tool aliases. Use `preview_edit` and `confirm_edit`.

### Improvements

- Improved glob handling for `search_files` and `find_files`:
  - `*.ts` now matches basenames anywhere in the searched tree.
  - `src/**/*.ts` matches files directly under `src/` and nested below it.
  - Comma-separated patterns and brace alternatives such as `{*.ts,*.tsx}` are supported.
  - `search_files.include` is applied to files, not directories, so include filters no longer prune the whole tree too early.

### Internal changes

- Added `src/globs.ts` for shared glob matching.
- Removed no-longer-used `src/patches.ts`.

## v0.4.0

### ⚠️ Breaking changes

- **Removed OpenClaw cron-specific tools**: `cron_list_jobs`, `cron_get_job`, `cron_preview_update_job`, and `cron_confirm_update_job`. Use generic SQLite tools instead.
- **Replaced `filesystem` edit API** with a new generic `preview_edit`/`confirm_edit` pair that supports 9 edit types in multi-file batches.
- **SQLite tools restructured**: the old `codex_sqlite_store_status`, `codex_sqlite_store_schema`, `codex_sqlite_store_select`, `codex_sqlite_preview_change`, `codex_sqlite_confirm_change` have been renamed to `sqlite_status`, `sqlite_schema`, `sqlite_select`, `sqlite_preview_change`, `sqlite_confirm_change`. The UI labeling and category prefixes have been simplified.

### 🚀 New features

- **Payload guardrails**: large edit, shell, and SQLite change payloads are rejected with split-call guidance.
- **Generic file editing** (`preview_edit`/`confirm_edit`):
  - 9 edit types: replace_text, replace_range, insert_before, insert_after, append, create, overwrite, rename, delete.
  - Multi-file batches: one action can contain many changes across different files.
  - Preview produces per-change diffs before any file is touched.
- **Enhanced `search_files`**:
  - New `caseSensitive`, `contextLines`, `maxMatches`, `include`, `exclude` parameters.
  - Include/exclude use glob-style patterns.
- **New `find_files` tool** — find files by name pattern (glob).
- **New `project_tree` tool** — visual directory tree (depth-limited, skips common ignore dirs).
- **SQLite tools reworked**:
  - `sqlite_preview_change` now supports `expected` field re-verification on confirm for update/delete, preventing stale-preview writes.
  - Full `jsonSet` support via dot-path keys (e.g. `job_json.enabled`) in update `set`.
  - Insert validation matches columns/values length.
  - UI labels and descriptions simplified.
- **`preview_shell`/`confirm_shell`** — two-step shell approval for write/publish commands in review mode.
- **Server info updated**:
  - Version bumped to 0.4.0.
  - Description and MCP instructions updated to reflect new workflow and features.
- **README updated**:
  - Full documentation for new tools (`preview_edit`, `confirm_edit`, `find_files`, `project_tree`, `sqlite_preview_change`, `sqlite_confirm_change`).
  - SQLite jsonSet documentation.
  - Edit types reference table.
  - Renamed SQLite tool listing.

### 🛠 Internal changes

- **Deleted files**:
  - `src/sqlite-tools.ts` fully rewritten — removed `CronStore`, `openclawCronList`, `openclawCronCreate`, `codex_` prefix mapping.
- **New file**:
  - `src/edit-store.ts` — generic multi-file edit store with 9 edit types, preview + async apply logic.
- **Modified files**:
  - `src/server.ts`: Complete rewrite — new tool registration, `EditStore`/`ShellActionStore` instances, updated descriptions/messages, enhanced `search_files` implementation, new `find_files`/`project_tree` helpers.
  - `src/config.ts`: Removed no-longer-used config fields if any.
  - `README.md`, `README.zh.md`: Full documentation rewrite for v0.4.0.
  - `CHANGELOG.md`: This file.
  - `env.example`, `.env.example`: Removed OpenClaw cron config; added CTM_SQLITE_TOOLS/ALLOWED_DBS examples.

### 🗑 Removed

- **cron tools** (`cron_list_jobs`, `cron_get_job`, `cron_preview_update_job`, `cron_confirm_update_job`): These were tightly coupled to the OpenClaw cron format. Users who need cron data can use the generic SQLite tools instead.
- **`codex_` prefix**: All tools use `snake_case` without prefix, matching standard MCP naming conventions.

## v0.3.0

- Added SQLite tools (`codex_sqlite_store_*`): read schema and select from an allowlisted SQLite database.
- Added OpenClaw cron tools (`cron_list_jobs`, `cron_get_job`, `cron_preview_update_job`, `cron_confirm_update_job`) backed by an allowlisted SQLite database.
- Added config-driven optional SQLite/cron feature gating (`CTM_SQLITE_TOOLS`, `CTM_SQLITE_ALLOWED_DBS`, `CTM_CRON_TOOLS`, `CTM_CRON_DB_PATH`).
- Added best-effort secret redaction on tool output (sensitive values matched against `CTM_SECRET_PATTERNS` or common patterns).
- v0.3.0 SQLite tools used `codex_sqlite_store_` prefix.

## v0.2.0

- Renamed all tools to remove `codex_` prefix for a cleaner MCP schema.
- Added optional `web_search` and `web_fetch` tools, gated behind `CTM_WEB_TOOLS`.
- Added `web_status` tool.
- Reworked process runner with timeout and output byte cap.
- Added `search_files` tool (basic text search).
- Added output byte cap to shell tool.
- Added `CTM_DENY_GLOBS` and global deny rules.
- Added `CTM_MAX_READ_BYTES` and `CTM_MAX_OUTPUT_BYTES` config.
- Added Windows startup scripts and `initialize`/`init-windows.cmd` helper.
- Enhanced secret redaction to be config-driven.

## v0.1.0

- Initial release.
- Local MCP server with workspace boundary (`CTM_ALLOWED_ROOTS`).
- File read/list, shell (review/full mode), git status/diff, `patch` (single replace_text preview-then-apply).
- Basic secret redaction.
- Config via environment variables or dotenv.
