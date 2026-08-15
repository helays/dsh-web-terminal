// src/index.ts
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import pty from "node-pty";
import { settingsNamespace } from "@deepseek-ai/dsh-settings";
import z from "@deepseek-ai/schemastery";

// src/resolve.ts
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
var TERMINAL_KINDS = [
  "auto",
  "pwsh",
  "powershell",
  "bash",
  "zsh",
  "sh",
  "cmd",
  "python",
  "custom"
];
var WINDOWS_PWSH_ROOTS = ["%ProgramFiles%\\PowerShell\\7\\pwsh.exe", "%ProgramFiles(x86)%\\PowerShell\\7-preview\\pwsh.exe"];
var WINDOWS_POWERSHELL = "%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
var WINDOWS_CMD = "%SystemRoot%\\System32\\cmd.exe";
function expandEnvVar(p, env) {
  if (!p.includes("%")) return p;
  return p.replace(/%([^%]+)%/g, (_m, k) => env[k] ?? "");
}
function which(bin, { platform, env }) {
  const shell = platform === "win32";
  const probe = shell ? `where.exe` : `which`;
  try {
    const out = execFileSync(probe, [bin], {
      env,
      encoding: "utf8",
      windowsHide: true
    });
    const first = out.split(/\r?\n/).find((l) => l.trim().length > 0);
    return first ? first.trim() : "";
  } catch {
    return "";
  }
}
function fileExists(p) {
  if (!p) return false;
  try {
    return existsSync(p);
  } catch {
    return false;
  }
}
function detectShells(opts = {}) {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const suggestions = new Set(suggestedKinds(platform));
  const candidates = [];
  const add = (kind, label, path, fallbacks = []) => {
    let resolved = path;
    if (!resolved || !fileExists(resolved)) {
      resolved = fallbacks.find((f) => fileExists(f)) ?? "";
    }
    if (!resolved && /^(pwsh|powershell|cmd|bash|zsh|sh|python)$/.test(kind)) {
      resolved = which(kind === "python" ? platform === "win32" ? "python" : "python3" : kind, { platform, env });
    }
    candidates.push({
      kind,
      label,
      path: resolved,
      available: resolved.length > 0,
      suggested: suggestions.has(kind)
    });
  };
  if (platform === "win32") {
    add(
      "pwsh",
      "PowerShell 7 (pwsh)",
      "",
      WINDOWS_PWSH_ROOTS.map((p) => expandEnvVar(p, env))
    );
    add("powershell", "Windows PowerShell 5.1", expandEnvVar(WINDOWS_POWERSHELL, env));
    add("cmd", "Command Prompt (cmd)", expandEnvVar(WINDOWS_CMD, env));
    add("bash", "Git Bash / WSL bash", "", []);
    add("zsh", "Zsh", "", []);
    add("sh", "POSIX sh", "", []);
    add("python", "Python \u4EA4\u4E92\u5F0F (REPL)", "", []);
  } else {
    add("bash", "Bash", "", []);
    add("zsh", "Zsh", "", []);
    add("sh", "POSIX sh", "", []);
    add("pwsh", "PowerShell (pwsh)", "", []);
    add("python", "Python \u4EA4\u4E92\u5F0F (REPL)", "", []);
  }
  candidates.unshift({
    kind: "auto",
    label: "\u81EA\u52A8\uFF08\u6309\u7CFB\u7EDF\u63A8\u8350\uFF09",
    path: "",
    available: true,
    suggested: false
  });
  return candidates;
}
function suggestedKinds(platform = process.platform) {
  return platform === "win32" ? ["pwsh", "powershell", "cmd"] : ["bash", "zsh", "sh"];
}
function buildArgv(cfg, candidates, opts = {}) {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  if (cfg.shellPath && cfg.shellPath.trim() && fileExists(cfg.shellPath.trim())) {
    return { file: cfg.shellPath.trim(), argv: cfg.shellArgs?.length ? cfg.shellArgs : [] };
  }
  const kind = cfg.kind ?? "auto";
  const used = candidates ?? detectShells({ platform, env });
  if (kind === "auto") {
    const firstSuggested = used.find((c) => c.available && c.suggested);
    const pick = firstSuggested ?? used.find((c) => c.available && c.kind !== "auto" && c.kind !== "custom");
    if (pick) return argvFor(pick, cfg.shellArgs, platform);
  }
  const byKind = used.find((c) => c.kind === kind && c.available);
  if (byKind) return argvFor(byKind, cfg.shellArgs, platform);
  if (platform === "win32") {
    const cmd = expandEnvVar(WINDOWS_CMD, env);
    return { file: fileExists(cmd) ? cmd : "cmd.exe", argv: [] };
  }
  return { file: "/bin/sh", argv: ["-i"] };
}
function argvFor(c, extra, platform) {
  const file = c.path || c.kind;
  if (extra && extra.length) return { file, argv: extra };
  switch (c.kind) {
    case "pwsh":
      return { file, argv: ["-NoLogo"] };
    // 交互式：不加 -Command/-NonInteractive
    case "powershell":
      return { file, argv: ["-NoLogo"] };
    case "bash":
    case "sh":
      return { file, argv: ["--noprofile", "--norc", "-i"] };
    case "zsh":
      return { file, argv: ["-i"] };
    case "python":
      return { file, argv: ["-i"] };
    case "cmd":
    default:
      return { file, argv: [] };
  }
}

// src/index.ts
var PREFIX = "/terminal";
var SCROLLBACK_CHARS = 1e5;
var TERMINAL_NS = settingsNamespace("terminal");
var __dirname = dirname(fileURLToPath(import.meta.url));
var name = "dsh-web-terminal";
var inject = ["webServer", "settings"];
var DEFAULT_CONFIG = {
  kind: "auto",
  shellPath: "",
  shellArgs: [],
  cwd: ""
};
var TERMINAL_CONFIG_SCHEMA = z.object({
  kind: z.union([...TERMINAL_KINDS]).default("auto"),
  shellPath: z.string().default(""),
  shellArgs: z.array(z.string()).default([]),
  cwd: z.string().default("")
});
function expandEnvVar2(p, env) {
  if (!p.includes("%")) return p;
  return p.replace(/%([^%]+)%/g, (_m, k) => env[k] ?? "");
}
function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload)
  });
  res.end(payload);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1e6) req.destroy();
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}
function sameOrigin(req, res) {
  const origin = req.headers.origin;
  if (origin === void 0) return true;
  try {
    return new URL(origin).host === (req.headers.host ?? "");
  } catch {
    return false;
  }
}
function apply(ctx) {
  const webServer = ctx.webServer;
  const sessions = /* @__PURE__ */ new Map();
  const upgradeDisposers = /* @__PURE__ */ new Map();
  let counter = 0;
  let configScope = null;
  let fallbackConfig = { ...DEFAULT_CONFIG };
  ctx.inject(["settings"], (sctx) => {
    const scope = sctx.settings.register(TERMINAL_NS, TERMINAL_CONFIG_SCHEMA, {
      base: { ...DEFAULT_CONFIG }
      // 组合层 entry 作为 base
    });
    configScope = scope;
    sctx.effect(() => () => {
      if (configScope === scope) configScope = null;
    });
  });
  ctx.inject(["commands"], (sctx) => {
    const dispose = sctx.commands.register({
      name: "terminal",
      description: "\u6253\u5F00\u4EA4\u4E92\u5F0F\u7EC8\u7AEF Tab",
      handler: async (_invocation) => ({
        kind: "success",
        text: "switched to terminal"
      })
    });
    sctx.effect(() => dispose);
  });
  const getConfig = () => configScope ? configScope.get() : fallbackConfig;
  const persist = async (next) => {
    if (configScope) {
      await configScope.update(next);
      return true;
    }
    fallbackConfig = next;
    return false;
  };
  function shellInventory() {
    return detectShells();
  }
  const newId = () => `${Date.now().toString(36)}-${(++counter).toString(36)}`;
  function killSession(id, _reason) {
    const record = sessions.get(id);
    if (!record) return;
    disposeWs(id);
    try {
      record.pty.kill();
    } catch {
    }
    sessions.delete(id);
    record.exited = true;
  }
  function disposeWs(id) {
    const dispose = upgradeDisposers.get(id);
    if (dispose) {
      dispose();
      upgradeDisposers.delete(id);
    }
  }
  function broadcast(record, data) {
    if (record.exited) return;
    record.buffer = (record.buffer + data).slice(-SCROLLBACK_CHARS);
    for (const ws of record.wsClients) {
      if (ws.readyState === ws.OPEN) ws.send(data);
    }
  }
  function createSession(opts = {}) {
    const { cols = 80, rows = 24, cwd } = opts;
    const cfg = getConfig();
    const { file, argv } = buildArgv(cfg);
    const id = newId();
    const cwdPath = cwd && cwd.length ? cwd : cfg.cwd && cfg.cwd.length ? expandEnvVar2(cfg.cwd, process.env) : process.cwd();
    const p = pty.spawn(file, argv, {
      name: "xterm-256color",
      cols,
      rows,
      cwd: cwdPath,
      env: {
        ...process.env,
        TERM: process.env.TERM || "xterm-256color",
        COLORTERM: process.env.COLORTERM || "truecolor"
      }
    });
    const record = {
      id,
      pty: p,
      shell: file,
      buffer: "",
      exited: false,
      wsClients: /* @__PURE__ */ new Set(),
      bornAt: Date.now()
    };
    sessions.set(id, record);
    p.onData((data) => broadcast(record, data));
    p.onExit(({ exitCode }) => {
      record.exited = true;
      record.buffer += `\r
\x1B[90m[\u8FDB\u7A0B\u5DF2\u9000\u51FA\uFF0C\u4EE3\u7801 ${exitCode}]\x1B[0m\r
`;
      for (const ws of record.wsClients) {
        try {
          ws.close(1e3, "session exited");
        } catch {
        }
      }
      record.wsClients.clear();
      disposeWs(id);
    });
    const dispose = webServer.registerUpgrade({
      path: `${PREFIX}/ws/${id}`,
      handler(req, socket, head) {
        const current = sessions.get(id);
        if (current === void 0 || current.exited) {
          socket.destroy();
          return;
        }
        const wss = new WebSocketServer({ noServer: true });
        wss.on("connection", (ws) => {
          current.wsClients.add(ws);
          if (current.buffer.length > 0) ws.send(current.buffer);
          ws.on("message", (data) => {
            if (current.exited || !current.pty) return;
            const text = String(data);
            if (text.startsWith('{"type":"resize"')) {
              try {
                const body = JSON.parse(text);
                if (typeof body.cols === "number" && typeof body.rows === "number") {
                  current.pty.resize(body.cols, body.rows);
                }
              } catch {
              }
            } else {
              current.pty.write(text);
            }
          });
          ws.on("close", () => current.wsClients.delete(ws));
          ws.on("error", () => current.wsClients.delete(ws));
        });
        wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
      }
    });
    upgradeDisposers.set(id, dispose);
    return record;
  }
  const disposeRoute = webServer.register({
    kind: "prefix",
    path: PREFIX,
    async handler(req, res) {
      if (!sameOrigin(req, res)) {
        sendJson(res, 403, { error: "cross-origin rejected" });
        return;
      }
      const url = new URL(req.url ?? "/", "http://x");
      const rest = url.pathname.slice(PREFIX.length);
      const method = req.method ?? "GET";
      if (rest === "/config" && method === "GET") {
        sendJson(res, 200, {
          config: getConfig(),
          shells: shellInventory()
        });
        return;
      }
      if (rest === "/config" && method === "POST") {
        try {
          const body = await readBody(req);
          const next = {
            kind: typeof body.kind === "string" && body.kind ? body.kind : "auto",
            shellPath: typeof body.shellPath === "string" ? body.shellPath : "",
            shellArgs: Array.isArray(body.shellArgs) ? body.shellArgs.filter((v) => typeof v === "string") : [],
            cwd: typeof body.cwd === "string" ? body.cwd : ""
          };
          await persist(next);
          sendJson(res, 200, { ok: true, config: getConfig() });
        } catch {
          sendJson(res, 400, { error: "bad config" });
        }
        return;
      }
      if (rest === "/xterm.css" && method === "GET") {
        try {
          const css = readFileSync(join(__dirname, "client.css"));
          res.writeHead(200, { "content-type": "text/css; charset=utf-8" });
          res.end(css);
        } catch {
          sendJson(res, 500, { error: "xterm.css not found" });
        }
        return;
      }
      if (rest === "/sessions" && method === "GET") {
        const list = [...sessions.values()].map((s) => ({
          id: s.id,
          shell: s.shell,
          exited: s.exited,
          bornAt: s.bornAt
        }));
        sendJson(res, 200, { sessions: list });
        return;
      }
      if (rest === "/sessions" && method === "POST") {
        let body = {};
        try {
          body = await readBody(req);
        } catch {
        }
        const record = createSession({
          cols: typeof body.cols === "number" ? body.cols : 80,
          rows: typeof body.rows === "number" ? body.rows : 24,
          cwd: typeof body.cwd === "string" && body.cwd ? body.cwd : getConfig().cwd || void 0
        });
        sendJson(res, 201, { id: record.id, shell: record.shell });
        return;
      }
      const delMatch = /^\/sessions\/([^/]+)$/.exec(rest);
      if (delMatch && method === "DELETE") {
        const id = delMatch[1];
        if (!sessions.has(id)) {
          sendJson(res, 404, { error: "not found" });
          return;
        }
        killSession(id, "client delete");
        sendJson(res, 200, { ok: true });
        return;
      }
      sendJson(res, 404, { error: "not found" });
    }
  });
  ctx.effect(() => () => {
    disposeRoute();
    for (const dispose of upgradeDisposers.values()) dispose();
    upgradeDisposers.clear();
    for (const id of [...sessions.keys()]) killSession(id, "plugin dispose");
  });
}
export {
  apply,
  inject,
  name
};
