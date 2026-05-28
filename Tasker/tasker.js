// tasker.js — Task queue manager for Claude Code agents
// Run: node tasker.js

"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");

// Derive a stable port from the project directory so each project gets its own server.
function projectPort(dir) {
  let h = 5381;
  for (let i = 0; i < dir.length; i++) h = ((h << 5) + h) ^ dir.charCodeAt(i);
  return 7843 + (Math.abs(h) % 2000);
}

const PORT = process.env.TASKER_PORT
  ? parseInt(process.env.TASKER_PORT)
  : projectPort(__dirname);
const HTML_FILE = path.join(__dirname, "tasker.html");
const STATE_FILE = path.join(__dirname, "tasks.json");
const PROJECT_NAME = path.basename(path.dirname(__dirname));

const DEFAULT_STATE = {
  tasks: [],
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
    return json(res, 200, { ok: true, paused: false });
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
    const settingsFile = path.join(__dirname, ".claude", "settings.json");
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
        const claudeDir = path.join(__dirname, ".claude");
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

  const portLine = `PORT=$(node Tasker/tasker.js port)`;

  // node-based server health check — works on Windows and Mac without curl
  const nodeCheck = `node -e "require('http').get('http://localhost:'+process.env.PORT+'/',r=>process.exit(0)).on('error',()=>process.exit(1))" PORT=$PORT 2>/dev/null`;

  const startBlock = `\`\`\`bash
${portLine}
${nodeCheck} || {
  nohup node Tasker/tasker.js serve > /dev/null 2>&1 &
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

  const resumeBlock = `\`\`\`bash
${portLine}
node -e "
const h=require('http'),r=h.request({hostname:'localhost',port:process.env.PORT,path:'/resume',method:'POST'},res=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>console.log(d))});
r.on('error',e=>console.log('err:',e.message));r.end();
" PORT=$PORT
\`\`\``;

  const queueSteps = `
## 2. Check the queue

Read \`./Tasker/tasks.json\`. Find all tasks with \`"status": "ready"\`.

If there are no ready tasks, skip to step 5.

## 3. Mark tasks in_progress

For each ready task, read the current \`./Tasker/tasks.json\` immediately before each POST (never use a stale copy), set that task's \`status\` to \`"in_progress"\`, and POST the full patched state to \`http://localhost:$PORT/state\`.

Use \`node -e\` to POST (do not use curl — it is not available in the Claude Code sandbox on Windows):

\`\`\`bash
node -e "
const http=require('http'),fs=require('fs');
const state=JSON.parse(fs.readFileSync('Tasker/tasks.json','utf8'));
// ... patch state.tasks[i].status = 'in_progress' ...
const body=JSON.stringify(state);
const req=http.request({hostname:'localhost',port:process.env.PORT,path:'/state',method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}},res=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>console.log(d))});
req.on('error',e=>console.log('err:',e.message));req.write(body);req.end();
" PORT=$PORT
\`\`\`

## 4. Spawn one Agent per task (in parallel if multiple)

For each task, call the **Agent tool** with:

- **description**: \`"[AgentName]: [task title]"\` — e.g. \`"Coder: Fix login bug"\`
- **prompt**: A self-contained brief that includes:
  - The agent's **role** (copy it verbatim from the \`agents\` array in \`./Tasker/tasks.json\`)
  - The task **title** and **description** (the agent's actual instructions)
  - Any user comments: activity entries with \`"type": "chat_user"\` from the task's \`activity\` array — include them verbatim under a **User comments** heading so the agent can address them
  - The working directory: the current working directory
  - What to return: a concise summary of what was done, including any files changed

The agent should do the real work using its tools (Read, Edit, Write, Bash, etc.).

If multiple tasks are ready, spawn all agents in a **single message** as parallel Agent tool calls.

## 5. Collect results and update state

When each agent finishes, inspect its result **before** updating state:

**If the agent returned an error containing "rate limit", "usage limit", "overloaded", or "capacity":**
- Reset the task's \`status\` back to \`"ready"\` in \`./Tasker/tasks.json\`
- POST to \`http://localhost:$PORT/pause-with-message\` using \`node -e\` with body \`{"message": "Paused: Claude usage limit hit while working on \\"<task title>\\". Resume when ready."}\`
- Stop immediately — do not update task state, do not call ScheduleWakeup.

**Otherwise (normal completion):**
- Read the current \`./Tasker/tasks.json\` again, then:
- Set the task's \`status\` to \`"in_review"\`
- Append to its \`activity\` array: \`{"timestamp": "<ISO timestamp>", "type": "output", "content": "<agent's summary>"}\`
- POST the full patched state to \`http://localhost:$PORT/state\` using \`node -e\``;

  const taskerContent = `---
description: Start the Tasker server, open the board, and start the scan loop
---

## 0. Bootstrap Tasker files if missing

\`\`\`bash
mkdir -p Tasker
cp "${sourceDir}/tasker.js" ./Tasker/tasker.js
cp "${sourceDir}/tasker.html" ./Tasker/tasker.html
cp "${sourceDir}/README.md" ./Tasker/README.md
\`\`\`

## 1. Start the server if needed

${startBlock}

## 2. Open the browser

\`\`\`bash
${portLine}
${openBrowserCmd}
\`\`\`

## 3. Start the scan loop

Invoke the \`/tasker-scan\` skill.
`;

  const scanContent = `---
description: Start the Tasker server if needed, then check the queue and execute ready tasks
---

You are the Tasker **team lead**. Your job is to manage the queue and delegate work to specialized sub-agents — not to do the work yourself.

## 1. Start the server if needed

${startBlock}

${resumeBlock}

${queueSteps}

## 6. Start the watch loop

Call ScheduleWakeup with \`delaySeconds=30\` and \`prompt="/tasker-watch"\`. The result text looks like \`"Next wakeup scheduled for ... (in 101s)"\`. Extract the seconds using \`/\\(in (\\d+)s\\)/\`, then POST:

\`\`\`bash
node -e "
const http=require('http');
const body=JSON.stringify({seconds: X});
const req=http.request({hostname:'localhost',port:process.env.PORT,path:'/next-scan',method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}},res=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>console.log(d))});
req.on('error',e=>console.log('err:',e.message));req.write(body);req.end();
" PORT=$PORT
\`\`\`

Replace X with the actual seconds extracted above. If you cannot parse the number, use 90.

---

**Important**: You are the coordinator. Never execute task work yourself — always delegate via Agent.`;

  const watchContent = `---
description: Check server state, then invoke /tasker-scan if server is running and not paused
---

## 1. Check pause state

\`\`\`bash
${portLine}
node -e "
const http=require('http');
http.get('http://localhost:'+process.env.PORT+'/paused',res=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>console.log(d))}).on('error',()=>{console.log('unreachable');process.exit(1)});
" PORT=$PORT
\`\`\`

- If the command **fails** (server unreachable) — stop immediately. Do not reschedule.
- If the response is \`{"paused":true}\` — stop immediately. Do not reschedule.
- If the response is \`{"paused":false}\` — proceed to step 2.

## 2. Run the next scan

Invoke the \`/tasker-scan\` skill.
`;

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

if (process.argv[2] === "port") {
  // NOTE: Do NOT call installSkills() here — `port` fires on every scan cycle
  // (PORT=$(node Tasker/tasker.js port)) and would overwrite skill files constantly.
  console.log(PORT);
  process.exit(0);
} else if (process.argv[2] === "serve") {
  installSkills();
  if (!appState) {
    appState = DEFAULT_STATE;
    fs.writeFileSync(STATE_FILE, JSON.stringify(appState, null, 2), "utf8");
  }
  server.listen(PORT, "127.0.0.1", () => {
    console.log(`[tasker] Running at http://localhost:${PORT}`);
    console.log(`[tasker] Press Ctrl+C to stop.`);
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
