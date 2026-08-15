// src/index.ts
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { WebSocketServer } from "ws";
import pty from "node-pty";
var PREFIX = "/terminal";
var SCROLLBACK_CHARS = 1e5;
var __dirname = dirname(fileURLToPath(import.meta.url));
var name = "dsh-web-terminal";
var inject = ["webServer"];
function resolveShell() {
  if (process.platform === "win32") {
    if (process.env.PWShell) return process.env.PWShell;
    return process.env.ComSpec || "cmd.exe";
  }
  return process.env.SHELL || "/bin/sh";
}
function buildEnv() {
  const env = { ...process.env };
  env.TERM = env.TERM || "xterm-256color";
  env.COLORTERM = env.COLORTERM || "truecolor";
  return env;
}
function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload)
  });
  res.end(payload);
}
function apply(ctx) {
  const webServer = ctx.webServer;
  const sessions = /* @__PURE__ */ new Map();
  const upgradeDisposers = /* @__PURE__ */ new Map();
  let counter = 0;
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
    const file = resolveShell();
    const argv = process.platform === "win32" ? [] : ["-i"];
    const id = newId();
    const p = pty.spawn(file, argv, {
      name: "xterm-256color",
      cols,
      rows,
      cwd: cwd && cwd.length ? cwd : process.cwd(),
      env: buildEnv()
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
      record.buffer += "\r\n\x1B[90m[\u8FDB\u7A0B\u5DF2\u9000\u51FA\uFF0C\u4EE3\u7801 " + exitCode + "]\x1B[0m\r\n";
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
      const origin = req.headers.origin;
      if (origin !== void 0) {
        try {
          if (new URL(origin).host !== (req.headers.host ?? "")) {
            sendJson(res, 403, { error: "cross-origin rejected" });
            return;
          }
        } catch {
          sendJson(res, 403, { error: "cross-origin rejected" });
          return;
        }
      }
      const url = new URL(req.url ?? "/", "http://x");
      const rest = url.pathname.slice(PREFIX.length);
      const method = req.method ?? "GET";
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
          cwd: typeof body.cwd === "string" ? body.cwd : process.cwd()
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
export {
  apply,
  inject,
  name
};
