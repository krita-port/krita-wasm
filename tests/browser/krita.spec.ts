import type { BrowserContext, Dialog, Download } from '@playwright/test'
import type { DocumentSnapshot, WidgetSnapshot } from './native.js'
import { Buffer } from 'node:buffer'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { createServer } from 'vite'
import { languageTag } from '../../web/i18n.ts'
import englishMessages from '../../web/messages/en.json' with { type: 'json' }
import { expect, stored, test } from './fixtures.ts'

import { artifact, KritaUI } from './krita-ui.ts'

async function saveShortcuts(ui: KritaUI) {
  const { page } = ui
  const observer = await page.evaluateHandle(() => {
    const controller = new AbortController()
    window.kritaSaveKeys = []
    window.addEventListener('keydown', (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        window.kritaSaveKeys.push({
          trusted: event.isTrusted,
          cancelled: event.defaultPrevented,
          shift: event.shiftKey,
          repeat: event.repeat,
        })
      }
    }, { capture: true, signal: controller.signal })
    return controller
  })
  const dialogs = async () => (await ui.snapshot()).filter(item => item.class === 'KisPreviewFileDialog')
  const before = await ui.documents()
  for (const shift of [false, true, false]) {
    await page.keyboard.press(shift ? 'Control+Shift+s' : 'Control+s')
    await ui.wait(async () => (await dialogs()).length === 1, 'trusted shortcut opens one Save dialog')
    let keys = await page.evaluate(() => window.kritaSaveKeys)
    expect(keys.at(-1)).toMatchObject({ trusted: true, cancelled: true, shift })
    await page.keyboard.press('Control+s')
    await page.waitForTimeout(200)
    expect(await dialogs()).toHaveLength(1)
    keys = await page.evaluate(() => window.kritaSaveKeys)
    expect(keys.at(-1)!.cancelled).toBe(true)
    await ui.click({ standardButton: 4194304 })
    await ui.wait(async () => !(await dialogs()).length, 'shortcut cancellation')
    await page.waitForTimeout(300)
    expect(await dialogs()).toHaveLength(0)
  }
  const after = await ui.documents()
  expect(after).toHaveLength(before.length)
  for (let i = 0; i < before.length; i++) {
    for (const field of ['path', 'width', 'height', 'layers'] as const) expect(after[i][field]).toEqual(before[i][field])
  }
  const keys = await page.evaluate(() => window.kritaSaveKeys)
  expect(keys).toHaveLength(6)
  for (const key of keys) expect(key).toMatchObject({ trusted: true, cancelled: true })
  ui.write('save-shortcut.json', keys)
  await observer.evaluate(controller => controller.abort())
  await observer.dispose()
}

async function files(ui: KritaUI) {
  const { page } = ui
  const downloads = ui.info.outputPath('downloads')
  mkdirSync(downloads)
  const browserDownloads: string[] = []
  const recordDownload = (event: Download) => browserDownloads.push(event.suggestedFilename())
  page.on('download', recordDownload)
  const fileAction = async (action: string) => {
    if (!await ui.find({ action })) {
      await ui.click({ action: 'file' })
      await ui.wait(() => ui.find({ action }), action)
    }
    await ui.click({ action })
  }
  const dialog = () => ui.find({ class: 'KisPreviewFileDialog' })
  const choose = async (name: string) => {
    await ui.wait(dialog, 'synchronous file dialog')
    await ui.replace({ name: 'fileNameEdit' }, `/Documents/${name}`)
    ui.write(`file-entry-${basename(name)}.json`, await ui.snapshot())
    await page.keyboard.press('Tab')
    await ui.wait(async () => (await ui.find({ standardButton: 2048 }))?.enabled, 'file model enables Save')
    await page.keyboard.press('Tab')
    await ui.click({ standardButton: 2048 })
    ui.write(`file-accept-${basename(name)}.json`, await ui.snapshot())
  }
  const download = async (name: string) => {
    await ui.wait(() => ui.find({ name: 'kritaWasmDownload' }), 'background save completes', 180_000)
    const pending = page.waitForEvent('download')
    await ui.click({ name: 'kritaWasmDownload' })
    const event = await pending
    expect(event.suggestedFilename()).toBe(name)
    const path = join(downloads, name)
    await event.saveAs(path)
    expect(await event.failure()).toBeNull()
    await ui.click({ standardButton: 2097152 })
    await ui.wait(async () => !await ui.find({ name: 'kritaWasmDownloadDialog' }), 'download prompt closes')
    return path
  }
  await page.evaluate(() => {
    window.kritaTestFS.mkdirTree('/Documents/dialog-subdirectory')
    window.kritaTestFS.writeFile('/Documents/not-a-directory', new Uint8Array([1]))
    window.kritaTestFS.symlink('/tmp', '/Documents/outside-link')
  })
  const before = await ui.documents()
  const pixels = await ui.darkPixels()
  await fileAction('file_save')
  await ui.wait(dialog, 'Save synchronous dialog')
  await ui.shot('05-save-dialog')
  // The user file browser is rooted at Documents, including typed paths and
  // symlink resolution; regular subdirectory navigation must still work.
  expect((await dialog())!.directory).toBe('/Documents')
  expect((await ui.find({ name: 'toParentButton' }))!.enabled).toBe(false)
  expect((await ui.snapshot()).filter(item => item.class === 'KritaTestFileItem' && item.viewName === 'sidebar').map(item => item.filePath)).toEqual(['/Documents'])
  await page.keyboard.press('Control+ArrowUp')
  await ui.wait(async () => (await dialog())?.directory === '/Documents', 'keyboard parent stays at cache root')
  const view = await ui.find({ name: 'treeView' }) || await ui.find({ name: 'listView' })
  await ui.click({ class: view!.class, name: view!.name })
  await page.keyboard.press('Backspace')
  await ui.wait(async () => (await dialog())?.directory === '/Documents', 'Backspace stays at cache root')
  if ((await ui.find({ name: 'backButton' }))?.enabled)
    await ui.click({ name: 'backButton' })
  await ui.wait(async () => (await dialog())?.directory === '/Documents', 'native history cannot leave the cache root')
  await ui.wait(() => ui.find({ class: 'KritaTestFileItem', filePath: '/Documents/dialog-subdirectory' }), 'cache subdirectory listed')
  await page.mouse.dblclick(...await ui.center(await ui.find({ class: 'KritaTestFileItem', filePath: '/Documents/dialog-subdirectory' })))
  await ui.wait(async () => (await dialog())?.directory === '/Documents/dialog-subdirectory', 'cache subdirectory entered')
  await ui.click({ name: 'toParentButton' })
  await ui.wait(async () => (await dialog())?.directory === '/Documents', 'parent returns to cache root')
  expect((await ui.find({ name: 'toParentButton' }))!.enabled).toBe(false)
  await ui.click({ name: 'backButton' })
  await ui.wait(async () => (await dialog())?.directory === '/Documents/dialog-subdirectory', 'Back returns to the permitted subdirectory')
  await ui.click({ name: 'forwardButton' })
  await ui.wait(async () => (await dialog())?.directory === '/Documents', 'Forward returns to the cache root')
  expect(await ui.find({ class: 'KritaTestFileItem', filePath: '/Documents/outside-link' })).toBeUndefined()
  for (const outside of ['/tmp/browser-dialog-outside.kra', '../tmp/browser-dialog-outside.kra', '/Documents/outside-link/browser-dialog-outside.kra']) {
    await ui.replace({ name: 'fileNameEdit' }, outside)
    await page.keyboard.press('Enter')
    await ui.wait(async () => (await dialog())?.directory === '/Documents', 'outside path rejected without leaving cache root')
    expect(await ui.find({ name: 'kritaWasmDownloadDialog' })).toBeUndefined()
  }
  expect(await page.evaluate(() => {
    try {
      window.kritaTestFS.stat('/tmp/browser-dialog-outside.kra')
      return true
    }
    catch { return false }
  })).toBe(false)
  await page.evaluate(() => window.kritaTestFS.unlink('/Documents/outside-link'))
  await ui.click({ standardButton: 4194304 })
  await ui.wait(async () => !await dialog(), 'Save cancellation')
  expect(await ui.documents()).toEqual(before)
  expect(await ui.darkPixels()).toBe(pixels)
  expect(browserDownloads).toEqual([])
  await fileAction('file_save')
  await choose('not-a-directory/Browser-error.kra')
  await ui.wait(() => ui.find({ class: 'QMessageBox' }), 'synchronous save error')
  await ui.shot('05-save-error')
  await ui.click({ standardButton: 1024 })
  await ui.wait(async () => !await ui.find({ class: 'QMessageBox' }), 'error acknowledged')
  if (await dialog())
    await ui.click({ standardButton: 4194304 })
  await ui.wait(async () => !await dialog(), 'save error returns to document')
  expect(await ui.documents()).toEqual(before)
  expect(browserDownloads).toEqual([])
  await fileAction('file_save')
  await choose('Browser-save.kra')
  const saved = await download('Browser-save.kra')
  const result: { kra: ReturnType<typeof artifact>, cancel_preserved_document: boolean, save_error_preserved_document: boolean, reopened?: unknown, save_as?: ReturnType<typeof artifact>, png?: unknown, overwrite_rejection_preserved_document?: boolean, export_cancel_preserved_document?: boolean } = {
    kra: artifact('kra', saved),
    cancel_preserved_document: true,
    save_error_preserved_document: true,
  }
  const savedState = await ui.documents()
  await fileAction('file_save_as')
  await choose('Browser-save.kra')
  await ui.wait(() => ui.find({ standardButton: 65536 }), 'nested overwrite confirmation')
  await ui.click({ standardButton: 65536 })
  await ui.wait(dialog, 'overwrite rejection returns to Save As')
  await ui.click({ standardButton: 4194304 })
  await ui.wait(async () => !await dialog(), 'Save As cancellation')
  expect(await ui.documents()).toEqual(savedState)
  expect(browserDownloads).toEqual(['Browser-save.kra'])
  result.overwrite_rejection_preserved_document = true
  for (const method of ['close', 'escape'] as const) {
    await fileAction('file_open')

    await expect(page.locator('#file-open')).toBeVisible()
    await expect(page.locator('#file-cache')).toBeVisible()
    await expect(page.locator('#device-file')).toBeVisible()
    await expect(page.locator('dialog[open]')).toHaveCount(1)
    expect(await ui.find({ name: 'kritaWasmOpenSourceDialog' })).toBeUndefined()
    if (method === 'close') {
      await ui.shot('combined-open')
      await page.locator('#file-close').click()
    }
    else {
      await page.keyboard.press('Escape')
    }
    await expect(page.locator('#file-open')).not.toBeVisible()
    expect(await ui.documents()).toEqual(savedState)
  }
  const delayedRead = await page.evaluateHandle(() => {
    const descriptor = Object.getOwnPropertyDescriptor(File.prototype, 'arrayBuffer')
    const original = File.prototype.arrayBuffer
    let finish: (() => Promise<void>) | undefined
    const state = {
      started: false,
      finish: async () => { await finish?.() },
      restore: () => {
        if (descriptor)
          Object.defineProperty(File.prototype, 'arrayBuffer', descriptor)
        else Reflect.deleteProperty(File.prototype, 'arrayBuffer')
      },
    }
    Object.defineProperty(File.prototype, 'arrayBuffer', {
      configurable: true,
      writable: true,
      value(this: File) {
        state.started = true
        return new Promise<ArrayBuffer>((resolve) => {
          finish = async () => {
            resolve(await original.call(this))
          }
        })
      },
    })
    return state
  })
  try {
    await fileAction('file_open')

    const delayedUpload = ui.chooseDeviceFile(saved)
    await expect.poll(() => delayedRead.evaluate(state => state.started)).toBe(true)
    await expect(page.locator('#device-file')).toBeDisabled()
    await expect(page.locator('#file-cache')).toBeDisabled()
    await page.keyboard.press('Escape')
    await delayedUpload
    await delayedRead.evaluate(state => state.restore())
    expect(await ui.documents()).toEqual(savedState)
    await fileAction('file_open')

    await expect(page.locator('#file-open')).toBeVisible()
    await delayedRead.evaluate(state => state.finish())
    await expect(page.locator('#file-open')).toBeVisible()
    await expect(page.locator('#device-file')).toBeEnabled()
    await expect(page.locator('#file-cache')).toBeEnabled()
    await expect(page.locator('#device-error')).toBeEmpty()
    expect(await ui.documents()).toEqual(savedState)
    await page.locator('#file-close').click()
  }
  finally {
    await delayedRead.evaluate(state => state.restore())
    await delayedRead.dispose()
  }
  const droppedFile = ui.info.outputPath('设备-图像.kra')
  writeFileSync(droppedFile, readFileSync(saved))
  for (const method of ['picker', 'drop'] as const) {
    await fileAction('file_open')

    if (method === 'picker') {
      const restore = await page.evaluateHandle(() => {
        const descriptor = Object.getOwnPropertyDescriptor(File.prototype, 'arrayBuffer')
        const reset = () => {
          if (descriptor)
            Object.defineProperty(File.prototype, 'arrayBuffer', descriptor)
          else Reflect.deleteProperty(File.prototype, 'arrayBuffer')
        }
        Object.defineProperty(File.prototype, 'arrayBuffer', {
          configurable: true,
          writable: true,
          value: () => {
            reset()
            return Promise.reject(new Error('Injected device read failure'))
          },
        })
        return reset
      })
      try {
        await expect(page.locator('#file-open')).toBeVisible()
        await page.locator('#device-file').setInputFiles(saved)
        await expect(page.locator('#device-error')).toContainText('Injected device read failure')
        await expect(page.locator('#file-open')).toBeVisible()
        await expect(page.locator('#device-file')).toBeEnabled()
        expect(await ui.documents()).toEqual(savedState)
      }
      finally {
        await restore.evaluate(reset => reset())
        await restore.dispose()
      }
    }
    const input = method === 'drop'
      ? droppedFile
      : saved
    const previousPaths = new Set((await ui.documents()).map(document => document.path))
    await ui.chooseDeviceFile(input, method)
    await ui.wait(async () => (await ui.documents()).length === before.length + 1, `actual KRA device ${method}`, 180_000)
    const reopened = (await ui.documents()).find(item => !previousPaths.has(item.path) && item.path.endsWith(`/${basename(input)}`))
    expect(reopened).toMatchObject({ width: 256, height: 256, layers: result.kra.layers })
    await ui.wait(async () => await ui.darkPixels() > 100, 'reopened KRA renders strokes')
    result.reopened = reopened
    if (method === 'picker') {
      await fileAction('file_close')
      await ui.wait(async () => (await ui.documents()).length === before.length, 'picker document closes before drop')
    }
  }
  await ui.shot('07-reopened')
  await fileAction('file_save_as')
  await choose('Browser-copy.kra')
  result.save_as = artifact('kra', await download('Browser-copy.kra'))
  expect(result.save_as.projection).toEqual(result.kra.projection)
  await fileAction('file_export_file')
  await choose('Browser-export.png')
  await ui.wait(() => ui.find({ class: 'KoDialog' }), 'nested PNG options')
  await ui.shot('08-export-options')
  const exportBefore = await ui.documents()
  await ui.click({ buttonRole: 1 })
  await ui.wait(async () => !await ui.find({ class: 'KoDialog' }), 'PNG cancellation')
  expect(await ui.documents()).toEqual(exportBefore)
  expect(browserDownloads).toEqual(['Browser-save.kra', 'Browser-copy.kra'])
  await fileAction('file_export_file')
  await choose('Browser-export.png')
  await ui.wait(() => ui.find({ class: 'KoDialog' }), 'PNG export retry')
  for (const name of ['chkForceSRGB', 'tryToSaveAsIndexed']) {
    if ((await ui.find({ name }))?.checked)
      await ui.click({ name })
  }
  await ui.click({ buttonRole: 0 })
  result.png = artifact('png', await download('Browser-export.png'))
  expect(result.png).toEqual(result.kra.projection)
  result.export_cancel_preserved_document = true
  expect(browserDownloads).toEqual(['Browser-save.kra', 'Browser-copy.kra', 'Browser-export.png'])
  page.off('download', recordDownload)
  ui.write('file-results.json', result)
}

async function viewActions(ui: KritaUI) {
  const states = async () => Object.fromEntries((await ui.canvases()).map(item => [item.path, item]))
  const before = await states()
  expect(Object.keys(before)).toHaveLength(2)
  const active = Object.keys(before).find(path => before[path].active)
  const results = []
  const select = async (path: string) => {
    const tab = (await ui.snapshot()).find(item => item.class === 'KritaTestTab' && item.text!.includes(basename(path)))
    await ui.page.mouse.click(...await ui.center(tab))
    await ui.wait(async () => (await states())[path].active, `active document ${path}`)
  }
  for (const path of Object.keys(before)) {
    await select(path)
    for (const [action, flag] of [
      ['view_toggle_painting_assistants', 'assistantVisible'],
      ['view_toggle_assistant_previews', 'assistantPreviewVisible'],
      ['mirror_canvas', 'mirrorX'],
      ['mirror_canvas_around_cursor', 'mirrorX'],
      ['mirror_canvas_around_canvas', 'mirrorX'],
    ] as const) {
      const original = await states()
      for (const expected of [!original[path][flag], original[path][flag]]) {
        await ui.click({ action: 'view' })
        if (action.startsWith('mirror_')) {
          await ui.wait(() => ui.find({ action: 'ZoomRotateMirror' }), 'mirror submenu')
          await ui.click({ action: 'ZoomRotateMirror' })
        }
        await ui.wait(() => ui.find({ action }), action)
        expect(await ui.find({ action })).toMatchObject({ enabled: true, checkable: true })
        await ui.click({ action })
        await ui.wait(async () => (await states())[path][flag] === expected, `${action} changes active view`)
        const after = await states()
        for (const other of Object.keys(original).filter(other => other !== path)) {
          for (const key of [
            'mirrorX',
            'mirrorY',
            'assistantVisible',
            'assistantPreviewVisible',
          ] as const) expect(after[other][key]).toBe(original[other][key])
        }
      }
      results.push({ path, action, restored: true })
    }
  }
  await select(active!)
  ui.write('view-actions.json', results)
}

async function independentTabs(ui: KritaUI, context: BrowserContext) {
  const documents = await ui.documents()
  const pixels = await ui.darkPixels()
  expect(documents.length).toBeGreaterThan(0)
  const second = await context.newPage()
  try {
    ui.web.statuses.length = 0
    const other = new KritaUI(second, ui.web, ui.info)
    await other.start()
    expect(await other.documents()).toEqual([])
    expect(await other.find({ class: 'KisMainWindow' })).toBeTruthy()
  }
  finally {
    await second.close()
    await ui.page.bringToFront()
  }
  expect(await ui.documents()).toEqual(documents)
  expect(await ui.darkPixels()).toBe(pixels)
  ui.write('independent-tabs.json', { second_window_started: true, first_document_preserved: true })
}

async function floatingSettings(ui: KritaUI) {
  const { page } = ui
  const toggle = page.locator('#settings-toggle')
  const modal = page.locator('#page-settings')
  const before = (await ui.snapshot(true)).filter(item => item.class === 'KritaTestDocument')
  await page.evaluate(() => {
    let focused = document.activeElement
    while (focused?.shadowRoot?.activeElement) focused = focused.shadowRoot!.activeElement
    window.kritaSettingsPreviousFocus = focused
  })
  const geometry = () => page.evaluate(() => ({
    screen: document.getElementById('screen')!.getBoundingClientRect().toJSON(),
    canvases: [
      ...document.getElementById('qt-shadow-container')!.shadowRoot!.querySelectorAll<HTMLCanvasElement>('canvas.qt-window-canvas'),
    ]
      // Qt popups can disappear when focus changes; measure the main backing canvas.
      .slice(0, 1)
      .map(canvas => canvas.getBoundingClientRect().toJSON()),
  }))
  const original = await geometry()
  expect(original.screen.y).toBe(0)
  expect(original.screen.height).toBe(900)
  await expect(modal).not.toBeVisible()
  const drag = async (x: number, y: number) => {
    const box = (await toggle.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(x, y, { steps: 12 })
    await page.mouse.up()
    await expect(modal).not.toBeVisible()
  }
  await drag(2, 2)
  let position = (await toggle.boundingBox())!
  expect(position.x).toBe(8)
  expect(position.y).toBe(8)
  await drag(1278, 898)
  position = (await toggle.boundingBox())!
  expect(position.x + position.width).toBe(1272)
  expect(position.y + position.height).toBe(892)
  await drag(240, 700)
  const saved = (await toggle.boundingBox())!
  const remembered = await page.evaluate(() => JSON.parse(localStorage.getItem('krita.settings-position')!))
  expect(remembered).toEqual({ x: saved.x, y: saved.y })
  await page.setViewportSize({ width: 720, height: 480 })
  await expect.poll(async () => (await toggle.boundingBox())!.y).toBeLessThan(saved.y)
  await page.setViewportSize({ width: 1280, height: 900 })
  await expect.poll(() => toggle.boundingBox()).toEqual(saved)
  await toggle.click()
  await expect(modal).toBeVisible()
  await expect(page.locator('#language')).toBeFocused()
  await page.locator('#page-settings').evaluate((dialog) => {
    window.kritaSettingsKeys = []
    dialog.addEventListener('keydown', event => window.kritaSettingsKeys.push({ key: (event as KeyboardEvent).key, prevented: event.defaultPrevented, trusted: event.isTrusted }))
  })
  await page.keyboard.press('Control+s')
  const keys = await page.evaluate(() => window.kritaSettingsKeys)
  expect(keys.at(-1)).toMatchObject({ key: 's', prevented: true, trusted: true })
  expect(await ui.find({ class: 'KisPreviewFileDialog' })).toBeUndefined()
  await page.keyboard.press('Escape')
  await expect(modal).not.toBeVisible()
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  expect(await page.evaluate(() => {
    let focused = document.activeElement
    while (focused?.shadowRoot?.activeElement) focused = focused.shadowRoot!.activeElement
    return focused === window.kritaSettingsPreviousFocus
  })).toBe(true)
  await toggle.focus()
  await page.keyboard.press('Enter')
  await expect(modal).toBeVisible()
  await page.locator('#settings-close').click()
  await expect(modal).not.toBeVisible()
  // close is queued after dialog.close(); wait for the focus-restoring handler
  // before this test explicitly moves focus back from the gear to Qt.
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await expect(toggle).toBeFocused()
  await page.evaluate(() => (window.kritaSettingsPreviousFocus as HTMLElement | null)?.focus({ preventScroll: true }))
  expect(await geometry()).toEqual(original)
  expect((await ui.snapshot(true)).filter(item => item.class === 'KritaTestDocument')).toEqual(before)
  ui.write('floating-settings.json', {
    fillsViewport: true,
    original,
    saved,
    modalKeyboard: keys,
    drawingUnchanged: true,
  })
  await ui.shot('floating-settings-closed')
}

async function languageControls(ui: KritaUI) {
  const { page } = ui
  // A document-local sentinel detects navigation without relying on WebKit's
  // timer precision, which can vary slightly between timeOrigin reads.
  const baseline = await page.evaluate(() => ({
    documentId: window.kritaLanguageDocument = crypto.randomUUID(),
    preference: localStorage.getItem('krita.ui-languages'),
  }))
  expect(baseline.preference).toBeNull()
  const pixels = await ui.darkPixels()
  const documents = await ui.documents()
  const results = []
  const handle = (await page.locator('#settings-toggle').boundingBox())!
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2)
  await page.mouse.down()
  await page.mouse.move(200, 720, { steps: 12 })
  await page.mouse.up()
  const settingsPosition = (await page.locator('#settings-toggle').boundingBox())!
  await expect(page.locator('#page-settings')).not.toBeVisible()
  const geometry = async () => {
    const pixels = await ui.darkPixels()
    return {
      canvases: await ui.canvases(),
      widgets: (await ui.snapshot()).filter(item => ['KisMainWindow', 'KisQPainterCanvas'].includes(item.class)),
      dom: await page.evaluate(() => [
        ...document.getElementById('qt-shadow-container')!.shadowRoot!.querySelectorAll<HTMLCanvasElement>('canvas.qt-window-canvas'),
      ].map(canvas => ({
        x: canvas.getBoundingClientRect().x,
        y: canvas.getBoundingClientRect().y,
        width: canvas.width,
        height: canvas.height,
      }))),
      samplePointInCanvas: ui.canvasSamplePoint,
      pixels,
    }
  }
  ui.write('language-geometry-before.json', await geometry())
  const confirm = async (accept: boolean, trigger: () => Promise<unknown>) => {
    const observed: string[] = []
    const handler = async (dialog: Dialog) => {
      observed.push(dialog.message())
      expect(dialog.type()).toBe('confirm')
      await (accept
        ? dialog.accept()
        : dialog.dismiss())
    }
    page.once('dialog', handler)
    try {
      await trigger()
      await ui.wait(() => observed.length === 1, 'explicit data loss confirmation')
    }
    finally {
      page.removeListener('dialog', handler)
    }
  }
  const choose = async (value: string) => {
    if (!await page.locator('#page-settings').isVisible())
      await page.locator('#settings-toggle').click()
    await page.locator('#language').selectOption(value)
    await page.locator('#apply-language').click()
  }
  const reload = async (trigger: () => Promise<unknown>, language: string) => {
    ui.web.statuses.length = 0
    await trigger()
    await ui.web.ready()
    await ui.wait(() => page.evaluate(() => !!window.kritaI18nState), 'translated window after reload', 90_000)
    await ui.verifyI18n(language)
    expect((await page.locator('#settings-toggle').boundingBox())!).toEqual(settingsPosition)
  }
  await ui.click({ action: 'settings' })
  await ui.wait(() => ui.find({ action: 'switch_application_language' }), 'native language action')
  await ui.click({ action: 'switch_application_language' })
  await ui.wait(() => ui.find({ standardButton: 134217728 }), 'native language dialog')
  await confirm(false, () => ui.click({ standardButton: 134217728 }))
  expect(await page.evaluate(() => window.kritaLanguageDocument)).toBe(baseline.documentId)
  expect(await ui.documents()).toEqual(documents)
  await ui.wait(async () => await ui.darkPixels() === pixels, 'native cancellation restores painted canvas pixels')
  results.push('native reset declined; painted document preserved')
  await confirm(false, () => choose('en'))
  ui.write('language-geometry-after.json', await geometry())
  expect(await page.evaluate(() => ({
    documentId: window.kritaLanguageDocument,
    preference: localStorage.getItem('krita.ui-languages'),
  }))).toEqual(baseline)
  expect(await ui.documents()).toEqual(documents)
  await ui.wait(async () => await ui.darkPixels() === pixels, 'page cancellation preserves painted canvas pixels')
  await page.locator('#settings-close').click()
  results.push('page switch declined; preference and painted document preserved')
  await reload(() => confirm(true, () => choose('en')), 'en_US')
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('krita.ui-languages')!))).toEqual(['en'])
  results.push('manual English overrides Chinese browser')
  await reload(() => page.goto(`${ui.web.url}/?test=1`, { waitUntil: 'domcontentloaded' }), 'en_US')
  results.push('saved preference restored without URL override')
  await reload(() => confirm(true, () => choose('auto')), 'zh_CN')
  expect(await page.evaluate(() => localStorage.getItem('krita.ui-languages'))).toBeNull()
  results.push('automatic language reset')
  await reload(() => page.goto(`${ui.web.url}/?test=1&lang=xx-ZZ`, { waitUntil: 'domcontentloaded' }), 'en_US')
  results.push('unsupported explicit language falls back to English')
  ui.write('language-controls.json', results)
}

const profiles = [
  {
    name: 'English startup, tabs, QML and Quit',
    locale: 'en-US',
    expected: 'en_US',
    full: true,
    panel: true,
  },
  {
    name: 'Chinese font coverage and language controls',
    locale: 'zh-CN',
    expected: 'zh_CN',
    cjk: true,
    controls: true,
  },
  {
    name: 'Russian',
    locale: 'ru',
    language: 'ru',
    expected: 'ru',
  },
  {
    name: 'Portuguese region overrides browser language',
    locale: 'zh-CN',
    language: 'pt_BR',
    expected: 'pt_BR',
  },
]
for (const profile of profiles) {
  test.describe(profile.name, () => {
    test.use({ locale: profile.locale })
    test('new document and actual painting', async ({ page, context, web }, info) => {
      const ui = new KritaUI(page, web, info)
      const externalRequests: string[] = []
      const errors: string[] = []
      if (profile.full) {
        page.on('pageerror', error => errors.push(String(error)))
        page.on('request', (request) => {
          const url = new URL(request.url())
          if (/^https?:$/.test(url.protocol) && url.origin !== new URL(web.url).origin)
            externalRequests.push(url.href)
        })
        // Seed a real pre-existing preference before Krita reads its config.
        await page.addInitScript(() => {
          let fs: typeof FS
          Object.defineProperty(window, 'kritaTestFS', {
            configurable: true,
            get: () => fs,
            set(value) {
              fs = value
              const path = '/krita/config/kritarc'
              fs.writeFile(path, `FetchNews=true\nFetchNewsLanguages=en\n${fs.readFile(path, { encoding: 'utf8' })}`)
            },
          })
        })
      }
      const query = (profile.language
        ? `&lang=${profile.language}`
        : '') + (profile.controls ? '&fontscan=1' : '')
      await ui.start(query)
      await ui.verifyStartup(profile.expected)
      if (profile.full)
        expect(await page.evaluate(() => window.kritaTestFS.readFile('/krita/config/kritarc', { encoding: 'utf8' }))).toContain('FetchNews=true')
      if (profile.controls)
        expect(web.messages.some(message => message.startsWith('KRITA_WASM_I18N_READY:') && message.includes('fontCoverage'))).toBe(true)
      if (profile.cjk)
        await ui.wait(() => web.messages.some(message => message.startsWith('KRITA_WASM_CJK_GLYPHS_READY:')), 'Qt CJK glyph coverage')
      await ui.help()
      await ui.paint()
      await ui.undoRedo()
      if (profile.full) {
        await independentTabs(ui, context)
      }
      if (profile.panel)
        await ui.textProperties()
      ui.web.check()
      if (profile.controls)
        await languageControls(ui)
      if (profile.full) {
        expect(externalRequests).toEqual([])
        ui.write('disabled-news.json', { enabledPreferenceIgnored: true, externalRequests })
        const canvases = page.locator('canvas.qt-window-canvas')
        expect(await canvases.count()).toBeGreaterThan(0)
        await ui.click({ action: 'file' })
        await ui.click({ action: 'file_quit' })
        await ui.wait(async () => {
          if (await canvases.count() === 0)
            return true
          // Discard only the painting made by this isolated test.
          if (await ui.find({ standardButton: 65536 }))
            await ui.click({ standardButton: 65536 })
          return await canvases.count() === 0
        }, 'File Quit closes every native window')
        expect(errors).toEqual([])
        ui.write('quit.json', { windowsAfterExit: await canvases.count(), errors })
      }
      ui.write('result.json', {
        status: 'KRITA_BROWSER_PAINT_OK',
        engine: info.project.name,
        version: context.browser()!.version(),
        profile: profile.name,
        scope: 'Actual new/paint and requested file/UI checks; no persistence proof',
      })
    })
  })
}
const messageDirectory = new URL('../../web/messages/', import.meta.url)
const downloadMessages: Record<string, typeof englishMessages> = Object.fromEntries(
  readdirSync(messageDirectory).filter(name => name.endsWith('.json')).sort().map(name => [
    name.slice(0, -5),
    JSON.parse(readFileSync(new URL(name, messageDirectory), 'utf8')) as typeof englishMessages,
  ]),
)
const translations: Partial<Record<string, typeof englishMessages>> = downloadMessages
test('corner settings round real windows and controls without changing documents', async ({ page, web }, info) => {
  const ui = new KritaUI(page, web, info)
  await ui.start('&lang=zh_CN')
  await expect(page.locator('#window-radius')).toHaveValue('8')
  await expect(page.locator('#control-radius')).toHaveValue('4')
  await expect(page.locator('#window-radius-label')).toHaveText('窗口圆角')
  await expect(page.locator('#control-radius-label')).toHaveText('控件圆角')
  await ui.paint()
  await ui.wait(async () => (await ui.documents())[0]?.undoIndex === 1, 'stroke committed before changing corners')
  const before = (await ui.snapshot(true)).filter(d => d.class === 'KritaTestDocument')
  await page.keyboard.press('Control+o')
  await expect(page.locator('#file-open')).toBeVisible()
  await expect(page.locator('#file-open')).toHaveCSS('border-radius', '8px')
  await page.locator('#file-cache').click()
  await ui.wait(() => ui.find({ class: 'KisPreviewFileDialog' }), 'native cache picker')
  const frameFor = async (fields: Partial<WidgetSnapshot>) => {
    const widget = await ui.find(fields)
    await page.evaluate((widget) => {
      const shadow = document.getElementById('qt-shadow-container')!.shadowRoot!
      for (const old of shadow.querySelectorAll<HTMLElement>('[data-corner-probe]')) old.removeAttribute('data-corner-probe')
      const matches = [
        ...shadow.querySelectorAll<HTMLCanvasElement>('canvas.qt-window-canvas'),
      ].filter((c) => {
        const r = c.getBoundingClientRect()
        return Math.abs(r.width - widget.width) < 1 && Math.abs(r.height - widget.height) < 1
      })
      if (matches.length !== 1)
        throw new Error('Expected one actual Qt window canvas')
      matches[0].closest<HTMLElement>('.qt-decorated-window')!.dataset.cornerProbe = ''
    }, widget)
    return page.locator('[data-corner-probe]')
  }
  const frame = await frameFor({ class: 'KisPreviewFileDialog' })
  await expect(frame).toHaveCSS('border-radius', '8px')
  const sourceGeometry = (await frame.boundingBox())!
  const title = (await frame.locator('.window-name').boundingBox())!
  await page.mouse.move(title.x + title.width / 2, title.y + title.height / 2)
  await page.mouse.down()
  await page.mouse.move(title.x + title.width / 2 + 30, title.y + title.height / 2 + 20, { steps: 8 })
  await page.mouse.up()
  await expect.poll(async () => Math.round(((await frame.boundingBox())!).x - sourceGeometry.x)).toBe(30)
  await expect.poll(async () => Math.round(((await frame.boundingBox())!).y - sourceGeometry.y)).toBe(20)
  const sample = async (fields: Partial<WidgetSnapshot>) => {
    const widget = await ui.find(fields)
    const center = await ui.center(widget)
    return page.evaluate(({ widget, center }) => {
      const canvases = [
        ...document.getElementById('qt-shadow-container')!.shadowRoot!.querySelectorAll<HTMLCanvasElement>('canvas.qt-window-canvas'),
      ]
        .filter((c) => {
          const r = c.getBoundingClientRect()
          return r.x <= center[0] && center[0] <= r.right && r.y <= center[1] && center[1] <= r.bottom
        })
        .sort((a, b) => a.width * a.height - b.width * b.height)
      const canvas = canvases[0]
      const rect = canvas.getBoundingClientRect()
      const scale = canvas.width / rect.width
      const x = Math.round((center[0] - widget.width / 2 - rect.x) * scale)
      const y = Math.round((center[1] - widget.height / 2 - rect.y) * scale)
      return {
        width: widget.width,
        height: widget.height,
        pixels: [
          ...canvas.getContext('2d')!.getImageData(x, y, Math.round(8 * scale), Math.round(8 * scale)).data,
        ],
      }
    }, { widget, center })
  }
  const change = async (id: string, key: string) => {
    await page.locator('#settings-toggle').click()
    await page.locator(`#${id}`).focus()
    await page.keyboard.press(key)
    await page.locator('#settings-close').click()
  }
  const button = { standardButton: 4194304 }
  const defaultButton = await sample(button)
  await change('control-radius', 'Home')
  await expect.poll(async () => (await sample(button)).pixels).not.toEqual(defaultButton.pixels)
  const squareButton = await sample(button)
  await change('control-radius', 'End')
  await expect.poll(async () => (await sample(button)).pixels).not.toEqual(squareButton.pixels)
  const roundButton = await sample(button)
  expect(roundButton.width).toBe(squareButton.width)
  expect(roundButton.height).toBe(squareButton.height)
  await change('window-radius', 'End')
  await expect(frame).toHaveCSS('border-radius', '24px')
  await ui.shot('rounded-cache-picker')
  const picker = await frameFor({ class: 'KisPreviewFileDialog' })
  await expect(picker).toHaveCSS('border-radius', '24px')
  const roundInput = await sample({ name: 'fileNameEdit' })
  await change('control-radius', 'Home')
  await expect.poll(async () => (await sample({ name: 'fileNameEdit' })).pixels).not.toEqual(roundInput.pixels)
  await change('window-radius', 'Home')
  await expect(picker).toHaveCSS('border-radius', '0px')
  await change('window-radius', 'End')
  const geometry = (await picker.boundingBox())!
  const handle = (await picker.locator('.resize-outline.se').boundingBox())!
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2)
  await page.mouse.down()
  await page.mouse.move(handle.x + handle.width / 2 + 50, handle.y + handle.height / 2 + 30, { steps: 10 })
  await page.mouse.up()
  await expect.poll(async () => Math.round(((await picker.boundingBox())!).width - geometry.width)).toBe(50)
  await picker.locator('.title-bar .action-button').nth(1).click()
  await expect(picker).toHaveClass(/maximized/)
  await expect(picker).toHaveCSS('border-radius', '0px')
  await picker.locator('.title-bar .action-button').first().click()
  await expect(picker).not.toHaveClass(/maximized/)
  await expect(picker).toHaveCSS('border-radius', '24px')
  await page.locator('#settings-toggle').click()
  await page.locator('#appearance').selectOption('light')
  await expect.poll(() => page.evaluate(() => kritaPalette!.dark)).toBe(false)
  await page.locator('#settings-close').click()
  const lightInput = await sample({ name: 'fileNameEdit' })
  await page.locator('#settings-toggle').click()
  await page.locator('#appearance').selectOption('dark')
  await expect.poll(() => page.evaluate(() => kritaPalette!.dark)).toBe(true)
  await page.locator('#settings-close').click()
  await expect.poll(async () => (await sample({ name: 'fileNameEdit' })).pixels).not.toEqual(lightInput.pixels)
  await page.locator('#settings-toggle').click()
  await page.locator('#widget-style').selectOption('windows')
  await expect.poll(() => page.evaluate(() => kritaWidgetStyleState!.current)).toBe('windows')
  await page.locator('#settings-close').click()
  await ui.shot('rounded-cache-Windows-dark')
  await ui.click({ standardButton: 4194304 })
  await ui.wait(async () => !await ui.find({ class: 'KisPreviewFileDialog' }), 'cache picker cancelled')
  expect((await ui.snapshot(true)).filter(d => d.class === 'KritaTestDocument')).toEqual(before)
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('krita.corner-radius')!))).toEqual({ window: 24, controls: 0 })
  // Retain a real native control's square raster as the reload reference.
  await page.keyboard.press('Control+o')
  await expect(page.locator('#file-open')).toBeVisible()
  await expect(page.locator('#file-open')).toHaveCSS('border-radius', '24px')
  await page.locator('#file-cache').click()
  await ui.wait(() => ui.find({ class: 'KisPreviewFileDialog' }), 'square picker before reload')
  const squareBeforeReload = await sample(button)
  web.statuses.length = 0
  await page.reload({ waitUntil: 'domcontentloaded' })
  await ui.waitForStartup()
  await expect(page.locator('#window-radius')).toHaveValue('24')
  await expect(page.locator('#control-radius')).toHaveValue('0')
  await page.keyboard.press('Control+o')
  await expect(page.locator('#file-open')).toBeVisible()
  await expect(page.locator('#file-open')).toHaveCSS('border-radius', '24px')
  await page.locator('#file-cache').click()
  await ui.wait(() => ui.find({ class: 'KisPreviewFileDialog' }), 'native picker after reload')
  await expect(await frameFor({ class: 'KisPreviewFileDialog' })).toHaveCSS('border-radius', '24px')
  expect(await sample(button)).toEqual(squareBeforeReload)
  await change('control-radius', 'End')
  await expect.poll(async () => (await sample(button)).pixels).not.toEqual(squareBeforeReload.pixels)
  ui.web.check()
  ui.write('corners.json', {
    defaults: [8, 4],
    defaultButton,
    squareButton,
    roundButton,
    roundInput,
    documentPreserved: before,
    reloadRetained: true,
  })
})

test('floating widget styles synchronize with native menus and survive reload', async ({ page, web }, info) => {
  const ui = new KritaUI(page, web, info)
  await ui.start('&lang=en')
  const select = page.locator('#widget-style')
  const state = () => page.evaluate(() => window.kritaWidgetStyleState)
  await expect(select).toBeEnabled()
  await expect(select.locator('option')).toHaveText(['Windows', 'Fusion'])
  await expect(select).toHaveValue('fusion')
  await ui.paint()
  const before = (await ui.snapshot(true)).filter(item => item.class === 'KritaTestDocument')
  const documentId = await page.evaluate(() => window.kritaStyleDocumentId = crypto.randomUUID())
  await page.locator('#settings-toggle').click()
  await expect(page.locator('#widget-style-label')).toHaveText('Widget style')
  await select.selectOption('windows')
  await expect(select).toBeEnabled()
  await expect.poll(state).toMatchObject({ current: 'windows', qtStyle: 'windows' })
  expect((await ui.snapshot(true)).filter(item => item.class === 'KritaTestDocument')).toEqual(before)
  expect(await page.evaluate(() => window.kritaStyleDocumentId)).toBe(documentId)
  await page.locator('#settings-close').click()
  await ui.click({ action: 'settings' })
  await ui.click({ action: 'style_menu' })
  await ui.wait(async () => (await ui.find({ class: 'QMenuAction', text: 'Windows' }))?.checked, 'native Windows action reflects page selection')
  await ui.shot('windows-native-style-menu')
  await ui.click({ class: 'QMenuAction', text: 'Fusion' })
  await expect(select).toHaveValue('fusion')
  await expect.poll(state).toMatchObject({ current: 'fusion', qtStyle: 'fusion' })
  expect(await page.evaluate(() => localStorage.getItem('krita.widget-style'))).toBe('fusion')
  expect((await ui.snapshot(true)).filter(item => item.class === 'KritaTestDocument')).toEqual(before)
  ui.web.check()
  await page.locator('#settings-toggle').click()
  await select.selectOption('windows')
  await expect(select).toBeEnabled()
  await expect.poll(() => page.evaluate(() => localStorage.getItem('krita.widget-style'))).toBe('windows')
  await ui.shot('windows-floating-settings')
  web.statuses.length = 0
  await page.goto(`${web.url}/?test=1&lang=zh_CN`, { waitUntil: 'domcontentloaded' })
  await ui.waitForStartup()
  await expect(select).toBeEnabled()
  await expect(select).toHaveValue('windows')
  await expect.poll(state).toMatchObject({ current: 'windows', qtStyle: 'windows' })
  await page.locator('#settings-toggle').click()
  await expect(page.locator('#widget-style-label')).toHaveText('控件风格')
  await ui.shot('windows-restored-Chinese-settings')
  await select.selectOption('fusion')
  await expect.poll(state).toMatchObject({ current: 'fusion', qtStyle: 'fusion' })
  await page.locator('#settings-close').click()
  await ui.paint()
  await ui.undoRedo()
  ui.web.check()
  await ui.click({ action: 'window' })
  await ui.click({ action: 'view_newwindow' })
  await ui.wait(async () => (await ui.snapshot()).filter(item => item.class === 'KisMainWindow').length === 2, 'second native Krita window')
  await page.locator('#settings-toggle').click()
  await select.selectOption('windows')
  await expect(select).toBeEnabled()
  await expect.poll(state).toMatchObject({ current: 'windows', qtStyle: 'windows' })
  await ui.shot('windows-second-main-window')
  ui.web.check()
  ui.write('widget-style.json', {
    initialDocumentPreserved: before,
    final: await state(),
    survivedReload: true,
    nativeMenuSynchronized: true,
    secondMainWindow: true,
  })
})

test('appearance choices during startup do not hide later native theme changes', async ({ page }) => {
  const server = await createServer({
    server: { host: '127.0.0.1', port: 0 },
  })
  await server.listen()
  try {
    await page.emulateMedia({ colorScheme: 'light' })
    await page.route('**/', route => route.fulfill({
      contentType: 'text/html',
      body: '<select id="appearance"><option>auto</option><option>light</option><option>dark</option></select><div id="qt-shadow-container"></div>',
    }))
    await page.goto(server.resolvedUrls!.local[0])
    const observed = await page.evaluate(async () => {
      document.querySelector('#qt-shadow-container')!.attachShadow({ mode: 'open' })
      const { installAppearance } = await import(`${location.origin}/settings.ts`)
      const select = document.querySelector<HTMLSelectElement>('#appearance')!
      const appearance = installAppearance(select, localStorage)
      const choose = (value: string) => {
        select.value = value
        select.dispatchEvent(new Event('change'))
      }
      choose('dark')
      appearance.connectNative(() => 1)
      choose('light')
      globalThis.kritaPalette = {
        dark: false,
        window: '#ffffff',
        windowText: '#000000',
        button: '#ffffff',
        buttonText: '#000000',
        border: '#aaaaaa',
        accent: '#0000ff',
        accentText: '#ffffff',
        link: '#0000ff',
      }
      window.dispatchEvent(new Event('krita-palette-change'))
      globalThis.kritaPalette.dark = true
      window.dispatchEvent(new Event('krita-palette-change'))
      return {
        selected: select.value,
        saved: localStorage.getItem('krita.color-scheme'),
        rendered: document.documentElement.dataset.colorScheme,
      }
    })
    expect(observed).toEqual({ selected: 'dark', saved: 'dark', rendered: 'dark' })
  }
  finally {
    await server.close()
  }
})

for (const initial of ['light', 'dark'] as const) {
  test(`appearance follows browser, manual choice and native themes (${initial})`, async ({ page, context, web }, info) => {
    await page.emulateMedia({ colorScheme: initial })
    await page.addInitScript(() => {
      window.addEventListener('krita-palette-change', () => {
        window.kritaFirstPalette ||= window.kritaPalette
      })
    })
    const ui = new KritaUI(page, web, info)
    const language = initial === 'dark'
      ? 'zh_CN'
      : 'en'
    const opposite = initial === 'dark'
      ? 'light'
      : 'dark'
    const select = page.locator('#appearance')
    const palette = () => page.evaluate(() => window.kritaPalette!)
    const waitScheme = async (value: string) => {
      await expect.poll(async () => (await palette())?.dark).toBe(value === 'dark')
      await expect(page.locator('html')).toHaveAttribute('data-color-scheme', value)
    }
    const openSettings = async () => {
      await page.locator('#settings-toggle').click()
      await expect(page.locator('#page-settings')).toBeVisible()
    }
    const choose = async (value: string) => {
      await openSettings()
      await select.selectOption(value)
      await waitScheme(value === 'auto'
        ? opposite
        : value)
      await page.locator('#settings-close').click()
    }
    const frames: unknown[] = []
    const inspectDialog = async (name: string) => {
      const dialog = await ui.find({ class: 'KisOpenPane' })
      const expected = await palette()
      const rgb = (hex: string) => `rgb(${[1, 3, 5].map(n => Number.parseInt(hex.slice(n, n + 2), 16)).join(', ')})`
      const inspect = () => page.evaluate(({ dialog, expected }) => {
        const root = document.getElementById('qt-shadow-container')!.shadowRoot!
        const canvas = [
          ...root.querySelectorAll<HTMLCanvasElement>('canvas.qt-window-canvas'),
        ].find((c) => {
          const r = c.getBoundingClientRect()
          return r.width === dialog.width && r.height === dialog.height
        })
        if (!canvas)
          return null
        const frame = canvas.closest<HTMLElement>('.qt-decorated-window')!
        const style = getComputedStyle(frame)
        const text = getComputedStyle(frame.querySelector<HTMLElement>('.window-name')!)
        const image = [
          ...frame.querySelectorAll<HTMLElement>('.title-bar .action-button img'),
        ].find(img => img.getClientRects().length)
        const target = [1, 3, 5].map(n => Number.parseInt(expected.window.slice(n, n + 2), 16))
        const pixels = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data
        let matching = 0
        for (let i = 0; i < pixels.length; i += 4) {
          if (pixels[i] === target[0] && pixels[i + 1] === target[1] && pixels[i + 2] === target[2] && pixels[i + 3] === 255)
            matching++
        }
        return {
          background: style.backgroundColor,
          border: style.borderColor,
          borderWidth: style.borderWidth,
          foreground: text.color,
          inactive: frame.classList.contains('inactive'),
          filter: getComputedStyle(image!).filter,
          matchingFraction: matching / (canvas.width * canvas.height),
        }
      }, { dialog, expected })
      await expect.poll(async () => (await inspect())?.matchingFraction, { message: 'native dialog paints the selected palette' }).toBeGreaterThan(0.05)
      await expect.poll(async () => (await inspect())?.filter, { message: 'title-bar icon contrast transition completes' }).toBe(expected.dark ? 'invert(1)' : 'none')
      const state = (await inspect())!
      expect(state.background).toBe(rgb(expected.window))
      expect(state.foreground).toBe(rgb(expected.windowText))
      expect(state.border).toBe(rgb(expected.border))
      expect(state.borderWidth).toBe('1px')
      expect(state.filter).toBe(expected.dark ? 'invert(1)' : 'none')
      frames.push({ name, palette: expected, frame: state })
      await ui.shot(name)
    }
    const newDialog = async () => {
      await ui.click({ action: 'file_new' })
      await ui.wait(() => ui.find({ class: 'KisOpenPane' }), 'native New Image dialog')
    }
    const cancel = async () => {
      await ui.click({ buttonBox: 'newDialogConfirmationButtonBox', standardButton: 4194304 })
      await ui.wait(async () => !await ui.find({ class: 'KisOpenPane' }), 'New Image dialog cancellation')
    }
    await ui.start(`&lang=${language}`)
    await waitScheme(initial)
    expect(await page.evaluate(() => window.kritaFirstPalette!.dark)).toBe(initial === 'dark')
    await expect(select).toHaveValue('auto')
    expect(await page.evaluate(() => localStorage.getItem('krita.color-scheme'))).toBeNull()
    await newDialog()
    await inspectDialog(`initial-${initial}`)
    await page.emulateMedia({ colorScheme: opposite })
    await waitScheme(opposite)
    await inspectDialog(`live-browser-${opposite}`)
    await cancel()
    await ui.paint()
    await ui.wait(async () => (await ui.documents())[0]?.undoIndex === 1, 'stroke committed to native undo history')
    const before = (await ui.snapshot(true)).filter(d => d.class === 'KritaTestDocument')
    const documentId = await page.evaluate(() => window.kritaAppearanceDocument = crypto.randomUUID())
    await choose(initial)
    await page.emulateMedia({ colorScheme: initial })
    await page.emulateMedia({ colorScheme: opposite })
    await page.evaluate(() => new Promise(requestAnimationFrame))
    await waitScheme(initial)
    await expect(select).toHaveValue(initial)
    expect(await page.evaluate(() => localStorage.getItem('krita.color-scheme'))).toBe(initial)
    expect(await page.evaluate(() => window.kritaAppearanceDocument)).toBe(documentId)
    expect((await ui.snapshot(true)).filter(d => d.class === 'KritaTestDocument')).toEqual(before)
    await openSettings()
    await page.locator('#widget-style').selectOption('windows')
    await expect.poll(() => page.evaluate(() => window.kritaWidgetStyleState!.qtStyle)).toBe('windows')
    await waitScheme(initial)
    await page.locator('#settings-close').click()
    await newDialog()
    await inspectDialog(`manual-${initial}-Windows`)
    await cancel()
    web.statuses.length = 0
    await page.reload({ waitUntil: 'domcontentloaded' })
    await ui.waitForStartup()
    await waitScheme(initial)
    await expect(select).toHaveValue(initial)
    expect(await page.evaluate(() => window.kritaFirstPalette!.dark)).toBe(initial === 'dark')
    await openSettings()
    await expect(page.locator('#appearance-label')).toHaveText(language === 'zh_CN'
      ? '外观'
      : 'Appearance')
    await expect(select.locator('option')).toHaveText(language === 'zh_CN'
      ? ['跟随浏览器', '浅色', '深色']
      : ['Follow browser', 'Light', 'Dark'])
    await select.selectOption('auto')
    await waitScheme(opposite)
    expect(await page.evaluate(() => localStorage.getItem('krita.color-scheme'))).toBeNull()
    await page.locator('#settings-close').click()
    await ui.click({ action: 'settings' })
    await ui.click({ action: 'theme_menu' })
    const nativeTheme = initial === 'dark'
      ? 'Krita darker'
      : 'Krita bright'
    await ui.click({ class: 'QMenuAction', text: nativeTheme })
    await waitScheme(initial)
    await expect(select).toHaveValue(initial)
    expect(await page.evaluate(() => localStorage.getItem('krita.color-scheme'))).toBe(initial)
    await newDialog()
    await inspectDialog(`native-theme-${initial}`)
    await cancel()
    ui.web.check()
    const manual = await context.newPage()
    await manual.emulateMedia({ colorScheme: initial })
    await manual.goto(web.previewURL, { waitUntil: 'domcontentloaded' })
    await expect(manual.locator('#bundle-panel')).toBeVisible()
    await expect(manual.locator('html')).toHaveAttribute('data-color-scheme', initial)
    expect(await manual.evaluate(() => localStorage.getItem('krita.color-scheme'))).toBeNull()
    await manual.screenshot({
      path: info.outputPath(`manual-loader-${initial}.png`),
    })
    await manual.close()
    ui.write('appearance.json', {
      initial,
      manualPersisted: true,
      nativeTheme,
      frames,
      documentPreserved: before,
    })
  })
}

test.describe('Manual release bundle loader', () => {
  test.use({ locale: 'en-US' })
  test('all supported languages translate the loader before importing a runtime', async ({ page, web }, info) => {
    for (const [code, messages] of Object.entries(downloadMessages)) {
      await page.goto(`${web.previewURL}/?lang=${encodeURIComponent(code)}&test=1`, { waitUntil: 'domcontentloaded' })
      await expect(page.locator('#bundle-panel'), code).toBeVisible()
      await expect(page.locator('html')).toHaveAttribute('lang', languageTag(code)!)
      await expect(page.locator('html')).toHaveAttribute('dir', ['ar', 'fa', 'he', 'ug'].includes(code)
        ? 'rtl'
        : 'ltr')
      await expect(page.locator('#bundle-prompt')).toHaveText(messages.bundlePrompt.replace('{filename}', 'krita.bundle.tar.gz'))
      await expect(page.locator('#bundle-release')).toHaveText(messages.download)
      await expect(page.locator('#bundle-choose')).toHaveText(messages.filePrompt)
      await expect(page.locator('#bundle-cache')).toHaveText(messages.bundleCache)
      await expect(page.locator('#failure')).toBeHidden()
      web.check()
      if (['el', 'ug', 'zh_CN'].includes(code)) {
        await page.screenshot({
          path: info.outputPath(`loader-${code}.png`),
        })
      }
    }
    expect(web.requests.some(path => /\.(?:wasm|tar\.gz)$/.test(path) || path.endsWith('/krita.js'))).toBe(false)
  })
  for (const method of ['picker', 'drop']) {
    test(`download, ${method}, paint and cached reload`, async ({ page, web }, info) => {
      // The picker scenario starts the real runtime in six separate page loads.
      if (method === 'picker')
        info.setTimeout(420_000)
      const previewURL = method === 'drop'
        ? `${web.previewURL}/nested`
        : web.previewURL
      const ui = new KritaUI(page, { ...web, url: previewURL }, info)
      expect(new URL(ui.web.url).port).not.toBe(new URL(web.url).port)
      await page.goto(`${ui.web.url}/?test=1`, { waitUntil: 'domcontentloaded' })
      await expect(page.locator('#bundle-panel')).toBeVisible()
      expect(web.requests.some(path => /\.(?:wasm|tar\.gz)$/.test(path) || path.endsWith('/krita.js'))).toBe(false)
      await page.evaluate(() => localStorage.setItem('krita.test.preview', 'separate-port'))
      const dev = await page.context().newPage()
      await dev.goto(`${web.url}/__blank`)
      expect(await dev.evaluate(() => localStorage.getItem('krita.test.preview'))).toBeNull()
      await dev.close()
      await page.locator('#bundle-file').setInputFiles({
        name: 'wrong.tar.gz',
        mimeType: 'application/gzip',
        buffer: Buffer.from('wrong release'),
      })
      await expect(page.locator('#bundle-error')).toContainText('Error:')
      await expect(page.locator('#bundle-panel')).toBeVisible()
      const descriptor = await (await page.request.get(`${previewURL}/bundle.json`)).json()
      const file = info.outputPath('downloaded-krita.bundle.tar.gz')
      if (descriptor.release_url) {
        await expect(page.locator('#bundle-release')).toHaveAttribute('href', descriptor.release_url)
        const response = await page.request.get(`${previewURL}/krita.bundle.tar.gz`)
        expect(response.ok()).toBe(true)
        writeFileSync(file, await response.body())
      }
      else {
        const pending = page.waitForEvent('download')
        await page.locator('#bundle-release').click()
        const download = await pending
        await download.saveAs(file)
        expect(await download.failure()).toBeNull()
      }
      const malformed = info.outputPath('malformed-i18n.tar.gz')
      const brokenResources = info.outputPath('malformed-resources.tar.gz')
      const incompatible = info.outputPath('incompatible-runtime.tar.gz')
      execFileSync('python3', [
        '-c',
        `
import io
import sys
import tarfile

conflicting = io.BytesIO()
with tarfile.open(fileobj=conflicting, mode='w', format=tarfile.USTAR_FORMAT) as resources:
    for name in ('krita/share/item', 'krita/share/item/image.png'):
        entry = tarfile.TarInfo(name)
        entry.size = 1
        resources.addfile(entry, io.BytesIO(b'x'))

variants = [
    (sys.argv[1], 'i18n.json', b'{broken'),
    (sys.argv[2], 'resources.tar', conflicting.getvalue()),
    (sys.argv[3], 'runtime.json', sys.argv[4].encode()),
]
for output, name, data in variants:
    with tarfile.open(output, 'w:gz', format=tarfile.USTAR_FORMAT) as archive:
        for member, contents in (('COPYING', b'test fixture'), (name, data)):
            entry = tarfile.TarInfo(member)
            entry.size = len(contents)
            archive.addfile(entry, io.BytesIO(contents))
`,
        malformed,
        brokenResources,
        incompatible,
        JSON.stringify({
          jspi: method === 'drop',
          cxx_exceptions: method === 'drop'
            ? 'emscripten-js'
            : 'wasm-native',
          startup_event: 'krita-ready',
          file_dialog: 'linked-batch',
        }),
      ])
      await page.locator('#bundle-file').setInputFiles(malformed)
      await expect(page.locator('#bundle-file')).toBeEnabled()
      await expect(page.locator('#bundle-error')).not.toBeEmpty()
      await page.locator('#bundle-file').setInputFiles(incompatible)
      await expect(page.locator('#bundle-error')).toContainText('Invalid runtime configuration')
      await expect(page.locator('#bundle-file')).toBeEnabled()
      await page.reload({ waitUntil: 'domcontentloaded' })
      await expect(page.locator('#bundle-panel')).toBeVisible()
      const dropFile = async (variant: boolean) => {
      // Playwright supplies an actual downloaded File; the browser's drop
      // event passes that same File through the product's drop handler.
        await page.evaluate(() => {
          const input = document.createElement('input')
          input.type = 'file'
          input.id = 'drop-transfer'
          input.hidden = true
          document.body.appendChild(input)
        })
        await page.locator('#drop-transfer').setInputFiles(file)
        return await page.evaluate(async (variant) => {
          const original = (document.getElementById('drop-transfer')! as HTMLInputElement).files![0]
          let file = original
          if (variant) {
          // A valid gzip filename header changes both archive bytes and size
          // while preserving the complete real Krita runtime underneath.
            const header = new Uint8Array(await original.slice(0, 10).arrayBuffer())
            if (header[3] !== 0)
              throw new Error('Expected the deterministic gzip fixture to have no optional header.')
            header[3] = 8
            file = new File([
              header,
              'another-release\0',
              original.slice(10),
            ], original.name)
          }
          const data = new DataTransfer()
          data.items.add(file)
          document.getElementById('bundle-drop')!.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }))
          document.getElementById('drop-transfer')!.remove()
          return { originalBytes: original.size, importedBytes: file.size }
        }, variant)
      }
      const runtimeId = () => page.evaluate(async () => {
        const scope = new URL('./', location.href)
        const cache = await caches.open(`krita-runtime-v2:${scope.href}`)
        return (await (await cache.match(new URL('.runtime/active.json', scope)))!.json()).id
      })
      let alternateArchive: { importedBytes: number, originalBytes: number } | undefined
      if (method === 'picker') {
        await page.locator('#bundle-file').setInputFiles(file)
      }
      else {
        alternateArchive = await dropFile(true)
      }
      await ui.waitForStartup()
      await ui.verifyStartup('en_US')
      const firstRuntime = await runtimeId()
      expect(await page.evaluate(() => navigator.serviceWorker.controller!.scriptURL)).toBe(`${previewURL}/isolation-sw.js`)
      await ui.paint()
      await ui.undoRedo()
      ui.web.check()
      expect(web.requests.filter(path => path.endsWith('/krita.bundle.tar.gz'))).toHaveLength(1)
      web.statuses.length = 0
      await page.reload({ waitUntil: 'domcontentloaded' })
      await ui.waitForStartup()
      await expect(page.locator('#bundle-panel')).toBeHidden()
      expect(await runtimeId()).toBe(firstRuntime)
      expect(await ui.documents()).toEqual([])
      expect(web.requests.filter(path => path.endsWith('/krita.bundle.tar.gz'))).toHaveLength(1)
      expect(web.requests.filter(path => path.endsWith('.wasm') || (path.includes('/assets/') && !/\.(?:js|css)$/.test(path)))).toEqual([])
      if (method === 'drop') {
        const originalMetadata = await page.evaluate(async () => {
          const scope = new URL('./', location.href)
          const cache = await caches.open(`krita-runtime-v2:${scope.href}`)
          const { id } = await (await cache.match(new URL('.runtime/active.json', scope)))!.json()
          const url = new URL(`.runtime/${id}/runtime.json`, scope).href
          const response = (await cache.match(url))!
          const text = await response.text()
          const data = JSON.parse(text)
          data.file_dialog = 'incompatible'
          const bytes = new TextEncoder().encode(JSON.stringify(data))
          // Keep the recorded length valid so the ABI check is exercised.
          const active = await (await cache.match(new URL('.runtime/active.json', scope)))!.json()
          active.files['runtime.json'] = bytes.length
          await cache.put(url, new Response(bytes, {
            headers: {
              'Content-Length': String(bytes.length),
            },
          }))
          await cache.put(new URL('.runtime/active.json', scope), Response.json(active))
          return { url, text, active }
        })
        const incompatiblePage = await page.context().newPage()
        try {
          await incompatiblePage.goto(`${previewURL}/?lang=en`, { waitUntil: 'domcontentloaded' })
          await expect(incompatiblePage.locator('#bundle-panel')).toBeVisible()
          await expect(incompatiblePage.locator('#failure')).toBeHidden()
        }
        finally {
          await incompatiblePage.close()
          await page.evaluate(async ({ url, text, active }) => {
            const scope = new URL('./', location.href)
            const cache = await caches.open(`krita-runtime-v2:${scope.href}`)
            active.files['runtime.json'] = new TextEncoder().encode(text).length
            await cache.put(url, new Response(text, {
              headers: {
                'Content-Length': String(active.files['runtime.json']),
              },
            }))
            await cache.put(new URL('.runtime/active.json', scope), Response.json(active))
          }, originalMetadata)
        }
      }
      if (method === 'picker') {
        const invalidLink = await page.context().newPage()
        try {
          await invalidLink.addInitScript(() => {
            const fetch = window.fetch
            window.fetch = async (resource, init) => {
              const response = await fetch(resource, init)
              const url = resource instanceof Request
                ? resource.url
                : String(resource)
              if (!url.endsWith('/bundle.json'))
                return response
              return Response.json({
                ...await response.json(),
                release_url: 'https://github.com%2F/OWNER/REPO/releases',
              })
            }
          })
          await invalidLink.goto(`${previewURL}/?bundle=choose&lang=en`, { waitUntil: 'domcontentloaded' })
          await expect(invalidLink.locator('#bundle-panel')).toBeVisible()
          await expect(invalidLink.locator('#bundle-release')).toBeHidden()
          await invalidLink.locator('#bundle-file').setInputFiles({
            name: 'invalid.tar.gz',
            mimeType: 'application/gzip',
            buffer: Buffer.from('not an archive'),
          })
          await expect(invalidLink.locator('#bundle-error')).not.toBeEmpty()
        }
        finally {
          await invalidLink.close()
        }
        // The candidate still contains the real Wasm and manifest, but its
        // JavaScript glue drops a required export before Krita's preRun.
        const missingBridge = await page.context().newPage()
        try {
          await missingBridge.addInitScript(() => {
            const put = Cache.prototype.put
            Cache.prototype.put = async function (request, response) {
              if (String(request).endsWith('/krita.js')) {
                const script = await response.text()
                response = new Response(`${script}
;{ const original = kritaWasm
  kritaWasm = (options) => {
    options.preRun.unshift((instance) => { delete instance._kritaWasmSetWidgetStyle })
    return original(options)
  }
}`, { headers: response.headers })
              }
              return put.call(this, request, response)
            }
          })
          await missingBridge.goto(`${previewURL}/?bundle=choose&lang=en`, { waitUntil: 'domcontentloaded' })
          await missingBridge.locator('#bundle-file').setInputFiles(file)
          await expect(missingBridge.locator('#failure-stack')).toContainText('Missing native runtime export: _kritaWasmSetWidgetStyle')
          expect(await runtimeId()).toBe(firstRuntime)
        }
        finally {
          await missingBridge.close()
        }
        // A cached runtime that fails to instantiate must not retain the
        // shared generation lease needed by quota-limited replacement.
        for (const mode of ['wasm', 'native'] as const) {
          const failed = await page.context().newPage()
          await failed.addInitScript((mode) => {
            if (mode === 'native') {
              const dispatch = window.dispatchEvent
              window.dispatchEvent = function (event) {
                return dispatch.call(this, event.type === 'krita-ready'
                  ? new CustomEvent('krita-startup-failed', { detail: 'Injected native startup failure' })
                  : event)
              }
              return
            }
            const fail = async () => {
              throw new WebAssembly.CompileError('Injected cached startup failure')
            }
            WebAssembly.instantiate = fail
            WebAssembly.instantiateStreaming = fail
          }, mode)
          // No test transport on the intentionally failing page.
          await failed.goto(`${previewURL}/?lang=en`, { waitUntil: 'domcontentloaded' })
          await expect(failed.locator('#failure')).toBeVisible({ timeout: 90_000 })
          await expect(failed.locator('#failure-stack')).toContainText(mode === 'native'
            ? 'Injected native startup failure'
            : 'Injected cached startup failure')
          await expect.poll(() => failed.evaluate(async () => {
            const marker = `krita-test-pin:${crypto.randomUUID()}`
            let release: () => void = () => {}
            await new Promise<void>((resolve) => {
              void navigator.locks.request(marker, () => new Promise<void>((unlock) => {
                release = unlock
                resolve()
              }))
            })
            try {
              const { held = [] } = await navigator.locks.query()
              const owner = held.find(lock => lock.name === marker)!.clientId
              return held.filter(lock => lock.clientId === owner && lock.name?.startsWith('krita-runtime-v2:')).length
            }
            finally { release() }
          })).toBe(0)
          await failed.close()
        }
        const older = await page.context().newPage()
        const olderUI = new KritaUI(older, { ...web, url: previewURL }, info)
        await olderUI.start()
        await olderUI.wait(() => olderUI.find({ class: 'KisMainWindow' }), 'second tab keeps the original runtime')
        page.once('dialog', dialog => dialog.accept())
        web.statuses.length = 0
        await page.locator('#settings-toggle').click()
        await page.locator('#bundle-replace').click()
        await expect(page.locator('#bundle-panel')).toBeVisible()
        await page.locator('#bundle-file').setInputFiles(brokenResources)
        await expect(page.locator('#bundle-error')).toContainText('Archive file and directory conflict.')
        await expect(page.locator('#bundle-panel')).toBeVisible()
        expect(await runtimeId()).toBe(firstRuntime)
        alternateArchive = await dropFile(true)
        await ui.waitForStartup()
        await ui.verifyStartup('en_US')
        const replacementRuntime = await runtimeId()
        expect(replacementRuntime).not.toBe(firstRuntime)
        // An older tab can request its own chooser without erasing the newer
        // published selection that other tabs will reuse.
        older.once('dialog', dialog => dialog.accept())
        await older.locator('#settings-toggle').click()
        await older.locator('#bundle-replace').click()
        await expect(older.locator('#bundle-panel')).toBeVisible()
        expect(await runtimeId()).toBe(replacementRuntime)
        await older.close()
        web.statuses.length = 0
        await page.reload({ waitUntil: 'domcontentloaded' })
        await ui.waitForStartup()
        await expect(page.locator('#bundle-panel')).toBeHidden()
        expect(await runtimeId()).toBe(replacementRuntime)
        const generations = await page.evaluate(async () => {
          const scope = new URL('./', location.href)
          const cache = await caches.open(`krita-runtime-v2:${scope.href}`)
          return [
            ...new Set((await cache.keys()).map(request => request.url.match(/\.runtime\/([a-f0-9]{32})\//)?.[1]).filter(Boolean)),
          ]
        })
        expect(generations).toEqual([await runtimeId()])
        await ui.paint()
        await ui.undoRedo()
        ui.web.check()
      }
      expect(alternateArchive!.importedBytes).toBeGreaterThan(alternateArchive!.originalBytes)
      const config = await (await page.request.get(`${previewURL}/bundle.json`)).json()
      expect(Object.keys(config).sort()).toEqual([
        'filename',
        'mode',
        'release_url',
        'schema',
      ])
      ui.write('bundle-loader.json', {
        method,
        requests: web.requests,
        cachedReload: true,
        wrongFileRejected: true,
        alternateArchiveAccepted: alternateArchive,
        replacementChecked: method === 'picker',
      })
    })
  }
})

async function localizedDownload(ui: KritaUI, locale: string, code: string, expected: string) {
  const { page, info } = ui
  await ui.verifyStartup(expected)
  await ui.paint()
  await page.keyboard.press('Control+s')
  await ui.wait(() => ui.find({ class: 'KisPreviewFileDialog' }), 'native Save dialog')
  const name = `Localized-${code}.kra`
  await ui.replace({ name: 'fileNameEdit' }, `/Documents/${name}`)
  await page.keyboard.press('Tab')
  await ui.wait(async () => (await ui.find({ standardButton: 2048 }))?.enabled, 'native Save enabled')
  await ui.click({ standardButton: 2048 })
  await ui.wait(() => ui.find({ name: 'kritaWasmDownloadDialog' }), 'completed-save prompt', 180_000)
  const translated = translations[code] || downloadMessages.en
  const label = await ui.find({ name: 'kritaWasmDownloadMessage' })
  const button = await ui.find({ name: 'kritaWasmDownload' })
  expect(label.text).toBe(translated.downloadReady)
  expect(button.text).toBe(translated.download)
  await ui.shot('localized-download-dialog')
  const pending = page.waitForEvent('download')
  await ui.click({ name: 'kritaWasmDownload' })
  const download = await pending
  expect(download.suggestedFilename()).toBe(name)
  const path = info.outputPath(name)
  await download.saveAs(path)
  expect(await download.failure()).toBeNull()
  const kra = artifact('kra', path)
  expect(kra.projection.width).toBe(256)
  expect(kra.projection.height).toBe(256)
  await ui.click({ standardButton: 2097152 })
  await ui.wait(async () => !await ui.find({ name: 'kritaWasmDownloadDialog' }), 'download dialog closes')
  const documents = await ui.documents()
  await page.keyboard.press('Control+o')
  await expect(page.locator('#file-open')).toBeVisible()
  await expect(page.locator('#file-source')).toHaveText(translated.openSource)
  await expect(page.locator('#file-cache')).toHaveText(translated.openCache)
  await expect(page.locator('#device-title')).toHaveText(translated.openDevice)
  await expect(page.locator('#device-choose')).toHaveText(translated.filePrompt)
  await expect(page.locator('dialog[open]')).toHaveCount(1)
  await expect(page.locator('#device-file')).toBeVisible()
  await ui.shot('localized-open-source')
  await page.locator('#file-close').click()
  await expect(page.locator('#file-open')).not.toBeVisible()
  expect(await ui.documents()).toEqual(documents)
  ui.write('localized-download.json', {
    locale,
    code,
    label: label.text,
    button: button.text,
    englishFallback: !translations[code],
    kra,
  })
  ui.web.check()
}

// Cases that reload, recover, restart, quit or open independent tabs keep the
// normal fixtures above. These UI-only cases restore one live workbench.
test.describe('UI workbench', () => {
  for (const [locale, code, expected] of [
    ['en-US', 'en', 'en_US'],
    ['zh-CN', 'zh_CN', 'zh_CN'],
    ['ar', 'ar', 'ar'],
    ['zh-TW', 'zh_TW', 'zh_TW'],
    ['pt-BR', 'pt_BR', 'pt_BR'],
    ['el-GR', 'el', 'el'],
  ]) {
    test.describe(code, () => {
      test.use({ locale })
      if (code === 'en') {
        test('floating settings and native save shortcuts', async ({ workbench }) => {
          const ui = await workbench()
          await ui.paint()
          await floatingSettings(ui)
          await saveShortcuts(ui)
          ui.web.check()
        })
        test('native files and per-view actions', async ({ workbench }) => {
          const ui = await workbench()
          await ui.paint()
          await files(ui)
          await viewActions(ui)
          ui.web.check()
        })
        test('animation worker exports acknowledge cached PNG frames', async ({ workbench }) => {
          const ui = await workbench()
          const { page } = ui
          await ui.paint()
          await page.evaluate(async () => {
            window.kritaTestFS.mkdirTree('/Documents/worker-frames')
            const canvas = document.createElement('canvas')
            canvas.width = 32
            canvas.height = 32
            const ctx = canvas.getContext('2d')!
            ctx.fillStyle = 'red'
            ctx.fillRect(0, 0, 32, 32)
            const blob = await new Promise<Blob>(resolve => canvas.toBlob(blob => resolve(blob!)))
            window.kritaTestFS.writeFile('/Documents/frame0.png', new Uint8Array(await blob.arrayBuffer()))
          })
          await ui.click({ action: 'file' })
          await ui.click({ action: 'file_import_animation' })
          await ui.click({ name: 'btnAddImages' })
          await ui.wait(() => ui.find({ class: 'KritaTestFileItem', filePath: '/Documents/frame0.png' }), 'animation input frame')
          await page.mouse.dblclick(...await ui.center(await ui.find({ class: 'KritaTestFileItem', filePath: '/Documents/frame0.png' })))
          await ui.wait(async () => !await ui.find({ class: 'KisPreviewFileDialog' }), 'frame selected')
          await ui.click({ buttonRole: 0 })
          await ui.wait(async () => !await ui.find({ name: 'btnAddImages' }), 'actual animation imported')
          const render = async (destination: string) => {
            await ui.click({ action: 'file' })
            await ui.click({ action: 'render_animation' })
            await ui.wait(() => ui.find({ name: 'intEnd' }), 'render animation options')
            await ui.replace({ name: 'intStart' }, 0)
            await ui.replace({ name: 'intEnd' }, 1)
            if ((await ui.find({ name: 'chkOnlyUniqueFrames' }))?.checked)
              await ui.click({ name: 'chkOnlyUniqueFrames' })
            await ui.replace({ name: 'txtBasename' }, 'worker-')
            const request = (await ui.find({ name: 'dirRequester' }))!
            const edits = (await ui.snapshot()).filter(w => w.class === 'QLineEdit' && w.x >= request.x && w.y >= request.y && w.x + w.width <= request.x + request.width && w.y + w.height <= request.y + request.height)
            expect(edits).toHaveLength(1)
            await ui.replace({
              class: edits[0].class,
              name: edits[0].name,
              x: edits[0].x,
              y: edits[0].y,
            }, destination)
            await ui.click({ buttonRole: 0 })
            await ui.wait(async () => !await ui.find({ name: 'intEnd' }), 'render options accepted')
          }
          await render('/Documents/worker-frames')
          const entries = async () => (await stored(page, false, 'saved')).filter(file => file.path.startsWith('/Documents/worker-frames/') && file.path.endsWith('.png'))
          await ui.wait(async () => (await entries()).length === 2, 'rendered and copied worker frames durable in actual IndexedDB', 60_000)
          expect(await page.evaluate(() => window.kritaRecovery.error)).toBeNull()
          ui.web.check()
          const frames = await entries()
          expect(frames[0].size).toBeGreaterThan(0)
          expect(frames[1].sha256).toBe(frames[0].sha256)
          // Let the first virtual frame commit, then make the second frame's
          // actual IndexedDB transaction fail. The first must also be removed.
          const rejectSecond = await page.evaluateHandle(() => {
            const put = IDBObjectStore.prototype.put
            let rejected = false
            IDBObjectStore.prototype.put = function (...args) {
              const result = put.apply(this, args)
              if (!rejected && String(args[1]).endsWith('/virtual/home/worker-frames/worker-0001.png')) {
                rejected = true
                const failure = this.add(args[0], args[1])
                failure.onerror = () => this.transaction.abort()
              }
              return result
            }
            return {
              rejected: () => rejected,
              restore: () => { IDBObjectStore.prototype.put = put },
            }
          })
          try {
            await render('/home/worker-frames')
            await ui.wait(() => rejectSecond.evaluate(fault => fault.rejected()), 'second virtual animation frame write was rejected')
            await ui.wait(async () => {
              const virtual = (await stored(page, false, 'virtual')).filter(file => file.path.startsWith('/home/worker-frames/'))
              return virtual.length === 0 && await page.evaluate(() => {
                const fs = window.kritaTestFS
                return !fs.readdir('/home/worker-frames').some(name => name.endsWith('.png'))
              })
            }, 'failed render removes durable frames and their live aliases')
            const errorMessage = { class: 'QLabel', text: 'Failed to render animation frames! Output files are incomplete.' }
            await ui.wait(() => ui.find(errorMessage), 'native animation error shown')
            await ui.click({ standardButton: 1024 })
            await ui.wait(async () => !await ui.find(errorMessage), 'native animation error dismissed')
            expect(await entries()).toEqual(frames)
          }
          finally {
            await rejectSecond.evaluate(fault => fault.restore())
            await rejectSecond.dispose()
          }
          ui.write('actual-animation-worker.json', {
            frames,
            range: [0, 1],
          })
        })
      }
      if (code === 'zh_CN' || code === 'ar') {
        test('new document and actual painting', async ({ workbench }) => {
          const ui = await workbench()
          await ui.verifyStartup(expected)
          if (code === 'zh_CN')
            await ui.wait(() => ui.web.messages.some(message => message.startsWith('KRITA_WASM_CJK_GLYPHS_READY:')), 'Qt CJK glyph coverage')
          await ui.help()
          await ui.paint()
          await ui.undoRedo()
          if (code === 'zh_CN')
            await ui.textProperties()
          ui.web.check()
        })
      }
      test('native Save shows translated text and downloads a valid KRA', async ({ workbench }) => {
        await localizedDownload(await workbench(), locale, code, expected)
      })
      if (code === 'en') {
        test('default A4 restores exact layer pixels after history swap', async ({ workbench }) => {
          const ui = await workbench()
          await ui.verifyStartup('en_US')
          const swapBeforeImage = (await ui.snapshot<{ class: string, swapBytes: number }>()).find(item => item.class === 'KritaTestTileMemory')!.swapBytes
          await ui.paint({ width: 2480, height: 3508 })
          const documentPixels = async () => (await ui.snapshot<DocumentSnapshot>(true)).find(item => item.class === 'KritaTestDocument')!
          const before = await documentPixels()
          expect(before).toMatchObject({ width: 2480, height: 3508 })
          expect(before.undoIndex).toBeGreaterThan(0)
          expect(before.layerPixels).toHaveLength(2)
          const cycles = []
          for (let cycle = 0; cycle < 3; cycle++) {
            await ui.click({ action: 'edit_undo' })
            await ui.wait(async () => await ui.darkPixels() === 0, 'large-canvas Undo removes the stroke')
            const undone = await documentPixels()
            expect(undone.undoIndex).toBe(before.undoIndex - 1)
            expect(undone.canRedo).toBe(true)
            expect(undone.layerPixels).not.toEqual(before.layerPixels)
            // Force history eviction AFTER pixel inspection, which can read
            // tiles back in. No pixel-read snapshot runs before the next Redo.
            await ui.wait(async () => {
              const memory = (await ui.snapshot<{ class: string, swapBytes: number, residentHistoryTiles: number }>(false, true)).find(item => item.class === 'KritaTestTileMemory')!
              return memory.residentHistoryTiles === 0 && memory.swapBytes > swapBeforeImage
            }, 'the stroke history is swapped out before Redo')
            const swapped = (await ui.snapshot(false, true)).find(item => item.class === 'KritaTestTileMemory')
            await ui.click({ action: 'edit_redo' })
            // Incremental downsampling can differ by a few antialiased edge pixels.
            // Require visible ink AND exact raw layer bytes rather than a rendered
            // pixel-count tolerance for the downscaled large image.
            await ui.wait(async () => await ui.darkPixels() > 100, 'large-canvas Redo restores visible ink')
            const restored = await documentPixels()
            expect(restored.undoIndex).toBe(before.undoIndex)
            expect(restored.layerPixels).toEqual(before.layerPixels)
            cycles.push({
              cycle,
              swapped,
              layerPixels: restored.layerPixels,
              renderedDarkPixels: await ui.darkPixels(),
            })
          }
          ui.web.check()
          await ui.shot('large-redo-restored')
          ui.write('swapped-undo-redo.json', {
            width: 2480,
            height: 3508,
            before: before.layerPixels,
            cycles,
          })
        })
      }
    })
  }
})
