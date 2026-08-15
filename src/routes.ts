/**
 * HTTP routes for the dsh-sub2api settings page.
 *
 * The browser half of a static plugin talks to the host through the web
 * server (there is no package-private `host.call` seam outside dynamic
 * packages), so this module exposes read/write endpoints for the plugin's
 * settings section. Requests are restricted to trusted local origins — the
 * same `trustedRequest` posture the oauth plugin uses — because these routes
 * mutate configuration and echo credential state.
 *
 * @module dsh-sub2api/routes
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { API_PROTOCOLS, PROVIDERS, type ApiProtocol, type CatalogModel, type Config, type ImageToolModelRef, type ImageToolsConfig, type ProviderKey, type ProviderProfile } from './index.ts'

export const ROUTES = {
  get: '/plugins/dsh-sub2api/config',
  set: '/plugins/dsh-sub2api/config',
  discover: '/plugins/dsh-sub2api/discover',
  usage: '/plugins/dsh-sub2api/usage',
  status: '/plugins/dsh-sub2api/status',
} as const

export interface ConfigPayload {
  baseURL: string
  catalogFormat: 'structured-v1'
  providers: Record<string, { keyConfigured: boolean; models: CatalogModel[] }>
  tools: ImageToolsConfig
}

function trustedRequest(req: IncomingMessage): boolean {
  const remote = req.socket.remoteAddress
  if (remote !== '127.0.0.1' && remote !== '::1' && remote !== '::ffff:127.0.0.1') return false
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const host = req.headers.host
  if (host === undefined) return false
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === new URL(`http://${host}`).host
  } catch {
    return false
  }
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text.length === 0) return {}
  const value: unknown = JSON.parse(text)
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(JSON.stringify(value))
}

function safeMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  try {
    const text = String(error)
    return text.length > 0 ? text : 'unknown error'
  } catch {
    return 'unknown error'
  }
}

function readProviderConfig(config: Config): ConfigPayload {
  const providers: ConfigPayload['providers'] = {}
  for (const def of PROVIDERS) {
    const profile = config.providers[def.key]
    providers[def.key] = {
      keyConfigured: profile.apiKeyEnv !== undefined,
      models: profile.models?.map((model) => ({ ...model })) ?? [],
    }
  }
  return {
    baseURL: config.baseURL,
    catalogFormat: 'structured-v1',
    providers,
    tools: {
      ...(config.tools?.analyze !== undefined ? { analyze: { ...config.tools.analyze } } : {}),
      ...(config.tools?.generate !== undefined ? { generate: { ...config.tools.generate } } : {}),
    },
  }
}

function legacyCatalogModel(value: string): CatalogModel | undefined {
  const [rawId = '', rawName = '', rawContextWindow = ''] = value.split('|')
  const id = rawId.trim()
  if (id.length === 0) return undefined
  const name = rawName.trim()
  const parsedContextWindow = Number(rawContextWindow.trim())
  const contextWindow = Number.isSafeInteger(parsedContextWindow) && parsedContextWindow > 0
    ? parsedContextWindow
    : undefined
  return {
    id,
    ...(name.length > 0 ? { name } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
  }
}

function structuredCatalogModel(value: unknown): CatalogModel | undefined {
  if (typeof value === 'string') return legacyCatalogModel(value)
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  const id = typeof raw.id === 'string' ? raw.id.trim() : ''
  if (id.length === 0) return undefined
  const name = typeof raw.name === 'string' ? raw.name.trim() : ''
  const contextWindow = typeof raw.contextWindow === 'number' && Number.isSafeInteger(raw.contextWindow) && raw.contextWindow > 0
    ? raw.contextWindow
    : undefined
  const maxTokens = typeof raw.maxTokens === 'number' && Number.isSafeInteger(raw.maxTokens) && raw.maxTokens > 0
    ? raw.maxTokens
    : undefined
  const reasoningEfforts = Array.isArray(raw.reasoningEfforts)
    ? (raw.reasoningEfforts as unknown[]).filter((effort): effort is string => typeof effort === 'string' && effort.length > 0)
    : undefined
  const input = Array.isArray(raw.input)
    ? (raw.input as unknown[]).filter((modality): modality is 'text' | 'image' => modality === 'text' || modality === 'image')
    : undefined
  return {
    id,
    ...(name.length > 0 ? { name } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(reasoningEfforts !== undefined ? { reasoningEfforts } : {}),
    ...(input !== undefined && input.length > 0 ? { input } : {}),
  }
}

function readCatalogModels(value: unknown, fallback: CatalogModel[]): CatalogModel[] {
  if (Array.isArray(value)) return value.map(structuredCatalogModel).filter((model) => model !== undefined)
  if (typeof value === 'string') {
    return value.split(/[\n,]/).map(legacyCatalogModel).filter((model) => model !== undefined)
  }
  return fallback
}

function providerCredentialRef(platform: string): CredentialRef {
  return credentialRef(`SUB2API_${platform.toUpperCase()}_API_KEY`)
}

function isProviderKey(value: string): value is ProviderKey {
  return PROVIDERS.some((def) => def.key === value)
}

function readToolModelRef(value: unknown): ImageToolModelRef | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  const provider = typeof raw.provider === 'string' ? raw.provider.trim() : ''
  const model = typeof raw.model === 'string' ? raw.model.trim() : ''
  if (!isProviderKey(provider) || model.length === 0) return undefined
  return { provider, model }
}

function readImageTools(value: unknown, fallback: ImageToolsConfig | undefined): ImageToolsConfig | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return fallback
  const raw = value as Record<string, unknown>
  const analyze = readToolModelRef(raw.analyze)
  const generate = readToolModelRef(raw.generate)
  if (analyze === undefined && generate === undefined) return undefined
  return {
    ...(analyze !== undefined ? { analyze } : {}),
    ...(generate !== undefined ? { generate } : {}),
  }
}

interface RouteContext {
  config: () => Config
  setConfig: (config: Config) => void | Promise<void>
  listRegisteredRoutes: () => string[]
  /**
   * Resolve the stored credential for one provider route. Used by discovery
   * and usage probes when the settings form does not carry a freshly typed
   * key (keys are write-only and stay in the credential store).
   */
  resolveApiKey: (route: string, profile: ProviderProfile) => Promise<string>
}

/**
 * One-shot probe key for discovery/usage: a freshly typed key wins (it is the
 * one under test); otherwise fall back to the credential already stored for
 * that provider, so the settings page does not force the user to re-type the
 * key every time.
 */
async function resolveProbeKey(
  ctx: Context,
  routes: RouteContext,
  provider: string,
  typedKey: string,
): Promise<string> {
  if (typedKey.length > 0) return typedKey
  if (!isProviderKey(provider)) throw new Error('provider 无效，应为 openai / claude / grok / gemini')
  const def = PROVIDERS.find((entry) => entry.key === provider)
  const profile = routes.config().providers[provider]
  if (profile?.apiKeyEnv === undefined) {
    throw new Error(`${def?.label ?? provider} 未配置 API key：请先填写 key 并保存配置，再获取模型/查看用量`)
  }
  try {
    return await routes.resolveApiKey(`sub2api-${provider}`, profile)
  } catch (error) {
    throw new Error(`无法使用已保存的 ${def?.label ?? provider} key：${safeMessage(error)}`)
  }
}

export function registerRoutes(ctx: Context, routes: RouteContext): void {
  ctx.inject(['webServer'], (webCtx) => {
    const register = (path: string, handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>) => {
      webCtx.webServer.register({ kind: 'exact', path, handler })
    }

    // GET/POST config share one pathname. The webserver routes by path only and
    // rejects duplicate paths, so a single handler dispatches on the method.
    register(ROUTES.get, async (req, res) => {
      if (req.method !== 'GET' && req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
      if (!trustedRequest(req)) return json(res, 403, { error: 'forbidden' })

      // GET config: redacted view for the settings page.
      if (req.method === 'GET') {
        json(res, 200, readProviderConfig(routes.config()))
        return
      }

      // POST config: persist baseURL + per-platform models; keys go to credentials.
      try {
        const body = await readJson(req)
        const baseURL = typeof body.baseURL === 'string' ? body.baseURL.trim().replace(/\/+$/, '') : ''
        if (baseURL.length === 0) return json(res, 400, { error: 'baseURL is required' })
        if (!/^https?:\/\//.test(baseURL)) return json(res, 400, { error: 'baseURL must start with http(s)://' })

        // Build a fresh config instead of mutating: the settings snapshot is
        // frozen (handed out immutably by the settings service).
        const current = routes.config()
        const next: Config = {
          baseURL,
          providers: {
            openai: { ...current.providers.openai },
            claude: { ...current.providers.claude },
            grok: { ...current.providers.grok },
            gemini: { ...current.providers.gemini },
          },
          ...(current.tools !== undefined ? { tools: { ...current.tools } } : {}),
        }

        const rawProviders = typeof body.providers === 'object' && body.providers !== null
          ? body.providers as Record<string, unknown>
          : {}
        const credentials = ctx.get('credentials')

        for (const def of PROVIDERS) {
          const raw = rawProviders[def.key] as Record<string, unknown> | undefined
          const profile = next.providers[def.key]
          const apiKey = typeof raw?.apiKey === 'string' ? raw.apiKey.trim() : ''
          if (apiKey.length > 0 && credentials !== undefined) {
            await credentials.set(providerCredentialRef(def.key), apiKey)
            profile.apiKeyEnv = providerCredentialRef(def.key)
          } else if (apiKey.length > 0 && credentials === undefined) {
            profile.apiKeyEnv = providerCredentialRef(def.key)
          }
          // Wire protocol: empty string clears an explicit override (the
          // group's native protocol applies); a valid name sets one.
          const api = typeof raw?.api === 'string' ? raw.api.trim() : undefined
          if (api !== undefined) {
            if (api.length === 0) {
              delete profile.api
            } else if ((API_PROTOCOLS as readonly string[]).includes(api)) {
              profile.api = api as ApiProtocol
            } else {
              return json(res, 400, { error: `${def.label} 的网关协议 "${api}" 无效，应为 ${API_PROTOCOLS.join(' / ')}` })
            }
          }
          profile.models = readCatalogModels(raw?.models, profile.models ?? [])
        }

        const tools = readImageTools(body.tools, current.tools)
        if (tools !== undefined) next.tools = tools
        else delete next.tools

        await routes.setConfig(next)
        json(res, 200, { ok: true, ...readProviderConfig(next), routes: routes.listRegisteredRoutes() })
      } catch (error) {
        json(res, 500, { error: safeMessage(error) })
      }
    })

    // POST discover: GET {baseURL}/models. A freshly typed key wins; without
    // one the stored credential for the provider is used.
    register(ROUTES.discover, async (req, res) => {
      if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
      if (!trustedRequest(req)) return json(res, 403, { error: 'forbidden' })
      try {
        const body = await readJson(req)
        const baseURL = typeof body.baseURL === 'string' ? body.baseURL.trim().replace(/\/+$/, '') : ''
        const provider = typeof body.provider === 'string' ? body.provider.trim() : ''
        if (baseURL.length === 0) return json(res, 400, { error: 'baseURL is required' })
        let apiKey: string
        try {
          apiKey = await resolveProbeKey(ctx, routes, provider, typeof body.apiKey === 'string' ? body.apiKey.trim() : '')
        } catch (error) {
          return json(res, 400, { error: safeMessage(error) })
        }
        const response = await fetch(`${baseURL}/models`, {
          method: 'GET',
          headers: { authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(30000),
        })
        if (!response.ok) {
          const text = await response.text().catch(() => '')
          return json(res, response.status, { error: `HTTP ${response.status}: ${text.slice(0, 300)}` })
        }
        const payload = await response.json() as { data?: Array<{ id?: unknown; display_name?: unknown; name?: unknown }> }
        const models = Array.isArray(payload.data)
          ? payload.data
            .map((m) => ({
              id: typeof m.id === 'string' ? m.id : '',
              name: typeof m.display_name === 'string' ? m.display_name : typeof m.name === 'string' ? m.name : undefined,
            }))
            .filter((m) => m.id.length > 0)
          : []
        json(res, 200, { ok: true, models })
      } catch (error) {
        json(res, 500, { error: safeMessage(error) })
      }
    })

    // POST usage: GET {baseURL}/usage. Same key fallback as discovery.
    register(ROUTES.usage, async (req, res) => {
      if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
      if (!trustedRequest(req)) return json(res, 403, { error: 'forbidden' })
      try {
        const body = await readJson(req)
        const baseURL = typeof body.baseURL === 'string' ? body.baseURL.trim().replace(/\/+$/, '') : ''
        const provider = typeof body.provider === 'string' ? body.provider.trim() : ''
        if (baseURL.length === 0) return json(res, 400, { error: 'baseURL is required' })
        let apiKey: string
        try {
          apiKey = await resolveProbeKey(ctx, routes, provider, typeof body.apiKey === 'string' ? body.apiKey.trim() : '')
        } catch (error) {
          return json(res, 400, { error: safeMessage(error) })
        }
        const response = await fetch(`${baseURL}/usage`, {
          method: 'GET',
          headers: { authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(30000),
        })
        if (!response.ok) {
          const text = await response.text().catch(() => '')
          return json(res, response.status, { error: `HTTP ${response.status}: ${text.slice(0, 300)}` })
        }
        const payload = await response.json() as Record<string, unknown>
        const parts: string[] = []
        const quota = payload.quota as Record<string, unknown> | undefined
        if (quota !== undefined && typeof quota.limit === 'number') {
          parts.push(`配额 ${String(quota.used ?? 0)}/${quota.limit}${typeof quota.unit === 'string' ? ` ${quota.unit}` : ''}（剩余 ${String(quota.remaining ?? 0)}）`)
        } else if (typeof payload.balance === 'number') {
          parts.push(`余额 $${payload.balance}`)
        } else if (typeof payload.remaining === 'number') {
          parts.push(`剩余 ${payload.remaining}${typeof payload.unit === 'string' ? ` ${payload.unit}` : ' USD'}`)
        }
        if (typeof payload.planName === 'string') parts.push(`分组: ${payload.planName}`)
        if (typeof payload.mode === 'string') parts.push(`模式: ${payload.mode}`)
        if (typeof payload.status === 'string') parts.push(`状态: ${payload.status}`)
        if (Array.isArray(payload.rate_limits)) {
          parts.push(`限流: ${(payload.rate_limits as Array<{ window?: unknown; used?: unknown; limit?: unknown }>)
            .map((r) => `${String(r.window ?? '')} ${String(r.used ?? 0)}/${String(r.limit ?? 0)}`).join(', ')}`)
        }
        const sub = payload.subscription as Record<string, unknown> | undefined
        if (sub !== undefined) {
          parts.push(`订阅日/周/月: ${[sub.daily_usage_usd, sub.weekly_usage_usd, sub.monthly_usage_usd]
            .map((v) => typeof v === 'number' ? `$${v}` : '-').join(' / ')}`)
        }
        json(res, 200, { ok: true, summary: parts.length > 0 ? parts.join('；') : '该 key 无配额/余额信息（unrestricted 模式）' })
      } catch (error) {
        json(res, 500, { error: safeMessage(error) })
      }
    })

    // GET status: registered routes + models per route.
    register(ROUTES.status, async (req, res) => {
      if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
      if (!trustedRequest(req)) return json(res, 403, { error: 'forbidden' })
      const config = routes.config()
      const models: Record<string, string[]> = {}
      for (const def of PROVIDERS) {
        if (config.providers[def.key].apiKeyEnv !== undefined) {
          models[def.route] = config.providers[def.key].models?.map((m) => m.id) ?? []
        }
      }
      json(res, 200, { routes: routes.listRegisteredRoutes(), models })
    })
  })
}
