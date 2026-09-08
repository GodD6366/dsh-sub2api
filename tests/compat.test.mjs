import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import SettingsProvider from '@deepseek-ai/dsh-settings'
import { Config as PiConfig } from '@deepseek-ai/dsh-llm-pi-ai'
import { Config, translateToPiAi, syncPiAiProfiles, Sub2ApiVisionAdapter } from '../lib/index.js'

const config = () => Config({
  baseURL: 'https://gateway.test/v1',
  providers: Object.fromEntries(['openai', 'claude', 'grok', 'gemini'].map(key => [key, {
    apiKeyEnv: `TEST_${key.toUpperCase()}`,
    models: [{ id: `${key}-test`, reasoningEfforts: ['none', 'high', 'max'] }],
  }])),
})

test('all gateway routes satisfy the current pi-ai schema', () => {
  const { providers } = PiConfig({ providers: translateToPiAi(config()) })
  assert.equal(Object.keys(providers).length, 4)
  assert.equal(providers['sub2api-claude'].baseURL, 'https://gateway.test')
  assert.equal(providers['sub2api-claude'].api, 'anthropic-messages')
  assert.equal(providers['sub2api-openai'].baseURL, 'https://gateway.test/v1')
  assert.equal(providers['sub2api-openai'].api, 'openai-responses')
  assert.equal(providers['sub2api-gemini'].api, 'openai-completions')
  assert.deepEqual(providers['sub2api-openai'].models[0].reasoningEfforts, {off: 'none', high: 'high', max: 'max'})
})

test('new settings service installs, hot-updates and removes bridged profiles', async () => {
  class MemorySettings extends SettingsProvider {
    writable = true
    async load() { return {} }
    async persist() {}
  }
  const ctx = new Context()
  const service = ctx.plugin(MemorySettings)
  await service.await()
  let current = config
  let sync = Promise.resolve()
  const consumer = ctx.plugin({
    inject: ['settings'],
    apply(owner) {
      owner.settings.register('llm-pi-ai', PiConfig, {base: {providers: {}}})
      owner.settings.installSection(owner, 'llm-sub2api', Config, config(), {
        setSource(source) { current = source },
        onChange() { sync = syncPiAiProfiles(owner, current()) },
      })
    },
  })
  try {
    await consumer.await()
    await sync
    assert.equal(Object.keys(ctx.settings.get('llm-pi-ai').providers).length, 4)
    const unrelated = {api: 'openai-completions', baseURL: 'https://other.test/v1', models: [{id: 'other'}]}
    await ctx.settings.update('llm-pi-ai', {providers: {external: unrelated}})
    await ctx.settings.update('llm-sub2api', {baseURL: ''})
    await new Promise(resolve => setImmediate(resolve))
    await sync
    assert.deepEqual(Object.keys(ctx.settings.get('llm-pi-ai').providers), ['external'])
    await ctx.settings.update('llm-sub2api', {baseURL: 'https://new.test'})
    await new Promise(resolve => setImmediate(resolve))
    await sync
    assert.equal(ctx.settings.get('llm-pi-ai').providers['sub2api-openai'].baseURL, 'https://new.test/v1')
  } finally {
    await consumer.dispose()
    await service.dispose()
  }
})

test('vision twins preserve text forwarding and strip provider-native replay', async () => {
  let forwarded
  const adapter = new Sub2ApiVisionAdapter({
    config,
    resolveApiKey: async () => 'test',
    resolveAttachments: () => undefined,
    nameOf: route => route,
    resolveBase: () => ({
      listModels: async () => [{id: 'text-model', inputModalities: ['text']}, {id: 'native', inputModalities: ['text', 'image']}],
      async *stream(options) { forwarded = options; yield {type: 'text-delta', text: 'ok'} },
    }),
  })
  assert.deepEqual((await adapter.listModels('base-vision')).map(m => m.id), ['text-model-vision'])
  const message = {role: 'assistant', content: [{type: 'text', text: 'history'}], source: {kind: 'model', provider: 'base-vision', model: 'text-model-vision', replayState: {opaque: true}}}
  for await (const chunk of adapter.stream({provider: 'base-vision', model: 'text-model-vision', messages: [message]})) assert.equal(chunk.text, 'ok')
  assert.equal(forwarded.provider, 'base')
  assert.equal(forwarded.model, 'text-model')
  assert.equal(forwarded.messages[0].source.replayState, undefined)
  assert.ok(message.source.replayState)
})

test('browser bundle registers settings and renders running/settled image tools', () => {
  const require = createRequire(import.meta.url)
  let plugin
  vm.runInNewContext(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), {
    window: {__ModuleLoader__: {load({factory}) { plugin = factory(require) }}},
    btoa,
  })
  const entries = []
  plugin.apply({slots: {inject(_name, callback) { callback() }, register(options, component) { entries.push({options, component}) }}})
  assert.equal(entries[0].options.name, 'settings.section')
  const view = entries.find(entry => entry.options.key === 'generate_image').component
  assert.match(JSON.stringify(view({block: {name: 'generate_image'}})), /生成图片/)
  const result = view({block: {kind: 'tool-result', content: [{type: 'text', text: 'saved'}, {type: 'image', attachment: {attachmentId: 'test', mediaType: 'image/png'}}]}})
  assert.match(JSON.stringify(result), /plugins\/dsh-sub2api\/attachment/)
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.ok(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-renderer'))
  assert.ok(!manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-runtime'))
})
