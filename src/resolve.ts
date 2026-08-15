// dsh-web-terminal —— shell 自动侦测与 argv 构造。
// 跨平台探测系统里实际可用的 shell / 终端程序，选出当前平台的推荐默认
// （Windows 优先 PowerShell，POSIX 优先 bash），并据可配置项构造 node-pty spawn 的 file+argv。
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'

/** 配置里的终端类型枚举（z.union 用 const 数组）。 */
export const TERMINAL_KINDS = [
  'auto',
  'pwsh',
  'powershell',
  'bash',
  'zsh',
  'sh',
  'cmd',
  'python',
  'custom',
] as const
export type TerminalKind = (typeof TERMINAL_KINDS)[number]

/** 一个候选 shell 的侦测结果。 */
export interface ShellCandidate {
  kind: TerminalKind
  /** 展示名（如 "PowerShell 7 (pwsh)"）。 */
  label: string
  /** 解析出的可执行文件绝对路径；找不到则空字符串。 */
  path: string
  /** 是否可用（存在于文件系统/PATH）。 */
  available: boolean
  /** 当前平台把这个设为默认吗？ */
  suggested: boolean
}

interface ResolveOptions {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
}

// ---------------------------------------------------------------------------
// 已知固定路径（不依赖 PATH）
// ---------------------------------------------------------------------------

/** Windows 下几个已知安装根。 */
const WINDOWS_PWSH_ROOTS = ['%ProgramFiles%\\PowerShell\\7\\pwsh.exe', '%ProgramFiles(x86)%\\PowerShell\\7-preview\\pwsh.exe']
const WINDOWS_POWERSHELL = '%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const WINDOWS_CMD = '%SystemRoot%\\System32\\cmd.exe'

function expandEnvVar(p: string, env: NodeJS.ProcessEnv): string {
  if (!p.includes('%')) return p
  return p.replace(/%([^%]+)%/g, (_m, k) => env[k] ?? '')
}

/** 在 PATH 里找可执行文件（Windows 用 where，POSIX 用 which）。 */
function which(bin: string, { platform, env }: ResolveOptions): string {
  const shell = platform === 'win32'
  const probe = shell ? `where.exe` : `which`
  try {
    const out = execFileSync(probe, [bin], {
      env: env as Record<string, string>,
      encoding: 'utf8',
      windowsHide: true,
    })
    const first = out.split(/\r?\n/).find((l) => l.trim().length > 0)
    return first ? first.trim() : ''
  } catch {
    return ''
  }
}

/** 校验候选绝对路径是否真的存在。 */
function fileExists(p: string): boolean {
  if (!p) return false
  try {
    return existsSync(p)
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// 主入口：全平台候选清单
// ---------------------------------------------------------------------------

export function detectShells(opts: ResolveOptions = {}): ShellCandidate[] {
  const platform = opts.platform ?? process.platform
  const env = opts.env ?? process.env
  const suggestions = new Set<string>(suggestedKinds(platform))
  const candidates: ShellCandidate[] = []

  const add = (kind: TerminalKind, label: string, path: string, fallbacks: string[] = []): void => {
    let resolved = path
    if (!resolved || !fileExists(resolved)) {
      resolved = fallbacks.find((f) => fileExists(f)) ?? ''
    }
    if (!resolved && /^(pwsh|powershell|cmd|bash|zsh|sh|python)$/.test(kind)) {
      resolved = which(kind === 'python' ? (platform === 'win32' ? 'python' : 'python3') : kind, { platform, env })
    }
    candidates.push({
      kind,
      label,
      path: resolved,
      available: resolved.length > 0,
      suggested: suggestions.has(kind),
    })
  }

  // mark suggested order (only the first suggested becomes default in the picker)
  if (platform === 'win32') {
    // PowerShell 7 / 5.1，尽量解析出绝对路径
    add(
      'pwsh',
      'PowerShell 7 (pwsh)',
      '',
      WINDOWS_PWSH_ROOTS.map((p) => expandEnvVar(p, env)),
    )
    add('powershell', 'Windows PowerShell 5.1', expandEnvVar(WINDOWS_POWERSHELL, env))
    // 若上面 pwsh candidates 已 available，则此时再补 PATH 级 pwsh 探测
    // （上面 add 内已 which('pwsh') 兜底）
    add('cmd', 'Command Prompt (cmd)', expandEnvVar(WINDOWS_CMD, env))
    add('bash', 'Git Bash / WSL bash', '', [])
    add('zsh', 'Zsh', '', [])
    add('sh', 'POSIX sh', '', [])
    add('python', 'Python 交互式 (REPL)', '', [])
  } else {
    add('bash', 'Bash', '', [])
    add('zsh', 'Zsh', '', [])
    add('sh', 'POSIX sh', '', [])
    add('pwsh', 'PowerShell (pwsh)', '', [])
    add('python', 'Python 交互式 (REPL)', '', [])
    // cmd / powershell exists only on Windows -> skip
  }

  // custom/auto handled at picker level; insert 'auto'
  candidates.unshift({
    kind: 'auto',
    label: '自动（按系统推荐）',
    path: '',
    available: true,
    suggested: false,
  })

  return candidates
}

/** 当前平台建议优先的 kind 顺序（仅第一个会被用作默认）。 */
export function suggestedKinds(platform: NodeJS.Platform = process.platform): string[] {
  return platform === 'win32' ? ['pwsh', 'powershell', 'cmd'] : ['bash', 'zsh', 'sh']
}

/** 解析「选定 kind + 自定义路径/参数」为 node-pty 的 { file, argv }。 */
export function buildArgv(
  cfg: { kind?: TerminalKind; shellPath?: string; shellArgs?: string[] },
  candidates?: ShellCandidate[],
  opts: ResolveOptions = {},
): { file: string; argv: string[] } {
  const platform = opts.platform ?? process.platform
  const env = opts.env ?? process.env

  // 1) 自定义路径优先
  if (cfg.shellPath && cfg.shellPath.trim() && fileExists(cfg.shellPath.trim())) {
    return { file: cfg.shellPath.trim(), argv: cfg.shellArgs?.length ? cfg.shellArgs : [] }
  }

  // 2) 用 kind 解析
  const kind: TerminalKind = cfg.kind ?? 'auto'
  const used = candidates ?? detectShells({ platform, env })
  if (kind === 'auto') {
    const firstSuggested = used.find((c) => c.available && c.suggested)
    const pick = firstSuggested ?? used.find((c) => c.available && c.kind !== 'auto' && c.kind !== 'custom')
    if (pick) return argvFor(pick, cfg.shellArgs, platform)
  }
  const byKind = used.find((c) => c.kind === kind && c.available)
  if (byKind) return argvFor(byKind, cfg.shellArgs, platform)

  // 3) 彻底兜底
  if (platform === 'win32') {
    const cmd = expandEnvVar(WINDOWS_CMD, env)
    return { file: fileExists(cmd) ? cmd : 'cmd.exe', argv: [] }
  }
  return { file: '/bin/sh', argv: ['-i'] }
}

function argvFor(c: ShellCandidate, extra: string[] | undefined, platform: NodeJS.Platform): { file: string; argv: string[] } {
  const file = c.path || c.kind
  if (extra && extra.length) return { file, argv: extra }
  switch (c.kind) {
    case 'pwsh':
      return { file, argv: ['-NoLogo'] } // 交互式：不加 -Command/-NonInteractive
    case 'powershell':
      return { file, argv: ['-NoLogo'] }
    case 'bash':
    case 'sh':
      return { file, argv: ['--noprofile', '--norc', '-i'] }
    case 'zsh':
      return { file, argv: ['-i'] }
    case 'python':
      return { file, argv: ['-i'] }
    case 'cmd':
    default:
      return { file, argv: [] }
  }
}
