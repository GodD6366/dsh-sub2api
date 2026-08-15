/**
 * Sub2API gateway adapter for the harness LLM seam.
 *
 * One OpenAI-compatible base URL, many provider routes. In the sub2api
 * gateway each API key is bound to a group, and the group decides the
 * platform (openai / anthropic / gemini / grok) and the model list the key
 * can serve — so this plugin registers one route per configured key, all
 * sharing a single baseURL. The gateway speaks each platform's NATIVE wire
 * protocol upstream (OpenAI → Responses API, Claude → Messages API, the rest
 * → chat/completions), so the adapter talks to the matching endpoint per
 * route instead of forcing the gateway to convert chat/completions, which
 * mangles parallel tool calls. Keys are stored through the harness credential
 * seam; the base URL and per-key model catalogs live in the `llm-sub2api:`
 * settings section (`$DSH_HOME/settings.yaml`, written by the web Models
 * page).
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
  ReasoningEffortId,
  assertUsableApiKey,
  attributionHeaders,
  contentHasImage,
  isContextWindowExceededError,
  isQuotaExceededError,
} from '@deepseek-ai/dsh-llm'
import type {
  ContentBlock,
  FinishReason,
  GenerateOptions,
  LlmModelInfo,
  LlmModelReasoningInfo,
  LlmReasoningEffortInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  Message,
  ResolvedRetryPolicy,
  StreamChunk,
  TokenUsage,
} from '@deepseek-ai/dsh-llm'
import type { AttachmentStore, ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { registerRoutes } from './routes.ts'
import { registerImageTools } from './image-tools.ts'
import { Sub2ApiVisionAdapter, visionRouteOf, VISION_ROUTE_SUFFIX } from './vision-wrapper.ts'

export {
  Sub2ApiVisionAdapter,
  VisionMemory,
  VISION_ROUTE_SUFFIX,
  VISION_MODEL_SUFFIX,
  visionRouteOf,
  baseRouteOf,
  stripVisionModel,
} from './vision-wrapper.ts'
export { describeViaVisionModel } from './image-tools.ts'

export const name = 'llm-sub2api'
export const inject: string[] = ['llm', 'settings', 'credentials']

const NS = settingsNamespace('llm-sub2api')

/** Context capacity assumed for a model neither configuration nor discovery sizes. */
export const DEFAULT_CONTEXT_WINDOW = 128000
/** Output capability assumed for a model neither configuration nor discovery sizes. */
export const DEFAULT_MAX_TOKENS = 8192
/** Maximum provider idle time while one stream read is outstanding. */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000

/**
 * Reasoning effort levels exposed for reasoning-capable models. The gateway
 * speaks the OpenAI chat-completions protocol, so the ids are the OpenAI
 * `reasoning_effort` vocabulary and are sent through verbatim. Per-model
 * configuration (filled from models.dev `reasoning_options`) may expose
 * additional vocabulary such as `none`, `xhigh`, or `max`.
 */
export const REASONING_EFFORTS: readonly { id: ReasoningEffortId; name: string }[] = [
  { id: ReasoningEffortId('low'), name: 'Low' },
  { id: ReasoningEffortId('medium'), name: 'Medium' },
  { id: ReasoningEffortId('high'), name: 'High' },
]

/** Display names for effort ids beyond the default low/medium/high vocabulary. */
const EFFORT_NAMES: Record<string, string> = {
  none: 'None',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
}

function effortName(id: string): string {
  return EFFORT_NAMES[id] ?? (id.length > 0 ? id.charAt(0).toUpperCase() + id.slice(1) : id)
}

/**
 * Reasoning metadata for one exact route/model, or undefined when the model
 * must not expose a reasoning-effort control. Every sub2api route speaks the
 * OpenAI chat-completions protocol against the same gateway, so `reasoning_effort`
 * applies to every provider by default — the provider route alone never hides
 * the control. An explicit per-model setting wins: an empty `reasoningEfforts`
 * opts the model out, a non-empty list exposes exactly those levels (verbatim,
 * so models.dev vocabularies like `xhigh`/`max`/`none` survive). Image models
 * are not chat reasoning models.
 */
function reasoningInfo(_provider: string, modelId: string, configured?: CatalogModel): LlmModelReasoningInfo | undefined {
  if (configured?.reasoningEfforts !== undefined) {
    if (configured.reasoningEfforts.length === 0) return undefined
    const seen = new Set<string>()
    const efforts: LlmReasoningEffortInfo[] = []
    for (const id of configured.reasoningEfforts) {
      if (typeof id !== 'string' || id.length === 0 || seen.has(id)) continue
      seen.add(id)
      efforts.push({ id: ReasoningEffortId(id), name: effortName(id) })
    }
    return efforts.length > 0 ? { efforts } : undefined
  }
  if (/image/i.test(modelId)) return undefined
  return { efforts: REASONING_EFFORTS }
}

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

const DEFAULT_MODELS: CatalogModel[] = []

/**
 * Request modalities a catalog model declares to the harness. An explicit
 * `input` wins; absent/empty falls back to a family guess — frontier
 * multimodal families accept images, everything else stays text-only (the
 * official harness posture: a hand-entered model is text-only until it says
 * otherwise). The model picker and the image-attach gate both read this.
 */
function catalogInputModalities(model: { id: string; input?: Array<'text' | 'image'> }): Array<'text' | 'image'> {
  if (model.input !== undefined && model.input.length > 0) return [...model.input]
  return /^(gpt|o[1-9]|claude|gemini|grok|glm|qwen|kimi|moonshot|minimax|mistral|llama|phi|command|jamba|codex|sora|veo|imagen|dall-e)/i.test(model.id)
    ? ['text', 'image']
    : ['text']
}

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

/**
 * Whether a chat message carries a durable image block (the harness attaches
 * one only for models that declare the image modality; the adapter must then
 * serialize it in the provider's native wire format).
 */
function hasImageContent(blocks: readonly ContentBlock[]): boolean {
  return contentHasImage(blocks as never)
}

/**
 * Read one durable image block into wire-ready base64 bytes through the
 * attachment service (the same seam the official llm-pi-ai adapter uses).
 */
async function readWireImage(
  block: ContentBlock,
  attachments: AttachmentStore | undefined,
  signal: AbortSignal | undefined,
): Promise<{ mediaType: ImageMediaType; data: string }> {
  if (block.type !== 'image') throw new LlmError('sub2api: unexpected content block', 'UNSUPPORTED_CONTENT')
  const ref = block.attachment as ImageAttachmentRef
  if (attachments === undefined) {
    throw new LlmError('sub2api: image input requires the durable attachment service', 'UNSUPPORTED_CONTENT')
  }
  const stored = await attachments.readImage(ref, signal)
  return { mediaType: stored.ref.mediaType, data: Buffer.from(stored.data).toString('base64') }
}

/**
 * The text/image parts of a user message in the provider's native wire
 * format. Tool-result blocks are handled separately by each serializer.
 */
async function wireUserContent(
  blocks: readonly ContentBlock[],
  api: ApiProtocol,
  attachments: AttachmentStore | undefined,
  signal: AbortSignal | undefined,
): Promise<unknown[]> {
  const parts: unknown[] = []
  for (const block of blocks) {
    if (block.type === 'text' && block.text.length > 0) {
      parts.push(api === 'openai-responses' ? { type: 'input_text', text: block.text } : { type: 'text', text: block.text })
    } else if (block.type === 'image') {
      const image = await readWireImage(block, attachments, signal)
      if (api === 'anthropic-messages') {
        parts.push({ type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.data } })
      } else if (api === 'openai-responses') {
        parts.push({ type: 'input_image', image_url: `data:${image.mediaType};base64,${image.data}` })
      } else {
        parts.push({ type: 'image_url', image_url: { url: `data:${image.mediaType};base64,${image.data}` } })
      }
    }
  }
  return parts
}

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

function protocolFor(def: ProviderDef, profile: ProviderProfile): ApiProtocol {
  return apiProtocolForKey(def.key, profile)
}

interface WireMessage {
  role: string
  content?: string | unknown[]
  tool_call_id?: string
  tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>
}

/** Serialize the conversation into OpenAI chat-completions wire messages. */
async function serializeMessagesCompletions(
  messages: readonly Message[],
  attachments: AttachmentStore | undefined,
  signal: AbortSignal | undefined,
): Promise<WireMessage[]> {
  const wire: WireMessage[] = []
  for (const message of messages) {
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
    if (hasImageContent(message.content)) {
      const parts = await wireUserContent(message.content, 'openai-completions', attachments, signal)
      if (parts.length > 0) wire.push({ role: 'user', content: parts })
    } else {
      const text = flattenText(message.content)
      if (text.length > 0 || toolResults.length === 0) wire.push({ role: 'user', content: text })
    }
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

/** Build the OpenAI chat-completions wire request. */
async function serializeRequestCompletions(
  options: GenerateOptions,
  attachments: AttachmentStore | undefined,
  signal: AbortSignal | undefined,
): Promise<Record<string, unknown>> {
  const messages: WireMessage[] = []
  if (options.system !== undefined) messages.push({ role: 'system', content: options.system })
  messages.push(...await serializeMessagesCompletions(options.messages, attachments, signal))
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
    ...(options.reasoningEffort !== undefined ? { reasoning_effort: options.reasoningEffort } : {}),
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(options.maxTokens !== undefined ? { max_tokens: options.maxTokens } : {}),
    ...(options.stop !== undefined ? { stop: options.stop } : {}),
  }
}

/**
 * One Responses-API `input` item. Content arrays hold `input_text`,
 * `function_call`, and `function_call_output` parts; tool-call arguments stay
 * raw JSON strings.
 */
interface ResponsesInputItem {
  role: string
  content: unknown[]
}

/** Serialize the conversation into OpenAI Responses-API `input` items. */
async function serializeMessagesResponses(
  messages: readonly Message[],
  attachments: AttachmentStore | undefined,
  signal: AbortSignal | undefined,
): Promise<ResponsesInputItem[]> {
  const wire: ResponsesInputItem[] = []
  for (const message of messages) {
    if (message.role === 'system') {
      wire.push({ role: 'system', content: [{ type: 'input_text', text: flattenText(message.content) }] })
      continue
    }
    if (message.role === 'assistant') {
      const text = flattenText(message.content)
      const content: unknown[] = text.length > 0 ? [{ type: 'output_text', text }] : []
      for (const b of message.content) {
        if (b.type !== 'tool-call') continue
        const call = b as { id: string; name: string; arguments: string }
        content.push({
          type: 'function_call',
          // `call_id` is the current Responses vocabulary; `id` is kept for
          // gateways that still read the older key.
          call_id: call.id,
          id: call.id,
          name: call.name,
          arguments: call.arguments,
        })
      }
      wire.push({ role: 'assistant', content })
      continue
    }
    const parts = await wireUserContent(message.content, 'openai-responses', attachments, signal)
    if (parts.length > 0) wire.push({ role: 'user', content: parts })
    for (const b of message.content) {
      if (b.type !== 'tool-result') continue
      const result = b as { toolCallId: string; content: ContentBlock[] }
      wire.push({
        role: 'user',
        content: [{
          type: 'function_call_output',
          call_id: result.toolCallId,
          output: flattenText(result.content) || '(no output)',
        }],
      })
    }
  }
  return wire
}

/** Build the OpenAI Responses-API wire request. */
async function serializeRequestResponses(
  options: GenerateOptions,
  attachments: AttachmentStore | undefined,
  signal: AbortSignal | undefined,
): Promise<Record<string, unknown>> {
  const input: unknown[] = []
  if (options.system !== undefined) input.push({ role: 'system', content: [{ type: 'input_text', text: options.system }] })
  input.push(...await serializeMessagesResponses(options.messages, attachments, signal))
  const tools = options.tools?.map((t) => ({
    type: 'function',
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }))
  return {
    model: options.model,
    input,
    stream: true,
    stream_options: { include_usage: true },
    ...(tools !== undefined && tools.length > 0 ? { tools } : {}),
    ...(options.reasoningEffort !== undefined ? { reasoning: { effort: options.reasoningEffort } } : {}),
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(options.maxTokens !== undefined ? { max_output_tokens: options.maxTokens } : {}),
    ...(options.stop !== undefined ? { stop: options.stop } : {}),
  }
}

/** One Anthropic Messages-API message; content holds text/tool_use/tool_result parts. */
interface MessagesWireMessage {
  role: string
  content: unknown[]
}

/** Serialize the conversation into Anthropic Messages-API messages. */
async function serializeMessagesMessages(
  messages: readonly Message[],
  attachments: AttachmentStore | undefined,
  signal: AbortSignal | undefined,
): Promise<MessagesWireMessage[]> {
  const wire: MessagesWireMessage[] = []
  for (const message of messages) {
    if (message.role === 'system') {
      // The Messages API has no system role in the messages array (the system
      // prompt rides the top-level `system` field); a system block in history
      // degrades to a user text block so it is not silently dropped.
      wire.push({ role: 'user', content: [{ type: 'text', text: flattenText(message.content) }] })
      continue
    }
    if (message.role === 'assistant') {
      const text = flattenText(message.content)
      const content: unknown[] = text.length > 0 ? [{ type: 'text', text }] : []
      for (const b of message.content) {
        if (b.type !== 'tool-call') continue
        const call = b as { id: string; name: string; arguments: string }
        let input: unknown = {}
        try {
          input = JSON.parse(call.arguments)
        } catch {
          input = {}
        }
        content.push({ type: 'tool_use', id: call.id, name: call.name, input })
      }
      wire.push({ role: 'assistant', content })
      continue
    }
    const toolResults = message.content.filter((b) => b.type === 'tool-result')
    const parts = await wireUserContent(message.content, 'anthropic-messages', attachments, signal)
    if (parts.length > 0 || toolResults.length === 0) {
      wire.push({ role: 'user', content: parts.length > 0 ? parts : [{ type: 'text', text: '' }] })
    }
    for (const b of toolResults) {
      const result = b as { toolCallId: string; content: ContentBlock[] }
      wire.push({
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: result.toolCallId,
          content: flattenText(result.content) || '(no output)',
        }],
      })
    }
  }
  // The Messages API requires alternating roles; fold adjacent same-role
  // messages together so a tool-result turn followed by text cannot 400.
  const merged: MessagesWireMessage[] = []
  for (const message of wire) {
    const last = merged[merged.length - 1]
    if (last !== undefined && last.role === message.role) last.content.push(...message.content)
    else merged.push(message)
  }
  return merged
}

/** Thinking-budget mapping for Anthropic extended thinking per effort id. */
const EFFORT_BUDGETS: Record<string, number> = {
  low: 4096,
  medium: 8192,
  high: 16384,
  xhigh: 32768,
  max: 65536,
}

/** Build the Anthropic Messages-API wire request. */
async function serializeRequestMessages(
  options: GenerateOptions,
  attachments: AttachmentStore | undefined,
  signal: AbortSignal | undefined,
): Promise<Record<string, unknown>> {
  const tools = options.tools?.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
  }))
  return {
    model: options.model,
    ...(options.system !== undefined ? { system: options.system } : {}),
    messages: await serializeMessagesMessages(options.messages, attachments, signal),
    ...(tools !== undefined && tools.length > 0 ? { tools } : {}),
    // The Messages API requires max_tokens; default to the plugin output cap
    // when the caller names none.
    max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
    stream: true,
    ...(options.reasoningEffort !== undefined
      ? options.reasoningEffort === 'none' || options.reasoningEffort === 'off'
        ? { thinking: { type: 'disabled' } }
        : { thinking: { type: 'enabled', budget_tokens: EFFORT_BUDGETS[options.reasoningEffort] ?? 16384 } }
      : {}),
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(options.stop !== undefined ? { stop_sequences: options.stop } : {}),
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

/** Map Responses-API `usage` (input_tokens / output_tokens + details) into harness counts. */
function mapUsageResponses(usage: unknown): TokenUsage | undefined {
  if (typeof usage !== 'object' || usage === null) return undefined
  const u = usage as Record<string, unknown>
  const input = Number(u.input_tokens ?? 0)
  const output = Number(u.output_tokens ?? 0)
  const inputDetails = u.input_tokens_details as Record<string, unknown> | undefined
  const outputDetails = u.output_tokens_details as Record<string, unknown> | undefined
  const cacheRead = inputDetails?.cached_tokens !== undefined ? Number(inputDetails.cached_tokens) : undefined
  const reasoning = outputDetails?.reasoning_tokens !== undefined ? Number(outputDetails.reasoning_tokens) : undefined
  if (input === 0 && output === 0 && cacheRead === undefined && reasoning === undefined) return undefined
  return {
    inputTokens: input - (cacheRead ?? 0),
    outputTokens: output,
    ...(cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {}),
    ...(reasoning !== undefined ? { reasoningTokens: reasoning } : {}),
  }
}

/**
 * A gateway tool call without a name is a protocol-conversion failure, not a
 * tool the model invented. Reject it with a readable error instead of letting
 * the harness answer `unknown tool ""`.
 */
function assembleToolCall(block: { callId?: string; name?: string; text: string } | undefined): ContentBlock {
  const name = block?.name ?? ''
  if (name.length === 0) {
    throw new LlmError(
      'sub2api: gateway returned a tool call with no tool name (its streamed tool_calls are malformed for this route; pick the group\'s native protocol — openai→responses, claude→messages — or update the gateway)',
      'MALFORMED_RESPONSE',
    )
  }
  return { type: 'tool-call', id: CallId(block?.callId ?? ''), name, arguments: block?.text ?? '' }
}

interface AdapterOptions {
  /** Current validated config, resolved once per operation. */
  options: () => Config
  /** Resolve the credential for one already-resolved profile. */
  resolveApiKey: (route: string, profile: ProviderProfile) => Promise<string>
  /** Resolve the durable attachment service for image input, when mounted. */
  resolveAttachments: () => AttachmentStore | undefined
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
      inputModalities: catalogInputModalities(m),
    }))
  }

  override async resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    const def = providerDef(provider)
    const profile = def !== undefined ? this.config.options().providers[def.key] : undefined
    const found = profile?.models?.find((m) => m.id === model)
    const reasoning = reasoningInfo(provider, model, found)
    return {
      provider,
      id: model,
      name: found?.name ?? model,
      inputModalities: catalogInputModalities(found ?? { id: model }),
      context: { contextWindow: found?.contextWindow ?? DEFAULT_CONTEXT_WINDOW },
      defaultMaxTokens: found?.maxTokens ?? DEFAULT_MAX_TOKENS,
      ...(reasoning !== undefined ? { reasoning } : {}),
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
    const api = protocolFor(def, profile)
    const endpoint = api === 'openai-responses'
      ? '/responses'
      : api === 'anthropic-messages'
        ? '/messages'
        : '/chat/completions'
    const controller = new AbortController()
    const signal = options.signal !== undefined
      ? (() => {
          const onAbort = () => controller.abort()
          options.signal?.addEventListener('abort', onAbort)
          return { signal: controller.signal, cleanup: () => options.signal?.removeEventListener('abort', onAbort) }
        })()
      : { signal: controller.signal, cleanup: () => {} }

    // Image content needs the durable attachment service to resolve bytes;
    // the harness gates attachments on the model's declared modalities, so
    // reaching here with an image means the model declared support.
    const attachments = this.config.resolveAttachments()
    const body = api === 'openai-responses'
      ? await serializeRequestResponses(options, attachments, signal.signal)
      : api === 'anthropic-messages'
        ? await serializeRequestMessages(options, attachments, signal.signal)
        : await serializeRequestCompletions(options, attachments, signal.signal)

    let response: Response
    try {
      response = await fetch(`${baseURL}${endpoint}`, {
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
      if (api === 'openai-responses') {
        yield* this.translateResponses(response.body, options, signal.cleanup)
      } else if (api === 'anthropic-messages') {
        yield* this.translateMessages(response.body, options, signal.cleanup)
      } else {
        yield* this.translate(response.body, options, signal.cleanup)
      }
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
          // OpenAI-compatible streams send `id`/`function.name` only on the
          // first delta of a tool call; later deltas may carry them as empty
          // strings or null. Capture each field once, from the first non-empty
          // value, so a later empty/null delta cannot clobber it.
          if (typeof call.id === 'string' && call.id.length > 0 && block.callId === undefined) block.callId = call.id
          if (
            typeof call.function?.name === 'string'
            && call.function.name.length > 0
            && block.name === undefined
          ) block.name = call.function.name
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
        else content = assembleToolCall(toolBlocks.get(entry.block.index))
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

  private async *translateResponses(body: ReadableStream<Uint8Array>, options: GenerateOptions, cleanup: () => void): AsyncGenerator<StreamChunk> {
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let nextIndex = 0
    const textBlocks = new Map<string, StreamTextBlock>()
    const reasoningBlocks = new Map<string, StreamTextBlock>()
    const toolBlocks = new Map<string, StreamToolBlock>()
    const order: StreamOrderEntry[] = []
    let usage: TokenUsage | undefined
    let finish: FinishReason | undefined

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
          for (const line of raw.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart())) {
            if (line.length === 0) continue
            let event: ResponsesEvent
            try {
              event = JSON.parse(line) as ResponsesEvent
            } catch {
              continue
            }
            const type = event.type
            if (type === 'response.output_text.delta') {
              const itemId = typeof event.item_id === 'string' ? event.item_id : ''
              if (itemId.length === 0) continue
              let block = textBlocks.get(itemId)
              if (block === undefined) {
                block = { index: nextIndex++, text: '' }
                textBlocks.set(itemId, block)
                order.push({ index: block.index, kind: 'text', block })
                yield { type: 'block-start', index: block.index, blockType: 'text' }
              }
              const delta = typeof event.delta === 'string' ? event.delta : ''
              if (delta.length === 0) continue
              block.text += delta
              yield { type: 'text-delta', index: block.index, text: delta }
            } else if (type === 'response.reasoning_summary_text.delta' || type === 'response.reasoning_text.delta') {
              const itemId = typeof event.item_id === 'string' ? event.item_id : ''
              if (itemId.length === 0) continue
              let block = reasoningBlocks.get(itemId)
              if (block === undefined) {
                block = { index: nextIndex++, text: '' }
                reasoningBlocks.set(itemId, block)
                order.push({ index: block.index, kind: 'reasoning', block })
                yield { type: 'block-start', index: block.index, blockType: 'reasoning' }
              }
              const delta = typeof event.summary === 'string' ? event.summary : typeof event.text === 'string' ? event.text : ''
              if (delta.length === 0) continue
              block.text += delta
              yield { type: 'reasoning-delta', index: block.index, text: delta }
            } else if (type === 'response.output_item.added') {
              const item = event.item
              if (typeof item !== 'object' || item === null || item.type !== 'function_call') continue
              const itemId = typeof item.id === 'string' ? item.id : typeof item.call_id === 'string' ? item.call_id : ''
              if (itemId.length === 0) continue
              let block = toolBlocks.get(itemId)
              if (block === undefined) {
                block = { index: nextIndex++, text: '' }
                toolBlocks.set(itemId, block)
                order.push({ index: block.index, kind: 'tool-call', block })
                yield { type: 'block-start', index: block.index, blockType: 'tool-call' }
              }
              if (block.callId === undefined && typeof item.call_id === 'string') block.callId = item.call_id
              if (block.name === undefined && typeof item.name === 'string') block.name = item.name
            } else if (type === 'response.function_call_arguments.delta') {
              const itemId = typeof event.item_id === 'string' ? event.item_id : ''
              if (itemId.length === 0) continue
              let block = toolBlocks.get(itemId)
              if (block === undefined) {
                block = { index: nextIndex++, text: '' }
                toolBlocks.set(itemId, block)
                order.push({ index: block.index, kind: 'tool-call', block })
                yield { type: 'block-start', index: block.index, blockType: 'tool-call' }
              }
              const delta = typeof event.delta === 'string' ? event.delta : ''
              if (delta.length === 0) continue
              block.text += delta
              yield {
                type: 'tool-call-delta',
                index: block.index,
                id: CallId(block.callId ?? ''),
                ...(block.name !== undefined ? { name: block.name } : {}),
                argumentsDelta: delta,
              }
            } else if (type === 'response.output_item.done') {
              const item = event.item
              if (typeof item !== 'object' || item === null || item.type !== 'function_call') continue
              const itemId = typeof item.id === 'string' ? item.id : typeof item.call_id === 'string' ? item.call_id : ''
              const block = itemId.length > 0 ? toolBlocks.get(itemId) : undefined
              if (block !== undefined) {
                if (typeof item.call_id === 'string' && item.call_id.length > 0) block.callId = item.call_id
                if (typeof item.name === 'string' && item.name.length > 0) block.name = item.name
                if (typeof item.arguments === 'string' && item.arguments.length > 0) block.text = item.arguments
              }
            } else if (type === 'response.completed' || type === 'response.incomplete' || type === 'response.failed') {
              const response = event.response
              usage = mapUsageResponses(response?.usage)
              const status = typeof response?.status === 'string' ? response.status : ''
              const output = Array.isArray(response?.output) ? response.output as Array<Record<string, unknown>> : []
              const hasToolCalls = order.some((entry) => entry.kind === 'tool-call')
                || output.some((item) => item.type === 'function_call')
              if (status === 'completed') {
                finish = hasToolCalls ? { kind: 'tool-calls' } : { kind: 'stop' }
              } else if (status === 'incomplete') {
                const details = typeof response?.incomplete_details === 'object' && response.incomplete_details !== null
                  ? response.incomplete_details as Record<string, unknown>
                  : {}
                const reason = typeof details.reason === 'string' ? details.reason : 'unknown'
                finish = reason === 'max_output_tokens'
                  ? { kind: 'max-tokens' }
                  : { kind: 'error', failure: { message: `sub2api: responses stream incomplete (${reason})`, code: 'INCOMPLETE' } }
              } else {
                const error = typeof response?.error === 'object' && response.error !== null ? response.error as Record<string, unknown> : {}
                finish = {
                  kind: 'error',
                  failure: { message: typeof error.message === 'string' ? error.message : 'sub2api: responses stream failed', code: 'PROVIDER' },
                }
              }
              // Patch tool blocks with the final assembled items and create any
              // the deltas never visited (some gateways emit only the terminal).
              for (const item of output) {
                if (item.type !== 'function_call') continue
                const itemId = typeof item.id === 'string' ? item.id : typeof item.call_id === 'string' ? item.call_id : ''
                if (itemId.length === 0) continue
                let block = toolBlocks.get(itemId)
                if (block === undefined) {
                  block = { index: nextIndex++, text: '' }
                  toolBlocks.set(itemId, block)
                  order.push({ index: block.index, kind: 'tool-call', block })
                  yield { type: 'block-start', index: block.index, blockType: 'tool-call' }
                }
                if (typeof item.call_id === 'string' && item.call_id.length > 0) block.callId = item.call_id
                if (typeof item.name === 'string' && item.name.length > 0) block.name = item.name
                if (typeof item.arguments === 'string' && item.arguments.length > 0) block.text = item.arguments
              }
              break // terminal event: stop consuming this buffer's lines
            } else if (type === 'error') {
              finish = {
                kind: 'error',
                failure: { message: `sub2api: responses error: ${typeof event.message === 'string' ? event.message : 'unknown'}`, code: 'PROVIDER' },
              }
              break
            }
          }
          if (finish !== undefined) break
        }
        if (finish !== undefined) break
      }
    } finally {
      cleanup()
      try {
        reader.releaseLock()
      } catch {
        // lock already released or reader detached
      }
    }

    if (finish === undefined) {
      if (options.signal?.aborted) throw new LlmError('sub2api: request aborted', 'ABORTED')
      throw new LlmError('sub2api: responses stream ended without a terminal event', 'STREAM_CLOSED')
    }
    for (const entry of order) {
      let content: ContentBlock
      if (entry.kind === 'text') content = { type: 'text', text: entry.block.text }
      else if (entry.kind === 'reasoning') content = { type: 'reasoning', text: entry.block.text }
      else content = assembleToolCall(entry.block as StreamToolBlock)
      yield { type: 'block-end', index: entry.index, block: content }
    }
    if (usage !== undefined) yield { type: 'usage', usage }
    const reason: FinishReason = finish.kind === 'stop' && order.length === 0
      ? { kind: 'error', failure: { message: 'sub2api: model returned a completed response with no content', code: EMPTY_RESPONSE_CODE } }
      : finish
    yield { type: 'finish', reason }
  }

  private async *translateMessages(body: ReadableStream<Uint8Array>, options: GenerateOptions, cleanup: () => void): AsyncGenerator<StreamChunk> {
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    const blocks = new Map<number, MessagesBlock>()
    const order: Array<{ index: number; kind: 'text' | 'reasoning' | 'tool-call' }> = []
    let usageInput = 0
    let usageCacheRead: number | undefined
    let usageCacheWrite: number | undefined
    let usageOutput = 0
    let usageReasoning: number | undefined
    let stopReason: string | undefined
    let terminal = false
    let finish: FinishReason | undefined

    const getOrCreate = (index: number, kind: MessagesBlock['kind']): MessagesBlock => {
      let block = blocks.get(index)
      if (block === undefined) {
        block = { kind, text: '' }
        blocks.set(index, block)
        order.push({ index, kind })
      }
      return block
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
          for (const line of raw.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart())) {
            if (line.length === 0) continue
            let event: MessagesEvent
            try {
              event = JSON.parse(line) as MessagesEvent
            } catch {
              continue
            }
            const type = event.type
            if (type === 'message_start') {
              const usage = typeof event.message === 'object' && event.message !== null
                ? event.message.usage as Record<string, unknown> | undefined
                : undefined
              usageInput = Number(usage?.input_tokens ?? 0)
              usageCacheRead = usage?.cache_read_input_tokens !== undefined ? Number(usage.cache_read_input_tokens) : undefined
              usageCacheWrite = usage?.cache_creation_input_tokens !== undefined ? Number(usage.cache_creation_input_tokens) : undefined
            } else if (type === 'content_block_start') {
              const index = typeof event.index === 'number' ? event.index : -1
              const block = typeof event.content_block === 'object' && event.content_block !== null ? event.content_block : {}
              if (index < 0) continue
              if (block.type === 'text') {
                getOrCreate(index, 'text')
                yield { type: 'block-start', index, blockType: 'text' }
              } else if (block.type === 'thinking') {
                getOrCreate(index, 'reasoning')
                yield { type: 'block-start', index, blockType: 'reasoning' }
              } else if (block.type === 'tool_use') {
                const created = getOrCreate(index, 'tool-call')
                if (typeof block.id === 'string' && block.id.length > 0) created.callId = block.id
                if (typeof block.name === 'string' && block.name.length > 0) created.name = block.name
                yield { type: 'block-start', index, blockType: 'tool-call' }
              }
            } else if (type === 'content_block_delta') {
              const index = typeof event.index === 'number' ? event.index : -1
              const delta = typeof event.delta === 'object' && event.delta !== null ? event.delta : {}
              if (index < 0) continue
              if (delta.type === 'text_delta') {
                const created = getOrCreate(index, 'text')
                const text = typeof delta.text === 'string' ? delta.text : ''
                if (text.length === 0) continue
                created.text += text
                yield { type: 'text-delta', index, text }
              } else if (delta.type === 'thinking_delta') {
                const created = getOrCreate(index, 'reasoning')
                const text = typeof delta.thinking === 'string' ? delta.thinking : ''
                if (text.length === 0) continue
                created.text += text
                yield { type: 'reasoning-delta', index, text }
              } else if (delta.type === 'input_json_delta') {
                const created = getOrCreate(index, 'tool-call')
                const fragment = typeof delta.partial_json === 'string' ? delta.partial_json : ''
                if (fragment.length === 0) continue
                created.text += fragment
                yield {
                  type: 'tool-call-delta',
                  index,
                  id: CallId(created.callId ?? ''),
                  ...(created.name !== undefined ? { name: created.name } : {}),
                  argumentsDelta: fragment,
                }
              }
            } else if (type === 'message_delta') {
              const delta = typeof event.delta === 'object' && event.delta !== null ? event.delta : {}
              if (typeof delta.stop_reason === 'string') stopReason = delta.stop_reason
              const usage = typeof event.usage === 'object' && event.usage !== null ? event.usage as Record<string, unknown> : {}
              usageOutput = Number(usage.output_tokens ?? 0)
              const details = typeof usage.output_tokens_details === 'object' && usage.output_tokens_details !== null
                ? usage.output_tokens_details as Record<string, unknown>
                : {}
              usageReasoning = details.reasoning_tokens !== undefined ? Number(details.reasoning_tokens) : undefined
            } else if (type === 'message_stop') {
              terminal = true
              const hasToolCalls = order.some((entry) => entry.kind === 'tool-call')
              switch (stopReason) {
                case 'end_turn':
                  finish = hasToolCalls ? { kind: 'tool-calls' } : { kind: 'stop' }
                  break
                case 'tool_use':
                  finish = { kind: 'tool-calls' }
                  break
                case 'max_tokens':
                  finish = { kind: 'max-tokens' }
                  break
                case 'stop_sequence':
                  finish = { kind: 'stop' }
                  break
                case 'refusal':
                  finish = { kind: 'error', failure: { message: 'sub2api: model refused to respond', code: 'REFUSAL' } }
                  break
                default:
                  finish = {
                    kind: 'error',
                    failure: { message: `sub2api: model stopped: ${stopReason ?? 'unknown'}`, code: 'PROVIDER' },
                  }
              }
              break
            } else if (type === 'error') {
              terminal = true
              const error = typeof event.error === 'object' && event.error !== null ? event.error as Record<string, unknown> : {}
              finish = {
                kind: 'error',
                failure: { message: typeof error.message === 'string' ? error.message : 'sub2api: messages stream failed', code: 'PROVIDER' },
              }
              break
            }
          }
          if (terminal) break
        }
        if (terminal) break
      }
    } finally {
      cleanup()
      try {
        reader.releaseLock()
      } catch {
        // lock already released or reader detached
      }
    }

    if (finish === undefined) {
      if (options.signal?.aborted) throw new LlmError('sub2api: request aborted', 'ABORTED')
      throw new LlmError('sub2api: messages stream ended without a terminal event', 'STREAM_CLOSED')
    }
    for (const entry of order) {
      const block = blocks.get(entry.index)
      let content: ContentBlock
      if (entry.kind === 'text') content = { type: 'text', text: block?.text ?? '' }
      else if (entry.kind === 'reasoning') content = { type: 'reasoning', text: block?.text ?? '' }
      else content = assembleToolCall(block)
      yield { type: 'block-end', index: entry.index, block: content }
    }
    const usage: TokenUsage | undefined = usageInput > 0 || usageOutput > 0
      || usageCacheRead !== undefined || usageCacheWrite !== undefined || usageReasoning !== undefined
      ? {
          inputTokens: usageInput - (usageCacheRead ?? 0) - (usageCacheWrite ?? 0),
          outputTokens: usageOutput,
          ...(usageCacheRead !== undefined ? { cacheReadTokens: usageCacheRead } : {}),
          ...(usageCacheWrite !== undefined ? { cacheWriteTokens: usageCacheWrite } : {}),
          ...(usageReasoning !== undefined ? { reasoningTokens: usageReasoning } : {}),
        }
      : undefined
    if (usage !== undefined) yield { type: 'usage', usage }
    const reason: FinishReason = finish.kind === 'stop' && order.length === 0
      ? { kind: 'error', failure: { message: 'sub2api: model returned a completed response with no content', code: EMPTY_RESPONSE_CODE } }
      : finish
    yield { type: 'finish', reason }
  }
}

interface StreamTextBlock {
  index: number
  text: string
}

interface StreamToolBlock {
  index: number
  callId?: string
  name?: string
  text: string
}

interface StreamOrderEntry {
  index: number
  kind: 'text' | 'reasoning' | 'tool-call'
  block: StreamTextBlock
}

interface ResponsesEvent {
  type?: string
  item_id?: unknown
  delta?: unknown
  summary?: unknown
  text?: unknown
  message?: unknown
  item?: Record<string, unknown> | null
  response?: Record<string, unknown> | null
}

interface MessagesBlock {
  kind: 'text' | 'reasoning' | 'tool-call'
  callId?: string
  name?: string
  text: string
}

interface MessagesEvent {
  type?: string
  index?: unknown
  content_block?: Record<string, unknown> | null
  delta?: Record<string, unknown> | null
  message?: { usage?: Record<string, unknown> } | null
  usage?: Record<string, unknown> | null
  error?: Record<string, unknown> | null
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
  const baseURL = (config.baseURL ?? '').trim().replace(/\/+$/, '')
  // An empty baseURL means "not configured yet": boot dormant and let the
  // settings scope (or setConfig) supply the URL later. Only validate the
  // scheme once a URL is actually present.
  if (baseURL.length > 0 && !/^https?:\/\//.test(baseURL)) {
    throw new Error('llm-sub2api: baseURL must start with http(s)://')
  }
  return { baseURL, profiles: resolveProfiles(config) }
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
    resolveAttachments: () => ctx.get('attachments'),
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

  // ── Auto Vision twin routes ──────────────────────────────────────────────
  // Every registered text-only provider route gets an image-capable twin
  // ("<route>-vision", shown as "… + 自动识图"), covering our own sub2api
  // routes AND external providers (deepseek 官方、llm-pi-ai、其他插件添加的
  // 提供商). The twin's catalog declares `inputModalities: ['text', 'image']`
  // so the harness admission accepts pasted images; its stream rewrites image
  // blocks into vision-model transcriptions (via the configured
  // `tools.analyze` model) and delegates the text-only turn to the base
  // route's own adapter. Text-only models gain image capability without
  // changing the model; multimodal models keep their native image input.
  //
  // `registration` is a TS-private LlmRuntime member, reachable at runtime —
  // the same access vision-router uses to wrap third-party adapters.
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
      // 自身路由：直接使用本插件的 Sub2ApiAdapter 实例。
      if (providerDef(route) !== undefined) return adapter
      // 外部路由：委托给该路由已注册的适配器。
      try {
        const registration = registrationAccessor.registration(route)
        if (registration === undefined) return undefined
        const base = registration.adapter
        return {
          listModels: () => base.listModels(route),
          resolveModel: (_provider, model, signal) => base.resolveModel(route, model, signal),
          providerRetryPolicy: () => ctx.llm.providerRetryPolicy(route),
          stream: (options) => base.stream(options),
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

  // 外部路由发现：枚举所有已注册路由，只包装「存在纯文本模型」的路由，
  // 排除自身路由与任何已包装的 -vision 路由。
  const textRouteCache = new Map<string, boolean>()
  const discoverExternalRoutes = async (): Promise<string[]> => {
    const own = new Set(registeredRoutes)
    const out: string[] = []
    for (const info of ctx.llm.listProviders()) {
      const route = info.id
      if (own.has(route) || route.endsWith(VISION_ROUTE_SUFFIX)) continue
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
    const own = registeredRoutes.map((route) => visionRouteOf(route))
    let external: string[] = []
    try {
      textRouteCache.clear()
      external = (await discoverExternalRoutes()).map((route) => visionRouteOf(route))
    } catch {
      external = []
    }
    if (seq !== recomputeSeq) return
    commitVisionRoutes([...own, ...external])
  }

  // 初始发现 + 跟随提供商拓扑变化（其他插件注册/注销路由时自动增删镜像）。
  void recomputeVisionRoutes()
  ctx.on('llm/adapters-updated', () => { void recomputeVisionRoutes() })

  // Settings-page HTTP bridge: read/write config, discover models, query usage.
  registerRoutes(ctx, {
    config: () => current(),
    setConfig: async (next) => {
      // The settings snapshot is handed out frozen (immutable), so never mutate
      // it. Persist through the settings service; its commit swaps the resolved
      // value and re-notifies, and we re-run ensureRegistration below so the
      // response reports the routes that just activated. Without a settings
      // service, fall back to an in-memory source.
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
      ensureRegistration()
      void recomputeVisionRoutes()
    },
    listRegisteredRoutes: () => registeredRoutes,
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
        ensureRegistration()
        void recomputeVisionRoutes()
      } catch (error) {
        ctx.logger.error('llm-sub2api: keeping the previously registered routes after a refused update')
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
// The schema is already passed to installSettingsSection explicitly.
