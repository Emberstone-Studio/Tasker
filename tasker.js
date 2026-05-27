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
    return json(res, 200, { ok: true, paused: false });
  }

  json(res, 404, { error: "Not found" });
});

// ─── Claude Code skill installer ─────────────────────────────────

function installSkill() {
  const commandsDir = path.join(os.homedir(), ".claude", "commands");
  const skillFile = path.join(commandsDir, "tasker.md");

  let step0;
  if (process.platform === "win32") {
    step0 = `0. **Start server and open UI**: If this invocation has a \`<command-name>\` tag in context (i.e., the user ran \`/tasker\` manually, not a ScheduleWakeup loop wakeup):
   - Run this PowerShell to check if the server is running and start it if not (it opens the browser automatically on start); if already running, open the UI manually:
   \`\`\`powershell
   try {
     Invoke-WebRequest http://localhost:7842/ -TimeoutSec 1 -ErrorAction Stop | Out-Null
     Start-Process "${HTML_FILE}"
   } catch {
     Start-Process node -ArgumentList "${__dirname}\\tasker.js" -WorkingDirectory "${__dirname}"
   }
   \`\`\``;
  } else {
    const openCmd = process.platform === "darwin" ? `open "${HTML_FILE}"` : `xdg-open "${HTML_FILE}"`;
    step0 = `0. **Start server and open UI**: If this invocation has a \`<command-name>\` tag in context (i.e., the user ran \`/tasker\` manually, not a ScheduleWakeup loop wakeup):
   - Check if the server is running and start it if not:
   \`\`\`bash
   if curl -s http://localhost:7842/ > /dev/null 2>&1; then
     ${openCmd}
   else
     nohup node "${__dirname}/tasker.js" > /dev/null 2>&1 &
   fi
   \`\`\``;
  }

  const content = `---
description: Run Tasker — execute ready tasks from tasks.json and loop for more
---

You are the Tasker agent executor. The Tasker installation is at: ${__dirname}

Each time you are invoked, do the following in order:

${step0}

1. **Check the queue**: Read \`${STATE_FILE}\`. Find all tasks with \`"status": "ready"\`.

2. **Execute each ready task**:
   - IMPORTANT: Always read the current \`${STATE_FILE}\` immediately before each POST — never reconstruct the full state from memory. Only modify the specific task's fields, then POST the full patched object.
   - Set this task's status to \`"in_progress"\`, POST to \`http://localhost:7842/state\`
   - Read the task's \`description\` as your instructions
   - Adopt the assigned agent's \`role\` as your persona (from the \`agents\` array)
   - Execute the work using your real tools (Read, Edit, Write, Bash, Glob, Grep, etc.)
   - When done, read \`${STATE_FILE}\` again, set this task's status to \`"in_review"\`, append an \`output\` entry to its \`activity\` array, POST the patched state to \`http://localhost:7842/state\`

3. **Loop**: Use ScheduleWakeup with delaySeconds=30 and prompt \`/tasker\` to check again.

If the Tasker server is not running (POST fails), write the state directly to \`${STATE_FILE}\`.

Always work relative to the task's context — if the task mentions a project or file path, work there. Follow the agent persona strictly.
`;
  try {
    fs.mkdirSync(commandsDir, { recursive: true });
    fs.writeFileSync(skillFile, content, "utf8");
    console.log(`[tasker] Skill installed: /tasker`);
  } catch (err) {
    console.warn(`[tasker] Could not install /tasker skill: ${err.message}`);
  }
}

// ─── Start ────────────────────────────────────────────────────────

function openBrowser(url) {
  const cmd = process.platform === "win32" ? `start "" "${url}"` :
              process.platform === "darwin" ? `open "${url}"` : `xdg-open "${url}"`;
  exec(cmd);
}

installSkill();

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[tasker] Running at http://localhost:${PORT}`);
  console.log(`[tasker] Press Ctrl+C to stop.`);
  openBrowser(`http://localhost:${PORT}`);
});

process.on("SIGINT", () => { for (const res of clients) { try { res.end(); } catch {} } server.close(() => process.exit(0)); });
process.on("SIGTERM", () => { for (const res of clients) { try { res.end(); } catch {} } server.close(() => process.exit(0)); });
