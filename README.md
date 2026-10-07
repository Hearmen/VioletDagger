# VioletDagger

中文 | [English](README_en.md)

一个本地运行的多 agent 协作聊天室。你新建一个房间、写下任务目标，拉进几个 AI coding agent（Codex、Claude、opencode、Kimi，或你自己加的），它们会围绕这个目标分工研究、互相验证，把发现记录成共享记忆。你在网页上实时看着整个过程，可以随时插话、暂停或终止某个 agent。

单机、单用户使用。

## 快速开始

需要 Node.js，以及至少一个已安装并登录好的 agent CLI。

```bash
npm install
npm run dev
```

打开 http://localhost:5173 ，新建房间、选择 agent、发出第一条消息（它就是任务目标）。

`npm run dev` 同时启动后端和前端，`Ctrl+C` 一起停掉。启动时后端会自检 MCP 服务，失败会直接退出并打印原因。

## 怎么用

- **房间**：一个任务一个房间。参与的 agent 在建房时选定，之后不能增减；同一个 agent 可以点多次，得到多个实例（`codex-1`、`codex-2`……）。
- **消息流**：agent 和你的所有消息。点选一条消息可以回复它；输入 `@agent名` 可以指定某个 agent 处理。
- **记忆**：按类型整理的结构化发现（问题、假设、事实、边界、方案、验证……）。
- **事件树**：按时间展示每个 agent 的每次运行（session），点开可以看它产出的消息和运行日志。
- **控制**：顶栏可暂停 / 恢复房间、结束房间；左侧可终止正在运行的 agent，或停用某个 agent 的派发。
- **界面语言**：顶栏右侧的 `EN` / `中` 按钮切换中英文。

## 添加新的 agent

agent 登记在 `packages/server/agents.config.json`，后端启动时读取（可用环境变量 `VIOLETDAGGER_AGENTS_CONFIG` 指向别的文件）。在 `"agents"` 下加一项，key 就是建房时看到的名字：

```json
"my-agent": {
  "command": ["my-agent", "-p", "{{prompt}}"],
  "mcpFile": {
    "template": "{\"mcpServers\":{\"violetdagger\":{\"url\":\"{{mcpUrl}}\"}}}"
  }
}
```

| 字段 | 说明 |
|---|---|
| `command`（必填） | 一次性、非交互的启动命令，按数组直接执行（不经过 shell）。可用占位符：`{{prompt}}`、`{{promptFile}}`、`{{mcpUrl}}`、`{{mcpFile}}` |
| `promptVia` | `"arg"`（默认，prompt 放进命令参数）或 `"stdin"`（prompt 从标准输入传入） |
| `env` | 额外的环境变量 |
| `mcpFile` | CLI 需要 MCP 配置文件时使用：每次运行把 `template` 写成一份独立文件，`{{mcpFile}}` 就是它的路径。只有 CLI 只认固定位置的配置时才设 `path` + `merge: true`（参考 kimi） |
| `stopGraceMs` / `stopConfirmMs` | 终止 agent 时的等待时长（毫秒），默认 2000 / 3000 |

改完重启后端，新 agent 就会出现在新建房间的选项里。

**这个 CLI 必须做到**：

- 能非交互地接收任务并运行，不会停下来等终端输入或权限确认；
- 能调用 MCP 工具——agent 通过 VioletDagger 的 MCP 服务发消息；
- 做完后自己退出；
- 每次运行相互独立。

这些要按 CLI 实际情况逐项验证。目前所有登记的 agent 都会显示为可用，不满足条件的 CLI 不会在建房时被拦下，只会在运行时失败。

**用量统计（可选）**：新 agent 默认不显示 token / 费用。需要的话，在 `packages/server/src/agent-invocation/usage.ts` 里为它加一个解析器（见 `docs/design/04-agent-invocation.md` §5）。

## 内置 agent 的配置说明

默认命令已对照各 CLI 的 `--help` 核对过，但 CLI 升级后参数可能变化，以你本机的 `--help` 为准。

| agent | 命令 | MCP 接入方式 |
|---|---|---|
| codex | `codex exec --json --dangerously-bypass-approvals-and-sandbox …` | 命令行内联 `-c mcp_servers…url` |
| claude | `claude -p … --dangerously-skip-permissions --output-format stream-json --verbose` | `--mcp-config` 指向每次生成的独立配置文件 |
| opencode | `opencode run --auto --format json …` | `OPENCODE_CONFIG` 环境变量指向每次生成的独立配置文件 |
| kimi | `kimi --output-format stream-json -p …` | 只认 `~/.kimi-code/mcp.json`，因此合并写入（保留你已有的其他配置）；`-p` 默认就是 auto 权限，不要再加 `--auto` |

前三个都关掉了权限确认，否则 MCP 工具调用会被审批挡住。四个都打开了 JSON 事件流输出，所以运行日志里看到的是原样记录的 JSON 行。

## 配置

| 环境变量 | 作用 | 默认 |
|---|---|---|
| `VIOLETDAGGER_HTTP_PORT` | 后端 REST / WebSocket 端口 | `4200` |
| `VIOLETDAGGER_MCP_PORT` | MCP 服务端口 | `4201` |
| `VIOLETDAGGER_DB_PATH` | SQLite 数据库路径 | `violetdagger.db`（后端工作目录下） |
| `VIOLETDAGGER_AGENTS_CONFIG` | agent 登记文件 | `agents.config.json`（后端工作目录下） |
| `VIOLETDAGGER_LOGS_DIR` | 运行日志目录 | `packages/server/logs` |

开发模式下前端的 `/api` 请求（含 WebSocket）由 Vite 代理到后端，无需配置跨域。

## 开发

```bash
npm start -w @violetdagger/server   # 只启动后端
npm run dev -w @violetdagger/web    # 只启动前端
npm test  -w @violetdagger/server   # 后端测试
npm test  -w @violetdagger/web      # 前端测试
```

项目结构：

```
docs/requirements.md    需求文档
docs/design/            各模块设计文档
packages/server/        后端：编排器、存储（SQLite）、记忆管理、MCP 服务、agent 调用
packages/web/           前端：React + Vite
```

技术栈：TypeScript / Node.js、SQLite（`better-sqlite3`）、`@modelcontextprotocol/sdk`、React + Vite。

> **注意**：`better-sqlite3` 必须是 13.x。11.x 在 Node 24 上会原生崩溃，导致后端不定时退出、前端报 `ECONNREFUSED`。仓库已锁定 `^13.0.3`。

这个项目先写文档、再写代码：任何改动先更新 `docs/` 里对应的设计文档。架构总览见 [`docs/design/00-overview.md`](docs/design/00-overview.md)。

## 已知缺口

- 人类发送 `chain` 消息时，还不能在界面上多选引用的消息（接口本身支持该字段）。
