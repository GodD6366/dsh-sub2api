/**
 * dsh-sub2api → dsh-llm-pi-ai profile bridge.
 *
 * The LLM routes this plugin used to own (`sub2api-openai` / `sub2api-claude`
 * / `sub2api-grok` / `sub2api-gemini`) are now served by the harness's pi-ai
 * adapter (`dsh-llm-pi-ai`, mounted dormant by dsh-base): protocol
 * serialization, streaming, usage mapping, replay, and retry handling all live
 * in pi-ai. This module is the translation layer — it turns this plugin's
 * `llm-sub2api:` settings section (gateway baseURL + per-group model catalogs
 * + keys) into `llm-pi-ai:` provider profiles and writes them through the
 * settings service, so routes register the moment the section lands and drop
 * again when a key is cleared.
 *
 * Every sub2api group is translated as a *hand-declared* route — pi-ai ships
 * no provider under these keys — with `api` naming the group's native wire
 * protocol (openai→responses, claude→messages, grok/gemini→chat-completions),
 * `baseURL` set to the shared gateway, and `models` carrying the configured
 * catalog with each model's capacity, modalities, and reasoning levels mapped
 * onto pi-ai's vocabulary (`none` becomes `off` with wire spelling `none`).
 *
 * @module dsh-sub2api/pi-ai
 */

import type { Context } from '@deepseek-ai/cordis'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import type { ApiProtocol, CatalogModel, Config, ProviderKey, ProviderProfile } from './index.ts'
import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  PROVIDERS,
  apiProtocolForKey,
  gatewayAnthropicRoot,
  gatewayApiRoot,
} from './index.ts'

/** The settings namespace owned by dsh-llm-pi-ai. */
export const PI_AI_NS: SettingsNamespace = settingsNamespace('llm-pi-ai')

/** Route prefix this plugin's groups own in the llm-pi-ai profile dict. */
export const ROUTE_PREFIX: string = 'sub2api-'

/** pi-ai thinking levels a profile may declare (catalog `THINKING_LEVELS`). */
const THINKING_LEVELS: readonly string[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/** One model entry in an llm-pi-ai profile (pi-ai `PiAiModelProfile`). */
export interface PiAiModelProfile {
  id: string
  name?: string
  contextWindow?: number
  maxTokens?: number
  input?: Array<'text' | 'image'>
  reasoningEfforts?: false | Partial<Record<string, string | null>>
}

/** One provider route in an llm-pi-ai profile (pi-ai `PiAiProviderProfile`). */
export interface PiAiProviderProfile {
  apiKeyEnv?: string
  displayName?: string
  api?: ApiProtocol
  baseURL?: string
  models?: PiAiModelProfile[]
  defaultContextWindow?: number
  defaultMaxTokens?: number
  defaultInput?: Array<'text' | 'image'>
  retryPolicy?: {
    mode: 'normal' | 'always'
    maxRetries?: number
    retryableCodes?: string[]
    backoff?: {
      initialDelayMs?: number
      maxDelayMs?: number
      jitterRatio?: number
    }
  }
}

/** The llm-pi-ai settings section value this plugin writes. */
export interface PiAiSettingsSection {
  providers?: Record<string, PiAiProviderProfile>
}

/**
 * Request modalities a catalog model declares to the harness. An explicit
 * `input` wins; absent/empty falls back to a family guess — frontier
 * multimodal families accept images, everything else stays text-only (the
 * official harness posture: a hand-entered model is text-only until it says
 * otherwise).
 */
function catalogInputModalities(model: { id: string; input?: Array<'text' | 'image'> }): Array<'text' | 'image'> {
  if (model.input !== undefined && model.input.length > 0) return [...model.input]
  return /^(gpt|o[1-9]|claude|gemini|grok|glm|qwen|kimi|moonshot|minimax|mistral|llama|phi|command|jamba|codex|sora|veo|imagen|dall-e)/i.test(model.id)
    ? ['text', 'image']
    : ['text']
}

/**
 * Map this plugin's reasoning-effort ids (OpenAI vocabulary — `none`,
 * `xhigh`, `max`, …) onto pi-ai's level keys. `none` is not a pi-ai level; it
 * becomes `off` with wire spelling `none`, which pi-ai dispatches as
 * `reasoning_effort: "none"` (chat/completions) or `reasoning:{effort:"none"}`
 * (responses) — exactly what this plugin used to send. An empty list declares
 * a non-reasoning model; unmappable ids are dropped.
 */
function translateReasoningEfforts(model: CatalogModel): false | Partial<Record<string, string | null>> | undefined {
  const ids = model.reasoningEfforts
  if (ids === undefined) {
    // The plugin's old default: every non-image model exposes low/medium/high.
    if (/image/i.test(model.id)) return false
    return { low: 'low', medium: 'medium', high: 'high' }
  }
  if (ids.length === 0) return false
  const efforts: Record<string, string | null> = {}
  for (const id of ids) {
    if (id === 'none') efforts.off = 'none'
    else if (THINKING_LEVELS.includes(id)) efforts[id] = id
  }
  return Object.keys(efforts).length > 0 ? efforts : undefined
}

/** One configured catalog model, translated onto pi-ai's per-model fields. */
function translateModel(model: CatalogModel): PiAiModelProfile {
  const reasoningEfforts = translateReasoningEfforts(model)
  return {
    id: model.id,
    ...(model.name !== undefined && model.name.length > 0 ? { name: model.name } : {}),
    ...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
    ...(model.maxTokens !== undefined ? { maxTokens: model.maxTokens } : {}),
    input: catalogInputModalities(model),
    ...(reasoningEfforts !== undefined ? { reasoningEfforts } : {}),
  }
}

/**
 * Translate one sub2api group into a hand-declared llm-pi-ai provider profile.
 * `apiKeyEnv` passes through verbatim (the harness resolves it per request
 * through `ctx.credentials`); routes without a key are skipped by the caller.
 *
 * The settings store the bare gateway host; the protocols join it differently.
 * OpenAI-compatible SDKs append their endpoint to the `/v1` API root, while
 * `@anthropic-ai/sdk` treats the given URL as the bare host and appends
 * `/v1/messages` itself — so OpenAI-style routes get the `/v1`-rooted URL and
 * the anthropic route gets the bare host.
 */
function translateProfile(key: ProviderKey, profile: ProviderProfile, baseURL: string, label: string): PiAiProviderProfile {
  const api = apiProtocolForKey(key, profile)
  return {
    ...(profile.apiKeyEnv !== undefined ? { apiKeyEnv: profile.apiKeyEnv } : {}),
    displayName: `Sub2API ${label}`,
    api,
    baseURL: api === 'anthropic-messages' ? gatewayAnthropicRoot(baseURL) : gatewayApiRoot(baseURL),
    models: (profile.models ?? []).map(translateModel),
    // Route-level fallbacks mirror the plugin's old adapter defaults, so a
    // catalog entry that omits a size keeps sizing like before.
    defaultContextWindow: DEFAULT_CONTEXT_WINDOW,
    defaultMaxTokens: DEFAULT_MAX_TOKENS,
    defaultInput: ['text'],
    // Sub2api acts as a proxy to upstream providers that may enforce their own
    // rate limits (HTTP 429). The default normal policy (2 retries, max 10s)
    // is too short for upstream throttling windows; raise to 5 retries / 120s
    // so transient rate limits resolve before the agent gives up.
    retryPolicy: {
      mode: 'normal',
      maxRetries: 5,
      retryableCodes: ['RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'EMPTY_RESPONSE'],
      backoff: { initialDelayMs: 1000, maxDelayMs: 120000, jitterRatio: 0.2 },
    },
  }
}

/**
 * Build the `llm-pi-ai` provider profile dict for every configured sub2api
 * group. A group is emitted only when it has both a key and at least one
 * model — a hand-declared pi-ai route needs a non-empty `models` list, and a
 * keyless group would otherwise surface as an unauthenticated route.
 */
export function translateToPiAi(config: Config): Record<string, PiAiProviderProfile> {
  const baseURL = (config.baseURL ?? '').trim().replace(/\/+$/, '')
  if (baseURL.length === 0) return {}
  const profiles: Record<string, PiAiProviderProfile> = {}
  for (const def of PROVIDERS) {
    const profile = config.providers[def.key]
    if (profile.apiKeyEnv === undefined) continue
    const models = (profile.models ?? []).filter((model) => model.id.length > 0)
    if (models.length === 0) continue
    profiles[def.route] = translateProfile(def.key, { ...profile, models }, baseURL, def.label)
  }
  return profiles
}

/**
 * Write the translated profiles into the `llm-pi-ai` settings section. Routes
 * under this plugin's `sub2api-` prefix are replaced wholesale; any other
 * route the user configured (e.g. through the built-in Models page) is
 * preserved. The write goes through the settings service, so dsh-llm-pi-ai's
 * own validation (schema + `assertServiceable`) refuses an unserviceable
 * profile at the write site and the section keeps its last good value.
 */
export async function syncPiAiProfiles(ctx: Context, config: Config): Promise<void> {
  const settings = ctx.get('settings')
  if (settings === undefined) return
  const current = settings.get(PI_AI_NS) as PiAiSettingsSection | undefined
  const providers: Record<string, PiAiProviderProfile> = { ...(current?.providers ?? {}) }
  for (const route of Object.keys(providers)) {
    if (route.startsWith(ROUTE_PREFIX)) delete providers[route]
  }
  Object.assign(providers, translateToPiAi(config))
  const next: PiAiSettingsSection = { providers }
  const before = JSON.stringify(current?.providers ?? {})
  if (JSON.stringify(providers) === before) return
  await settings.replace(PI_AI_NS, next)
}
