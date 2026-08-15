/**
 * Settings section for dsh-sub2api.
 *
 * One base URL, four provider cards (OpenAI / Claude / Grok / Gemini), each
 * with a key field and a structured model catalog. Keys are written to the
 * harness credential store through the host HTTP bridge; the base URL and
 * model catalogs land in the `llm-sub2api:` settings section.
 *
 * @module dsh-sub2api/client/settings
 */

import { useCallback, useEffect, useState } from 'react'
import { ProviderIcon } from './icons.tsx'
import type { ProviderIconName } from './icons.tsx'

const BASE = '/plugins/dsh-sub2api'
const MODELS_DEV_API = 'https://models.dev/api.json'

/** Model-row controls matching the official Models page. */
function IconTrash() {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden>
      <path
        d="M3.5 5.25h13M8 5.25V3.5h4v1.75M5.25 5.25l.8 10.1c.05.65.6 1.15 1.25 1.15h5.4c.65 0 1.2-.5 1.25-1.15l.8-10.1M8.25 8v5.75M11.75 8v5.75"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function IconChevron({ expanded }: { expanded: boolean }) {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="none"
      aria-hidden
      style={{ transform: expanded ? 'rotate(90deg)' : undefined, transition: 'transform 120ms ease' }}
    >
      <path d="m7.5 4.75 5.25 5.25-5.25 5.25" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

interface ProviderDefinition {
  key: string
  label: string
  icon: ProviderIconName
  placeholder: string
  modelsDevProvider: string
}

const PROVIDERS: ProviderDefinition[] = [
  { key: 'openai', label: 'OpenAI', icon: 'openai', placeholder: 'sk-…', modelsDevProvider: 'openai' },
  { key: 'claude', label: 'Claude', icon: 'claude', placeholder: 'sk-ant-…', modelsDevProvider: 'anthropic' },
  { key: 'grok', label: 'Grok', icon: 'grok', placeholder: 'xai-…', modelsDevProvider: 'xai' },
  { key: 'gemini', label: 'Gemini', icon: 'gemini', placeholder: 'AIza…', modelsDevProvider: 'google' },
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
.s2a_rows{flex-direction:column;gap:10px;margin:4px 0 0;padding:0;list-style:none;display:flex}
.s2a_rowCard{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;flex-direction:column;gap:12px;padding:14px 16px;display:flex}
.s2a_rowHead{align-items:center;gap:10px;display:flex}
.s2a_rowIdentity{flex:1;align-items:center;gap:8px;min-width:0;display:inline-flex}
.s2a_rowName{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:500;line-height:22px}
.s2a_rowTag{border:1px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-secondary);border-radius:4px;flex:none;padding:1px 6px;font-size:11px;line-height:16px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.s2a_editor{background:var(--dsw-alias-bg-module-platform);border-radius:8px;flex-direction:column;gap:12px;padding:12px 14px;display:flex}
.s2a_rowActions,.s2a_modelActions{align-items:center;gap:4px;margin-left:auto;display:inline-flex}
.s2a_btn,.s2a_primary{box-sizing:border-box;height:32px;font:inherit;cursor:pointer;border:none;justify-content:center;align-items:center;gap:4px;font-size:13px;line-height:20px;display:inline-flex}
.s2a_btn,.s2a_primary{border-radius:16px;padding:0 14px}
.s2a_primary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}
.s2a_primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}
.s2a_btn{border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);background:transparent}
.s2a_btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.s2a_btn:disabled,.s2a_primary:disabled{opacity:.4;cursor:default}
.s2a_btn:focus-visible,.s2a_primary:focus-visible{box-shadow:0 0 0 2px var(--dsw-alias-border-l3);outline:none}
/* Square, label-free icon affordance matching the official Models page: the
   row's inputs carry the meaning, the trash glyph announces deletion. */
.s2a_iconBtn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border:none;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;padding:0}
.s2a_iconBtn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.s2a_iconBtn:disabled{opacity:.4;cursor:default}
.s2a_iconBtn:focus-visible{box-shadow:0 0 0 2px var(--dsw-alias-border-l3);outline:none}
.s2a_trash:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary)}
.s2a_models{flex-direction:column;gap:10px;display:flex}
.s2a_modelItem{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;overflow:hidden;background:var(--dsw-alias-bg-layer-1)}
.s2a_modelSummary{grid-template-columns:minmax(0,1fr) minmax(0,.72fr) 44px 32px;align-items:center;gap:10px;padding:9px 10px 9px 12px;display:grid}
.s2a_modelSummary .s2a_input{height:38px;border-radius:7px;padding:0 12px;font-size:14px}
.s2a_expandBtn{width:44px;height:38px;border-radius:7px;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary)}
.s2a_modelDetails{border-top:1px solid var(--dsw-alias-border-l2);grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:10px 12px;padding:10px 12px 12px;display:grid}
.s2a_modelDetails .s2a_fieldLabel{font-size:12px;font-weight:400}
/* Derived, read-only display for fields auto-filled from models.dev. */
.s2a_readonly{box-sizing:border-box;width:100%;height:32px;font:inherit;border:1px dashed var(--dsw-alias-border-l3);background:transparent;color:var(--dsw-alias-label-secondary);border-radius:8px;padding:0 10px;font-size:13px;line-height:30px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.s2a_reasoningField{grid-column:1/-1}
.s2a_modelEmpty{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;color:var(--dsw-alias-label-tertiary);margin:0;padding:16px 10px;text-align:center;font-size:12px;line-height:18px}
.s2a_modelFooter{align-items:center;justify-content:space-between;gap:8px;display:flex}
.s2a_modelSource{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
.s2a_modelSource a{color:inherit;text-decoration:underline;text-underline-offset:2px}
.s2a_actions{align-items:center;gap:8px;margin-top:4px;display:flex}
.s2a_status{margin:0;font-size:12px;line-height:18px;white-space:pre-wrap;color:var(--dsw-alias-label-secondary)}
.s2a_statusOk{color:var(--dsw-alias-state-success-primary)}
.s2a_statusErr{color:var(--dsw-alias-state-error-primary)}
@media(max-width:620px){
  .s2a_section,.s2a_rowIdentity{min-width:0}.s2a_rowCard{padding:10px 8px}.s2a_editor{padding:8px 0}
  .s2a_rowHead{align-items:flex-start;flex-wrap:wrap}.s2a_rowIdentity{flex-wrap:wrap}.s2a_rowTag{box-sizing:border-box;width:100%;max-width:100%;min-width:0;flex:1 1 100%;white-space:normal;overflow-wrap:anywhere}.s2a_rowActions{width:100%;margin-left:0;flex-direction:column;align-items:stretch}.s2a_rowActions .s2a_btn{width:100%}
  .s2a_modelSummary{grid-template-columns:minmax(0,1fr) 44px 32px;gap:8px;padding:8px}.s2a_modelSummary>div:nth-child(2){grid-column:1/2;grid-row:2}.s2a_modelSummary>.s2a_expandBtn{grid-column:2;grid-row:1/3}.s2a_modelSummary>.s2a_trash{grid-column:3;grid-row:1/3}
  .s2a_modelDetails{grid-template-columns:minmax(0,1fr)}.s2a_reasoningField{grid-column:auto}
  .s2a_modelFooter{align-items:stretch;flex-direction:column}.s2a_modelActions{width:100%;margin-left:0;align-items:stretch;flex-direction:column}.s2a_modelActions .s2a_btn{width:100%;padding:0 8px}
}
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

interface CatalogModel {
  id: string
  name?: string
  contextWindow?: number
  maxTokens?: number
  input?: Array<'text' | 'image'>
  reasoningEfforts?: string[]
}

interface ModelRow {
  rowId: number
  id: string
  name: string
  contextWindow: string
  maxTokens: string
  /** '' = 自动（按模型 ID 推断）; 'text' = 仅文本; 'text-image' = 文本 + 图片 */
  input: string
  /** '' = 自动（未设置，按路由默认）; 'on' = 支持（档位见 effortLevels）; 'off' = 不支持 */
  reasoning: string
  /** 该模型实际支持的推理档位（reasoning === 'on' 时保存到配置） */
  effortLevels: string[]
}

const DEFAULT_REASONING_LEVELS = ['low', 'medium', 'high']

interface ProviderState {
  key: string
  keyConfigured: boolean
  models: ModelRow[]
}

interface ImageToolModelRef {
  provider: string
  model: string
}

interface ImageToolsState {
  analyze: ImageToolModelRef
  generate: ImageToolModelRef
}

interface ConfigState {
  baseURL: string
  catalogFormat?: 'structured-v1'
  providers: Record<string, { keyConfigured: boolean; models: Array<CatalogModel | string> }>
  tools?: {
    analyze?: ImageToolModelRef
    generate?: ImageToolModelRef
  }
}

interface ModelsDevModel {
  id?: string
  name?: string
  /** Whether the model accepts image input (models.dev `attachment`). */
  attachment?: boolean
  /** Explicit modality list when the entry carries one. */
  modalities?: { input?: string[] }
  reasoning?: boolean
  /** models.dev JSON key is `reasoning_options` (snake_case). */
  reasoning_options?: Array<{ type?: string; values?: string[] }>
  limit?: { context?: number; output?: number }
}

interface ModelsDevProvider {
  models?: Record<string, ModelsDevModel>
}

type ModelsDevCatalog = Record<string, ModelsDevProvider>

let nextRowId = 1
let modelsDevRequest: Promise<ModelsDevCatalog> | undefined

function modelRow(model: CatalogModel | string = { id: '' }): ModelRow {
  if (typeof model === 'string') {
    const [id = '', name = '', contextWindow = ''] = model.split('|')
    return { rowId: nextRowId++, id: id.trim(), name: name.trim(), contextWindow: contextWindow.trim(), maxTokens: '', input: '', reasoning: '', effortLevels: [] }
  }
  const reasoningEfforts = model.reasoningEfforts
  return {
    rowId: nextRowId++,
    id: model.id,
    name: model.name ?? '',
    contextWindow: model.contextWindow !== undefined ? String(model.contextWindow) : '',
    maxTokens: model.maxTokens !== undefined ? String(model.maxTokens) : '',
    input: model.input === undefined ? '' : model.input.includes('image') ? 'text-image' : 'text',
    reasoning: reasoningEfforts === undefined ? '' : reasoningEfforts.length === 0 ? 'off' : 'on',
    effortLevels: reasoningEfforts !== undefined && reasoningEfforts.length > 0 ? [...reasoningEfforts] : [],
  }
}

function loadModelsDev(): Promise<ModelsDevCatalog> {
  modelsDevRequest ??= fetch(MODELS_DEV_API)
    .then(async (response) => {
      if (!response.ok) throw new Error(`models.dev HTTP ${response.status}`)
      return await response.json() as ModelsDevCatalog
    })
    .catch((error) => {
      modelsDevRequest = undefined
      throw error
    })
  return modelsDevRequest
}

function canonicalModelsDevProvider(id: string): string | undefined {
  const normalized = id.toLowerCase()
  if (/^(gpt|o[134]|codex)/.test(normalized)) return 'openai'
  if (normalized.startsWith('claude')) return 'anthropic'
  if (normalized.startsWith('grok')) return 'xai'
  if (normalized.startsWith('gemini')) return 'google'
  if (normalized.startsWith('deepseek')) return 'deepseek'
  return undefined
}

function officialModel(catalog: ModelsDevCatalog, def: ProviderDefinition, id: string): ModelsDevModel | undefined {
  const preferredProviders = [canonicalModelsDevProvider(id), def.modelsDevProvider].filter((provider, index, all): provider is string => (
    provider !== undefined && all.indexOf(provider) === index
  ))
  for (const provider of preferredProviders) {
    const models = catalog[provider]?.models
    const match = models?.[id] ?? (models !== undefined ? Object.values(models).find((model) => model.id === id) : undefined)
    if (match !== undefined) return match
  }
  for (const provider of Object.values(catalog)) {
    const models = provider.models
    const match = models?.[id] ?? (models !== undefined ? Object.values(models).find((model) => model.id === id) : undefined)
    if (match !== undefined) return match
  }
  return undefined
}

/** The concrete reasoning-effort levels a model advertises, or undefined. */
function officialEffortValues(official: ModelsDevModel): string[] | undefined {
  const effort = official.reasoning_options?.find((option) => option.type === 'effort')
  const values = effort?.values
  if (values === undefined || values.length === 0) return undefined
  return values.filter((value): value is string => typeof value === 'string' && value.length > 0)
}

/**
 * Image-input modality derived from models.dev: an explicit modality list
 * wins, then the `attachment` flag. Absent means the entry says nothing, and
 * the row keeps "auto" (the adapter infers from the model id).
 */
function officialInput(official: ModelsDevModel): 'text' | 'text-image' | undefined {
  const input = official.modalities?.input
  if (Array.isArray(input) && input.includes('image')) return 'text-image'
  if (typeof official.attachment === 'boolean') return official.attachment ? 'text-image' : 'text'
  return undefined
}

function applyOfficialDefaults(rows: ModelRow[], def: ProviderDefinition, catalog: ModelsDevCatalog): { rows: ModelRow[]; filled: number } {
  let filled = 0
  const next = rows.map((row) => {
    const official = officialModel(catalog, def, row.id.trim())
    if (official === undefined) return row
    const name = row.name.trim().length === 0 && typeof official.name === 'string' ? official.name : row.name
    const officialContext = official.limit?.context
    const contextWindow = row.contextWindow.length === 0 && Number.isSafeInteger(officialContext) && (officialContext ?? 0) > 0
      ? String(officialContext)
      : row.contextWindow
    const officialOutput = official.limit?.output
    const maxTokens = row.maxTokens.length === 0 && Number.isSafeInteger(officialOutput) && (officialOutput ?? 0) > 0
      ? String(officialOutput)
      : row.maxTokens
    // 图片输入：models.dev 有数据就自动定，用户不用选
    const input = row.input.length === 0 && officialInput(official) !== undefined ? officialInput(official)! : row.input
    const officialEfforts = officialEffortValues(official)
    let reasoning = row.reasoning
    let effortLevels = row.effortLevels
    if (reasoning.length === 0) {
      if (officialEfforts !== undefined && officialEfforts.length > 0) {
        reasoning = 'on'
        effortLevels = officialEfforts
      } else if (typeof official.reasoning === 'boolean') {
        reasoning = official.reasoning ? 'on' : 'off'
        effortLevels = official.reasoning ? [...DEFAULT_REASONING_LEVELS] : []
      }
    }
    if (
      name !== row.name || contextWindow !== row.contextWindow || maxTokens !== row.maxTokens
      || input !== row.input
      || reasoning !== row.reasoning || effortLevels.join(',') !== row.effortLevels.join(',')
    ) filled++
    return { ...row, name, contextWindow, maxTokens, input, reasoning, effortLevels }
  })
  return { rows: next, filled }
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

function emptyProvider(): ProviderState {
  return { key: '', keyConfigured: false, models: [] }
}

function emptyToolRef(): ImageToolModelRef {
  return { provider: '', model: '' }
}

function emptyTools(): ImageToolsState {
  return { analyze: emptyToolRef(), generate: emptyToolRef() }
}

function toolRefFromConfig(value: ImageToolModelRef | undefined): ImageToolModelRef {
  return {
    provider: value?.provider ?? '',
    model: value?.model ?? '',
  }
}

function toolOptions(providers: Record<string, ProviderState>): Array<{ value: string; label: string; provider: string; model: string }> {
  const options: Array<{ value: string; label: string; provider: string; model: string }> = []
  for (const def of PROVIDERS) {
    const provider = providers[def.key]
    if (provider === undefined) continue
    for (const row of provider.models) {
      const id = row.id.trim()
      if (id.length === 0) continue
      const name = row.name.trim()
      options.push({
        value: `${def.key}:${id}`,
        label: `${def.label} / ${name.length > 0 ? `${name} (${id})` : id}`,
        provider: def.key,
        model: id,
      })
    }
  }
  return options
}

function serializeToolRef(ref: ImageToolModelRef): ImageToolModelRef | undefined {
  const provider = ref.provider.trim()
  const model = ref.model.trim()
  if (provider.length === 0 || model.length === 0) return undefined
  return { provider, model }
}

export function Sub2ApiSettings() {
  const [baseURL, setBaseURL] = useState('')
  const [providers, setProviders] = useState<Record<string, ProviderState>>({})
  const [tools, setTools] = useState<ImageToolsState>(emptyTools())
  const [structuredConfig, setStructuredConfig] = useState(false)
  const [expandedModels, setExpandedModels] = useState<Set<number>>(() => new Set())
  const [busy, setBusy] = useState('')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    ensureCss()
    api<ConfigState>(`${BASE}/config`)
      .then(async (cfg) => {
        setBaseURL(cfg.baseURL ?? '')
        setStructuredConfig(cfg.catalogFormat === 'structured-v1')
        const map: Record<string, ProviderState> = {}
        for (const def of PROVIDERS) {
          const provider = cfg.providers?.[def.key]
          map[def.key] = {
            key: '',
            keyConfigured: provider?.keyConfigured ?? false,
            models: (provider?.models ?? []).map(modelRow),
          }
        }
        setProviders(map)
        setTools({
          analyze: toolRefFromConfig(cfg.tools?.analyze),
          generate: toolRefFromConfig(cfg.tools?.generate),
        })
        try {
          const catalog = await loadModelsDev()
          setProviders((current) => {
            const enriched = { ...current }
            for (const def of PROVIDERS) {
              const provider = current[def.key]
              if (provider !== undefined) enriched[def.key] = { ...provider, models: applyOfficialDefaults(provider.models, def, catalog).rows }
            }
            return enriched
          })
        } catch {
          // The form remains fully editable when the optional public catalog is unavailable.
        }
      })
      .catch((e) => setError(String(e instanceof Error ? e.message : e)))
  }, [])

  const updateProvider = useCallback((key: string, patch: Partial<ProviderState>) => {
    setProviders((previous) => ({ ...previous, [key]: { ...(previous[key] ?? emptyProvider()), ...patch } }))
  }, [])

  const updateModel = (providerKey: string, rowId: number, patch: Partial<ModelRow>) => {
    const provider = providers[providerKey] ?? emptyProvider()
    updateProvider(providerKey, { models: provider.models.map((row) => row.rowId === rowId ? { ...row, ...patch } : row) })
  }

  const toggleModel = (rowId: number) => {
    setExpandedModels((current) => {
      const next = new Set(current)
      if (next.has(rowId)) next.delete(rowId)
      else next.add(rowId)
      return next
    })
  }

  const fillModel = async (def: ProviderDefinition, rowId: number) => {
    try {
      const catalog = await loadModelsDev()
      setProviders((previous) => {
        const provider = previous[def.key]
        if (provider === undefined) return previous
        const models = provider.models.map((row) => row.rowId === rowId ? applyOfficialDefaults([row], def, catalog).rows[0] ?? row : row)
        return { ...previous, [def.key]: { ...provider, models } }
      })
    } catch {
      // Manual values remain available if models.dev cannot be reached.
    }
  }

  const fillProvider = async (def: ProviderDefinition) => {
    setBusy(`metadata-${def.key}`); setError(''); setMessage('')
    try {
      const catalog = await loadModelsDev()
      const provider = providers[def.key] ?? emptyProvider()
      const result = applyOfficialDefaults(provider.models, def, catalog)
      updateProvider(def.key, { models: result.rows })
      setMessage(result.filled > 0 ? `${def.label} 已从 models.dev 补全 ${result.filled} 个模型` : `${def.label} 没有需要补全的模型`)
    } catch (e) {
      setError(`无法读取 models.dev：${String(e instanceof Error ? e.message : e)}`)
    } finally {
      setBusy('')
    }
  }

  const save = async () => {
    setBusy('save'); setError(''); setMessage('')
    try {
      if (!structuredConfig) throw new Error('服务端仍在运行旧版插件，请重启 DSH Web 后再保存结构化模型配置')
      const payload = {
        baseURL,
        providers: {} as Record<string, { apiKey: string; models: CatalogModel[] }>,
        tools: {} as { analyze?: ImageToolModelRef; generate?: ImageToolModelRef },
      }
      for (const def of PROVIDERS) {
        const provider = providers[def.key] ?? emptyProvider()
        const nonEmptyRows = provider.models.filter((row) =>
          row.id.trim().length > 0 || row.name.trim().length > 0 || row.contextWindow.length > 0 || row.maxTokens.length > 0 || row.reasoning.length > 0)
        const seen = new Set<string>()
        const models = nonEmptyRows.map((row) => {
          const id = row.id.trim()
          if (id.length === 0) throw new Error(`${def.label} 存在未填写 ID 的模型`)
          if (seen.has(id)) throw new Error(`${def.label} 模型 ID 重复：${id}`)
          seen.add(id)
          const name = row.name.trim()
          const contextWindow = row.contextWindow.length > 0 ? Number(row.contextWindow) : undefined
          if (contextWindow !== undefined && (!Number.isSafeInteger(contextWindow) || contextWindow < 1)) {
            throw new Error(`${def.label} ${id} 的 Context Window 必须是正整数`)
          }
          const maxTokens = row.maxTokens.trim().length > 0 ? Number(row.maxTokens) : undefined
          if (maxTokens !== undefined && (!Number.isSafeInteger(maxTokens) || maxTokens < 1)) {
            throw new Error(`${def.label} ${id} 的 Max Tokens 必须是正整数`)
          }
          const reasoningEfforts = row.reasoning === 'off' ? [] : row.reasoning === 'on'
            ? (row.effortLevels.length > 0 ? row.effortLevels : [...DEFAULT_REASONING_LEVELS])
            : undefined
          const input: Array<'text' | 'image'> | undefined = row.input === 'text-image'
            ? ['text', 'image']
            : row.input === 'text'
              ? ['text']
              : undefined
          return {
            id,
            ...(name.length > 0 ? { name } : {}),
            ...(contextWindow !== undefined ? { contextWindow } : {}),
            ...(maxTokens !== undefined ? { maxTokens } : {}),
            ...(input !== undefined ? { input } : {}),
            ...(reasoningEfforts !== undefined ? { reasoningEfforts } : {}),
          }
        })
        payload.providers[def.key] = { apiKey: provider.key, models }
      }
      const analyze = serializeToolRef(tools.analyze)
      const generate = serializeToolRef(tools.generate)
      if (analyze !== undefined) payload.tools.analyze = analyze
      if (generate !== undefined) payload.tools.generate = generate
      const res = await api<{ ok: boolean; routes?: string[] }>(`${BASE}/config`, { method: 'POST', body: JSON.stringify(payload) })
      const routes = res.routes !== undefined && res.routes.length > 0 ? res.routes.join(', ') : '无（未填 key）'
      setMessage(`已保存。激活路由: ${routes}`)
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e))
    } finally {
      setBusy('')
    }
  }

  const discover = async (def: ProviderDefinition) => {
    const key = providers[def.key]?.key ?? ''
    setBusy(`discover-${def.key}`); setError(''); setMessage('')
    // 先清空现有模型列表，再重新拉取：失败的拉取不会残留旧列表。
    updateProvider(def.key, { models: [] })
    try {
      const res = await api<{ ok: boolean; models: CatalogModel[] }>(`${BASE}/discover`, {
        method: 'POST',
        body: JSON.stringify({ baseURL, apiKey: key, provider: def.key }),
      })
      let rows = (res.models ?? []).map(modelRow)
      try {
        rows = applyOfficialDefaults(rows, def, await loadModelsDev()).rows
      } catch {
        // Discovery results are still useful without public metadata.
      }
      updateProvider(def.key, { models: rows })
      setMessage(`${def.label} 发现 ${rows.length} 个模型`)
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e))
    } finally {
      setBusy('')
    }
  }

  const checkUsage = async (def: ProviderDefinition) => {
    const key = providers[def.key]?.key ?? ''
    setBusy(`usage-${def.key}`); setError(''); setMessage('')
    try {
      const res = await api<{ ok: boolean; summary?: string }>(`${BASE}/usage`, {
        method: 'POST',
        body: JSON.stringify({ baseURL, apiKey: key, provider: def.key }),
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
        提示：先在 sub2api 后台创建各平台的分组并生成 API key，再填入下方。
      </p>
      <div className="s2a_field" style={{ marginTop: 2 }}>
        <label className="s2a_fieldLabel">Sub2API Base URL</label>
        <input className="s2a_input" value={baseURL} placeholder="http://localhost:8080/v1" onChange={(event) => setBaseURL(event.target.value)} />
      </div>
      <div className="s2a_rowCard">
        <div className="s2a_rowHead">
          <div className="s2a_rowIdentity">
            <span className="s2a_rowName">全局图像工具</span>
            <span className="s2a_rowTag">analyze_image / generate_image</span>
          </div>
        </div>
        <div className="s2a_editor">
          <p className="s2a_intro">
            给当前会话模型补两个全局工具：识图走 vision 模型，生图走 image 模型。未配置时工具仍会出现，但调用会提示先在这里指定模型。
          </p>
          {(['analyze', 'generate'] as const).map((kind) => {
            const label = kind === 'analyze' ? '识图模型' : '生图模型'
            const ref = tools[kind]
            const options = toolOptions(providers)
            const selected = ref.provider.length > 0 && ref.model.length > 0 ? `${ref.provider}:${ref.model}` : ''
            const known = options.some((option) => option.value === selected)
            return (
              <div key={kind} className="s2a_field">
                <label className="s2a_fieldLabel">{label}</label>
                <select
                  className="s2a_input"
                  value={selected}
                  aria-label={label}
                  onChange={(event) => {
                    const next = options.find((option) => option.value === event.target.value)
                    setTools((current) => ({
                      ...current,
                      [kind]: next === undefined ? emptyToolRef() : { provider: next.provider, model: next.model },
                    }))
                  }}
                >
                  <option value="">未指定</option>
                  {!known && selected.length > 0 && (
                    <option value={selected}>{`${ref.provider} / ${ref.model}（不在当前目录）`}</option>
                  )}
                  {options.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </div>
            )
          })}
        </div>
      </div>
      <ul className="s2a_rows">
        {PROVIDERS.map((def) => {
          const provider = providers[def.key] ?? emptyProvider()
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
                    {busy === `discover-${def.key}` ? '…' : '获取模型'}
                  </button>
                  <button className="s2a_btn" disabled={busy.length > 0} onClick={() => checkUsage(def)}>
                    {busy === `usage-${def.key}` ? '…' : '查看用量'}
                  </button>
                </div>
              </div>
              <div className="s2a_editor">
                <div className="s2a_field">
                  <label className="s2a_fieldLabel">
                    {def.label} API Key{provider.keyConfigured || provider.key.length > 0 ? ' ✓' : ''}
                  </label>
                  <input
                    className="s2a_input"
                    type="password"
                    value={provider.key}
                    placeholder={provider.keyConfigured ? `${def.placeholder}（已配置，留空保持不变）` : def.placeholder}
                    onChange={(event) => updateProvider(def.key, { key: event.target.value })}
                  />
                </div>
                <div className="s2a_field">
                  <label className="s2a_fieldLabel">模型列表</label>
                  <div className="s2a_models">
                    {provider.models.length === 0
                      ? <p className="s2a_modelEmpty">暂无模型</p>
                      : provider.models.map((row) => {
                        const expanded = expandedModels.has(row.rowId)
                        const detailsId = `s2a-model-${row.rowId}-details`
                        return (
                          <div key={row.rowId} className="s2a_modelItem">
                            <div className="s2a_modelSummary">
                              <div>
                                <input
                                  className="s2a_input"
                                  value={row.id}
                                  placeholder="模型 ID"
                                  aria-label={`${def.label} 模型 ID`}
                                  onChange={(event) => updateModel(def.key, row.rowId, { id: event.target.value })}
                                  onBlur={() => fillModel(def, row.rowId)}
                                />
                              </div>
                              <div>
                                <input
                                  className="s2a_input"
                                  value={row.name}
                                  placeholder="名称"
                                  aria-label={`${def.label} 模型名称`}
                                  onChange={(event) => updateModel(def.key, row.rowId, { name: event.target.value })}
                                />
                              </div>
                              <button
                                type="button"
                                className="s2a_iconBtn s2a_expandBtn"
                                title={expanded ? '收起模型详情' : '展开模型详情'}
                                aria-label={expanded ? `收起 ${row.id || '模型'} 详情` : `展开 ${row.id || '模型'} 详情`}
                                aria-expanded={expanded}
                                aria-controls={detailsId}
                                onClick={() => toggleModel(row.rowId)}
                              >
                                <IconChevron expanded={expanded} />
                              </button>
                              <button
                                type="button"
                                className="s2a_iconBtn s2a_trash"
                                title="删除模型"
                                aria-label={`删除 ${row.id || '模型'}`}
                                onClick={() => updateProvider(def.key, { models: provider.models.filter((item) => item.rowId !== row.rowId) })}
                              >
                                <IconTrash />
                              </button>
                            </div>
                            {expanded && (
                              <div id={detailsId} className="s2a_modelDetails">
                                <div className="s2a_field">
                                  <label className="s2a_fieldLabel">上下文窗口</label>
                                  <input
                                    className="s2a_input"
                                    type="number"
                                    min="1"
                                    step="1"
                                    value={row.contextWindow}
                                    placeholder="自动填充"
                                    aria-label={`${def.label} 上下文窗口`}
                                    onChange={(event) => updateModel(def.key, row.rowId, { contextWindow: event.target.value })}
                                  />
                                </div>
                                <div className="s2a_field">
                                  <label className="s2a_fieldLabel">最大输出 token</label>
                                  <input
                                    className="s2a_input"
                                    type="number"
                                    min="1"
                                    step="1"
                                    value={row.maxTokens}
                                    placeholder="自动填充"
                                    aria-label={`${def.label} 最大输出 token`}
                                    onChange={(event) => updateModel(def.key, row.rowId, { maxTokens: event.target.value })}
                                  />
                                </div>
                                <div className="s2a_field">
                                  <label className="s2a_fieldLabel">图片输入（自动补全）</label>
                                  <div className="s2a_readonly">
                                    {row.input === 'text-image' ? '文本 + 图片' : row.input === 'text' ? '仅文本' : '自动（按模型推断）'}
                                  </div>
                                </div>
                                <div className="s2a_field s2a_reasoningField">
                                  <label className="s2a_fieldLabel">思考强度（自动补全）</label>
                                  <div className="s2a_readonly">
                                    {row.reasoning === 'on'
                                      ? (row.effortLevels.length > 0 ? row.effortLevels.join(' / ') : '支持')
                                      : row.reasoning === 'off'
                                        ? '不支持'
                                        : '自动（low / medium / high）'}
                                  </div>
                                </div>
                              </div>
                            )}
                          </div>
                        )
                      })}
                  </div>
                  <div className="s2a_modelFooter">
                    <span className="s2a_modelSource">
                      默认值来自 <a href="https://models.dev/" target="_blank" rel="noreferrer">models.dev</a>，未匹配时可手动填写
                    </span>
                    <div className="s2a_modelActions">
                      <button className="s2a_btn" disabled={busy.length > 0 || provider.models.length === 0} onClick={() => fillProvider(def)}>
                        {busy === `metadata-${def.key}` ? '…' : '补全数据'}
                      </button>
                      <button className="s2a_btn" disabled={busy.length > 0} onClick={() => updateProvider(def.key, { models: [...provider.models, modelRow()] })}>
                        添加模型
                      </button>
                    </div>
                  </div>
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
