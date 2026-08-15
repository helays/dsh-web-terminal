import type { Context } from '@deepseek-ai/cordis'
// Type-only：client 侧服务（slots/locale/sessions）与槽位/命令契约的类型合并
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import { en, NS, zh } from './locales.ts'
import { TerminalView, type TerminalViewInjected } from './TerminalView.tsx'
import { TerminalSettingsCard } from './TerminalSettingsCard.tsx'
import { TerminalTrigger } from './TerminalTrigger.tsx'

const PREFIX = '/terminal'

/** cordis 服务级 inject：slots（槽位）、locale（字典）、sessions。 */
export const inject = ['slots', 'locale', 'sessions']

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

  // ===== 输入框识别 /terminal 并切到「终端」视图 =====
  // 不依赖 commandUi（那条链在当前 Web 装配里运行时不可靠，且曾致 loader 崩溃）。
  // 用 document 捕获阶段 keydown 拦截 composer 纯回车 + draft 命中，见 TerminalTrigger。
  // store handle 从 slots 注册表“抠”出 ui-conversation 的共享 chat store（chat 视图条目持有）：
  //     —— 声明同一 handle 后，渲染器把该会话的 bound actions(setView) 追加进组件 props。
  //     —— 拿不到就订阅等待，绝不让 apply 抛错（对齐「宁可降级」红线）。
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

  const registerTrigger = (chatStore: unknown): (() => void) => {
    // 关键：保持 `ctx.slots.register` 的 this 绑定——不能解构出方法再调用，
    // 否则 this 丢失会触发 slots 内部 `this.ctx.effect` 崩（此前 loader 报错即此因）。
    // type-only：chat store handle 未在包外公开契约，用宽松断言（运行时由渲染器按 handle 注入 actions）。
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (ctx.slots as any).register(
      {
        name: 'conversation.session.header.actions',
        id: 'dsh-web-terminal.terminal-trigger',
        order: 2000,
        store: chatStore as never,
        // 组件用标准 kit 的 useInput / inputActions + 注入的 actions(setView)
        inject: () => ({}),
      },
      TerminalTrigger,
    )
  }

  ctx.slots.inject('conversation.session.header.actions', () => {
    const handle = fishChatStore()
    if (handle !== undefined) return registerTrigger(handle)
    // 极端时序（本插件先于 ui-conversation apply）：订阅等 chat 条目出现，期间静默不注册
    const unsub =
      ctx.slots.subscribe?.('conversation.view', () => {
        const late = fishChatStore()
        if (late === undefined) return
        unsub?.()
        registerTrigger(late)
      }) ?? (() => {})
    return unsub
  })
}

// 别名导出，供 esbuild 的 factory 拿 { apply, inject }
export { TerminalView, TerminalSettingsCard }
