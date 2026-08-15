/**
 * Sub2API gateway adapter for the harness LLM seam.
 *
 * One OpenAI-compatible base URL, many provider routes. In the sub2api
 * gateway each API key is bound to a group, and the group decides the
 * platform (openai / anthropic / gemini / grok) and the model list the key
 * can serve — so this plugin registers one route per configured key, all
 * sharing a single baseURL, and the gateway auto-routes and protocol-converts
 * every request. Keys are stored through the harness credential seam; the
 * base URL and per-key model catalogs live in the `llm-sub2api:` settings
 * section (`$DSH_HOME/settings.yaml`, written by the web Models page).
 *
 * @module dsh-sub2api
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-llm'
import {
  CONTEXT_WINDOW_EXCEEDED_CODE,
  CallId,
  EMPTY_RESPONSE_CODE,
  LlmAdapter,
  LlmError,
  ProviderRequestId,
  QUOTA_EXCEEDED_CODE,
  assertUsableApiKey,
  attributionHeaders,
  contentHasImage,
  isContextWindowExceededError,
  isQuotaExceededError,
} from '@deepseek-ai/dsh-llm'
import type {
  ContentBlock,
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  Message,
  ResolvedRetryPolicy,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { registerRoutes } from './routes.ts'

export const name = 'llm-sub2api'
export const inject: string[] = ['llm', 'settings', 'credentials']

const NS = settingsNamespace('llm-sub2api')

/** Context capacity assumed for a model neither configuration nor discovery sizes. */
export const DEFAULT_CONTEXT_WINDOW = 128000
/** Output capability assumed for a model neither configuration nor discovery sizes. */
export const DEFAULT_MAX_TOKENS = 8192
/** Maximum provider idle time while one stream read is outstanding. */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000

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
}

export interface ProviderProfile {
  /** Credential reference (environment-variable name) resolved per request through `ctx.credentials`. */
  apiKeyEnv?: string
  /** Advisory model catalog for this route. */
  models?: CatalogModel[]
}

export interface Config {
  /** OpenAI-compatible gateway base URL, e.g. http://localhost:8080/v1. */
  baseURL: string
  /** Per-platform provider profiles keyed by sub2api platform name. */
  providers: Record<ProviderKey, ProviderProfile>
}

const catalogModel = z.object({
  id: z.string().required(),
  name: z.string(),
  contextWindow: z.number().step(1).min(1),
  maxTokens: z.number().step(1).min(1),
})

const providerProfile = z.object({
  apiKeyEnv: z.string().role('credential-ref'),
  models: z.array(catalogModel),
})

export const Config: z<Config> = z.object({
  baseURL: z.string(),
  providers: z.object({
    openai: providerProfile,
    claude: providerProfile,
    grok: providerProfile,
    gemini: providerProfile,
  }),
})

const DEFAULT_MODELS: CatalogModel[] = []

function providerDef(route: string) {
  return PROVIDERS.find((p) => p.route === route)
}

/** Map an HTTP status to a stable LlmError code. */
function httpErrorCode(status: number, detail: string): string {
  if (status === 401 || status === 403) return 'AUTH'
  if (isQuotaExceededError(detail)) return QUOTA_EXCEEDED_CODE
  if (status === 429) return 'RATE_LIMIT'
  if (status === 400) {
    if (isContextWindowExceededError(detail)) return CONTEXT_WINDOW_EXCEEDED_CODE
    return 'INVALID_REQUEST'
  }
  if (status >= 500) return 'SERVER'
  return `HTTP_${status}`
}

function providerRetryAfterMs(value: string | null): number | undefined {
  if (value === null) return undefined
  if (/^\d+$/.test(value)) {
    const delay = Number(value) * 1000
    return Number.isFinite(delay) && delay > 0 ? delay : undefined
  }
  const delay = Date.parse(value) - Date.now()
  return Number.isFinite(delay) && delay > 0 ? delay : undefined
}

function requestId(headers: Headers): ProviderRequestId | undefined {
  const value = headers.get('x-request-id') ?? headers.get('x-sub2api-request-id')
  return value === null || value.length === 0 ? undefined : ProviderRequestId(value)
}

/** Join the text blocks of a message (used for user/tool-result content). */
function flattenText(blocks: readonly { type: string; text?: string }[]): string {
  return blocks.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('')
}

/** Reject core image content before any text-flattening path can silently erase it. */
function assertTextOnly(blocks: readonly { type: string }[]): void {
  if (contentHasImage(blocks as never)) {
    throw new LlmError('The sub2api chat-completions adapter does not support image content.', 'UNSUPPORTED_CONTENT')
  }
}

interface WireMessage {
  role: string
  content?: string
  tool_call_id?: string
  tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>
}

/** Serialize the conversation into OpenAI chat-completions wire messages. */
function serializeMessages(messages: readonly Message[]): WireMessage[] {
  const wire: WireMessage[] = []
  for (const message of messages) {
    assertTextOnly(message.content)
    if (message.role === 'system') {
      wire.push({ role: 'system', content: flattenText(message.content) })
      continue
    }
    if (message.role === 'assistant') {
      const text = flattenText(message.content)
      const toolCalls = message.content
        .filter((b) => b.type === 'tool-call')
        .map((b) => {
          const call = b as { id: string; name: string; arguments: string }
          return { id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } }
        })
      wire.push({ role: 'assistant', content: text, ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}) })
      continue
    }
    const toolResults = message.content.filter((b) => b.type === 'tool-result')
    const text = flattenText(message.content)
    if (text.length > 0 || toolResults.length === 0) wire.push({ role: 'user', content: text })
    for (const r of toolResults) {
      const result = r as { toolCallId: string; content: ContentBlock[] }
      wire.push({
        role: 'tool',
        tool_call_id: result.toolCallId,
        content: flattenText(result.content) || '(no output)',
      })
    }
  }
  return wire
}

/**
 * Build the full wire request. Always streaming (`stream: true`, usage
 * reporting on); optional fields are omitted rather than sent as null.
 */
function serializeRequest(options: GenerateOptions): Record<string, unknown> {
  const messages: WireMessage[] = []
  if (options.system !== undefined) messages.push({ role: 'system', content: options.system })
  messages.push(...serializeMessages(options.messages))
  const tools = options.tools?.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }))
  return {
    model: options.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    ...(tools !== undefined && tools.length > 0 ? { tools } : {}),
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(options.maxTokens !== undefined ? { max_tokens: options.maxTokens } : {}),
    ...(options.stop !== undefined ? { stop: options.stop } : {}),
  }
}

/** Map the wire finish_reason vocabulary to the harness FinishReason. */
function mapFinishReason(reason: string) {
  switch (reason) {
    case 'stop': return { kind: 'stop' as const }
    case 'tool_calls': return { kind: 'tool-calls' as const }
    case 'length': return { kind: 'max-tokens' as const }
    default:
      return { kind: 'error' as const, failure: { message: `model stopped: ${reason}`, code: reason.toUpperCase() } }
  }
}

/** Map wire usage fields into disjoint harness counts. */
function mapUsage(usage: Record<string, unknown>) {
  const prompt = Number(usage.prompt_tokens ?? 0)
  const completion = Number(usage.completion_tokens ?? 0)
  const details = usage.prompt_tokens_details as Record<string, unknown> | undefined
  const compDetails = usage.completion_tokens_details as Record<string, unknown> | undefined
  const cacheRead = details?.cached_tokens !== undefined ? Number(details.cached_tokens) : undefined
  const reasoning = compDetails?.reasoning_tokens !== undefined ? Number(compDetails.reasoning_tokens) : undefined
  return {
    inputTokens: prompt - (cacheRead ?? 0),
    outputTokens: completion,
    ...(cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {}),
    ...(reasoning !== undefined ? { reasoningTokens: reasoning } : {}),
  }
}

interface AdapterOptions {
  /** Current validated config, resolved once per operation. */
  options: () => Config
  /** Resolve the credential for one already-resolved profile. */
  resolveApiKey: (route: string, profile: ProviderProfile) => Promise<string>
  /** Maximum provider idle time while one stream read is outstanding. */
  streamIdleTimeoutMs: number
}

/**
 * A transport-only adapter: fetch + SSE against an OpenAI-compatible
 * chat-completions endpoint, emitting harness StreamChunks.
 */
export class Sub2ApiAdapter extends LlmAdapter {
  private readonly config: AdapterOptions

  constructor(config: AdapterOptions) {
    super()
    this.config = config
  }

  override providerInfo(provider: string): LlmProviderInfo {
    const def = providerDef(provider)
    return { id: provider, name: def !== undefined ? `Sub2API ${def.label}` : provider }
  }

  override providerRetryPolicy(_provider: string): ResolvedRetryPolicy | undefined {
    return undefined
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const def = providerDef(provider)
    const profile = def !== undefined ? this.config.options().providers[def.key] : undefined
    const models = profile?.models ?? DEFAULT_MODELS
    return models.map((m) => ({
      provider,
      id: m.id,
      name: m.name ?? m.id,
      inputModalities: ['text' as const],
    }))
  }

  override async resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    const def = providerDef(provider)
    const profile = def !== undefined ? this.config.options().providers[def.key] : undefined
    const found = profile?.models?.find((m) => m.id === model)
    return {
      provider,
      id: model,
      name: found?.name ?? model,
      inputModalities: ['text' as const],
      context: { contextWindow: found?.contextWindow ?? DEFAULT_CONTEXT_WINDOW },
      defaultMaxTokens: found?.maxTokens ?? DEFAULT_MAX_TOKENS,
    }
  }

  override async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    const def = providerDef(options.provider)
    if (def === undefined) throw new LlmError(`sub2api: unknown provider "${options.provider}"`, 'NO_ADAPTER')
    const config = this.config.options()
    const profile = config.providers[def.key]
    if (config.baseURL.length === 0) throw new LlmError('sub2api: baseURL is not configured', 'MISSING_CREDENTIAL')
    if (profile.apiKeyEnv === undefined) {
      throw new LlmError(`sub2api: no API key configured for ${def.label}`, 'MISSING_CREDENTIAL')
    }
    const apiKey = await this.config.resolveApiKey(options.provider, profile)

    const baseURL = config.baseURL.replace(/\/+$/, '')
    const body = serializeRequest(options)
    const controller = new AbortController()
    const signal = options.signal !== undefined
      ? (() => {
          const onAbort = () => controller.abort()
          options.signal?.addEventListener('abort', onAbort)
          return { signal: controller.signal, cleanup: () => options.signal?.removeEventListener('abort', onAbort) }
        })()
      : { signal: controller.signal, cleanup: () => {} }

    let response: Response
    try {
      response = await fetch(`${baseURL}/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
          accept: 'text/event-stream',
          ...attributionHeaders(),
        },
        body: JSON.stringify(body),
        signal: signal.signal,
      })
    } catch (error) {
      signal.cleanup()
      if (signal.signal.aborted) throw new LlmError('sub2api: request aborted', 'ABORTED', { cause: error })
      throw new LlmError(`sub2api: API request to ${baseURL} failed`, 'TRANSPORT', { cause: error })
    }

    if (!response.ok) {
      signal.cleanup()
      let message = `sub2api: API error (HTTP ${response.status})`
      let providerError: Record<string, unknown> | undefined
      try {
        const parsed = (await response.json()) as { error?: Record<string, unknown> }
        providerError = parsed.error
        const text = providerError?.message
        if (typeof text === 'string' && text.length > 0) message = text
      } catch {
        // non-JSON error body; keep the status message
      }
      const detail = [providerError?.code, providerError?.type, providerError?.message].filter(Boolean).join(' ')
      const delay = providerRetryAfterMs(response.headers.get('retry-after'))
      const id = requestId(response.headers)
      throw new LlmError(message, httpErrorCode(response.status, detail), {
        status: response.status,
        ...(delay !== undefined ? { providerRetryAfterMs: delay } : {}),
        ...(id !== undefined ? { requestId: id } : {}),
      })
    }
    if (response.body === null) {
      signal.cleanup()
      throw new LlmError('sub2api: API returned no response body', EMPTY_RESPONSE_CODE)
    }

    try {
      yield* this.translate(response.body, options, signal.cleanup)
    } finally {
      signal.cleanup()
    }
  }

  private async *translate(body: ReadableStream<Uint8Array>, options: GenerateOptions, cleanup: () => void): AsyncGenerator<StreamChunk> {
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let nextIndex = 0
    let textBlock: { index: number; text: string } | null = null
    let reasoningBlock: { index: number; text: string } | null = null
    const toolBlocks = new Map<number, { index: number; callId?: string; name?: string; text: string }>()
    const order: Array<{ index: number; kind: 'text' | 'reasoning' | 'tool-call'; block: { index: number; text: string } }> = []
    let pendingFinish: ReturnType<typeof mapFinishReason> | undefined
    let pendingUsage: ReturnType<typeof mapUsage> | undefined
    let closed = false

    const open = (kind: 'text' | 'reasoning' | 'tool-call', block: { index: number; text: string }) => {
      order.push({ index: block.index, kind, block })
      return block
    }

    const emit = function* (data: string): Generator<StreamChunk> {
      if (data === '[DONE]') {
        closed = true
        return
      }
      let chunk: { choices?: Array<{ delta?: Record<string, unknown>; finish_reason?: string }>; usage?: Record<string, unknown> }
      try {
        chunk = JSON.parse(data) as typeof chunk
      } catch {
        throw new LlmError(`sub2api: malformed SSE payload: ${data.slice(0, 120)}`, 'MALFORMED_RESPONSE')
      }
      for (const choice of chunk.choices ?? []) {
        const delta = choice.delta ?? {}
        const reasoning = delta.reasoning_content ?? delta.reasoning
        if (typeof reasoning === 'string' && reasoning.length > 0) {
          if (reasoningBlock === null) {
            reasoningBlock = open('reasoning', { index: nextIndex++, text: '' })
            yield { type: 'block-start', index: reasoningBlock.index, blockType: 'reasoning' }
          }
          reasoningBlock.text += reasoning
          yield { type: 'reasoning-delta', index: reasoningBlock.index, text: reasoning }
        }
        const content = delta.content
        if (typeof content === 'string' && content.length > 0) {
          if (textBlock === null) {
            textBlock = open('text', { index: nextIndex++, text: '' })
            yield { type: 'block-start', index: textBlock.index, blockType: 'text' }
          }
          textBlock.text += content
          yield { type: 'text-delta', index: textBlock.index, text: content }
        }
        const calls = delta.tool_calls as Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> | undefined
        for (const call of calls ?? []) {
          const callIndex = call.index ?? 0
          let block = toolBlocks.get(callIndex)
          if (block === undefined) {
            block = { index: nextIndex++, text: '' }
            toolBlocks.set(callIndex, block)
            open('tool-call', block)
            yield { type: 'block-start', index: block.index, blockType: 'tool-call' }
          }
          if (call.id !== undefined) block.callId = call.id
          if (call.function?.name !== undefined) block.name = call.function.name
          const fragment = call.function?.arguments ?? ''
          block.text += fragment
          yield {
            type: 'tool-call-delta',
            index: block.index,
            id: CallId(block.callId ?? ''),
            ...(block.name !== undefined ? { name: block.name } : {}),
            argumentsDelta: fragment,
          }
        }
        if (typeof choice.finish_reason === 'string') pendingFinish = mapFinishReason(choice.finish_reason)
      }
      if (chunk.usage !== undefined) pendingUsage = mapUsage(chunk.usage)
    }

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        while (true) {
          const idx = buffer.indexOf('\n\n')
          if (idx === -1) break
          const raw = buffer.slice(0, idx)
          buffer = buffer.slice(idx + 2)
          const dataLines = raw.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart())
          if (dataLines.length === 0) continue
          const data = dataLines.join('\n')
          if (data === '[DONE]') {
            closed = true
            break
          }
          for (const line of dataLines) {
            yield* emit(line)
          }
          if (closed) break
        }
        if (closed) break
      }
      if (options.signal?.aborted) throw new LlmError('sub2api: request aborted', 'ABORTED')
      if (!closed) throw new LlmError('sub2api: SSE stream ended without [DONE]', 'STREAM_CLOSED')

      for (const entry of order) {
        let content: ContentBlock
        if (entry.kind === 'text') content = { type: 'text', text: entry.block.text }
        else if (entry.kind === 'reasoning') content = { type: 'reasoning', text: entry.block.text }
        else {
          const block = toolBlocks.get(entry.block.index)
          content = {
            type: 'tool-call',
            id: CallId(block?.callId ?? ''),
            name: block?.name ?? '',
            arguments: entry.block.text,
          }
        }
        yield { type: 'block-end', index: entry.index, block: content }
      }
      if (pendingUsage !== undefined) yield { type: 'usage', usage: pendingUsage }
      const reason = pendingFinish ?? { kind: 'stop' }
      yield {
        type: 'finish',
        reason: reason.kind === 'stop' && order.length === 0
          ? { kind: 'error', failure: { message: 'sub2api: model returned a completed response with no content', code: EMPTY_RESPONSE_CODE } }
          : reason,
      }
    } finally {
      cleanup()
      try {
        reader.releaseLock()
      } catch {
        // lock already released or reader detached
      }
    }
  }
}

function resolveProfiles(config: Config) {
  const profiles: Record<string, ProviderProfile> = {}
  for (const def of PROVIDERS) {
    profiles[def.route] = {
      ...config.providers[def.key],
      models: config.providers[def.key].models ?? [],
    }
  }
  return profiles
}

function resolveAdapterOptions(config: Config) {
  const baseURL = config.baseURL.trim().replace(/\/+$/, '')
  if (baseURL.length === 0) throw new Error('llm-sub2api: baseURL is required')
  if (!/^https?:\/\//.test(baseURL)) throw new Error('llm-sub2api: baseURL must start with http(s)://')
  return { baseURL, profiles: resolveProfiles(config) }
}

export function apply(ctx: Context, config: Config): void {
  let current = (): Config => config
  const options = () => {
    const raw = current()
    return { ...raw, ...resolveAdapterOptions(raw) }
  }
  options()

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

  const adapter = new Sub2ApiAdapter({
    options: () => current(),
    resolveApiKey,
    streamIdleTimeoutMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  })

  ctx.llm.registerConfigurableProviders(
    PROVIDERS.map((def) => ({
      provider: def.route,
      displayName: `Sub2API ${def.label}`,
      settingsNs: NS,
      settingsPath: ['providers', def.key],
      declared: true,
    })),
  )

  let registration: { replace(providers: string[]): void } | undefined
  let registeredRoutes: string[] = []
  const ensureRegistration = () => {
    const routes = PROVIDERS
      .filter((def) => current().providers[def.key].apiKeyEnv !== undefined)
      .map((def) => def.route)
    const same = routes.length === registeredRoutes.length && routes.every((r, i) => r === registeredRoutes[i])
    if (same) return
    if (registration === undefined) {
      if (routes.length > 0) registration = ctx.llm.registerAdapter(routes, adapter)
    } else {
      registration.replace(routes)
    }
    registeredRoutes = routes
  }
  ensureRegistration()

  // Settings-page HTTP bridge: read/write config, discover models, query usage.
  registerRoutes(ctx, {
    config: () => current(),
    setConfig: (next) => {
      // Mutate in place so the settings scope (and its watchers) see the change.
      const raw = current()
      raw.baseURL = next.baseURL
      for (const def of PROVIDERS) {
        raw.providers[def.key] = next.providers[def.key]
      }
      ensureRegistration()
    },
    listRegisteredRoutes: () => registeredRoutes,
  })

  installSettingsSection(ctx, NS, Config, config, {
    setSource: (source) => {
      current = source
    },
    onChange: () => {
      try {
        ensureRegistration()
      } catch (error) {
        ctx.logger.error('llm-sub2api: keeping the previously registered routes after a refused update')
        ctx.logger.error(error)
      }
    },
  })
}

export { Config as default }
