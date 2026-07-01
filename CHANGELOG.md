# Changelog

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
