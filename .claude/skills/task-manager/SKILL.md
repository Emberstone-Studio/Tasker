# Task Manager Skill

Trigger this skill at session start and whenever the user asks about tasks, agents, what's in progress, or uses task-related phrases like "what's next", "add a task", "move X to ready", "start the watcher", "what did [agent] do".

## On session start

Read `TASKS.html` and extract the embedded JSON state from `<script id="app-state" type="application/json">`. Parse it and report:

- How many tasks are **In Progress** (status: `in_progress` or `queued`) — list their titles and assigned agents
- How many tasks are **In Review** (status: `in_review`) — list their titles
- How many tasks are in **Backlog** and **Ready**
- Whether `node watch.js` appears to be needed (any tasks in Ready or queued state)

Format: concise bullet list. Example:
```
Board state:
• In Progress: "Research Carbon tokens" (Researcher)
• In Review: "Update button styles" 
• Ready: 2 tasks waiting for execution
• Backlog: 5 tasks

Run `node watch.js` to process queued tasks.
```

If TASKS.html doesn't exist yet, say so and tell the user to open TASKS.html in their browser.

## Reading state

```javascript
// Pattern to extract state from TASKS.html
const html = fs.readFileSync('TASKS.html', 'utf8')
const match = html.match(/<script id="app-state" type="application\/json">([\s\S]*?)<\/script>/)
const state = JSON.parse(match[1])
```

## Writing state

To update TASKS.html, read the file, parse the state, mutate it, then replace the script block:

```javascript
const newStateJson = JSON.stringify(state, null, 2)
const newHtml = html.replace(
  /(<script id="app-state" type="application\/json">)([\s\S]*?)(<\/script>)/,
  `$1\n${newStateJson}\n$3`
)
fs.writeFileSync('TASKS.html.tmp', newHtml)
fs.renameSync('TASKS.html.tmp', 'TASKS.html')
```

Always use the tmp → rename pattern to avoid corrupting the file.

## Natural language commands

### "Add a task to [do something]"

1. Infer the best agent from the description:
   - Research, audit, investigate, find, analyze → Researcher
   - Write, fix, build, implement, refactor, debug → Coder  
   - Review, check, validate, test → Reviewer
   - Document, summarize, draft, copy → Writer
2. Create a new task object with a generated ID (`crypto.randomUUID()` or timestamp-based), status `backlog`, priority `medium`
3. Assign the inferred agent and their default model
4. Add an activity entry: `{type: "created", content: "Created via Claude Code"}`
5. Write back to TASKS.html
6. Confirm: "Added '[title]' to Backlog, assigned to [Agent]."

### "What's in progress?" / "What's ready?"

Read state and summarize the relevant column. List task titles, agents, and how long they've been in that status.

### "Move [task name] to [column]"

Find the task by fuzzy title match, update its `status` field:
- Backlog → `backlog`
- Ready → `ready`
- In Progress → `in_progress`
- In Review → `in_review`
- Done → `done`

Add an activity entry: `{type: "moved", content: "Moved to [Column] via Claude Code"}`.
Write back to file.

### "Start the watcher"

Run: `node watch.js` in the terminal (use the Bash tool).

Check first that TASKS.html exists. Then start the process. Remind the user it will poll every 3 seconds and process any tasks with status `queued`.

### "Execute [task name]"

**Never execute tasks autonomously without explicit user instruction.**

Find the task by fuzzy title match. Confirm with the user: "Execute '[title]' with [Agent] via [Model]?" Only after confirmation:
1. Set `status = "queued"`
2. Add activity: `{type: "executed", content: "Queued for execution via Claude Code"}`
3. Write back to TASKS.html
4. Tell the user the watcher will pick it up within 3 seconds (remind them to run `node watch.js` if not started).

### "Show me what [agent] did on [task]"

Find the task, filter its `activity` array, format and display the entries chronologically. Include timestamps.

### "What agents do we have?"

Read `state.agents` and list: name, role summary (first sentence), default temperature, color.

### "Add an agent called [name]"

Prompt the user for: role description, default temperature (suggest 0.4), color. Then create the agent and write back.

## Important constraints

- **Never** execute tasks autonomously. Always require explicit "execute [task]" + user confirmation OR the Execute button in the UI.
- Always use the tmp → rename write pattern to avoid file corruption.
- After any write, confirm what changed.
- If TASKS.html is missing, do not create it — tell the user to open the browser UI.
- State in TASKS.html is the source of truth. localStorage in the browser is a live copy; writes from this skill update the file directly (the browser reloads state on its next poll).
