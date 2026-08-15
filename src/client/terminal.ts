// dsh-web-terminal —— client 共享类型（浏览器安全，无 host 依赖）。
// TerminalKind 与 host 的 src/resolve.ts 保持同构字符串联合，但不 import host 文件，
// 以免把 node:child_process 等 host 依赖混进 client bundle。

/** shell 类型（与 host resolve.ts 的 TERMINAL_KINDS 对齐）。 */
export type TerminalKind =
  | 'auto'
  | 'pwsh'
  | 'powershell'
  | 'bash'
  | 'zsh'
  | 'sh'
  | 'cmd'
  | 'python'
  | 'custom'

/** 一个会话下的某个终端 tab 的持久态（会话生命周期内；刷新重建）。 */
export interface TerminalEntry {
  /** 本地唯一 id（同会话内自增）。 */
  key: string
  /** shell 类型。 */
  kind: TerminalKind
  /** 后端 PTY 会话 id；未创建时为空（某 pane 挂载时才惰性建）。 */
  ptyId: string | null
}

/** 注入给终端视图固件的终端注册表（跨视图/会话保活；会话池在本插件 apply 闭包）。 */
export interface TerminalHost {
  /** 某会话的所有终端 tab。 */
  getEntries(sessionId: string): readonly TerminalEntry[]
  /** 新增一个终端 tab（默认 auto）；返回新条目。 */
  addEntry(sessionId: string, kind?: TerminalKind): TerminalEntry
  /** 删除某终端 tab（含其 host PTY，若已建）。 */
  removeEntry(sessionId: string, key: string): void
  /** 改变某终端 tab 的 shell 类型：清空已建 PTY（删除旧 PTY），下次 open 时按新 kind 重建。 */
  setKind(sessionId: string, key: string, kind: TerminalKind): void
  /** 惰性创建/复用某终端 tab 的 host PTY，返回后端 terminalId（带 kind/cwd）。 */
  openPty(
    sessionId: string,
    key: string,
    opts: { cols: number; rows: number; cwd?: string },
  ): Promise<string>
}
