// dsh-web-terminal 构建脚本。
// 一个包两个产物：
//   lib/index.js    —— Host half（Node，ESM，Cordis entry：name/inject/apply）
//   lib/client.js   —— Client half（Browser，CJS + window.__ModuleLoader__.load 包装）
//   lib/client.css  —— @xterm/xterm 的样式（由 host 半通过 GET /terminal/xterm.css 提供）
// 产物 lib/ 签入仓库，避免 git 源安装时跑构建 / allowBuilds。

import { build } from 'esbuild'
import { copyFileSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

// .bin 里没有 esbuild 的话，保证 node 能解析；这里显式 import 自顶层
const PACKAGE_ID = 'dsh-web-terminal'

// ---------- host half ----------
await build({
  entryPoints: ['src/index.ts'],
  outfile: 'lib/index.js',
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  external: [
    'node:fs',
    'node:os',
    'node:path',
    'node:util',
    // node-pty 携带原生 .node 二进制（Windows ConPTY），必须保留外部解析
    'node-pty',
    'ws',
    // host 半通过 profile 闭包解析官方包，不打进 bundle
    '@deepseek-ai/cordis',
    '@deepseek-ai/dsh-host-webserver',
    '@deepseek-ai/dsh-settings',
    '@deepseek-ai/schemastery',
  ],
  logLevel: 'warning',
  sourcemap: false,
  minify: false,
})

// ---------- client half ----------
const clientResult = await build({
  entryPoints: ['src/client/index.tsx'],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: ['es2020'],
  outfile: 'lib/client.js',
  // react 属平台模块，HTTP 运行时注入；其余（含 @xterm/*、ws 零引用）内联
  external: ['react'],
  loader: { '.css': 'css', '.tsx': 'tsx' },
  jsx: 'automatic',
  logLevel: 'warning',
  minify: true,
  write: true,
})

const factoryBody = [
  'var __client = module.exports.exports ?? module.exports;',
  'return {',
  '  apply: __client.apply,',
  '  inject: __client.inject,',
  '};',
].join('\n')

// esbuild format:'cjs' 会输出 `module.exports = __toCommonJS(...)`；我们需拿到 `{apply, inject}`。
// 由于直接 outfile 写法的产出即是 CommonJS module，ModuleLoader 期望一个返回 {apply, inject} 的 factory。
// 我们把 esbuild 输出读回，再包一层 ModuleLoader.load({ id, factory })。
import { readFileSync, writeFileSync } from 'node:fs'
const raw = readFileSync(new URL('./lib/client.js', import.meta.url), 'utf8')
const wrapped = [
  'window.__ModuleLoader__.load({',
  `  id: '${PACKAGE_ID}',`,
  '  factory: (require) => {',
  '    var module = { exports: {} };',
  '    var exports = module.exports;',
  raw,
  factoryBody,
  '  },',
  '});',
].join('\n')
writeFileSync(new URL('./lib/client.js', import.meta.url), wrapped)

// ---------- xterm.css ----------
mkdirSync(new URL('./lib', import.meta.url), { recursive: true })
const xtermCss = require.resolve('@xterm/xterm/css/xterm.css')
copyFileSync(xtermCss, new URL('./lib/client.css', import.meta.url))

console.log('build ok: lib/index.js + lib/client.js + lib/client.css')
