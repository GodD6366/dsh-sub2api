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
import { PROVIDERS, type Config } from './index.ts'

export const ROUTES = {
  get: '/plugins/dsh-sub2api/config',
  set: '/plugins/dsh-sub2api/config',
  discover: '/plugins/dsh-sub2api/discover',
  usage: '/plugins/dsh-sub2api/usage',
  status: '/plugins/dsh-sub2api/status',
} as const

export interface ConfigPayload {
  baseURL: string
  providers: Record<string, { keyConfigured: boolean; models: string[] }>
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
      models: profile.models?.map((m) => m.id) ?? [],
    }
  }
  return { baseURL: config.baseURL, providers }
}

function providerCredentialRef(platform: string): CredentialRef {
  return credentialRef(`SUB2API_${platform.toUpperCase()}_API_KEY`)
}

interface RouteContext {
  config: () => Config
  setConfig: (config: Config) => void
  listRegisteredRoutes: () => string[]
}

export function registerRoutes(ctx: Context, routes: RouteContext): void {
  ctx.inject(['webServer'], (webCtx) => {
    const register = (path: string, handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>) => {
      webCtx.webServer.register({ kind: 'exact', path, handler })
    }

    // GET config: redacted view for the settings page.
    register(ROUTES.get, async (req, res) => {
      if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
      if (!trustedRequest(req)) return json(res, 403, { error: 'forbidden' })
      json(res, 200, readProviderConfig(routes.config()))
    })

    // POST config: persist baseURL + per-platform models; keys go to credentials.
    register(ROUTES.set, async (req, res) => {
      if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
      if (!trustedRequest(req)) return json(res, 403, { error: 'forbidden' })
      try {
        const body = await readJson(req)
        const baseURL = typeof body.baseURL === 'string' ? body.baseURL.trim().replace(/\/+$/, '') : ''
        if (baseURL.length === 0) return json(res, 400, { error: 'baseURL is required' })
        if (!/^https?:\/\//.test(baseURL)) return json(res, 400, { error: 'baseURL must start with http(s)://' })

        const next = routes.config()
        next.baseURL = baseURL

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
          const models = Array.isArray(raw?.models)
            ? (raw.models as unknown[]).map((m) => ({ id: String(m) }))
            : typeof raw?.models === 'string'
              ? raw.models.split(/[\n,]/).map((s: string) => s.trim()).filter((s: string) => s.length > 0).map((id: string) => ({ id }))
              : profile.models ?? []
          profile.models = models
        }

        routes.setConfig(next)
        json(res, 200, { ok: true, ...readProviderConfig(next), routes: routes.listRegisteredRoutes() })
      } catch (error) {
        json(res, 500, { error: safeMessage(error) })
      }
    })

    // POST discover: GET {baseURL}/models with a one-shot key.
    register(ROUTES.discover, async (req, res) => {
      if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
      if (!trustedRequest(req)) return json(res, 403, { error: 'forbidden' })
      try {
        const body = await readJson(req)
        const baseURL = typeof body.baseURL === 'string' ? body.baseURL.trim().replace(/\/+$/, '') : ''
        const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : ''
        if (baseURL.length === 0 || apiKey.length === 0) {
          return json(res, 400, { error: 'baseURL and apiKey are required' })
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

    // POST usage: GET {baseURL}/usage with a one-shot key.
    register(ROUTES.usage, async (req, res) => {
      if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
      if (!trustedRequest(req)) return json(res, 403, { error: 'forbidden' })
      try {
        const body = await readJson(req)
        const baseURL = typeof body.baseURL === 'string' ? body.baseURL.trim().replace(/\/+$/, '') : ''
        const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : ''
        if (baseURL.length === 0 || apiKey.length === 0) {
          return json(res, 400, { error: 'baseURL and apiKey are required' })
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
