// tasker.js — Task queue manager for Claude Code agents
// Run: node tasker.js

"use strict";

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");

const VERSION = "1.2.1";
const GITHUB_REPO = "Emberstone-Studio/Tasker";
const INSTALL_DIR = path.join(os.homedir(), ".claude", "tasker");

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

const TASKER_HOME = path.join(os.homedir(), ".tasker");
const TASKER_SETTINGS_FILE = path.join(TASKER_HOME, "settings.json");
const MODEL_REGISTRY_PRIMARY = path.join(TASKER_HOME, "models");
const MODEL_REGISTRY_FALLBACK = path.join(__dirname, "models");

function readTaskerSettings() {
  try { return JSON.parse(fs.readFileSync(TASKER_SETTINGS_FILE, "utf8")); } catch { return {}; }
}

function writeTaskerSettings(data) {
  fs.mkdirSync(TASKER_HOME, { recursive: true });
  fs.writeFileSync(TASKER_SETTINGS_FILE, JSON.stringify(data, null, 2), "utf8");
}

function readModelRegistry() {
  const seen = new Set();
  const models = [];
  for (const dir of [MODEL_REGISTRY_PRIMARY, MODEL_REGISTRY_FALLBACK]) {
    let files;
    try { files = fs.readdirSync(dir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith(".json") || seen.has(f)) continue;
      seen.add(f);
      try {
        const d = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
        if (d.model_id) models.push(d);
      } catch {}
    }
  }
  return models;
}

const DEFAULT_STATE = {
  tasks: [],
  scanInterval: 60,
  agents: [
    {
      id: "agent-researcher-default",
      name: "Researcher",
      role: "You are a research agent. Your job is to find information, audit codebases, summarize findings, and answer questions with cited sources. Be thorough and precise. Prefer facts over speculation.",
      color: "#3b82f6",
      model: "claude-sonnet-4-6",
    },
    {
      id: "agent-coder-default",
      name: "Coder",
      role: "You are a coding agent. Your job is to write, edit, debug, and explain code. Produce clean, working code with no unnecessary comments. Follow the existing conventions in the codebase.",
      color: "#10b981",
      model: "claude-sonnet-4-6",
    },
    {
      id: "agent-reviewer-default",
      name: "Reviewer",
      role: "You are a review agent. Your job is to review output from other agents, flag issues, identify improvements, and provide actionable feedback. Be direct and specific.",
      color: "#f59e0b",
      model: "claude-opus-4-6",
    },
    {
      id: "agent-writer-default",
      name: "Writer",
      role: "You are a writing agent. Your job is to write documentation, copy, summaries, and prose. Match the existing tone and style. Be clear and concise.",
      color: "#8b5cf6",
      model: "claude-sonnet-4-6",
    },
  ],
  logs: [],
};

// ─── Claude binary resolution ─────────────────────────────────────

const { execSync, exec } = require("child_process");
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
    // Fallback: claude installed as a VS Code extension (no global CLI in PATH)
    if (!CLAUDE_BIN) {
      try {
        const vscodeExtDir = path.join(home, ".vscode", "extensions");
        const entries = fs.readdirSync(vscodeExtDir);
        for (const entry of entries.sort().reverse()) {
          if (entry.startsWith("anthropic.claude-code-")) {
            const bin = path.join(vscodeExtDir, entry, "resources", "native-binary", "claude");
            if (fs.existsSync(bin)) { CLAUDE_BIN = bin; break; }
          }
        }
      } catch {}
    }
  }
}

// ─── State ────────────────────────────────────────────────────────

let appState = null;
let paused = true;
let lastHeartbeat = null;
let pendingRepause = false;
let teamLeadSessionId = null;
let teamLeadScanSessionId = null;
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

// ─── External model execution ────────────────────────────────────

function loadDossier(modelId) {
  for (const dir of [MODEL_REGISTRY_PRIMARY, MODEL_REGISTRY_FALLBACK]) {
    const p = path.join(dir, `${modelId}.json`);
    try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch {}
  }
  return null;
}

async function executeExternal({ task_id, model_id, system_prompt, user_message, temperature, max_tokens }) {
  const dossier = loadDossier(model_id);
  if (!dossier) {
    return [400, { error: `Model ${model_id} has no dossier. Run /tasker-add-model to onboard it.`, retryable: false }];
  }

  const settings = readTaskerSettings();
  const conn = (settings.connected_models || {})[model_id];
  if (!conn) {
    return [400, { error: `Model ${model_id} is not connected. Open the Models tab and click Connect.`, retryable: false }];
  }

  const { api } = dossier;
  const format = api.format;
  const endpoint = conn.endpoint || api.endpoint;
  const apiKey = conn.api_key;
  const modelString = api.model_string;
  const temp = typeof temperature === "number" ? temperature : 0.7;
  const maxTok = typeof max_tokens === "number" ? max_tokens : 4096;

  let url, headers, bodyObj;

  if (format === "anthropic-messages") {
    if (!endpoint) return [400, { error: `Model ${model_id} needs endpoint configuration. Open the Models tab to finish setup.`, retryable: false }];
    url = endpoint;
    headers = { "x-api-key": apiKey || "", "anthropic-version": "2023-06-01", "content-type": "application/json" };
    bodyObj = { model: modelString, max_tokens: maxTok, system: system_prompt || "", messages: [{ role: "user", content: user_message }] };
  } else if (format === "openai-chat") {
    if (!endpoint) return [400, { error: `Model ${model_id} needs endpoint configuration. Open the Models tab to finish setup.`, retryable: false }];
    url = endpoint;
    headers = { "Authorization": `Bearer ${apiKey || ""}`, "content-type": "application/json" };
    const msgs = [];
    if (system_prompt) msgs.push({ role: "system", content: system_prompt });
    msgs.push({ role: "user", content: user_message });
    bodyObj = { model: modelString, temperature: temp, messages: msgs };
  } else if (format === "gemini") {
    if (!endpoint) return [400, { error: `Model ${model_id} needs endpoint configuration. Open the Models tab to finish setup.`, retryable: false }];
    url = `${endpoint}?key=${encodeURIComponent(apiKey || "")}`;
    headers = { "content-type": "application/json" };
    const combined = system_prompt ? `${system_prompt}\n\n${user_message}` : user_message;
    bodyObj = { contents: [{ parts: [{ text: combined }] }], generationConfig: { temperature: temp } };
  } else if (format === "ollama") {
    url = endpoint || "http://localhost:11434/api/chat";
    headers = { "content-type": "application/json" };
    const msgs = [];
    if (system_prompt) msgs.push({ role: "system", content: system_prompt });
    msgs.push({ role: "user", content: user_message });
    bodyObj = { model: modelString, messages: msgs, stream: false, options: { temperature: temp } };
  } else {
    return [400, { error: `Unknown API format: ${format}`, retryable: false }];
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);

  let response;
  try {
    response = await fetch(url, { method: "POST", headers, body: JSON.stringify(bodyObj), signal: controller.signal });
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === "AbortError") return [504, { error: "Request timed out", retryable: true }];
    if (format === "ollama") return [503, { error: "Ollama not running — start with 'ollama serve'", retryable: false }];
    return [503, { error: `Network error: ${err.message}`, retryable: true }];
  }
  clearTimeout(timeoutId);

  if (response.status === 401 || response.status === 403) return [response.status, { error: "Authentication failed — check API key", retryable: false }];
  if (response.status === 429) return [429, { error: "Rate limited", retryable: true }];
  if (response.status >= 500) return [response.status, { error: "Provider error", retryable: true }];
  if (!response.ok) return [response.status, { error: `HTTP ${response.status}`, retryable: false }];

  let data;
  try { data = await response.json(); } catch {
    return [502, { error: "Unexpected response format", retryable: false }];
  }

  let output, tokens_used = null;
  try {
    if (format === "anthropic-messages") {
      output = data.content[0].text;
      tokens_used = ((data.usage?.input_tokens ?? 0) + (data.usage?.output_tokens ?? 0)) || null;
    } else if (format === "openai-chat") {
      output = data.choices[0].message.content;
      tokens_used = data.usage?.total_tokens ?? null;
    } else if (format === "gemini") {
      output = data.candidates[0].content.parts[0].text;
      tokens_used = data.usageMetadata?.totalTokenCount ?? null;
    } else if (format === "ollama") {
      output = data.message.content;
      tokens_used = ((data.prompt_eval_count ?? 0) + (data.eval_count ?? 0)) || null;
    }
  } catch {
    return [502, { error: "Unexpected response format", retryable: false }];
  }

  if (typeof output !== "string") return [502, { error: "Unexpected response format", retryable: false }];

  let stripped = false;
  if (model_id === "deepseek-r1") {
    const cleaned = output.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
    if (cleaned !== output) { output = cleaned; stripped = true; }
  }

  return [200, { output, model_id, tokens_used, ...(stripped && { stripped: true }) }];
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
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed.tasks)) {
          return json(res, 400, { error: "Invalid state: missing tasks array" });
        }
        const prevInterval = appState && appState.scanInterval;
        appState = parsed;
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
      if (scanTimer) { clearTimeout(scanTimer); scanTimer = null; }
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
    if (found > 0) {
      const wasPaused = paused;
      paused = false;
      pendingRepause = wasPaused;
      if (scanTimer) clearTimeout(scanTimer);
      scanTimer = setTimeout(() => {
        runScan();
        if (!wasPaused) scheduleScan();
      }, 0);
      if (wasPaused) {
        setTimeout(() => {
          if (pendingRepause) {
            pendingRepause = false;
            paused = true;
            broadcast({ type: "tasker_state", paused: true });
          }
        }, 120000);
      }
    }
    return json(res, 200, { ok: true, found });
  }

  if (req.method === "POST" && req.url === "/claim-ready") {
    if (!appState) return json(res, 200, { tasks: [], agents: [] });
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
    const pickups = claimed.map((t) => {
      const effectiveId = (t.pipeline && t.pipeline.length > 0)
        ? t.pipeline[t.pipeline_step || 0] : t.agent_id;
      const agent = (appState.agents || []).find((a) => a.id === effectiveId);
      return { taskId: t.id, title: t.title, agent: agent ? agent.name : "Auto" };
    });
    broadcast({ type: "scan_claimed", pickups });
    if (pendingRepause) {
      pendingRepause = false;
      paused = true;
      broadcast({ type: "tasker_state", paused: true });
    }
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

  if (req.method === "GET" && req.url === "/version") {
    return json(res, 200, {
      version: VERSION,
      latestVersion: latestRelease ? latestRelease.tag_name : null,
      updateAvailable: !!latestRelease,
      downloadUrl: latestRelease
        ? (latestRelease.assets || []).find((a) => a.name === "Tasker.zip")?.browser_download_url || latestRelease.html_url
        : null,
    });
  }

  if (req.method === "POST" && req.url === "/update") {
    if (!latestRelease) return json(res, 400, { error: "No update available" });
    json(res, 200, { ok: true });
    setImmediate(performUpdate);
    return;
  }

  if (req.method === "POST" && req.url === "/shutdown") {
    teamLeadSessionId = null;
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

  if (req.method === "POST" && req.url === "/chat/reset") {
    teamLeadSessionId = null;
    return json(res, 200, { ok: true });
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
      const session_id = teamLeadSessionId || body.session_id || null;

      const sanitize = (s) => String(s).replace(/[\r\n"]/g, " ").trim();
      const tasks =
        ((appState && appState.tasks) || [])
          .map((t) => `[${t.status}] ${sanitize(t.title)}`)
          .join(", ") || "(no tasks)";
      const agents =
        ((appState && appState.agents) || []).map((a) => sanitize(a.name)).join(", ") ||
        "(none)";

      // Keep system prompt on one line — newlines break cmd.exe arg parsing on Windows.
      const systemPrompt =
        `You are the Tasker team lead — a project manager embedded in a Claude Code task management board. ` +
        `Your job is to orchestrate tasks, assign work to specialized agents, and report status clearly to the user. ` +
        `You do NOT do task work yourself; you delegate everything to agents and coordinate results. ` +
        `You have full tool access and can act on the board by calling the Tasker REST API at http://localhost:${PORT}. ` +
        `Current board state: ${tasks}. ` +
        `Agents available: ${agents}. ` +
        `To update the board, POST to http://localhost:${PORT}/state with the full updated state JSON. ` +
        `If you need to write any temporary files, use the .tasker/ directory (e.g. .tasker/tmp.json) and delete them when done. Never write temp files to the system temp directory or working directory root. ` +
        `When you need user input, have hit a blocker, or require human attention, include [NEEDS_ATTENTION] at the very end of your response (it will be stripped before display).`;

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

      const CHAT_TIMEOUT_MS = 600_000;
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
        if (newSessionId) teamLeadSessionId = newSessionId;
        const needsAttention = reply.includes("[NEEDS_ATTENTION]");
        if (needsAttention) broadcast({ type: "needs_attention" });
        json(res, 200, { reply, session_id: newSessionId });
      });
    });
    return;
  }

  if (req.method === "GET" && req.url === "/models") {
    const catalog = readModelRegistry();
    const settings = readTaskerSettings();
    const connected = settings.connected_models || {};
    const result = catalog.map((m) => ({
      ...m,
      builtin: m.provider === "Anthropic",
      connected: m.provider === "Anthropic" ? true : !!connected[m.model_id],
      connection: connected[m.model_id] || null,
    }));
    return json(res, 200, result);
  }

  if (req.method === "POST" && req.url === "/models/connect") {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      let body;
      try { body = JSON.parse(raw); } catch { return json(res, 400, { error: "invalid JSON" }); }
      const { model_id, api_key, endpoint, host } = body;
      if (!model_id) return json(res, 400, { error: "model_id required" });
      const settings = readTaskerSettings();
      if (!settings.connected_models) settings.connected_models = {};
      settings.connected_models[model_id] = {
        api_key: api_key || null,
        endpoint: endpoint || null,
        host: host || null,
        connected_at: new Date().toISOString().split("T")[0],
      };
      writeTaskerSettings(settings);
      return json(res, 200, { ok: true });
    });
    return;
  }

  if (req.method === "POST" && req.url === "/models/disconnect") {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      let body;
      try { body = JSON.parse(raw); } catch { return json(res, 400, { error: "invalid JSON" }); }
      const { model_id } = body;
      if (!model_id) return json(res, 400, { error: "model_id required" });
      const settings = readTaskerSettings();
      if (settings.connected_models) delete settings.connected_models[model_id];
      writeTaskerSettings(settings);
      return json(res, 200, { ok: true });
    });
    return;
  }

  if (req.method === "POST" && req.url === "/execute-external") {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      let body;
      try { body = JSON.parse(raw); } catch {
        return json(res, 400, { error: "invalid JSON", retryable: false });
      }
      const { task_id, model_id, system_prompt, user_message, temperature, max_tokens } = body;
      if (!model_id) return json(res, 400, { error: "model_id required", retryable: false });
      executeExternal({ task_id, model_id, system_prompt: system_prompt || "", user_message: user_message || "", temperature, max_tokens })
        .then(([status, result]) => json(res, status, result))
        .catch((err) => json(res, 500, { error: err.message, retryable: false }));
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

  // Always restart: shut down any stale server (silently no-ops if nothing running)
  // so freshly copied files are always picked up.
  const shutdownExisting = `node -e "require('http').request({hostname:'localhost',port:process.env.PORT,path:'/shutdown',method:'POST'},()=>{}).on('error',()=>{}).end()" PORT=$PORT 2>/dev/null; sleep 1`;

  const startBlock = `\`\`\`bash
${portLine}
${shutdownExisting}
nohup node .tasker/tasker.js serve > /dev/null 2>&1 &
for i in 1 2 3 4 5 6 7 8 9 10; do
  sleep 1
  ${nodeCheck} && break
done
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

No further output.
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

If \`tasks\` is empty, you are done — stop here.

## 2. Select the model and load its dossier (per claimed task)

Tasker keeps a **model registry**: one JSON dossier per model plus a \`ROUTING.md\` guide. Resolve the registry by checking these locations in order:

- Primary: \`~/.tasker/models/\` (global — onboarded and user-added models live here)
- Fallback: \`./.tasker/models/\` (seed dossiers shipped with the project)

**2a. Load the routing guide once per scan** (not per task): read \`ROUTING.md\` for fast routing decisions.

**2b. Determine each task's target model**, in priority order:
1. \`task.model\` (a model_id) if set
2. the resolved agent's \`model\` field if set
3. otherwise no explicit model — use \`ROUTING.md\` to pick the best connected model, or fall back to the local Claude sub-agent path (Step 3)

**2c. Load only that model's dossier** (\`<registry>/<model_id>.json\`). Never bulk-load dossiers.

**2d. Gate checks** — read \`~/.tasker/settings.json\` for connection state. Run in order; on any failure do NOT delegate: reset task \`status\` to \`ready\`, append an \`activity\` note, POST full state to \`/state\` via \`node -e\`, then POST \`/pause-with-message\` and skip the task:

- **Missing dossier** — message \`"Model <id> has no dossier. Run /tasker-add-model to onboard it."\`
- **Unverified** — any \`quirks\` entry begins with \`UNVERIFIED\`: message \`"Model <id> dossier is unverified. Remove the UNVERIFIED marker in ~/.tasker/models/<id>.json once confirmed."\`
- **Not connected** — \`connected_models[model_id]\` missing from \`~/.tasker/settings.json\`: message \`"Model <id> is not connected. Open the Models tab and click Connect."\`
- **Needs configuration** — \`api.endpoint\` or \`api.auth\` is null and no endpoint in settings: message \`"Model <id> needs endpoint configuration. Open the Models tab to finish setup."\`

Tasks that pass all gates carry their dossier into Step 3.

## 3. Build the brief, apply the dossier, and delegate

For each task that passed Step 2:

- **description**: \`"[AgentName]: [task title]"\` — e.g. \`"Coder: Fix login bug"\`
- **prompt** — a self-contained brief that includes:
  - The agent's **role** (copy it verbatim from the \`agents\` array returned above)
  - The task **title** and **description** (the agent's actual instructions)
  - Any user comments: activity entries with \`"type": "chat_user"\` from the task's \`activity\` array — include them verbatim under a **User comments** heading
  - The working directory: the current working directory
  - What to return: a concise summary of what was done, including any files changed

**Apply the dossier when constructing the brief** (when one was loaded):
- Prepend \`prompting.system_prompt_prefix\` to the role text when non-null.
- Add \`handoff.output_format_instruction\` verbatim as an explicit **Output format** line.
- Shape the brief to \`prompting.ideal_task_length\` and \`prompting.responds_best_to\`; if \`prompting.needs_examples\` is true, include a short few-shot example.

**Delegation transport — two paths based on model provider:**

**Path A — Claude model (\`provider: "Anthropic"\`) or no explicit model assigned:**
→ Delegate via the **Agent tool**. If the dossier has an \`agent_model\` field (e.g. \`"haiku"\`, \`"sonnet"\`, \`"opus"\`), pass it as the \`model\` parameter in the Agent tool call. If no dossier was loaded or \`agent_model\` is absent, omit \`model\` to use the session default.

When the Agent returns, inspect the result **before** updating state:

**If the result contains "rate limit", "usage limit", "overloaded", or "capacity":**
- Reset the task's \`status\` to \`"ready"\`, append an activity note with the error
- POST state to \`/state\` via \`node -e\`, then POST \`/pause-with-message\` with body \`{"message": "Paused: Claude usage limit hit while working on \\"<task title>\\". Resume when ready."}\`
- Stop immediately — do not call ScheduleWakeup.

**Otherwise (normal completion):**
- Read \`./.tasker/tasks.json\`, set \`status\` to \`"in_review"\`, append \`{"timestamp": "<ISO>", "type": "output", "content": "<agent summary>"}\` to \`activity\`
- POST the full patched state to \`/state\` via \`node -e\`

**Path B — External (non-Claude) model:**
→ POST to \`http://localhost:$PORT/execute-external\` via \`node -e\`. Request body fields: \`task_id\` (string), \`model_id\` (string), \`system_prompt\` (assembled role + dossier prefix), \`user_message\` (task brief), \`temperature\` (0.7), \`max_tokens\` (null). Response on success: \`{ output, model_id, tokens_used, stripped? }\`. On failure: \`{ error, retryable }\`.

**Handling external model responses:**

- **Retryable error (\`retryable: true\` — rate limited, timeout, provider error):**
  - Reset \`status\` to \`"ready"\`, append \`{"type": "error", "content": "<error message>"}\` to \`activity\`
  - POST state to \`/state\` via \`node -e\`, then POST \`/pause-with-message\` with body \`{"message": "Paused: <error> while working on \\"<task title>\\". Resume when ready."}\`
  - Stop immediately.

- **Non-retryable error (\`retryable: false\` — auth failure, bad config):**
  - Reset \`status\` to \`"ready"\`, append \`{"type": "error", "content": "<error message>"}\` to \`activity\`
  - POST state to \`/state\` via \`node -e\`, then POST \`/pause-with-message\` with body \`{"message": "Paused: <error> while working on \\"<task title>\\". Fix the issue and resume."}\`
  - Stop immediately.

- **Success:**
  - Build an attribution header: start with \`**<dossier.display_name>**\`; if \`tokens_used\` is non-null append \`(tokens used: <n>)\`; if \`stripped: true\` append \`— reasoning trace stripped\`.
  - Append to \`activity\`: \`{"timestamp": "<ISO>", "type": "output", "content": "<attribution>\\n---\\n<output>"}\`
  - Set \`status\` to \`"in_review"\`, POST full patched state to \`/state\` via \`node -e\`

For pipeline tasks use \`pipeline[pipeline_step]\` as the effective agent_id. For \`agent_id: null\`, pick the best agent based on task content (writing/docs → Writer, reviewing/auditing → Reviewer, research → Researcher, default → Coder). Auto tasks always use Path A unless a non-Claude connected model is found via routing.

If multiple tasks are ready, spawn all Path A (Claude) agents in a **single message** as parallel Agent tool calls. Path B (external) tasks must be executed sequentially — one \`/execute-external\` call at a time — to avoid interleaving state writes.

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
    try { fs.unlinkSync(path.join(commandsDir, "tasker-watch.md")); } catch (e) {}
    // Install tasker-add-model only if not already present (allows user customization)
    const addModelPath = path.join(commandsDir, "tasker-add-model.md");
    if (!fs.existsSync(addModelPath)) {
      const b = "`";
      const addModelContent = `---
description: Onboard a new model into Tasker's registry by interviewing it and saving a dossier
---

Onboard a model that isn't in Tasker's registry yet. Interview the model, normalize its self-report into the standard dossier schema, and save to ${b}~/.tasker/models/<model_id>.json${b}. After this, /tasker-scan can route tasks to it.

${b}$ARGUMENTS${b} may contain the model id and/or connection details. Ask the user for anything missing.

## 1. Gather connection details

Collect: ${b}model_id${b}, ${b}display_name${b}, ${b}provider${b}, ${b}api.endpoint${b}, ${b}api.model_string${b}, ${b}api.format${b} (anthropic-messages / openai-chat / gemini), ${b}api.auth${b}. If endpoint/auth unavailable, save as null — the scan skill gates as "needs configuration" until filled in.

## 2. Interview the model

Send this single user message (empty system prompt):

> You are being registered in a model-orchestration registry. Reply with JSON only, no prose. Report honestly: ${b}best_for${b} (3–6 task types), ${b}avoid${b} (3–6), ${b}context_window${b} (int), ${b}supports_multimodal${b} (bool), ${b}supports_tool_use${b} (bool), ${b}relative_speed${b} (fast/medium/slow), ${b}relative_cost${b} (low/medium/high), ${b}responds_best_to${b} (1–2 sentences), ${b}prompt_avoid${b} (1–2 sentences), ${b}needs_examples${b} (bool), ${b}ideal_task_length${b} (brief/medium/detailed), ${b}quirks${b} (2–5 actionable items), ${b}output_format_instruction${b}. Keys exactly as named.

Use ${b}node -e${b} to POST to the provider's API. Read the API key from Tasker Settings or from the user. Stop and report if the call fails.

## 3. Normalize into the dossier schema

Map the self-report into the schema used by seed dossiers (see any file in ${b}~/.tasker/models/${b}):
- Fill the ${b}api${b} block from Step 1 (null where unavailable)
- Set ${b}tier${b} (flagship/standard/fast) from cost/speed
- ${b}prompting.system_prompt_prefix${b}: derive the most useful prefix; null if nothing clearly helps
- Rewrite ${b}quirks${b}, ${b}handoff.output_format_instruction${b}, and ${b}handoff.evaluation_notes${b} from an orchestrator's perspective
- Set ${b}"source": "onboarding — model self-report"${b}
- First ${b}quirks${b} entry must begin with ${b}UNVERIFIED${b} — scan will gate the model until confirmed
- ${b}last_updated${b}: today's date (YYYY-MM-DD)

## 4. Save and register

- Write ${b}~/.tasker/models/<model_id>.json${b} (create dir if missing)
- Read board state, append ${b}{ "id": "<model_id>", "display_name": ..., "provider": ... }${b} to the ${b}models${b} array, POST to ${b}/state${b}

## 5. Report to the user

Confirm: dossier saved, registered, marked UNVERIFIED until confirmed. Show ${b}tier${b}, ${b}best_for${b}, top ${b}quirks${b}, and any null API fields still needing configuration.
`;
      fs.writeFileSync(addModelPath, addModelContent, "utf8");
      console.log(`[tasker] Skill installed: /tasker-add-model`);
    }
  } catch (err) {
    console.warn(`[tasker] Could not install skills: ${err.message}`);
  }

}

// ─── Update ───────────────────────────────────────────────────────

let latestRelease = null;

function parseVersion(v) {
  return String(v).replace(/^v/, "").split(".").map(Number);
}

function isNewer(remote, local) {
  const r = parseVersion(remote);
  const l = parseVersion(local);
  for (let i = 0; i < 3; i++) {
    if ((r[i] || 0) > (l[i] || 0)) return true;
    if ((r[i] || 0) < (l[i] || 0)) return false;
  }
  return false;
}

function checkForUpdate() {
  const opts = {
    hostname: "api.github.com",
    path: `/repos/${GITHUB_REPO}/releases/latest`,
    headers: { "User-Agent": `Tasker/${VERSION}` },
  };
  https.get(opts, (res) => {
    let data = "";
    res.on("data", (c) => (data += c));
    res.on("end", () => {
      try {
        const release = JSON.parse(data);
        if (release.tag_name && isNewer(release.tag_name, VERSION)) {
          latestRelease = release;
          broadcast({ type: "update_available", version: release.tag_name });
        }
      } catch {}
    });
  }).on("error", () => {});
}

function downloadFile(url, dest, cb) {
  const mod = url.startsWith("https") ? https : http;
  mod.get(url, { headers: { "User-Agent": `Tasker/${VERSION}` } }, (res) => {
    if (res.statusCode === 301 || res.statusCode === 302)
      return downloadFile(res.headers.location, dest, cb);
    if (res.statusCode !== 200) return cb(new Error(`HTTP ${res.statusCode}`));
    const f = fs.createWriteStream(dest);
    res.pipe(f);
    f.on("finish", () => f.close(cb));
    f.on("error", (e) => { fs.unlink(dest, () => {}); cb(e); });
  }).on("error", cb);
}

function performUpdate() {
  const asset = (latestRelease.assets || []).find((a) => a.name === "Tasker.zip");
  if (!asset) throw new Error("No Tasker.zip in release assets");

  const tmpDir = path.join(os.tmpdir(), `tasker-update-${Date.now()}`);
  const zipPath = path.join(tmpDir, "Tasker.zip");
  const extractDir = path.join(tmpDir, "extracted");
  fs.mkdirSync(tmpDir, { recursive: true });

  broadcast({ type: "update_progress", step: "downloading" });

  downloadFile(asset.browser_download_url, zipPath, (err) => {
    if (err) return fail(err, tmpDir, asset.browser_download_url);

    broadcast({ type: "update_progress", step: "extracting" });
    fs.mkdirSync(extractDir, { recursive: true });

    const extractCmd = process.platform === "win32"
      ? `powershell -NoProfile -NonInteractive -Command "Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${extractDir}' -Force"`
      : `unzip -o "${zipPath}" -d "${extractDir}"`;

    exec(extractCmd, (err) => {
      if (err) return fail(err, tmpDir, asset.browser_download_url);

      broadcast({ type: "update_progress", step: "installing" });

      try {
        const srcDir = path.join(extractDir, "Tasker");
        for (const dir of [INSTALL_DIR, __dirname]) {
          fs.mkdirSync(dir, { recursive: true });
          for (const file of fs.readdirSync(srcDir))
            fs.copyFileSync(path.join(srcDir, file), path.join(dir, file));
        }
      } catch (e) {
        return fail(e, tmpDir, asset.browser_download_url);
      }

      try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
      broadcast({ type: "update_complete", version: latestRelease.tag_name });

      const next = spawn(process.execPath, [__filename, "serve"], {
        detached: true, stdio: "ignore", cwd: process.cwd(),
        env: { ...process.env, TASKER_PORT: String(PORT) },
      });
      next.unref();
      setTimeout(() => process.exit(0), 800);
    });
  });
}

function fail(err, tmpDir, downloadUrl) {
  try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
  console.error("[tasker] update failed:", err.message);
  broadcast({ type: "update_failed", downloadUrl });
}

// ─── Server-side scan loop ────────────────────────────────────────

let scanTimer = null;

function runScan() {
  if (paused || !appState || !CLAUDE_BIN) return;
  const readyTasks = appState.tasks.filter((t) => t.status === "ready");
  if (readyTasks.length === 0) return;
  lastHeartbeat = Date.now();
  broadcast({ type: "scan_heartbeat", lastHeartbeat });

  const pickups = readyTasks.map((t) => {
    const effectiveId = (t.pipeline && t.pipeline.length > 0)
      ? t.pipeline[t.pipeline_step || 0] : t.agent_id;
    const agent = (appState.agents || []).find((a) => a.id === effectiveId);
    return { taskId: t.id, title: t.title, agent: agent ? agent.name : "Auto" };
  });

  broadcast({ type: "scan_claimed", pickups });

  const taskList = pickups.map((p) => `${p.title} (${p.agent})`).join(", ");
  const triggerMessage =
    `${readyTasks.length} task${readyTasks.length > 1 ? "s" : ""} ready to process: ${taskList}. ` +
    `Claim and assign them.`;

  const postBody = JSON.stringify({
    message: triggerMessage,
    session_id: teamLeadScanSessionId || undefined,
  });

  const req = http.request(
    {
      hostname: "127.0.0.1",
      port: PORT,
      path: "/chat",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(postBody),
      },
    },
    (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          const body = JSON.parse(data);
          if (body.error) {
            console.error("[tasker] scan chat error:", body.error);
            return;
          }
          if (body.session_id) teamLeadScanSessionId = body.session_id;
          const reply = (body.reply || "").replace(/\[NEEDS_ATTENTION\]/g, "").trim();
          if (reply) broadcast({ type: "team_lead_message", reply });
          if ((body.reply || "").includes("[NEEDS_ATTENTION]"))
            broadcast({ type: "needs_attention" });
        } catch {}
      });
    }
  );
  req.on("error", (err) => console.error("[tasker] scan request error:", err.message));
  req.write(postBody);
  req.end();
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
    if (!paused) scheduleScan();
    checkForUpdate();
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
