// dsh-web-terminal —— Host half（Cordis entry）。
// 在本机 spawn 一个 node-pty 会话池，通过 ctx.webServer 暴露：
//   GET/POST/DELETE /terminal/...  —— REST 会话管理 + xterm.css
//   UPGRADE /terminal/ws/<id>      —— WebSocket 双向字节流 + resize
// 与 agent/模型会话完全解耦：这是「用户自己的终端」。
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { WebSocketServer } from 'ws'
import type { WebSocket as WsClient } from 'ws'
import type { ServerResponse } from 'node:http'
import pty from 'node-pty'
// Type-only：把 @deepseek-ai/cordis 的 Context 及其上挂的 webServer 带进类型域
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'

const PREFIX = '/terminal'
const SCROLLBACK_CHARS = 100_000
const __dirname = dirname(fileURLToPath(import.meta.url))

export const name = 'dsh-web-terminal'
export const inject = ['webServer']

/** 一个 PTY 会话的记录：pty 句柄 + 连接订阅者 + 断线回放缓冲。 */
interface SessionRecord {
  id: string
  pty: pty.IPty
  shell: string
  buffer: string
  exited: boolean
  wsClients: Set<WsClient>
  bornAt: number
}

/** Windows 下依次取 pwsh / powershell / cmd；其他平台用 $SHELL 兜底。 */
function resolveShell() {
  if (process.platform === 'win32') {
    if (process.env.PWShell) return process.env.PWShell
    return process.env.ComSpec || 'cmd.exe'
  }
  return process.env.SHELL || '/bin/sh'
}

function buildEnv() {
  const env = { ...process.env }
  env.TERM = env.TERM || 'xterm-256color'
  env.COLORTERM = env.COLORTERM || 'truecolor'
  return env
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

export function apply(ctx: Context): void {
  const webServer = ctx.webServer
  /** 会话池：id → record{pty, wsClients, buffer, exited} */
  const sessions = new Map<string, SessionRecord>()
  const upgradeDisposers = new Map<string, () => void>()
  let counter = 0

  const newId = () => `${Date.now().toString(36)}-${(++counter).toString(36)}`

  function killSession(id: string, _reason?: string): void {
    const record = sessions.get(id)
    if (!record) return
    disposeWs(id)
    try {
      record.pty.kill()
    } catch {
      /* 进程已退出 */
    }
    sessions.delete(id)
    record.exited = true
  }

  function disposeWs(id: string): void {
    const dispose = upgradeDisposers.get(id)
    if (dispose) {
      dispose()
      upgradeDisposers.delete(id)
    }
  }

  function broadcast(record: SessionRecord, data: string): void {
    if (record.exited) return
    record.buffer = (record.buffer + data).slice(-SCROLLBACK_CHARS)
    for (const ws of record.wsClients) {
      if (ws.readyState === ws.OPEN) ws.send(data)
    }
  }

  /** spawn 一个 PTY 会话（Windows 走 ConPTY），并每会话注册一条 WS upgrade。 */
  function createSession(opts: { cols?: number; rows?: number; cwd?: string } = {}): SessionRecord {
    const { cols = 80, rows = 24, cwd } = opts
    const file = resolveShell()
    // Windows 下 cmd/powershell 直接以空 args 启动即进交互；POSIX 加 -i 确保交互式。
    const argv = process.platform === 'win32' ? [] : ['-i']
    const id = newId()
    const p = pty.spawn(file, argv, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: cwd && cwd.length ? cwd : process.cwd(),
      env: buildEnv(),
    })
    const record: SessionRecord = {
      id,
      pty: p,
      shell: file,
      buffer: '',
      exited: false,
      wsClients: new Set(),
      bornAt: Date.now(),
    }
    sessions.set(id, record)

    p.onData((data: string) => broadcast(record, data))
    p.onExit(({ exitCode }: { exitCode: number }) => {
      record.exited = true
      record.buffer += '\r\n\x1b[90m[进程已退出，代码 ' + exitCode + ']\x1b[0m\r\n'
      for (const ws of record.wsClients) {
        try {
          ws.close(1000, 'session exited')
        } catch {
          /* 已关闭 */
        }
      }
      record.wsClients.clear()
      disposeWs(id)
    })

    // 每会话一条独立 upgrade 路由（路径精确匹配）
    const dispose = webServer.registerUpgrade({
      path: `${PREFIX}/ws/${id}`,
      handler(req, socket, head) {
        const current = sessions.get(id)
        if (current === undefined || current.exited) {
          socket.destroy()
          return
        }
        const wss = new WebSocketServer({ noServer: true })
        wss.on('connection', (ws) => {
          current.wsClients.add(ws)
          if (current.buffer.length > 0) ws.send(current.buffer) // 重连回放
          ws.on('message', (data) => {
            if (current.exited || !current.pty) return
            const text = String(data)
            if (text.startsWith('{"type":"resize"')) {
              try {
                const body = JSON.parse(text) as { cols?: number; rows?: number }
                if (typeof body.cols === 'number' && typeof body.rows === 'number') {
                  current.pty.resize(body.cols, body.rows)
                }
              } catch {
                /* 忽略畸形 resize */
              }
            } else {
              current.pty.write(text)
            }
          })
          ws.on('close', () => current.wsClients.delete(ws))
          ws.on('error', () => current.wsClients.delete(ws))
        })
        wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
      },
    })
    upgradeDisposers.set(id, dispose)
    return record
  }

  const disposeRoute = webServer.register({
    kind: 'prefix',
    path: PREFIX,
    async handler(req, res) {
      // 同源校验（webServer 无内置 origin 策略）
      const origin = req.headers.origin
      if (origin !== undefined) {
        try {
          if (new URL(origin).host !== (req.headers.host ?? '')) {
            sendJson(res, 403, { error: 'cross-origin rejected' })
            return
          }
        } catch {
          sendJson(res, 403, { error: 'cross-origin rejected' })
          return
        }
      }

      const url = new URL(req.url ?? '/', 'http://x')
      const rest = url.pathname.slice(PREFIX.length)
      const method = req.method ?? 'GET'

      // GET /terminal/xterm.css
      if (rest === '/xterm.css' && method === 'GET') {
        try {
          const css = readFileSync(join(__dirname, 'client.css'))
          res.writeHead(200, { 'content-type': 'text/css; charset=utf-8' })
          res.end(css)
        } catch {
          sendJson(res, 500, { error: 'xterm.css not found' })
        }
        return
      }

      // GET /terminal/sessions —— 会话列表（供恢复）
      if (rest === '/sessions' && method === 'GET') {
        const list = [...sessions.values()].map((s) => ({
          id: s.id,
          shell: s.shell,
          exited: s.exited,
          bornAt: s.bornAt,
        }))
        sendJson(res, 200, { sessions: list })
        return
      }

      // POST /terminal/sessions —— 创建会话（body: {cols, rows, cwd}）
      if (rest === '/sessions' && method === 'POST') {
        let body: { cols?: unknown; rows?: unknown; cwd?: unknown } = {}
        try {
          body = (await readBody(req)) as { cols?: unknown; rows?: unknown; cwd?: unknown }
        } catch {
          /* 用默认尺寸 */
        }
        const record = createSession({
          cols: typeof body.cols === 'number' ? body.cols : 80,
          rows: typeof body.rows === 'number' ? body.rows : 24,
          cwd: typeof body.cwd === 'string' ? body.cwd : process.cwd(),
        })
        sendJson(res, 201, { id: record.id, shell: record.shell })
        return
      }

      // DELETE /terminal/sessions/<id>
      const delMatch = /^\/sessions\/([^/]+)$/.exec(rest)
      if (delMatch && method === 'DELETE') {
        const id = delMatch[1]
        if (!sessions.has(id)) {
          sendJson(res, 404, { error: 'not found' })
          return
        }
        killSession(id, 'client delete')
        sendJson(res, 200, { ok: true })
        return
      }

      sendJson(res, 404, { error: 'not found' })
    },
  })

  // 卸载清理：先关 upgrade 路由，再杀全会话
  ctx.effect(() => () => {
    disposeRoute()
    for (const dispose of upgradeDisposers.values()) dispose()
    upgradeDisposers.clear()
    for (const id of [...sessions.keys()]) killSession(id, 'plugin dispose')
  })
}

/** 读取并 JSON.parse 请求体，失败抛错。 */
function readBody(req: import('node:http').IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk) => {
      data += chunk
      if (data.length > 1_000_000) req.destroy() // 上限
    })
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {})
      } catch (err) {
        reject(err)
      }
    })
    req.on('error', reject)
  })
}
