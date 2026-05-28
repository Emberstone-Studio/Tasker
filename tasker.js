// tasker.js — Task queue manager for Claude Code agents
// Run: node tasker.js

"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");

const PORT = 7842;
const HTML_FILE = path.join(__dirname, "tasker.html");
const STATE_FILE = path.join(__dirname, "tasks.json");

const DEFAULT_STATE = {
  tasks: [],
  agents: [
    { id: "agent-researcher-default", name: "Researcher", role: "You are a research agent. Your job is to find information, audit codebases, summarize findings, and answer questions with cited sources. Be thorough and precise. Prefer facts over speculation.", color: "#3b82f6" },
    { id: "agent-coder-default", name: "Coder", role: "You are a coding agent. Your job is to write, edit, debug, and explain code. Produce clean, working code with no unnecessary comments. Follow the existing conventions in the codebase.", color: "#10b981" },
    { id: "agent-reviewer-default", name: "Reviewer", role: "You are a review agent. Your job is to review output from other agents, flag issues, identify improvements, and provide actionable feedback. Be direct and specific.", color: "#f59e0b" },
    { id: "agent-writer-default", name: "Writer", role: "You are a writing agent. Your job is to write documentation, copy, summaries, and prose. Match the existing tone and style. Be clear and concise.", color: "#8b5cf6" }
  ],
  logs: []
};

// ─── State ────────────────────────────────────────────────────────

let appState = null;
let paused = false;
let lastHeartbeat = null;
try { appState = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch {}

// ─── SSE ─────────────────────────────────────────────────────────

const clients = new Set();

function broadcast(event) {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of clients) {
    try { res.write(data); } catch { clients.delete(res); }
  }
}

// ─── HTTP helpers ─────────────────────────────────────────────────

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json", ...CORS });
  res.end(JSON.stringify(body));
}

// ─── Server ───────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  if (req.method === "OPTIONS") { res.writeHead(204, CORS); res.end(); return; }

  if (req.method === "GET" && req.url === "/") {
    try {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(fs.readFileSync(HTML_FILE, "utf8"));
    } catch {
      res.writeHead(404); res.end("tasker.html not found in " + __dirname);
    }
    return;
  }

  if (req.method === "GET" && req.url === "/events") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", ...CORS });
    res.write(`data: ${JSON.stringify({ type: "connected", state: appState, paused, lastHeartbeat })}\n\n`);
    clients.add(res);
    const hb = setInterval(() => {
      try { res.write(": ping\n\n"); } catch { clearInterval(hb); clients.delete(res); }
    }, 25000);
    req.on("close", () => { clearInterval(hb); clients.delete(res); });
    return;
  }

  if (req.method === "GET" && req.url === "/state") {
    return json(res, 200, appState || {});
  }

  if (req.method === "POST" && req.url === "/state") {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      try {
        appState = JSON.parse(raw);
        fs.writeFileSync(STATE_FILE, raw, "utf8");
        broadcast({ type: "state_sync", state: appState });
        json(res, 200, { ok: true });
      } catch (err) {
        json(res, 400, { error: err.message });
      }
    });
    return;
  }

  if (req.method === "POST" && req.url === "/pause") {
    paused = true;
    broadcast({ type: "tasker_state", paused: true });
    return json(res, 200, { ok: true, paused: true });
  }

  if (req.method === "POST" && req.url === "/pause-with-message") {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const { message } = JSON.parse(raw || "{}");
      paused = true;
      broadcast({ type: "tasker_state", paused: true });
      broadcast({ type: "usage_cap", message: message || "Usage limit reached." });
      json(res, 200, { ok: true, paused: true });
    });
    return;
  }

  if (req.method === "POST" && req.url === "/resume") {
    paused = false;
    broadcast({ type: "tasker_state", paused: false });
    return json(res, 200, { ok: true, paused: false });
  }

  if (req.method === "GET" && req.url === "/paused") {
    if (!paused) { lastHeartbeat = Date.now(); broadcast({ type: "scan_heartbeat", lastHeartbeat }); }
    return json(res, 200, { paused });
  }

  if (req.method === "POST" && req.url === "/next-scan") {
    let body = "";
    req.on("data", d => body += d);
    req.on("end", () => {
      let parsed;
      try { parsed = JSON.parse(body || "{}"); } catch { return json(res, 400, { error: "invalid JSON" }); }
      const seconds = Number(parsed.seconds);
      if (!Number.isFinite(seconds) || seconds <= 0) return json(res, 400, { error: "seconds must be a positive number" });
      broadcast({ type: "next_scan", seconds });
      return json(res, 200, { ok: true });
    });
    return;
  }

  if (req.method === "POST" && req.url === "/shutdown") {
    json(res, 200, { ok: true });
    broadcast({ type: "shutdown" });
    setTimeout(() => { for (const r of clients) { try { r.end(); } catch {} } server.close(() => process.exit(0)); }, 200);
    return;
  }

  if (req.method === "GET" && req.url === "/permissions") {
    const settingsFile = path.join(__dirname, ".claude", "settings.json");
    try {
      const data = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
      return json(res, 200, { allow: (data.permissions && data.permissions.allow) || [] });
    } catch {
      return json(res, 200, { allow: [] });
    }
  }

  if (req.method === "POST" && req.url === "/permissions") {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      try {
        const body = JSON.parse(raw);
        const claudeDir = path.join(__dirname, ".claude");
        fs.mkdirSync(claudeDir, { recursive: true });
        const settingsFile = path.join(claudeDir, "settings.json");
        const settings = { permissions: { allow: body.allow || [] } };
        fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2), "utf8");
        json(res, 200, { ok: true });
      } catch (err) {
        json(res, 400, { error: err.message });
      }
    });
    return;
  }

  if (req.method === "POST" && req.url === "/chat") {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      let body;
      try { body = JSON.parse(raw); } catch { return json(res, 400, { error: "invalid JSON" }); }

      const message = (body.message || "").trim();
      if (!message) return json(res, 400, { error: "message is required" });
      const session_id = body.session_id || null;

      const tasks = (appState && appState.tasks || [])
        .map((t) => `  - [${t.status}] ${t.title}`)
        .join("\n") || "  (no tasks)";
      const agents = (appState && appState.agents || [])
        .map((a) => a.name)
        .join(", ") || "(none)";

      const systemPrompt =
        `You are a helpful assistant embedded in Tasker, a Claude Code task management board. ` +
        `You have full tool access and can act on the board by calling the Tasker REST API at http://localhost:${PORT}. ` +
        `Current board state:\n${tasks}\n` +
        `Agents available: ${agents}. ` +
        `To update the board, POST to http://localhost:${PORT}/state with the full updated state JSON.`;

      const args = ["--print", "--output-format", "stream-json", "--verbose",
                    "--system-prompt", systemPrompt];
      if (session_id) args.push("--resume", session_id);
      args.push(message);

      const child = spawn("claude", args, { stdio: ["ignore", "pipe", "pipe"] });

      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => { stdout += d; });
      child.stderr.on("data", (d) => { stderr += d; });

      child.on("error", (err) => {
        json(res, 500, { error: `Failed to spawn claude: ${err.message}` });
      });

      child.on("close", (code) => {
        let reply = "";
        let newSessionId = session_id || "";
        const lines = stdout.split("\n");
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const obj = JSON.parse(trimmed);
            if (obj.type === "result") {
              reply = obj.result || "";
              if (obj.session_id) newSessionId = obj.session_id;
              break;
            }
          } catch {}
        }
        if (code !== 0 && !reply) {
          return json(res, 500, { error: stderr.trim() || `claude exited with code ${code}` });
        }
        json(res, 200, { reply, session_id: newSessionId });
      });
    });
    return;
  }

  json(res, 404, { error: "Not found" });
});

// ─── Claude Code skill installer ─────────────────────────────────


const QUEUE_STEPS = `
## 2. Check the queue

Read \`${STATE_FILE}\`. Find all tasks with \`"status": "ready"\`.

If there are no ready tasks, skip to step 5.

## 3. Mark tasks in_progress

For each ready task, read the current \`${STATE_FILE}\` immediately before each POST (never use a stale copy), set that task's \`status\` to \`"in_progress"\`, and POST the full patched state to \`http://localhost:7842/state\`.

## 4. Spawn one Agent per task (in parallel if multiple)

For each task, call the **Agent tool** with:

- **description**: \`"[AgentName]: [task title]"\` — e.g. \`"Coder: Fix login bug"\`
- **prompt**: A self-contained brief that includes:
  - The agent's **role** (copy it verbatim from the \`agents\` array in ${STATE_FILE})
  - The task **title** and **description** (the agent's actual instructions)
  - Any user comments: activity entries with \`"type": "chat_user"\` from the task's \`activity\` array — include them verbatim under a **User comments** heading so the agent can address them
  - The working directory: \`${__dirname}\`
  - What to return: a concise summary of what was done, including any files changed

The agent should do the real work using its tools (Read, Edit, Write, Bash, etc.).

If multiple tasks are ready, spawn all agents in a **single message** as parallel Agent tool calls.

## 5. Collect results and update state

When each agent finishes, inspect its result **before** updating state:

**If the agent returned an error containing "rate limit", "usage limit", "overloaded", or "capacity":**
- Reset the task's \`status\` back to \`"ready"\` in ${STATE_FILE}
- POST to \`http://localhost:7842/pause-with-message\` with a JSON body like:
  \`{"message": "Paused: Claude usage limit hit while working on \\"<task title>\\". Resume when ready."}\`
- Stop immediately — do not update task state, do not call ScheduleWakeup.

**Otherwise (normal completion):**
- Read the current \`${STATE_FILE}\` again, then:
- Set the task's \`status\` to \`"in_review"\`
- Append to its \`activity\` array: \`{"timestamp": "<ISO timestamp>", "type": "output", "content": "<agent's summary>"}\`
- POST the full patched state to \`http://localhost:7842/state\``;

function installSkills() {
  const commandsDir = path.join(os.homedir(), ".claude", "commands");

  const startBlock = `\`\`\`bash
if ! curl -s http://localhost:7842/ > /dev/null 2>&1; then
  nohup node "${__dirname.replace(/\\/g, "/")}/tasker.js" serve > /dev/null 2>&1 &
  for i in 1 2 3 4 5 6 7 8 9 10; do
    sleep 1
    curl -s http://localhost:7842/ > /dev/null 2>&1 && break
  done
fi
\`\`\``;

  const openBrowserCmd = process.platform === "win32"
    ? `start "" "http://localhost:${PORT}"`
    : process.platform === "darwin"
    ? `open "http://localhost:${PORT}"`
    : `xdg-open "http://localhost:${PORT}"`;

  const taskerContent = `---
description: Start the Tasker server, open the board, and start the scan loop
---

The Tasker installation is at: ${__dirname}

## 1. Start the server if needed

${startBlock}

## 2. Open the browser

\`\`\`bash
${openBrowserCmd}
\`\`\`

## 3. Start the scan loop

Invoke the \`/tasker-scan\` skill.
`;

  const scanContent = `---
description: Start the Tasker server if needed, then check the queue and execute ready tasks
---

You are the Tasker **team lead**. Your job is to manage the queue and delegate work to specialized sub-agents — not to do the work yourself.

The Tasker installation is at: ${__dirname}

## 1. Start the server if needed

${startBlock}

\`\`\`bash
curl -s -X POST http://localhost:7842/resume
\`\`\`

${QUEUE_STEPS}

## 6. Start the watch loop

Call ScheduleWakeup with \`delaySeconds=30\` and \`prompt="/tasker-watch"\`. The result text looks like \`"Next wakeup scheduled for ... (in 101s)"\`. Extract the number using a pattern like \`/\\(in (\\d+)s\\)/\`, then POST it:

\`\`\`bash
curl -s -X POST http://localhost:7842/next-scan -H "Content-Type: application/json" -d "{\\"seconds\\": X}"
\`\`\`

Replace X with the actual seconds. If you cannot parse the number, use 90.

---

**Important**: You are the coordinator. Never execute task work yourself — always delegate via Agent.`;

  const watchContent = `---
description: Wait 30 seconds, check pause state, then invoke /tasker-scan if not paused
---

## 1. Check pause state

Run \`curl -s http://localhost:7842/paused\`.
- If \`{"paused":true}\` — stop immediately. Do not reschedule.

## 2. Run the next scan

Invoke the \`/tasker-scan\` skill.
`;

  const pauseContent = `---
description: Pause the Tasker scan loop
---

\`\`\`bash
curl -s -X POST http://localhost:7842/pause
\`\`\`

Then stop — do not reschedule.
`;

  const stopContent = `---
description: Stop the Tasker server
---

\`\`\`bash
curl -s -X POST http://localhost:7842/shutdown
\`\`\`
`;

  try {
    fs.mkdirSync(commandsDir, { recursive: true });
    fs.writeFileSync(path.join(commandsDir, "tasker.md"), taskerContent, "utf8");
    console.log(`[tasker] Skill installed: /tasker`);
    fs.writeFileSync(path.join(commandsDir, "tasker-scan.md"), scanContent, "utf8");
    console.log(`[tasker] Skill installed: /tasker-scan`);
    fs.writeFileSync(path.join(commandsDir, "tasker-watch.md"), watchContent, "utf8");
    console.log(`[tasker] Skill installed: /tasker-watch`);
    fs.writeFileSync(path.join(commandsDir, "tasker-pause.md"), pauseContent, "utf8");
    console.log(`[tasker] Skill installed: /tasker-pause`);
    fs.writeFileSync(path.join(commandsDir, "tasker-stop.md"), stopContent, "utf8");
    console.log(`[tasker] Skill installed: /tasker-stop`);
  } catch (err) {
    console.warn(`[tasker] Could not install skills: ${err.message}`);
  }
}

// ─── Start ────────────────────────────────────────────────────────

installSkills();

if (process.argv[2] === "serve") {
  if (!appState) {
    appState = DEFAULT_STATE;
    fs.writeFileSync(STATE_FILE, JSON.stringify(appState, null, 2), "utf8");
  }
  server.listen(PORT, "127.0.0.1", () => {
    console.log(`[tasker] Running at http://localhost:${PORT}`);
    console.log(`[tasker] Press Ctrl+C to stop.`);
  });
  process.on("SIGINT", () => { for (const res of clients) { try { res.end(); } catch {} } server.close(() => process.exit(0)); });
  process.on("SIGTERM", () => { for (const res of clients) { try { res.end(); } catch {} } server.close(() => process.exit(0)); });
} else {
  console.log(`\nNext steps:`);
  console.log(`  1. Reload VS Code — open the command palette and run "Reload Window"`);
  console.log(`  2. Run /tasker in Claude Code\n`);
}
