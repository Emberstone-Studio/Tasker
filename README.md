# Tasker

A local-first kanban board for Claude Code agents. Create tasks on the board, run `/tasker` in Claude Code to execute them, and review the output — all without leaving your editor.

![Tasker board](https://raw.githubusercontent.com/Emberstone-Studio/Tasker/main/tasker-screen.jpeg)

## Requirements

- Node.js 18 or later (no `npm install` needed)
- Claude Code

## Getting started

1. Drop the `Tasker/` folder anywhere on your machine.

2. Run the installer from that directory:
   ```
   node tasker.js
   ```
   This installs five Claude Code skills into `~/.claude/commands/` and prints the next steps. It does **not** start a server.

3. Reload your VS Code window so the new skills are available:
   - Open the command palette (`Ctrl+Shift+P` on Windows/Linux, `Cmd+Shift+P` on macOS)
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

- **Title** and **Description** — the description becomes the agent's instructions
- **Agent** — which agent to assign; leave it as **Auto** to let the team lead decide
- **Pipeline** — an optional sequence of agents to run in order (each agent's output is passed to the next)
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

Add or edit agents from the **Agents** tab. The role field is the full system prompt sent to the sub-agent when it executes a task — be specific.

If a task's agent is set to **Auto** (`agent_id: null`), the team lead chooses the most appropriate agent from the available list.

## Pipelines

A pipeline is a sequence of agents applied to a single task in order. Add pipeline steps in the task form — each step is an agent selected from your roster. When the task runs:

1. The first agent in the pipeline executes and produces output
2. That output is handed to the second agent as its input, and so on
3. The task moves to **In Review** after the final step completes

The card shows a **Step N/M** badge while a pipeline task is in progress, and the progress bar tracks completed steps against the total.

## Claude Code skills

Running `node tasker.js` installs five skills into `~/.claude/commands/`:

| Skill | Purpose |
|---|---|
| `/tasker` | Starts the server (if not running), opens the board, and starts the scan loop |
| `/tasker-scan` | Starts the server if needed, resumes the loop, scans the queue, executes ready tasks, then schedules `/tasker-watch` |
| `/tasker-watch` | Checks pause state, then calls `/tasker-scan` if not paused |
| `/tasker-pause` | Pauses the scan loop (server keeps running) |
| `/tasker-stop` | Shuts down the server |

Tasker itself has no built-in model calls. All task execution happens inside Claude Code.

### How the loop works

`/tasker-scan` and `/tasker-watch` alternate to keep the queue running:

1. `/tasker-scan` starts the server (if not running), resumes the loop, then scans the queue
2. It reads `tasks.json`, finds all tasks with `"status": "ready"`, marks them **In Progress**, and spawns a dedicated sub-agent per task via the Agent tool
3. When agents finish, tasks move to **In Review** with output posted to the activity log
4. `/tasker-scan` schedules `/tasker-watch` by calling `ScheduleWakeup` with `delaySeconds=30`. The runtime clamps this to a minimum of ~60 seconds. The actual delay is extracted from the wakeup confirmation text and posted to `POST /next-scan` so the countdown on the board reflects reality rather than the requested delay
5. `/tasker-watch` wakes up, checks the pause state via `GET /paused`, and calls `/tasker-scan` again if not paused

The loop runs until you pause or stop it. Tasks moved to Ready while the loop is running are picked up on the next cycle.

### Team lead + agent pattern

`/tasker-scan` acts as a **team lead** (orchestrator): it reads the queue, delegates each task to a dedicated sub-agent via the Agent tool, then collects and records the results. The team lead never does task work itself — it only coordinates.

Sub-agents receive a self-contained prompt that includes the agent's role, the task title and description, any user comments from the activity log, the working directory, and instructions on what to return. Sub-agents have full access to Claude Code's tools — file read/write, shell, search, and so on.

If multiple tasks are ready, all sub-agents are spawned in a single message as parallel Agent tool calls.

### Usage limits

If an agent returns an error indicating a rate limit or usage cap, the team lead resets the task back to **Ready**, posts a warning banner to the board via `POST /pause-with-message`, and stops the loop. The board displays the message with a **Resume** button. Clicking Resume clears the banner and posts to `POST /resume` — then run `/tasker-scan` in Claude Code to restart the loop.

## Pause and resume

The top bar shows the current status and a **countdown** to the next scan. Two control buttons appear when the server is running:

- **Pause** (‖) — stops the loop after the current scan; the board shows "Paused — run: /tasker-scan"
- **Stop** (⏻) — shuts down the server entirely

To resume after pausing, run `/tasker-scan` in Claude Code. It always resumes the loop and clears the paused state before scanning.

## Chat panel

Click the **chat bubble icon** in the top-right corner to open the chat panel. It slides in from the right side of the board and stays open as you work.

The chat panel connects to a Claude instance that has full awareness of your current board state — all tasks and their statuses, and the list of configured agents. You can ask it to explain what's happening, create new tasks, or make changes to the board. The assistant has tool access and can update the board by calling the Tasker REST API directly.

Conversations persist within the session. Each message is sent with a session ID so the assistant maintains context across exchanges.

## Settings

Open the **Settings** panel (⚙) to:

- **Toggle dark/light mode** — switches between the dark (default) and light themes; preference is saved in `localStorage`
- **Permissions** — toggle which tool categories sub-agents are allowed to use without a permission prompt. Changes are written to `.claude/settings.json` in the Tasker directory

| Permission | Tools |
|---|---|
| Read files | `Read` |
| Edit / Write files | `Edit`, `Write` |
| Bash commands | `Bash(*)` |
| Web access | `WebFetch(*)`, `WebSearch(*)` |

Note: the Settings modal no longer includes an Export State JSON button. To export state, copy `tasks.json` directly.

## Data

State is persisted in `tasks.json` and synced to the browser in real time over SSE. The file is written on every state change.

## Files

| File | Purpose |
|---|---|
| `tasker.js` | Skill installer (default) and HTTP server (`node tasker.js serve`) |
| `tasker.html` | The board UI, served at `http://localhost:7842` |
| `tasks.json` | Persistent task state (created automatically on first server start) |
| `.claude/settings.json` | Agent permissions (created by the Settings panel) |
| `~/.claude/commands/tasker.md` | `/tasker` skill — starts server, opens board, begins scan loop |
| `~/.claude/commands/tasker-scan.md` | `/tasker-scan` skill — team lead that delegates tasks to sub-agents |
| `~/.claude/commands/tasker-watch.md` | `/tasker-watch` skill — checks pause state and re-triggers scan |
| `~/.claude/commands/tasker-pause.md` | `/tasker-pause` skill — pauses the loop |
| `~/.claude/commands/tasker-stop.md` | `/tasker-stop` skill — shuts down the server |
