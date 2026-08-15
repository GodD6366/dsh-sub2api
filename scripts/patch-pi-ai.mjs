#!/usr/bin/env node
/**
 * Apply the pi-ai multi-turn guard to the dsh-bundled pi-ai install.
 *
 * Usage (after a dsh upgrade may have overwritten the patch):
 *   node scripts/patch-pi-ai.mjs
 *
 * Idempotent: prints the outcome and exits non-zero only on failure.
 */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const { applyPiAiMultiTurnPatch } = await import(join(root, 'lib', 'index.js'))

const result = applyPiAiMultiTurnPatch()
switch (result.kind) {
  case 'patched':
    console.log(`patched: ${result.file}`)
    process.exit(0)
  case 'already':
    console.log(`already patched: ${result.file}`)
    process.exit(0)
  case 'skipped':
    console.error(`skipped: ${result.reason}`)
    process.exit(1)
}
