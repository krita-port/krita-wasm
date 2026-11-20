import type { LanguageIndex } from './runtime.js'

type ReadStorage = Pick<Storage, 'getItem'> | undefined
type WriteStorage = Partial<Pick<Storage, 'setItem' | 'removeItem'>> | undefined

export const preferenceKey = 'krita.ui-languages'

export function languageTag(code: unknown): string | null {
  if (typeof code !== 'string')
    return null
  const tag = code.replace(/_/g, '-').replace(/@cyrillic$/i, '-Cyrl').replace(/@latin$/i, '-Latn').replace(/@valencia$/i, '-valencia')
  try {
    return Intl.getCanonicalLocales(tag)[0] || null
  }
  catch {
    return null
  }
}

export function matchLanguage(requested: string, available: string[]): string | null {
  const tag = languageTag(requested)
  if (!tag)
    return null
  const locale = new Intl.Locale(tag)
  const lookup = new Map(available.map(code => [
    languageTag(code)?.toLowerCase(),
    code,
  ]))
  const exact = lookup.get(tag.toLowerCase())
  if (exact)
    return exact
  if (locale.language === 'zh') {
    const traditional = locale.script
      ? locale.script === 'Hant'
      : ['TW', 'HK', 'MO'].includes(locale.region || '')
    return available.includes(traditional ? 'zh_TW' : 'zh_CN')
      ? (traditional ? 'zh_TW' : 'zh_CN')
      : null
  }
  if (locale.script) {
    const scripted = lookup.get(`${locale.language}-${locale.script}`.toLowerCase())
    if (scripted)
      return scripted
  }
  return lookup.get(locale.language) || null
}

export function resolveLanguages(choice: string[] | null, browserLanguages: readonly string[], available: string[]): string[] {
  const supported = [
    ...new Set(['en', ...available]),
  ]
  const requested = choice?.length ? choice : browserLanguages
  const result: string[] = []
  for (const language of requested || []) {
    const matched = matchLanguage(language, supported)
    if (!matched)
      continue
    if (!result.includes(matched))
      result.push(matched)
    if (matched === 'en')
      break
    // Region-specific catalogs fall back to their base language before the
    // next browser preference. Modifiers keep their exact catalog first.
    const base = languageTag(matched)?.split('-')[0]
    if (base && supported.includes(base) && !result.includes(base))
      result.push(base)
    if (base === 'en')
      break
  }
  if (!result.includes('en'))
    result.push('en')
  return result
}

export function readChoice(storage: ReadStorage): string[] | null {
  try {
    const value = JSON.parse(storage?.getItem(preferenceKey) || 'null')
    return Array.isArray(value) && value.length && value.every(code => languageTag(code))
      ? value
      : null
  }
  catch {
    return null
  }
}

export function applyChoice(choice: string[] | null, { storage, confirm, reload, warning }: { storage: WriteStorage, confirm: (warning: string) => boolean, reload: (choice: string[] | null) => void, warning: string }) {
  if (!confirm(warning))
    return false
  try {
    if (choice?.length)
      storage?.setItem?.(preferenceKey, JSON.stringify(choice))
    else storage?.removeItem?.(preferenceKey)
  }
  catch {
    // A URL override also works when persistent storage is unavailable.
  }
  reload(choice?.length ? choice : null)
  return true
}

export function textFor(index: Pick<LanguageIndex, 'messages'>, languages: string[], key: string) {
  for (const language of languages) {
    const text = index.messages[language]?.[key]
    if (text)
      return text
  }
  return index.messages.en[key] || key
}
