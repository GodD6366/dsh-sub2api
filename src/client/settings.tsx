/**
 * Settings section for dsh-sub2api.
 *
 * One base URL, four provider cards (OpenAI / Claude / Grok / Gemini), each
 * with a key field and a model list. Keys are written to the harness
 * credential store through the host HTTP bridge; the base URL and model
 * catalogs land in the `llm-sub2api:` settings section.
 *
 * @module dsh-sub2api/client/settings
 */

import { useCallback, useEffect, useState } from 'react'
import type { CSSProperties } from 'react'
import { ProviderIcon } from './icons.tsx'
import type { ProviderIconName } from './icons.tsx'

const BASE = '/plugins/dsh-sub2api'

const PROVIDERS: Array<{ key: string; label: string; icon: ProviderIconName; placeholder: string }> = [
  { key: 'openai', label: 'OpenAI', icon: 'openai', placeholder: 'sk-…' },
  { key: 'claude', label: 'Claude', icon: 'claude', placeholder: 'sk-ant-…' },
  { key: 'grok', label: 'Grok', icon: 'grok', placeholder: 'xai-…' },
  { key: 'gemini', label: 'Gemini', icon: 'gemini', placeholder: 'AIza…' },
]

const CSS_ID = 'dsh-sub2api/settings.css'

const css = `
.s2a_section{max-width:720px;color:var(--dsw-alias-label-primary);flex-direction:column;gap:12px;display:flex}
.s2a_title{color:var(--dsw-alias-label-primary);margin:0;font-size:16px;font-weight:500;line-height:24px}
.s2a_intro{color:var(--dsw-alias-label-tertiary);margin:0;font-size:13px;line-height:20px}
.s2a_notice{color:var(--dsw-alias-state-warn-label);margin:0;font-size:12px;line-height:18px}
.s2a_field{flex-direction:column;gap:5px;display:flex}
.s2a_fieldLabel{color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:500;line-height:18px}
.s2a_input{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);width:100%;height:32px;font:inherit;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 10px;font-size:13px;line-height:22px}
.s2a_input:focus{border-color:var(--dsw-alias-brand-primary);outline:none}
.s2a_input::placeholder{color:var(--dsw-alias-label-dimmed)}
.s2a_textarea{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);width:100%;min-height:84px;font:inherit;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:8px;padding:6px 10px;font-size:12px;line-height:18px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;resize:vertical}
.s2a_textarea:focus{border-color:var(--dsw-alias-brand-primary);outline:none}
.s2a_textarea::placeholder{color:var(--dsw-alias-label-dimmed)}
.s2a_rows{flex-direction:column;gap:10px;margin:4px 0 0;padding:0;list-style:none;display:flex}
.s2a_rowCard{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;flex-direction:column;gap:12px;padding:14px 16px;display:flex}
.s2a_rowHead{align-items:center;gap:10px;display:flex}
.s2a_rowIdentity{flex:1;align-items:center;gap:8px;min-width:0;display:inline-flex}
.s2a_rowName{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:500;line-height:22px}
.s2a_rowTag{border:1px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-secondary);border-radius:4px;flex:none;padding:1px 6px;font-size:11px;line-height:16px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.s2a_editor{background:var(--dsw-alias-bg-module-platform);border-radius:10px;flex-direction:column;gap:10px;padding:12px 14px;display:flex}
.s2a_rowActions{align-items:center;gap:4px;margin-left:auto;display:inline-flex}
.s2a_btn,.s2a_primary{box-sizing:border-box;height:32px;font:inherit;cursor:pointer;border:none;border-radius:16px;justify-content:center;align-items:center;gap:4px;padding:0 14px;font-size:13px;line-height:20px;display:inline-flex}
.s2a_primary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}
.s2a_primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}
.s2a_btn{border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);background:transparent}
.s2a_btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.s2a_btn:disabled,.s2a_primary:disabled{opacity:.4;cursor:default}
.s2a_btn:focus-visible,.s2a_primary:focus-visible{box-shadow:0 0 0 2px var(--dsw-alias-border-l3);outline:none}
.s2a_actions{align-items:center;gap:8px;margin-top:4px;display:flex}
.s2a_status{margin:0;font-size:12px;line-height:18px;white-space:pre-wrap;color:var(--dsw-alias-label-secondary)}
.s2a_statusOk{color:var(--dsw-alias-state-success-primary)}
.s2a_statusErr{color:var(--dsw-alias-state-error-primary)}
`

function ensureCss(): void {
  if (typeof document === 'undefined') return
  if (document.querySelector(`style[data-plugin-css=${JSON.stringify(CSS_ID)}]`)) return
  const tag = document.createElement('style')
  tag.dataset.plugin = 'dsh-sub2api'
  tag.dataset.pluginCss = CSS_ID
  tag.textContent = css
  document.head.appendChild(tag)
}

interface ProviderState {
  key: string
  keyConfigured: boolean
  modelsText: string
}

interface ConfigState {
  baseURL: string
  providers: Record<string, ProviderState>
}

function modelsToText(models: Array<{ id: string; name?: string }>): string {
  return models.map((m) => (m.name !== undefined && m.name !== m.id ? `${m.id}|${m.name}` : m.id)).join('\n')
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
  })
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>
  if (!response.ok) {
    const message = typeof payload.error === 'string' ? payload.error : `HTTP ${response.status}`
    throw new Error(message)
  }
  return payload as T
}

export function Sub2ApiSettings() {
  const [baseURL, setBaseURL] = useState('')
  const [providers, setProviders] = useState<Record<string, ProviderState>>({})
  const [busy, setBusy] = useState('')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    ensureCss()
    api<{ baseURL: string; providers: Record<string, { keyConfigured: boolean; models: string[] }> }>(`${BASE}/config`)
      .then((cfg) => {
        setBaseURL(cfg.baseURL ?? '')
        const map: Record<string, ProviderState> = {}
        for (const def of PROVIDERS) {
          const p = cfg.providers?.[def.key]
          map[def.key] = {
            key: '',
            keyConfigured: p?.keyConfigured ?? false,
            modelsText: p?.models !== undefined ? modelsToText(p.models.map((id) => ({ id }))) : '',
          }
        }
        setProviders(map)
      })
      .catch((e) => setError(String(e instanceof Error ? e.message : e)))
  }, [])

  const updateProvider = useCallback((key: string, patch: Partial<ProviderState>) => {
    setProviders((prev) => ({ ...prev, [key]: { ...(prev[key] ?? { key: '', keyConfigured: false, modelsText: '' }), ...patch } }))
  }, [])

  const save = async () => {
    setBusy('save'); setError(''); setMessage('')
    try {
      const payload = { baseURL, providers: {} as Record<string, { apiKey: string; models: string }> }
      for (const def of PROVIDERS) {
        const p = providers[def.key] ?? { key: '', modelsText: '' }
        payload.providers[def.key] = { apiKey: p.key, models: p.modelsText }
      }
      const res = await api<{ ok: boolean; routes?: string[]; error?: string }>(`${BASE}/config`, { method: 'POST', body: JSON.stringify(payload) })
      const routes = res.routes !== undefined && res.routes.length > 0 ? res.routes.join(', ') : '无（未填 key）'
      setMessage(`已保存。激活路由: ${routes}`)
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e))
    } finally {
      setBusy('')
    }
  }

  const discover = async (def: { key: string; label: string }) => {
    const key = providers[def.key]?.key ?? ''
    setBusy(def.key); setError(''); setMessage('')
    try {
      const res = await api<{ ok: boolean; models: Array<{ id: string; name?: string }> }>(`${BASE}/discover`, {
        method: 'POST',
        body: JSON.stringify({ baseURL, apiKey: key }),
      })
      updateProvider(def.key, { modelsText: modelsToText(res.models ?? []) })
      setMessage(`${def.label} 发现 ${(res.models ?? []).length} 个模型`)
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e))
    } finally {
      setBusy('')
    }
  }

  const checkUsage = async (def: { key: string; label: string }) => {
    const key = providers[def.key]?.key ?? ''
    setBusy(def.key); setError(''); setMessage('')
    try {
      const res = await api<{ ok: boolean; summary?: string }>(`${BASE}/usage`, {
        method: 'POST',
        body: JSON.stringify({ baseURL, apiKey: key }),
      })
      setMessage(`${def.label} 用量: ${res.summary ?? ''}`)
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e))
    } finally {
      setBusy('')
    }
  }

  const checkStatus = async () => {
    setBusy('status'); setError(''); setMessage('')
    try {
      const res = await api<{ routes: string[]; models: Record<string, string[]> }>(`${BASE}/status`)
      setMessage(`已注册路由: ${res.routes.length > 0 ? res.routes.join(', ') : '无'}；模型: ${JSON.stringify(res.models)}`)
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e))
    } finally {
      setBusy('')
    }
  }

  return (
    <div className="s2a_section">
      <h2 className="s2a_title">Sub2API 模型接入</h2>
      <p className="s2a_intro">
        统一端点 + 多 key：所有供应商共享一个 baseURL，每个 key 在 sub2api 后台绑定一个分组，分组决定平台（OpenAI / Claude / Grok /
        Gemini）与可用模型。
      </p>
      <p className="s2a_notice">
        提示：先在 sub2api 后台创建各平台的分组并生成 API key，再填入下方。默认端口 8080，例如 http://localhost:8080/v1。
      </p>
      <div className="s2a_field" style={{ marginTop: 2 }}>
        <label className="s2a_fieldLabel">Sub2API Base URL</label>
        <input className="s2a_input" value={baseURL} placeholder="http://localhost:8080/v1" onChange={(e) => setBaseURL(e.target.value)} />
      </div>
      <ul className="s2a_rows">
        {PROVIDERS.map((def) => {
          const p = providers[def.key] ?? { key: '', keyConfigured: false, modelsText: '' }
          return (
            <li key={def.key} className="s2a_rowCard">
              <div className="s2a_rowHead">
                <div className="s2a_rowIdentity">
                  <ProviderIcon name={def.icon} size={18} />
                  <span className="s2a_rowName">{def.label}</span>
                  <span className="s2a_rowTag">sub2api-{def.key}</span>
                </div>
                <div className="s2a_rowActions">
                  <button className="s2a_btn" disabled={busy.length > 0} onClick={() => discover(def)}>
                    {busy === def.key ? '…' : '获取模型'}
                  </button>
                  <button className="s2a_btn" disabled={busy.length > 0} onClick={() => checkUsage(def)}>
                    {busy === def.key ? '…' : '查看用量'}
                  </button>
                </div>
              </div>
              <div className="s2a_editor">
                <div className="s2a_field">
                  <label className="s2a_fieldLabel">
                    {def.label} API Key{p.keyConfigured || p.key.length > 0 ? ' ✓' : ''}
                  </label>
                  <input
                    className="s2a_input"
                    type="password"
                    value={p.key}
                    placeholder={p.keyConfigured ? `${def.placeholder}（已配置，留空保持不变）` : def.placeholder}
                    onChange={(e) => updateProvider(def.key, { key: e.target.value })}
                  />
                </div>
                <div className="s2a_field">
                  <label className="s2a_fieldLabel">模型列表（每行一个：id 或 id|名称|contextWindow）</label>
                  <textarea
                    className="s2a_textarea"
                    value={p.modelsText}
                    placeholder="gpt-4o&#10;claude-sonnet-4-5&#10;grok-3&#10;gemini-2.5-pro"
                    onChange={(e) => updateProvider(def.key, { modelsText: e.target.value })}
                  />
                </div>
              </div>
            </li>
          )
        })}
      </ul>
      <div className="s2a_actions">
        <button className="s2a_primary" disabled={busy.length > 0} onClick={save}>
          {busy === 'save' ? '保存中…' : '保存配置'}
        </button>
        <button className="s2a_btn" disabled={busy.length > 0} onClick={checkStatus}>
          {busy === 'status' ? '…' : '查看状态'}
        </button>
      </div>
      {message.length > 0 && <p className="s2a_status s2a_statusOk" style={{ marginTop: 6 }}>{message}</p>}
      {error.length > 0 && <p className="s2a_status s2a_statusErr" style={{ marginTop: 6 }}>{error}</p>}
    </div>
  )
}

export default Sub2ApiSettings
