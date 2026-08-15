<!--
  dsh-web-terminal — README (sales-oriented, bilingual)。
  徽章为 shields.io；GitHub 动态徽章（stars/contributors）在仓库公开后自动生效。
-->

<div align="center">

# 🖥️ dsh-web-terminal

**在 DeepSeek Harness 里，给你的 AI 编码工作台嵌一块「真·终端」。**

内置 **xterm.js + node-pty** 的交互式 **PTY** 终端，作为第三个 Tab（对话 · 轨迹 · **终端**）挂在 Web UI 顶部。
模型跑完代码后，你**不用切窗口、不用离开对话**，直接在旁边开一个你自己的 shell —— 立即构建、git、测试、调试。

</div>

<p align="center">
  <a href="https://github.com/helays/dsh-web-terminal/blob/main/LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-yellowgreen.svg?style=flat-square"/></a>
  <a href="https://github.com/helays/dsh-web-terminal/releases"><img alt="Version" src="https://img.shields.io/badge/version-0.1.0-blue.svg?style=flat-square"/></a>
  <a href="https://www.deepseek.com/harness"><img alt="DeepSeek Harness" src="https://img.shields.io/badge/platform-DeepSeek%20Harness-4f8cff.svg?style=flat-square"/></a>
  <a href="https://github.com/helays/dsh-web-terminal"><img alt="dsh-plugin" src="https://img.shields.io/badge/type-dsh--plugin-7c3aed.svg?style=flat-square"/></a>
  <a href="https://github.com/helays/dsh-web-terminal"><img alt="Stars" src="https://img.shields.io/github/stars/helays/dsh-web-terminal?style=flat-square&logo=github" /></a>
  <a href="https://github.com/helays/dsh-web-terminal"><img alt="Last commit" src="https://img.shields.io/github/last-commit/helays/dsh-web-terminal?style=flat-square" /></a>
</p>

<p align="center">
  <a href="#readme">中文</a> · <a href="#english-readme">English</a>
</p>

---

## 💡 一分钟看懂

| 🤯 痛点 | ✅ dsh-web-terminal |
|---|---|
| 模型改完代码，只能 **复制粘贴** 回自己的终端的复现 | 在对话**旁边**打开一块**真实 PTY**，命令即输即跑 |
| 一切都要挤进对话上下文，token 和噪音翻倍 | 终端与 **模型 / agent 会话完全解耦**——是你的私有终端，**零上下文占用** |
| 换会话/刷新后命令和会话丢失，得重头再来 | **跨会话保活**：切走切回 / 刷新，自动重连并补回滚动历史 |
| 每次只为一个命令开一次性 shell，效率低 | **持续进程**：打开一次，多次命令、常驻 shell（Ctrl+C 中断可再跑） |

> 一句话：**把“写代码”和“跑代码”放进同一个界面，互不干扰。**

---

## ✨ 核心卖点

- 🗂️ 第三个 **「终端」Tab**，与「对话 / 轨迹」并列，一键切换。
- 🧯 **真实 PTY，不是伪终端**：
  - Windows 走 **ConPTY**，POSIX 用交互式 shell；
  - 支持 `Ctrl+C` / `Ctrl+D` 等控制键、`resize` 窗口自适应、彩色 + 光标闪烁；
  - 持续会话（进程常驻，多次命令，不用每次重开）。
- 🔄 **会话保活 + 断线回放**：切走再切回、甚至刷新页面，自动重连并补齐滚动历史（会话池在插件侧持有）。
- 🚪 **零侵入对话**：完全独立于 agent 流，不占用上下文 token，不混入会话记录。
- ⚡ **即时可用**：默认零配置 —— Windows 自动用 PowerShell，POSIX 自动用 bash；可在设置面板一键换 `bash / zsh / pwsh / powershell / cmd / python` 或自定义 shell 路径。
- ⌨️ 在 composer 输入 `/terminal`，候选一键直达终端（与官方 `/plan` 同源的单步命令），连空会话也能开终端。
- 🧩 纯 DSH bundle 插件，安装即用，与官方 UI 槽位原生集成。

---

## 🚀 快速开始

> 环境：DeepSeek Harness **`0.1.0-rc.6`（next 通道）** 的 `web` profile。

### 安装

```bash
# 方式一：GitHub（推荐，稳定可复现）
dsh plugin --profile web add dsh-web-terminal@github:helays/dsh-web-terminal#main -w

# 方式二：本地开发目录
cd dsh-web-terminal && dsh plugin --profile web add . -w
```

> ⚠️ **`-w` 必须带**：当前 dsh profile 模板是 pnpm workspace 根（`pnpm-workspace.yaml` 含 `packages: [.]`），
> 不带会报 `ERR_PNPM_ADDING_TO_ROOT`。`dsh plugin` 会把其余参数原样转发给 pnpm。
>
> 安装后**重启 `dsh web`**（插件集合/宿主变化需重启生效），再刷新浏览器页面。

### 使用

1. 打开任意会话（进入后顶部出现 **对话 · 轨迹 · 终端**）；
2. 点「**终端**」，或在输入框输 `/terminal`；
3. 直接输命令，例如：

```bash
npm run build   # 改完代码立刻构建
git status      # 查看改动
pytest          # 跑测试
```

4. 顶栏可看连接状态；想隐藏时切回「对话」即可——**终端和会话都还在**。

---

## 🧩 技术栈

| 层 | 选型 | 说明 |
|---|---|---|
| 前端终端 | [`@xterm/xterm`](https://github.com/xtermjs/xterm.js) + `@xterm/addon-fit` | 打包进 client bundle（`lib/client.js`），`__ModuleLoader__.load` 注册 |
| 后端 PTY | [`node-pty`](https://github.com/microsoft/node-pty) | 原生 PTY（Windows ConPTY / POSIX pty），进程常驻 |
| 传输 | [`ws`](https://github.com/websockets/ws) | 经 `ctx.webServer` 提供 WebSocket 双向字节流 + resize |
| UI 装配 | `ctx.slots.inject('conversation.view')` | 注册 `id:'terminal'` tab，与官方 `dsh-client-ui-trajectory` 同构 |

### 为什么是“真”终端 & 与官方 `dsh-terminal` 的区别

dsh 自带 `ctx.terminals` 是 **Agent 所有权 + 模型面 line-oriented** 语义，无浏览器传输、Windows 下不可用。
我们选择直接用 `node-pty` **spawn 一个完全属于你的 shell**，与 agent 会话彻底解耦——这是**你自己的终端**。

---

## 🔧 本地开发

```bash
pnpm install     # 依赖（含类型）
pnpm build       # 产出 lib/index.js + lib/client.js + lib/client.css
pnpm typecheck   # tsc --noEmit
```

- 改 **host half**（`src/`）：重启 `dsh web`；
- 改 **client half**（`src/client/`）：重装 + 刷新页面即可。

---

## ❓ FAQ

**Q：这个终端会占用我的对话上下文吗？**
不会。终端与模型/agent 会话完全解耦，不写入上下文，也不混入会话记录。

**Q：重启/刷新后会话还在吗？**
在。会话池由插件持有，跨会话、跨刷新保活；重连后自动补回最近的输出历史。

**Q：只想临时跑一条命令，也要开终端吗？**
打开后进程常驻，你可以在里面持续操作；切走再切回仍是同一个 shell。

**Q：能换 shell / 自定义路径吗？**
可以。在「设置 → 插件 → 终端」面板里切换 `bash / zsh / pwsh / powershell / cmd / python`，或填自定义 shell 绝对路径与附加参数。默认 Windows→PowerShell、POSIX→bash 自动识别。

---

## 📄 GitHub 仓库信息（About）

**Description（一句话）**
> DSH 插件：给 DeepSeek Harness 的 Web 界面加一个独立的真实 PTY「终端」Tab（xterm.js + node-pty，Windows ConPTY），编码后即时跑命令，与模型会话解耦、跨会话保活。

**Topics**
> `dsh` · `dsh-bundle` · `deepseek-harness` · `dsh-plugin` · `terminal` · `xterm` · `node-pty`

> 添加 topics 后，插件会被 Oh-MY-DSH 等目录站自动收录，被更多人发现。

---

## 📝 License

[MIT](./LICENSE) © [helays](https://github.com/helays)

---

<br/>

# <a name="english-readme"></a> 🖥 English

> **A real PTY Terminal as a first-class tab inside DeepSeek Harness** — build, debug, and run commands right next to your AI conversation, without leaving the page.

<div align="center">

![License](https://img.shields.io/badge/License-MIT-yellowgreen?style=flat-square)
![Version](https://img.shields.io/badge/version-0.1.0-blue?style=flat-square)
![Platform](https://img.shields.io/badge/platform-DeepSeek%20Harness-4f8cff?style=flat-square)
![Type](https://img.shields.io/badge/type-dsh--plugin-7c3aed?style=flat-square)

</div>

**Why you'll love it**

- 🗂️ A dedicated **Terminal** tab next to Chat & Trajectory.
- 🧯 A **real PTY** (Windows ConPTY / POSIX interactive shell), not a toy:
  `Ctrl+C`, resize, colors, persistent session, streaming output.
- 🔄 **Survives tab switches & page reloads** — reconnect and replay scrollback automatically.
- 🚪 **Zero context pollution** — the terminal is fully decoupled from the model/agent conversation.
- ⚡ **Zero config** — auto-detects PowerShell on Windows, bash on POSIX; switch shells from the settings panel.
- ⌨️ `/terminal` in the composer jumps straight to it (single-step, same as official `/plan`), even in an empty session.

**Install**

```bash
dsh plugin --profile web add dsh-web-terminal@github:helays/dsh-web-terminal#main -w
```

> `-w` is required (the profile is a pnpm workspace root; omit it and you'll hit `ERR_PNPM_ADDING_TO_ROOT`). Then **restart `dsh web`** and refresh.

**Usage** — open a session → click the **Terminal** tab (or type `/terminal`) → run commands:

```bash
npm run build
git status
pytest
```

Your shell stays alive across switches; the model and the terminal never interfere with each other.

**Tech** — `@xterm/xterm` + `@xterm/addon-fit` (client) · `node-pty` (real PTY, Windows ConPTY) · `ws` (WebSocket) · `ctx.slots` (native UI slot integration).

**Development** — `pnpm install && pnpm build && pnpm typecheck`.

**Repo info**
> Description: *A DSH plugin that adds a real, independent PTY Terminal tab (xterm.js + node-pty, Windows ConPTY) to the DeepSeek Harness web UI — run commands instantly after coding, decoupled from the model and surviving across sessions.*Topics: `dsh, dsh-bundle, deepseek-harness, dsh-plugin, terminal, xterm, node-pty`.

**License** — [MIT](./LICENSE) © [helays](https://github.com/helays)
