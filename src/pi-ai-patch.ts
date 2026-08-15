/**
 * Best-effort defense guard for pi-ai's prefix-token estimation.
 *
 * Background: pi-ai's `AssistantMessage.usage` is required in its types and
 * `estimateContextTokens` dereferences `usage.totalTokens` on that contract.
 * The harness path is already safe — `dsh-llm-pi-ai` attaches a zero `Usage`
 * (`emptyPiUsage()`) to every reconstructed assistant message. The guard here
 * only defends against *other* callers that build pi-ai contexts without
 * `usage` (hand-rolled clients, future adapters), which would otherwise die
 * with a bare `Cannot read properties of undefined (reading 'totalTokens')`
 * deep inside estimation.
 *
 * This plugin cannot control the pi-ai version through npm — Node resolves
 * pi-ai from the dsh install, not from this package. So the guard is applied
 * as a precise idempotent edit to the bundled `estimate.js`:
 *
 * ```js
 *   assistant.stopReason !== "error" &&
 *   assistant.usage !== undefined &&
 *   calculateContextTokens(assistant.usage) > 0
 * ```
 *
 * It runs at plugin apply time — before any pi-ai request (pi-ai's API modules
 * are lazy-loaded, so `estimate.js` is only imported on the first stream). A
 * refusal to write (read-only install) only logs a warning; the harness path
 * works without the guard, and an upstream pi-ai guard makes this a no-op.
 *
 * @module dsh-sub2api/pi-ai-patch
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Guard marker; its presence means the patch is already applied. */
const MARKER = 'assistant.usage !== undefined'
/** The exact upstream expression this patch guards. */
const TARGET = 'calculateContextTokens(assistant.usage) > 0'

/** Outcome of one patch attempt. */
export type PiAiPatchResult =
  | { kind: 'patched'; file: string }
  | { kind: 'already'; file: string }
  | { kind: 'skipped'; reason: string }

/** Candidate locations of the pi-ai estimate module inside a dsh install. */
function candidateEstimatePaths(): string[] {
  const roots = new Set<string>()
  const global = spawnSync('npm', ['root', '-g'], { encoding: 'utf8', windowsHide: true })
  if (global.status === 0 && global.stdout.trim().length > 0) roots.add(global.stdout.trim())
  if (process.env.npm_config_prefix !== undefined) {
    roots.add(join(process.env.npm_config_prefix, 'lib', 'node_modules'))
  }
  roots.add(join(homedir(), '.npm-global', 'lib', 'node_modules'))
  const dshHome = process.env.DSH_HOME !== undefined ? process.env.DSH_HOME : join(homedir(), '.dsh')
  const paths: string[] = []
  for (const root of roots) {
    paths.push(join(root, '@deepseek-ai', 'dsh', 'node_modules', '@earendil-works', 'pi-ai', 'dist', 'utils', 'estimate.js'))
    paths.push(join(root, '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-llm-pi-ai', 'node_modules', '@earendil-works', 'pi-ai', 'dist', 'utils', 'estimate.js'))
  }
  // Profile-local installs (dsh web profile) may carry their own copy.
  paths.push(join(dshHome, 'profiles', 'web', 'node_modules', '@deepseek-ai', 'dsh-llm-pi-ai', 'node_modules', '@earendil-works', 'pi-ai', 'dist', 'utils', 'estimate.js'))
  return paths
}

/**
 * Apply the multi-turn guard to the dsh-bundled pi-ai `estimate.js` when it is
 * missing. Idempotent; only a byte-exact edit is ever made.
 */
export function applyPiAiMultiTurnPatch(): PiAiPatchResult {
  const file = candidateEstimatePaths().find((candidate) => existsSync(candidate))
  if (file === undefined) return { kind: 'skipped', reason: 'pi-ai estimate.js not found under the dsh install' }
  let source: string
  try {
    source = readFileSync(file, 'utf8')
  } catch (error) {
    return { kind: 'skipped', reason: `cannot read ${file}: ${String(error)}` }
  }
  if (source.includes(MARKER)) return { kind: 'already', file }
  const index = source.indexOf(TARGET)
  if (index === -1) return { kind: 'skipped', reason: `target pattern not found in ${file} (pi-ai layout changed?)` }
  // Preserve the indentation of the line the target sits on.
  const lineStart = source.lastIndexOf('\n', index) + 1
  const indent = source.slice(lineStart, index).match(/^[ \t]*/)?.[0] ?? ''
  const replacement = `${MARKER} &&\n${indent}${TARGET}`
  const next = source.slice(0, index) + replacement + source.slice(index + TARGET.length)
  try {
    writeFileSync(file, next)
  } catch (error) {
    return { kind: 'skipped', reason: `cannot write ${file}: ${String(error)}` }
  }
  return { kind: 'patched', file }
}
