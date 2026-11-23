import type { Page, TestInfo } from '@playwright/test'
import type { WebFixture } from './fixtures.ts'
import type { CanvasSnapshot, DocumentSnapshot, SnapshotRecord, WidgetSnapshot } from './native.js'
import { Buffer } from 'node:buffer'
import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { expect } from '@playwright/test'

export interface PixelArtifact { width: number, height: number, dark_pixels: number, rgba_sha256: string }
export interface KraArtifact { bytes: number, sha256: string, layers: number, projection: PixelArtifact }
function artifact(kind: 'catalog', path: string, extra?: string[]): Record<string, string>
function artifact(kind: 'png', path: string, extra?: string[]): PixelArtifact
function artifact(kind: 'kra' | 'autosave', path: string, extra?: string[]): KraArtifact
function artifact(kind: string, path: string, extra: string[] = []): unknown {
  return JSON.parse(execFileSync('python3', [
    resolve('scripts/browser-artifacts.py'),
    kind,
    path,
    ...extra,
  ], { encoding: 'utf8' }))
}

class KritaUI {
  canvasCenter: [number, number] = [0, 0]
  canvasSamplePoint: [number, number] = [0, 0]
  page: Page
  web: WebFixture
  info: TestInfo
  constructor(page: Page, web: WebFixture, info: TestInfo) {
    this.page = page
    this.web = web
    this.info = info
  }

  write(name: string, data: unknown) {
    writeFileSync(this.info.outputPath(name), `${JSON.stringify(data, null, 2)}\n`)
  }

  async shot(name: string) {
    await this.page.screenshot({
      path: this.info.outputPath(`${name}.png`),
    })
  }

  async wait(predicate: () => unknown | Promise<unknown>, message: string, timeout = 30_000) {
    await expect.poll(async () => {
      this.web.check()
      return await predicate()
    }, { timeout, message }).toBeTruthy()
  }

  async start(query = '') {
    await this.page.goto(`${this.web.url}/?test=1${query}`, { waitUntil: 'domcontentloaded' })
    await this.waitForStartup()
  }

  async waitForWidgets() {
    // Reloading can recompile Wasm before a recovery dialog becomes available.
    await this.wait(() => this.page.evaluate(() => window.kritaRecovery?.widgetsReady
      && typeof window.kritaTestSnapshot === 'function'), 'native widgets and test bridge initialized', 90_000)
  }

  async waitForStartup() {
    try {
      await this.web.ready()
    }
    finally {
      this.write('capabilities.json', await this.page.evaluate(() => ({
        userAgent: navigator.userAgent,
        isolated: crossOriginIsolated,
        sharedMemory: typeof SharedArrayBuffer === 'function',
        suspending: typeof WebAssembly.Suspending === 'function',
        promising: typeof WebAssembly.promising === 'function',
      })).catch(error => ({
        error: String(error),
      })))
    }
    await this.wait(() => this.page.evaluate(() => typeof window.kritaTestSnapshot === 'function'), 'Qt widget snapshot bridge', 90_000)
    // The server receives readiness logs from every tab. A previous window
    // must not make this page appear ready before its own app initialized.
    await this.wait(() => this.state(), 'this page application state', 90_000)
    await expect(this.page.locator('#status')).toBeHidden({ timeout: 90_000 })
    expect(this.web.requests.filter(path => path.includes('/assets/') && !/\.(?:js|css)$/.test(path))).toEqual([])
    expect(this.web.requests.filter(path => path.endsWith('/krita.bundle.tar.gz')).length).toBeLessThanOrEqual(1)
  }

  async snapshot<T extends SnapshotRecord = WidgetSnapshot>(includePixels = false, swapHistory = false): Promise<T[]> {
    return this.page.evaluate(([pixels, swap]) => window.kritaTestSnapshot(pixels, swap), [includePixels, swapHistory]) as Promise<T[]>
  }

  async find(fields: Partial<WidgetSnapshot>) {
    const matches = (await this.snapshot()).filter(item => (Object.entries(fields) as [keyof WidgetSnapshot, unknown][]).every(([key, value]) => item[key] === value))
    expect(matches.length, `ambiguous widget ${JSON.stringify(fields)}`).toBeLessThanOrEqual(1)
    return matches[0]
  }

  async center(widget: WidgetSnapshot | undefined): Promise<[number, number]> {
    expect(widget, 'Qt widget exists').toBeTruthy()
    if (!widget)
      throw new Error('Qt widget does not exist')
    const x = widget.x + widget.width / 2
    const y = widget.y + widget.height / 2
    const windows = (await this.snapshot()).filter(item => (item.window || ['KisMainWindow', 'KisOpenPane', 'QMenu'].includes(item.class)
      || item.class.endsWith('KisKSwitchLanguageDialog')) && item.x <= x && x <= item.x + item.width && item.y <= y && y <= item.y + item.height)
    expect(windows.length, 'Qt window contains widget').toBeGreaterThan(0)
    const window = windows.sort((a, b) => a.width * a.height - b.width * b.height)[0]
    const canvases = await this.page.evaluate(() => [
      ...document.getElementById('qt-shadow-container')!.shadowRoot!.querySelectorAll<HTMLCanvasElement>('canvas.qt-window-canvas')!,
    ].map((canvas) => {
      const r = canvas.getBoundingClientRect()
      return {
        x: r.x,
        y: r.y,
        width: r.width,
        height: r.height,
      }
    }))
    const matches = canvases.filter(item => Math.abs(item.width - window.width) < 1 && Math.abs(item.height - window.height) < 1)
    expect(matches, 'one actual DOM canvas for Qt window').toHaveLength(1)
    const point: [number, number] = [
      Math.round(matches[0].x + x - window.x),
      Math.round(matches[0].y + y - window.y),
    ]
    appendFileSync(this.info.outputPath('input-geometry.jsonl'), `${JSON.stringify({
      widget,
      window,
      canvas: matches[0],
      point,
    })}\n`)
    return point
  }

  async click(fields: Partial<WidgetSnapshot>) {
    await this.wait(async () => {
      const widget = await this.find(fields)
      return widget && widget.enabled !== false
    }, `enabled Qt control ${JSON.stringify(fields)}`)
    const widget = await this.find(fields)
    const point = await this.center(widget)
    if (widget?.class === 'QCheckBox') {
      // Qt's click rectangle covers the indicator/label, not stretched padding.
      const rtl = await this.page.locator('html').getAttribute('dir') === 'rtl'
      point[0] += (rtl
        ? 1
        : -1) * (widget.width / 2 - 8)
    }
    const settings = this.page.locator('#settings-toggle')
    const box = (await settings.boundingBox())!
    // In RTL layouts the floating gear can cover the New toolbar button.
    // Move it with real pointer input before clicking an obscured Qt control.
    if (box && box.x <= point[0] && point[0] <= box.x + box.width
      && box.y <= point[1] && point[1] <= box.y + box.height) {
      const viewport = this.page.viewportSize()!
      await this.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      await this.page.mouse.down()
      await this.page.mouse.move(point[0] < viewport.width / 2
        ? viewport.width - 30
        : 30, point[1] < viewport.height / 2
        ? viewport.height - 30
        : 30, { steps: 12 })
      await this.page.mouse.up()
      await expect(this.page.locator('#page-settings')).not.toBeVisible()
    }
    await this.page.mouse.click(...point)
  }

  async replace(fields: Partial<WidgetSnapshot>, value: string | number) {
    await this.click(fields)
    await this.page.keyboard.press('Control+A')
    const text = String(value)
    // Firefox BiDi's insertText emits an input event Qt does not handle.
    // Use actual key events for ASCII input in the system-browser checks.
    if (this.info.project.use.channel === 'moz-firefox' && /^[\x20-\x7E]*$/.test(text))
      await this.page.keyboard.type(text)
    else await this.page.keyboard.insertText(text)
    if (typeof value === 'number') {
      await this.page.keyboard.press('Tab')
      await expect.poll(async () => (await this.find(fields))!.value, { message: `Qt numeric input ${fields.name}` }).toBe(value)
    }
  }

  async chooseDeviceFile(path: string | string[], method: 'picker' | 'drop' = 'picker') {
    const dialog = this.page.locator('#file-open')
    await expect(dialog).toBeVisible()
    if (method === 'picker') {
      const input = this.page.locator('#device-file')
      await expect(input).toBeEnabled()
      await input.setInputFiles(path)
    }
    else {
      const paths = Array.isArray(path)
        ? path
        : [path]
      await this.page.evaluate((files) => {
        const transfer = new DataTransfer()
        for (const { name, bytes } of files) {
          transfer.items.add(new File([
            new Uint8Array(bytes),
          ], name))
        }
        document.querySelector('#device-drop')!.dispatchEvent(new DragEvent('drop', {
          bubbles: true,
          cancelable: true,
          dataTransfer: transfer,
        }))
      }, paths.map(path => ({
        name: basename(path),
        bytes: Array.from(readFileSync(path)),
      })))
    }
    await expect(dialog).not.toBeVisible()
  }

  async warnings() {
    return this.page.evaluate(() => window.kritaStartupWarnings)
  }

  async state() {
    return this.page.evaluate(() => window.kritaI18nState)
  }

  async documents() {
    // Cancellation checks compare document state. Save-in-progress and timer
    // suspension are transient observations, checked separately by autosave tests.
    return (await this.snapshot<DocumentSnapshot>()).filter(item => item.class === 'KritaTestDocument').map(({ saving, autosaveActive, ...document }) => document)
  }

  async canvases() {
    return (await this.snapshot<CanvasSnapshot>()).filter(item => item.class === 'KritaTestCanvasGeometry')
  }

  async verifyI18n(expectedLanguage?: string) {
    const state = await this.state()
    if (expectedLanguage)
      expect(state.languages[0]).toBe(expectedLanguage)
    const labels = artifact('catalog', this.web.root, [
      '--languages',
      JSON.stringify(state.languages),
    ])
    expect(state.menus.find(item => item.name === 'file')!.text).toBe(labels['&File'].replaceAll('&', ''))
    const primary = state.languages[0]
    const numbers: Record<string, string> = {
      en_US: '12,345.67',
      zh_CN: '12,345.67',
      zh_TW: '12,345.67',
      ar: '١٢٬٣٤٥٫٦٧',
      ru: '12\u00A0345,67',
      pt_BR: '12.345,67',
    }
    if (numbers[primary])
      expect(state.number).toBe(numbers[primary])
    expect(state.rtl).toBe(['ar', 'fa', 'he', 'ur', 'ug'].includes(primary.split('_')[0]))
    const cancel: Record<string, string> = {
      en_US: 'Cancel',
      zh_CN: '取消',
      zh_TW: '取消',
      ar: 'ألغِ',
      ru: 'Отмена',
      pt_BR: 'Cancelar',
    }
    if (cancel[primary])
      expect(state.qtCancel).toBe(cancel[primary])
    if (primary !== 'en_US' && cancel[primary])
      expect(state.kdeCancel.replaceAll('&', '')).not.toBe('Cancel')
    expect(state.missingMenuGlyphs).toBe(0)
    for (const coverage of Object.values(state.fontCoverage || {})) expect(coverage.missing).toBe(0)
    return state
  }

  async verifyStartup(expectedLanguage?: string) {
    const state = await this.verifyI18n(expectedLanguage)
    this.write('i18n.json', state)
    for (const name of [
      'widgetRight',
      'newsTitleLabel',
      'btnNewsOptions',
      'newsFrame',
      'labelNoFeed',
      'newsWidget',
      'updaterFrame',
    ])
      expect(await this.find({ name }), `desktop news must not be visible in the browser: ${name}`).toBeUndefined()
    expect(await this.find({ name: 'newFileLink' })).toBeTruthy()
    expect(await this.find({ name: 'openFileLink' })).toBeTruthy()
    this.write('startup-warnings.json', await this.warnings())
    expect(state.groupButtonColors).toHaveLength(4)
    for (const color of state.groupButtonColors) {
      expect(color.valid).toBe(true)
      expect(color.icon).toBe(color.text)
    }
    expect(new Set(state.groupButtonColors.map(item => item.icon)).size).toBeGreaterThan(1)
    expect(state.textToolCursors).toHaveLength(8)
    expect(state.textToolQmlExists).toBe(true)
    for (const cursor of state.textToolCursors) {
      for (const key of ['loaded', 'bitmap', 'mask', 'custom'] as const) expect(cursor[key]).toBe(true)
      expect(Math.min(cursor.width, cursor.height)).toBeGreaterThan(0)
      expect(cursor.hotspot).toEqual(cursor.expectedHotspot)
    }
    expect(state.emptyCanvasStates.map(item => item.dpr).sort()).toEqual([1, 1.5, 2])
    for (const item of state.emptyCanvasStates) {
      expect(item.boundsEmpty).toBe(true)
      expect(item.mappedEmpty).toBe(true)
    }
    await this.shot('01-window')
    return state
  }

  async help() {
    await this.page.evaluate(() => {
      window.kritaTestHelpUrls = []
      window.kritaOriginalOpen = window.open
      window.open = (url) => {
        window.kritaTestHelpUrls.push(String(url))
        return window
      }
    })
    try {
      await this.click({ action: 'help' })
      await this.wait(() => this.find({ action: 'help_contents' }), 'Handbook action')
      await this.click({ action: 'help_contents' })
      await this.wait(() => this.page.evaluate(() => window.kritaTestHelpUrls.length), 'handbook URL')
      const urls = await this.page.evaluate(() => window.kritaTestHelpUrls)
      expect(urls).toHaveLength(1)
      expect(new URL(urls[0]).origin).toBe('https://docs.krita.org')
      this.write('help.json', urls)
    }
    finally {
      await this.page.evaluate(() => {
        window.open = window.kritaOriginalOpen
        Reflect.deleteProperty(window, 'kritaOriginalOpen')
      })
    }
    const diagnostics = []
    for (const [action, filename, expected, downloadName] of [
      [
        'buginfo',
        'krita.log',
        'SESSION:',
        'KritaUsageLog.txt',
      ],
      [
        'sysinfo',
        'krita-sysinfo.log',
        'Hardware Information',
        'KritaSystemInformation.txt',
      ],
    ]) {
      await this.click({ action: 'help' })
      await this.click({ action })
      await this.wait(() => this.find({ name: 'txtBugInfo' }), `native diagnostic viewer ${action}`)
      const text = await this.page.evaluate(filename => window.kritaTestFS.readFile(`/krita/user-data/${filename}`, { encoding: 'utf8' }), filename)
      expect(text).toContain(expected)
      if (action === 'buginfo')
        expect(text).toContain('Style:')
      const displayed = (await this.find({ name: 'txtBugInfo' }))!.text!
      expect(displayed).toContain(expected)
      await this.shot(`help-${action}`)
      for (let attempt = 0; attempt < 2; attempt++) {
        const pending = this.page.waitForEvent('download')
        await this.click({ koButton: 8192 })
        const download = await pending
        const path = this.info.outputPath(`help-${action}-${attempt}.txt`)
        expect(download.suggestedFilename()).toBe(downloadName)
        await download.saveAs(path)
        expect(await download.failure()).toBeNull()
        expect(readFileSync(path)).toEqual(Buffer.from(displayed, 'utf8'))
        expect(await this.find({ class: 'KisPreviewFileDialog' })).toBeUndefined()
        expect((await this.find({ name: 'txtBugInfo' }))!.text!).toBe(displayed)
      }
      diagnostics.push({
        action,
        filename,
        bytes: Buffer.byteLength(text),
        downloadName,
        repeatedExportMatchesDisplayedText: true,
      })
      await this.click({ buttonRole: 0 })
      await this.wait(async () => !await this.find({ name: 'txtBugInfo' }), 'diagnostic viewer closes')
    }
    this.write('help-diagnostics.json', diagnostics)
  }

  async darkPixels() {
    return this.page.evaluate(([x, y]) => {
      const canvas = document.getElementById('qt-shadow-container')!.shadowRoot!.querySelector<HTMLCanvasElement>('canvas.qt-window-canvas')!
      const rect = canvas.getBoundingClientRect()
      const scaleX = canvas.width / rect.width
      const scaleY = canvas.height / rect.height
      const pixels = canvas.getContext('2d')!.getImageData(Math.round((x - 75) * scaleX), Math.round((y - 75) * scaleY), Math.round(150 * scaleX), Math.round(150 * scaleY)).data
      let dark = 0
      for (let i = 0; i < pixels.length; i += 4) {
        if (pixels[i] < 100 && pixels[i + 1] < 100 && pixels[i + 2] < 100 && pixels[i + 3] > 200)
          dark++
      }
      return dark
    }, this.canvasSamplePoint)
  }

  async paint({ width = 256, height = 256 } = {}) {
    await this.click({ action: 'file_new' })
    await this.wait(() => this.find({ class: 'KisOpenPane' }), 'new document dialog')
    await this.shot('02-new-dialog')
    await this.replace({ name: 'doubleWidth' }, width)
    await this.replace({ name: 'doubleHeight' }, height)
    await this.shot('02-dimensions')
    await this.click({ buttonBox: 'newDialogConfirmationButtonBox', standardButton: 1024 })
    await this.wait(async () => !await this.find({ class: 'KisOpenPane' }), 'new document accepted')
    await this.wait(() => this.find({ class: 'KisQPainterCanvas' }), 'actual QPainter canvas')
    this.canvasCenter = await this.center(await this.find({ class: 'KisQPainterCanvas' }))
    // Keep the sampling point relative to the main backing canvas. Native
    // HTML selectors may shift its DOM origin without changing Qt geometry.
    this.canvasSamplePoint = await this.page.evaluate(([x, y]) => {
      const rect = document.getElementById('qt-shadow-container')!.shadowRoot!.querySelector<HTMLCanvasElement>('canvas.qt-window-canvas')!.getBoundingClientRect()!
      return [x - rect.x, y - rect.y] as [number, number]
    }, this.canvasCenter)
    await this.wait(async () => await this.darkPixels() === 0, 'initial canvas is white')
    await this.shot('03-new-canvas')
    const [x, y] = this.canvasCenter
    await this.page.mouse.move(x - 50, y - 45)
    await this.page.mouse.down()
    for (let i = 1; i <= 10; i++) {
      await this.page.mouse.move(x - 50 + i * 10, y - 45 + i)
      await this.page.waitForTimeout(30)
    }
    await this.page.mouse.up()
    await this.page.mouse.move(900, 650)
    await this.wait(async () => await this.darkPixels() > 100, 'mouse stroke changes rendered pixels')
    await this.wait(async () => (await this.find({ action: 'edit_undo' }))?.enabled, 'stroke committed to native undo history')
    this.web.check()
    await this.shot('04-painted')
    const geometries = await this.canvases()
    expect(geometries.length).toBeGreaterThan(0)
    for (const geometry of geometries) {
      expect(geometry.openGL).toBe(false)
      expect(geometry.lodPreferred).toBe(false)
      expect(Math.min(...geometry.imageSize, ...geometry.widgetRect.slice(2))).toBeGreaterThan(0)
      for (const value of [
        ...geometry.widgetRect,
        ...geometry.documentOffsetF,
        geometry.zoom,
        geometry.dpr,
      ]) expect(Number.isFinite(value)).toBe(true)
      expect(Math.abs(geometry.widgetRect[0] + geometry.documentOffsetF[0])).toBeLessThan(1e-6)
      expect(Math.abs(geometry.widgetRect[1] + geometry.documentOffsetF[1])).toBeLessThan(1e-6)
    }
    this.write('canvas-geometry-after-paint.json', geometries)
  }

  async undoRedo() {
    const painted = await this.darkPixels()
    expect(painted).toBeGreaterThan(100)
    await this.click({ action: 'edit_undo' })
    await this.wait(async () => await this.darkPixels() === 0, 'Undo removes the single stroke')
    await this.shot('undo-blank')
    this.write('undo-state.json', await this.snapshot())
    await this.click({ action: 'edit_redo' })
    await this.shot('redo-immediate')
    this.write('redo-state.json', await this.snapshot())
    await this.wait(async () => await this.darkPixels() === painted, 'Redo restores the exact rendered stroke')
    this.write('undo-redo.json', { painted, restored: await this.darkPixels() })
  }

  async textProperties() {
    const state = await this.state()
    const title = artifact('catalog', this.web.root, [
      '--languages',
      JSON.stringify(state.languages),
    ])['Text Properties']
    await this.click({ action: 'settings' })
    await this.wait(() => this.find({ action: 'settings_dockers_menu' }), 'Dockers submenu')
    await this.click({ action: 'settings_dockers_menu' })
    await this.wait(() => this.find({ class: 'QMenuAction', text: title }), 'Text Properties toggle')
    await this.click({ class: 'QMenuAction', text: title })
    const panel = async () => (await this.snapshot()).find(item => item.qml_source === 'qrc:/TextProperties.qml')
    await this.wait(panel, 'actual Text Properties QML widget')
    const item = (await panel())!
    expect(item.qml_status).toBe(1)
    expect(item.qml_root).toBe(true)
    expect(item.qml_errors).toEqual([])
    const tabs = (await this.snapshot()).filter(item => item.class === 'KritaTestQmlTab')
    expect(tabs).toHaveLength(3)
    for (const tab of tabs) {
      expect(tab.text).toBeTruthy()
      await this.click({ class: 'KritaTestQmlTab', text: tab.text })
      await this.wait(() => this.find({ class: 'KritaTestQmlTab', text: tab.text, checked: true }), `selected tab ${tab.text}`)
    }
    this.write('text-properties.json', {
      panel: await panel(),
      tabs: tabs.map(tab => tab.text),
    })
    await this.shot('06-text-properties')
  }
}
export { artifact, KritaUI }
