# dsh-web-terminal

> **DSH 插件**：在 DeepSeek Harness Web 界面的「对话 / 轨迹」顶部新增第三个 **「终端」** Tab，内置交互式 PTY 终端（xterm.js 前端 + node-pty 后端），让你在编码完成后**即时在终端执行指令调试**。

[English](#english) · 中文

---

## ✨ 功能

- 顶部新增「终端」标签页，与「对话」「轨迹」并列。
- 真实 **PTY**（Windows 走 ConPTY，POSIX 用交互式 shell），支持：
  - 持续会话（多次命令，进程常驻，不用每次重开）
  - 实时流式输出
  - `Ctrl+C` 中断、窗口缩放 resize
  - 断线回放：切走再切回 / 刷新后自动重连并补回滚动历史（会话池在插件侧，跨会话保活）
- 全屏模式。
- 与模型 / agent 会话完全解耦 —— 这是**你自己的终端**，不占用对话上下文。

## 📦 安装

### 方式一：本地开发（从插件目录）

```bash
cd dsh-web-terminal
npx @deepseek-ai/dsh plugin --profile web add . -w
# 然后重启 dsh web，再刷新页面
```

### 方式二：从 GitHub 安装（已发布）

```bash
# 首次安装（pin 到 commit，稳定可复现）
dsh plugin --profile web add dsh-web-terminal@github:helays/dsh-web-terminal#89a82f2cce1d471a7f9ffab3f9ee164b19733a8d -w
# 更新到最新 main
dsh plugin --profile web add dsh-web-terminal@github:helays/dsh-web-terminal#main -w
# 重启 dsh web，再刷新页面
```

> ⚠️ **`-w` 是必需的**：当前 dsh profile 模板是 pnpm workspace 根（`pnpm-workspace.yaml` 含 `packages: [.]`），不带 `-w` 会报 `ERR_PNPM_ADDING_TO_ROOT`。`dsh plugin` 会将其余参数原样转发给 pnpm，`-w` 会一并传给 `add`。
>
> 安装后 **必须重启 `dsh web`**（插件集合变化需重启生效），然后刷新浏览器页面进入任意会话即可看到「终端」Tab。

## 🚀 使用

1. 打开一个会话（空白/无会话页不显示 tab 栏）。
2. 点击顶部「终端」标签。
3. 在终端里输入命令回车执行，例如：
   ```
   dir            # Windows 列目录
   npm run build  # 编码后快速构建
   git status     # 查看改动
   ```
4. 顶栏可切换**全屏**。

## 🧩 技术实现

- **前端**：`@xterm/xterm` + `@xterm/addon-fit`，打包进 client bundle（`lib/client.js`），经 `window.__ModuleLoader__.load({ id, factory })` 注册。
- **后端**：`node-pty` spawn 真实 PTY + `ws` WebSocket。通过 `ctx.webServer` 提供：
  - `GET/POST/DELETE /terminal/sessions` —— 会话管理
  - `UPGRADE /terminal/ws/<id>` —— 双向字节流 + resize
  - `GET /terminal/xterm.css` —— xterm 样式
- **UI 接入**：`ctx.slots.inject('conversation.view', …)` 注册 `id:'terminal'` 的 tab（与官方 `dsh-client-ui-trajectory` 一致）。
- 不依赖 agent 会话，会话池由插件 apply 闭包持有。

## 🔧 开发

```bash
pnpm install        # 安装依赖（含类型）
pnpm build          # 产出 lib/index.js + lib/client.js + lib/client.css
pnpm typecheck      # tsc --noEmit 类型检查
```

- 改 **host half**（`src/`）需重启 `dsh web`。
- 改 **client half**（`src/client/`）重装插件 + 刷新页面即可。

## 📚 新版本发布

1. 修改版本号并构建：`pnpm build`。
2. 提交（含 `lib/`）并推送。
3. 打 tag / 更新 README 里的 `<commit>` 引用。
4. 检查仓库 topics：`dsh`、`dsh-bundle`、`deepseek-harness`、`dsh-plugin`（自动进入 Oh-My-DSH 等目录站同步）。

## 📄 项目描述（GitHub，粘贴到仓库 About）

> DSH 插件：在 DeepSeek Harness Web 界面（对话/轨迹）顶部新增「终端」Tab，内置 xterm.js + node-pty 交互式终端（Windows 走 ConPTY），让你在编码完成后即时在终端执行指令调试。会话与模型/agent 解耦，跨会话保活。安装：`dsh plugin --profile web add dsh-web-terminal@github:helays/dsh-web-terminal#89a82f2cce1d471a7f9ffab3f9ee164b19733a8d -w`

**GitHub topics（在仓库 About → Topics 里添加）**：`dsh`、`dsh-bundle`、`deepseek-harness`、`dsh-plugin`、`terminal`

## License

MIT

---

## English

A DSH bundle plugin that adds an interactive **Terminal** tab (xterm.js + node-pty, Windows ConPTY) beside Chat/Trajectory in the DeepSeek Harness Web UI — for quickly running debug commands after coding. Sessions are decoupled from model/agent and survive tab switches.

**Install:**
```bash
dsh plugin --profile web add dsh-web-terminal@github:helays/dsh-web-terminal#89a82f2cce1d471a7f9ffab3f9ee164b19733a8d -w
```
Restart `dsh web`, refresh, open a session, switch to the **Terminal** tab.
