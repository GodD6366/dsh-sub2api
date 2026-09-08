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
 * The tool UI owns the slot contract; import its public props so upstream
 * changes are checked at build time.
 *
 * @module dsh-sub2api/client/toolview
 */

import type { CSSProperties } from 'react'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import type { ImageBlock } from '@deepseek-ai/dsh-llm'

type GenerateImageToolviewProps = ToolCallViewProps

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
  const content = 'content' in block ? block.content : []
  const image = content.find((b) => b.type === 'image' && b.attachment !== undefined) as ImageBlock | undefined
  const text = content.find((b) => b.type === 'text')

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
