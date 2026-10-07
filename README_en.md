# VioletDagger

[中文](README.md) | English

A multi-agent collaboration chat room that runs locally. You create a room, write down a task goal, and bring in several AI coding agents (Codex, Claude, opencode, Kimi, or your own). They split the work, research it, check each other's findings, and record what they learn as shared memory. You watch the whole process live in the browser and can step in, pause, or stop an agent at any time.

Single machine, single user.

## Quick start

You need Node.js and at least one agent CLI that is installed and logged in.

```bash
npm install
npm run dev
```

Open http://localhost:5173, create a room, pick agents, and send the first message — that message is the task goal.

`npm run dev` starts the backend and frontend together; `Ctrl+C` stops both. On startup the backend self-checks its MCP service and exits with the reason if the check fails.

## How to use it

- **Rooms**: one room per task. The agents in a room are chosen when you create it and can't be changed later. You can click the same agent more than once to get several instances (`codex-1`, `codex-2`, …).
- **Messages**: everything the agents and you have said. Click a message to reply to it; type `@agent-name` to direct a message to one agent.
- **Memory**: structured findings grouped by type (questions, hypotheses, facts, boundaries, solutions, verifications, …).
- **Event tree**: every run (session) of every agent, in time order. Open one to see the messages it produced and its run log.
- **Controls**: the top bar pauses / resumes or ends the room; the left rail stops a running agent or disables dispatch to an agent.
- **UI language**: the `EN` / `中` button at the right of the top bar switches between Chinese and English.

## Adding a new agent

Agents are registered in `packages/server/agents.config.json`, which the backend reads at startup (set `VIOLETDAGGER_AGENTS_CONFIG` to use a different file). Add an entry under `"agents"`; the key is the name you'll see when creating a room:

```json
"my-agent": {
  "command": ["my-agent", "-p", "{{prompt}}"],
  "mcpFile": {
    "template": "{\"mcpServers\":{\"violetdagger\":{\"url\":\"{{mcpUrl}}\"}}}"
  }
}
```

| Field | Meaning |
|---|---|
| `command` (required) | A one-shot, non-interactive launch command, executed directly as an array (no shell). Placeholders: `{{prompt}}`, `{{promptFile}}`, `{{mcpUrl}}`, `{{mcpFile}}` |
| `promptVia` | `"arg"` (default, prompt goes in the command arguments) or `"stdin"` (prompt is piped to standard input) |
| `env` | Extra environment variables |
| `mcpFile` | For CLIs that need an MCP config file: each run writes `template` to its own file, and `{{mcpFile}}` is that file's path. Set `path` + `merge: true` only when the CLI only reads config from a fixed location (see kimi) |
| `stopGraceMs` / `stopConfirmMs` | How long to wait when stopping an agent, in milliseconds; defaults 2000 / 3000 |

Restart the backend after editing; the new agent then appears in the new-room options.

**The CLI must be able to:**

- take a task and run non-interactively, never stopping to wait for terminal input or permission prompts;
- call MCP tools — agents post messages through VioletDagger's MCP service;
- exit by itself when it's done;
- keep each run independent of the others.

Verify each of these against the actual CLI. Currently every registered agent is shown as available, so a CLI that doesn't meet them won't be rejected when you create a room — it will just fail when it runs.

**Usage tracking (optional)**: a new agent shows no token / cost figures by default. To add them, write a parser for it in `packages/server/src/agent-invocation/usage.ts` (see `docs/design/04-agent-invocation.md` §5).

## Built-in agent setup

The default commands were checked against each CLI's `--help`, but flags can change when a CLI is upgraded — your local `--help` is the source of truth.

| agent | command | how MCP is connected |
|---|---|---|
| codex | `codex exec --json --dangerously-bypass-approvals-and-sandbox …` | inline `-c mcp_servers…url` on the command line |
| claude | `claude -p … --dangerously-skip-permissions --output-format stream-json --verbose` | `--mcp-config` points to a config file generated for each run |
| opencode | `opencode run --auto --format json …` | the `OPENCODE_CONFIG` environment variable points to a config file generated for each run |
| kimi | `kimi --output-format stream-json -p …` | only reads `~/.kimi-code/mcp.json`, so it is merged in (your other entries are kept); `-p` already uses auto permissions, so don't add `--auto` |

The first three turn off permission prompts, otherwise MCP tool calls would be blocked waiting for approval. All four turn on JSON event-stream output, so the run log shows JSON lines recorded as-is.

## Configuration

| Environment variable | Purpose | Default |
|---|---|---|
| `VIOLETDAGGER_HTTP_PORT` | Backend REST / WebSocket port | `4200` |
| `VIOLETDAGGER_MCP_PORT` | MCP service port | `4201` |
| `VIOLETDAGGER_DB_PATH` | SQLite database path | `violetdagger.db` (in the backend's working directory) |
| `VIOLETDAGGER_AGENTS_CONFIG` | Agent registry file | `agents.config.json` (in the backend's working directory) |
| `VIOLETDAGGER_LOGS_DIR` | Run log directory | `packages/server/logs` |

In development, the frontend's `/api` requests (including WebSocket) are proxied to the backend by Vite, so no CORS setup is needed.

## Development

```bash
npm start -w @violetdagger/server   # backend only
npm run dev -w @violetdagger/web    # frontend only
npm test  -w @violetdagger/server   # backend tests
npm test  -w @violetdagger/web      # frontend tests
```

Project layout:

```
docs/requirements.md    requirements
docs/design/            per-module design docs
packages/server/        backend: orchestrator, storage (SQLite), memory management, MCP service, agent invocation
packages/web/           frontend: React + Vite
```

Tech stack: TypeScript / Node.js, SQLite (`better-sqlite3`), `@modelcontextprotocol/sdk`, React + Vite.

> **Note**: `better-sqlite3` must be 13.x. 11.x crashes natively on Node 24, making the backend exit at random and the frontend report `ECONNREFUSED`. The repo pins `^13.0.3`.

This project is docs-first: any change starts by updating the matching design doc in `docs/`. For the architecture overview see [`docs/design/00-overview.md`](docs/design/00-overview.md).

## Known gaps

- When a human sends a `chain` message, the UI can't yet multi-select the messages it references (the API itself accepts the field).
