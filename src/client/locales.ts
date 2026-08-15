/** dsh-web-terminal —— 字典（终端 tab 标签）。 */
export const NS = 'terminal'

export type TerminalKey = 'view.terminal'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'terminal': TerminalKey
  }
}

export const zh: Record<TerminalKey, string> = { 'view.terminal': '终端' }
export const en: Record<TerminalKey, string> = { 'view.terminal': 'Terminal' }
