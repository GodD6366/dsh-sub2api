import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import SettingsProvider from '@deepseek-ai/dsh-settings'
import { Config as PiConfig } from '@deepseek-ai/dsh-llm-pi-ai'
import { Config, translateToPiAi, syncPiAiProfiles } from '../lib/index.js'

const config = () => Config({
  baseURL: 'https://gateway.test/v1',
  providers: Object.fromEntries(['openai', 'claude', 'grok'].map(key => [key, {
    apiKeyEnv: `TEST_${key.toUpperCase()}`,
    models: [{ id: `${key}-test`, reasoningEfforts: ['none', 'high', 'max'] }],
  }])),
})

test('all gateway routes satisfy the current pi-ai schema', () => {
  const { providers } = PiConfig({ providers: translateToPiAi(config()) })
  assert.equal(Object.keys(providers).length, 3)
  assert.equal(providers['sub2api-claude'].baseURL, 'https://gateway.test')
  assert.equal(providers['sub2api-claude'].api, 'anthropic-messages')
  assert.equal(providers['sub2api-openai'].baseURL, 'https://gateway.test/v1')
  assert.equal(providers['sub2api-openai'].api, 'openai-responses')
  assert.equal(providers['sub2api-grok'].api, 'openai-completions')
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
    assert.equal(Object.keys(ctx.settings.get('llm-pi-ai').providers).length, 3)
    const unrelated = {api: 'openai-completions', baseURL: 'https://other.test/v1', models: [{id: 'other'}]}
    await ctx.settings.update('llm-pi-ai', {providers: {external: unrelated, 'sub2api-gemini': unrelated}})
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

test('legacy Gemini and auto-vision settings do not create routes', () => {
  const legacy = Config({...config(), autoVision: true, providers: {...config().providers, gemini: {apiKeyEnv: 'OLD', models: [{id: 'old'}]}}})
  assert.deepEqual(Object.keys(translateToPiAi(legacy)), ['sub2api-openai', 'sub2api-claude', 'sub2api-grok'])
})

test('settings save manual capabilities, preserve edits during metadata fill, and dismiss errors', async () => {
  const { create, act } = await import('react-test-renderer')
  const React = await import('react')
  const require = createRequire(import.meta.url)
  let plugin, saved
  const timers = new Map()
  let timerId = 0
  const fixture = {baseURL: 'https://gateway.test', catalogFormat: 'structured-v1', providers: {openai: {keyConfigured: true, models: [{id: 'test-model', input: ['text'], reasoningEfforts: ['low']}]}}}
  vm.runInNewContext(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), {
    window: {__ModuleLoader__: {load({factory}) { plugin = factory(require) }}, setTimeout(callback) { timers.set(++timerId, callback); return timerId }, clearTimeout(id) {timers.delete(id)}},
    fetch: async (url, init) => ({ok: true, json: async () => {
      if (url.includes('models.dev')) return {openai: {models: {'test-model': {attachment: true, reasoning: true}}}}
      if (init?.method === 'POST') {saved = JSON.parse(init.body); return {ok: true, routes: ['sub2api-openai']}}
      return fixture
    }}), btoa,
  })
  const entries = []
  plugin.apply({slots: {inject(_name, callback) {callback()}, register(options, component) {entries.push({options, component})}}})
  let view
  await act(async () => { view = create(React.createElement(entries[0].component)) })
  try {
    assert.equal(view.root.findAllByProps({className: 's2a_rowTag'}).some(n => n.children.includes('sub2api-gemini')), false)
    await act(async () => {view.root.findAllByProps({className: 's2a_iconBtn s2a_expandBtn'})[0].props.onClick()})
    const field = label => view.root.findByProps({'aria-label': `OpenAI test-model ${label}`})
    await act(async () => {field('图片输入').props.onChange({target: {value: 'text-image'}}); field('思考强度档位').props.onChange({target: {value: 'none, high, max'}})})
    const button = text => view.root.findAllByType('button').find(n => n.children.includes(text))
    await act(async () => {await button('补全数据').props.onClick()})
    await act(async () => {await button('保存配置').props.onClick()})
    assert.deepEqual(saved.providers.openai.models[0].input, ['text', 'image'])
    assert.deepEqual(saved.providers.openai.models[0].reasoningEfforts, ['none', 'high', 'max'])
    assert.deepEqual(Object.keys(saved.providers), ['openai', 'claude', 'grok'])
    await act(async () => {field('思考强度档位').props.onChange({target: {value: 'invalid'}})})
    await act(async () => {await button('保存配置').props.onClick()})
    assert.ok(view.root.findByProps({role: 'status'}))
    assert.match(view.root.findByProps({className: 's2a_status s2a_statusErr'}).children.join(''), /思考强度支持/)
    await act(async () => {view.root.findByProps({'aria-label': '关闭提示'}).props.onClick()})
    assert.equal(view.root.findAllByProps({role: 'status'}).length, 0)
    await act(async () => {field('思考模式').props.onChange({target: {value: 'off'}})})
    await act(async () => {await button('保存配置').props.onClick()})
    assert.deepEqual(saved.providers.openai.models[0].reasoningEfforts, [])
    await act(async () => {for (const callback of timers.values()) callback()})
    assert.equal(view.root.findAllByProps({role: 'status'}).length, 0)
  } finally {await act(async () => view.unmount())}
})
