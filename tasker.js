// tasker.js - Agent Task Manager
// HTTP server + SSE. No npm install required — Node.js built-ins only.
// Run: node tasker.js

"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const PORT = 7842;
const DEFAULT_WORKDIR = __dirname;

// ─────────────────────────────────────────────────────────────────
// SSE client registry
// ─────────────────────────────────────────────────────────────────

const clients = new Set()
let paused = false;

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

// ─────────────────────────────────────────────────────────────────
// HTTP helpers
// ─────────────────────────────────────────────────────────────────

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json", ...CORS });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

// ─────────────────────────────────────────────────────────────────
// Action format injected into every agent's system prompt
// ─────────────────────────────────────────────────────────────────

const ACTION_INSTRUCTIONS = `You are running inside Tasker, an agentic task runner. You have full ability to create files and run shell commands on the user's machine. The system will execute your instructions automatically.

CRITICAL: When asked to create a file, you MUST use the <file> block below. Do NOT say you cannot create files. Do NOT tell the user to copy and paste. Just output the block and the system handles the rest.

To create or write a file:
<file path="relative/path/filename.ext">
file content here
</file>

To run a shell command:
<shell>
command here
</shell>

Rules:
- Paths are relative to the working directory
- Multiple <file> and <shell> blocks are allowed in one response
- Shell blocks run in order; they can reference files you just created
- Briefly explain what you are doing, then output the blocks, then confirm what was done
`;

function buildSystemPrompt(agentRole) {
  return ACTION_INSTRUCTIONS + "\n\n" + (agentRole || "").trim();
}

// ─────────────────────────────────────────────────────────────────
// Action parsing
// ─────────────────────────────────────────────────────────────────

function parseActions(text) {
  const actions = [];

  const fileRe = /<file\s+path="([^"]+)">([\s\S]*?)<\/file>/g;
  let m;
  while ((m = fileRe.exec(text)) !== null) {
    actions.push({ type: "file", path: m[1], content: m[2], index: m.index });
  }

  const shellRe = /<shell>([\s\S]*?)<\/shell>/g;
  while ((m = shellRe.exec(text)) !== null) {
    actions.push({ type: "shell", command: m[1].trim(), index: m.index });
  }

  // Execute in document order
  actions.sort((a, b) => a.index - b.index);
  return actions;
}

// ─────────────────────────────────────────────────────────────────
// Action execution
// ─────────────────────────────────────────────────────────────────

function resolveWorkdir(workdir) {
  if (!workdir) return DEFAULT_WORKDIR;
  return path.isAbsolute(workdir)
    ? workdir
    : path.resolve(DEFAULT_WORKDIR, workdir);
}

function safeResolvePath(filePath, workdir) {
  const resolved = path.resolve(workdir, filePath);
  if (!resolved.startsWith(path.resolve(workdir))) {
    throw new Error(`Path traversal denied: ${filePath}`);
  }
  return resolved;
}

function executeActions(actions, workdir) {
  const results = [];
  const wd = resolveWorkdir(workdir);

  for (const action of actions) {
    if (action.type === "file") {
      try {
        const fullPath = safeResolvePath(action.path, wd);
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(fullPath, action.content);
        const msg = `Created file: ${action.path}`;
        console.log(`[tasker]   ✓ ${msg}`);
        results.push({
          ok: true,
          type: "file",
          path: action.path,
          message: msg,
        });
      } catch (err) {
        const msg = `Failed to write ${action.path}: ${err.message}`;
        console.error(`[tasker]   ✗ ${msg}`);
        results.push({
          ok: false,
          type: "file",
          path: action.path,
          message: msg,
        });
      }
    } else if (action.type === "shell") {
      try {
        const output = execSync(action.command, {
          cwd: wd,
          timeout: 30000,
          encoding: "utf8",
          stdio: ["pipe", "pipe", "pipe"],
        });
        const msg = `Ran: ${action.command}\n${output.trim()}`;
        console.log(`[tasker]   ✓ ${msg}`);
        results.push({
          ok: true,
          type: "shell",
          command: action.command,
          message: msg,
        });
      } catch (err) {
        const msg = `Command failed: ${action.command}\n${(err.stderr || err.message || "").trim()}`;
        console.error(`[tasker]   ✗ ${msg}`);
        results.push({
          ok: false,
          type: "shell",
          command: action.command,
          message: msg,
        });
      }
    }
  }

  return results;
}

// ─────────────────────────────────────────────────────────────────
// API call helper — native fetch (Node 18+), 120s timeout, 1 retry
// ─────────────────────────────────────────────────────────────────

async function callAPI(endpoint, headers, body, timeoutMs = 120000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 400)}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function callModelWithMessages(model, agent, messages, temperature = 0.7, retry = true) {
  if (!model) throw new Error('No model configured.')
  const provider = (model.provider || '').toLowerCase()
  const systemPrompt = buildSystemPrompt(agent.role)

  try {
    if (provider === 'anthropic') {
      if (!model.api_key) throw new Error('Anthropic API key not set. Add it in Settings.')
      const data = await callAPI(
        model.endpoint || 'https://api.anthropic.com/v1/messages',
        { 'x-api-key': model.api_key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        { model: model.model_string, max_tokens: 8096, system: systemPrompt, messages, temperature }
      )
      return data.content?.[0]?.text ?? JSON.stringify(data)
    } else if (provider === 'openai' || provider === 'custom') {
      if (!model.api_key && provider === 'openai') throw new Error('OpenAI API key not set. Add it in Settings.')
      const headers = { 'content-type': 'application/json' }
      if (model.api_key) headers['Authorization'] = `Bearer ${model.api_key}`
      const data = await callAPI(
        model.endpoint || 'https://api.openai.com/v1/chat/completions',
        headers,
        { model: model.model_string, messages: [{ role: 'system', content: systemPrompt }, ...messages], temperature, max_tokens: 8096 }
      )
      return data.choices?.[0]?.message?.content ?? JSON.stringify(data)
    } else if (provider === 'ollama') {
      const data = await callAPI(
        model.endpoint || 'http://localhost:11434/api/chat',
        { 'content-type': 'application/json' },
        { model: model.model_string, messages: [{ role: 'system', content: systemPrompt }, ...messages], stream: false }
      )
      return data.message?.content ?? JSON.stringify(data)
    } else {
      throw new Error(`Unknown provider "${model.provider}". Use anthropic, openai, ollama, or custom.`)
    }
  } catch (err) {
    if (err.name === 'AbortError' && retry) return callModelWithMessages(model, agent, messages, temperature, false)
    throw err
  }
}

async function callModel(model, agent, task, retry = true) {
  if (!model) throw new Error("No model configured for this task.");
  const provider = (model.provider || "").toLowerCase();
  const prompt = task.description || "";
  const temperature =
    typeof task.temperature === "number" ? task.temperature : 0.7;
  const systemPrompt = buildSystemPrompt(agent.role);

  try {
    if (provider === "anthropic") {
      if (!model.api_key)
        throw new Error("Anthropic API key not set. Add it in Settings.");
      const data = await callAPI(
        model.endpoint || "https://api.anthropic.com/v1/messages",
        {
          "x-api-key": model.api_key,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        {
          model: model.model_string,
          max_tokens: 8096,
          system: systemPrompt,
          messages: [{ role: "user", content: prompt }],
          temperature,
        },
      );
      return data.content?.[0]?.text ?? JSON.stringify(data);
    } else if (provider === "openai" || provider === "custom") {
      if (!model.api_key && provider === "openai")
        throw new Error("OpenAI API key not set. Add it in Settings.");
      const headers = { "content-type": "application/json" };
      if (model.api_key) headers["Authorization"] = `Bearer ${model.api_key}`;
      const data = await callAPI(
        model.endpoint || "https://api.openai.com/v1/chat/completions",
        headers,
        {
          model: model.model_string,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: prompt },
          ],
          temperature,
          max_tokens: 8096,
        },
      );
      return data.choices?.[0]?.message?.content ?? JSON.stringify(data);
    } else if (provider === "ollama") {
      const data = await callAPI(
        model.endpoint || "http://localhost:11434/api/chat",
        { "content-type": "application/json" },
        {
          model: model.model_string,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: prompt },
          ],
          stream: false,
        },
      );
      return data.message?.content ?? JSON.stringify(data);
    } else {
      throw new Error(
        `Unknown provider "${model.provider}". Use anthropic, openai, ollama, or custom.`,
      );
    }
  } catch (err) {
    if (err.name === "AbortError" && retry) {
      console.log("[tasker] Timeout — retrying once...");
      return callModel(model, agent, task, false);
    }
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────────
// Handoff detection
// ─────────────────────────────────────────────────────────────────

function detectHandoffs(text, agents) {
  const mentions = [
    ...new Set(
      (text.match(/@[\w-]+/g) || []).map((m) => m.slice(1).toLowerCase()),
    ),
  ];
  return mentions
    .map((mention) =>
      agents.find((a) => a.name.toLowerCase().includes(mention)),
    )
    .filter(Boolean);
}

function makeHandoffTask(originalTask, originalAgent, targetAgent, output) {
  return {
    id: `task-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    title: `↳ ${originalTask.title} (handoff)`,
    description: `Handoff from ${originalAgent.name}:\n\n${output}`,
    agent_id: targetAgent.id,
    model_id: targetAgent.default_model_id || originalTask.model_id,
    temperature: targetAgent.default_temperature ?? 0.5,
    priority: originalTask.priority || "medium",
    status: "ready",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    activity: [
      {
        timestamp: new Date().toISOString(),
        type: "created",
        content: `Auto-created via handoff from "${originalTask.title}"`,
      },
      {
        timestamp: new Date().toISOString(),
        type: "handoff",
        content: `Handed off by ${originalAgent.name}`,
      },
    ],
  };
}

// ─────────────────────────────────────────────────────────────────
// Browser launcher
// ─────────────────────────────────────────────────────────────────

const { exec } = require('child_process')

function openBrowser(url) {
  const cmd = process.platform === 'win32' ? `start "" "${url}"` :
              process.platform === 'darwin' ? `open "${url}"` :
              `xdg-open "${url}"`
  exec(cmd)
}

// ─────────────────────────────────────────────────────────────────
// HTTP server
// ─────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS);
    res.end();
    return;
  }

  if (req.method === 'GET' && req.url === '/') {
    try {
      const html = fs.readFileSync(path.join(__dirname, 'TASKS.html'), 'utf8')
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(html)
    } catch {
      res.writeHead(404)
      res.end('TASKS.html not found in ' + __dirname)
    }
    return
  }

  if (req.method === "GET" && req.url === "/health") {
    return json(res, 200, { ok: true, workdir: DEFAULT_WORKDIR });
  }

  if (req.method === "GET" && req.url === "/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      ...CORS,
    });
    res.write(`data: ${JSON.stringify({ type: "connected", paused })}\n\n`);
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

  if (req.method === "POST" && req.url === "/execute") {
    let payload;
    try {
      payload = await readBody(req);
    } catch {
      return json(res, 400, { error: "Invalid JSON" });
    }
    const { task, agent, model, agents, workdir } = payload;
    if (!task || !agent || !model) {
      return json(res, 400, { error: "Missing task, agent, or model" });
    }
    if (paused) {
      return json(res, 503, { error: "Tasker is paused. Resume it from the UI first." });
    }

    json(res, 202, { ok: true, task_id: task.id });
    (async () => {
      const ts = () => new Date().toISOString();
      const taskUpdate = (status, activity) =>
        broadcast({
          type: "task_update",
          task_id: task.id,
          status,
          timestamp: ts(),
          activity,
        });
      const logMsg = (msg) =>
        broadcast({ type: "log", task_id: task.id, message: msg });
      const taskProgress = (progress) =>
        broadcast({ type: "task_progress", task_id: task.id, progress, timestamp: ts() });

      console.log(
        `[tasker] Executing: "${task.title}" → ${agent.name} via ${model.name}`,
      );
      logMsg(`Executing "${task.title}" with ${agent.name} via ${model.name}`);
      taskProgress(5);

      let output;
      try {
        output = await callModel(model, agent, task);
      } catch (err) {
        console.error(`[tasker] Error on "${task.title}":`, err.message);
        taskUpdate("ready", {
          timestamp: ts(),
          type: "output",
          content: `Error: ${err.message}`,
        });
        logMsg(`Failed: "${task.title}" — ${err.message}`);
        return;
      }
      taskProgress(70);

      // Execute any actions in the response
      const actions = parseActions(output);
      let actionSummary = "";
      if (actions.length > 0) {
        console.log(
          `[tasker] Executing ${actions.length} action(s) for "${task.title}"`,
        );
        const results = executeActions(actions, workdir);
        const lines = results.map((r) => `${r.ok ? "✓" : "✗"} ${r.message}`);
        actionSummary = "\n\n── Actions ──\n" + lines.join("\n");
        taskUpdate("in_progress", {
          timestamp: ts(),
          type: "actions",
          content: lines.join("\n"),
        });
        taskProgress(95);
      }

      taskUpdate("in_review", {
        timestamp: ts(),
        type: "output",
        content: output + actionSummary,
      });
      broadcast({
        type: "task_update",
        task_id: task.id,
        status: "in_review",
        timestamp: ts(),
        activity: {
          timestamp: ts(),
          type: "moved",
          content: "Moved to In Review",
        },
      });
      logMsg(`Complete: "${task.title}" moved to In Review`);
      console.log(
        `[tasker] Complete: "${task.title}" moved to In Review`,
      );

      // Handoff detection
      const allAgents = Array.isArray(agents) ? agents : [];
      const combined = (task.description || "") + "\n" + output;
      const targets = detectHandoffs(
        combined,
        allAgents.filter((a) => a.id !== agent.id),
      );
      for (const target of targets) {
        const newTask = makeHandoffTask(task, agent, target, output);
        broadcast({ type: "new_task", task: newTask });
        taskUpdate("in_review", {
          timestamp: ts(),
          type: "handoff",
          content: `Handed off to ${target.name}`,
        });
        logMsg(`Handoff: "${task.title}" → ${target.name}`);
        console.log(`[tasker] Handoff: "${task.title}" → ${target.name}`);
      }
    })();
    return;
  }

  if (req.method === 'POST' && req.url === '/pause') {
    paused = true
    broadcast({ type: 'tasker_state', paused: true })
    return json(res, 200, { ok: true, paused: true })
  }

  if (req.method === 'POST' && req.url === '/resume') {
    paused = false
    broadcast({ type: 'tasker_state', paused: false })
    return json(res, 200, { ok: true, paused: false })
  }

  if (req.method === 'POST' && req.url === '/stop') {
    json(res, 200, { ok: true })
    setTimeout(() => {
      console.log('[tasker] Stopped via UI.')
      process.exit(0)
    }, 100)
    return
  }

  if (req.method === 'POST' && req.url === '/chat') {
    let payload
    try { payload = await readBody(req) } catch {
      return json(res, 400, { error: 'Invalid JSON' })
    }
    const { task_id, task, agent, model, workdir } = payload
    if (!task_id || !task || !agent || !model) {
      return json(res, 400, { error: 'Missing task_id, task, agent, or model' })
    }

    json(res, 202, { ok: true })

    ;(async () => {
      const ts = () => new Date().toISOString()

      // Build conversation from activity — interleave user/assistant messages
      const relevant = (task.activity || [])
        .filter(a => a.type === 'output' || a.type === 'chat_user' || a.type === 'chat_agent')
        .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp))

      const messages = [{ role: 'user', content: task.description || '' }]
      for (const a of relevant) {
        const role = (a.type === 'chat_user') ? 'user' : 'assistant'
        const last = messages[messages.length - 1]
        if (last && last.role === role) {
          last.content += '\n' + a.content  // merge consecutive same-role messages
        } else {
          messages.push({ role, content: a.content })
        }
      }

      // Ensure the conversation ends with the user's message
      if (messages[messages.length - 1]?.role !== 'user') {
        console.log('[tasker] Chat: last message is not from user — skipping')
        return
      }

      const temperature = typeof agent.default_temperature === 'number' ? agent.default_temperature : 0.7

      let response
      try {
        response = await callModelWithMessages(model, agent, messages, temperature)
      } catch (err) {
        broadcast({
          type: 'task_update', task_id, status: null, timestamp: ts(),
          activity: { timestamp: ts(), type: 'chat_agent', content: `Error: ${err.message}` }
        })
        return
      }

      const actions = parseActions(response)
      let actionSummary = ''
      if (actions.length > 0) {
        const results = executeActions(actions, workdir)
        const lines = results.map(r => `${r.ok ? '✓' : '✗'} ${r.message}`)
        actionSummary = '\n\n── Actions ──\n' + lines.join('\n')
      }

      broadcast({
        type: 'task_update', task_id, status: null, timestamp: ts(),
        activity: { timestamp: ts(), type: 'chat_agent', content: response + actionSummary }
      })
    })()
    return
  }

  json(res, 404, { error: "Not found" });
});

server.listen(PORT, "127.0.0.1", () => {
  const url = `http://localhost:${PORT}`
  console.log(`[tasker] Running at ${url}`)
  console.log(`[tasker] Working directory: ${DEFAULT_WORKDIR}`)
  console.log(`[tasker] Opening browser...`)
  console.log(`[tasker] Press Ctrl+C to stop.`)
  openBrowser(url)
});

process.on("SIGINT", () => {
  console.log("\n[tasker] Shutting down...");
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
