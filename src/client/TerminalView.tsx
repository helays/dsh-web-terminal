import { useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { NS } from './locales.ts'

const PREFIX = '/terminal'

export interface TerminalViewInjected {
  /** 确保该会话有 PTY，返回后端 terminalId（创建会话在挂载时惰性发生）。 */
  ensureTerminal: (sessionId: string, cols: number, rows: number) => Promise<string>
}

interface TerminalViewProps {
  sessionId: string
  ensureTerminal: TerminalViewInjected['ensureTerminal']
  t: (key: 'view.terminal') => string
}

const TERM_THEME = {
  foreground: '#e5e5e5',
  background: '#1e1e1e',
  selectionBackground: '#4a6da7',
} as const

/** 注入 xterm 样式 link（幂等）。 */
function injectXtermCss() {
  if (typeof document === 'undefined') return
  if (document.getElementById('dsh-web-terminal-xterm-css') !== null) return
  const link = document.createElement('link')
  link.id = 'dsh-web-terminal-xterm-css'
  link.rel = 'stylesheet'
  link.href = PREFIX + '/xterm.css'
  document.head.appendChild(link)
}

export function TerminalView({ sessionId, ensureTerminal, t }: TerminalViewProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const [fullscreen, setFullscreen] = useState(false)
  const [connection, setConnection] = useState<'connecting' | 'open'>('connecting')

  // 首次/重挂载：确保有 PTY 会话（会话池在 host，组件只 attach，绝不销毁）
  useEffect(() => {
    let alive = true
    injectXtermCss()
    const term = new Terminal({
      cursorBlink: true,
      fontFamily:
        "ui-monospace, SFMono-Regular, 'Cascadia Mono', Consolas, Menlo, monospace",
      fontSize: 12.5,
      lineHeight: 1.25,
      scrollback: 10_000,
      theme: TERM_THEME,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)

    const host = hostRef.current
    if (!host) return
    term.open(host)
    let fitTimer: number | undefined
    const doFit = () => {
      try {
        fit.fit()
      } catch {
        /* 容器零尺寸 */
      }
    }
    doFit()
    fitTimer = window.setTimeout(doFit, 100)

    let socket: WebSocket | null = null
    const initialCols = term.cols
    const initialRows = term.rows

    ensureTerminal(sessionId, initialCols || 80, initialRows || 24)
      .then((id) => {
        if (!alive) return
        // 打开 WebSocket（路径精确匹配后端每会话 upgrade）
        const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
        const ws = new WebSocket(`${proto}//${location.host}${PREFIX}/ws/${id}`)
        socket = ws
        ws.onopen = () => alive && setConnection('open')
        ws.onmessage = (ev) => term.write(ev.data as string)
        ws.onclose = () => {
          setConnection('connecting')
        }
        ws.onerror = () => ws.close()
        term.onData((data) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(data)
        })
        term.onResize(({ cols, rows }) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'resize', cols, rows }))
          }
        })
      })
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.error('dsh-web-terminal: 创建会话失败', err)
      })

    return () => {
      alive = false
      if (fitTimer !== undefined) window.clearTimeout(fitTimer)
      if (socket) {
        // onclose 里别触发重连副作用：此处仅断开，不销毁 host 会话
        socket.onclose = null
        socket.onerror = null
        try {
          socket.close()
        } catch {
          /* 已关闭 */
        }
      }
      term.dispose()
    }
  }, [sessionId, ensureTerminal])

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: 0,
        position: 'relative',
        paddingTop: 4,
        boxSizing: 'border-box',
        ...(fullscreen
          ? { position: 'fixed', inset: 0, zIndex: 999, background: '#1e1e1e', padding: 8 }
          : {}),
      }}
    >
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '4px 8px', flexShrink: 0 }}>
        <span style={{ opacity: 0.7, fontSize: 12 }}>
          {t('view.terminal')}
        </span>
        <span style={{ opacity: 0.5, fontSize: 12 }} data-testid="dsh-terminal-status">
          {connection === 'open' ? '● 已连接' : '… 连接中'}
        </span>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          onClick={() => navigator.clipboard?.writeText('')}
          title="复制粘贴方法：选中后使用 Ctrl+C / Ctrl+V（web 终端默认行为）"
          style={LINK_BTN}
        >
          提示
        </button>
        <button type="button" onClick={() => setFullscreen((v) => !v)} style={LINK_BTN}>
          {fullscreen ? '退出全屏' : '全屏'}
        </button>
      </div>
      <div
        ref={hostRef}
        style={{ flex: 1, minHeight: 0, padding: '0 4px 4px', overflow: 'hidden', boxSizing: 'border-box' }}
      />
    </div>
  )
}

const LINK_BTN: CSSProperties = {
  background: 'transparent',
  border: '1px solid rgba(128,128,128,0.4)',
  color: 'inherit',
  borderRadius: 4,
  fontSize: 12,
  padding: '2px 8px',
  cursor: 'pointer',
}
