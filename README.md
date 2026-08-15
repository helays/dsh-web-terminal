<!--
  dsh-web-terminal — English README.
  Badges are shields.io; dynamic GitHub badges (stars/contributors, …) go live once the repo is public.
-->

<div align="center">

# 🖥️ dsh-web-terminal

**Give your AI coding workbench a real terminal — right inside DeepSeek Harness.**

An interactive **PTY** terminal powered by **xterm.js + node-pty**, mounted as a third tab (Chat · Trajectory · **Terminal**) at the top of the web UI.
After the model writes code, **stay in the conversation** and open a shell of your own right next to it — build, commit, test, debug in one click.

</div>

<p align="center">
  <a href="https://github.com/helays/dsh-web-terminal/blob/main/LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-yellowgreen.svg?style=flat-square"/></a>
  <a href="https://github.com/helays/dsh-web-terminal"><img alt="Version" src="https://img.shields.io/badge/version-0.1.0-blue.svg?style=flat-square"/></a>
  <a href="https://www.deepseek.com/harness"><img alt="DeepSeek Harness" src="https://img.shields.io/badge/platform-DeepSeek%20Harness-4f8cff.svg?style=flat-square"/></a>
  <a href="https://github.com/helays/dsh-web-terminal"><img alt="dsh-plugin" src="https://img.shields.io/badge/type-dsh--plugin-7c3aed.svg?style=flat-square"/></a>
  <a href="https://github.com/helays/dsh-web-terminal"><img alt="Stars" src="https://img.shields.io/github/stars/helays/dsh-web-terminal?style=flat-square&logo=github" /></a>
  <a href="https://github.com/helays/dsh-web-terminal"><img alt="Last commit" src="https://img.shields.io/github/last-commit/helays/dsh-web-terminal?style=flat-square" /></a>
</p>

<p align="center">
  English  ·  <a href="./README.zh.md">中文</a>
</p>

---

## Why you'll love it

| The pain 😤 | The fix with dsh-web-terminal ✅ |
|---|---|
| After the model edits code, you copy-paste it back into your own terminal and fumble | Open a **real PTY** right **next to the chat** — type a command, run it instantly |
| Everything has to squeeze into the conversation context, doubling tokens and noise | The terminal is **fully decoupled from the model / agent** — your private shell, **zero context cost** |
| Switching sessions or refreshing loses your commands and session state | **Survives across sessions**: switch away / come back / refresh — auto reconnect and replay scrollback |
| Spinning up a throwaway shell for a single command is slow | **Persistent process**: open once, run many commands on one resident shell (`Ctrl+C` interrupts, then keep going) |

> In one line: **put “writing code” and “running code” in the same place — without them interfering.**

---

## ✨ Highlights

- 🗂️ A dedicated **Terminal** tab next to Chat & Trajectory — one click to switch.
- 🧯 **A real PTY, not a toy**:
  - Windows uses **ConPTY**; POSIX uses an interactive shell;
  - full `Ctrl+C` / `Ctrl+D` control keys, `resize` auto-fit, color + cursor blink;
  - persistent session (process stays resident, so you can chain commands without restarting).
- 🔄 **Session survival + scrollback replay**: tab away and back, even reload the page — it auto-reconnects and replays recent output (the pool lives plugin-side).
- 🚪 **Zero conversation pollution**: fully independent of the agent stream — no context tokens, no chat-log noise.
- ⚡ **Zero config**: PowerShell on Windows and bash on POSIX are auto-detected; run **multiple terminals side by side** and switch each one's shell type (`bash / zsh / pwsh / powershell / cmd / python`, …) from a dropdown right in the Terminal tab.
- 🗂️ **Multi-terminal**: open several terminals in one tab, switch with the tab cards, each with its own process.
- ⌨️ Type `/terminal` in the composer to jump straight to the terminal (a single-step command, same source as the official `/plan`) — works even in an empty new session.
- 🧩 A pure DSH bundle plugin: install, run, natively integrated with the official UI slots.

---

## 🚀 Quick Start

> Requires: DeepSeek Harness **`0.1.0-rc.6` (next channel)** `web` profile.

### Install

```bash
# Option 1 — GitHub (recommended, reproducible)
dsh plugin --profile web add dsh-web-terminal@github:helays/dsh-web-terminal#main -w

# Option 2 — from a local dev checkout
cd dsh-web-terminal && dsh plugin --profile web add . -w
```

> ⚠️ **`-w` is required**: the current dsh profile template is a pnpm workspace root
> (`pnpm-workspace.yaml` contains `packages: [.]`); omitting it triggers `ERR_PNPM_ADDING_TO_ROOT`.
> `dsh plugin` forwards its remaining args to pnpm verbatim.
>
> After installing, **restart `dsh web`** (a changed plugin set / host needs a restart), then refresh the browser.

### Usage

1. Open any session (once you're inside, you'll see **Chat · Trajectory · Terminal** at the top).
2. Click the **Terminal** tab, or type `/terminal` in the input box.
3. Run commands directly, for example:

```bash
npm run build   # build right after the model edits code
git status      # see what changed
pytest          # run tests
```

4. The tab bar shows connection status; switch back to **Chat** whenever you like — your terminal and session are still there.

---

## 🧩 Tech Stack

| Layer | Choice | Notes |
|---|---|---|
| Front-end terminal | [`@xterm/xterm`](https://github.com/xtermjs/xterm.js) + `@xterm/addon-fit` | Bundled into the client bundle (`lib/client.js`), registered via `__ModuleLoader__.load` |
| Back-end PTY | [`node-pty`](https://github.com/microsoft/node-pty) | Native PTY (Windows ConPTY / POSIX pty), resident process |
| Transport | [`ws`](https://github.com/websockets/ws) | WebSocket bidirectional byte stream + resize via `ctx.webServer` |
| UI integration | `ctx.slots.inject('conversation.view')` | Registers the `id:'terminal'` tab, mirroring `dsh-client-ui-trajectory` |

### Why a “real” terminal — and how it differs from the built-in `dsh-terminal`

The built-in `ctx.terminals` is **agent-owned, model-facing, line-oriented**, with no browser transport and unavailable on Windows.
Here we instead **spawn a shell that belongs entirely to you** via `node-pty`, fully decoupled from the agent session — it is *your own* terminal.

---

## 🔧 Local Development

```bash
pnpm install     # install deps (types included)
pnpm build       # outputs lib/index.js + lib/client.js + lib/client.css
pnpm typecheck   # tsc --noEmit type check
```

- Changing the **host half** (`src/`) requires a `dsh web` restart;
- Changing the **client half** (`src/client/`) just needs a reinstall + page refresh.

---

## ❓ FAQ

**Q: Does this terminal consume my conversation context?**
No. It is fully decoupled from the model/agent conversation — nothing is written to context and nothing mixes into the chat log.

**Q: Will my session survive a restart/refresh?**
Yes. The session pool lives plugin-side and survives across sessions and reloads; on reconnect it replays the latest output.

**Q: I only want to run a single command — must I open a terminal?**
Once open the process stays resident, so you can keep operating inside it; switching away and back returns to the same shell.

**Q: Can I swap shells?**
Yes — per terminal. In the **Terminal** tab, use the “Terminal type” dropdown (top-right) to pick `bash / zsh / pwsh / powershell / cmd / python` (from the shells detected on your system); switching restarts that terminal with the new shell. It auto-detects PowerShell on Windows and bash on POSIX by default.

**Q: Where do terminals open by default?**
In the current conversation's workspace directory (falling back to the `dsh web` startup directory if unavailable). No configuration needed.

---

## 📝 License

[MIT](./LICENSE) © [helays](https://github.com/helays)
