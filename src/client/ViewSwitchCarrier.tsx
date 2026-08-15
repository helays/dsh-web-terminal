// dsh-web-terminal —— 「/terminal 切视图」的哨兵 carrier。
//
// 本身零视觉占用（返回 null）。它的作用只有一个：让一个【始终渲染】的会话作用域
// 条目声明共享 chat store，从而在 inject 工厂里拿到框架绑定到【该会话 live 实例】的
// actions.setView（index.tsx 里的 registerCarrier + liveSetView 捕获），供命令弹窗的
// onSelect 复用 —— 与点击「终端」tab 走完全相同的写面。
//
// 注意：slots 判空会渲染本组件，但也可以让 index.tsx 直接用一个匿名组件；拆文件只为直观。
export function ViewSwitchCarrier(): null {
  return null
}
