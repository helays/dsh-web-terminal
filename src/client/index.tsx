import type { Context } from '@deepseek-ai/cordis'
// Type-only：client 侧服务（slots/locale/sessions/commandUi）与槽位/命令契约的类型合并
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import type {} from '@deepseek-ai/dsh-client-ui-commands/client'
import { en, NS, zh } from './locales.ts'
import { TerminalView, type TerminalViewInjected } from './TerminalView.tsx'
import { TerminalSettingsCard } from './TerminalSettingsCard.tsx'

const PREFIX = '/terminal'

/** cordis 服务级 inject：slots、locale、sessions、commandUi（/terminal 斜杠命令）。 */
export const inject = ['slots', 'locale', 'sessions', 'commandUi']

/** 恒挂载的空渲染条目：持有与 ui-conversation 共享的 chat store handle，
 * 捕获每会话 setView bound actions，供 /terminal 命令切换视图用。 */
function ViewSwitchCapture(): null {
  return null
}

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-web-terminal: dictionaries')
  const t = ctx.locale.bind(NS)

  // ===== 插件级 PTY 会话池缓存（apply 闭包） =====
  const terminalBySession = new Map()

  const ensureTerminal = async (
    sessionId: string,
    cols: number,
    rows: number,
    cwd?: string,
  ): Promise<string> => {
    let id = terminalBySession.get(sessionId)
    if (!id) {
      const res = await fetch(`${PREFIX}/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cols, rows, cwd: cwd || undefined }),
      })
      if (!res.ok) throw new Error(`dsh-web-terminal: 创建会话失败 ${res.status}`)
      const body = await res.json()
      id = body.id
      terminalBySession.set(sessionId, id)
    }
    return id
  }

  // 注入面：把 ensureTerminal 交给「终端 tab」
  ctx.slots.inject('conversation.view', () =>
    ctx.slots.register(
      {
        name: 'conversation.view',
        id: 'terminal',
        order: 20,
        locale: NS,
        label: () => t('view.terminal'),
        inject: () => ({
          ensureTerminal,
        }),
      },
      TerminalView,
    ),
  )

  // 自绘「终端」配置卡片
  ctx.slots.inject('settings.plugin.item', () =>
    ctx.slots.register(
      {
        name: 'settings.plugin.item',
        id: 'terminal',
        order: 20,
        locale: NS,
      },
      TerminalSettingsCard,
    ),
  )

  // ===== /terminal 斜杠命令：切到「终端」视图 =====
  // 官方把活跃视图 id 存在共享 chat store，写面是「声明同一 store handle 的条目」被渲染器
  // 追加的 bound actions。类型层未向第三方暴露该 store/actions 契约（运行时存在，调研确认），
  // 故此处用宽松断言；再在恒挂载的 header.actions 槽位捕获每会话 setView。
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const registerWithStore = (ctx as any).slots.register as (...args: any[]) => () => void
  const viewActions = new Map<string, { setView(view: string): void }>()

  ctx.slots.inject('conversation.session.header.actions', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rawEntries = ctx.slots.entries?.('conversation.view') as unknown as any[] | undefined
    const chatEntries = (rawEntries ?? []) as Array<{ options?: { id?: string }; store?: unknown }>
    const chatEntry = chatEntries.find((e) => e.options?.id === 'chat')
    const chatStore = chatEntry?.store
    if (chatStore === undefined) return () => {}
    return registerWithStore(
      {
        name: 'conversation.session.header.actions',
        store: chatStore, // 声明共享 handle → 渲染器把 bound actions 追加进 inject 参数
        id: 'dsh-web-terminal.view-switch',
        order: 1000,
        inject: (sessionId: string, actions: unknown) => {
          const set = (actions as { setView?: (v: string) => void } | undefined)?.setView
          if (typeof set === 'function') {
            viewActions.set(sessionId, { setView: set })
          }
          return {}
        },
      },
      ViewSwitchCapture,
    )
  })

  ctx.commandUi.register({
    name: 'terminal',
    description: '切换到「终端」视图',
    available: () => true,
    ui: {
      kind: 'popupSelect',
      options: async () => [{ id: 'terminal', label: t('view.terminal') }],
      onSelect: (_option, session) => {
        viewActions.get(session.sessionId)?.setView('terminal')
      },
    },
  })
}

// 别名导出，供 esbuild 的 factory 拿 { apply, inject }
export { TerminalView, TerminalSettingsCard }
