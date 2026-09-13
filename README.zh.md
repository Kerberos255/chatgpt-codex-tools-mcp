[English](./README.md) | 简体中文

# chatgpt-codex-tools-mcp

这是一个本地 MCP 服务，为 ChatGPT 提供受约束的 Codex 风格项目工具箱。

ChatGPT 负责推理；本服务负责限定工作区的文件读取、搜索、Git 检查、预览后确认
的编辑、无 Shell 的结构化进程执行，以及可选 Web 与 SQLite 工具。

> 社区项目，不隶属于 OpenAI 或 Codex。
>
> MCP 端点没有应用层认证。请保持绑定 `127.0.0.1`，并在前面使用可信入口。
> 使用 Tailscale Funnel 时，只公开 `127.0.0.1:3334` 的 OAuth Gateway，绝不要把 MCP `3333` 端口直接暴露出去。

## 主要功能

- 本地 HTTP MCP 地址：`http://127.0.0.1:3333/mcp`
- 通过 `CTM_ALLOWED_ROOTS` 限定工作区
- 内置常见私密文件和敏感路径拒绝规则
- 文件与 SQLite 写入均采用预览-确认流程
- 使用结构化 `command` + `args[]` 执行，不提供 Shell 工具或 Shell 语法
- 支持有超时和输出上限的前台、后台托管进程
- 工具输出尽力进行敏感值脱敏
- 可选 SearXNG 搜索和公共 HTTP 抓取，默认关闭
- 可选白名单 SQLite 读取和受限结构化写入，默认关闭
- Windows 初始化器，可配置 OpenAI Secure MCP Tunnel、Tailscale Funnel 或两者

## 环境要求

- 核心服务需要 Node.js 20 或更高版本；推荐 Node.js 24
- npm
- 支持 Developer Mode 自定义 MCP 应用 / 连接器的 ChatGPT（可用性取决于套餐与工作区策略）
- OpenAI Secure MCP Tunnel 路径使用 OpenAI `tunnel-client`；Funnel 路径使用 Tailscale
- SQLite 工具需要支持 `node:sqlite` 的运行时（Node.js 22.5+；推荐 24+）

Windows 下，`scripts/start-mcp.ps1` 会先采用显式 PowerShell 参数，再读取环境变量覆盖值，然后读取 `config.json`。如果这些都没有指定运行时，才回退到 `%LOCALAPPDATA%\OpenAI\Codex\runtimes\cua_node` 中的 Codex 捆绑运行时，最后尝试 `PATH` 中的 `node`。相关设置为 `runtime.codexRuntimeRoot` / `CTM_CODEX_RUNTIME_ROOT` 与 `runtime.fallbackNodeBin` / `OPENCLAW_NODE_BIN`。

## Windows 快速开始

### 1. 获取项目

下载最新 GitHub Release 附带的 ZIP 并解压，或克隆仓库：

```powershell
git clone https://github.com/Kerberos255/chatgpt-codex-tools-mcp.git
cd chatgpt-codex-tools-mcp
```

### 2. 初始化一次

运行：

```text
init-windows.cmd
```

初始化器会：

- 询问较窄的允许工作区根路径，例如 `D:\Projects`
- 安装 npm 依赖并构建 `dist/server.js`
- 让你选择 **OpenAI Secure MCP Tunnel**、**Tailscale Funnel** 或 **两者都配置**
- 首次配置时创建被 Git 忽略的本地 `config.json`；已有配置默认保留，除非显式强制覆盖
- 按选择创建 `tunnel\openai` 和/或 `tunnel\tailscale`，集中保存隧道程序、profile 和本地状态
- 优先复用现有隧道程序；缺少时从对应官方分发源下载
- OpenAI `tunnel-client` 下载后会用 Release 的 `SHA256SUMS.txt` 校验
- 只生成你实际配置的一个或两个一键启动脚本

按你的选择，项目根目录会出现：

```text
start-openai-mcp.cmd
start-tailscale-mcp.cmd
```

以后可以再次运行 `init-windows.cmd` 配置另一种隧道；已有启动脚本会保留，所以两种入口可以同时存在。

OpenAI 相关本地文件放在 `tunnel\openai`。启动时依次读取环境变量 `CONTROL_PLANE_API_KEY`、可选的 `tunnel\openai\control-plane-api-key.txt`，都没有时再用隐藏输入临时询问。

首次配置 OpenAI Tunnel 还需要 ChatGPT 与 `tunnel-client` 共用的 OpenAI Tunnel ID；如果本地没有对应 profile，`init-windows.cmd` 会主动询问。运行用 Runtime API Key 应具备该 Tunnel 的 **Tunnels Read + Use** 权限，不要用 Tunnel 管理员密钥替代长期运行密钥。

Tailscale 相关本地文件放在 `tunnel\tailscale`。初始化器会创建 OAuth 审批页使用的 `owner-password.txt`，OAuth 状态也保存在同一目录。

### 3. 启动 MCP 与隧道

OpenAI Secure MCP Tunnel：

```text
start-openai-mcp.cmd
```

Tailscale Funnel：

```text
start-tailscale-mcp.cmd
```

每个启动器都会在需要时先启动 MCP，然后只启动自己的隧道链路。Tailscale 入口固定为 `HTTPS 443 → OAuth gateway 3334 → MCP 3333`。

正常冷启动时，主要可见控制台窗口为：

- OpenAI 模式：**Codex MCP Server** + **OpenAI MCP Tunnel** + **OpenAI MCP Tunnel Watchdog**。
- Tailscale 模式：**Codex MCP Server** + **Tailscale OAuth Gateway** + **Tailscale Funnel** + **Tailscale MCP Watchdog**。

Tailscale Funnel 现在明确以前台方式运行。使用 Tailscale 连接期间请保持 Funnel 窗口开启；关闭窗口或按 `Ctrl+C` 会停止 HTTPS 443 的 Funnel 映射。watchdog 会监测 MCP、OAuth Gateway 和 Funnel 路由，并在 Funnel 缺失时重新拉起前台窗口；已健康运行的组件会直接复用，避免重复启动。

### 4. 配置 ChatGPT

在 ChatGPT 的 Developer Mode / Apps 中创建自定义 MCP 应用，并填写你所选择隧道链路的端点。具体可用性和界面名称可能随套餐、工作区策略变化，请以 [OpenAI 当前的 Developer Mode / MCP 应用说明](https://help.openai.com/zh-hans-cn/articles/12584461-developer-mode-and-full-mcp-connectors-in-chatgpt-beta) 为准。

OpenAI Secure MCP Tunnel 在 ChatGPT 中选择 **Connection: Tunnel**，再选择对应 Tunnel，或粘贴初始化时使用的同一个 Tunnel ID。由于本项目的 MCP 服务本身没有应用层认证，如果界面继续询问 MCP 身份验证方式，则选择 **No Authentication / 无身份验证**。

Tailscale Funnel 使用：

```text
https://<你的机器名>.<你的tailnet>.ts.net/mcp
```

使用 OAuth 自动发现。打开授权页后，输入本机 `tunnel\tailscale\owner-password.txt` 中的 Owner Password。

Tailscale Funnel 属于公网入口。首次启用 Funnel 可能需要 tailnet 权限，并要求 MagicDNS / HTTPS 已启用；详见 [Tailscale Funnel 要求](https://tailscale.com/docs/features/tailscale-funnel)。

两种模式下 MCP 服务本身都继续只绑定 `127.0.0.1`。

## 手动安装（Windows、macOS、Linux）

```bash
git clone https://github.com/Kerberos255/chatgpt-codex-tools-mcp.git
cd chatgpt-codex-tools-mcp
npm ci
npm run build
```

从公开模板创建本地配置：

```bash
cp config.example.json config.json
```

Windows PowerShell：

```powershell
Copy-Item config.example.json config.json
```

编辑 `config.json` 后启动：

```bash
npm start
```

核心服务设置直接读取 `config.json` 与环境变量。`runtime`、`proxy`、`environment` 下的 Windows 启动器专用设置由 `scripts/start-mcp.ps1` 应用；环境变量和显式 PowerShell 参数优先于 `config.json` 中的对应值。没有配置文件时，会使用保守默认值。

## 连接路径

OpenAI 路径：

```text
ChatGPT → OpenAI Secure MCP Tunnel → tunnel\openai\tunnel-client.exe
        → http://127.0.0.1:3333/mcp → 仅允许的本地工作区
```

Tailscale 路径：

```text
ChatGPT → Tailscale Funnel HTTPS 443 → OAuth gateway 127.0.0.1:3334
        → MCP 127.0.0.1:3333 → 仅允许的本地工作区
```

健康检查：

```text
http://127.0.0.1:3333/healthz
```

直接 GET `/mcp` 可能返回 `No valid MCP session`；在 MCP 会话尚未初始化时属于
正常现象。

已初始化的 MCP 会话不会仅因为 ChatGPT 窗口长时间闲置而过期。服务通过 LRU 会话
上限（`mcp.maxSessions`，默认 `128`）限制内存：只有超过上限时，才关闭最久未使用
的会话。服务进程重启仍会重置全部会话。

## 工具目录

| 分组 | 工具 | 操作 / 用途 |
| --- | --- | --- |
| Meta | `local_status` | 查看版本、访问模式、根路径、限制和 Web/SQLite 状态。 |
| Workspace | `open_workspace` | 打开 `CTM_ALLOWED_ROOTS` 下的目录并返回 `workspaceId`。 |
| Files | `files` | `list`、`read`、`search`、`find`；递归 `list` + `depth` 取代原项目树工具。 |
| Git | `git` | 仅本地 `status`、`diff`；GitHub 远端操作交给 GitHub/`gh` 工具。 |
| Edit | `edit` | `preview`、`confirm`，保留编辑预览确认。 |
| Exec | `exec` | `run`、`start`、`read`、`stop`，不经过 Shell。 |
| SQLite | `sqlite` | 可选白名单数据库的 `schema`、`select`、`preview`、`confirm`。 |
| Web | `web` | 可选 `search` 和公共 HTTP `fetch`。 |
| Capture | `screenshot` | Windows 桌面、显示器、窗口或区域截图，直接返回 PNG 图片内容。 |

公开 MCP 接口固定收敛为这 9 个工具。Web / SQLite 未启用时对应 action 会明确报未启用；当前状态统一看 `local_status`。

## 推荐工作流

```text
open_workspace
  → files / git
  → edit(action="preview")
  → 审阅 diff
  → edit(action="confirm", actionId=...)
```

进程执行需要传 action、真实可执行文件和 argv 数组：

```json
{
  "action": "run",
  "workspaceId": "...",
  "command": "npm",
  "args": ["run", "build"]
}
```

不支持管道、重定向、命令串联、Shell 展开或 Shell 内置命令。

## 访问模式

```text
CTM_ACCESS_MODE=review   # 默认
CTM_ACCESS_MODE=full
```

- `review` 只允许少量检查/测试进程。
- `full` 允许更广的结构化可执行程序。
- 两种模式仍会阻止直接 Shell（`cmd`、PowerShell、`sh`、`bash`）和危险参数模式。
- 应优先使用专用的读取、Git、编辑、Web 和 SQLite 工具。

## 配置

`config.example.json` 是公开模板。`config.json` 由用户生成或复制，仅供本机使用，
并被 Git 忽略。

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

常用环境变量覆盖：

| 设置 | 环境变量 | 默认值 |
| --- | --- | --- |
| 主机/端口 | `HOST`、`PORT` | `127.0.0.1`、`3333` |
| 允许根路径 | `CTM_ALLOWED_ROOTS` | 当前项目目录 |
| 访问模式 | `CTM_ACCESS_MODE` | `review` |
| 拒绝规则覆盖 | `CTM_DENY_GLOBS` | 内置规则 |
| 读取/输出上限 | `CTM_MAX_READ_BYTES`、`CTM_MAX_OUTPUT_BYTES` | `200000` |
| MCP 会话上限 | `CTM_MAX_SESSIONS` | `128` |
| Web 工具 | `CTM_WEB_TOOLS` | 关闭 |
| 搜索后端 | `CTM_SEARCH_PROVIDER`、`CTM_SEARXNG_URL` | `none` |
| Web 限制 | `CTM_WEB_MAX_BYTES`、`CTM_WEB_TIMEOUT_MS` | `200000`、`15000` |
| SQLite 工具 | `CTM_SQLITE_TOOLS` | 关闭 |
| SQLite 白名单 | `CTM_SQLITE_ALLOWED_DBS` | 空 |
| SQLite 行数上限 | `CTM_SQLITE_MAX_ROWS` | `100` |
| 配置路径 | `CTM_CONFIG_PATH` | `<项目>/config.json` |

高级运行时和代理选项见 `env.example`。

`mcp.denyGlobs` 与 `CTM_DENY_GLOBS` 会**替换**内置 deny 列表，而不是在默认规则后追加。若要覆盖，请把仍需保留的全部默认规则与你新增的规则一起写入。

不要把隧道运行密钥写入 `config.json`。OpenAI Tunnel 的
`CONTROL_PLANE_API_KEY` 应放在当前环境，或 Git 已忽略的本地
`tunnel\openai\control-plane-api-key.txt`。

## 可选 Web 工具

在 `config.json` 中启用：

```json
{
  "web": {
    "enabled": true,
    "searchProvider": "searxng",
    "searxngUrl": "http://127.0.0.1:8888"
  }
}
```

- `web` 的 `action="search"` 只查询配置的 SearXNG 实例。
- `web` 的 `action="fetch"` 只接受公共 HTTP(S) 地址，并阻止 localhost、私网目标、嵌入凭据和
  不安全重定向。
- 不转发 cookie、浏览器登录态、Authorization 头或客户端证书。

## 可选 SQLite 工具

启用 SQLite 并列出精确数据库路径：

```json
{
  "sqlite": {
    "enabled": true,
    "allowedDbs": ["D:\\Data\\app.sqlite"],
    "maxRows": 100
  }
}
```

- `sqlite` 的 `action="schema"` 读取 schema 元数据。
- `sqlite` 的 `action="select"` 接受一条只读 `SELECT`/`WITH` 或安全 `PRAGMA`。
- 写入先用 `sqlite` 的 `action="preview"`，再用返回的 `actionId` 执行 `action="confirm"`。
- 支持 insert、受限 update/delete、expected 字段复核，以及
  `job_json.enabled` 形式的 `jsonSet` 点路径。
- 不暴露原始写入 SQL 或子查询。

## 文件编辑操作

`edit` 的 `action="preview"` 支持多文件批次和以下类型：

```text
replace_text   replace_range   insert_before   insert_after
append         create          overwrite       rename         delete
```

预览会返回 action id 和逐文件 diff。`edit` 的 `action="confirm"` 在应用前重新检查工作区和拒绝
边界。文件批次不是事务性的，因此应保持批次较小并审阅完整预览。

## 截图工具

`screenshot` 仅在 Windows 上提供，直接以 MCP 图片内容返回 PNG；默认不落盘。

- `mode="window"` 可按窗口标题子串或 `windowHandle` 截图，使用 Windows `PrintWindow`，窗口被其他窗口遮挡时也可抓取。
- `mode="desktop"`、`monitor`、`region` 抓取当前交互桌面。若 Windows 正处于锁屏或桌面切换状态而拒绝屏幕表面访问，工具会明确报错，不会返回黑图冒充成功。
- 可选 `savePath` 必须配合 `workspaceId`，路径仍受工作区边界和 deny 规则约束。

## 安全规则

- 保持 `HOST=127.0.0.1`。
- 允许根路径应尽量窄；不要使用整个系统盘或 `/`。
- 除非确实需要更广的进程执行，否则保持 `review`。
- 不要把端点直接暴露到公网。
- Tailscale Funnel 属于公网入口；Funnel 必须指向 `127.0.0.1:3334` 的 OAuth Gateway，绝不要直接指向 MCP `3333`。
- 不需要时保持 Web 和 SQLite 工具关闭。
- 脱敏只是最后一道安全网，不是主要边界。
- 每次确认文件或 SQLite 写入前都应审阅预览。

完整策略见 [`SECURITY.md`](SECURITY.md)。

## 开发

```bash
npm ci
npm run typecheck
npm run build
npm test
npm run check
```

测试覆盖配置优先级、会话 LRU 行为、glob 匹配、敏感值脱敏、可选 SQLite 加载、
版本/仓库一致性和 CI/CD 闸门。

## CI 与 Release

Pull Request 会在 Node.js 20 和 24 上运行 CI、启动 HTTP 服务做 smoke test、在
Windows 上解析全部 PowerShell 脚本，并干跑一次 Release 打包。

推送与 `package.json` 完全一致的标签（如 `v0.6.0`）后，会触发 Release 工作流。
它会确认标签提交属于 `main`、重新运行完整检查、构建包含源码和已编译 `dist` 的
ZIP、生成 `SHA256SUMS.txt`，并自动创建 GitHub Release。

## 故障排查

### 身份验证行为不符合预期

OpenAI Secure MCP Tunnel 应创建或重新创建 MCP 应用并选择 **No Authentication / 无身份验证**。Tailscale Funnel 出现 OAuth 授权页则是正常行为：使用 OAuth 自动发现，并输入 `tunnel\tailscale\owner-password.txt` 中的 Owner Password。旧应用设置可能仍保留此前的身份验证方式。

### 路径超出允许范围

把项目父目录添加到 `mcp.allowedRoots` 或 `CTM_ALLOWED_ROOTS`，然后重启服务。

### 进程命令被阻止

优先使用专用工具。`review` 模式只接受少量进程；所有模式都禁止 Shell 可执行文件
和 Shell 语法。

### SQLite 工具不可用

启用 SQLite、添加精确数据库路径，并使用支持 `node:sqlite` 的 Node。
`local_status` 会显示 SQLite 是否启用以及当前数据库白名单。

### 缺少 `dist/server.js`

```bash
npm ci
npm run build
```

### 缺少隧道程序

重新运行 `init-windows.cmd` 并选择对应隧道。初始化器会优先复用已安装的程序；
缺少时，OpenAI `tunnel-client` 会从官方 GitHub Release 下载并校验 SHA256，
Tailscale 则从官方稳定版地址下载 Windows 安装器。

## 仓库边界

仓库和 Release 包不会包含：

- `node_modules`
- 本地 `config.json`
- 本地 `tunnel/` 目录（程序、profile、OAuth 状态和运行密钥）
- 本机生成的 `start-openai-mcp.cmd` / `start-tailscale-mcp.cmd`
- 日志或工作区数据

## 许可证

MIT，见 [`LICENSE`](LICENSE)。
