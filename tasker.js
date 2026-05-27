// tasker.js — Task queue manager for Claude Code agents
// Run: node tasker.js

"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { exec } = require("child_process");

const PORT = 7842;
const HTML_FILE = path.join(__dirname, "tasker.html");
const STATE_FILE = path.join(__dirname, "tasks.json");

// ─── State ────────────────────────────────────────────────────────

let appState = null;
let paused = false;
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
    res.write(`data: ${JSON.stringify({ type: "connected", state: appState, paused })}\n\n`);
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

  if (req.method === "POST" && req.url === "/resume") {
    paused = false;
    broadcast({ type: "tasker_state", paused: false });
    exec('claude -p "/tasker-scan"', { detached: true });
    return json(res, 200, { ok: true, paused: false });
  }

  if (req.method === "GET" && req.url === "/paused") {
    if (!paused) broadcast({ type: "scan_heartbeat" });
    return json(res, 200, { paused });
  }

  if (req.method === "POST" && req.url === "/shutdown") {
    json(res, 200, { ok: true });
    broadcast({ type: "shutdown" });
    setTimeout(() => { for (const r of clients) { try { r.end(); } catch {} } server.close(() => process.exit(0)); }, 200);
    return;
  }

  json(res, 404, { error: "Not found" });
});

// ─── Claude Code skill installer ─────────────────────────────────

const TASK_INSTRUCTIONS = `
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
  - The working directory: \`${__dirname}\`
  - What to return: a concise summary of what was done, including any files changed

The agent should do the real work using its tools (Read, Edit, Write, Bash, etc.).

If multiple tasks are ready, spawn all agents in a **single message** as parallel Agent tool calls.

## 5. Collect results and update state

When each agent finishes, read the current \`${STATE_FILE}\` again, then:
- Set the task's \`status\` to \`"in_review"\`
- Append to its \`activity\` array: \`{"timestamp": "<ISO timestamp>", "type": "output", "content": "<agent's summary>"}\`
- POST the full patched state to \`http://localhost:7842/state\`

## 6. Schedule the next scan

Use ScheduleWakeup with \`delaySeconds=30\` and \`prompt="/tasker-scan"\` to keep the loop running.

---

**Important**: You are the coordinator. Never execute task work yourself — always delegate via Agent. If the server is unreachable, stop — do not reschedule.`;

function installSkills() {
  const commandsDir = path.join(os.homedir(), ".claude", "commands");

  const startBlock = process.platform === "win32"
    ? `   \`\`\`powershell
   if (-not (Invoke-WebRequest http://localhost:7842/ -TimeoutSec 1 -ErrorAction SilentlyContinue)) {
     Start-Process node -ArgumentList "${__dirname}\\tasker.js" -WorkingDirectory "${__dirname}"
     Start-Sleep 2
   }
   \`\`\``
    : `   \`\`\`bash
   if ! curl -s http://localhost:7842/ > /dev/null 2>&1; then
     nohup node "${__dirname}/tasker.js" > /dev/null 2>&1 &
     sleep 2
   fi
   \`\`\``;

  const taskerContent = `---
description: Start Tasker and begin executing ready tasks from tasks.json
---

You are the Tasker **team lead**. Your job is to manage the queue and delegate work to specialized sub-agents — not to do the work yourself.

The Tasker installation is at: ${__dirname}

## 1. Start the server

${startBlock}

${TASK_INSTRUCTIONS}`;

  const scanContent = `---
description: Check Tasker queue and execute any ready tasks
---

You are the Tasker **team lead**. Your job is to manage the queue and delegate work to specialized sub-agents — not to do the work yourself.

The Tasker installation is at: ${__dirname}

## 1. Check pause state

Run \`curl -s http://localhost:7842/paused\`.
- If the server is unreachable — stop. Do not reschedule.
- If response is \`{"paused":true}\` — stop immediately. Do not execute tasks or reschedule. The server will restart the loop automatically when you unpause from the UI.

${TASK_INSTRUCTIONS}`;

  try {
    fs.mkdirSync(commandsDir, { recursive: true });
    fs.writeFileSync(path.join(commandsDir, "tasker.md"), taskerContent, "utf8");
    console.log(`[tasker] Skill installed: /tasker`);
    fs.writeFileSync(path.join(commandsDir, "tasker-scan.md"), scanContent, "utf8");
    console.log(`[tasker] Skill installed: /tasker-scan`);
  } catch (err) {
    console.warn(`[tasker] Could not install skills: ${err.message}`);
  }
}

// ─── Start ────────────────────────────────────────────────────────

function openBrowser(url) {
  const cmd = process.platform === "win32" ? `start "" "${url}"` :
              process.platform === "darwin" ? `open "${url}"` : `xdg-open "${url}"`;
  exec(cmd);
}

installSkills();

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[tasker] Running at http://localhost:${PORT}`);
  console.log(`[tasker] Press Ctrl+C to stop.`);
  openBrowser(`http://localhost:${PORT}`);
});

process.on("SIGINT", () => { for (const res of clients) { try { res.end(); } catch {} } server.close(() => process.exit(0)); });
process.on("SIGTERM", () => { for (const res of clients) { try { res.end(); } catch {} } server.close(() => process.exit(0)); });
