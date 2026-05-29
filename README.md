# Tasker

A kanban board for Claude Code agents. Run `/tasker` in Claude Code to create, review, and execute tasks — all without leaving your editor.

![Tasker board](https://raw.githubusercontent.com/Emberstone-Studio/Tasker/main/tasker-screen1.png)

## Requirements

- [Node.js](https://nodejs.org/en)
- [VS Code](https://code.visualstudio.com/download)
- [Claude Code](https://claude.com/product/claude-code)

## Getting Started

### 1. Install globally (once)

Download the [latest release](https://github.com/Emberstone-Studio/Tasker/releases) (Tasker.zip) and extract it anywhere (e.g. your Downloads folder). Then:

- **macOS** — double-click `Install-Mac.command`
- **Windows** — double-click `Install-Windows.bat`

This copies the `.tasker/` folder to `~/.claude/tasker/`, installs four Claude Code skills into `~/.claude/commands/`, and prints the next steps.

### 2. Reload VS Code

Open the command palette (`Cmd+Shift+P` on macOS, `Ctrl+Shift+P` on Windows/Linux) and run **Reload Window** so the new skills are available.

### 3. Use in any project

Open a project in VS Code and run `/tasker` in Claude Code. On the first run in a new project it creates a `.tasker/` directory and copies `tasker.js`, `tasker.html`, and `README.md` into it, then starts the server, opens the board, and begins the scan loop. Nothing to copy or unzip per project.

---

## Board

Tasks move through five columns:

| Column | Meaning |
|---|---|
| **Backlog** | Not ready yet |
| **Ready** | Queued for execution — the scan loop will pick these up |
| **In Progress** | Being worked on |
| **In Review** | Review the output, then move to Done or back into the queue with new comments |
| **Done** | Complete |

Drag cards between columns at any time. Click the **+** in any column header to add a task directly into that column.

## Tasks

Each task has:

- **Title** and **Description** — the description becomes the agent's instructions
- **Agent** — which agent to assign; leave it as **Auto** to let the team lead decide
- **Pipeline** — an optional sequence of agents to run in order
- **Priority** — Low / Medium / High (shown as a coloured dot on the card)

### Workflow

1. Create a task in **Backlog** or **Ready**
2. Run `/tasker` in Claude Code — the server starts and the scan loop picks up ready tasks automatically
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

Running the installer installs four skills into `~/.claude/commands/`:

| Skill | Purpose |
|---|---|
| `/tasker` | Bootstraps project files if missing, starts the server, opens the board |
| `/tasker-scan` | Manually triggers a scan: starts the server if needed, picks up ready tasks, and executes them |
| `/tasker-pause` | Pauses the scan loop (clears the server timer) |
| `/tasker-stop` | Shuts down the server |

Tasker itself has no built-in model calls. All task execution happens inside Claude Code.

### Ports

Each project gets a stable port derived from its directory path (range 7843–9842), so multiple projects can run simultaneously without conflict.

### How the scan loop works

The scan loop runs entirely inside the server process. On startup, the server starts a timer (default 60 seconds, configurable in Settings). On each tick:

1. If paused or no ready tasks, skip
2. Spawn `claude --print` with a self-contained prompt instructing it to call `/claim-ready`, dispatch sub-agents, and update task state when done
3. Reschedule the timer

The loop is completely invisible — you will never see a background turn fire in Claude Code.

### Team lead + agent pattern

When tasks are ready, a Claude instance acts as a **team lead** (orchestrator): it calls `/claim-ready` to atomically claim ready tasks, delegates each to a dedicated sub-agent via the Agent tool, then posts results back to the server. The team lead never does task work itself — it only coordinates.

Sub-agents receive a self-contained prompt that includes the agent's role, the task title and description, any user comments from the activity log, the working directory, and instructions on what to return. Sub-agents have full access to Claude Code's tools — file read/write, shell, search, and so on.

If multiple tasks are ready, all sub-agents are spawned in a single message as parallel Agent tool calls.

### Usage limits

If an agent hits a rate limit or usage cap, the team lead resets the task back to **Ready** and posts a warning banner to the board. Click **Resume** on the banner to clear it and restart the loop.

## Pause and resume

The top bar shows the current status and a countdown to the next scan. Controls available when the server is running:

- **⚡ Scan Now** — immediately checks for ready tasks and processes them; visible when running or paused
- **▶ Resume** — restarts the scan timer from the beginning; visible when paused
- **⏸ Pause** — stops the scan timer; visible when running
- **⏻ Stop** — shuts down the server entirely

When paused, the timer is fully cleared. Clicking Resume or Scan Now are the two ways to act while paused — Resume restarts the automatic loop, Scan Now runs a one-off check without restarting the timer.

## Chat panel

Click the **chat bubble icon** in the top-right corner to open the chat panel. It slides in from the right side of the board and stays open as you work.

The chat panel connects to a Claude instance that has full awareness of your current board state — all tasks and their statuses, and the list of configured agents. You can ask it to explain what's happening, create new tasks, or make changes to the board. The assistant has tool access and can update the board by calling the Tasker REST API directly.

Conversations persist within the session. Each message is sent with a session ID so the assistant maintains context across exchanges.

## Settings

Open the **Settings** panel (⚙) to configure:

- **Scan interval** — how often the loop checks for ready tasks (30s / 1m / 2m / 5m / 10m)
- **Dark/light mode** — preference saved in `localStorage`
- **Permissions** — which tool categories sub-agents can use without a permission prompt; written to `.claude/settings.json`

| Permission | Tools |
|---|---|
| Read files | `Read` |
| Edit / Write files | `Edit`, `Write` |
| Bash commands | `Bash(*)` |
| Web access | `WebFetch(*)`, `WebSearch(*)` |

## Data

State is persisted in `.tasker/tasks.json` and synced to the browser in real time over SSE. The file is written on every state change. To export state, copy `.tasker/tasks.json` directly.

## Files

| Location | Purpose |
|---|---|
| `Install-Mac.command` | macOS installer — double-click to run |
| `Install-Windows.bat` | Windows installer — double-click to run |
| `~/.claude/tasker/` | Master copy installed globally |
| `~/.claude/commands/tasker*.md` | Global skills, installed once, shared by all projects |
| `<project>/.tasker/tasker.js` | Per-project server (copied from master on first `/tasker` run) |
| `<project>/.tasker/tasker.html` | Per-project UI (copied from master on first `/tasker` run) |
| `<project>/.tasker/README.md` | Per-project readme (copied from master on first `/tasker` run) |
| `<project>/.tasker/tasks.json` | Per-project task state (created on first server start) |

---

> Patent Pending — US Application 64/076,775 · © 2026 Emberstone Studio
