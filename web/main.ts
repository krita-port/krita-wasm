import type { Bundle } from './bundle.js'
import type { LanguageIndex } from './runtime.js'
import { prepareRecovery } from './autosave.js'
import { loadBundleResources, loadRuntimeScript, prepareBundle } from './bundle.js'
import { installFileDialog } from './file-upload.ts'
import { applyChoice, languageTag, readChoice, resolveLanguages, textFor } from './i18n.js'
import { ensureIsolation } from './isolation.js'
import { installSaveShortcutGuard } from './save-shortcut.js'
import { installAppearance, installCornerSettings, installSettings, installWidgetStyleSettings, widgetStyleKey } from './settings.js'

const status = document.querySelector<HTMLElement>('#status')!
const testing = new URLSearchParams(location.search).has('test')
let index: LanguageIndex = {
  languages: [],
  messages: {
    en: {
      preparing: 'Preparing Krita…',
      loading: 'Loading resources…',
      starting: 'Starting Krita…',
      error: 'Error',
      details: 'Details',
    },
  },
}
let languages = ['en']
const t = (key: string) => textFor(index, languages, key)
let storage: Storage | undefined
try {
  storage = window.localStorage
}
catch { /* Private browsing can disable storage. */ }
const appearance = installAppearance(document.querySelector<HTMLSelectElement>('#appearance')!, storage)
const corners = installCornerSettings(document.querySelector<HTMLInputElement>('#window-radius')!, document.querySelector<HTMLInputElement>('#control-radius')!, storage)
let failureReported = false
let bundle: Bundle | undefined
let runtimeReady = false
let finishStartup: (visible: boolean) => void
const nativeWindowReady = new Promise<boolean>((resolve) => {
  finishStartup = resolve
  window.addEventListener('krita-ready', () => resolve(true), { once: true })
})
function reportFailure(error: unknown) {
  const stack = error && typeof error === 'object' && 'stack' in error
    ? error.stack
    : undefined
  const details = stack
    ? `${String(error)}\n${stack}`
    : String(error)
  console.error(details)
  if (!failureReported) {
    status.hidden = false
    status.textContent = `${t('error')}: ${String(error)}`
    document.querySelector<HTMLElement>('#failure-stack')!.textContent = details
    document.querySelector<HTMLElement>('#failure')!.hidden = false
    // Keep the original Wasm stack when onExit later reports a generic abort.
    failureReported = true
    finishStartup(false)
    if (!runtimeReady) {
      globalThis.kritaRecovery?.cancelStartup()
      void bundle?.cancel().catch(cleanupError => console.warn('Failed runtime cleanup', cleanupError))
    }
  }
  if (testing) {
    fetch(`/__probe_result?status=${encodeURIComponent(`FAIL: ${details}`)}`)
      .catch(transportError => console.warn('Result transport failed', transportError))
  }
}
function logMessage(message: unknown) {
  console.log(String(message))
  if (testing) {
    fetch(`/__probe_log?message=${encodeURIComponent(String(message))}`)
      .catch(error => console.warn('Diagnostic transport failed', error))
  }
}
window.addEventListener('krita-startup-failed', event => reportFailure(new Error(String((event as CustomEvent<string>).detail))))
window.addEventListener('error', event => reportFailure(event.error || event.message))
window.addEventListener('unhandledrejection', event => reportFailure(event.reason))
if (testing) {
  globalThis.kritaStartupWarnings = []
  for (const name of ['warn', 'error'] as const) {
    const original = console[name].bind(console)
    console[name] = (...args: unknown[]) => {
      const message = args.map(String).join(' ')
      globalThis.kritaStartupWarnings.push(message)
      original(...args)
    }
  }
  const traceAsync = <T extends typeof fetch | typeof createImageBitmap>(original: T, name: 'fetch' | 'createImageBitmap'): T => {
    const traced = (...args: unknown[]) => {
      const input = args[0]
      const subject = input instanceof Request
        ? input.url
        : input instanceof HTMLImageElement
          ? input.src
          : String(input)
      const trace = new Error(`${name}(${subject.slice(0, 400)})`)
      return (Reflect.apply(original, globalThis, args) as Promise<unknown>).catch((error: unknown) => {
        trace.message += ` failed: ${String(error)}`
        throw trace
      })
    }
    return traced as T
  }
  globalThis.fetch = traceAsync(globalThis.fetch, 'fetch')
  if (typeof globalThis.createImageBitmap === 'function')
    globalThis.createImageBitmap = traceAsync(globalThis.createImageBitmap, 'createImageBitmap')
}
try {
  const launcherResponse = await fetch(new URL('i18n.json', location.href))
  if (!launcherResponse.ok)
    throw new Error(`Language index: HTTP ${launcherResponse.status}`)
  index = await launcherResponse.json()
  const query = new URLSearchParams(location.search).get('lang')
  const choice = query === 'auto'
    ? null
    : query
      ? query.split(':')
      : readChoice(storage)
  languages = resolveLanguages(choice, navigator.languages, index.languages)
  document.documentElement.lang = languageTag(languages[0])!
  document.documentElement.dir = ['ar', 'fa', 'he', 'ur', 'ug'].includes(languages[0].split('_')[0])
    ? 'rtl'
    : 'ltr'
  status.textContent = t('preparing')
  document.querySelector<HTMLElement>('#failure summary')!.textContent = t('details')
  await ensureIsolation()
  if (typeof WebAssembly.Suspending !== 'function' || typeof WebAssembly.promising !== 'function')
    throw new TypeError(t('jspiUnavailable'))
  const selectedBundle = await prepareBundle(status, t)
  bundle = selectedBundle
  const response = await fetch(new URL('i18n.json', selectedBundle.base))
  if (!response.ok)
    throw new Error(`Language index: HTTP ${response.status}`)
  // The page owns its UI messages; the selected runtime owns its locale list.
  index.languages = (await response.json()).languages
  languages = resolveLanguages(choice, navigator.languages, index.languages)
  document.documentElement.lang = languageTag(languages[0])!
  document.documentElement.dir = ['ar', 'fa', 'he', 'ur', 'ug'].includes(languages[0].split('_')[0])
    ? 'rtl'
    : 'ltr'
  document.querySelector<HTMLElement>('#failure summary')!.textContent = t('details')
  document.querySelector<HTMLElement>('#language-label')!.textContent = t('language')
  document.querySelector<HTMLElement>('#widget-style-label')!.textContent = t('widgetStyle')
  document.querySelector<HTMLElement>('#appearance-label')!.textContent = t('appearance')
  document.querySelector<HTMLElement>('#window-radius-label')!.textContent = t('windowCorners')
  document.querySelector<HTMLElement>('#control-radius-label')!.textContent = t('controlCorners')
  for (const option of document.querySelector<HTMLSelectElement>('#appearance')!.options) {
    option.textContent = t(option.value === 'auto'
      ? 'followBrowser'
      : option.value)
  }
  let widgetStyle
  try {
    widgetStyle = storage?.getItem(widgetStyleKey)
  }
  catch { /* Use Krita's default style. */ }
  // Pass only a style key to Qt's startup style selection.
  if (!/^[\w-]{1,64}$/.test(widgetStyle || ''))
    widgetStyle = null
  const select = document.querySelector<HTMLSelectElement>('#language')!
  const apply = document.querySelector<HTMLButtonElement>('#apply-language')!
  apply.textContent = t('apply')
  select.add(new Option(t('automatic'), 'auto'))
  for (const language of index.languages) {
    const tag = languageTag(language)!
    let name: string | undefined = tag
    try {
      name = new Intl.DisplayNames([tag], { type: 'language' }).of(tag)
    }
    catch { /* Use the language tag. */ }
    select.add(new Option(`${name} (${tag})`, language))
  }
  const initialSelection = choice?.length ? languages[0] : 'auto'
  select.value = initialSelection
  select.addEventListener('change', () => {
    apply.disabled = select.value === initialSelection
  })
  const changeLanguage = (selected: string[] | null) => applyChoice(selected, {
    storage,
    warning: t('changeWarning'),
    // eslint-disable-next-line no-alert -- Keep the native unsaved-work confirmation before reloading.
    confirm: message => window.confirm(message),
    reload: (next) => {
      const url = new URL(location.href)
      url.searchParams.set('lang', next?.join(':') || 'auto')
      location.assign(url.href)
    },
  })
  apply.addEventListener('click', () => changeLanguage(select.value === 'auto'
    ? null
    : [select.value]))
  window.addEventListener('krita-language-change', event => changeLanguage(event.detail?.length ? event.detail : null))
  document.querySelector<HTMLElement>('#language-bar')!.hidden = false
  const settings = document.querySelector<HTMLButtonElement>('#settings-toggle')!
  const settingsText = t('settings')
  const closeText = t('close')
  settings.title = settingsText
  settings.setAttribute('aria-label', settingsText)
  document.querySelector<HTMLElement>('#settings-title')!.textContent = settingsText
  const closeSettings = document.querySelector<HTMLButtonElement>('#settings-close')!
  closeSettings.title = closeText
  closeSettings.setAttribute('aria-label', closeText)
  settings.hidden = false
  installSettings(settings, document.querySelector<HTMLDialogElement>('#page-settings')!, closeSettings, storage)
  status.textContent = t('loading')
  const runtimeResponse = await fetch(new URL('runtime.json', selectedBundle.base))
  if (!runtimeResponse.ok)
    throw new Error(`Runtime configuration: HTTP ${runtimeResponse.status}`)
  const runtime = await runtimeResponse.json()
  if (runtime.jspi && (typeof WebAssembly.Suspending !== 'function' || typeof WebAssembly.promising !== 'function'))
    throw new Error(t('jspiUnavailable'))
  const resources = await loadBundleResources(selectedBundle)
  const recovery = await prepareRecovery({
    startupFailed: reportFailure,
    failed: (message) => {
      const warning = document.querySelector<HTMLElement>('#recovery-error')!
      warning.textContent = message || ''
      warning.hidden = !message
    },
  })
  globalThis.kritaRecovery = recovery
  await loadRuntimeScript(new URL('krita.js', selectedBundle.base))
  await loadRuntimeScript(new URL('qtloader.js', selectedBundle.base))
  if (failureReported)
    throw new Error('Runtime script startup failed.')
  installSaveShortcutGuard(document.querySelector<HTMLElement>('#screen')!)
  const application = await qtLoad({
    print: logMessage,
    printErr: logMessage,
    locateFile: name => new URL(name, selectedBundle.base).href,
    preRun: [
      (instance) => {
        for (const name of [
          '_kritaWasmRelocateRecoveries',
          '_kritaWasmSetWidgetStyle',
          '_kritaWasmSetColorScheme',
          '_kritaWasmSetControlRadius',
        ] as const) {
          if (typeof instance[name] !== 'function')
            throw new TypeError(`Missing native runtime export: ${name}`)
        }
        for (const dir of [
          '/krita/config',
          '/krita/home',
          '/krita/user-data',
          '/krita/cache',
        ])
          instance.FS.mkdirTree(dir)
        instance.FS.writeFile('/krita/config/kritadisplayrc', 'OpenGLRenderer=none\nLogUsage=true\n')
        let config = 'maxNumberOfThreads=2\n'
        // Exercise Krita's real timer with a short interval only in test mode.
        const seconds = Number(new URLSearchParams(location.search).get('autosaveSeconds'))
        if (testing && Number.isInteger(seconds) && seconds >= 1 && seconds <= 60)
          config += `AutoSaveInterval=${seconds}\n`
        config += `[theme]\nTheme=Krita ${appearance.scheme() === 'dark'
          ? 'dark'
          : 'bright'}\n`
        instance.FS.writeFile('/krita/config/kritarc', config)
        for (const file of resources) {
          instance.FS.mkdirTree(file.destination.slice(0, file.destination.lastIndexOf('/')))
          instance.FS.writeFile(file.destination, file.data, { canOwn: true })
        }
        resources.length = 0
        recovery.install(instance)
        installFileDialog(instance, t)
        if (testing) {
          globalThis.kritaTestFS = instance.FS
          globalThis.kritaTestSnapshot = (includePixels = false, swapHistory = false) => {
            instance._kritaWasmTestSnapshot((includePixels ? 1 : 0) | (swapHistory ? 2 : 0))
            return globalThis.kritaWidgetSnapshot
          }
        }
      },
    ],
    qt: {
      entryFunction: globalThis.kritaWasm,
      containerElements: [
        document.querySelector<HTMLElement>('#screen')!,
      ],
      environment: {
        // Native Home shortcuts must browse persistent user files too.
        HOME: recovery.filesDirectory,
        KRITA_WASM_RECOVERY_DIR: recovery.recoveryDirectory,
        KRITA_WASM_FILES_DIR: recovery.filesDirectory,
        XDG_CONFIG_HOME: '/krita/config',
        XDG_DATA_HOME: '/krita/user-data',
        XDG_CACHE_HOME: '/krita/cache',
        XDG_DATA_DIRS: '/krita/share',
        QML_IMPORT_PATH: '/krita/lib/qml',
        QT_QUICK_BACKEND: 'software',
        ...(widgetStyle
          ? { QT_STYLE_OVERRIDE: widgetStyle }
          : {}),
        KRITA_UI_LANGUAGES: languages.join(':'),
        LANGUAGE: languages.join(':'),
        LANG: `${languageTag(languages[0])!.replaceAll('-', '_')}.UTF-8`,
      },
      onLoaded: () => {
        status.textContent = t('starting')
      },
      onExit: (exit) => {
        logMessage(JSON.stringify(exit))
        // qtLoad rethrows the original error with its Wasm stack immediately
        // after this callback. Give that rejection priority over the fallback.
        setTimeout(() => reportFailure(JSON.stringify(exit)), 0)
      },
    },
  })
  installWidgetStyleSettings(document.querySelector<HTMLSelectElement>('#widget-style')!, index => application._kritaWasmSetWidgetStyle(index), storage)
  appearance.connectNative(value => application._kritaWasmSetColorScheme(value))
  corners.connectNative(value => application._kritaWasmSetControlRadius(value))
  if (testing) {
    // Recovery dialogs precede the main window, so their widgets must already
    // be available to the shared browser driver while startup is still pending.
    globalThis.kritaTestSnapshot = (includePixels = false, swapHistory = false) => {
      application._kritaWasmTestSnapshot((includePixels ? 1 : 0) | (swapHistory ? 2 : 0))
      return globalThis.kritaWidgetSnapshot
    }
  }
  if (await nativeWindowReady && !failureReported) {
    await selectedBundle.ready()
    runtimeReady = true
    if (!failureReported)
      status.hidden = true
  }
}
catch (error) {
  reportFailure(error)
}
