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

## Do not do this

- Do not bind the server to `0.0.0.0` unless you add your own protection layer.
- Do not set `CTM_ALLOWED_ROOTS` to an entire system drive such as `C:\` or `/`.
- Do not publish local private files, logs, or workspace data.
- Do not switch to `CTM_ACCESS_MODE=full` unless you fully understand the risks.

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

## 不要这样做

- 不要在没有额外保护层的情况下绑定到 `0.0.0.0`。
- 不要把 `CTM_ALLOWED_ROOTS` 设置成整个系统盘，比如 `C:\` 或 `/`。
- 不要发布本机私人文件、日志或工作区数据。
- 不理解风险时不要切换到 `CTM_ACCESS_MODE=full`。
