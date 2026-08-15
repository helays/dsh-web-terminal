/** dsh-web-terminal —— 字典（终端 tab 标签 + /terminal 命令）。 */
export const NS = 'terminal'

export type TerminalKey =
  | 'view.terminal'
  | 'command.terminal'
  | 'command.terminal.detail'
  | 'command.terminal.desc'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'terminal': TerminalKey
  }
}

export const zh: Record<TerminalKey, string> = {
  'view.terminal': '终端',
  'command.terminal': '打开终端',
  'command.terminal.detail': '切到「终端」Tab（切换时才创建/连接 PTY 会话）',
  'command.terminal.desc': '打开交互式终端 Tab',
}
export const en: Record<TerminalKey, string> = {
  'view.terminal': 'Terminal',
  'command.terminal': 'Open terminal',
  'command.terminal.detail': 'Switch to the Terminal tab (PTY session is created lazily on switch)',
  'command.terminal.desc': 'Open the interactive terminal tab',
}
