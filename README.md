# Tasker

A local-first kanban board for Claude Code agents. Create tasks on the board, run `/tasker` in Claude Code to execute them, and review the output — all without leaving your editor.

## Requirements

- Node.js 18 or later (no `npm install` needed)
- Claude Code

## Getting started

1. Drop the `Tasker/` folder anywhere on your machine.

2. Run the installer from that directory:
   ```
   node tasker.js
   ```
   This installs five Claude Code skills and prints the next steps. It does **not** start a server.

3. Reload your VS Code window so the new skills are available:
   - Open the command palette (`Cmd+Shift+P` on macOS, or your configured shortcut on Windows/Linux)
   - Run **Reload Window**

4. Run `/tasker` in Claude Code. This starts the server, opens the board in your browser, and begins the scan loop.

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

### Comments

Each task has an activity log where you can leave comments. Any comments you add are included in the agent's prompt when the task is next picked up, so the agent can address them.

## Agents

Built-in agents: **Researcher**, **Coder**, **Reviewer**, **Writer**. Each has a role (system prompt) and a colour used on cards.

Add or edit agents from the **Agents** tab. The role field is the full system prompt sent to Claude Code when it executes a task for that agent — be specific.

## Claude Code skills

Running `node tasker.js` installs five skills into `~/.claude/commands/`:

| Skill | Purpose |
|---|---|
| `/tasker` | Starts the server (if not running), opens the board, and starts the scan loop |
| `/tasker-scan` | Starts the server if needed, checks the queue, executes ready tasks, then schedules `/tasker-watch` |
| `/tasker-watch` | Waits 30 seconds, checks pause state, then calls `/tasker-scan` if not paused |
| `/tasker-pause` | Pauses the scan loop (server keeps running) |
| `/tasker-stop` | Shuts down the server |

Tasker itself has no built-in model calls. All task execution happens inside Claude Code.

### How the loop works

`/tasker-scan` and `/tasker-watch` alternate to keep the queue running:

1. `/tasker-scan` starts the server (if not running), then scans the queue
2. It reads `tasks.json`, finds all tasks with `"status": "ready"`, marks them **In Progress**, and spawns a dedicated sub-agent per task
3. When agents finish, tasks move to **In Review** with output posted to the activity log
4. `/tasker-scan` then schedules `/tasker-watch` with a 30-second delay
5. `/tasker-watch` wakes up, checks the pause state, and calls `/tasker-scan` again if not paused

The loop runs until you pause or stop it. Tasks moved to Ready while the loop is running are picked up on the next cycle.

### Team lead + agent pattern

`/tasker-scan` acts as a team lead (orchestrator): it reads the queue, delegates each task to a dedicated sub-agent via the Agent tool, then collects and records the results. Sub-agents have full access to Claude Code's tools — file read/write, shell, search, and so on.

## Pause and resume

The board's top bar shows a **countdown** to the next scan. Two buttons sit to the right of it:

- **Pause** (‖) — stops the loop after the current scan; the board shows "Paused — run: /tasker-scan"
- **Stop** (⏻) — shuts down the server entirely

To resume after pausing, run `/tasker-scan` in Claude Code. It always starts the server if needed and clears the paused state before scanning.

## Settings

Open the **Settings** panel to toggle between dark and light mode.

## Data

State is persisted in `tasks.json` and synced to the browser in real time over SSE. The file is written on every state change.

## Files

| File | Purpose |
|---|---|
| `tasker.js` | Skill installer (default) and HTTP server (`node tasker.js serve`) |
| `tasks.json` | Persistent task state (created automatically on first server start) |
