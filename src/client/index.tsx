import type { Context } from '@deepseek-ai/cordis'
// Type-only：client 侧服务（slots/locale/sessions）与 SlotMap('conversation.view') 的类型合并
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-runtime/client'
import { en, NS, zh } from './locales.ts'
import { TerminalView, type TerminalViewInjected } from './TerminalView.tsx'

const PREFIX = '/terminal'

const TERMINAL_ID_TAG = 'dsh-web-terminal-id'

/** cordis 服务级 inject：slots（注册槽位）、locale（字典）、sessions（会话 id）。 */
export const inject = ['slots', 'locale', 'sessions']

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-web-terminal: dictionaries')
  const t = ctx.locale.bind(NS)

  // ===== 插件级 PTY 会话池缓存（apply 闭包） =====
  // conversation sessionId -> 后端 terminalId；视图挂载时惰性创建，只 attach 不销毁。
  const terminalBySession = new Map()

  const ensureTerminal = async (
    sessionId: string,
    cols: number,
    rows: number,
  ): Promise<string> => {
    let id = terminalBySession.get(sessionId)
    if (!id) {
      const res = await fetch(`${PREFIX}/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cols, rows }),
      })
      if (!res.ok) throw new Error(`dsh-web-terminal: 创建会话失败 ${res.status}`)
      const body = await res.json()
      id = body.id
      terminalBySession.set(sessionId, id)
    }
    return id
  }

  // 注入面：把 ensureTerminal 交给视图（inject 工厂必须同步）
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
}

// 别名导出，供 esbuild 的 factory 拿 { apply, inject }
export { TerminalView }
