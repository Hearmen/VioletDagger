# VioletDagger

多 agent 协作聊天室系统：新建一个"聊天室"，拉入多个异构 AI coding agent CLI（Kimi、opencode、Codex、Claude，可扩展），围绕同一个任务目标持续协作——共享分层记忆，通过 endorse/challenge/verify/追问等结构化反应互动，人类可以随时插话、查看进展、终止卡住的 session。本地单机工具，单用户使用。

## 架构

两层，职责严格分离：

```
┌─────────────────────────┐
│  编排器 (Orchestrator)    │  本地网页 UI + 进程编排
│  REST + WebSocket 服务前端 │
└──────┬─────────────┬─────┘
       │ WS           │ 直接读写（同进程/同存储）
       ▼              ▼
┌────────────┐  ┌──────────────────────┐
│ 网页前端     │  │  MCP Server            │
│ (React)     │  │  post_message/         │
└────────────┘  │  get_overview/...       │
                 └───────────┬────────────┘
                             ▲
                 ┌───────────┼───────────┬───────────┐
               Kimi       opencode     Codex       Claude
```

编排器核心、存储层、记忆管理、MCP Server、Agent 调用适配层运行在同一个 Node.js 进程内；Web 前端是独立的浏览器应用，通过 REST + WebSocket 通信；MCP Server 通过 HTTP 暴露给外部 agent CLI 进程。详见 [`docs/design/00-overview.md`](docs/design/00-overview.md)。

## 技术栈

- 后端：TypeScript / Node.js，SQLite（`better-sqlite3`，WAL 模式，无 ORM），`@modelcontextprotocol/sdk`
  - **`better-sqlite3` 必须是 13.x**：11.x 在 Node 24 上有原生崩溃（`Statement` 析构时环境已销毁的断言），会让后端不定时退出、前端出现 `ECONNREFUSED`。仓库已锁 `^13.0.3`。
- 前端：React + Vite

## 目录结构

```
VioletDagger/
├── docs/
│   ├── requirements.md          # 需求文档
│   └── design/                  # 9 份模块设计文档（00-08）
├── packages/
│   ├── server/                  # 编排器核心 + 存储层 + 记忆管理 + MCP Server + Agent 调用适配层
│   │   └── agents.config.json   # agent 注册表，登记每个 CLI 的调用命令
│   └── web/                     # React + Vite 前端
└── package.json                 # npm workspaces 根
```

## 快速开始

```bash
npm install
```

**运行模型：** session 以**一次性非交互 CLI** 直接 exec（不经 shell、不使用 PTY），stdout/stderr 按流标记记录为只读日志；前端用纯文本视图展示，不依赖 xterm。人类通过房间 Composer 指导协作、通过编排器暂停/终止，不提供终端输入。详见 [`docs/design/04-agent-invocation.md`](docs/design/04-agent-invocation.md)。

**运行测试：**

```bash
npm test -w @violetdagger/server   # 229 个测试
npm test -w @violetdagger/web      # 108 个测试
```

**本地启动：**

0. 按你机器上实际安装的 CLI，检查/调整 `packages/server/agents.config.json` 里每个 agent 的 `command`（**一次性非交互调用的 argv 数组**，首元素是可执行文件；`promptVia: 'arg'`（默认，用 `{{prompt}}` 占位符）或 `'stdin'`；另可用 `env` 补环境变量；可选 `stopGraceMs`/`stopConfirmMs` 控制人工终止的 SIGTERM 宽限/SIGKILL 确认时长）。四个内置 agent 已预接编排器的 MCP server：**codex** 用内联 `-c`；**claude** 用 `--mcp-config`、**opencode** 用 `OPENCODE_CONFIG` 环境变量（两者都由编排器每次生成一份含 `{{mcpUrl}}` 的**独立**配置文件 `<logsDir>/mcp/<roomId>/<seq>.json`）；**kimi** 没有 per-invocation 的 MCP 配置 flag，只认 user 级 `~/.kimi-code/mcp.json`（或 `$KIMI_CODE_HOME/mcp.json`），因此编排器对它做**合并写入**（保留你已有的其它 server，不整文件覆盖）；它的 `-p/--prompt` 非交互模式已经默认走 `auto` 权限策略（官方文档：`-p` 不与 `--auto`/`--yolo` 组合，非交互模式默认 auto），所以命令就是 `kimi -p "{{prompt}}"`，不能再加 `--auto`。其余三家处理了"审批挡住 MCP 工具"的问题（codex `--dangerously-bypass-approvals-and-sandbox`、claude `--dangerously-skip-permissions` + `--settings` 跳过一次性确认、opencode `run --auto`）。**四家都打开了各自的"过程流"输出**，便于在只读日志里实时观察工具调用/思考：codex `--json`、claude `--output-format stream-json --verbose`、opencode `--format json`、kimi `--output-format stream-json`。日志按设计**原样记录、不解析**，所以看到的是 JSON 事件行。**默认命令已按本机 `--help` 核对（`codex exec` / `claude -p` / `opencode run --auto` / `kimi -p`），但 CLI 升级后仍可能变化，以本机 `--help` 为准**。详见 [`docs/design/04-agent-invocation.md`](docs/design/04-agent-invocation.md) §1。

**一键启动**（后端 + 前端一起，日志分别标 `[server]`/`[web]` 前缀）：

```bash
npm run dev
```

默认后端 REST/WS 监听 `:4200`、MCP Server 监听 `:4201`，前端 `http://localhost:5173`；`Ctrl+C` 一次性停掉两个进程。

也可以分开单独启动：

```bash
npm start -w @violetdagger/server   # 只启动后端
npm run dev -w @violetdagger/web    # 只启动前端
```

启动时会自动做一次 **MCP 自检**（连接本进程的 MCP 端点并校验四个工具已注册），失败则关掉已监听端口并退出、打印原因——避免"进程起来了但 agent 调 `post_message` 才发现 MCP 不通"。

端口/路径可通过环境变量覆盖：`VIOLETDAGGER_HTTP_PORT`、`VIOLETDAGGER_MCP_PORT`、`VIOLETDAGGER_DB_PATH`、`VIOLETDAGGER_AGENTS_CONFIG`、`VIOLETDAGGER_LOGS_DIR`。开发模式下前端的 `/api` 开头请求（含 WebSocket）会被 Vite 自动代理到后端端口，不需要额外配置 CORS。

## 项目状态

7 个模块全部实现，已合并到 `main`：

| 模块 | 状态 |
|---|---|
| storage-layer / memory-management / orchestrator-core / agent-invocation / mcp-server / orchestrator-api | ✅（`packages/server`，229 个测试） |
| frontend | ✅（`packages/web`，108 个测试） |

模块顺序与依赖关系见 [`docs/design/00-overview.md`](docs/design/00-overview.md)。

> **只读 session 日志（已实现）。** session 以一次性非交互 CLI 执行、自然退出后结算；AgentRail 进入的是固定 session 的实时只读日志（`SessionLogView`），事件树点开的是复盘视图（元数据 + 消息列表 + 生命周期记录 + 只读日志回放）。不提供 PTY、终端输入或 xterm。见 `docs/design/04-agent-invocation.md`、`06-orchestrator-api.md` §2.1、`08-live-session-modal.md`。各 CLI 非交互参数仍需按本机版本核对（见上面第 0 步）。

## 已知缺口

前端 review 时记录的缺口，现状如下：

- `chain` 类型消息的 `referencedMessageIds` 多选器未实现（人类 UI 不产生 `chain`，接口层仍接受该字段）。

## 文档索引

- [需求文档](docs/requirements.md)
- [设计文档（00-08）](docs/design/)
