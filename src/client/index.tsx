import type { Context } from '@deepseek-ai/cordis'
// Type-only：client 侧服务（slots/locale/sessions）与槽位契约的类型合并
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
// command/executed（host 目录命令在本机提交成功的本地确认）类型 + 事件声明
import type {} from '@deepseek-ai/dsh-client-ui-commands/client'
import { en, NS, zh } from './locales.ts'
import { TerminalView, type TerminalViewInjected } from './TerminalView.tsx'
import { TerminalSettingsCard } from './TerminalSettingsCard.tsx'
import { ViewSwitchCarrier } from './ViewSwitchCarrier.tsx'

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

  // ===== /terminal 就绪切「终端」视图（liveSetView 捕获） =====
  //
  // 用户要求：表现得像 /plan —— 敲 / 出现候选、方向键选中 + 回车即切换；且新会话
  // （顶部还没有 tabs、空会话 blank 态）输入 /terminal 也应切过去，对话框显示为空会话。
  // 触发时【绝不】创建 PTY 会话 / 绝不调 /terminal/ws/<id>（会话只在 TerminalView 挂载时惰性创建）。
  //
  // 切入点是纯回调（command/executed + 捕获的 setView），拿不到 React props 注入的 bound actions。
  // 唯一可靠的取到【该会话】live bound actions 的方式：让一个「blank 与否都会渲染」的会话作用域
  // 条目声明共享 chat store，其 inject 工厂会拿到框架绑定到 live 实例的 setView。
  // 因此 carrier 放 conversation.input.dock（hero/blank 与正常态都渲染；header.actions 在 blank
  // 会整段隐藏，捕获不到）。同时用它承载 blank 态下终端的就地挂载（见 ViewSwitchCarrier）。
  //
  // store handle 从 slots 注册表“抠”出 ui-conversation 的共享 chat store（chat 视图条目持有）。
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
    // 关键：保持 `ctx.slots.register` 的 this 绑定——不能解构出方法再调用，
    // 否则 this 丢失会触发 slots 内部 `this.ctx.effect` 崩（AGENTS §5.6，loader 曾报错）。
    // type-only：chat store handle 未在包外公开契约，用宽松断言（运行时由渲染器按 handle 注入 actions）。
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
          return { ensureTerminal }
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
  // host 半已把 terminal 注册为目录命令（无 input 字段）：
  //   - 于是它出现在「composer 左下角 + 图标」的 command 下拉（toggleSource("command") 只认这个源），
  //   - 且方向键选中 + 回车 = 单步直达（与 /plan 完全一致，无二级 popup）。
  // 真正的“切到「终端」Tab”在浏览器端做：host 命令执行成功 → 本机发 command/executed 确认 →
  // 这里收到 name==='terminal' 就切视图。命令路径绝不创建 PTY（只切视图；会话在 TerminalView 挂载时惰性建）。
  const switchToTerminal = (): void => {
    // 与点击「终端」tab 完全同一条写面；未捕获到 live setView（如尚无 header 渲染）则尝试兜底
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
export { TerminalView, TerminalSettingsCard }
