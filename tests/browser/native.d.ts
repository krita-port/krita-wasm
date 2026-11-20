// Projections of the JSON records emitted by kritaWasmTestSnapshot.
export interface SnapshotRecord { class: string }
export interface WidgetSnapshot extends SnapshotRecord {
  name: string
  x: number
  y: number
  width: number
  height: number
  window?: boolean
  enabled?: boolean
  activeCanvas?: boolean
  text?: string
  action?: string
  checked?: boolean
  checkable?: boolean
  selected?: boolean
  buttonBox?: string
  standardButton?: number
  buttonRole?: number
  koButton?: number
  value?: number
  index?: number
  choices?: string[]
  directory?: string
  acceptMode?: number
  filePath?: string
  viewName?: string
  qml_source?: string
  qml_status?: number
  qml_root?: boolean
  qml_errors?: string[]
}
export interface DocumentSnapshot extends SnapshotRecord {
  class: 'KritaTestDocument'
  path: string
  width: number
  height: number
  layers: number
  modified: boolean
  recovered: boolean
  saving: boolean
  autosaveActive: boolean
  recoveryPath: string
  savedPath: string
  undoIndex: number
  undoCount: number
  canUndo: boolean
  canRedo: boolean
  layerPixels?: { name: string, sha256: string }[]
}
export interface CanvasSnapshot extends SnapshotRecord {
  class: 'KritaTestCanvasGeometry'
  path: string
  active: boolean
  assistantVisible: boolean
  assistantPreviewVisible: boolean
  mirrorX: boolean
  mirrorY: boolean
  openGL: boolean
  lodPreferred: boolean
  imageSize: [number, number]
  widgetRect: [number, number, number, number]
  documentOffsetF: [number, number]
  dpr: number
  zoom: number
}
export interface I18nState {
  available: string[]
  languages: string[]
  number: string
  rtl: boolean
  qtCancel: string
  kdeCancel: string
  menus: { name: string, text: string }[]
  missingMenuGlyphs: number
  fontCoverage?: Record<string, { missing: number }>
  groupButtonColors: { valid: boolean, icon: string, text: string, checked: boolean, enabled: boolean }[]
  textToolQmlExists: boolean
  textToolCursors: { custom: boolean, loaded: boolean, bitmap: boolean, mask: boolean, width: number, height: number, hotspot: number[], expectedHotspot: number[] }[]
  emptyCanvasStates: { boundsEmpty: boolean, mappedEmpty: boolean, dpr: number }[]
}
declare global {
  var kritaI18nState: I18nState
  var kritaSaveKeys: { trusted: boolean, cancelled: boolean, shift: boolean, repeat: boolean }[]
  var kritaSettingsKeys: { key: string, prevented: boolean, trusted: boolean }[]
  var kritaSettingsPreviousFocus: Element | null
  var kritaTestHelpUrls: string[]
  var kritaOriginalOpen: typeof window.open
  var kritaLanguageDocument: string
  var kritaStyleDocumentId: string
  var kritaAppearanceDocument: string
  var kritaFirstPalette: import('../../web/runtime.js').Palette | undefined
}
