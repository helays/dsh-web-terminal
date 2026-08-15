// dsh-web-terminal —— Host half（Cordis entry）。
// 在本机 spawn 一个 node-pty 会话池，通过 ctx.webServer 暴露：
//   GET/POST/DELETE /terminal/...  —— REST 会话管理 + 配置读写 + xterm.css
//   UPGRADE /terminal/ws/<id>      —— WebSocket 双向字节流 + resize
// 终端类型可配置：默认「自动识别（Windows→PowerShell，POSIX→bash）」，用户可在
// 设置面板的自绘卡片里切换（bash/zsh/pwsh/powershell/cmd/python 或自定义路径）。
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { WebSocketServer } from 'ws'
import type { WebSocket as WsClient } from 'ws'
import pty from 'node-pty'
// Type-only：把 @deepseek-ai/cordis 的 Context 及其上挂的 webServer / settings 带进类型域
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-settings'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import { detectShells, buildArgv, TERMINAL_KINDS, type TerminalKind } from './resolve.ts'

const PREFIX = '/terminal'
const SCROLLBACK_CHARS = 100_000
const TERMINAL_NS = settingsNamespace('terminal')
const __dirname = dirname(fileURLToPath(import.meta.url))

export const name = 'dsh-web-terminal'
export const inject = ['webServer', 'settings']

/** 用户可配置项。 */
export interface TerminalConfig {
  /** 终端类型（auto=按系统自动识别）。 */
  kind: TerminalKind
  /** 自定义 shell 绝对路径，非空时优先于 kind。 */
  shellPath: string
  /** 自定义 shell 的附加 argv（默认由 kind 决定）。 */
  shellArgs: string[]
  /** 默认工作目录；空则用会话/启动目录。 */
  cwd: string
}

const DEFAULT_CONFIG: TerminalConfig = {
  kind: 'auto',
  shellPath: '',
  shellArgs: [],
  cwd: '',
}

/** terminal 命名空间的 Schemastery schema（settings.yaml 校验 + 设置卡片渲染）。 */
const TERMINAL_CONFIG_SCHEMA = z.object({
  kind: z.union([...TERMINAL_KINDS]).default('auto'),
  shellPath: z.string().default(''),
  shellArgs: z.array(z.string()).default([]),
  cwd: z.string().default(''),
})

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

function expandEnvVar(p: string, env: NodeJS.ProcessEnv): string {
  if (!p.includes('%')) return p
  return p.replace(/%([^%]+)%/g, (_m, k) => env[k] ?? '')
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

  // ====== 可配置状态：settings 服务可用时走已注册命名空间（scope），否则内存兜底 ======
  let configScope: import('@deepseek-ai/dsh-settings').SettingsScope<TerminalConfig> | null = null
  let fallbackConfig: TerminalConfig = { ...DEFAULT_CONFIG }

  ctx.inject(['settings'], (sctx) => {
    const scope = sctx.settings.register(TERMINAL_NS, TERMINAL_CONFIG_SCHEMA, {
      base: { ...DEFAULT_CONFIG }, // 组合层 entry 作为 base
    })
    configScope = scope
    sctx.effect(() => () => {
      if (configScope === scope) configScope = null
    })
  })

  /** 当前权威配置（已注册时读 scope 的 resolved value，否则内存兜底）。 */
  const getConfig = (): TerminalConfig => (configScope ? configScope.get() : fallbackConfig)

  /** 持久化（await + catch，绝不产生 unhandled rejection）。返回是否落盘。 */
  const persist = async (next: TerminalConfig): Promise<boolean> => {
    if (configScope) {
      await configScope.update(next)
      return true
    }
    fallbackConfig = next
    return false
  }

  /** 当前可用 shell 候选（含推荐默认），返回给前端配置卡片。 */
  function shellInventory(): ReturnType<typeof detectShells> {
    return detectShells()
  }

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

  function createSession(opts: { cols?: number; rows?: number; cwd?: string } = {}): SessionRecord {
    const { cols = 80, rows = 24, cwd } = opts
    const cfg = getConfig()
    // 按配置（kind/shellPath/shellArgs）解析要 spawn 的 shell；auto 自动识别
    const { file, argv } = buildArgv(cfg)
    const id = newId()
    const cwdPath =
      cwd && cwd.length
        ? cwd
        : cfg.cwd && cfg.cwd.length
          ? expandEnvVar(cfg.cwd, process.env)
          : process.cwd()
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

      // GET /terminal/config —— 当前配置 + 可用 shell 清单
      if (rest === '/config' && method === 'GET') {
        sendJson(res, 200, {
          config: getConfig(),
          shells: shellInventory(),
        })
        return
      }

      // POST /terminal/config —— 保存配置（await + catch，防止 unhandled rejection）
      if (rest === '/config' && method === 'POST') {
        try {
          const body = (await readBody(req)) as Partial<TerminalConfig>
          const next: TerminalConfig = {
            kind: typeof body.kind === 'string' && body.kind ? (body.kind as TerminalKind) : 'auto',
            shellPath: typeof body.shellPath === 'string' ? body.shellPath : '',
            shellArgs: Array.isArray(body.shellArgs)
              ? body.shellArgs.filter((v): v is string => typeof v === 'string')
              : [],
            cwd: typeof body.cwd === 'string' ? body.cwd : '',
          }
          await persist(next)
          sendJson(res, 200, { ok: true, config: getConfig() })
        } catch {
          sendJson(res, 400, { error: 'bad config' })
        }
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

      // POST /terminal/sessions —— 创建会话（body: {cols, rows, cwd}）
      if (rest === '/sessions' && method === 'POST') {
        let body: { cols?: unknown; rows?: unknown; cwd?: unknown } = {}
        try {
          body = (await readBody(req)) as { cols?: unknown; rows?: unknown; cwd?: unknown }
        } catch {
          /* use defaults */
        }
        const record = createSession({
          cols: typeof body.cols === 'number' ? body.cols : 80,
          rows: typeof body.rows === 'number' ? body.rows : 24,
          cwd: typeof body.cwd === 'string' && body.cwd ? body.cwd : getConfig().cwd || undefined,
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
