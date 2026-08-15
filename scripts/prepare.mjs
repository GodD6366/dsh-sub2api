import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
if (!existsSync(join(root, 'src', 'index.ts'))) process.exit(0)
const tsdown = spawnSync('npx', ['tsdown'], { cwd: root, stdio: 'inherit' })
if (tsdown.status !== 0) process.exit(tsdown.status ?? 1)
const wrap = spawnSync(process.execPath, [join(root, 'scripts', 'wrap-client.mjs')], { cwd: root, stdio: 'inherit' })
process.exit(wrap.status ?? 1)
