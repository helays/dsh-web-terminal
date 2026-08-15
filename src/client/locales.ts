/** dsh-web-terminal —— 字典（终端 tab 标签 + /terminal 命令 + 工具条）。 */
export const NS = 'terminal'

export type TerminalKey =
  | 'view.terminal'
  | 'command.terminal.desc'
  | 'terminal.new'
  | 'terminal.kind'
  | 'terminal.unnamed'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'terminal': TerminalKey
  }
}

export const zh: Record<TerminalKey, string> = {
  'view.terminal': '终端',
  'command.terminal.desc': '打开交互式终端 Tab',
  'terminal.new': '新建终端',
  'terminal.kind': '终端类型',
  'terminal.unnamed': '终端',
}
export const en: Record<TerminalKey, string> = {
  'view.terminal': 'Terminal',
  'command.terminal.desc': 'Open the interactive terminal tab',
  'terminal.new': 'New terminal',
  'terminal.kind': 'Terminal type',
  'terminal.unnamed': 'Terminal',
}
