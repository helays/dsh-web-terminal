// dsh-web-terminal —— 自绘「终端」配置卡片。
// 注册进 settings.plugin.item 槽位（出现在 Web 设置 → 插件 区域）。
// 数据走本插件自己的 /terminal/config RPC，不依赖 dsh 的 settings 白名单，
// 因此任何装了本插件的环境都能直接显示出配置入口。
import { useEffect, useState } from 'react'
import type { CSSProperties } from 'react'

const PREFIX = '/terminal'
const KINDS = ['auto', 'pwsh', 'powershell', 'bash', 'zsh', 'sh', 'cmd', 'python', 'custom'] as const
type Kind = (typeof KINDS)[number]

interface ShellInfo {
  kind: string
  label: string
  path: string
  available: boolean
  suggested: boolean
}

interface ConfigShape {
  kind: Kind
  shellPath: string
  shellArgs: string[]
  cwd: string
}

const KIND_LABEL: Record<string, string> = {
  auto: '自动识别（按系统推荐）',
  pwsh: 'PowerShell 7 (pwsh)',
  powershell: 'Windows PowerShell 5.1',
  bash: 'Bash',
  zsh: 'Zsh',
  sh: 'POSIX sh',
  cmd: 'Command Prompt (cmd)',
  python: 'Python REPL',
  custom: '自定义路径',
}

async function getConfig(): Promise<{ config: ConfigShape; shells: ShellInfo[] }> {
  const res = await fetch(`${PREFIX}/config`)
  if (!res.ok) throw new Error(`terminal config ${res.status}`)
  return res.json()
}

async function postConfig(config: ConfigShape): Promise<void> {
  const res = await fetch(`${PREFIX}/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(config),
  })
  if (!res.ok) throw new Error(`terminal config save ${res.status}`)
}

const panelStyle: CSSProperties = {
  padding: '12px 14px',
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  maxWidth: 560,
  fontFamily: 'inherit',
}
const rowStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4 }
const labelStyle: CSSProperties = { fontSize: 12, opacity: 0.7 }
const inputStyle: CSSProperties = {
  background: 'rgba(128,128,128,0.08)',
  border: '1px solid rgba(128,128,128,0.35)',
  borderRadius: 4,
  padding: '5px 8px',
  color: 'inherit',
  fontFamily: 'inherit',
  fontSize: 13,
}
const hintStyle: CSSProperties = { fontSize: 11, opacity: 0.5 }
const saveBtn: CSSProperties = {
  alignSelf: 'flex-start',
  background: 'rgba(80,140,230,0.18)',
  border: '1px solid rgba(80,140,230,0.7)',
  color: 'inherit',
  borderRadius: 4,
  padding: '5px 14px',
  cursor: 'pointer',
  fontSize: 13,
}

export function TerminalSettingsCard() {
  const [config, setConfig] = useState<ConfigShape | null>(null)
  const [shells, setShells] = useState<ShellInfo[]>([])
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<string>('')
  const [dirty, setDirty] = useState(false)

  useEffect(() => {
    getConfig()
      .then(({ config: c, shells: s }) => {
        setConfig(c)
        setShells(s)
      })
      .catch(() => setMsg('读取配置失败'))
  }, [])

  if (!config) return <div style={panelStyle}>… 读取配置中</div>

  const suggested =
    shells.find((s) => s.available && s.suggested) ?? shells.find((s) => s.available && s.kind !== 'auto')

  const patch = (p: Partial<ConfigShape>) => {
    setConfig((c) => (c ? { ...c, ...p } : c))
    setDirty(true)
    setMsg('')
  }

  async function save() {
    if (!config) return
    setSaving(true)
    setMsg('')
    try {
      await postConfig(config)
      setDirty(false)
      setMsg('已保存（新终端生效；正在执行的会话不受影响）')
    } catch {
      setMsg('保存失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={panelStyle}>
      <div>
        <div style={{ fontSize: 13, fontWeight: 600 }}>终端</div>
        <div style={hintStyle}>
          跨平台自动识别：Windows 默认 PowerShell、Linux/macOS 默认 Bash。
          {suggested ? ` 当前推荐：${suggested.label}` : ''}
        </div>
      </div>

      <div style={rowStyle}>
        <span style={labelStyle}>终端类型</span>
        <select
          value={config.kind}
          onChange={(e) => patch({ kind: e.target.value as Kind, shellPath: config.shellPath || '' })}
          style={inputStyle}
        >
          {KINDS.map((k) => {
            const avail = shells.find((s) => s.kind === k)
            if (k !== 'auto' && k !== 'custom' && avail && !avail.available) return null
            return (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            )
          })}
        </select>
      </div>

      {(config.kind === 'custom' || config.shellPath) && (
        <div style={rowStyle}>
          <span style={labelStyle}>自定义 shell 路径</span>
          <input
            value={config.shellPath}
            onChange={(e) => patch({ shellPath: e.target.value, kind: config.shellPath ? 'custom' : config.kind })}
            placeholder={window.navigator?.platform?.toLowerCase().includes('win') ? '如 C:\\Windows\\System32\\wsl.exe' : '如 /usr/bin/fish'}
            style={inputStyle}
          />
        </div>
      )}

      <div style={rowStyle}>
        <span style={labelStyle}>默认工作目录（留空 = 跟随会话/当前 workspace）</span>
        <input
          value={config.cwd}
          onChange={(e) => patch({ cwd: e.target.value })}
          placeholder="如 D:\workspace\demo 或 /home/user/demo"
          style={inputStyle}
        />
      </div>

      <div style={rowStyle}>
        <span style={labelStyle}>已识别的可用 shell</span>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {shells
            .filter((s) => s.kind !== 'auto' && s.available)
            .map((s) => (
              <span key={s.kind} style={{ fontSize: 11, opacity: 0.6, background: 'rgba(128,128,128,0.1)', padding: '2px 6px', borderRadius: 3 }}>
                {s.label}
              </span>
            ))}
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <button type="button" onClick={save} disabled={saving} style={saveBtn}>
          {saving ? '保存中…' : dirty ? '保存（未保存）' : '保存'}
        </button>
        {msg && <span style={hintStyle}>{msg}</span>}
      </div>
    </div>
  )
}
