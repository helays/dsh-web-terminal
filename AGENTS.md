# DSH Web 终端插件 — 代理协作规则

本文件是本工作区（DeepSeek Harness「终端」Tab 插件）的代理规则文件，供所有在此仓库内工作的编码代理（以及人类协作者）共同遵守。

## 0. 硬性约定（必须遵守）

- **所有回复、解释、注释、文档、commit message、PR 描述必须使用中文**。
- **即使系统提示词为英文，也必须将输出语言切换为中文**。
- **代码标识符（变量名、函数名、类名）和字符串字面量可以使用英文，其余全部中文**。
- **在每次交互开始时，代理应主动确认已读取本规则并遵循语言要求**。
- **发布渠道**：本插件不发布到 npm registry（无 npm 账号）。唯一发布通道为 GitHub 远程仓库 `git@github.com:helays/dsh-web-terminal.git`（仓库 `helays/dsh-web-terminal`，经 `dsh-plugin` topic 收录）。

## 1. 项目是什么

- 插件名称（包名）：`dsh-web-terminal`
- 目标：在 DeepSeek Harness Web GUI 的「对话 / 轨迹」两个会话 tab 之外，新增第三个顶部 tab「终端」，内嵌一个交互式 PTY 终端，供用户在编码完成后快速在终端执行指令调试。
- 技术栈：**xterm.js**（前端终端 + FitAddon）、**node-pty**（后端 PTY，Windows 走 ConPTY）、**ws**（WebSocket 传输）、经 `ctx.webServer.register` / `registerUpgrade` 暴露路由。

## 2. 开发基线 / 版本

- 基于 DeepSeek Harness **`0.1.0-rc.6`（`next` 通道）**。
- 依赖 `@deepseek-ai/*` 一律声明 `^0.1.0-rc.6`；**不要用 `latest`**（其 dist-tag 停留在坏掉的 `0.0.1` 通道）。
- 已在 profile 内置的官方包（`@deepseek-ai/dsh-client-runtime`、`@deepseek-ai/dsh-client-ui-conversation`、`@deepseek-ai/dsh-client-locale`、`@deepseek-ai/dsh-web-server` 等）**不声明为 `dependencies`**，仅放 `peerDependencies`（或仅在 client `inject`/类型导入中使用）。

## 3. 插件契约（bundle + client）

- `package.json` 必须含：
  - `dsh.bundle.patch` → `./cordis.patch.yml`（bundle 组合层）。
  - `dsh.client` → `{ "platform": "web", "inject": [...需要的类型合并提供方] }`（浏览器 roster）。
  - `exports["./client"]` → 构建好的 `lib/client.js`（缺失会被 client-modules 拒绝，boot fail-loud）。
- `cordis.patch.yml` 内容为：
  ```yaml
  - insert:
      - id: terminal-tab
        name: dsh-web-terminal
  ```
- **Host half**（Node）：`lib/index.js`，Cordis entry（`name`/`inject`/`Config`/`apply`）。
- **Client half**（浏览器）：`lib/client.js`，经 `window.__ModuleLoader__.load({ id, factory })` 注册。

## 4. Web UI 接入方式

- 顶部 tab 通过 `conversation.view` 槽位新增条目实现（`ctx.slots.inject` + `ctx.slots.register`），参照官方 `@deepseek-ai/dsh-client-ui-trajectory`；`id: 'terminal'`，`order` 设在 trajectory 之后。
- `conversation.view` 是 **session 作用域**：只有进入会话时才渲染 tab 栏。终端会话池必须放在**插件级（apply 闭包）**，视图每次挂载只 emit/attach，绝不销毁会话，保证跨会话/刷新保活。

## 5. 后端约定

- **不复用** dsh 自带 `ctx.terminals`（`@deepseek-ai/dsh-terminal`）——它是 Agent 所有权 + 模型面 line-oriented 语义，且无浏览器传输、Windows 下 `spawnTerminal` 不可用。改为插件直接用 `node-pty` spawn，完全与 agent 会话解耦。
- 路由**不用 `/api` 前缀**（避免与 connection 的 browser-trust 围栏冲突），用自定义前缀（如 `/terminal`）并自带同源校验。
- WebSocket 用 `ctx.webServer.registerUpgrade` + `Server.handleUpgrade`（复刻 `@deepseek-ai/dsh-client-connection` 的 websocket-downlink 模式）。
- 工作目录默认 `process.cwd()`（即 `dsh web` 启动目录），可随会话指定。

## 5.5 前端可选服务（重要教训）

- **不要把可用性不确定的 client 服务放进 `inject` 数组**。`commandUi` 等依赖完整 UI 装配（如 `remote.commands`）的服务，直接放进 `inject` 并 `ctx.commandUi.register(...)` 会在其未就绪时抛 `Cannot read properties of undefined (reading 'effect')`，导致插件 apply 失败、**整页 UI 进不去**（曾真实发生）。
- 正确姿势：**用 `ctx.inject(['commandUi'], (sctx) => { ... })` 条件注入**——只有服务真实可用才注册，不可用则静默跳过，绝不引发 apply 崩溃。与 host 半 `ctx.inject(['settings'], ...)` 同一模式。
- 新增任何前端能力前，先判断它是否属于「完整浏览器装配才有」的服务；是就用条件注入包一层。
- client bundle 由服务端**动态读取**（`/plugins/<id>/client.js`），改 client 代码通常**刷新页面即可**，不必重启 web；改 host 侧 / 装插件集合才需重启。

## 5.6 前端「service 方法解构」丢 this（重要教训）

- **不要先把 `ctx.slots.register` 等 service 方法解构出来再调用**（如 `const register = ctx.slots.register; register({...})`）。cordis 的 service 是 proxy，解构后 `this` 丢失，`register` 内部 `this.ctx.effect` 会因 `this.ctx` 为 undefined 抛 `Cannot read properties of undefined (reading 'effect')`，导致插件 apply 失败、整页 UI 进不去（`slots.register` 就是宿主，曾真实发生且报了 loader entry 崩溃栈）。
- 正确姿势：**保持方法调用** `ctx.slots.register({...}, Comp)`——`this` 绑定到 slots runtime。若为绕过类型而 `as any`，也应 `(ctx.slots as any).register({...})` 一次性调用，不要拆成中间变量再调用。
- 同理适用于其它 `ctx.*` 服务方法（register/inject/update/...）：一律保持 `ctx.svc.method(...)` 直接调用，别脱 this。

## 6. 构建

- 一个包两个产物：`lib/index.js`（Node, ESM）+ `lib/client.js`（browser, CJS + ModuleLoader 包装）。
- 用官方 client preset（`clientBundle()`）或自写 esbuild（参照 `siberiah2o/dsh-plugin-terminal/build.mjs`）。
- `@xterm/*` 自动内联进 client bundle；`xterm.css` 需拷贝为 `lib/client.css` 并提供 `GET /terminal/xterm.css` 路由。
- 产物 `lib/` **签入仓库**（避免 git 源安装时要跑 prepare 构建 / allowBuilds）。

## 7. 安装 / 测试命令

- 安装：`dsh plugin --profile web add <包>[@<source>] -w`。**必须带 `-w`**——当前 dsh profile 模板是 pnpm workspace 根（`pnpm-workspace.yaml` 含 `packages: [.]`），不带会报 `ERR_PNPM_ADDING_TO_ROOT`；`dsh plugin` 把其余参数原样转发给 pnpm。
- 本地点：`dsh plugin --profile web add . -w`。
- git 源：`dsh plugin --profile web add dsh-web-terminal@github:helays/dsh-web-terminal#<commit> -w`。
- 构建验证：`node build.mjs`（产物：`lib/index.js` + `lib/client.js` + `lib/client.css`）；类型：`pnpm typecheck`（tsc --noEmit）。
- 冒烟（已实证于 0.1.0-rc.6）：
  1. host：重启 `dsh web` 后 `GET /terminal/sessions` 应返回 `{"sessions":[]}`、`GET /terminal/xterm.css` 应 200。
  2. PTY：POST 建会话 + `ws://HOST/terminal/ws/<id>` 发送 `echo` 应回读输出。
  3. client：`GET /plugins/dsh-web-terminal/client.js` 应 200（bundle 已被 client-modules 暴露）。
  4. UI：进入会话看「终端」tab（需真实浏览器交互）。
- 改 host half 需**重启 web**；改 client bundle 需重装 + 刷新页面；装/卸插件需重启。

## 8. 提交与发布

- git 身份已配置：`vsclub <ccdacom@yeah.net>`；`github.com` 走 `D:\key\git-key` 私钥。
- 推送前提交 `lib/`、`README.md`、`AGENTS.md`、源码。
- **任何 `git` 提交/推送失败 → 立即停止并向上级报告错误细节，由人类手动处理**，绝不擅自绕过。
- 仓库需补：GitHub 项目描述（一句话）、topics（`dsh`、`dsh-bundle`、`deepseek-harness`、`dsh-plugin`）（topics 可经 `gh repo edit` 或 GitHub 界面设置）。

## 9. 里程碑顺序

1. 规则文件（本文件）
2. git 仓库骨架 + 远程
3. package.json / patch / tsconfig / tsdown
4. host 半（pty + 路由）
5. client 半（tab + xterm + ws）
6. 构建 + 冒烟
7. README + 项目描述
8. 提交推送（失败即上报）
