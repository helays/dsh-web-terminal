import type { Context } from '@deepseek-ai/cordis'
// Type-only：client 侧服务（slots/locale/sessions）与槽位契约的类型合并
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
// inputTriggers：官方斜杠管线（/plan /model 走的同一管道）。注册一个独立 slash source，
// 让 /terminal 像其它命令一样「方向键选中 + 回车」单步直达（不走 commandUi 的二级 popupSelect）。
import type { InputTriggerSource } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type {} from '@deepseek-ai/dsh-client-ui-input-trigger/client'
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
  // 用户要求：表现得与官方 /plan /model 一致 —— 敲 / 出现候选、方向键选中 + 回车即切换，
  // 且触发时【绝不】创建 PTY 会话 / 绝不调 /terminal/ws/<id>（会话只在 TerminalView 挂载时惰性创建）。
  //
  // onPick / onSelect 是纯回调、没有 React props 注入的 bound actions。要切换到通用 chat store 的
  // 「活跃视图」，唯一可靠的取到【该会话】live bound actions 的方式，是让一个始终渲染的
  // 会话作用域条目声明共享 chat store，其 inject 工厂会拿到框架绑定到 live 实例的 setView。
  // 这里用恒挂载的 header.actions 槽位作 carrier，把 setView 捕进 apply 闭包，供斜杠源调用。
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
        name: 'conversation.session.header.actions',
        id: 'dsh-web-terminal.view-switch-carrier',
        order: 2000,
        store: chatStore as never,
        // 每次该会话 header 渲染都会带 live bound actions；捕获 setView 供 /terminal 复用
        inject: (_sessionId: string, actions: { setView(view: string): void }) => {
          liveSetView = actions.setView
          return {}
        },
      },
      ViewSwitchCarrier,
    )
  }

  ctx.slots.inject('conversation.session.header.actions', () => {
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

  // ===== /terminal 单步斜杠源（与 /plan /model 同一管线） =====
  // /plan /model 是目录命令：在感叹号下拉里方向键选中 + 回车 = 立即执行（单步）。
  // commandUi 的 client「贡献」只支持 popupSelect（选中后还会弹一个二级 shell——多一步，
  // 且不是“回车即切换”）。因此这里不注册 commandUi 贡献，而是直接向 inputTriggers 注册
  // 一个独立 slash source：候选 /terminal → onPick 立即切视图并清掉 token（单步直达）。
  // 同样依赖完整 UI 装配，用条件注入，不可用则静默跳过（AGENTS §5.5）。
  ctx.inject(['inputTriggers'], (sub) => {
    let dispose: (() => void) | null = null
    try {
      const source: InputTriggerSource = {
        trigger: '/',
        name: 'terminal',
        order: 200,
        candidates: async (): Promise<ReadonlyArray<{ name: string; description: string }>> => [
          { name: 'terminal', description: t('command.terminal.desc') },
        ],
        onPick: (_pick) => {
          // 选中即切视图（与点击「终端」tab 同一条写面；session 恒为 agent 支撑）
          liveSetView?.('terminal')
          // {text:''} 会把草稿里的 /terminal token span 替换为空白 → 清掉 token
          return { text: '' }
        },
        matchEnter: async (session, line) => {
          const trimmed = line.trim()
          if (trimmed !== '/terminal') return undefined
          liveSetView?.('terminal')
          // 裸 /terminal + 回车：抑制默认发送并切换（adjudicate 的 text/handled 均不会默认发送）
          return 'handled'
        },
      }
      dispose = sub.inputTriggers.registerSource(source)
    } catch (err) {
      // 注册异常（重名等）：绝不让 apply 崩掉正在运行的 web
      console.error('dsh-web-terminal: register slash source failed', err)
      dispose = null
    }
    return () => {
      dispose?.()
      liveSetView = null
    }
  })
}

// 别名导出，供 esbuild 的 factory 拿 { apply, inject }
export { TerminalView, TerminalSettingsCard }
