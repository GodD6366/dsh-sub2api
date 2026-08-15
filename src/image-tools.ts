/**
 * Global vision and image-generation tools.
 *
 * These call a configured Sub2API model independently of the current chat
 * route, so a text-only session can still inspect or create images. Results
 * stay text-only: a description, or the workspace path of a generated file.
 *
 * @module dsh-sub2api/image-tools
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, extname } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { attributionHeaders, LlmError } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'
import {
  DEFAULT_MAX_TOKENS,
  apiProtocolForKey,
  type ApiProtocol,
  type Config,
  type ProviderKey,
  type ProviderProfile,
} from './index.ts'

interface ImageFsTarget {
  displayPath: string
}

interface ImageFsInfo {
  type: string
}

interface ImageFs {
  resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<ImageFsTarget>
  stat(target: ImageFsTarget, signal?: AbortSignal): Promise<ImageFsInfo | undefined>
  readBytes(target: ImageFsTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array>
  contains(parent: ImageFsTarget, child: ImageFsTarget): boolean
  processPath(target: ImageFsTarget): string
}

function getFs(ctx: Context): ImageFs | undefined {
  return (ctx as Context & { get(name: 'fs'): ImageFs | undefined }).get('fs')
}

export const ANALYZE_IMAGE_NAME = 'analyze_image'
export const GENERATE_IMAGE_NAME = 'generate_image'
export const DEFAULT_IMAGE_TOOL_TIMEOUT_MS = 180_000
export const DEFAULT_MAX_IMAGE_BYTES: number = 20 * 1024 * 1024

const IMAGE_EXTENSIONS: Record<string, ImageMediaType> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'

const GENERATE_SIZES: readonly string[] = [
  'auto',
  '256x256',
  '512x512',
  '1024x1024',
  '1024x1536',
  '1536x1024',
  '1024x1792',
  '1792x1024',
] as const

const GENERATE_QUALITIES: readonly string[] = ['auto', 'low', 'medium', 'high', 'standard', 'hd'] as const

export interface ImageToolHost {
  config: () => Config
  resolveApiKey: (route: string, profile: ProviderProfile) => Promise<string>
}

const PROVIDER_LABELS: Record<ProviderKey, string> = {
  openai: 'OpenAI',
  claude: 'Claude',
  grok: 'Grok',
  gemini: 'Gemini',
}

interface ResolvedToolModel {
  route: string
  label: string
  profile: ProviderProfile
  model: string
  baseURL: string
  /** Wire protocol the gateway speaks for this provider group (see DEFAULT_PROTOCOL). */
  api: ApiProtocol
  /** Output cap for the model, used where the wire protocol requires one. */
  maxTokens: number
}

function isProviderKey(value: string): value is ProviderKey {
  return value === 'openai' || value === 'claude' || value === 'grok' || value === 'gemini'
}

function mediaTypeForPath(filePath: string): ImageMediaType | undefined {
  return IMAGE_EXTENSIONS[extname(filePath).toLowerCase()]
}

function mediaTypeFromBytes(data: Uint8Array): ImageMediaType {
  if (data.length >= 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return 'image/png'
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg'
  if (data.length >= 6 && data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46) return 'image/gif'
  if (
    data.length >= 12
    && data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46
    && data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50
  ) return 'image/webp'
  return 'image/png'
}

function extensionForMediaType(mediaType: ImageMediaType): string {
  switch (mediaType) {
    case 'image/jpeg': return '.jpg'
    case 'image/webp': return '.webp'
    case 'image/gif': return '.gif'
    default: return '.png'
  }
}

function toBase64(data: Uint8Array): string {
  return Buffer.from(data).toString('base64')
}

function dataUrl(mediaType: ImageMediaType, data: Uint8Array): string {
  return `data:${mediaType};base64,${toBase64(data)}`
}

function decodeDataUrl(value: string): { mediaType: ImageMediaType; data: Uint8Array } | undefined {
  const match = /^data:(image\/(?:png|jpeg|jpg|webp|gif));base64,([A-Za-z0-9+/=\s]+)$/i.exec(value.trim())
  if (match === null) return undefined
  const declared = match[1]!.toLowerCase() === 'image/jpg' ? 'image/jpeg' : match[1]!.toLowerCase()
  const mediaType = declared as ImageMediaType
  return { mediaType, data: Buffer.from(match[2]!, 'base64') }
}

function sessionCwd(exec: { agent?: { session: { header: { cwd?: string } } } }): string | undefined {
  return exec.agent?.session.header.cwd
}

function resolveToolModel(config: Config, kind: 'analyze' | 'generate'): ResolvedToolModel {
  const ref = config.tools?.[kind]
  const label = kind === 'analyze' ? '识图' : '生图'
  const provider = typeof ref?.provider === 'string' ? ref.provider.trim() : ''
  const model = typeof ref?.model === 'string' ? ref.model.trim() : ''
  if (provider.length === 0 || model.length === 0) {
    throw new Error(`sub2api: 未配置${label}模型。打开设置 → Sub2API 模型，为「全局图像工具」指定一个模型后再试`)
  }
  if (!isProviderKey(provider)) {
    throw new Error(`sub2api: ${label}模型的平台 "${provider}" 无效，应为 openai / claude / grok / gemini`)
  }
  const baseURL = config.baseURL.trim().replace(/\/+$/, '')
  if (baseURL.length === 0) throw new Error('sub2api: baseURL is not configured')
  const profile = config.providers[provider]
  if (profile.apiKeyEnv === undefined) {
    throw new Error(`sub2api: ${PROVIDER_LABELS[provider]} 未配置 API key，无法调用${label}模型`)
  }
  const catalogModel = profile.models?.find((entry) => entry.id === model)
  return {
    route: `sub2api-${provider}`,
    label: PROVIDER_LABELS[provider],
    profile,
    model,
    baseURL,
    api: apiProtocolForKey(provider, profile),
    maxTokens: catalogModel?.maxTokens ?? DEFAULT_MAX_TOKENS,
  }
}

async function readErrorDetail(response: Response): Promise<string> {
  try {
    const parsed = await response.json() as { error?: { message?: unknown; code?: unknown; type?: unknown } }
    const message = parsed.error?.message
    if (typeof message === 'string' && message.length > 0) return message
  } catch {
    // keep the status fallback
  }
  return `HTTP ${response.status}`
}

async function gatewayFetch(
  host: ImageToolHost,
  resolved: ResolvedToolModel,
  path: string,
  body: Record<string, unknown>,
  signal: AbortSignal | undefined,
  accept: string,
): Promise<Response> {
  const apiKey = await host.resolveApiKey(resolved.route, resolved.profile)
  let response: Response
  try {
    response = await fetch(`${resolved.baseURL}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        accept,
        ...attributionHeaders(),
      },
      body: JSON.stringify(body),
      signal,
    })
  } catch (error) {
    if (signal?.aborted) throw new LlmError('sub2api: request aborted', 'ABORTED', { cause: error })
    throw new LlmError(`sub2api: API request to ${resolved.baseURL}${path} failed`, 'TRANSPORT', { cause: error })
  }
  if (!response.ok) {
    throw new Error(`sub2api ${path}: ${await readErrorDetail(response)}`)
  }
  return response
}

async function collectSseText(response: Response): Promise<string> {
  if (response.body === null) throw new Error('sub2api: API returned no response body')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let text = ''
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
        const dataLines = raw.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart())
        if (dataLines.length === 0) continue
        const joined = dataLines.join('\n')
        if (joined === '[DONE]') return text
        for (const line of dataLines) {
          if (line === '[DONE]') return text
          let chunk: { choices?: Array<{ delta?: { content?: unknown }; message?: { content?: unknown } }> }
          try {
            chunk = JSON.parse(line) as typeof chunk
          } catch {
            continue
          }
          for (const choice of chunk.choices ?? []) {
            const delta = choice.delta?.content ?? choice.message?.content
            if (typeof delta === 'string') text += delta
          }
        }
      }
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // lock already released
    }
  }
  return text
}

function flattenMessageContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => {
      if (typeof part === 'string') return part
      if (typeof part !== 'object' || part === null) return ''
      const record = part as Record<string, unknown>
      if (typeof record.text === 'string') return record.text
      return ''
    })
    .join('')
}

async function collectChatText(response: Response): Promise<string> {
  const contentType = response.headers.get('content-type') ?? ''
  if (contentType.includes('text/event-stream')) {
    const text = (await collectSseText(response)).trim()
    if (text.length === 0) throw new Error('sub2api: vision model returned no text')
    return text
  }
  const payload = await response.json() as { choices?: Array<{ message?: { content?: unknown } }> }
  const text = flattenMessageContent(payload.choices?.[0]?.message?.content).trim()
  if (text.length === 0) throw new Error('sub2api: vision model returned no text')
  return text
}

interface ResponsesTextEvent {
  type?: string
  delta?: unknown
  response?: { output?: Array<{ content?: Array<{ text?: string }> }> }
}

function responsesTextOf(payload: ResponsesTextEvent): string {
  return (payload.response?.output ?? [])
    .flatMap((item) => (Array.isArray(item.content) ? item.content : []))
    .map((part) => typeof part.text === 'string' ? part.text : '')
    .join('')
}

/** Collect the assistant text from a Responses-API reply (streamed or JSON). */
async function collectResponsesText(response: Response): Promise<string> {
  const contentType = response.headers.get('content-type') ?? ''
  if (!contentType.includes('text/event-stream')) {
    const payload = await response.json() as ResponsesTextEvent
    return responsesTextOf(payload).trim()
  }
  if (response.body === null) throw new Error('sub2api: API returned no response body')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let text = ''
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
          let event: ResponsesTextEvent
          try {
            event = JSON.parse(line) as ResponsesTextEvent
          } catch {
            continue
          }
          if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') {
            text += event.delta
          } else if (event.type === 'response.completed') {
            const full = responsesTextOf(event).trim()
            if (full.length > 0) return full
          }
        }
      }
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // lock already released
    }
  }
  return text.trim()
}

interface MessagesTextEvent {
  type?: string
  delta?: { type?: string; text?: unknown }
}

/** Collect the assistant text from an Anthropic Messages-API reply (streamed or JSON). */
async function collectMessagesText(response: Response): Promise<string> {
  const contentType = response.headers.get('content-type') ?? ''
  if (!contentType.includes('text/event-stream')) {
    const payload = await response.json() as { content?: Array<{ text?: string }> }
    return (Array.isArray(payload.content) ? payload.content : [])
      .map((part) => typeof part.text === 'string' ? part.text : '')
      .join('')
      .trim()
  }
  if (response.body === null) throw new Error('sub2api: API returned no response body')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let text = ''
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
          let event: MessagesTextEvent
          try {
            event = JSON.parse(line) as MessagesTextEvent
          } catch {
            continue
          }
          if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta' && typeof event.delta.text === 'string') {
            text += event.delta.text
          } else if (event.type === 'message_stop') {
            return text.trim()
          }
        }
      }
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // lock already released
    }
  }
  return text.trim()
}

/** Collect the vision model's reply text for the provider's wire protocol. */
async function collectVisionText(response: Response, api: ApiProtocol): Promise<string> {
  const text = api === 'openai-responses'
    ? await collectResponsesText(response)
    : api === 'anthropic-messages'
      ? await collectMessagesText(response)
      : await collectChatText(response)
  const trimmed = text.trim()
  if (trimmed.length === 0) throw new Error('sub2api: vision model returned no text')
  return trimmed
}

/**
 * One-shot vision Q&A against the configured `analyze` model. Shared by the
 * analyze_image tool and the Auto Vision chat wrapper, so an image turn in a
 * text-only session describes its attachment through the exact same pipeline
 * (native wire protocol → gateway → configured vision model).
 */
export async function describeViaVisionModel(
  host: ImageToolHost,
  question: string,
  mediaType: ImageMediaType,
  data: Uint8Array,
  signal: AbortSignal | undefined,
): Promise<{ text: string; model: string }> {
  const resolved = resolveToolModel(host.config(), 'analyze')
  const response = await gatewayFetch(
    host,
    resolved,
    visionPath(resolved.api),
    visionBody(resolved, question, mediaType, data),
    signal,
    'text/event-stream',
  )
  const text = await collectVisionText(response, resolved.api)
  return { text, model: `${resolved.route}/${resolved.model}` }
}

/**
 * The gateway endpoint for a vision request, matching the provider group's
 * native wire protocol (responses / messages / chat-completions). Sending the
 * image through the group's native protocol avoids the gateway's
 * chat/completions ↔ native conversion dropping the image payload.
 */
function visionPath(api: ApiProtocol): string {
  if (api === 'openai-responses') return '/responses'
  if (api === 'anthropic-messages') return '/messages'
  return '/chat/completions'
}

/** The vision request body for the provider's wire protocol. */
function visionBody(resolved: ResolvedToolModel, question: string, mediaType: ImageMediaType, data: Uint8Array): Record<string, unknown> {
  if (resolved.api === 'openai-responses') {
    return {
      model: resolved.model,
      input: [{
        role: 'user',
        content: [
          { type: 'input_text', text: question },
          { type: 'input_image', image_url: dataUrl(mediaType, data) },
        ],
      }],
      stream: true,
      stream_options: { include_usage: true },
    }
  }
  if (resolved.api === 'anthropic-messages') {
    return {
      model: resolved.model,
      max_tokens: resolved.maxTokens,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: question },
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: toBase64(data) } },
        ],
      }],
      stream: true,
    }
  }
  return {
    model: resolved.model,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: question },
        { type: 'image_url', image_url: { url: dataUrl(mediaType, data) } },
      ],
    }],
    stream: true,
    stream_options: { include_usage: true },
  }
}

async function loadRemoteImage(url: string, signal: AbortSignal | undefined, maxBytes: number): Promise<{ mediaType: ImageMediaType; data: Uint8Array }> {
  const encoded = decodeDataUrl(url)
  if (encoded !== undefined) return encoded
  let response: Response
  try {
    response = await fetch(url, { method: 'GET', signal, redirect: 'follow' })
  } catch (error) {
    if (signal?.aborted) throw new LlmError('sub2api: request aborted', 'ABORTED', { cause: error })
    throw new Error(`sub2api: failed to download image URL: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!response.ok) throw new Error(`sub2api: image URL returned HTTP ${response.status}`)
  const buffer = new Uint8Array(await response.arrayBuffer())
  if (buffer.byteLength > maxBytes) throw new Error(`sub2api: image URL exceeds ${maxBytes} bytes`)
  const headerType = (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase()
  const mediaType = headerType === 'image/png' || headerType === 'image/jpeg' || headerType === 'image/webp' || headerType === 'image/gif'
    ? headerType
    : mediaTypeFromBytes(buffer)
  return { mediaType, data: buffer }
}

async function readLocalImage(
  ctx: Context,
  exec: { signal: AbortSignal; agent?: { session: { header: { cwd?: string } } } },
  filePath: string,
  maxBytes: number,
): Promise<{ path: string; mediaType: ImageMediaType; data: Uint8Array }> {
  const fs = getFs(ctx)
  if (fs === undefined) throw new Error(`cannot read "${filePath}": filesystem service is not mounted`)
  if (mediaTypeForPath(filePath) === undefined) {
    throw new Error(`cannot read "${filePath}": analyze_image only accepts PNG/JPEG/WebP/GIF paths`)
  }
  const cwd = sessionCwd(exec)
  const target = await fs.resolve(filePath, { ...(cwd !== undefined ? { cwd } : {}), signal: exec.signal })
  const info = await fs.stat(target, exec.signal)
  if (info === undefined) throw new Error(`cannot read "${target.displayPath}": not found`)
  if (info.type !== 'file') throw new Error(`cannot read "${target.displayPath}": not a regular file`)
  const data = await fs.readBytes(target, exec.signal, maxBytes)
  return { path: target.displayPath, mediaType: mediaTypeFromBytes(data), data }
}

function extractGeneratedImage(payload: unknown): { data?: Uint8Array; mediaType?: ImageMediaType; url?: string; revisedPrompt?: string } | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const record = payload as Record<string, unknown>
  const items = Array.isArray(record.data) ? record.data : []
  for (const item of items) {
    if (typeof item !== 'object' || item === null) continue
    const row = item as Record<string, unknown>
    const revised = typeof row.revised_prompt === 'string' ? row.revised_prompt : undefined
    if (typeof row.b64_json === 'string' && row.b64_json.length > 0) {
      const data = Buffer.from(row.b64_json, 'base64')
      return { data, mediaType: mediaTypeFromBytes(data), ...(revised !== undefined ? { revisedPrompt: revised } : {}) }
    }
    if (typeof row.url === 'string' && row.url.length > 0) {
      if (row.url.startsWith('data:')) {
        const decoded = decodeDataUrl(row.url)
        if (decoded !== undefined) return { ...decoded, ...(revised !== undefined ? { revisedPrompt: revised } : {}) }
      }
      return { url: row.url, ...(revised !== undefined ? { revisedPrompt: revised } : {}) }
    }
  }
  return undefined
}

function extractImageFromText(text: string): { kind: 'data'; mediaType: ImageMediaType; data: Uint8Array } | { kind: 'url'; url: string } | undefined {
  const dataMatch = /data:image\/(?:png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=\s]+/i.exec(text)
  if (dataMatch !== null) {
    const decoded = decodeDataUrl(dataMatch[0]!)
    if (decoded !== undefined) return { kind: 'data', ...decoded }
  }
  const urlMatch = /https?:\/\/\S+\.(?:png|jpe?g|webp|gif)(?:\?\S*)?/i.exec(text)
  if (urlMatch !== null) return { kind: 'url', url: urlMatch[0]!.replace(/[),.;]+$/, '') }
  const markdown = /!\[[^\]]*]\((https?:\/\/[^)\s]+)\)/i.exec(text)
  if (markdown !== null) return { kind: 'url', url: markdown[1]! }
  return undefined
}

function defaultOutputName(mediaType: ImageMediaType): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '-').slice(0, 19)
  return `generated-${stamp}${extensionForMediaType(mediaType)}`
}

async function writeGeneratedFile(
  ctx: Context,
  exec: { signal: AbortSignal; agent?: { session: { header: { cwd?: string } } } },
  requestedPath: string | undefined,
  data: Uint8Array,
  mediaType: ImageMediaType,
): Promise<string> {
  const fs = getFs(ctx)
  if (fs === undefined) throw new Error('cannot write generated image: filesystem service is not mounted')
  const cwd = sessionCwd(exec)
  const rawPath = requestedPath !== undefined && requestedPath.trim().length > 0
    ? requestedPath.trim()
    : defaultOutputName(mediaType)
  const withExt = extname(rawPath).length === 0 ? `${rawPath}${extensionForMediaType(mediaType)}` : rawPath
  const target = await fs.resolve(withExt, { ...(cwd !== undefined ? { cwd } : {}), signal: exec.signal })
  if (cwd !== undefined) {
    const root = await fs.resolve('.', { cwd, signal: exec.signal })
    if (!fs.contains(root, target)) {
      throw new Error(`generate_image can only write inside the session workspace; refused "${target.displayPath}"`)
    }
  }
  const abs = fs.processPath(target)
  await mkdir(dirname(abs), { recursive: true })
  await writeFile(abs, data)
  return target.displayPath
}

async function generateViaImagesApi(
  host: ImageToolHost,
  resolved: ResolvedToolModel,
  args: { prompt: string; size?: string; quality?: string },
  signal: AbortSignal | undefined,
  maxBytes: number,
): Promise<{ data: Uint8Array; mediaType: ImageMediaType; revisedPrompt?: string }> {
  const response = await gatewayFetch(host, resolved, '/images/generations', {
    model: resolved.model,
    prompt: args.prompt,
    n: 1,
    response_format: 'b64_json',
    ...(args.size !== undefined && args.size !== 'auto' ? { size: args.size } : {}),
    ...(args.quality !== undefined && args.quality !== 'auto' ? { quality: args.quality } : {}),
  }, signal, 'application/json')
  const payload: unknown = await response.json()
  const image = extractGeneratedImage(payload)
  if (image === undefined) throw new Error('sub2api: image API returned no image data')
  if (image.data !== undefined && image.mediaType !== undefined) {
    return { data: image.data, mediaType: image.mediaType, ...(image.revisedPrompt !== undefined ? { revisedPrompt: image.revisedPrompt } : {}) }
  }
  if (image.url !== undefined) {
    const downloaded = await loadRemoteImage(image.url, signal, maxBytes)
    return { ...downloaded, ...(image.revisedPrompt !== undefined ? { revisedPrompt: image.revisedPrompt } : {}) }
  }
  throw new Error('sub2api: image API returned no image data')
}

async function generateViaChat(
  host: ImageToolHost,
  resolved: ResolvedToolModel,
  prompt: string,
  signal: AbortSignal | undefined,
  maxBytes: number,
): Promise<{ data: Uint8Array; mediaType: ImageMediaType; revisedPrompt?: string }> {
  const response = await gatewayFetch(host, resolved, '/chat/completions', {
    model: resolved.model,
    messages: [{
      role: 'user',
      content: `Generate an image for this prompt and return the image itself (as a data URL or a direct image URL), not a description:\n\n${prompt}`,
    }],
    stream: true,
    stream_options: { include_usage: true },
  }, signal, 'text/event-stream')
  const text = await collectChatText(response)
  const extracted = extractImageFromText(text)
  if (extracted === undefined) {
    throw new Error(`sub2api: chat image model did not return image data. Response preview: ${text.slice(0, 240)}`)
  }
  if (extracted.kind === 'data') return { data: extracted.data, mediaType: extracted.mediaType }
  return await loadRemoteImage(extracted.url, signal, maxBytes)
}

export function registerImageTools(ctx: Context, host: ImageToolHost): void {
  ctx.inject(['tools', 'systemPrompt'], (toolCtx) => {
    toolCtx.systemPrompt.section({
      name: 'tool:analyze_image',
      order: 118,
      text: 'Use the analyze_image tool to inspect a local image file or image URL with the configured vision model. Call it whenever the current chat model cannot see images, or when you need a dedicated vision model. Do not assume you can see an attached or on-disk image yourself.',
    })
    toolCtx.systemPrompt.section({
      name: 'tool:generate_image',
      order: 119,
      text: 'Use the generate_image tool to create an image with the configured image model and write it to the workspace. Call it when the current chat model cannot generate images. The tool returns the saved file path, not the image bytes.',
    })

    toolCtx.tools.register(defineTool({
      name: ANALYZE_IMAGE_NAME,
      description: 'Describe or answer questions about a local image file or image URL by calling the configured vision model. Use this when the current chat model cannot see images.',
      parameters: {
        file_path: {
          type: 'string',
          description: 'Path to a PNG/JPEG/WebP/GIF file. Provide this or image_url.',
        },
        image_url: {
          type: 'string',
          description: 'http(s) or data: URL of an image. Used when file_path is omitted.',
        },
        question: {
          type: 'string',
          description: 'What to look for. Defaults to a thorough visual description.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            source: { type: 'string', required: true },
            model: { type: 'string', required: true },
            text: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: value.text }],
      },
      timeoutMs: DEFAULT_IMAGE_TOOL_TIMEOUT_MS,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const filePath = args.file_path?.trim() ?? ''
        const imageUrl = args.image_url?.trim() ?? ''
        if (filePath.length === 0 && imageUrl.length === 0) {
          throw new Error('analyze_image requires file_path or image_url')
        }
        const question = args.question?.trim().length ? args.question.trim() : 'Describe this image thoroughly: subject, scene, text, layout, colors, and any notable details.'
        const resolved = resolveToolModel(host.config(), 'analyze')
        const maxBytes = ctx.get('attachments')?.imageLimits.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES
        let source: string
        let mediaType: ImageMediaType
        let data: Uint8Array
        if (filePath.length > 0) {
          const local = await readLocalImage(ctx, exec, filePath, maxBytes)
          source = local.path
          mediaType = local.mediaType
          data = local.data
        } else {
          const remote = await loadRemoteImage(imageUrl, exec.signal, maxBytes)
          source = imageUrl.startsWith('data:') ? 'data-url' : imageUrl
          mediaType = remote.mediaType
          data = remote.data
        }
        const response = await gatewayFetch(host, resolved, visionPath(resolved.api), visionBody(resolved, question, mediaType, data), exec.signal, 'text/event-stream')
        const text = await collectVisionText(response, resolved.api)
        return { source, model: `${resolved.route}/${resolved.model}`, text }
      },
      presentCall(args) {
        return {
          card: 'generic',
          title: `Analyze image ${args.file_path ?? args.image_url ?? ''}`,
          kind: 'read',
          ...(args.file_path !== undefined ? { locations: [{ path: args.file_path }] } : {}),
        }
      },
    }))

    toolCtx.tools.register(defineTool({
      name: GENERATE_IMAGE_NAME,
      description: 'Generate an image with the configured image model and write it to the workspace. Use this when the current chat model cannot generate images. Returns the saved file path.',
      parameters: {
        prompt: {
          type: 'string',
          required: true,
          description: 'Image generation prompt.',
        },
        file_path: {
          type: 'string',
          description: 'Workspace path to write. Defaults to generated-<timestamp>.png in the session cwd.',
        },
        size: {
          type: 'string',
          enum: [...GENERATE_SIZES],
          description: 'Requested size when the image API supports it.',
        },
        quality: {
          type: 'string',
          enum: [...GENERATE_QUALITIES],
          description: 'Requested quality when the image API supports it.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            path: { type: 'string', required: true },
            model: { type: 'string', required: true },
            mediaType: { type: 'string', required: true },
            bytes: { type: 'integer', required: true },
            revisedPrompt: { type: 'string' },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: [
            `<path>${value.path}</path>`,
            '<type>image</type>',
            '<content>',
            `${value.mediaType}, ${value.bytes} bytes, model ${value.model}`,
            value.revisedPrompt !== undefined ? `revised prompt: ${value.revisedPrompt}` : '',
            '</content>',
          ].filter((line) => line.length > 0).join('\n'),
        }],
      },
      timeoutMs: DEFAULT_IMAGE_TOOL_TIMEOUT_MS,
      async execute(args, exec) {
        const prompt = args.prompt.trim()
        if (prompt.length === 0) throw new Error('prompt must be a non-empty string')
        const resolved = resolveToolModel(host.config(), 'generate')
        const maxBytes = ctx.get('attachments')?.imageLimits.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES
        let image: { data: Uint8Array; mediaType: ImageMediaType; revisedPrompt?: string }
        try {
          image = await generateViaImagesApi(host, resolved, {
            prompt,
            ...(args.size !== undefined ? { size: args.size } : {}),
            ...(args.quality !== undefined ? { quality: args.quality } : {}),
          }, exec.signal, maxBytes)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          if (!/HTTP 404|HTTP 405|HTTP 501|not found|unknown endpoint|does not exist|not implemented/i.test(message)) throw error
          image = await generateViaChat(host, resolved, prompt, exec.signal, maxBytes)
        }
        const path = await writeGeneratedFile(ctx, exec, args.file_path, image.data, image.mediaType)
        return {
          path,
          model: `${resolved.route}/${resolved.model}`,
          mediaType: image.mediaType,
          bytes: image.data.byteLength,
          ...(image.revisedPrompt !== undefined ? { revisedPrompt: image.revisedPrompt } : {}),
        }
      },
      presentCall(args) {
        return {
          card: 'generic',
          title: `Generate image${args.file_path !== undefined ? ` ${args.file_path}` : ''}`,
          ...(args.file_path !== undefined ? { locations: [{ path: args.file_path }] } : {}),
        }
      },
    }))
  })
}
