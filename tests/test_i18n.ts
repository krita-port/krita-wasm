import assert from 'node:assert/strict'
import { applyChoice, languageTag, matchLanguage, preferenceKey, readChoice, resolveLanguages, textFor } from '../web/i18n.ts'

const available = [
  'en_GB',
  'zh_CN',
  'zh_TW',
  'fr',
  'pt',
  'pt_BR',
  'ar',
  'uz',
  'uz@cyrillic',
  'ca',
  'ca@valencia',
]
for (const [requested, expected] of [
  ['zh-CN', 'zh_CN'],
  ['zh-SG', 'zh_CN'],
  ['zh-Hans-TW', 'zh_CN'],
  ['zh-TW', 'zh_TW'],
  ['zh-Hant', 'zh_TW'],
  ['zh-HK', 'zh_TW'],
  ['pt-BR', 'pt_BR'],
  ['pt-PT', 'pt'],
  ['fr-CA', 'fr'],
  ['uz-Cyrl-UZ', 'uz@cyrillic'],
  ['ca-valencia', 'ca@valencia'],
  ['en-AU', 'en'],
  ['en-GB', 'en_GB'],
  ['../../zh_CN', null],
  ['invalid!!!', null],
] as const) assert.equal(matchLanguage(requested, ['en', ...available]), expected, requested)
assert.equal(languageTag('uz@cyrillic'), 'uz-Cyrl')
assert.equal(languageTag('ca@valencia'), 'ca-valencia')
assert.deepEqual(resolveLanguages(null, ['xx-ZZ', 'pt-BR', 'fr-CA'], available), ['pt_BR', 'pt', 'fr', 'en'])
assert.deepEqual(resolveLanguages(['fr'], ['zh-CN'], available), ['fr', 'en'])
assert.deepEqual(resolveLanguages(['xx'], ['zh-CN'], available), ['en'])
assert.deepEqual(resolveLanguages(null, ['en-US', 'zh-CN'], available), ['en'])
assert.deepEqual(resolveLanguages(null, ['en-GB', 'fr'], available), ['en_GB', 'en'])
assert.deepEqual(resolveLanguages(['zh-Hant', 'zh-HK'], [], available), ['zh_TW', 'en'])
const map = new Map<string, string>()
const storage = {
  getItem: (key: string) => map.get(key) ?? null,
  setItem: (key: string, value: string) => map.set(key, value),
  removeItem: (key: string) => map.delete(key),
}
let reloaded = 0
const options = {
  storage,
  warning: 'Unsaved work will be lost',
  confirm: () => false,
  reload: (_next: string[] | null) => reloaded++,
}
assert.equal(applyChoice(['fr'], options), false)
assert.equal(reloaded, 0)
assert.equal(readChoice(storage), null)
options.confirm = () => true
assert.equal(applyChoice(['fr'], options), true)
assert.equal(reloaded, 1)
assert.deepEqual(readChoice(storage), ['fr'])
applyChoice(null, options)
assert.equal(readChoice(storage), null)
map.set(preferenceKey, '{bad JSON')
assert.equal(readChoice(storage), null)
map.set(preferenceKey, '["../x"]')
assert.equal(readChoice(storage), null)
assert.equal(readChoice({
  getItem() {
    throw new Error('unavailable')
  },
}), null)
const unavailable = {
  setItem() {
    throw new Error('unavailable')
  },
  removeItem() {
    throw new Error('unavailable')
  },
}
let urlChoice: string[] | null | undefined
applyChoice(['zh_CN'], {
  ...options,
  storage: unavailable,
  reload: value => urlChoice = value,
})
assert.deepEqual(urlChoice, ['zh_CN'])
applyChoice(null, {
  ...options,
  storage: unavailable,
  reload: value => urlChoice = value,
})
assert.equal(urlChoice, null)
const messages = {
  messages: {
    zh_CN: { loading: '加载资源' },
    fr: { error: 'Erreur' },
    en: { loading: 'Loading resources', error: 'Error' },
  },
}
assert.equal(textFor(messages, ['zh_CN', 'en'], 'loading'), '加载资源')
assert.equal(textFor(messages, ['zh_CN', 'fr', 'en'], 'error'), 'Erreur')
assert.equal(textFor(messages, ['zh_CN', 'en'], 'error'), 'Error')
