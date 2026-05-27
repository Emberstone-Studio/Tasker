# Tasker

A local-first kanban board for Claude Code agents. Create tasks on the board, run `/tasker` in Claude Code to execute them, and review the output — all without leaving your editor.

## Requirements

- Node.js 18 or later (no `npm install` needed)
- Claude Code

## Getting started

Drop the `Tasker/` folder anywhere, then run it from the directory you want agents to work in:

```
# from your project root:
node path/to/Tasker/tasker.js

# or cd into it:
cd Tasker && node tasker.js
```

The server starts on `http://localhost:7842` and opens your browser automatically. It also installs the `/tasker` Claude Code skill — see [Claude Code integration](#claude-code-integration) below.

> **First run only:** After running `tasker.js` for the first time, reload your VS Code window so the `/tasker` command becomes available — `Cmd+Shift+P` → **Reload Window** on macOS, `Ctrl+Shift+P` → **Reload Window** on Windows/Linux.

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

When `tasker.js` starts it writes a `/tasker` skill to `~/.claude/commands/tasker.md`. This is the execution engine — Tasker itself has no built-in model calls.

### How `/tasker` works

Run `/tasker` in Claude Code to start the executor loop:

1. Opens `tasker.html` in your default browser
2. Reads `tasks.json` and finds all tasks with `"status": "ready"`
3. Executes each task using Claude Code's own tools (file read/write, shell, search, etc.), adopting the assigned agent's role as its persona
4. Moves finished tasks to **In Review** and posts output to the board
5. Schedules itself to re-check every 30 seconds

The loop runs until you stop it. Tasks moved to Ready while it's running will be picked up on the next cycle.

## Tasker toggle

The status indicator in the top-right corner shows the connection state and lets you pause the executor:

- **Green / on** — server is running
- **Amber / off** — paused; Claude Code will not pick up new tasks until resumed
- **Red / dimmed** — server not running; start it with `node tasker.js`

## Data

State is persisted in `tasks.json` in the Tasker directory and synced to the browser in real time over SSE. The file is written on every state change.

## Files

| File | Purpose |
|---|---|
| `tasker.js` | HTTP server, SSE broker, skill installer |
| `tasker.html` | Single-file frontend app (served by tasker.js) |
| `tasks.json` | Persistent task state (created on first run) |
