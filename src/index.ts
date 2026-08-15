// dsh-web-terminal —— Host half（Cordis entry）。
// 在本机 spawn 一个 node-pty 会话池，通过 ctx.webServer 暴露：
//   GET/POST/DELETE /terminal/...  —— REST 会话管理 + shell 清单 + xterm.css
//   UPGRADE /terminal/ws/<id>      —— WebSocket 双向字节流 + resize
// shell 类型由前端多终端工具条按「每个终端」指定（kind 随 POST /terminal/sessions 传入）；
// 默认 auto 自动识别（Windows→PowerShell，POSIX→bash）。不再用 dsh settings 持久化终端配置，
// 也不再提供可配置的默认工作目录（cwd 仅来自请求携带的 workspace 路径，或回退 process.cwd()）。
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { WebSocketServer } from 'ws'
import type { WebSocket as WsClient } from 'ws'
import pty from 'node-pty'
// Type-only：把 @deepseek-ai/cordis 的 Context 及其上挂的 webServer / commands 带进类型域
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-commands'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { detectShells, buildArgv, type TerminalKind } from './resolve.ts'

const PREFIX = '/terminal'
const SCROLLBACK_CHARS = 100_000
const __dirname = dirname(fileURLToPath(import.meta.url))

export const name = 'dsh-web-terminal'
export const inject = ['webServer']

/** 一个 PTY 会话的记录。 */
interface SessionRecord {
  id: string
  pty: pty.IPty
  shell: string
  buffer: string
  exited: boolean
  wsClients: Set<WsClient>
  bornAt: number
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk) => {
      data += chunk
      if (data.length > 1_000_000) req.destroy()
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

function sameOrigin(req: IncomingMessage, res: ServerResponse): boolean {
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === (req.headers.host ?? '')
  } catch {
    return false
  }
}

export function apply(ctx: Context): void {
  const webServer = ctx.webServer
  const sessions = new Map<string, SessionRecord>()
  const upgradeDisposers = new Map<string, () => void>()
  let counter = 0

  /** 当前可用 shell 候选（含推荐默认），返回给前端多终端下拉。 */
  function shellInventory(): ReturnType<typeof detectShells> {
    return detectShells()
  }

  // ===== /terminal 作为 host 目录命令注册（与 /plan 同源） =====
  // 这样它会出现在浏览器「composer 左下角 + 图标」的 command 下拉里，方向键选中 + 回车 = 单步执行。
  // handler 在 Node 端运行、本身无动作（返回成功即可）；真正的「切到终端 Tab」由浏览器端监听
  // command/executed 的本地确认后再做。命令路径绝不创建 PTY（只切视图）。
  ctx.inject(['commands'], (sctx) => {
    const dispose = sctx.commands.register({
      name: 'terminal',
      description: '打开交互式终端 Tab',
      // 无 input → 菜单选中/裸回车即单步直达；不记录 args（命令无参数）
      recordInput: false,
      handler: async (_invocation: CommandInvocation): Promise<CommandResult> => ({
        kind: 'success',
        text: 'switched to terminal',
      }),
    })
    sctx.effect(() => dispose)
  })

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

  interface SessionOpts {
    cols?: number
    rows?: number
    /** 打开目录；缺省回退 process.cwd()。不再有可配置的默认 cwd。 */
    cwd?: string
    /** shell 类型（auto=平台自动识别）。 */
    kind?: TerminalKind
    /** 自定义 shell 绝对路径；非空时优先于 kind。 */
    shellPath?: string
    /** 自定义 shell 附加 argv。 */
    shellArgs?: string[]
  }

  function createSession({ cols = 80, rows = 24, cwd, kind, shellPath, shellArgs }: SessionOpts = {}): SessionRecord {
    // 按请求参数解析要 spawn 的 shell（kind/shellPath/shellArgs），默认 auto 自动识别
    const { file, argv } = buildArgv({ kind: kind ?? 'auto', shellPath, shellArgs })
    const id = newId()
    const cwdPath = cwd && cwd.length ? cwd : process.cwd()
    const p = pty.spawn(file, argv, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: cwdPath,
      env: {
        ...process.env,
        TERM: process.env.TERM || 'xterm-256color',
        COLORTERM: process.env.COLORTERM || 'truecolor',
      },
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
      record.buffer += `\r\n\x1b[90m[进程已退出，代码 ${exitCode}]\x1b[0m\r\n`
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
          if (current.buffer.length > 0) ws.send(current.buffer)
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
                /* ignore */
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
      if (!sameOrigin(req, res)) {
        sendJson(res, 403, { error: 'cross-origin rejected' })
        return
      }
      const url = new URL(req.url ?? '/', 'http://x')
      const rest = url.pathname.slice(PREFIX.length)
      const method = req.method ?? 'GET'

      // GET /terminal/config —— 可用 shell 候选清单（供前端多终端下拉）。已无全局终端配置。
      if (rest === '/config' && method === 'GET') {
        sendJson(res, 200, {
          shells: shellInventory(),
        })
        return
      }

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

      // GET /terminal/sessions —— 会话列表
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

      // POST /terminal/sessions —— 创建会话（body: {cols, rows, cwd?, kind?, shellPath?, shellArgs?}）
      if (rest === '/sessions' && method === 'POST') {
        let body: {
          cols?: unknown
          rows?: unknown
          cwd?: unknown
          kind?: unknown
          shellPath?: unknown
          shellArgs?: unknown
        } = {}
        try {
          body = (await readBody(req)) as typeof body
        } catch {
          /* use defaults */
        }
        const record = createSession({
          cols: typeof body.cols === 'number' ? body.cols : 80,
          rows: typeof body.rows === 'number' ? body.rows : 24,
          cwd: typeof body.cwd === 'string' && body.cwd ? body.cwd : undefined,
          kind: typeof body.kind === 'string' && body.kind ? (body.kind as TerminalKind) : undefined,
          shellPath: typeof body.shellPath === 'string' ? body.shellPath : undefined,
          shellArgs: Array.isArray(body.shellArgs)
            ? body.shellArgs.filter((v): v is string => typeof v === 'string')
            : undefined,
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

  ctx.effect(() => () => {
    disposeRoute()
    for (const dispose of upgradeDisposers.values()) dispose()
    upgradeDisposers.clear()
    for (const id of [...sessions.keys()]) killSession(id, 'plugin dispose')
  })
}
