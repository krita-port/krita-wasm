import type { Page } from '@playwright/test'
import type { DocumentSnapshot } from './native.js'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { expect, test } from './fixtures.ts'
import { artifact, KritaUI } from './krita-ui.ts'

// Inspect the actual IDBFS database in a separate readonly transaction. A MEMFS
// file, a timer callback or an in-memory "saved" flag is not persistence proof.
async function stored(page: Page, contents = false, kind: 'recovery' | 'saved' = 'recovery') {
  return page.evaluate(async ({ contents, kind }) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(window.kritaRecovery.directory)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    try {
      const entries = await new Promise<{ key: string, contents?: Uint8Array<ArrayBuffer>, mode: number }[]>((resolve, reject) => {
        const transaction = db.transaction('FILE_DATA', 'readonly')
        const store = transaction.objectStore('FILE_DATA')
        const keys = store.getAllKeys()
        const values = store.getAll()
        transaction.oncomplete = () => resolve(keys.result.map((key, i) => ({
          key: String(key),
          ...values.result[i],
        })))
        transaction.onerror = () => reject(transaction.error)
      })
      const storageRoot = window.kritaRecovery.filesStorageDirectory || window.kritaRecovery.filesDirectory
      return await Promise.all(entries.filter(entry => entry.contents && entry.key.startsWith(`${kind === 'saved'
        ? storageRoot
        : window.kritaRecovery.recoveryDirectory}/`)
      && (kind === 'saved'
        ? /\.(?:kra|png)$/.test(entry.key)
        : entry.key.endsWith('-autosave.kra'))).map(async entry => ({
        path: kind === 'saved'
          ? window.kritaRecovery.filesDirectory + entry.key.slice(storageRoot.length)
          : entry.key,
        storagePath: entry.key,
        size: entry.contents!.length,
        sha256: [
          ...new Uint8Array(await crypto.subtle.digest('SHA-256', entry.contents!)),
        ].map(x => x.toString(16).padStart(2, '0')).join(''),
        ...(contents
          ? {
              contents: Array.from(entry.contents!),
            }
          : {}),
      })))
    }
    finally {
      db.close()
    }
  }, { contents, kind })
}

const documents = async (ui: KritaUI) => (await ui.snapshot<DocumentSnapshot>(true)).filter(item => item.class === 'KritaTestDocument')
const fingerprints = (docs: DocumentSnapshot[]) => docs.map(doc => ({ width: doc.width, height: doc.height, layerPixels: doc.layerPixels }))

async function fileAction(ui: KritaUI, action: string) {
  if (!await ui.find({ action }))
    await ui.click({ action: 'file' })
  await ui.click({ action })
}

async function committed(ui: KritaUI, count = 1, previous?: string, kind: 'recovery' | 'saved' = 'recovery') {
  await ui.wait(async () => {
    const files = await stored(ui.page, false, kind)
    return files.length === count && files.every(file => file.size > 0)
      && (!previous || files.some(file => file.sha256 !== previous))
      && await ui.page.evaluate(() => !window.kritaRecovery.pending && !window.kritaRecovery.error)
  }, 'complete KRA committed by actual IDBFS transaction')
  return stored(ui.page, false, kind)
}

async function reloadRecovery(ui: KritaUI, button: number | 'discardAll' = 1024) {
  ui.web.statuses.length = 0
  await ui.page.reload({ waitUntil: 'domcontentloaded' })
  await ui.waitForWidgets()
  await ui.wait(() => ui.find({ class: 'KisAutoSaveRecoveryDialog' }), 'native startup recovery dialog')
  await ui.shot('recovery-dialog')
  // KoDialog creates custom buttons with roles, not Qt StandardButton IDs.
  await ui.click({
    class: 'QPushButton',
    buttonRole: button === 'discardAll'
      ? 3
      : button === 4194304
        ? 1
        : 0,
  })
  await ui.waitForStartup()
}

async function chooseSaveDestination(ui: KritaUI, name: string, location = 'persistent') {
  const activePath = (await ui.canvases()).find(canvas => canvas.active)!.path
  await ui.wait(() => ui.find({ class: 'KisPreviewFileDialog' }), 'native Save dialog')
  expect((await documents(ui)).find(document => document.path === activePath)!.autosaveActive).toBe(false)
  const root = await ui.page.evaluate(() => window.kritaRecovery.filesDirectory)
  if (location !== 'persistent')
    expect((await ui.find({ class: 'KisPreviewFileDialog' }))!.directory).toBe(root)
  if (location === 'home') {
    const homes = (await ui.snapshot()).filter(item => item.class === 'KritaTestFileItem' && item.viewName === 'sidebar' && item.filePath)
    expect(homes).toHaveLength(1)
    await ui.click({ class: 'KritaTestFileItem', viewName: 'sidebar', filePath: homes[0].filePath })
    await ui.wait(async () => (await ui.find({ class: 'KisPreviewFileDialog' }))!.directory === homes[0].filePath, 'native Home directory selected')
  }
  await ui.replace({ name: 'fileNameEdit' }, location === 'persistent'
    ? `${root}/${name}`
    : name)
  await ui.page.keyboard.press('Tab')
  await ui.wait(async () => (await ui.find({ standardButton: 2048 }))?.enabled, 'Save enabled')
  await ui.click({ standardButton: 2048 })
}

async function nativeSave(ui: KritaUI, name: string, action = 'file_save', location = 'persistent') {
  await fileAction(ui, action)
  await chooseSaveDestination(ui, name, location)
  await ui.wait(async () => await ui.find({ class: 'KoDialog' }) || await ui.find({ name: 'kritaWasmDownloadDialog' }), 'save options or completed download')
  if (await ui.find({ class: 'KoDialog' })) {
    for (const name of ['chkForceSRGB', 'tryToSaveAsIndexed']) {
      if ((await ui.find({ name }))?.checked)
        await ui.click({ name })
    }
    await ui.click({ buttonRole: 0 })
  }
  await ui.wait(() => ui.find({ name: 'kritaWasmDownloadDialog' }), 'ordinary save download prompt')
}

async function openCacheDialog(ui: KritaUI, action = 'file_open') {
  await fileAction(ui, action)
  await expect(ui.page.locator('#file-open')).toBeVisible()
  await ui.page.locator('#file-cache').click()
  await ui.wait(() => ui.find({ class: 'KisPreviewFileDialog', acceptMode: 0 }), 'native cache file dialog')
}

async function chooseCachedFile(ui: KritaUI, path: string) {
  const root = await ui.page.evaluate(() => window.kritaRecovery.filesDirectory)
  expect(path.startsWith(`${root}/`)).toBe(true)
  let current = root
  const parts = path.slice(root.length + 1).split('/')
  for (let index = 0; index < parts.length; index++) {
    current += `/${parts[index]}`
    await ui.wait(() => ui.find({ class: 'KritaTestFileItem', filePath: current }), `native file entry ${parts[index]}`)
    await ui.page.mouse.dblclick(...await ui.center(await ui.find({ class: 'KritaTestFileItem', filePath: current })))
    if (index < parts.length - 1)
      await ui.wait(async () => (await ui.find({ class: 'KisPreviewFileDialog' }))?.directory === current, 'native directory changes')
  }
  await ui.wait(async () => !await ui.find({ class: 'KisPreviewFileDialog' }), 'native cached file opens')
}

async function openCachedFile(ui: KritaUI, path: string) {
  await openCacheDialog(ui)
  await chooseCachedFile(ui, path)
}

async function reloadSaved(ui: KritaUI) {
  ui.web.statuses.length = 0
  await ui.page.reload({ waitUntil: 'domcontentloaded' })
  await ui.waitForWidgets()
  await ui.wait(async () => ui.web.statuses.includes('KRITA_WASM_WINDOW_READY') || await ui.find({ class: 'KisAutoSaveRecoveryDialog' }), 'native startup decision')
  expect(await ui.find({ class: 'KisAutoSaveRecoveryDialog' })).toBeUndefined()
  await ui.waitForStartup()
}

async function deviceFixture(ui: KritaUI) {
  await ui.paint()
  await nativeSave(ui, 'Device-fixture.kra')
  await committed(ui, 1, undefined, 'saved')
  const file = (await stored(ui.page, true, 'saved'))[0]
  const path = ui.info.outputPath('Device-source.kra')
  writeFileSync(path, Buffer.from(file.contents!))
  await ui.click({ standardButton: 2097152 })
  await fileAction(ui, 'file_close')
  await ui.wait(async () => (await documents(ui)).length === 0, 'fixture document closes')
  return path
}

async function editDeviceFile(ui: KritaUI, path: string) {
  await fileAction(ui, 'file_open')
  await ui.chooseDeviceFile(path)
  await ui.wait(async () => (await documents(ui)).length === 1, 'device document opens')
  expect((await documents(ui))[0].path.startsWith('/Documents/')).toBe(false)
  const point = await ui.center(await ui.find({ class: 'KisQPainterCanvas', activeCanvas: true }))
  await ui.page.mouse.move(point[0] - 20, point[1] + 30)
  await ui.page.mouse.down()
  await ui.page.mouse.move(point[0] + 35, point[1] + 40, { steps: 8 })
  await ui.page.mouse.up()
  await ui.wait(async () => (await documents(ui))[0].modified && (await documents(ui))[0].undoIndex > 0, 'uploaded document edited')
  return fingerprints(await documents(ui))
}

for (const [locale, language] of [
  ['en-US', 'en'],
  ['zh-CN', 'zh_CN'],
  ['ar', 'ar'],
]) {
  test.describe(`Open browser cache ${language}`, () => {
    test.use({ locale })
    test('native folders and Discard preserve independently saved documents', async ({ page, web }, info) => {
      const ui = new KritaUI(page, web, info)
      let chooserCount = 0
      let downloadCount = 0
      page.on('filechooser', () => chooserCount++)
      page.on('download', () => downloadCount++)
      await ui.start('&autosaveSeconds=2')
      const root = await page.evaluate(() => window.kritaRecovery.filesDirectory)
      await openCacheDialog(ui)
      expect((await ui.find({ class: 'KisPreviewFileDialog' }))!.directory).toBe(root)
      expect(await ui.find({ name: 'fileNameEdit' })).toBeTruthy()
      await ui.click({ standardButton: 4194304 })
      await ui.wait(async () => !await ui.find({ class: 'KisPreviewFileDialog' }), 'empty native browser Cancel')
      expect(chooserCount).toBe(0)
      expect(await documents(ui)).toEqual([])
      // Seed a directory fixture, then navigate it through the real native UI.
      const folder = language === 'zh_CN'
        ? '项目目录'
        : 'Projects'
      const filename = language === 'zh_CN'
        ? '作品-autosave.kra'
        : 'Protected-autosave.kra'
      await page.evaluate(folder => window.kritaTestFS.mkdirTree(`${window.kritaRecovery.filesDirectory}/${folder}`), folder)
      await ui.paint()
      const before = fingerprints(await documents(ui))
      const name = `${folder}/${filename}`
      const path = `${root}/${name}`
      await nativeSave(ui, name)
      const first = (await committed(ui, 1, undefined, 'saved'))[0]
      await committed(ui, 0)
      expect(first.path).toBe(path)
      expect((await documents(ui))[0].savedPath).toBe(path)
      await ui.click({ standardButton: 2097152 })
      await fileAction(ui, 'file_close')
      await ui.wait(async () => !(await documents(ui)).length, 'clean saved document closes')
      expect(downloadCount).toBe(0)
      const initialCache = (await stored(page, true, 'saved'))[0]
      const uploaded = info.outputPath('Device-open.kra')
      writeFileSync(uploaded, Buffer.from(initialCache.contents!))
      await reloadSaved(ui)
      await openCacheDialog(ui)
      expect((await ui.find({ class: 'KisPreviewFileDialog' }))!.directory).toBe(root)
      await ui.wait(() => ui.find({ class: 'KritaTestFileItem', filePath: `${root}/${folder}` }), 'native directory entry')
      await page.mouse.dblclick(...await ui.center(await ui.find({ class: 'KritaTestFileItem', filePath: `${root}/${folder}` })))
      await ui.wait(async () => (await ui.find({ class: 'KisPreviewFileDialog' }))?.directory === `${root}/${folder}`, 'native directory navigation')
      await ui.shot('native-cache-folders')
      await ui.wait(() => ui.find({ class: 'KritaTestFileItem', filePath: path }), 'native saved file entry')
      await page.mouse.dblclick(...await ui.center(await ui.find({ class: 'KritaTestFileItem', filePath: path })))
      await ui.wait(async () => (await documents(ui)).length === 1, 'saved cached KRA opened')
      expect(fingerprints(await documents(ui))).toEqual(before)
      expect((await documents(ui))[0]).toMatchObject({
        modified: false,
        recovered: false,
        savedPath: path,
        path,
      })
      await openCachedFile(ui, path)
      expect((await documents(ui)).length).toBe(1)
      const edit = async () => {
        const canvas = await ui.center(await ui.find({ class: 'KisQPainterCanvas', activeCanvas: true }))
        await page.mouse.move(canvas[0] - 20, canvas[1] + 30)
        await page.mouse.down()
        await page.mouse.move(canvas[0] + 30, canvas[1] + 35, { steps: 8 })
        await page.mouse.up()
        await ui.wait(async () => (await documents(ui))[0].modified, 'cached document edited')
        return fingerprints(await documents(ui))
      }
      const dirty = await edit()
      expect(dirty).not.toEqual(before)
      await committed(ui)
      expect((await stored(page, false, 'saved'))[0].sha256).toBe(initialCache.sha256)
      await reloadRecovery(ui, 'discardAll')
      await committed(ui, 0)
      expect((await stored(page, false, 'saved'))[0].sha256).toBe(initialCache.sha256)
      expect(await documents(ui)).toEqual([])
      await openCachedFile(ui, path)
      await ui.wait(async () => (await documents(ui)).length === 1, 'saved baseline survives startup Discard')
      expect(fingerprints(await documents(ui))).toEqual(before)
      const edited = await edit()
      await fileAction(ui, 'file_save')
      await ui.wait(() => ui.find({ name: 'kritaWasmDownloadDialog' }), 'edited cached document saved')
      await committed(ui, 1, initialCache.sha256, 'saved')
      await committed(ui, 0)
      await ui.click({ standardButton: 2097152 })
      await fileAction(ui, 'file_close')
      await ui.wait(async () => !(await documents(ui)).length, 'updated cached document closes')
      await reloadSaved(ui)
      await openCachedFile(ui, path)
      await ui.wait(async () => (await documents(ui)).length === 1, 'updated saved file opens after refresh')
      expect(fingerprints(await documents(ui))).toEqual(edited)
      await fileAction(ui, 'file_open')

      await ui.chooseDeviceFile(uploaded)
      await ui.wait(async () => (await documents(ui)).length === 2, 'device file opens alongside saved document')
      expect(fingerprints(await documents(ui)).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))))
        .toEqual([
          ...before,
          ...edited,
        ].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))))
      expect(chooserCount).toBe(1)
      expect(downloadCount).toBe(0)
      ui.web.check()
      ui.write('browser-cache-open.json', {
        locale,
        savedPath: path,
        before,
        directoryNavigation: true,
        cleanSaveNeedsNoRecovery: true,
        discardPreservedSavedBaseline: true,
        normalOpenWithoutRecovery: true,
        existingDocumentReused: true,
        editedSaveSurvivedRefresh: true,
        chooserCount,
        downloadCount,
      })
    })
  })
}

test.describe('IDBFS native autosave', () => {
  test('device Save, Save As, Close and Close All share the durable cache workflow', async ({ page, web }, info) => {
    const ui = new KritaUI(page, web, info)
    await ui.start('&lang=en&autosaveSeconds=60')
    const source = await deviceFixture(ui)
    let downloads = 0
    page.on('download', () => downloads++)
    const results = []
    for (const action of [
      'file_close',
      'file_save',
      'file_save_as',
      'file_close_all',
    ]) {
      const pixels = await editDeviceFile(ui, source)
      await fileAction(ui, action)
      if (action === 'file_close' || action === 'file_close_all') {
        await ui.wait(() => ui.find({ standardButton: 16384 }), 'close offers Save')
        await ui.click({ standardButton: 16384 })
      }
      await ui.wait(async () => await ui.find({ class: 'KisPreviewFileDialog' }) || await ui.find({ name: 'kritaWasmDownloadDialog' }), 'cache destination must precede device download')
      expect(await ui.find({ class: 'KisPreviewFileDialog' }), `${action} must choose a browser-cache location`).toBeTruthy()
      expect(await ui.find({ name: 'kritaWasmDownloadDialog' })).toBeUndefined()
      const name = `Device-${action}.kra`
      await chooseSaveDestination(ui, name)
      await ui.wait(() => ui.find({ name: 'kritaWasmDownloadDialog' }), 'download offered after durable save')
      // Do not poll for a later commit: the readiness prompt itself is a promise.
      const saved = (await stored(page, false, 'saved')).find(file => file.path === `/Documents/${name}`)
      expect(saved?.size).toBeGreaterThan(0)
      expect(await page.evaluate(() => window.kritaRecovery.error)).toBeNull()
      await ui.click({ standardButton: 2097152 })
      if (action === 'file_save' || action === 'file_save_as') {
        expect((await documents(ui))[0]).toMatchObject({ modified: false, path: `/Documents/${name}` })
        await fileAction(ui, 'file_close')
      }
      await ui.wait(async () => (await documents(ui)).length === 0, 'saved document closes')
      results.push({
        action,
        path: saved!.path,
        sha256: saved!.sha256,
        pixels,
      })
    }
    expect(downloads).toBe(0)
    await reloadSaved(ui)
    for (const result of [
      results[0],
      results.at(-1)!,
    ]) {
      await openCachedFile(ui, result.path)
      await ui.wait(async () => (await documents(ui)).length === 1, 'closed device document reopens from cache')
      expect(fingerprints(await documents(ui))).toEqual(result.pixels)
      await fileAction(ui, 'file_close')
      await ui.wait(async () => (await documents(ui)).length === 0, 'reopened document closes')
    }
    ui.web.check()
    ui.write('device-save-workflow.json', { results, downloads, savedBeforeDownloadPrompt: true })
  })

  test('closing Save stays open on cache cancellation or failure and waits for commit acknowledgement', async ({ page, web }, info) => {
    const ui = new KritaUI(page, web, info)
    await ui.start('&lang=en&autosaveSeconds=60')
    const source = await deviceFixture(ui)
    const pixels = await editDeviceFile(ui, source)
    const before = await stored(page, false, 'saved')
    const closeAndSave = async () => {
      await fileAction(ui, 'file_close')
      await ui.wait(() => ui.find({ standardButton: 16384 }), 'close asks to Save')
      await ui.click({ standardButton: 16384 })
      await ui.wait(() => ui.find({ class: 'KisPreviewFileDialog' }), 'first manual Save chooses cache path')
    }
    await closeAndSave()
    await ui.click({ standardButton: 4194304 })
    await ui.wait(async () => !await ui.find({ class: 'KisPreviewFileDialog' }), 'cache destination cancelled')
    expect((await documents(ui))[0].modified).toBe(true)
    expect(await ui.find({ name: 'kritaWasmDownloadDialog' })).toBeUndefined()

    await closeAndSave()
    const abort = await page.evaluateHandle(() => {
      const descriptor = Object.getOwnPropertyDescriptor(IDBObjectStore.prototype, 'put')!
      const original = IDBObjectStore.prototype.put
      IDBObjectStore.prototype.put = function (...args) {
        if (this.transaction.db.name === window.kritaRecovery.directory) {
          this.transaction.abort()
          throw new DOMException('Manual save quota exhaustion', 'QuotaExceededError')
        }
        return original.apply(this, args)
      }
      return {
        restore: () => Object.defineProperty(IDBObjectStore.prototype, 'put', descriptor),
      }
    })
    try {
      await chooseSaveDestination(ui, 'Failed-close.kra')
      await expect(page.locator('#recovery-error')).toContainText('Browser cache could not be saved')
      await ui.wait(() => ui.find({ standardButton: 1024 }), 'cache failure is a native save error')
      expect((await documents(ui))[0].modified).toBe(true)
      expect(await ui.find({ name: 'kritaWasmDownloadDialog' })).toBeUndefined()
      expect(await stored(page, false, 'saved')).toEqual(before)
      await ui.click({ standardButton: 1024 })
      await ui.wait(async () => !await ui.find({ standardButton: 1024 }), 'cache error acknowledged')
      expect((await documents(ui))[0].modified).toBe(true)
    }
    finally {
      await abort.evaluate((state) => {
        state.restore()
      })
      await abort.dispose()
    }

    await closeAndSave()
    const gate = await page.evaluateHandle(() => {
      const recovery = window.kritaRecovery
      const original = recovery.sync
      let release: (() => void) | undefined
      const state = {
        held: false,
        resume: () => {
          recovery.sync = original
          release?.()
        },
      }
      recovery.sync = async () => {
        let ready = false
        try {
          ready = window.kritaTestFS.isFile(window.kritaTestFS.stat('/Documents/Committed-close.kra').mode)
        }
        catch {}
        if (ready && !state.held) {
          state.held = true
          await new Promise<void>((resolve) => {
            release = resolve
          })
        }
        return original()
      }
      return state
    })
    try {
      await chooseSaveDestination(ui, 'Committed-close.kra')
      await expect.poll(() => gate.evaluate(state => state.held)).toBe(true)
      expect((await documents(ui))[0]).toMatchObject({ modified: true, saving: true })
      expect(await ui.find({ name: 'kritaWasmDownloadDialog' })).toBeUndefined()
      await gate.evaluate(state => state.resume())
      await ui.wait(() => ui.find({ name: 'kritaWasmDownloadDialog' }), 'successful commit releases the download prompt')
      const saved = (await stored(page, false, 'saved')).find(file => file.path === '/Documents/Committed-close.kra')
      expect(saved?.size).toBeGreaterThan(0)
    }
    finally {
      await gate.evaluate(state => state.resume())
      await gate.dispose()
    }
    await ui.wait(async () => (await documents(ui)).length === 0, 'close accepted only after durable save')
    await reloadSaved(ui)
    await openCachedFile(ui, '/Documents/Committed-close.kra')
    await ui.wait(async () => (await documents(ui)).length === 1, 'committed retry reopens after immediate refresh')
    expect(fingerprints(await documents(ui))).toEqual(pixels)
    ui.write('close-save-durability.json', {
      cancelledClosePreserved: true,
      failedCommitPreserved: true,
      promptWaitedForCommit: true,
      pixels,
    })
  })

  test('Save unchanged cached file offers a device copy without rewriting cache', async ({ page, web }, info) => {
    const ui = new KritaUI(page, web, info)
    await ui.start('&lang=en&autosaveSeconds=60')
    await ui.paint()
    const originalPixels = fingerprints(await documents(ui))
    await nativeSave(ui, 'Unchanged-cache.kra')
    const saved = (await committed(ui, 1, undefined, 'saved'))[0]
    await ui.click({ standardButton: 2097152 })
    await reloadSaved(ui)
    await openCachedFile(ui, saved.path)
    await ui.wait(async () => (await documents(ui)).length === 1, 'cached document loaded')
    expect(fingerprints(await documents(ui))).toEqual(originalPixels)
    expect((await documents(ui))[0]).toMatchObject({
      path: saved.path,
      modified: false,
      recovered: false,
      saving: false,
    })
    const before = await documents(ui)
    const downloaded = []
    const closePrompt = async () => {
      await ui.click({ standardButton: 2097152 })
      await ui.wait(async () => !await ui.find({ name: 'kritaWasmDownloadDialog' }), 'device prompt closed')
    }
    for (const trigger of ['toolbar', 'menu', 'shortcut']) {
      if (trigger === 'toolbar') {
        await ui.click({ class: 'QToolButton', action: 'file_save' })
      }
      else if (trigger === 'menu') {
        await ui.click({ action: 'file' })
        await ui.click({ class: 'QMenuAction', action: 'file_save' })
      }
      else {
        await page.keyboard.press('Control+s')
      }
      await ui.wait(() => ui.find({ name: 'kritaWasmDownloadDialog' }), 'unchanged Save directly offers device copy')
      expect(await ui.find({ class: 'KisPreviewFileDialog' })).toBeUndefined()
      expect(await documents(ui)).toEqual(before)
      expect(await stored(page, false, 'saved')).toEqual([saved])
      // Closing the prompt changes neither the document nor its saved copy.
      if (trigger === 'toolbar') {
        await closePrompt()
        expect(await documents(ui)).toEqual(before)
        continue
      }
      const pending = page.waitForEvent('download')
      await ui.click({ name: 'kritaWasmDownload' })
      const download = await pending
      const path = info.outputPath(`unchanged-${trigger}.kra`)
      expect(download.suggestedFilename()).toBe('Unchanged-cache.kra')
      await download.saveAs(path)
      expect(await download.failure()).toBeNull()
      const hash = createHash('sha256').update(readFileSync(path)).digest('hex')
      expect(hash).toBe(saved.sha256)
      expect(artifact('kra', path).projection.width).toBe(256)
      downloaded.push({ trigger, hash })
      await closePrompt()
    }
    await fileAction(ui, 'file_save_as')
    await ui.wait(() => ui.find({ class: 'KisPreviewFileDialog', acceptMode: 1 }), 'explicit Save As retains cache file picker')
    await ui.click({ standardButton: 4194304 })
    await ui.wait(async () => !await ui.find({ class: 'KisPreviewFileDialog' }), 'Save As cancelled')
    expect(await documents(ui)).toEqual(before)
    const point = await ui.center(await ui.find({ class: 'KisQPainterCanvas', activeCanvas: true }))
    await page.mouse.move(point[0] - 20, point[1] + 35)
    await page.mouse.down()
    await page.mouse.move(point[0] + 30, point[1] + 40, { steps: 8 })
    await page.mouse.up()
    // Save immediately: native preflight must finish pending brush work before
    // choosing between serializing changes and offering existing cache bytes.
    await page.keyboard.press('Control+s')
    await ui.wait(() => ui.find({ name: 'kritaWasmDownloadDialog' }), 'modified Save completes normal cache write')
    const modified = fingerprints(await documents(ui))
    expect(modified).not.toEqual(originalPixels)
    const updated = (await committed(ui, 1, saved.sha256, 'saved'))[0]
    expect(updated.path).toBe(saved.path)
    expect(updated.sha256).not.toBe(saved.sha256)
    expect((await documents(ui))[0].modified).toBe(false)
    expect(fingerprints(await documents(ui))).toEqual(modified)
    const pending = page.waitForEvent('download')
    await ui.click({ name: 'kritaWasmDownload' })
    const download = await pending
    const path = info.outputPath('modified-cache.kra')
    await download.saveAs(path)
    expect(createHash('sha256').update(readFileSync(path)).digest('hex')).toBe(updated.sha256)
    await closePrompt()
    await reloadSaved(ui)
    await openCachedFile(ui, updated.path)
    await ui.wait(async () => (await documents(ui)).length === 1, 'updated cached document loaded')
    expect(fingerprints(await documents(ui))).toEqual(modified)
    ui.web.check()
    ui.write('unchanged-save.json', {
      saved,
      updated,
      downloaded,
      cancelPreserved: true,
      saveAsPreserved: true,
      modifiedSavePersisted: true,
    })
  })

  test.use({ locale: 'en-US' })

  for (const [size, width, height] of [
    ['256px', 256, 256],
    ['A4', 2480, 3508],
  ] as const) {
    test(`default native Save survives immediate refresh without closing the document (${size})`, async ({ page, web }, info) => {
      const ui = new KritaUI(page, web, info)
      await ui.start()
      await ui.paint({ width, height })
      const before = fingerprints(await documents(ui))
      const originalDirectory = await page.evaluate(() => window.kritaRecovery.directory)
      await nativeSave(ui, 'Saved-before-refresh.kra', 'file_save', 'default')
      // Mimic a user refreshing as soon as the completed-file prompt appears:
      // no IndexedDB commit wait, Download click or document close beforehand.
      await reloadSaved(ui)
      const saved = await stored(page, false, 'saved')
      ui.write('immediate-refresh-storage.json', {
        originalDirectory,
        currentDirectory: await page.evaluate(() => window.kritaRecovery.directory),
        saved,
      })
      expect(saved).toHaveLength(1)
      expect(saved[0].path).toBe('/Documents/Saved-before-refresh.kra')
      await openCachedFile(ui, saved[0].path)
      await ui.wait(async () => (await documents(ui)).length === 1, 'saved file opens after immediate refresh')
      expect(fingerprints(await documents(ui))).toEqual(before)
      ui.web.check()
    })
  }

  test('native Home sidebar saves and reopens the same persistent directory after refresh', async ({ page, web }, info) => {
    const ui = new KritaUI(page, web, info)
    await ui.start()
    await ui.paint()
    expect(await page.evaluate(() => window.kritaRecovery.filesDirectory)).toBe('/Documents')
    const before = fingerprints(await documents(ui))
    await nativeSave(ui, 'Home-saved.kra', 'file_save', 'home')
    await reloadSaved(ui)
    const saved = await stored(page, false, 'saved')
    expect(saved).toHaveLength(1)
    await openCacheDialog(ui)
    const homes = (await ui.snapshot()).filter(item => item.class === 'KritaTestFileItem' && item.viewName === 'sidebar' && item.filePath)
    expect(homes).toHaveLength(1)
    await ui.click({ class: 'KritaTestFileItem', viewName: 'sidebar', filePath: homes[0].filePath })
    await ui.wait(async () => (await ui.find({ class: 'KisPreviewFileDialog' }))!.directory === homes[0].filePath, 'native Open Home selected')
    const root = await page.evaluate(() => window.kritaRecovery.filesDirectory)
    ui.write('native-home-storage.json', { home: homes[0].filePath, persistentRoot: root, saved })
    expect(homes[0].filePath).toBe(root)
    expect(saved[0].path).toBe(`${root}/Home-saved.kra`)
    await chooseCachedFile(ui, saved[0].path)
    await ui.wait(async () => (await documents(ui)).length === 1, 'native Home saved file reopened')
    expect(fingerprints(await documents(ui))).toEqual(before)
    ui.web.check()
  })

  test('timed KRA survives reload, recovery cancellation and explicit discard', async ({ page, web }, info) => {
    const ui = new KritaUI(page, web, info)
    const downloads: string[] = []
    page.on('download', download => downloads.push(download.suggestedFilename()))
    await ui.start('&autosaveSeconds=2')
    await expect(page.locator('#settings-toggle')).toBeVisible()
    await expect(page.locator('#page-settings')).not.toBeVisible()
    expect(await page.locator('#preview-note').count()).toBe(0)
    await ui.paint()
    const before = fingerprints(await documents(ui))
    const saved = await committed(ui)
    expect(await ui.find({ name: 'kritaWasmDownloadDialog' })).toBeUndefined()
    expect(downloads).toEqual([])
    const disk = (await stored(page, true))[0]
    const path = info.outputPath('actual-autosave.kra')
    writeFileSync(path, Buffer.from(disk.contents!))
    const kra = artifact('autosave', path)
    await reloadRecovery(ui, 4194304)
    expect(await ui.documents()).toEqual([])
    expect((await stored(page))[0].sha256).toBe(saved[0].sha256)
    await reloadRecovery(ui)
    expect(fingerprints(await documents(ui))).toEqual(before)
    expect((await documents(ui))[0]).toMatchObject({ modified: true, recovered: true })
    await fileAction(ui, 'file_save')
    await ui.wait(() => ui.find({ class: 'KisPreviewFileDialog', acceptMode: 1 }), 'recovered Save still asks for a cache destination')
    expect(await ui.find({ name: 'kritaWasmDownloadDialog' })).toBeUndefined()
    await ui.click({ standardButton: 4194304 })
    await ui.wait(async () => !await ui.find({ class: 'KisPreviewFileDialog' }), 'recovered Save cancellation')
    expect(fingerprints(await documents(ui))).toEqual(before)
    await fileAction(ui, 'file_close')
    await ui.wait(() => ui.find({ class: 'QMessageBox' }), 'close asks Save/Discard/Cancel')
    await ui.click({ standardButton: 4194304 })
    expect(fingerprints(await documents(ui))).toEqual(before)
    expect(await stored(page)).toHaveLength(1)
    await fileAction(ui, 'file_close')
    await ui.click({ standardButton: 65536 })
    await ui.wait(async () => (await ui.documents()).length === 0, 'explicit document discard')
    await committed(ui, 0)
    web.statuses.length = 0
    await page.reload({ waitUntil: 'domcontentloaded' })
    await ui.waitForStartup()
    expect(await ui.find({ class: 'KisAutoSaveRecoveryDialog' })).toBeUndefined()
    expect(await ui.documents()).toEqual([])
    ui.web.check()
    ui.write('autosave-reload.json', {
      intervalSeconds: 2,
      saved,
      before,
      kra,
      downloads,
      discardPersisted: true,
    })
  })

  test('manual Save keeps saved files without downloading and imported documents autosave', async ({ page, web }, info) => {
    const ui = new KritaUI(page, web, info)
    await ui.start('&autosaveSeconds=2')
    await ui.paint()
    const before = fingerprints(await documents(ui))
    await nativeSave(ui, 'manual-recovery.kra')
    await committed(ui, 1, undefined, 'saved')
    await committed(ui, 0)
    // Do not click Download: the native Save still needs a persistent copy.
    await ui.click({ standardButton: 2097152 })
    expect((await ui.documents())[0].modified).toBe(false)
    await fileAction(ui, 'file_close')
    await ui.wait(async () => (await ui.documents()).length === 0, 'clean saved document closes')
    expect(await stored(page, false, 'saved')).toHaveLength(1)
    const savedPath = (await stored(page, false, 'saved'))[0].path
    await reloadSaved(ui)
    await openCachedFile(ui, savedPath)
    await ui.wait(async () => (await documents(ui)).length === 1, 'saved cached file reopened')
    expect(fingerprints(await documents(ui))).toEqual(before)
    const disk = (await stored(page, true, 'saved'))[0]
    const path = info.outputPath('imported.kra')
    writeFileSync(path, Buffer.from(disk.contents!))
    await fileAction(ui, 'file_open')

    await ui.chooseDeviceFile(path)
    await ui.wait(async () => (await ui.documents()).length === 2, 'real browser KRA upload')
    // Loading starts with an empty undo stack; draw on the imported document.
    const activeCanvas = await ui.find({ class: 'KisQPainterCanvas', activeCanvas: true })
    const canvas = await ui.center(activeCanvas)
    await page.mouse.move(canvas[0] - 20, canvas[1] + 20)
    await page.mouse.down()
    await page.mouse.move(canvas[0] + 35, canvas[1] + 30, { steps: 8 })
    await page.mouse.up()
    await ui.wait(async () => (await documents(ui)).some(doc => doc.undoIndex > 0), 'imported document really edited')
    const imported = fingerprints(await documents(ui))
    await committed(ui, 1)
    await reloadRecovery(ui)
    await openCachedFile(ui, savedPath)
    await ui.wait(async () => (await documents(ui)).length === 2, 'saved baseline and dirty import both reopen')
    expect(fingerprints(await documents(ui)).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))))
      .toEqual(imported.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))))
    ui.web.check()
    ui.write('autosave-manual-import.json', { manualDownloadSkipped: true, recoveredDocuments: imported })
  })

  test('closed tabs with identical file names preserve both saved documents', async ({ page, context, web }, info) => {
    const ui = new KritaUI(page, web, info)
    await ui.start('&autosaveSeconds=60')
    await ui.paint()
    const firstPixels = fingerprints(await documents(ui))
    await nativeSave(ui, 'Same-name.kra')
    const first = (await committed(ui, 1, undefined, 'saved'))[0]
    await ui.click({ standardButton: 2097152 })
    const secondPage = await context.newPage()
    try {
      const other = new KritaUI(secondPage, web, info)
      web.statuses.length = 0
      await other.start('&autosaveSeconds=60')
      await other.paint({ width: 320, height: 192 })
      const secondPixels = fingerprints(await documents(other))
      await nativeSave(other, 'Same-name.kra')
      const second = (await committed(other, 1, undefined, 'saved'))[0]
      await other.click({ standardButton: 2097152 })
      expect(first.path).toBe('/Documents/Same-name.kra')
      expect(second.path).toBe(first.path)
      expect(first.storagePath).not.toBe(second.storagePath)
      await secondPage.goto(`${web.url}/__blank`)
      await page.goto(`${web.url}/__blank`)
      web.statuses.length = 0
      await ui.start('&autosaveSeconds=60')
      const merged = await committed(ui, 2, undefined, 'saved')
      await committed(ui, 0)
      expect(merged.map(file => file.sha256).sort()).toEqual([first.sha256, second.sha256].sort())
      expect(merged.some(file => file.path.includes('/Other sessions/'))).toBe(true)
      for (const file of merged) {
        await openCachedFile(ui, file.path)
      }
      await ui.wait(async () => (await documents(ui)).length === 2, 'both namespaced saved files open')
      expect(fingerprints(await documents(ui)).sort((a, b) => a.width - b.width)).toEqual([
        ...firstPixels,
        ...secondPixels,
      ].sort((a, b) => a.width - b.width))
      ui.web.check()
      ui.write('closed-session-files.json', {
        first,
        second,
        merged,
        bothFilesPreserved: true,
      })
    }
    finally {
      await secondPage.close()
    }
  })

  test('native cache Import keeps the saved source and its recovery independent', async ({ page, web }, info) => {
    const ui = new KritaUI(page, web, info)
    await ui.start('&autosaveSeconds=2')
    await ui.paint()
    const baseline = fingerprints(await documents(ui))
    const baselineInk = await ui.darkPixels()
    await nativeSave(ui, 'Import-source.kra')
    const saved = (await committed(ui, 1, undefined, 'saved'))[0]
    await ui.click({ standardButton: 2097152 })
    const editActive = async () => {
      const activePath = (await ui.canvases()).find(canvas => canvas.active)!.path
      const previousUndo = (await documents(ui)).find(document => document.path === activePath)!.undoIndex
      const point = await ui.center(await ui.find({ class: 'KisQPainterCanvas', activeCanvas: true }))
      await page.mouse.move(point[0] - 20, point[1] + 35)
      await page.mouse.down()
      await page.mouse.move(point[0] + 30, point[1] + 40, { steps: 8 })
      await page.mouse.up()
      await ui.wait(async () => (await documents(ui)).find(document => document.path === activePath)!.undoIndex > previousUndo, 'real brush stroke accepted')
    }
    await editActive()
    const recovery = (await committed(ui))[0]
    await openCacheDialog(ui, 'file_import_file')
    await chooseCachedFile(ui, saved.path)
    await ui.wait(async () => (await documents(ui)).length === 2, 'native Import creates a separate document')
    const imported = (await documents(ui)).find(document => !document.savedPath)!
    expect(imported).toBeTruthy()
    expect(imported.path).toBe('')
    expect(imported.recoveryPath).not.toBe(recovery.path)
    expect(fingerprints([imported])).toEqual(baseline)
    expect((await stored(page))[0].sha256).toBe(recovery.sha256)
    expect((await stored(page, false, 'saved'))[0].sha256).toBe(saved.sha256)
    await ui.wait(async () => (await ui.canvases()).some(canvas => canvas.active && canvas.path === '')
      && await ui.darkPixels() === baselineInk, 'imported canvas presents its first frame')
    await editActive()
    const independent = await committed(ui, 2)
    expect(independent.some(file => file.path === recovery.path && file.sha256 === recovery.sha256)).toBe(true)
    await nativeSave(ui, 'Imported-copy.kra')
    await committed(ui, 2, undefined, 'saved')
    await committed(ui, 1)
    await ui.click({ standardButton: 2097152 })
    expect((await stored(page))[0]).toMatchObject({ path: recovery.path, sha256: recovery.sha256 })
    expect((await stored(page, false, 'saved')).find(file => file.path === saved.path)!.sha256).toBe(saved.sha256)
    ui.web.check()
    ui.write('native-cache-import.json', {
      baseline,
      savedSource: saved.path,
      sourceSavedSha256: saved.sha256,
      sourceRecoverySha256: recovery.sha256,
      independentImport: true,
    })
  })

  test('aborted IDBFS transaction retains the previous committed snapshot', async ({ page, web }, info) => {
    const ui = new KritaUI(page, web, info)
    await ui.start('&autosaveSeconds=2')
    await ui.paint()
    const before = fingerprints(await documents(ui))
    const saved = await committed(ui)
    await page.evaluate(() => {
      const put = IDBObjectStore.prototype.put
      IDBObjectStore.prototype.put = function (...args) {
        if (this.transaction.db.name === window.kritaRecovery.directory) {
          this.transaction.abort()
          throw new DOMException('Test quota exhaustion', 'QuotaExceededError')
        }
        return put.apply(this, args)
      }
    })
    // Undoing the only stroke would make the document clean and intentionally
    // skip autosave. Make another real edit so the native timer must write.
    const canvas = await ui.center(await ui.find({ class: 'KisQPainterCanvas' }))
    await page.mouse.move(canvas[0] - 20, canvas[1] + 20)
    await page.mouse.down()
    await page.mouse.move(canvas[0] + 35, canvas[1] + 30, { steps: 8 })
    await page.mouse.up()
    await expect(page.locator('#recovery-error')).toContainText('Browser cache could not be saved')
    expect((await stored(page))[0].sha256).toBe(saved[0].sha256)
    await reloadRecovery(ui)
    expect(fingerprints(await documents(ui))).toEqual(before)
    await expect(page.locator('#recovery-error')).toBeHidden()
    ui.write('autosave-abort.json', { previousSha256: saved[0].sha256, actualTransactionAborted: true, before })
  })

  test('non-native Save retains native layers and PNG export preserves recovery', async ({ page, web }, info) => {
    const ui = new KritaUI(page, web, info)
    // No periodic snapshot should be needed: non-native Save must trigger the
    // native recovery exporter even after it marks the document clean.
    await ui.start('&autosaveSeconds=60')
    await ui.paint()
    const before = fingerprints(await documents(ui))
    await nativeSave(ui, 'flattened-save.png')
    await ui.click({ standardButton: 2097152 })
    await ui.wait(async () => !(await documents(ui))[0].saving, 'forced native snapshot completes')
    const saved = await committed(ui)
    expect((await ui.documents())[0]).toMatchObject({ modified: false })
    await nativeSave(ui, 'separate-export.png', 'file_export_file')
    await ui.click({ standardButton: 2097152 })
    expect((await stored(page))[0].sha256).toBe(saved[0].sha256)
    await reloadRecovery(ui)
    expect(fingerprints(await documents(ui))).toEqual(before)
    await reloadRecovery(ui, 'discardAll')
    await committed(ui, 0)
    expect(await ui.documents()).toEqual([])
    ui.web.check()
    ui.write('autosave-non-native.json', {
      periodicIntervalSeconds: 60,
      nativeRecoveryAfterPngSave: true,
      before,
      discardedAll: true,
    })
  })

  test('live tabs stay isolated and closed sessions merge without losing either document', async ({ page, context, web }, info) => {
    const first = new KritaUI(page, web, info)
    await first.start('&autosaveSeconds=2')
    await first.paint()
    const firstPixels = fingerprints(await documents(first))
    await committed(first)
    const firstDirectory = await page.evaluate(() => window.kritaRecovery.directory)
    const secondPage = await context.newPage()
    const second = new KritaUI(secondPage, web, info)
    web.statuses.length = 0
    await second.start('&autosaveSeconds=2')
    expect(await second.documents()).toEqual([])
    expect(await secondPage.evaluate(() => window.kritaRecovery.directory)).not.toBe(firstDirectory)
    await second.paint({ width: 320, height: 240 })
    await committed(second)
    const secondPixels = fingerprints(await documents(second))
    expect(fingerprints(await documents(first))).toEqual(firstPixels)
    expect(await stored(page)).toHaveLength(1)
    // Closing the browser pages does not run Krita's explicit Discard command.
    await secondPage.close()
    await page.close()
    const thirdPage = await context.newPage()
    const third = new KritaUI(thirdPage, web, info)
    web.statuses.length = 0
    await thirdPage.goto(`${web.url}/?test=1&autosaveSeconds=2`, { waitUntil: 'domcontentloaded' })
    await third.waitForWidgets()
    await third.wait(() => third.find({ class: 'KisAutoSaveRecoveryDialog' }), 'both abandoned sessions offered')
    await third.click({ class: 'QPushButton', buttonRole: 0 })
    await third.waitForStartup()
    const recovered = fingerprints(await documents(third))
    expect(recovered.sort((a, b) => a.width - b.width)).toEqual([
      ...firstPixels,
      ...secondPixels,
    ].sort((a, b) => a.width - b.width))
    await committed(third, 2)
    third.web.check()
    third.write('autosave-tabs.json', { firstDirectory, recovered })
  })

  test('default A4 native snapshot restores exact layer pixels', async ({ page, web }, info) => {
    const ui = new KritaUI(page, web, info)
    await ui.start('&autosaveSeconds=2')
    await ui.paint({ width: 2480, height: 3508 })
    const before = fingerprints(await documents(ui))
    await committed(ui)
    await reloadRecovery(ui)
    expect(fingerprints(await documents(ui))).toEqual(before)
    ui.web.check()
    ui.write('autosave-a4.json', { intervalSeconds: 2, before })
  })
})
