/**
 * Inline generated-image preview for the `generate_image` tool card.
 *
 * generate_image embeds an image content block (a durable attachment
 * reference) in its tool result; the stock tool card only renders text and
 * JSON blocks, so this keyed `tool.call.toolview` renders the attachment
 * bytes as an inline `<img>` right inside the chat record. The image is
 * served by the plugin's own `GET /plugins/dsh-sub2api/attachment` route
 * (the request carries the full attachment ref; the store re-verifies the
 * content digest, so only genuine generated images resolve).
 *
 * The `tool.call.toolview` slot is declared by @deepseek-ai/dsh-client-ui-tool;
 * this package does not depend on it at runtime, so the slot is re-declared
 * locally (module augmentation) with the exact owner share the tool UI passes
 * (callId / toolName / block / cwd / openFile / inspect).
 *
 * @module dsh-sub2api/client/toolview
 */

import type { CSSProperties } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ContentBlock, ImageBlock } from '@deepseek-ai/dsh-llm'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'tool.call.toolview': {
      kind: 'keyed'
      scope: 'session'
      owner: {
        callId: string
        toolName: string
        /** Frozen running call or settled result node (the tool-result content blocks). */
        block: { content?: readonly ContentBlock[] }
        cwd?: string
        openFile: (path: string) => void
        inspect?: () => void
      }
    }
  }
}

type GenerateImageToolviewProps = PropsRuntime<'tool.call.toolview'>

const ROOT: CSSProperties = {
  display: 'grid',
  gap: '8px',
  padding: '8px 10px',
}

const IMAGE: CSSProperties = {
  maxWidth: '100%',
  maxHeight: 420,
  objectFit: 'contain',
  borderRadius: 8,
  background: 'var(--dsw-alias-bg-module-platform, #f2f2f2)',
}

const META: CSSProperties = {
  fontSize: 11,
  lineHeight: 1.5,
  color: 'var(--dsw-alias-label-secondary, #6b6b6b)',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
}

/** Attachment-served URL for one image content block. */
function attachmentUrl(image: ImageBlock): string {
  const ref = JSON.stringify(image.attachment)
  return `/plugins/dsh-sub2api/attachment?ref=${encodeURIComponent(btoa(ref))}`
}

export function GenerateImageToolview(props: GenerateImageToolviewProps): JSX.Element {
  const { block } = props
  const content = Array.isArray(block?.content) ? block.content : []
  const image = content.find((b) => b.type === 'image' && b.attachment !== undefined) as ImageBlock | undefined
  const text = content.find((b) => b.type === 'text' && typeof b.text === 'string')

  if (image === undefined && text === undefined) {
    return (
      <div style={{ ...META, padding: '8px 10px' }}>生成图片…</div>
    )
  }

  return (
    <div style={ROOT}>
      {image !== undefined && (
        <img
          src={attachmentUrl(image)}
          alt={image.attachment.name ?? 'generated image'}
          style={IMAGE}
        />
      )}
      {text !== undefined && <div style={META}>{text.text}</div>}
    </div>
  )
}
