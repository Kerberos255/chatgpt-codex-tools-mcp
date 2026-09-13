# Security Policy

## Intended use

This project is intended for personal or small-team local use behind a trusted
ingress. The core MCP server is not an internet-facing service and does not
implement application-layer authentication. Secure MCP Tunnel can keep MCP
private; Tailscale Funnel must expose only the OAuth gateway, not MCP directly.

## Security boundaries

- The server binds to `127.0.0.1` by default.
- Workspaces must be under `CTM_ALLOWED_ROOTS`.
- Built-in and user-defined deny globs block common private files and paths.
- File and SQLite writes require preview followed by explicit confirmation.
- There is no shell tool. Process tools use structured executable + argv input.
- Direct shell executables and dangerous process patterns are blocked in every
  access mode.
- Process environment variables with secret-like names are removed before spawn.
- Tool output passes through best-effort secret redaction.
- Web and SQLite capabilities are disabled by default and separately gated.
- Reads, process output, payloads, rows, and execution time are bounded.

## Access modes

- `review` allows only a small inspection/test process allowlist.
- `full` allows broader structured executables, but still blocks direct shells
  and dangerous argument patterns.

`full` is not equivalent to unrestricted shell access.

## Required deployment practices

- Keep `HOST=127.0.0.1`.
- Use Secure MCP Tunnel or another trusted ingress.
- If using Tailscale Funnel, route public ingress only to the OAuth gateway on `127.0.0.1:3334`.
- Do not expose the core MCP listener on `127.0.0.1:3333` directly to the public internet.
- Set narrow allowed roots; never use an entire drive or `/`.
- Keep `review` mode unless broader process execution is necessary.
- Keep `config.json`, tunnel keys, generated launchers, logs, and workspace data
  out of source control.
- Treat redaction as a final safety net, not a substitute for narrow boundaries.

## File writes

`edit` with `action="preview"` returns the proposed per-file diff and an action id.
`edit` with `action="confirm"` rechecks workspace and deny boundaries before applying it.
Multi-file edits are not transactional, so use small batches and review every
change before confirmation.

## SQLite tools

When enabled, SQLite access is restricted to exact paths in
`CTM_SQLITE_ALLOWED_DBS` / `sqlite.allowedDbs`.

- `sqlite` with `action="schema"` returns schema metadata.
- `sqlite` with `action="select"` accepts one read-only `SELECT`/`WITH` or safe `PRAGMA`.
- Writes use `sqlite` preview/confirm actions with bounded structured insert/update/delete operations.
- Update/delete confirmation can revalidate expected fields to prevent stale
  previews.
- Raw write SQL, arbitrary identifiers, and subqueries are not exposed.

SQLite tools require a Node runtime with `node:sqlite` support. The core server
can run without that module when SQLite is disabled.

## Web tools

When enabled:

- `web` with `action="search"` queries only the configured SearXNG endpoint.
- `web` with `action="fetch"` blocks localhost, private/link-local addresses, embedded URL
  credentials, and unsafe redirect targets.
- Cookies, browser state, authorization headers, and client certificates are
  not forwarded.
- Response size and request duration are capped.

## Reporting a vulnerability

Do not include real secrets, private paths, database contents, or tunnel keys in
a public issue. Use GitHub's private vulnerability reporting feature when
available, or contact the repository owner privately.

---

# 安全策略

## 设计用途

本项目面向个人或小团队的本地使用，并应置于可信入口之后。核心 MCP 服务本身不是公网服务，也没有实现应用层认证。Secure MCP Tunnel 可以让 MCP 保持私有；使用 Tailscale Funnel 时，只能公开 OAuth Gateway，不能直接公开 MCP。

## 安全边界

- 服务默认绑定 `127.0.0.1`。
- 工作区必须位于 `CTM_ALLOWED_ROOTS` 下。
- 内置和用户配置的 deny glob 会阻止常见私密文件与路径。
- 文件和 SQLite 写入都必须先预览，再显式确认。
- 不提供 Shell 工具；进程工具使用结构化可执行文件与 argv。
- 所有访问模式都阻止直接 Shell 可执行文件和危险参数模式。
- 启动进程前会移除名称疑似密钥的环境变量。
- 工具输出会经过尽力而为的敏感值脱敏。
- Web 与 SQLite 默认关闭，并分别受功能开关控制。
- 读取、进程输出、载荷、行数和执行时间均有限制。

## 访问模式

- `review` 只允许少量检查/测试进程。
- `full` 允许更广的结构化可执行程序，但仍阻止直接 Shell 和危险参数模式。

`full` 不等于不受限制的 Shell 权限。

## 必须遵守的部署方式

- 保持 `HOST=127.0.0.1`。
- 使用 Secure MCP Tunnel 或其他可信入口。
- 使用 Tailscale Funnel 时，公网入口只应转发到 `127.0.0.1:3334` 的 OAuth Gateway。
- 不要把 `127.0.0.1:3333` 的核心 MCP 监听器直接暴露到公网。
- 允许根路径应尽量窄；不要使用整个磁盘或 `/`。
- 除非确实需要更广的进程执行，否则保持 `review`。
- 不要把 `config.json`、隧道密钥、本机启动器、日志或工作区数据提交到源码库。
- 脱敏只是最后一道安全网，不能替代窄化访问边界。

## 文件写入

`edit` 的 `action="preview"` 返回逐文件差异和 action id；`action="confirm"` 在应用前重新检查工作区和拒绝边界。多文件编辑不是事务性的，应使用较小批次，并在确认前审阅每一项。

## SQLite 工具

启用后，SQLite 只能访问 `CTM_SQLITE_ALLOWED_DBS` / `sqlite.allowedDbs` 中的精确
路径。

- `sqlite` 的 `action="schema"` 返回 schema 元数据。
- `sqlite` 的 `action="select"` 只接受一条只读 `SELECT`/`WITH` 或安全 `PRAGMA`。
- 写入通过 `sqlite` 的 preview/confirm action 完成结构化、受限 insert/update/delete。
- update/delete 可在确认时复核 expected 字段，防止使用过期预览。
- 不暴露原始写入 SQL、任意标识符或子查询。

SQLite 工具需要支持 `node:sqlite` 的 Node；SQLite 关闭时，核心服务无需该模块即可
运行。

## Web 工具

启用后：

- `web` 的 `action="search"` 只访问配置的 SearXNG。
- `web` 的 `action="fetch"` 阻止 localhost、私网/链路本地地址、URL 内嵌凭据和不安全重定向。
- 不转发 cookie、浏览器状态、Authorization 头或客户端证书。
- 响应大小和请求时长均有限制。

## 漏洞报告

不要在公开 Issue 中放入真实密钥、私有路径、数据库内容或隧道密钥。优先使用
GitHub 的私有漏洞报告功能（如可用），或私下联系仓库维护者。
