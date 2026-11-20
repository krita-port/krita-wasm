import type { RecoveryState } from './autosave.js'

export interface KritaModule {
  FS: typeof FS
  IDBFS: Emscripten.FileSystemType
  addRunDependency: typeof addRunDependency
  removeRunDependency: typeof removeRunDependency
  _kritaWasmTestSnapshot: (includePixels: number) => void
  _kritaWasmSetWidgetStyle: (index: number) => number
  _kritaWasmSetColorScheme: (value: number) => number
  _kritaWasmSetControlRadius: (value: number) => number
}
export interface Palette {
  dark: boolean
  window: string
  windowText: string
  button: string
  buttonText: string
  border: string
  accent: string
  accentText: string
  link: string
}
export interface LanguageIndex {
  languages: string[]
  messages: Record<string, Record<string, string>>
}
declare global {
  var kritaChooseFile: (directory: string, title: string) => Promise<string | null>
  var kritaRecovery: RecoveryState
  var kritaPalette: Palette | undefined
  var kritaWidgetStyleState: { available: string[], current: string, qtStyle: string } | undefined
  var kritaStartupWarnings: string[]
  var kritaTestFS: typeof FS
  var kritaWidgetSnapshot: { class: string }[]
  var kritaTestSnapshot: (includePixels?: boolean) => { class: string }[]
  var kritaWasm: unknown
  function qtLoad(options: {
    print: (message: unknown) => void
    printErr: (message: unknown) => void
    locateFile?: (name: string) => string
    preRun?: ((module: KritaModule) => void)[]
    qt: {
      entryFunction: unknown
      containerElements: HTMLElement[]
      environment?: Record<string, string>
      onLoaded: () => void
      onExit: (exit: unknown) => void
    }
  }): Promise<KritaModule>
  interface WindowEventMap {
    'krita-language-change': CustomEvent<string[] | null>
    'krita-palette-change': Event
    'krita-widget-style-change': Event
  }
  namespace WebAssembly {
    const Suspending: (new (fn: (...args: never[]) => unknown) => object) | undefined
    const promising: ((fn: (...args: never[]) => unknown) => ((...args: never[]) => unknown)) | undefined
  }
}
