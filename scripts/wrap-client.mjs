import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const lib = join(root, 'lib')
const { name: pkgName } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
// tsdown emits CommonJS as client.cjs in this ESM package. Prefer that fresh
// build over a client.js left behind by an earlier wrapper run.
const filename = ['client.cjs', 'client.js']
  .map(name => join(lib, name))
  .find(path => {
    try {
      readFileSync(path)
      return true
    } catch {
      return false
    }
  })
if (filename === undefined) throw new Error('tsdown did not emit lib/client.js or lib/client.cjs')
const source = readFileSync(filename, 'utf8')
const out = join(lib, 'client.js')
if (source.includes('window.__ModuleLoader__')) {
  if (filename !== out) writeFileSync(out, source)
  process.exit(0)
}

writeFileSync(out, `window.__ModuleLoader__.load({
	id: "${pkgName}",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
${source}
		return module.exports;
	}
});
`)
