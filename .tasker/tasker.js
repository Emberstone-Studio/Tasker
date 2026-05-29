// tasker.js — Task queue manager for Claude Code agents
// Run: node tasker.js

"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");

// Derive a stable port from the project directory so each project gets its own server.
// Normalize to forward slashes and strip Git-Bash-style /c/ drive prefix so the hash
// is the same whether invoked from Bash (/c/Users/...) or PowerShell (C:\Users\...).
function projectPort(dir) {
  const normalized = dir
    .replace(/\\/g, "/")
    .replace(/^\/([a-zA-Z])\//, (_, d) => d.toUpperCase() + ":/");
  let h = 5381;
  for (let i = 0; i < normalized.length; i++)
    h = ((h << 5) + h) ^ normalized.charCodeAt(i);
  return 7843 + (Math.abs(h) % 2000);
}

const PORT = process.env.TASKER_PORT
  ? parseInt(process.env.TASKER_PORT)
  : projectPort(__dirname);
const HTML_FILE = path.join(__dirname, "tasker.html");
const STATE_FILE = path.join(__dirname, "tasks.json");
const PROJECT_DIR = path.dirname(__dirname);
const PROJECT_NAME = path.basename(PROJECT_DIR);

const DEFAULT_STATE = {
  tasks: [],
  scanInterval: 60,
  agents: [
    {
      id: "agent-researcher-default",
      name: "Researcher",
      role: "You are a research agent. Your job is to find information, audit codebases, summarize findings, and answer questions with cited sources. Be thorough and precise. Prefer facts over speculation.",
      color: "#3b82f6",
    },
    {
      id: "agent-coder-default",
      name: "Coder",
      role: "You are a coding agent. Your job is to write, edit, debug, and explain code. Produce clean, working code with no unnecessary comments. Follow the existing conventions in the codebase.",
      color: "#10b981",
    },
    {
      id: "agent-reviewer-default",
      name: "Reviewer",
      role: "You are a review agent. Your job is to review output from other agents, flag issues, identify improvements, and provide actionable feedback. Be direct and specific.",
      color: "#f59e0b",
    },
    {
      id: "agent-writer-default",
      name: "Writer",
      role: "You are a writing agent. Your job is to write documentation, copy, summaries, and prose. Match the existing tone and style. Be clear and concise.",
      color: "#8b5cf6",
    },
  ],
  logs: [],
};

// ─── Claude binary resolution ─────────────────────────────────────

const { execSync } = require("child_process");
let CLAUDE_BIN = process.env.CLAUDE_BIN || null;
let CLAUDE_SHELL = false;

if (!CLAUDE_BIN) {
  if (process.platform === "win32") {
    // On Windows, find claude.cmd then derive the native claude.exe so we can
    // spawn it directly without shell:true — avoids cmd.exe splitting args on
    // newlines or special characters in the system prompt / message.
    try {
      const cmdPath = execSync("where.exe claude.cmd", { encoding: "utf8" })
        .split(/\r?\n/)[0]
        .trim();
      const exePath = path.join(
        path.dirname(cmdPath),
        "node_modules",
        "@anthropic-ai",
        "claude-code",
        "bin",
        "claude.exe"
      );
      if (fs.existsSync(exePath)) {
        CLAUDE_BIN = exePath;
      } else {
        CLAUDE_BIN = cmdPath;
        CLAUDE_SHELL = true;
      }
    } catch {
      CLAUDE_BIN = "claude.cmd";
      CLAUDE_SHELL = true;
    }
  } else {
    // Mac/Linux: augment PATH for non-login shells (nvm, volta, homebrew).
    const home = os.homedir();
    const extraPaths = [
      `${home}/.volta/bin`,
      `/opt/homebrew/bin`,
      `/usr/local/bin`,
      `${home}/.local/bin`,
    ];
    try {
      const nvmDir = process.env.NVM_DIR || `${home}/.nvm`;
      const alias = fs.readFileSync(`${nvmDir}/alias/default`, "utf8").trim();
      extraPaths.unshift(`${nvmDir}/versions/node/${alias}/bin`);
    } catch {}
    process.env.PATH = [...extraPaths, process.env.PATH || ""].join(":");
    try {
      CLAUDE_BIN = execSync("which claude", { shell: true, encoding: "utf8" })
        .trim()
        .split(/\r?\n/)[0];
    } catch {
      CLAUDE_BIN = null;
    }
  }
}

// ─── State ────────────────────────────────────────────────────────

let appState = null;
let paused = false;
let lastHeartbeat = null;
try {
  appState = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
} catch {}

// ─── SSE ─────────────────────────────────────────────────────────

const clients = new Set();

function broadcast(event) {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of clients) {
    try {
      res.write(data);
    } catch {
      clients.delete(res);
    }
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
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS);
    res.end();
    return;
  }

  if (req.method === "GET" && req.url === "/") {
    try {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(fs.readFileSync(HTML_FILE, "utf8"));
    } catch {
      res.writeHead(404);
      res.end("tasker.html not found in " + __dirname);
    }
    return;
  }

  if (req.method === "GET" && req.url === "/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      ...CORS,
    });
    res.write(
      `data: ${JSON.stringify({ type: "connected", state: appState, paused, lastHeartbeat, projectName: PROJECT_NAME })}\n\n`,
    );
    clients.add(res);
    const hb = setInterval(() => {
      try {
        res.write(": ping\n\n");
      } catch {
        clearInterval(hb);
        clients.delete(res);
      }
    }, 25000);
    req.on("close", () => {
      clearInterval(hb);
      clients.delete(res);
    });
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
        const prevInterval = appState && appState.scanInterval;
        appState = JSON.parse(raw);
        fs.writeFileSync(STATE_FILE, raw, "utf8");
        broadcast({ type: "state_sync", state: appState });
        if (appState.scanInterval !== prevInterval) scheduleScan();
        json(res, 200, { ok: true });
      } catch (err) {
        json(res, 400, { error: err.message });
      }
    });
    return;
  }

  if (req.method === "POST" && req.url === "/pause") {
    paused = true;
    if (scanTimer) { clearTimeout(scanTimer); scanTimer = null; }
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
      broadcast({
        type: "usage_cap",
        message: message || "Usage limit reached.",
      });
      json(res, 200, { ok: true, paused: true });
    });
    return;
  }

  if (req.method === "POST" && req.url === "/resume") {
    paused = false;
    broadcast({ type: "tasker_state", paused: false });
    scheduleScan();
    return json(res, 200, { ok: true, paused: false });
  }

  if (req.method === "POST" && req.url === "/trigger-scan") {
    const found = appState ? appState.tasks.filter((t) => t.status === "ready").length : 0;
    runScan();
    if (!paused) scheduleScan();
    return json(res, 200, { ok: true, found });
  }

  if (req.method === "POST" && req.url === "/claim-ready") {
    if (!appState) return json(res, 200, { tasks: [], agents: [] });
    paused = false;
    broadcast({ type: "tasker_state", paused: false });
    const now = new Date().toISOString();
    const claimed = appState.tasks.filter((t) => t.status === "ready");
    if (claimed.length === 0)
      return json(res, 200, { tasks: [], agents: appState.agents });
    claimed.forEach((t) => {
      t.status = "in_progress";
      t.updated_at = now;
      (t.activity = t.activity || []).push({
        timestamp: now,
        type: "moved",
        content: "In progress",
      });
    });
    const saved = JSON.stringify(appState, null, 2);
    fs.writeFileSync(STATE_FILE, saved, "utf8");
    broadcast({ type: "state_sync", state: appState });
    return json(res, 200, { tasks: claimed, agents: appState.agents });
  }

  if (req.method === "GET" && req.url === "/paused") {
    if (!paused) {
      lastHeartbeat = Date.now();
      broadcast({ type: "scan_heartbeat", lastHeartbeat });
    }
    return json(res, 200, { paused });
  }

  if (req.method === "POST" && req.url === "/next-scan") {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      let parsed;
      try {
        parsed = JSON.parse(body || "{}");
      } catch {
        return json(res, 400, { error: "invalid JSON" });
      }
      const seconds = Number(parsed.seconds);
      if (!Number.isFinite(seconds) || seconds <= 0)
        return json(res, 400, { error: "seconds must be a positive number" });
      broadcast({ type: "next_scan", seconds });
      return json(res, 200, { ok: true });
    });
    return;
  }

  if (req.method === "POST" && req.url === "/shutdown") {
    json(res, 200, { ok: true });
    broadcast({ type: "shutdown" });
    setTimeout(() => {
      for (const r of clients) {
        try {
          r.end();
        } catch {}
      }
      server.close(() => process.exit(0));
    }, 200);
    return;
  }

  if (req.method === "GET" && req.url === "/permissions") {
    const settingsFile = path.join(__dirname, "..", ".claude", "settings.json");
    try {
      const data = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
      return json(res, 200, {
        allow: (data.permissions && data.permissions.allow) || [],
      });
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
        const claudeDir = path.join(__dirname, "..", ".claude");
        fs.mkdirSync(claudeDir, { recursive: true });
        const settingsFile = path.join(claudeDir, "settings.json");
        const settings = { permissions: { allow: body.allow || [] } };
        fs.writeFileSync(
          settingsFile,
          JSON.stringify(settings, null, 2),
          "utf8",
        );
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
      try {
        body = JSON.parse(raw);
      } catch {
        return json(res, 400, { error: "invalid JSON" });
      }

      const message = (body.message || "").trim();
      if (!message) return json(res, 400, { error: "message is required" });
      const session_id = body.session_id || null;

      const tasks =
        ((appState && appState.tasks) || [])
          .map((t) => `[${t.status}] ${t.title}`)
          .join(", ") || "(no tasks)";
      const agents =
        ((appState && appState.agents) || []).map((a) => a.name).join(", ") ||
        "(none)";

      // Keep system prompt on one line — newlines break cmd.exe arg parsing on Windows.
      const systemPrompt =
        `You are a helpful assistant embedded in Tasker, a Claude Code task management board. ` +
        `You have full tool access and can act on the board by calling the Tasker REST API at http://localhost:${PORT}. ` +
        `Current board state: ${tasks}. ` +
        `Agents available: ${agents}. ` +
        `To update the board, POST to http://localhost:${PORT}/state with the full updated state JSON.`;

      // Sanitize message: newlines in args also break cmd.exe on Windows.
      const safeMessage = message.replace(/[\r\n]+/g, " ");

      const args = [
        "--print",
        "--output-format",
        "stream-json",
        "--verbose",
        "--system-prompt",
        systemPrompt,
      ];
      if (session_id) args.push("--resume", session_id);
      args.push(safeMessage);

      if (!CLAUDE_BIN) {
        return json(res, 503, {
          error:
            "Claude CLI not found. Install it with: npm install -g @anthropic-ai/claude-code",
        });
      }

      const child = spawn(CLAUDE_BIN, args, {
        stdio: ["ignore", "pipe", "pipe"],
        shell: CLAUDE_SHELL,
      });

      let stdout = "";
      let stderr = "";
      let replied = false;

      const CHAT_TIMEOUT_MS = 120_000;
      const killTimer = setTimeout(() => {
        if (replied) return;
        replied = true;
        child.kill();
        json(res, 504, { error: "Claude did not respond within 2 minutes." });
      }, CHAT_TIMEOUT_MS);

      child.stdout.on("data", (d) => {
        stdout += d;
      });
      child.stderr.on("data", (d) => {
        stderr += d;
      });

      child.on("error", (err) => {
        if (replied) return;
        replied = true;
        json(res, 500, { error: `Failed to spawn claude: ${err.message}` });
      });

      child.on("close", (code) => {
        clearTimeout(killTimer);
        if (replied) return;
        replied = true;
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
          return json(res, 500, {
            error: stderr.trim() || `claude exited with code ${code}`,
          });
        }
        json(res, 200, { reply, session_id: newSessionId });
      });
    });
    return;
  }

  json(res, 404, { error: "Not found" });
});

// ─── Claude Code skill installer ─────────────────────────────────
//
// Skills use node -e for all HTTP calls instead of curl — curl is not
// reliably available in the Claude Code sandbox on Windows.
// installSkills() is called on `serve` and initial setup only — NOT on
// `port`, which fires on every scan cycle and would otherwise overwrite
// skill files constantly.

function installSkills() {
  const commandsDir = path.join(os.homedir(), ".claude", "commands");
  const sourceDir = __dirname.replace(/\\/g, "/");

  const portLine = `PORT=$(node .tasker/tasker.js port)\nexport PORT`;

  // node-based server health check — works on Windows and Mac without curl
  const nodeCheck = `node -e "require('http').get('http://localhost:'+process.env.PORT+'/',r=>process.exit(0)).on('error',()=>process.exit(1))" PORT=$PORT 2>/dev/null`;

  const startBlock = `\`\`\`bash
${portLine}
${nodeCheck} || {
  nohup node .tasker/tasker.js serve > /dev/null 2>&1 &
  for i in 1 2 3 4 5 6 7 8 9 10; do
    sleep 1
    ${nodeCheck} && break
  done
}
\`\`\``;

  const openBrowserCmd =
    process.platform === "win32"
      ? `start "" "http://localhost:$PORT"`
      : process.platform === "darwin"
        ? `open "http://localhost:$PORT"`
        : `xdg-open "http://localhost:$PORT"`;

  const startAndClaimBlock = `\`\`\`bash
${portLine}
${nodeCheck} || {
  nohup node .tasker/tasker.js serve > /dev/null 2>&1 &
  for i in 1 2 3 4 5 6 7 8 9 10; do
    sleep 1
    ${nodeCheck} && break
  done
}
CLAIMED=$(node -e "
const http=require('http');
const b='{}';
const req=http.request({hostname:'localhost',port:process.env.PORT,path:'/claim-ready',method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(b)}},res=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>process.stdout.write(d))});
req.on('error',e=>process.stdout.write(JSON.stringify({error:e.message,tasks:[],agents:[]})));
req.write(b);req.end();
" PORT=$PORT)
echo "$CLAIMED"
\`\`\``;

  const taskerContent = `---
description: Start the Tasker server, open the board, and start the scan loop
---

Output exactly: \`Bootstrapping\`

\`\`\`bash
mkdir -p .tasker
cp "${sourceDir}/tasker.js" ./.tasker/tasker.js 2>/dev/null || true
cp "${sourceDir}/tasker.html" ./.tasker/tasker.html 2>/dev/null || true
cp "${sourceDir}/README.md" ./.tasker/README.md 2>/dev/null || true
\`\`\`

Output exactly: \`Starting server and opening task board\`

${startBlock}

\`\`\`bash
${portLine}
${openBrowserCmd}
\`\`\`

Output exactly: \`Scanning for tasks\`

${startAndClaimBlock}

Parse the JSON from CLAIMED. If \`tasks\` is non-empty, spawn agents per the rules in /tasker-scan (pipeline/auto-delegate logic, parallel, update state on completion). The server scan loop runs automatically — no further output.
`;

  const scanContent = `---
description: Start the Tasker server if needed, then check the queue and execute ready tasks
---

Do not output any text to the user. Execute silently.

You are the Tasker **team lead**. Your job is to manage the queue and delegate work to specialized sub-agents — not to do the work yourself.

## 1. Start server and claim ready tasks

${startAndClaimBlock}

This also resumes the server if paused. Parse the JSON printed to stdout — it has shape \`{ tasks: [...], agents: [...] }\`:
- \`tasks\`: tasks that were ready and are now \`in_progress\`
- \`agents\`: the full agents array (use these for agent roles)

If \`tasks\` is empty, skip to step 3.

## 2. Spawn one Agent per task (in parallel if multiple)

For each task, call the **Agent tool** with:

- **description**: \`"[AgentName]: [task title]"\` — e.g. \`"Coder: Fix login bug"\`
- **prompt**: A self-contained brief that includes:
  - The agent's **role** (copy it verbatim from the \`agents\` array returned above)
  - The task **title** and **description** (the agent's actual instructions)
  - Any user comments: activity entries with \`"type": "chat_user"\` from the task's \`activity\` array — include them verbatim under a **User comments** heading
  - The working directory: the current working directory
  - What to return: a concise summary of what was done, including any files changed

For pipeline tasks use \`pipeline[pipeline_step]\` as the effective agent_id. For \`agent_id: null\`, pick the best agent based on task content (writing/docs → Writer, reviewing/auditing → Reviewer, research → Researcher, default → Coder).

If multiple tasks are ready, spawn all agents in a **single message** as parallel Agent tool calls.

When each agent finishes, inspect its result **before** updating state:

**If the agent returned an error containing "rate limit", "usage limit", "overloaded", or "capacity":**
- Reset the task's \`status\` back to \`"ready"\` in \`./.tasker/tasks.json\`
- POST to \`http://localhost:$PORT/pause-with-message\` using \`node -e\` with body \`{"message": "Paused: Claude usage limit hit while working on \\"<task title>\\". Resume when ready."}\`
- Stop immediately — do not update task state, do not call ScheduleWakeup.

**Otherwise (normal completion):**
- Read the current \`./.tasker/tasks.json\`, then set the task's \`status\` to \`"in_review"\` and append to its \`activity\` array: \`{"timestamp": "<ISO timestamp>", "type": "output", "content": "<agent's summary>"}\`
- POST the full patched state to \`http://localhost:$PORT/state\` using \`node -e\`

The server scan loop restarts automatically — no ScheduleWakeup needed.

---

**Important**: You are the coordinator. Never execute task work yourself — always delegate via Agent.`;

  const pauseContent = `---
description: Pause the Tasker scan loop
---

\`\`\`bash
${portLine}
node -e "
const h=require('http'),r=h.request({hostname:'localhost',port:process.env.PORT,path:'/pause',method:'POST'},res=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>console.log(d))});
r.on('error',e=>console.log('err:',e.message));r.end();
" PORT=$PORT
\`\`\`

Then stop — do not reschedule.
`;

  const stopContent = `---
description: Stop the Tasker server
---

\`\`\`bash
${portLine}
node -e "
const h=require('http'),r=h.request({hostname:'localhost',port:process.env.PORT,path:'/shutdown',method:'POST'},res=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>console.log(d))});
r.on('error',e=>console.log('err:',e.message));r.end();
" PORT=$PORT
\`\`\`
`;

  try {
    fs.mkdirSync(commandsDir, { recursive: true });
    fs.writeFileSync(path.join(commandsDir, "tasker.md"), taskerContent, "utf8");
    console.log(`[tasker] Skill installed: /tasker`);
    fs.writeFileSync(path.join(commandsDir, "tasker-scan.md"), scanContent, "utf8");
    console.log(`[tasker] Skill installed: /tasker-scan`);
    fs.writeFileSync(path.join(commandsDir, "tasker-pause.md"), pauseContent, "utf8");
    console.log(`[tasker] Skill installed: /tasker-pause`);
    fs.writeFileSync(path.join(commandsDir, "tasker-stop.md"), stopContent, "utf8");
    console.log(`[tasker] Skill installed: /tasker-stop`);
  } catch (err) {
    console.warn(`[tasker] Could not install skills: ${err.message}`);
  }

}

// ─── Server-side scan loop ────────────────────────────────────────

let scanTimer = null;

function buildScanPrompt() {
  const stateFile = STATE_FILE.replace(/\\/g, "/");
  const projectDir = PROJECT_DIR.replace(/\\/g, "/");
  const prompt =
    `You are a Tasker scan agent. Do not output anything to the user.\n` +
    `Project: ${projectDir} | Port: ${PORT}\n\n` +
    `1. POST {} to http://localhost:${PORT}/claim-ready using node -e. ` +
    `Parse response {tasks,agents}. If tasks is empty, stop.\n` +
    `2. For each task call the Agent tool (parallel if multiple). ` +
    `description="[AgentName]: [title]". ` +
    `Effective agent: use pipeline[pipeline_step] if pipeline exists; ` +
    `auto-pick if agent_id null (writing/docs->Writer, reviewing->Reviewer, research->Researcher, else Coder); ` +
    `else use agent_id. ` +
    `Prompt must include: agent role verbatim, task title+description, ` +
    `chat_user activity entries as User comments, cwd ${projectDir}, return a concise summary.\n` +
    `3. After all agents complete: if any error contains "rate limit"/"usage limit"/"overloaded"/"capacity", ` +
    `reset that task's status to "ready" in ${stateFile}, ` +
    `POST {"message":"Paused: usage limit hit on \\"[title]\\""} to http://localhost:${PORT}/pause-with-message, stop. ` +
    `Otherwise: read ${stateFile}, set status "in_review", ` +
    `append {"timestamp":"<ISO>","type":"output","content":"<summary>"} to activity, ` +
    `POST full state to http://localhost:${PORT}/state. All HTTP via node -e.`;
  return CLAUDE_SHELL ? prompt.replace(/[\r\n]+/g, " ") : prompt;
}

function runScan() {
  if (paused || !appState || !CLAUDE_BIN) return;
  if (!appState.tasks.some((t) => t.status === "ready")) return;
  lastHeartbeat = Date.now();
  broadcast({ type: "scan_heartbeat", lastHeartbeat });
  const child = spawn(CLAUDE_BIN, ["--print", "-p", buildScanPrompt()], {
    cwd: PROJECT_DIR,
    shell: CLAUDE_SHELL,
    stdio: "ignore",
  });
  child.on("error", (err) =>
    console.error("[tasker] scan error:", err.message)
  );
}

function scheduleScan() {
  if (scanTimer) clearTimeout(scanTimer);
  const secs = (appState && appState.scanInterval) || 60;
  broadcast({ type: "next_scan", seconds: secs });
  scanTimer = setTimeout(() => {
    runScan();
    scheduleScan();
  }, secs * 1000);
}

// ─── Start ────────────────────────────────────────────────────────

if (process.argv[2] === "port") {
  // NOTE: Do NOT call installSkills() here — `port` fires on every scan cycle
  // (PORT=$(node .tasker/tasker.js port)) and would overwrite skill files constantly.
  console.log(PORT);
  process.exit(0);
} else if (process.argv[2] === "serve") {
  installSkills();
  if (!appState) {
    appState = DEFAULT_STATE;
  } else if (!appState.scanInterval) {
    appState.scanInterval = 60;
  }
  fs.writeFileSync(STATE_FILE, JSON.stringify(appState, null, 2), "utf8");
  server.listen(PORT, "127.0.0.1", () => {
    console.log(`[tasker] Running at http://localhost:${PORT}`);
    console.log(`[tasker] Press Ctrl+C to stop.`);
    scheduleScan();
  });
  process.on("SIGINT", () => {
    for (const res of clients) {
      try {
        res.end();
      } catch {}
    }
    server.close(() => process.exit(0));
  });
  process.on("SIGTERM", () => {
    for (const res of clients) {
      try {
        res.end();
      } catch {}
    }
    server.close(() => process.exit(0));
  });
} else {
  installSkills();
  console.log(`\nNext steps:`);
  console.log(
    `  1. Reload VS Code — open the command palette and run "Reload Window"`,
  );
  console.log(`  2. Run /tasker in Claude Code\n`);
}
