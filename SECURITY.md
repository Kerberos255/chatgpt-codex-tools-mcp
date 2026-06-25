# Security Policy

## Intended use

This project is intended for personal, local use with a private MCP tunnel. It is not designed to be exposed directly to the public internet.

## Safe defaults

- The HTTP server binds to `127.0.0.1` by default.
- The default access mode is `review`.
- Files can only be opened under `CTM_ALLOWED_ROOTS`.
- Common private-file names and sensitive paths are denied by default.
- Patches require preview before confirm.
- Shell commands are blocked in `review` mode unless they match a small low-risk allowlist.
- Tool output is passed through best-effort secret redaction.

## Do not do this

- Do not bind the server to `0.0.0.0` unless you add your own protection layer.
- Do not set `CTM_ALLOWED_ROOTS` to an entire system drive such as `C:\` or `/`.
- Do not publish local private files, logs, or workspace data.
- Do not switch to `CTM_ACCESS_MODE=full` unless you fully understand the risks.
- Do not rely on output redaction as the only protection layer. Keep allowed roots and database allowlists narrow.

## Optional web tools

When enabled (`CTM_WEB_TOOLS=1`), two extra tools are available: `web_search` and `web_fetch`. `web_status` is always available regardless of this setting.

They are disabled by default and must be explicitly opted into:

- `web_search` only queries the configured SearXNG instance (`CTM_SEARXNG_URL`). It does not contact any other search provider.
- `web_fetch` blocks localhost, private network addresses (RFC 1918, IPv6 private/ULA/link-local), and URLs with embedded credentials. Redirect targets are rechecked before each hop.
- Neither tool sends cookies, Authorization headers, browser login state, or client certificates.
- Both tools are subject to `CTM_WEB_MAX_BYTES` and `CTM_WEB_TIMEOUT_MS` limits.

## Optional SQLite and cron tools

When enabled (`CTM_SQLITE_TOOLS=1`), SQLite tools can only open databases explicitly listed in `CTM_SQLITE_ALLOWED_DBS`.

- `sqlite_schema` only returns SQLite schema metadata.
- `sqlite_select` only allows one read-only `SELECT`/`WITH` statement or a small set of safe `PRAGMA` statements.
- Generic SQLite writes are not exposed.
- OpenClaw cron writes are limited to `cron_preview_update_job` followed by `cron_confirm_update_job`.
- Cron updates check that the job was not changed between preview and confirm.
- SQLite and cron outputs still pass through redaction before being returned to ChatGPT.

---

# 安全策略

## 设计用途

本项目面向个人本机使用，建议配合私有 MCP tunnel。它不适合直接暴露到公网。

## 默认安全边界

- HTTP server 默认绑定 `127.0.0.1`。
- 默认模式是 `review`。
- 只能打开 `CTM_ALLOWED_ROOTS` 指定范围内的文件夹。
- 默认阻止常见私人文件名和敏感路径。
- 修改文件必须先 preview，再 confirm。
- `review` 模式下 shell 只允许少量低风险命令。
- 工具输出会经过尽力而为的敏感值脱敏。

## 不要这样做

- 不要在没有额外保护层的情况下绑定到 `0.0.0.0`。
- 不要把 `CTM_ALLOWED_ROOTS` 设置成整个系统盘，比如 `C:\` 或 `/`。
- 不要发布本机私人文件、日志或工作区数据。
- 不理解风险时不要切换到 `CTM_ACCESS_MODE=full`。
- 不要把输出脱敏当成唯一防线。仍应收窄 allowed roots 和数据库白名单。

## 可选 web 工具的安全边界

启用 `CTM_WEB_TOOLS=1` 后，会额外暴露 `web_search`、`web_fetch` 两个工具。`web_status` 始终可用，不受此设置影响。默认关闭，需明确启用。

- `web_search` 只访问配置的 SearXNG 实例（`CTM_SEARXNG_URL`），不联系其他搜索服务。
- `web_fetch` 阻止 localhost、内网地址（RFC 1918、IPv6 私有/ULA/链路本地）以及带凭据的 URL。重定向目标在每次跳转前重新检查。
- 两个工具都不发送 cookie、Authorization 头、浏览器登录态或客户端证书。
- 受 `CTM_WEB_MAX_BYTES` 和 `CTM_WEB_TIMEOUT_MS` 限制。

## 可选 SQLite 和 cron 工具

启用 `CTM_SQLITE_TOOLS=1` 后，SQLite 工具只能打开 `CTM_SQLITE_ALLOWED_DBS` 明确列出的数据库。

- `sqlite_schema` 只返回 SQLite schema 元数据。
- `sqlite_select` 只允许单条只读 `SELECT`/`WITH` 或少量安全 `PRAGMA`。
- 不暴露通用 SQLite 写入能力。
- OpenClaw cron 写入仅限 `cron_preview_update_job` 后接 `cron_confirm_update_job`。
- cron 确认写入前会检查任务是否在 preview 后被其他进程改过。
- SQLite 和 cron 输出仍会先脱敏再返回给 ChatGPT。
