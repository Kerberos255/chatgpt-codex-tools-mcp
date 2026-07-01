English | [中文](./README.zh.md)

# chatgpt-codex-tools-mcp

通过 MCP 向 ChatGPT 暴露 Codex 风格的本地工作区工具。

ChatGPT 负责推理。此服务仅提供受限制的本地工具：打开工作区、列出/读取/搜索/树状浏览文件、查看 Git 状态、预览-确认文件编辑、运行一小部分白名单命令，以及可选的基于结构化预览-确认流程的 SQLite 查询与修改。

> 不与 OpenAI 或 Codex 关联。这是一个社区/本地工具层，以小型 Codex 风格工具箱的形式为 ChatGPT 提供服务。

---

## 这是什么

`chatgpt-codex-tools-mcp` 是一个本地 HTTP MCP 服务，适用于既希望 ChatGPT 检查和编辑本地项目，又不希望赋予其广泛的 Shell 或公网访问权限的用户。

推荐流程：

```text
ChatGPT 自定义连接器
  → 私有 MCP 隧道
  → 你机器上的隧道客户端
  → http://127.0.0.1:3333/mcp
  → 此本地 MCP 服务器
  → 仅限允许的本地工作区
```

默认公开模板使用 **No Authentication（无认证）** 的 MCP 应用层设置。这是有意为之，适用于私有/本地隧道场景，但也意味着**不应**将此服务直接暴露在公网上。

---

## 特性

- 仅本地 HTTP 服务，默认绑定 `127.0.0.1`
- 通过 `CTM_ALLOWED_ROOTS` 限定工作区范围
- 通用私有文件和敏感路径的拒绝规则
- 读/列出/搜索/查找/树状浏览等检查工具
- 9 种编辑类型、支持多文件批处理的预览-确认文件编辑流程
- Git 状态/差异查看工具
- `review` 模式下的 Shell 白名单，仅允许低风险的验证命令
- 工具输出中的智能值脱敏（尽力而为）
- 提供 Windows 辅助脚本，可复用 Codex 自带 Node 运行时
- 可选 Web 工具（默认禁用）：SearXNG 搜索和公共 HTTP 抓取
- 可选 SQLite 工具（默认禁用）：白名单只读查询 + 结构化预览-确认更新，支持 jsonSet

---

## 向 ChatGPT 暴露的工具

| 工具 | 用途 |
| --- | --- |
| `local_status` | 服务状态、访问模式、允许根路径、能力与功能标志。 |
| `open_workspace` | 在 `CTM_ALLOWED_ROOTS` 下打开一个本地项目目录，获取可复用的 workspaceId。 |
| `list_dir` | 列出打开的工作区中的文件。 |
| `read_file` | 读取 UTF-8 文本文件，带输出大小限制。 |
| `search_files` | 在工作区内全文搜索。可用时优先使用 `rg`。支持大小写、上下文行数、最大匹配数和包含/排除 glob 模式。 |
| `find_files` | 通过 glob 模式查找文件（如 `*.ts`、`**/config*`）。 |
| `project_tree` | 展示可视化的目录树（限制深度，跳过 node_modules/dist/.git）。 |
| `git_status` | 运行 `git status --short`。 |
| `git_diff` | 查看未暂存或已暂存的 Git diff，可只看统计或限定到某个路径。 |
| `preview_edit` | **（推荐）** 创建待处理的多文件编辑批次。支持 replace_text、replace_range、insert_before、insert_after、append、create、overwrite、rename、delete。 |
| `confirm_edit` | 按 actionId 应用待处理的编辑批次。 |
| `preview_shell` | 将 Shell 命令加入审批队列。 |
| `confirm_shell` | 执行已加入队列的 Shell 命令。 |
| `shell` | 直接运行本地命令，受 `CTM_ACCESS_MODE` 限制。 |
| `sqlite_status` | 显示 SQLite 工具配置。始终可用。 |
| `sqlite_schema` * | 查看白名单数据库的表结构。 |
| `sqlite_select` * | 运行一条只读 `SELECT`/`WITH` 或安全的 `PRAGMA`。 |
| `sqlite_preview_change` * | 预览对白名单数据库的结构化 insert/update/delete。支持通过点分路径键（如 `job_json.enabled`）进行 jsonSet。在确认前不会实际写入。 |
| `sqlite_confirm_change` * | 按 actionId 应用待处理的 SQLite 更改。在写入前会重新验证 'expected' 字段。 |
| `web_status` | 显示 Web 工具配置。始终可用。 |
| `web_search` * | 通过 SearXNG 搜索网络。 |
| `web_fetch` * | 获取公共 HTTP(S) 页面。阻止 localhost、私有网络和凭据信息。 |

\* *可选工具，默认禁用，仅在启用相应功能标志后可用。*

---

## 安全模型

默认设置为有意保守：

```text
HOST=127.0.0.1
PORT=3333
CTM_ACCESS_MODE=review
```

**重要规则：**

- 个人使用请保持 `HOST=127.0.0.1`。
- 除非完全理解风险，否则保持 `CTM_ACCESS_MODE=review`。
- 将 `CTM_ALLOWED_ROOTS` 设置得尽量窄，例如 `D:\Projects`。
- 不要将允许根路径设为整个系统盘。
- 请通过私有隧道使用，而非公网 URL。
- 在 ChatGPT 连接器配置中选择 **No Authentication / 未授权**。
- 输出脱敏只是安全网，不能替代窄化 `CTM_ALLOWED_ROOTS`、deny 规则和 SQLite 白名单配置。
- 大型参数会被拒绝；请拆成更小的 preview 调用。

`review` 模式会阻止危险命令模式，仅允许一小部分检查/测试命令，如 `git status`、`git diff`、`dir`、`ls`、`node --version` 和 `npm run ...`。

修改 Git 历史或发布到远程的命令（如 `git add`、`git commit`、`git remote`、`git push` 和 `gh repo create`）在 `review` 模式下不允许通过直接 shell 执行。它们必须通过 `preview_shell` 暂存，然后使用返回的 actionId 通过 `confirm_shell` 执行。

---

## 环境要求

- Node.js 20+（推荐）
- npm
- 能够连接 MCP 服务的 ChatGPT 自定义连接器
- 如果 ChatGPT 需要通过 Secure MCP Tunnel 连接此本地服务，则需要 OpenAI 的 `tunnel-client`
- 在 OpenAI Platform 隧道设置中创建的隧道 ID 和运行时密钥
- 可选 SQLite 工具需要支持 `node:sqlite` 的 Node.js 运行时（推荐 Node.js 24+）

在 Windows 上，辅助脚本按以下顺序查找 Node：

1. `%LOCALAPPDATA%\OpenAI\Codex\runtimes\cua_node` 下的 Codex 捆绑 Node 运行时。
2. 你设置的 `OPENCLAW_NODE_BIN`。
3. `PATH` 上的 `node`。

---

## 安装

```bash
git clone https://github.com/Kerberos255/chatgpt-codex-tools-mcp.git
cd chatgpt-codex-tools-mcp
npm install
npm run build
```

启动前设置允许的工作区根路径：

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

服务应输出类似：

```text
chatgpt-codex-tools-mcp listening on http://127.0.0.1:3333/mcp
allowed roots: D:\Projects
access mode: review
auth: no authentication (use only behind a private/local tunnel)
```

---

## Windows 快速启动

对于普通 Windows 用户，使用根目录下的 `.cmd` 文件。`scripts/` 目录下的 PowerShell 脚本为内部实现和高级入口点。

### 第一步：初始化

运行：

```text
init-windows.cmd
```

初始化程序会要求你配置：

1. 允许的工作区根路径，例如 `D:\Projects`。
2. npm 依赖和 `dist/server.js` 构建输出。
3. 本地 `tunnel-client.exe` 路径。
4. 本地 MCP 启动配置 `config.json`。
5. 为本机生成的仅本地隧道启动文件。

它会创建或更新以下本地文件：

```text
config.json
start-mcp.local.cmd
start-tunnel.local.cmd
start-tunnel.local.ps1
```

初始化程序**不会**保存你的运行时密钥。隧道启动时，如果当前环境变量中存在 `CONTROL_PLANE_API_KEY` 则使用该值；否则会通过隐藏的 PowerShell 提示符要求你输入。

如果缺少 `tunnel-client.exe`，初始化程序会打开下载页面并显示推荐的本地路径。请下载并放置到该位置，重新运行 `init-windows.cmd`，然后运行 `start-all.cmd`。

### 第二步：启动 MCP + 隧道

初始化后运行：

```text
start-all.cmd
```

它将打开两个窗口：

1. MCP 服务窗口，使用 `start-mcp.local.cmd` 或后备方案 `start-mcp.cmd`。
2. 隧道窗口，使用 `start-tunnel.local.cmd`。

使用 ChatGPT 连接器时请保持两个窗口都运行。

### 第三步：可选的单一用途启动器

```text
start-mcp.cmd       # 仅启动本地 MCP 服务
start-tunnel.cmd    # 仅启动私有隧道（初始化后）
```

`start-mcp.cmd` 会读取项目根目录的 `config.json`。环境变量和显式 PowerShell 参数仍可覆盖 `config.json`，适合临时测试。

---

## 配置参考

`config.json` 是启动器配置。`scripts/start-mcp.ps1` 会先把它映射为现有运行时环境变量，再启动 `dist/server.js`。

```json
{
  "mcp": {
    "host": "127.0.0.1",
    "port": 3333,
    "allowedRoots": ["D:\\Projects"],
    "accessMode": "review",
    "denyGlobs": ["**/.env", "**/key.txt"],
    "maxReadBytes": 200000,
    "maxOutputBytes": 200000
  },
  "runtime": {
    "codexRuntimeRoot": "",
    "fallbackNodeBin": "C:\\Tools\\nodejs",
    "npmCache": "D:\\npm-cache"
  },
  "proxy": {
    "url": "http://127.0.0.1:10808",
    "noProxy": "127.0.0.1,localhost,::1",
    "nodeUseEnvProxy": true
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

| JSON 路径 | 环境变量 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `mcp.host` | `HOST` | `127.0.0.1` | 除非你添加了自己的保护，否则保持本地绑定。 |
| `mcp.port` | `PORT` | `3333` | 本地 HTTP 端口。 |
| `mcp.allowedRoots` | `CTM_ALLOWED_ROOTS` | 项目根目录 | 允许的工作区根路径，支持数组或逗号分隔字符串。 |
| `mcp.accessMode` | `CTM_ACCESS_MODE` | `review` | `review` 或 `full`。 |
| `mcp.denyGlobs` | `CTM_DENY_GLOBS` | 内置拒绝列表 | 额外拒绝规则，支持数组或逗号分隔字符串。 |
| `mcp.maxReadBytes` | `CTM_MAX_READ_BYTES` | `200000` | 文件读取返回的最大字节数。 |
| `mcp.maxOutputBytes` | `CTM_MAX_OUTPUT_BYTES` | `200000` | Shell/Git 输出返回的最大字节数。 |
| `runtime.codexRuntimeRoot` | `CTM_CODEX_RUNTIME_ROOT` | Codex 捆绑运行时目录 | 高级选项，用于覆盖 Codex Node 运行时搜索根目录。 |
| `runtime.fallbackNodeBin` | `OPENCLAW_NODE_BIN` | 无 | 可选，包含 `node.exe` 的目录。 |
| `runtime.npmCache` | `CTM_NPM_CACHE` | 无 | 可选 npm 缓存目录。 |
| `proxy.url` | `PROXY_URL`、`HTTP_PROXY`、`HTTPS_PROXY` | 无 | 可选的 Node/Web 请求出站代理。 |
| `proxy.noProxy` | `NO_PROXY` | 无 | 不走代理的主机列表。 |
| `proxy.nodeUseEnvProxy` | `NODE_USE_ENV_PROXY` | 无 | 设为 `true` 时供支持环境代理的 Node 版本使用。 |
| `web.enabled` | `CTM_WEB_TOOLS` | 关闭 | 启用可选 `web_search` 和 `web_fetch`。`web_status` 始终可用。 |
| `web.searchProvider` | `CTM_SEARCH_PROVIDER` | `none` | `none` 或 `searxng`。需要 `web.enabled=true`。 |
| `web.searxngUrl` | `CTM_SEARXNG_URL` | 无 | SearXNG 实例 URL。`searchProvider=searxng` 时必须设置。 |
| `web.maxBytes` | `CTM_WEB_MAX_BYTES` | `200000` | `web_fetch` 返回的最大字节数。 |
| `web.timeoutMs` | `CTM_WEB_TIMEOUT_MS` | `15000` | 每个网络请求的超时时间。 |
| `sqlite.enabled` | `CTM_SQLITE_TOOLS` | 关闭 | 启用可选 SQLite 工具。 |
| `sqlite.allowedDbs` | `CTM_SQLITE_ALLOWED_DBS` | 无 | 允许访问的 SQLite 数据库绝对路径，支持数组或逗号分隔字符串。 |
| `sqlite.maxRows` | `CTM_SQLITE_MAX_ROWS` | `100` | SQLite 工具返回的最大行数。 |
| `environment` | 任意变量 | 无 | 高级选项，用于设置上面没有覆盖的环境变量默认值。 |

`config.json` 不应存放隧道运行时密钥。`CONTROL_PLANE_API_KEY` 请继续放在当前环境变量、本地 key 文件或私有启动器中。

### SQLite 工具

SQLite 工具是可选且路径白名单制的。`sqlite_select` 为只读：接受一条 `SELECT`/`WITH` 语句或一小部分安全的 `PRAGMA` 语句。

结构化写入使用预览-确认流程：

```text
sqlite_preview_change  →  返回 action_id + before/after 差异
sqlite_confirm_change  →  通过 action_id 执行，重新验证 expected 字段
```

支持的修改类型：
- **insert** – `table`、`columns`、`values`
- **update** – `table`、`set`、`where`（仅 AND）、`limit`（默认 1）、`expected`（确认时重新验证）
- **delete** – `table`、`where`、`limit`（默认 1）、`expected`
- **jsonSet** – 在 `set` 中使用点分键（如 `job_json.enabled`）更新 JSON 文本列中的单个字段，通过 SQLite 的 `json_set()` 实现。第一个点之前为列名，点之后的路径用于导航 JSON 结构。

表名和列名会经过安全标识符验证。WHERE 仅支持简单的 AND 连接条件，使用参数化值。不允许原始写入 SQL 或子查询。

示例：

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

### 文件编辑工具

文件编辑使用预览-确认流程：

```text
preview_edit  →  返回 action_id + 每个修改的差异
confirm_edit  →  应用批次中的所有修改
```

支持的编辑类型（`changes[].type`）：

| 类型 | 字段 | 用途 |
| --- | --- | --- |
| `replace_text` | `path`、`oldText`、`newText` | 精确文本查找替换（向后兼容旧版 patch 流程） |
| `replace_range` | `path`、`startLine`、`endLine`、`newText` | 用新内容替换指定行范围 |
| `insert_before` | `path`、`anchor`、`text` | 在 anchor 首次出现之前插入文本 |
| `insert_after` | `path`、`anchorAfter`、`text` | 在 anchorAfter 首次出现之后插入文本 |
| `append` | `path`、`text` | 在文件末尾追加文本 |
| `create` | `path`、`text` | 创建新文件（已存在时报错） |
| `overwrite` | `path`、`newText` | 覆盖整个文件内容 |
| `rename` | `path`、`newPath` | 重命名/移动文件 |
| `delete` | `path` | 删除文件 |

### 搜索 glob

`search_files` 可用时会优先使用 ripgrep（`rg`），找不到 `rg` 时回退到内置 Node 搜索。`search_files.include`、`search_files.exclude` 和 `find_files.pattern` 支持常见 glob 模式：

- `*.ts` 会匹配搜索树下任意位置的文件名。
- `src/**/*.ts` 会同时匹配 `src/app.ts` 和 `src/lib/app.ts` 这类嵌套文件。
- 支持逗号分隔模式和花括号候选，例如 `*.ts,*.tsx` 或 `{*.ts,*.tsx}`。

### Git diff 选项

`git_diff` 默认返回未暂存的 `git diff --stat` 加完整 `git diff`。可选输入：

- `staged: true` 查看已暂存/cached 的修改。
- `path: "src/server.ts"` 将 diff 限定到某个文件或目录。
- `statOnly: true` 只返回 `git diff --stat`。
- `maxBytes` 为大型 diff 设置更小的输出上限。

---

## 故障排除

### `No valid MCP session`

对 `/mcp` 的原始 GET 请求属于正常行为。仅表示服务正在运行，但未初始化 MCP 会话。

### ChatGPT 要求登录

创建一个全新的连接器，选择 **No Authentication / 未授权**。旧的连接器设置可能仍记得 OAuth 流程。

### 路径超出允许根路径范围

将该项目的父目录添加到 `CTM_ALLOWED_ROOTS`，然后重启 MCP 服务。

### Shell 命令被阻止

你当前处于 `review` 模式。请尽可能使用 read/search/git/edit 工具。仅在受信任的本地环境中切换为 `full` 模式。

### SQLite 工具不可用

设置 `CTM_SQLITE_TOOLS=1`，将数据库添加到 `CTM_SQLITE_ALLOWED_DBS`，使用支持 `node:sqlite` 的 Node.js 运行时，然后重启 MCP 服务。

### `dist/server.js not found`

运行：

```bash
npm install
npm run build
```
