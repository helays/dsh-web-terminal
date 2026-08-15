// dsh-web-terminal —— 「/terminal 切视图」的 carrier + 空白会话下的终端挂载点。
//
// 挂在 conversation.input.dock。它声明官方共享 chat store，其 inject 工厂拿到框架绑定到
// 【该会话 live 实例】的 actions.setView（index.tsx 里 registerCarrier + liveSetView 捕获），
// 供斜杠命令的 command/executed 本地确认复用。
//
// 为什么用 conversation.input.dock 而非 conversation.session.header.actions：
// header 在「新会话还没有任何对话、顶部还没有 tab」的 blank 态会整段隐藏
// （ui-conversation 的 headerHidden + aria-hidden，L6955-6958）——放它上面时 blank 的
// inject 工厂不跑、liveSetView 捕获不到 → /terminal 点了没反应。conversation.input.dock
// 在 blank/hero 与正常态都会渲染，捕获才稳定。
//
// 同时 blank 态下 conversation.session 主体直接 return null（L7035），视图环不渲染，
// 常规「tab 切到终端」走不通。因此这里在满足下面条件时就地挂一个 TerminalView，
// 用终端取代空白英雄页作为会话主体；非 blank 返回 null 交给常规视图环 tab（无双挂载）。
import { TerminalView } from './TerminalView.tsx'

export interface ViewSwitchCarrierInjected {
  ensureTerminal: (
    sessionId: string,
    cols: number,
    rows: number,
    cwd?: string,
  ) => Promise<string>
}

export interface ViewSwitchCarrierProps {
  sessionId: string
  ensureTerminal: ViewSwitchCarrierInjected['ensureTerminal']
  /** 共享 chat store 的只读 selector（声明 store 后由框架注入）。 */
  useStore: <S>(selector: (s: unknown) => S) => S
  /** 会话快照 selector（会话标准 kit）。 */
  useSession: <S>(selector: (s: unknown) => S) => S
  /** 当前会话关联 workspace 绝对路径（默认工作目录）。 */
  useWorkspaces?: <T = unknown>(selector: (s: unknown) => T) => T
  /** 声明 locale: NS 后的翻译函数。 */
  t: (key: 'view.terminal') => string
}

export function ViewSwitchCarrier({
  sessionId,
  ensureTerminal,
  useStore,
  useSession,
  useWorkspaces,
  t,
}: ViewSwitchCarrierProps) {
  const view = useStore((s) => (s as { view?: string | null }).view ?? null)
  const blank = useSession((s) => (s as { blank?: boolean }).blank ?? false)
  const composerPhase = useSession((s) => (s as { composerPhase?: string }).composerPhase ?? '')

  // blank 英雄态且切到「终端」：就地挂终端，取代空白对话页；非 blank 交给视图环 tab。
  const showBlankTerminal = blank === true && composerPhase === 'blank' && view === 'terminal'
  if (!showBlankTerminal) return null

  // dock 槽是 hero 卡片内的窄条带，直接挂 TerminalView 会被压成扁条；给一个可视高度，
  // 让它像「对话区里的终端面板」一样撑开（scrollBody 里 conversation.session 为 null，
  // 因此这块区域空着可被终端占据）。非 blank 由视图环 tab 接管，这里返回 null，无双挂载。
  return (
    <div
      data-dsh-terminal-blank
      style={{
        display: 'flex',
        boxSizing: 'border-box',
        width: '100%',
        maxWidth: 'var(--dsh-composer-card-max-width, 760px)',
        height: 'min(56vh, 460px)',
        minHeight: 240,
        margin: '0 auto',
        borderRadius: 12,
        border: '1px solid var(--dsw-alias-border-l2-darkmode-thin, rgba(120,120,128,0.35))',
        background: '#1e1e1e',
        overflow: 'hidden',
      }}
    >
      <TerminalView
        key="blank-terminal"
        sessionId={sessionId}
        ensureTerminal={ensureTerminal}
        t={t}
        useWorkspaces={useWorkspaces}
      />
    </div>
  )
}
