/**
 * Browser half of dsh-sub2api: registers the settings section.
 *
 * @module dsh-sub2api/client
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { Sub2ApiSettings } from './settings.tsx'
import { GenerateImageToolview } from './toolview.tsx'

export const name = 'dsh-sub2api-client'
export const inject = ['slots']

export function apply(ctx: ClientContext): void {
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'sub2api-models',
    order: 12,
    label: () => 'Sub2API 模型',
  }, Sub2ApiSettings))

  // Render generate_image results as an inline image inside the tool card:
  // the tool result already carries an image content block (durable
  // attachment), and this keyed toolview turns those bytes into an <img>.
  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
    name: 'tool.call.toolview',
    key: 'generate_image',
  }, GenerateImageToolview))
}
