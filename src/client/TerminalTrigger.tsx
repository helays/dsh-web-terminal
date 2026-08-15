// dsh-web-terminal —— 输入框识别 /terminal 并切到「终端」视图。
// 不依赖 commandUi / input-trigger（那条链在当前 Web 装配里不可靠）。
// 在 document 捕获阶段拦「composer 纯回车 + draft 命中定式」：
//   阻止提交（不发给 agent）→ 切视图 setView('terminal') → 清空 draft。
// 挂载于恒挂载的会话头部 actions 槽位，共享 ui-conversation 的 chat store，
// 使 setView 走与「点 tab」完全相同的写面。返回 null，零视觉占用。
import { useEffect, useRef } from 'react'

/** 触发定式：draft 以 /terminal 开头（词边界）。如需严格整行，改为 /^\/terminal\s*$/ */
const TERMINAL_RE = /^\/terminal\b/

interface TerminalTriggerProps {
  useInput: (selector: (s: { draft: string }) => string) => string
  inputActions: { setDraft(text: string): void }
  actions: { setView(view: string): void }
}

export function TerminalTrigger({ useInput, inputActions, actions }: TerminalTriggerProps): null {
  // 实时 draft（标准 kit 会话 input 钩子）；ref 把最新值带进 DOM 捕获回调
  const draft = useInput((s) => s.draft)
  const draftRef = useRef(draft)
  draftRef.current = draft

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      // 只拦纯回车：重复按键 / IME 合成 / Shift(换行) / Ctrl+Meta(加速插话) / Alt 一律放行
      if (e.key !== 'Enter' || e.repeat) return
      if (e.isComposing || (e as KeyboardEvent & { keyCode?: number }).keyCode === 229) return
      if (e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return
      // 目标必须是 composer 的输入框（data-composer-card 是 InputBar 卡片特征）
      const target = e.target
      if (!(target instanceof HTMLTextAreaElement)) return
      if (!target.closest('[data-composer-card]')) return
      if (!TERMINAL_RE.test(draftRef.current)) return

      // 捕获相位先于 React 根容器的 onKeyDown：提交被彻底阻止（不发 agent）
      e.preventDefault()
      e.stopImmediatePropagation()
      // 切视图（共享 chat store —— 与 tab 点击同一条写面）
      actions.setView('terminal')
      // 清空 draft（输入机器事务，驱动受控 textarea + mirror 到 store）
      inputActions.setDraft('')
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [actions, inputActions])

  return null
}
