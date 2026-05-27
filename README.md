# Tasker

A local-first kanban board for Claude Code agents. Create tasks on the board, run `/tasker` in Claude Code to execute them, and review the output — all without leaving your editor.

## Requirements

- Node.js 18 or later (no `npm install` needed)
- Claude Code

## Getting started

Drop the `Tasker/` folder anywhere, then run it from that directory:

```
node tasker.js
```

The server starts on `http://localhost:7842`, opens your browser automatically, and installs the `/tasker` and `/tasker-scan` Claude Code skills — see [Claude Code integration](#claude-code-integration) below.

> **First run only:** After running `tasker.js` for the first time, reload your VS Code window so the `/tasker` and `/tasker-scan` commands become available — `Cmd+Shift+P` → **Reload Window** on macOS, `Ctrl+Shift+P` → **Reload Window** on Windows/Linux.

## Board

Tasks move through five columns:

| Column | Meaning |
|---|---|
| **Backlog** | Not ready yet |
| **Ready** | Queued for execution — Claude Code will pick these up |
| **In Progress** | Claude Code is working on it |
| **In Review** | Done — review the output, then move to Done |
| **Done** | Complete |

Drag cards between columns at any time. Click the **+** in any column header to add a task directly into that column.

## Tasks

Each task has:

- **Title** and **Description** — the description becomes Claude Code's instructions
- **Agent** — which agent persona Claude Code adopts when executing
- **Priority** — Low / Medium / High (shown as a coloured dot on the card)

### Workflow

1. Create a task in **Backlog** or **Ready**
2. Run `/tasker` in Claude Code — it picks up all Ready tasks and executes them
3. Tasks move to **In Review** when done, with output in the activity log
4. Review the output, then click **Move to Done**

## Agents

Built-in agents: **Researcher**, **Coder**, **Reviewer**, **Writer**. Each has a role (system prompt) and a colour used on cards.

Add or edit agents from the **Agents** tab. The role field is the full system prompt sent to Claude Code when it executes a task for that agent — be specific.

## Claude Code integration

When `tasker.js` starts it installs two skills into `~/.claude/commands/`:

| Skill | Purpose |
|---|---|
| `/tasker` | Starts the server (if not running) and begins processing the queue |
| `/tasker-scan` | Checks the queue for ready tasks — used internally by the polling loop |

Tasker itself has no built-in model calls. All task execution happens inside Claude Code.

### How `/tasker` works

Run `/tasker` in Claude Code to start the executor loop:

1. Reads `tasks.json` and finds all tasks with `"status": "ready"`
2. Marks each task **In Progress**, then spawns a real sub-agent via the Agent tool to execute it — adopting the assigned agent's role as its persona
3. Collects results and moves finished tasks to **In Review**, posting output to the board
4. Schedules `/tasker-scan` to re-check every 30 seconds

The loop runs until you stop it or pause the queue. Tasks moved to Ready while it's running will be picked up on the next cycle.

### Team lead + agent pattern

`/tasker` acts as a team lead (orchestrator): it reads the queue, delegates each task to a dedicated sub-agent, then collects and records the results. Sub-agents have full access to Claude Code's tools — file read/write, shell, search, and so on.

## Pause and resume

The power button in the top-right corner lets you pause the executor:

- **On** — executor is running; Claude Code will pick up Ready tasks on the next cycle
- **Paused** — `/tasker-scan` stops scheduling itself; no new tasks will be picked up until resumed

## Settings

Open the **Settings** panel to toggle between dark and light mode.

## Data

State is persisted in `tasks.json` and synced to the browser in real time over SSE. The file is written on every state change.

## Files

| File | Purpose |
|---|---|
| `tasker.js` | HTTP server, SSE broker, skill installer, serves the UI |
| `tasks.json` | Persistent task state (created on first run) |
