import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { TerminalHost, type TerminalEntry, type TerminalKind } from './terminal.ts'
import type { TerminalKey } from './locales.ts'

const PREFIX = '/terminal'

const TERM_THEME = {
  foreground: '#e5e5e5',
  background: '#1e1e1e',
  selectionBackground: '#4a6da7',
} as const

/** 每种 kind 的短展示名（tab 标题 / auto 时按推荐显示）。 */
const KIND_SHORT: Record<string, string> = {
  auto: 'Shell',
  pwsh: 'PowerShell',
  powershell: 'Windows PowerShell',
  bash: 'Bash',
  zsh: 'Zsh',
  sh: 'sh',
  cmd: 'Command Prompt',
  python: 'Python',
  custom: 'Custom',
}

interface ShellCandidate {
  kind: string
  label: string
  available: boolean
}

/** 打开 xterm 样式 link（幂等）。 */
function injectXtermCss() {
  if (typeof document === 'undefined') return
  if (document.getElementById('dsh-web-terminal-xterm-css') !== null) return
  const link = document.createElement('link')
  link.id = 'dsh-web-terminal-xterm-css'
  link.rel = 'stylesheet'
  link.href = PREFIX + '/xterm.css'
  document.head.appendChild(link)
}

/** 单个终端 pane：xterm + ws，连接到 host PTY（宿主在 openPty 里惰性建并缓存 ptyId）。 */
function TerminalPane({
  sessionId,
  termKey,
  terminalHost,
  cwd,
}: {
  sessionId: string
  termKey: string
  terminalHost: TerminalHost
  cwd: string
}) {
  const hostRef = useRef<HTMLDivElement>(null)

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
    term.focus()
    const focusTimer = window.setTimeout(() => term.focus(), 150)

    let socket: WebSocket | null = null
    const initialCols = term.cols
    const initialRows = term.rows

    terminalHost
      .openPty(sessionId, termKey, {
        cols: initialCols || 80,
        rows: initialRows || 24,
        cwd: cwd || undefined,
      })
      .then((id) => {
        if (!alive) return
        const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
        const ws = new WebSocket(`${proto}//${location.host}${PREFIX}/ws/${id}`)
        socket = ws
        ws.onopen = () => {
          if (!alive) return
          term.focus()
        }
        ws.onmessage = (ev) => term.write(ev.data as string)
        ws.onclose = () => {
          /* 断线重连由重挂载/切换驱动；此处不自杀 */
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
      window.clearTimeout(focusTimer)
      if (socket) {
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
  }, [sessionId, termKey, terminalHost, cwd])

  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        padding: '0 4px 4px',
        overflow: 'hidden',
        boxSizing: 'border-box',
        background: '#1e1e1e',
      }}
      ref={hostRef}
    />
  )
}

interface TerminalViewProps {
  sessionId: string
  terminalHost: TerminalHost
  t: (key: TerminalKey) => string
  /** 标准套件：读当前 workspace 列表以取绝对路径（终端默认工作目录，跟随会话）。 */
  useWorkspaces?: <T = unknown>(selector: (s: unknown) => T) => T
}

export function TerminalView({ sessionId, terminalHost, t, useWorkspaces }: TerminalViewProps) {
  // 会话缓存里「当前这端的多终端列表」——本地状态，来源 host.getEntries（闭包持久）。
  const [entries, setEntries] = useState<TerminalEntry[]>(() =>
    [...terminalHost.getEntries(sessionId)],
  )
  const [activeKey, setActiveKey] = useState<string | null>(null)
  const [shells, setShells] = useState<ShellCandidate[]>([])

  // 首次进入：自动建一个 auto 终端；并行拉 shell 候选供下拉。
  useEffect(() => {
    terminalHost.getEntries(sessionId)
    if (terminalHost.getEntries(sessionId).length === 0) {
      const first = terminalHost.addEntry(sessionId, 'auto')
      setEntries([...terminalHost.getEntries(sessionId)])
      setActiveKey(first.key)
    } else {
      setEntries([...terminalHost.getEntries(sessionId)])
      setActiveKey(terminalHost.getEntries(sessionId)[0]?.key ?? null)
    }
    fetch(`${PREFIX}/config`)
      .then((r) => (r.ok ? r.json() : null))
      .then((b) => {
        const list = b?.shells as ShellCandidate[] | undefined
        if (Array.isArray(list)) setShells(list)
      })
      .catch(() => {
        /* 下拉候选加载失败则可降级为仅 auto */
      })
  }, [sessionId, terminalHost])

  const active = entries.find((e) => e.key === activeKey) ?? entries[0] ?? null

  // 切换会话：sessionId 变化重挂载本组件，重读该会话条目。
  const addTerminal = useCallback(() => {
    const entry = terminalHost.addEntry(sessionId, 'auto')
    setEntries([...terminalHost.getEntries(sessionId)])
    setActiveKey(entry.key)
  }, [sessionId, terminalHost])

  const removeTerminal = useCallback(
    (key: string) => {
      terminalHost.removeEntry(sessionId, key)
      const next = [...terminalHost.getEntries(sessionId)]
      setEntries(next)
      // 活动项被删则切到剩余第一个
      setActiveKey((cur) => (next.length ? (next.find((e) => e.key === cur)?.key ?? next[0].key) : null))
    },
    [sessionId, terminalHost],
  )

  const changeKind = useCallback(
    (key: string, kind: TerminalKind) => {
      terminalHost.setKind(sessionId, key, kind)
      setEntries([...terminalHost.getEntries(sessionId)])
    },
    [sessionId, terminalHost],
  )

  // 当前会话关联的 workspace 绝对路径（终端默认工作目录，跟随会话）
  const workspacePath = useWorkspaces?.((state: unknown) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const s = state as { items?: Array<{ path?: string; sessionIds?: string[] }> }
    const items = s?.items ?? []
    const hit = items.find((w) => (w.sessionIds ?? []).includes(sessionId)) ?? items[0] ?? null
    return hit?.path ?? ''
  }) ?? ''

  // 下拉候选：可用的 + 固定 auto
  const kindOptions = useMemo(() => {
    const avail = shells.filter((s) => s.kind !== 'auto' && s.kind !== 'custom' && s.available)
    return [{ kind: 'auto', label: '自动（按系统推荐）' }, ...avail]
  }, [shells])

  const toolbarStyle: CSSProperties = {
    display: 'flex',
    gap: 8,
    alignItems: 'center',
    padding: '6px 8px',
    flexShrink: 0,
    borderBottom: '1px solid rgba(128,128,128,0.25)',
  }
  const tabStyle = (isActive: boolean): CSSProperties => ({
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '3px 8px',
    border: '1px solid rgba(128,128,128,0.35)',
    borderRadius: 6,
    fontSize: 12,
    cursor: 'pointer',
    background: isActive ? 'rgba(80,140,230,0.22)' : 'transparent',
    color: 'inherit',
    whiteSpace: 'nowrap',
  })
  const addBtn: CSSProperties = {
    ...tabStyle(false),
    borderStyle: 'dashed',
    background: 'transparent',
    opacity: 0.8,
  }
  const closeX: CSSProperties = {
    border: 'none',
    background: 'transparent',
    color: 'inherit',
    opacity: 0.6,
    cursor: 'pointer',
    fontSize: 12,
    padding: 0,
    lineHeight: 1,
  }
  const selectStyle: CSSProperties = {
    background: 'rgba(128,128,128,0.08)',
    border: '1px solid rgba(128,128,128,0.35)',
    borderRadius: 6,
    padding: '3px 6px',
    color: 'inherit',
    fontSize: 12,
    fontFamily: 'inherit',
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: 0,
        boxSizing: 'border-box',
      }}
    >
      {/* 工具条：左 = 多终端 tab 卡片 +「+」；右 = 当前终端类型下拉 */}
      <div style={toolbarStyle}>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flex: 1, minWidth: 0, overflowX: 'auto' }}>
          {entries.map((e) => (
            <div style={tabStyle(e.key === active?.key)} key={e.key} onClick={() => setActiveKey(e.key)}>
              <span>{KIND_SHORT[e.kind] ?? e.kind}</span>
              <button
                type="button"
                aria-label="close terminal"
                title="关闭"
                style={closeX}
                onClick={(ev) => {
                  ev.stopPropagation()
                  removeTerminal(e.key)
                }}
              >
                ×
              </button>
            </div>
          ))}
          <button type="button" title={t('terminal.new')} aria-label={t('terminal.new')} style={addBtn} onClick={addTerminal}>
            +
          </button>
        </div>

        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, opacity: 0.75 }}>
          {t('terminal.kind')}
          <select
            style={selectStyle}
            value={active?.kind ?? 'auto'}
            disabled={!active}
            onChange={(ev) => {
              if (active) changeKind(active.key, ev.target.value as TerminalKind)
            }}
          >
            {kindOptions.map((o) => (
              <option key={o.kind} value={o.kind}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {/* 活动 pane：key 含 kind，切 shell 类型或切 tab 时重挂载重连 */}
      {active ? (
        <TerminalPane
          key={`${active.key}:${active.kind}`}
          sessionId={sessionId}
          termKey={active.key}
          terminalHost={terminalHost}
          cwd={workspacePath}
        />
      ) : (
        <div style={{ flex: 1 }} />
      )}
    </div>
  )
}
