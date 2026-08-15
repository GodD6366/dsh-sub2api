/**
 * Sub2API gateway integration for the harness LLM seam.
 *
 * One OpenAI-compatible base URL, many provider routes. In the sub2api
 * gateway each API key is bound to a group, and the group decides the
 * platform (openai / anthropic / gemini / grok) and the model list the key
 * can serve.
 *
 * The LLM routes this plugin used to own (`sub2api-openai` / `sub2api-claude`
 * / `sub2api-grok` / `sub2api-gemini`) are served by the harness's own pi-ai
 * adapter (`dsh-llm-pi-ai`, mounted dormant by dsh-base): protocol
 * serialization, streaming, usage mapping, replay, and retry handling all live
 * in pi-ai, which speaks each platform's native wire protocol upstream (OpenAI
 * → Responses API, Claude → Messages API, the rest → chat/completions).
 * This plugin contributes the sub2api-specific surface on top: the
 * `llm-sub2api:` settings section and its web page (baseURL + per-key model
 * catalogs + keys), gateway model discovery and usage probes, the global
 * vision / image-generation tools, the Auto-Vision twin routes, and a bridge
 * that materializes the configured groups as `llm-pi-ai:` provider profiles
 * the moment the section lands (see `./pi-ai.ts`).
 *
 * Keys are stored through the harness credential seam; the base URL and
 * per-key model catalogs live in the `llm-sub2api:` settings section
 * (`$DSH_HOME/settings.yaml`, written by the web Models page).
 *
 * @module dsh-sub2api
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-llm'
import {
  LlmAdapter,
  LlmError,
  assertUsableApiKey,
} from '@deepseek-ai/dsh-llm'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { registerRoutes } from './routes.ts'
import { registerImageTools } from './image-tools.ts'
import { Sub2ApiVisionAdapter, visionRouteOf, VISION_ROUTE_SUFFIX } from './vision-wrapper.ts'
import { syncPiAiProfiles } from './pi-ai.ts'
import { applyPiAiMultiTurnPatch } from './pi-ai-patch.ts'

export {
  Sub2ApiVisionAdapter,
  VisionMemory,
  VISION_ROUTE_SUFFIX,
  VISION_MODEL_SUFFIX,
  visionRouteOf,
  baseRouteOf,
  stripVisionModel,
  neutralizeReplayState,
} from './vision-wrapper.ts'
export { describeViaVisionModel } from './image-tools.ts'
export {
  PI_AI_NS,
  ROUTE_PREFIX,
  syncPiAiProfiles,
  translateToPiAi,
  type PiAiModelProfile,
  type PiAiProviderProfile,
  type PiAiSettingsSection,
} from './pi-ai.ts'
export { applyPiAiMultiTurnPatch, type PiAiPatchResult } from './pi-ai-patch.ts'

export const name = 'llm-sub2api'
export const inject: string[] = ['llm', 'settings', 'credentials']

const NS = settingsNamespace('llm-sub2api')

/** Context capacity assumed for a model neither configuration nor discovery sizes. */
export const DEFAULT_CONTEXT_WINDOW = 128000
/** Output capability assumed for a model neither configuration nor discovery sizes. */
export const DEFAULT_MAX_TOKENS = 8192

/**
 * Reasoning effort levels exposed for reasoning-capable models. The gateway
 * speaks the OpenAI chat-completions protocol, so the ids are the OpenAI
 * `reasoning_effort` vocabulary and are sent through verbatim. Per-model
 * configuration (filled from models.dev `reasoning_options`) may expose
 * additional vocabulary such as `none`, `xhigh`, or `max`.
 */
export const REASONING_EFFORTS: readonly { id: string; name: string }[] = [
  { id: 'low', name: 'Low' },
  { id: 'medium', name: 'Medium' },
  { id: 'high', name: 'High' },
]

export type ProviderKey = 'openai' | 'claude' | 'grok' | 'gemini'

export interface ProviderDef {
  key: ProviderKey
  route: string
  label: string
  icon: string
}

/** The provider routes this plugin owns, keyed by sub2api platform name. */
export const PROVIDERS: readonly ProviderDef[] = [
  { key: 'openai', route: 'sub2api-openai', label: 'OpenAI', icon: 'openai' },
  { key: 'claude', route: 'sub2api-claude', label: 'Claude', icon: 'claude' },
  { key: 'grok', route: 'sub2api-grok', label: 'Grok', icon: 'grok' },
  { key: 'gemini', route: 'sub2api-gemini', label: 'Gemini', icon: 'gemini' },
]

export interface CatalogModel {
  /** Model id sent to the provider and accepted by {@link GenerateOptions.model}. */
  id: string
  /** Display name for selectors; defaults to the id. */
  name?: string
  /** Maximum combined request and response context in tokens. */
  contextWindow?: number
  /** Maximum output tokens. */
  maxTokens?: number
  /**
   * Accepted request modalities. Absent or empty: the adapter guesses from
   * the model id (multimodal families such as gpt/claude/gemini/grok/glm
   * declare `[text, image]`, everything else stays `[text]`). Non-empty:
   * exactly those modalities, e.g. `[text]` to pin a multimodal-looking
   * model to text only.
   */
  input?: Array<'text' | 'image'>
  /**
   * Reasoning effort levels selectable for this model. Absent: every non-image
   * model on any route exposes low/medium/high (the gateway is OpenAI-compatible
   * on all routes). Empty array: reasoning effort is explicitly off for this
   * model. Non-empty: exposes exactly those levels verbatim (e.g. models.dev
   * vocabularies such as `xhigh`/`max`/`none`).
   */
  reasoningEfforts?: string[]
}

export interface ProviderProfile {
  /** Credential reference (environment-variable name) resolved per request through `ctx.credentials`. */
  apiKeyEnv?: string
  /**
   * Wire protocol spoken to the gateway for this platform group. Absent
   * selects the group's native protocol (openai → responses, claude →
   * messages, grok/gemini → chat/completions). Explicitly name a protocol to
   * force a different endpoint, e.g. a gateway that serves a group through
   * chat/completions after all.
   */
  api?: ApiProtocol
  /** Advisory model catalog for this route. */
  models?: CatalogModel[]
}

/** One dedicated model used by a global image tool, independent of the chat route. */
export interface ImageToolModelRef {
  /** Sub2API platform that owns the key and catalog (`openai` / `claude` / `grok` / `gemini`). */
  provider: string
  /** Model id sent to the gateway. */
  model: string
}

export interface ImageToolsConfig {
  /** Vision model used by the global `analyze_image` tool. */
  analyze?: ImageToolModelRef
  /** Image-generation model used by the global `generate_image` tool. */
  generate?: ImageToolModelRef
}

export interface Config {
  /** OpenAI-compatible gateway base URL, e.g. http://localhost:8080/v1. */
  baseURL: string
  /** Per-platform provider profiles keyed by sub2api platform name. */
  providers: Record<ProviderKey, ProviderProfile>
  /** Dedicated models for the global vision / image-generation tools. */
  tools?: ImageToolsConfig
  /**
   * Auto Vision twin routes: an image-capable copy of every registered
   * provider route (`<route>-vision`, shown as "… + 自动识图"). Picking one
   * lets a text-only model accept pasted images — the twin's wrapper rewrites
   * image blocks into vision-model transcriptions before the text turn is
   * delegated. Defaults to on; set false to hide the twins.
   */
  autoVision?: boolean
}

const catalogModel = z.object({
  id: z.string().required(),
  name: z.string(),
  contextWindow: z.number().step(1).min(1),
  maxTokens: z.number().step(1).min(1),
  // Default to an empty list so the settings normalization never fills a
  // fabricated value: an empty/absent `input` means "auto" (the adapter
  // guesses modalities from the model id).
  input: z.array(z.union([z.const('text'), z.const('image')])).default([]),
  // The settings layer normalizes every section through this schema, and an
  // absent optional array would otherwise be filled with an empty array —
  // silently turning reasoning off for every unconfigured model. Default the
  // field to the full OpenAI effort vocabulary so a model without explicit
  // configuration exposes low/medium/high (image models are excluded at
  // resolve time); an explicit empty array still opts the model out.
  reasoningEfforts: z.array(z.string()).default(REASONING_EFFORTS.map((effort) => effort.id)),
})

const apiProtocol = z.union([
  z.const('openai-completions'),
  z.const('openai-responses'),
  z.const('anthropic-messages'),
])

const providerProfile = z.object({
  apiKeyEnv: z.string().role('credential-ref'),
  api: apiProtocol,
  models: z.array(catalogModel),
})

// Keep these fields optional strings. The settings layer fills absent
// objects, and a required union here would reject a still-empty tools
// section (or silently coerce it) before the user picks a model.
const imageToolModelRef = z.object({
  provider: z.string(),
  model: z.string(),
})

export const Config: z<Config> = z.object({
  baseURL: z.string(),
  providers: z.object({
    openai: providerProfile,
    claude: providerProfile,
    grok: providerProfile,
    gemini: providerProfile,
  }),
  tools: z.object({
    analyze: imageToolModelRef,
    generate: imageToolModelRef,
  }),
  autoVision: z.boolean().default(true),
})

/**
 * Wire protocol the adapter speaks to the gateway for one route. Each value
 * names a real endpoint: `openai-completions` → `/chat/completions`,
 * `openai-responses` → `/responses`, `anthropic-messages` → `/messages`.
 */
export type ApiProtocol = 'openai-completions' | 'openai-responses' | 'anthropic-messages'

export const API_PROTOCOLS: readonly ApiProtocol[] = ['openai-completions', 'openai-responses', 'anthropic-messages']

/**
 * The wire protocol each sub2api platform group speaks natively at the
 * gateway. Openai groups are served upstream through the Responses API and
 * Claude groups through the Messages API; grok/gemini groups are
 * chat-completions. Speaking the native protocol avoids the gateway's
 * chat/completions ↔ native conversion, which drops/misaligns tool-call
 * names and ids for parallel calls. A provider profile may override.
 */
const DEFAULT_PROTOCOL: Record<ProviderKey, ApiProtocol> = {
  openai: 'openai-responses',
  claude: 'anthropic-messages',
  grok: 'openai-completions',
  gemini: 'openai-completions',
}

/** Resolve the wire protocol for one provider key; shared by chat routes and the global image tools. */
export function apiProtocolForKey(key: ProviderKey, profile: ProviderProfile): ApiProtocol {
  return profile.api ?? DEFAULT_PROTOCOL[key]
}

/**
 * The OpenAI-style API root for a gateway base URL. The Sub2API settings page
 * stores the bare host (e.g. `https://gateway.example:6443`); OpenAI-compatible
 * endpoints (`/responses`, `/chat/completions`, `/models`, `/usage`) live under
 * the `/v1` root, so it is appended here when missing. A URL already carrying
 * `/v1` passes through unchanged.
 */
export function gatewayApiRoot(baseURL: string): string {
  const cleaned = (baseURL ?? '').trim().replace(/\/+$/, '')
  if (cleaned.length === 0) return ''
  return /\/v1$/i.test(cleaned) ? cleaned : `${cleaned}/v1`
}

/**
 * The bare-host form the Anthropic SDK expects: `@anthropic-ai/sdk` treats the
 * configured URL as the host and always appends `/v1/messages` itself, so a
 * `/v1`-rooted URL would hit `/v1/v1/messages` (404). Strips a trailing `/v1`
 * when present.
 */
export function gatewayAnthropicRoot(baseURL: string): string {
  return gatewayApiRoot(baseURL).replace(/\/v1$/i, '')
}

function providerDef(route: string) {
  return PROVIDERS.find((p) => p.route === route)
}

function resolveAdapterOptions(config: Config) {
  const baseURL = (config.baseURL ?? '').trim().replace(/\/+$/, '')
  // An empty baseURL means "not configured yet": boot dormant and let the
  // settings scope (or setConfig) supply the URL later. Only validate the
  // scheme once a URL is actually present.
  if (baseURL.length > 0 && !/^https?:\/\//.test(baseURL)) {
    throw new Error('llm-sub2api: baseURL must start with http(s)://')
  }
  return { baseURL }
}

const EMPTY_PROVIDER: ProviderProfile = {}

/** Provider map used until settings (or setConfig) provide real values. */
function defaultProviders(): Record<ProviderKey, ProviderProfile> {
  return { openai: EMPTY_PROVIDER, claude: EMPTY_PROVIDER, grok: EMPTY_PROVIDER, gemini: EMPTY_PROVIDER }
}

export function apply(ctx: Context, config: Config): void {
  // The loader may start this plugin before any `llm-sub2api:` settings exist,
  // so normalize an empty/undefined config into a dormant boot: no baseURL and
  // no provider profiles yet. The settings scope replaces `current` wholesale
  // once the harness settings service is available.
  let current = (): Config => {
    const raw = config ?? {}
    return {
      baseURL: raw.baseURL ?? '',
      providers: { ...defaultProviders(), ...(raw.providers ?? {}) },
      ...(raw.tools !== undefined ? { tools: raw.tools } : {}),
      autoVision: raw.autoVision !== false,
    }
  }
  const options = () => {
    const raw = current()
    return { ...raw, ...resolveAdapterOptions(raw) }
  }
  options()

  // Best-effort guard for the bundled pi-ai multi-turn defect. pi-ai modules
  // are lazy-loaded, so this runs well before any request imports estimate.js.
  const patchResult = applyPiAiMultiTurnPatch()
  if (patchResult.kind === 'patched') {
    ctx.logger.info(`llm-sub2api: applied pi-ai multi-turn guard to ${patchResult.file}`)
  } else if (patchResult.kind === 'skipped') {
    ctx.logger.warn(`llm-sub2api: pi-ai multi-turn guard not applied — ${patchResult.reason}`)
  }

  const resolveApiKey = async (route: string, profile: ProviderProfile) => {
    if (profile.apiKeyEnv === undefined) {
      throw new LlmError(`sub2api: no API key configured for route "${route}"`, 'MISSING_CREDENTIAL')
    }
    const ref = credentialRef(profile.apiKeyEnv)
    const credentials = ctx.get('credentials')
    const hit = credentials !== undefined ? await credentials.resolve(ref) : undefined
    if (hit !== undefined && hit.value.length > 0) {
      return assertUsableApiKey(hit.value, 'llm-sub2api', ref)
    }
    throw new LlmError(
      `sub2api: no credential for provider route "${route}"; its profile resolves ${profile.apiKeyEnv}, which is not set — store it through the credentials service (the web Models page writes it) or export it`,
      'MISSING_CREDENTIAL',
    )
  }

  // ── pi-ai profile bridge ────────────────────────────────────────────────
  // The chat routes are owned by dsh-llm-pi-ai: every `llm-sub2api:` change
  // (and boot, via installSettingsSection's first onChange) materializes the
  // configured groups as `llm-pi-ai:` provider profiles. A refused write
  // (unserviceable profile) keeps the previous routes and is logged here.
  const syncPiAi = () => {
    syncPiAiProfiles(ctx, current()).catch((error) => {
      ctx.logger.error('llm-sub2api: refused to update llm-pi-ai profiles; keeping the previously registered routes')
      ctx.logger.error(error)
    })
  }

  // ── Auto Vision twin routes ──────────────────────────────────────────────
  // Every registered text-only provider route gets an image-capable twin
  // ("<route>-vision", shown as "… + 自动识图"), covering our own sub2api
  // routes (now owned by llm-pi-ai) AND external providers (deepseek 官方、
  // llm-pi-ai、其他插件添加的提供商). The twin's catalog declares
  // `inputModalities: ['text', 'image']` so the harness admission accepts
  // pasted images; its stream rewrites image blocks into vision-model
  // transcriptions (via the configured `tools.analyze` model) and delegates
  // the text-only turn to the base route's own adapter. Text-only models gain
  // image capability without changing the model; multimodal models keep their
  // native image input.
  //
  // Base adapters are resolved through the llm runtime's registration (the
  // same access vision-router uses), so the twin follows whichever adapter
  // owns the route — for sub2api groups that is the pi-ai adapter.
  const registrationAccessor = ctx.llm as unknown as {
    registration(route: string): { adapter: LlmAdapter } | undefined
  }
  const visionAdapter = new Sub2ApiVisionAdapter({
    config: () => current(),
    resolveApiKey,
    resolveAttachments: () => ctx.get('attachments'),
    nameOf: (route) => {
      const def = providerDef(route)
      if (def !== undefined) return `Sub2API ${def.label}`
      const info = ctx.llm.listProviders().find((entry) => entry.id === route)
      return info?.name ?? route
    },
    resolveBase: (route) => {
      try {
        const registration = registrationAccessor.registration(route)
        if (registration === undefined) return undefined
        const base = registration.adapter
        return {
          listModels: () => base.listModels(route),
          resolveModel: (_provider, model, signal) => base.resolveModel(route, model, signal),
          providerRetryPolicy: () => ctx.llm.providerRetryPolicy(route),
          stream: (generateOptions) => base.stream(generateOptions),
        }
      } catch {
        return undefined
      }
    },
  })

  let visionRegistration: { replace(providers: string[]): void } | undefined
  let visionRoutes: string[] = []
  const routeOwnedByOther = (route: string): boolean => {
    if (visionRoutes.includes(route)) return false
    try {
      registrationAccessor.registration(route)
      return true
    } catch {
      return false
    }
  }
  const commitVisionRoutes = (routes: string[]) => {
    // 冲突过滤：镜像名已被其他插件占用（如 vision-router 的
    // deepseek-official-vision）时跳过，避免 DUPLICATE_ADAPTER。
    const usable = routes.filter((route) => !routeOwnedByOther(route))
    const same = usable.length === visionRoutes.length && usable.every((r, i) => r === visionRoutes[i])
    if (same) return
    try {
      if (visionRegistration === undefined) {
        if (usable.length > 0) visionRegistration = ctx.llm.registerAdapter(usable, visionAdapter)
      } else {
        visionRegistration.replace(usable)
      }
      visionRoutes = usable
    } catch (error) {
      ctx.logger.warn('llm-sub2api: Auto Vision twin registration refused, retrying on the next provider change')
      ctx.logger.warn(error)
    }
  }

  // 外部路由发现：枚举所有已注册路由（含 llm-pi-ai 拥有的 sub2api 路由），
  // 只包装「存在纯文本模型」的路由，排除任何已包装的 -vision 路由。
  const textRouteCache = new Map<string, boolean>()
  const discoverTextRoutes = async (): Promise<string[]> => {
    const out: string[] = []
    for (const info of ctx.llm.listProviders()) {
      const route = info.id
      if (route.endsWith(VISION_ROUTE_SUFFIX)) continue
      let hasText = textRouteCache.get(route)
      if (hasText === undefined) {
        try {
          const models = await ctx.llm.listModels(route)
          hasText = models.some((model) => !(model.inputModalities ?? []).includes('image'))
        } catch {
          hasText = false
        }
        textRouteCache.set(route, hasText)
      }
      if (hasText) out.push(route)
    }
    return out
  }

  let recomputeSeq = 0
  const recomputeVisionRoutes = async () => {
    const seq = ++recomputeSeq
    if (current().autoVision === false) {
      commitVisionRoutes([])
      return
    }
    let routes: string[] = []
    try {
      textRouteCache.clear()
      routes = (await discoverTextRoutes()).map((route) => visionRouteOf(route))
    } catch {
      routes = []
    }
    if (seq !== recomputeSeq) return
    commitVisionRoutes(routes)
  }

  // 初始发现 + 跟随提供商拓扑变化（其他插件注册/注销路由时自动增删镜像）。
  void recomputeVisionRoutes()
  ctx.on('llm/adapters-updated', () => { void recomputeVisionRoutes() })

  // Settings-page HTTP bridge: read/write config, discover models, query usage.
  // `listRegisteredRoutes` reports the routes the pi-ai adapter actually
  // registered for this plugin's groups.
  registerRoutes(ctx, {
    config: () => current(),
    setConfig: async (next) => {
      // The settings snapshot is handed out frozen (immutable), so never mutate
      // it. Persist through the settings service; its commit swaps the resolved
      // value and re-notifies (which re-syncs the llm-pi-ai profiles), and we
      // re-run the sync below so the response reports the routes that just
      // activated. Without a settings service, fall back to an in-memory source.
      const settings = ctx.get('settings')
      if (settings !== undefined) {
        await settings.replace(NS, next)
      } else {
        current = () => ({
          baseURL: next.baseURL ?? '',
          providers: { ...defaultProviders(), ...next.providers },
          ...(next.tools !== undefined ? { tools: next.tools } : {}),
          autoVision: next.autoVision !== false,
        })
      }
      syncPiAi()
      void recomputeVisionRoutes()
    },
    listRegisteredRoutes: () => ctx.llm.listProviders()
      .map((info) => info.id)
      .filter((route) => route.startsWith('sub2api-')),
    resolveApiKey,
  })

  registerImageTools(ctx, {
    config: () => current(),
    resolveApiKey,
  })

  installSettingsSection(ctx, NS, Config, config, {
    setSource: (source) => {
      current = source
    },
    onChange: () => {
      try {
        syncPiAi()
        void recomputeVisionRoutes()
      } catch (error) {
        ctx.logger.error('llm-sub2api: keeping the previous llm-pi-ai profiles after a refused update')
        ctx.logger.error(error)
      }
    },
  })
}

// NOTE: no default export. The harness loader (cordis-plugin-loader
// unwrapExports) treats a module's default export as the plugin entry;
// `Config` here is the settings schema, so exporting it as default makes the
// loader boot the schema as the plugin and fails with
// "cannot get property \"baseURL\" without inject".
