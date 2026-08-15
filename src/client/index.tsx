import type { Context } from '@deepseek-ai/cordis'
// Type-only：client 侧服务（slots/locale/sessions）与槽位契约的类型合并
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-runtime/client'
// command/executed（host 目录命令在本机提交成功的本地确认）类型 + 事件声明
import type {} from '@deepseek-ai/dsh-client-ui-commands/client'
import { en, NS, zh } from './locales.ts'
import { TerminalView } from './TerminalView.tsx'
import { ViewSwitchCarrier } from './ViewSwitchCarrier.tsx'
import type { TerminalEntry, TerminalHost, TerminalKind } from './terminal.ts'

const PREFIX = '/terminal'

/** cordis 服务级 inject：slots（槽位）、locale（字典）、sessions。 */
export const inject = ['slots', 'locale', 'sessions']

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-web-terminal: dictionaries')
  const t = ctx.locale.bind(NS)

  // ===== 多终端注册表（插件级 apply 闭包，按对话会话分开；host PTY 会话池在 host 侧） =====
  const entriesBySession = new Map<string, TerminalEntry[]>()
  let tabSeq = 0

  const forSession = (sessionId: string): TerminalEntry[] => {
    let list = entriesBySession.get(sessionId)
    if (!list) {
      list = []
      entriesBySession.set(sessionId, list)
    }
    return list
  }

  /** 删除 host 侧 PTY（尽力，失败仅告警不抛）。 */
  const deleteHostPty = (ptyId: string): void => {
    fetch(`${PREFIX}/sessions/${encodeURIComponent(ptyId)}`, { method: 'DELETE' }).catch(() => {
      /* 尽力释放 */
    })
  }

  const terminalHost: TerminalHost = {
    getEntries(sessionId) {
      return forSession(sessionId)
    },
    addEntry(sessionId, kind = 'auto') {
      const list = forSession(sessionId)
      const entry: TerminalEntry = { key: `t${++tabSeq}`, kind, ptyId: null }
      list.push(entry)
      return entry
    },
    removeEntry(sessionId, key) {
      const list = forSession(sessionId)
      const entry = list.find((e) => e.key === key)
      if (entry?.ptyId) deleteHostPty(entry.ptyId)
      const next = list.filter((e) => e.key !== key)
      entriesBySession.set(sessionId, next)
      if (next.length === 0) entriesBySession.delete(sessionId)
    },
    setKind(sessionId, key, kind) {
      const entry = forSession(sessionId).find((e) => e.key === key)
      if (!entry || entry.kind === kind) return
      if (entry.ptyId) {
        deleteHostPty(entry.ptyId)
        entry.ptyId = null
      }
      // 保持引用，直接改字段（条目对象就地突变，视图按 key/kind 重挂 pane）
      entry.kind = kind
    },
    async openPty(sessionId, key, { cols, rows, cwd }) {
      const entry = forSession(sessionId).find((e) => e.key === key)
      if (!entry) throw new Error(`dsh-web-terminal: unknown terminal ${key}`)
      if (entry.ptyId) return entry.ptyId
      const res = await fetch(`${PREFIX}/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          cols,
          rows,
          cwd: cwd || undefined,
          kind: entry.kind,
        }),
      })
      if (!res.ok) throw new Error(`dsh-web-terminal: 创建会话失败 ${res.status}`)
      const body = await res.json()
      entry.ptyId = body.id as string
      return entry.ptyId
    },
  }

  // 注入面：把 terminalHost 交给「终端 tab」
  ctx.slots.inject('conversation.view', () =>
    ctx.slots.register(
      {
        name: 'conversation.view',
        id: 'terminal',
        order: 20,
        locale: NS,
        label: () => t('view.terminal'),
        inject: () => ({
          terminalHost,
        }),
      },
      TerminalView,
    ),
  )

  // ===== /terminal 就绪切「终端」视图（liveSetView 捕获） =====
  //
  // 切入点是纯回调（command/executed + 捕获的 setView），拿不到 React props 注入的 bound actions。
  // 唯一可靠的取到【该会话】live bound actions 的方式：让一个「blank 与否都会渲染」的会话作用域
  // 条目声明共享 chat store，其 inject 工厂会拿到框架绑定到 live 实例的 setView。
  // 因此 carrier 放 conversation.input.dock（hero/blank 与正常态都渲染；header.actions 在 blank
  // 会整段隐藏，捕获不到）。同时用它承载 blank 态下终端的就地挂载（见 ViewSwitchCarrier）。
  let liveSetView: ((view: string) => void) | null = null

  const fishChatStore = (): unknown => {
    try {
      const raw = ctx.slots.entries?.('conversation.view') as unknown as
        | Array<{ options?: { id?: string }; store?: unknown }>
        | undefined
      return (raw ?? []).find((e) => e.options?.id === 'chat')?.store
    } catch {
      return undefined
    }
  }

  const registerCarrier = (chatStore: unknown): (() => void) => {
    // 保持 `ctx.slots.register` 的 this 绑定（AGENTS §5.6）。
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (ctx.slots as any).register(
      {
        name: 'conversation.input.dock',
        id: 'dsh-web-terminal.view-switch-carrier',
        order: 2000,
        locale: NS,
        store: chatStore as never,
        // 每次该会话 dock 渲染都会带 live bound actions；捕获 setView 供 /terminal 复用
        inject: (_sessionId: string, actions: { setView(view: string): void }) => {
          liveSetView = actions.setView
          return { terminalHost }
        },
      },
      ViewSwitchCarrier,
    )
  }

  ctx.slots.inject('conversation.input.dock', () => {
    const handle = fishChatStore()
    if (handle !== undefined) return registerCarrier(handle)
    // 极端时序（本插件先于 ui-conversation apply）：订阅等 chat 条目出现，期间静默不注册
    const unsub =
      ctx.slots.subscribe?.('conversation.view', () => {
        const late = fishChatStore()
        if (late === undefined) return
        unsub?.()
        registerCarrier(late)
      }) ?? (() => {})
    return unsub
  })

  // ===== /terminal 单步执行：走 host 目录命令 + 本地确认 =====
  const switchToTerminal = (): void => {
    if (liveSetView) {
      liveSetView('terminal')
      return
    }
    console.warn('dsh-web-terminal: /terminal executed but no live view store captured yet')
  }

  ctx.on('command/executed', (_sessionId, name) => {
    if (name === 'terminal') switchToTerminal()
  })
}

// 别名导出，供 esbuild 的 factory 拿 { apply, inject }
export { TerminalView }
