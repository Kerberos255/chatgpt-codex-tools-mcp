# Changelog

## [0.2.0] - 2026-06-25

### Added

- Added `outputSchema` to all 15 MCP tools for structured content metadata.
- Optional web tools: `web_search`, `web_fetch` (disabled by default). `web_status` is always registered.
  - Config via `CTM_WEB_TOOLS`, `CTM_SEARCH_PROVIDER`, `CTM_SEARXNG_URL`, `CTM_WEB_MAX_BYTES`, `CTM_WEB_TIMEOUT_MS`.
- `local_status` now reports web tools config state in its JSON output.

### Changed

- `web_status` is now always registered; `CTM_WEB_TOOLS` only gates `web_search` and `web_fetch`.

### Breaking

- Renamed all MCP tools to remove the `codex_` prefix:
  - `codex_local_status` → `local_status`
  - `codex_workspace_open` → `open_workspace`
  - `codex_list_dir` → `list_dir`
  - `codex_read_file` → `read_file`
  - `codex_search_files` → `search_files`
  - `codex_git_status` → `git_status`
  - `codex_git_diff` → `git_diff`
  - `codex_apply_patch_preview` → `preview_patch`
  - `codex_apply_patch_confirm` → `confirm_patch`
  - `codex_shell_preview` → `preview_shell`
  - `codex_shell_confirm` → `confirm_shell`
  - `codex_shell` → `shell`

## v0.1.0 - Initial public release

- Local HTTP MCP server for ChatGPT custom connectors.
- Workspace allowlist via `CTM_ALLOWED_ROOTS`.
- Read/list/search tools for local projects.
- Git status/diff inspection tools.
- Patch preview and confirmation workflow.
- Review-mode shell allowlist.
- Windows initializer and launcher scripts.
- Private tunnel startup flow with runtime key prompt instead of saving keys to local files.
- English and Chinese README files.
