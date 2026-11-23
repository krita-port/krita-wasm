import type { Page } from '@playwright/test'
import type { DocumentSnapshot } from './native.js'
import { Buffer } from 'node:buffer'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { expect, stored, test } from './fixtures.ts'
import { artifact, KritaUI } from './krita-ui.ts'

const documents = async (ui: KritaUI) => (await ui.snapshot<DocumentSnapshot>(true)).filter(item => item.class === 'KritaTestDocument')
const fingerprints = (docs: DocumentSnapshot[]) => docs.map(doc => ({ width: doc.width, height: doc.height, layerPixels: doc.layerPixels }))

async function fileAction(ui: KritaUI, action: string) {
  if (!await ui.find({ action }))
    await ui.click({ action: 'file' })
  await ui.click({ action })
}

async function abortNextCacheDeletion(page: Page, prefix = '') {
  await page.evaluate((prefix) => {
    const remove = IDBObjectStore.prototype.delete
    delete document.documentElement.dataset.discardDeleteFailed
    let injected = false
    IDBObjectStore.prototype.delete = function (...args) {
      const request = remove.apply(this, args)
      const key = String(args[0])
      if (!injected && (prefix
        ? key.startsWith(prefix)
        : key.endsWith('-autosave.kra'))) {
        injected = true
        document.documentElement.dataset.discardDeleteFailed = 'true'
        this.add({}, 'forced-discard-abort')
        const collision = this.add({}, 'forced-discard-abort')
        collision.onerror = () => this.transaction.abort()
      }
      return request
    }
    Reflect.set(globalThis, 'restoreDiscardDelete', () => {
      IDBObjectStore.prototype.delete = remove
    })
  }, prefix)
}

async function virtualFilesDirectory(page: Page): Promise<string> {
  return page.evaluate(() => {
    const fs = window.kritaTestFS
    const state = window.kritaRecovery
    const name = fs.readdir(state.filesDirectory).find((name) => {
      const path = `${state.filesDirectory}/${name}`
      return fs.isLink(fs.lstat(path).mode) && fs.readlink(path) === `${state.directory}/virtual`
    })
    if (!name)
      throw new Error('Persistent virtual files have no visible Documents alias')
    return `${state.filesDirectory}/${name}`
  })
}

async function abortUploadRead(page: Page, nth: number) {
  return page.evaluateHandle((nth) => {
    const descriptor = Object.getOwnPropertyDescriptor(File.prototype, 'arrayBuffer')
    const read = File.prototype.arrayBuffer
    const fs = window.kritaTestFS
    const write = fs.writeFile
    const paths: string[] = []
    let count = 0
    Object.defineProperty(File.prototype, 'arrayBuffer', {
      configurable: true,
      writable: true,
      value(this: File) {
        return ++count === nth
          ? Promise.reject(new Error('Injected upload read failure'))
          : read.call(this)
      },
    })
    fs.writeFile = new Proxy(write, {
      apply(target, receiver, args) {
        const result = Reflect.apply(target, receiver, args)
        paths.push(String(args[0]))
        return result
      },
    })
    return {
      paths,
      restore() {
        fs.writeFile = write
        if (descriptor)
          Object.defineProperty(File.prototype, 'arrayBuffer', descriptor)
        else Reflect.deleteProperty(File.prototype, 'arrayBuffer')
      },
    }
  }, nth)
}

async function linkedDeviceFiles(ui: KritaUI) {
  const directory = ui.info.outputPath('linked-upload')
  mkdirSync(directory)
  const paths: string[] = []
  for (const name of ['Converted-layer.kra', 'converted-layer.png']) {
    const path = `${directory}/${name}`
    const bytes = await ui.page.evaluate(name => Array.from(window.kritaTestFS.readFile(`/Documents/${name}`)), name)
    writeFileSync(path, Buffer.from(bytes))
    paths.push(path)
  }
  return paths
}

async function convertToFileLayer(ui: KritaUI, image = '/Documents/converted-layer.png') {
  const previousUndo = (await documents(ui))[0].undoIndex
  await ui.click({ action: 'Layer' })
  await ui.click({ action: 'LayerConvert' })
  await ui.click({ action: 'convert_to_file_layer' })
  await ui.wait(() => ui.find({ class: 'KisPreviewFileDialog' }), 'file-layer image chooses browser cache')
  expect((await ui.find({ class: 'KisPreviewFileDialog' }))!.directory).toBe('/Documents')
  await ui.replace({ name: 'fileNameEdit' }, image)
  await ui.page.keyboard.press('Tab')
  await ui.click({ standardButton: 2048 })
  await ui.wait(() => ui.find({ class: 'KoDialog' }), 'file-layer PNG options')
  await ui.click({ buttonRole: 0 })
  await ui.wait(async () => (await documents(ui))[0].undoIndex > previousUndo, 'file layer created after acknowledged export')
}

async function abortCacheWrite(page: Page, suffix: string) {
  return await page.evaluateHandle((suffix) => {
    const descriptor = Object.getOwnPropertyDescriptor(IDBObjectStore.prototype, 'put')!
    const original = IDBObjectStore.prototype.put
    const rejected = new WeakSet<IDBTransaction>()
    IDBObjectStore.prototype.put = function (...args) {
      const request = original.apply(this, args)
      if (this.transaction.db.name === window.kritaRecovery.directory
        && String(args[1]).endsWith(suffix) && !rejected.has(this.transaction)) {
        rejected.add(this.transaction)
        // An actual failing IDB request reaches the backend's async error
        // handler; aborting synchronously inside put breaks its remaining
        // request setup instead of exercising commit failure.
        const failure = this.add(args[0], args[1])
        failure.onerror = () => this.transaction.abort()
      }
      return request
    }
    return {
      restore: () => Object.defineProperty(IDBObjectStore.prototype, 'put', descriptor),
    }
  }, suffix)
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

async function chooseSaveDestination(ui: KritaUI, name: string, location = 'persistent', existing = false) {
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
  if (existing) {
    await ui.click({ class: 'KritaTestFileItem', filePath: `${root}/${name}` })
  }
  else {
    await ui.replace({ name: 'fileNameEdit' }, location === 'persistent'
      ? `${root}/${name}`
      : name)
  }
  await ui.page.keyboard.press('Tab')
  await ui.wait(async () => (await ui.find({ standardButton: 2048 }))?.enabled, 'Save enabled')
  await ui.click({ standardButton: 2048 })
}

async function nativeSave(ui: KritaUI, name: string, action = 'file_save', location = 'persistent', overwrite = false) {
  await fileAction(ui, action)
  await chooseSaveDestination(ui, name, location, overwrite)
  if (overwrite) {
    await ui.wait(() => ui.find({ standardButton: 16384 }), 'overwrite confirmation')
    await ui.click({ standardButton: 16384 })
  }
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

async function browseCachedDirectory(ui: KritaUI, path: string) {
  const root = await ui.page.evaluate(() => window.kritaRecovery.filesDirectory)
  expect(path === root || path.startsWith(`${root}/`)).toBe(true)
  let current = root
  for (const name of path.slice(root.length + 1).split('/').filter(Boolean)) {
    current += `/${name}`
    await ui.wait(() => ui.find({ class: 'KritaTestFileItem', filePath: current }), `native directory entry ${name}`)
    await ui.page.mouse.dblclick(...await ui.center(await ui.find({ class: 'KritaTestFileItem', filePath: current })))
    await ui.wait(async () => (await ui.find({ class: 'KisPreviewFileDialog' }))?.directory === current, 'native directory changes')
  }
}

async function chooseCachedFile(ui: KritaUI, path: string) {
  await browseCachedDirectory(ui, path.slice(0, path.lastIndexOf('/')))
  await ui.wait(() => ui.find({ class: 'KritaTestFileItem', filePath: path }), 'native cached file entry')
  await ui.page.mouse.dblclick(...await ui.center(await ui.find({ class: 'KritaTestFileItem', filePath: path })))
  await ui.wait(async () => !await ui.find({ class: 'KisPreviewFileDialog' }), 'native cached file opens')
}

async function openCachedFile(ui: KritaUI, path: string) {
  await openCacheDialog(ui)
  await chooseCachedFile(ui, path)
}

async function nativeFileCommand(ui: KritaUI, path: string, label: string) {
  const { page } = ui
  await ui.wait(() => ui.find({ class: 'KritaTestFileItem', filePath: path }), 'native file context target loads')
  const target = await ui.find({ class: 'KritaTestFileItem', filePath: path })
  const [x, y] = await ui.center(target)
  await page.mouse.click(x, y, { button: 'right' })
  const action = async () => (await ui.snapshot()).find(item => item.class === 'QMenuAction' && item.text?.replaceAll('&', '') === label)
  await ui.wait(action, `native file context menu offers ${label}`)
  await ui.click({ class: 'QMenuAction', text: (await action())!.text })
}

async function renameCachedFolder(ui: KritaUI, path: string) {
  const parent = path.slice(0, path.lastIndexOf('/'))
  const name = path.slice(parent.length + 1)
  const entries = () => ui.page.evaluate(directory => window.kritaTestFS.readdir(directory), parent)
  const before = await entries()
  await openCacheDialog(ui)
  await browseCachedDirectory(ui, parent)
  await nativeFileCommand(ui, path, 'Rename')
  await ui.click({ class: 'QExpandingLineEdit' })
  await ui.page.keyboard.press('Home')
  await ui.page.keyboard.press('Delete')
  await ui.page.keyboard.press('Enter')
  await ui.wait(async () => !(await entries()).includes(name), 'native cache rename completes')
  const added = (await entries()).filter(entry => !before.includes(entry))
  expect(added).toHaveLength(1)
  const renamed = `${parent}/${added[0]}`
  await ui.wait(() => ui.find({ class: 'KritaTestFileItem', filePath: renamed }), 'native picker shows the renamed folder')
  await ui.click({ standardButton: 4194304 })
  return renamed
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
        editedSaveSurvivedRefresh: true,
        chooserCount,
        downloadCount,
      })
    })
  })
}

test.describe('IDBFS native autosave', () => {
  test('layered Save keeps logical file links and multi-file exports keep every companion', async ({ page, web }, info) => {
    const ui = new KritaUI(page, web, info)
    await ui.start('&lang=en&autosaveSeconds=60')
    await ui.paint()
    await page.evaluate(async () => {
      const canvas = new OffscreenCanvas(256, 256)
      const context = canvas.getContext('2d')!
      context.fillStyle = '#2060c0'
      context.fillRect(0, 0, 256, 256)
      const image = await canvas.convertToBlob({ type: 'image/png' })
      window.kritaTestFS.mkdirTree('/Documents/linked')
      window.kritaTestFS.mkdirTree('/Documents/project/deep')
      window.kritaTestFS.writeFile('/Documents/linked/source.png', new Uint8Array(await image.arrayBuffer()))
      await window.kritaRecovery.sync()
    })
    await nativeSave(ui, 'Link-base.kra')
    await ui.click({ standardButton: 2097152 })
    await ui.click({ action: 'Layer' })
    await ui.click({ action: 'LayerNew' })
    await ui.click({ action: 'add_new_file_layer' })
    await ui.wait(() => ui.find({ name: 'txtFileName' }), 'native linked file-layer dialog')
    await ui.replace({ name: 'txtFileName' }, '/Documents/linked/source.png')
    await page.keyboard.press('Tab')
    await ui.click({ buttonRole: 0 })
    await ui.wait(async () => (await documents(ui))[0].layers === 3, 'linked image becomes a real layer')
    const before = fingerprints(await documents(ui))
    await nativeSave(ui, 'project/deep/linked.kra', 'file_save_as')
    const linksInKra = async (name: string): Promise<string[]> => {
      const kra = info.outputPath(name)
      const data = await page.evaluate(name => Array.from(window.kritaTestFS.readFile(`/Documents/project/deep/${name}`)), name)
      writeFileSync(kra, Buffer.from(data))
      return JSON.parse(execFileSync('python3', ['-c', `
import json,sys,zipfile,xml.etree.ElementTree as ET
with zipfile.ZipFile(sys.argv[1]) as archive:
 print(json.dumps([node.attrib['source'] for node in ET.fromstring(archive.read('maindoc.xml')).iter() if 'source' in node.attrib]))
`, kra], { encoding: 'utf8' }))
    }
    const links = await linksInKra('linked.kra')
    expect(links).toContain('../../linked/source.png')
    await ui.click({ standardButton: 2097152 })
    await nativeSave(ui, 'project/deep/linked.krz', 'file_export_file')
    expect(await linksInKra('linked.krz')).toContain('../../linked/source.png')
    await ui.click({ standardButton: 2097152 })
    await fileAction(ui, 'file_save_as')
    await chooseSaveDestination(ui, 'project/deep/paired.png')
    const companion = { class: 'QCheckBox', text: 'Also save your image as a Krita file.' }
    await ui.wait(() => ui.find(companion), 'native companion KRA choice')
    if (!(await ui.find(companion))!.checked)
      await ui.click(companion)
    await ui.wait(async () => (await ui.find(companion))?.checked, 'companion KRA explicitly enabled')
    await ui.click({ buttonRole: 0 })
    await ui.wait(() => ui.find({ name: 'kritaWasmDownloadDialog' }), 'PNG and companion KRA committed')
    const companionLinks = await linksInKra('paired.png.kra')
    expect(companionLinks).toContain('../../linked/source.png')
    await ui.click({ standardButton: 2097152 })
    await nativeSave(ui, 'project/deep/layers.qml', 'file_save_as')
    const pending = page.waitForEvent('download')
    await ui.click({ name: 'kritaWasmDownload' })
    const download = await pending
    expect(download.suggestedFilename()).toBe('layers.zip')
    const zip = info.outputPath('layers.zip')
    await download.saveAs(zip)
    const companions = JSON.parse(execFileSync('python3', ['-c', `
import json,re,sys,zipfile
with zipfile.ZipFile(sys.argv[1]) as archive:
 qml=archive.read('layers.qml').decode()
 names=re.findall(r'source: "([^"]+)"',qml)
 assert names
 for name in names:
  assert archive.read(name).startswith(bytes([137,80,78,71,13,10,26,10])), name
 print(json.dumps(names))
`, zip], { encoding: 'utf8' })) as string[]
    expect(companions.length).toBeGreaterThanOrEqual(2)
    await ui.click({ standardButton: 2097152 })
    await nativeSave(ui, 'project/deep/one-off.png', 'file_export_file')
    await ui.click({ standardButton: 2097152 })
    await fileAction(ui, 'file_save')
    await ui.wait(() => ui.find({ name: 'kritaWasmDownloadDialog' }), 'unchanged saved QML can be downloaded after a one-off export')
    const repeated = page.waitForEvent('download')
    await ui.click({ name: 'kritaWasmDownload' })
    const repeatedDownload = await repeated
    expect(repeatedDownload.suggestedFilename()).toBe('layers.zip')
    const repeatedZip = info.outputPath('layers-after-export.zip')
    await repeatedDownload.saveAs(repeatedZip)
    execFileSync('python3', [
      '-c',
      `
import sys,zipfile
with zipfile.ZipFile(sys.argv[1]) as first, zipfile.ZipFile(sys.argv[2]) as second:
 assert sorted(first.namelist()) == sorted(second.namelist())
 for name in first.namelist():
  assert first.read(name) == second.read(name), name
`,
      zip,
      repeatedZip,
    ])
    await ui.click({ standardButton: 2097152 })
    await reloadRecovery(ui, 'discardAll')
    expect(await linksInKra('paired.png.kra')).toContain('../../linked/source.png')
    await openCachedFile(ui, '/Documents/project/deep/linked.kra')
    await ui.wait(async () => (await documents(ui)).length === 1, 'linked KRA reopens after refresh')
    expect(fingerprints(await documents(ui))).toEqual(before)
    expect(await page.evaluate(names => names.every(name => window.kritaTestFS.stat(`/Documents/project/deep/${name}`).size > 0), companions)).toBe(true)
    await openCacheDialog(ui, 'file_import_file')
    await chooseCachedFile(ui, '/Documents/project/deep/linked.kra')
    await ui.wait(async () => (await documents(ui)).length === 2, 'cached linked KRA imported as an independent document')
    expect((await documents(ui)).some(document => document.path === '' && document.savedPath === '')).toBe(true)
    await nativeSave(ui, 'project/deep/imported.kra')
    const importedLinks = await linksInKra('imported.kra')
    expect(importedLinks).toContain('../../linked/source.png')
    await ui.click({ standardButton: 2097152 })
    ui.write('linked-and-multifile-export.json', {
      links,
      companionLinks,
      importedLinks,
      companions,
      before,
    })
  })

  test('duplicate Open Recent documents retain independent dirty recovery snapshots', async ({ page, web }, info) => {
    const ui = new KritaUI(page, web, info)
    await ui.start('&lang=en&autosaveSeconds=2')
    await ui.paint()
    await nativeSave(ui, 'duplicate.kra')
    await ui.click({ standardButton: 2097152 })
    const stroke = async (documentIndex: number, offset: number) => {
      // The native document list keeps insertion order even when paths match.
      const previous = (await documents(ui))[documentIndex].undoIndex
      const [x, y] = await ui.center(await ui.find({ class: 'KisQPainterCanvas', activeCanvas: true }))
      await page.mouse.move(x - 30, y + offset)
      await page.mouse.down()
      await page.mouse.move(x + 30, y + offset, { steps: 8 })
      await page.mouse.up()
      await ui.wait(async () => (await documents(ui))[documentIndex].undoIndex > previous, 'active duplicate stroke committed')
    }
    await stroke(0, 25)
    const firstPixels = fingerprints(await documents(ui))
    const firstRecovery = (await committed(ui))[0]
    const firstRecoveryBytes = (await stored(page, true))[0].contents!
    await fileAction(ui, 'file_open_recent')
    await ui.wait(async () => (await ui.snapshot()).some(item => item.class === 'QMenuAction' && item.text?.includes('duplicate.kra')), 'saved file in native Open Recent')
    const recent = (await ui.snapshot()).find(item => item.class === 'QMenuAction' && item.text?.includes('duplicate.kra'))!
    await ui.click({ class: recent.class, text: recent.text })
    await ui.wait(async () => (await documents(ui)).length === 2, 'same saved file opens as a second document')
    await stroke(1, -25)
    const both = await committed(ui, 2)
    expect(new Set(both.map(file => file.path)).size).toBe(2)
    expect(both.find(file => file.path === firstRecovery.path)!.sha256).toBe(firstRecovery.sha256)
    await fileAction(ui, 'file_save')
    await ui.wait(() => ui.find({ name: 'kritaWasmDownloadDialog' }), 'second document durably saved')
    await ui.click({ standardButton: 2097152 })
    expect((await committed(ui))[0]).toMatchObject({ path: firstRecovery.path, sha256: firstRecovery.sha256 })
    await reloadRecovery(ui)
    expect(fingerprints(await documents(ui))).toEqual(firstPixels)
    expect((await documents(ui))[0].savedPath).toBe('/Documents/duplicate.kra')
    const saved = await stored(page, false, 'saved')
    await reloadRecovery(ui, 4194304)
    expect(await documents(ui)).toEqual([])
    await openCacheDialog(ui)
    await chooseCachedFile(ui, '/Documents/duplicate.kra')
    await ui.wait(() => ui.find({ class: 'KisRecoverNamedAutosaveDialog' }), 'named recovery prompt')
    // Allow the retirement preflight, but do not let an unrelated later sync
    // hide a missing acknowledgement of the actual recovery deletion.
    await page.evaluate(async () => {
      const state = window.kritaRecovery
      await state.sync()
      const sync = state.sync.bind(state)
      let release: () => void = () => {}
      const held = new Promise<void>((resolve) => {
        release = resolve
      })
      let written = false
      let preflight = false
      state.sync = async (write, rollback) => {
        if (write) {
          await sync(write, rollback)
          written = true
        }
        else {
          if (!preflight) {
            preflight = true
          }
          else if (!written) {
            await held
          }
          await sync()
        }
      }
      Reflect.set(globalThis, 'releaseDiscardSyncs', () => {
        state.sync = sync
        release()
      })
    })
    await ui.click({ name: 'rbDiscardAutosave' })
    await ui.click({ name: 'btOk' })
    await ui.wait(async () => (await documents(ui)).length === 1, 'main file opens after acknowledged recovery discard')
    expect(await stored(page)).toEqual([])
    expect(await stored(page, false, 'saved')).toEqual(saved)
    await page.evaluate(async () => {
      Reflect.get(globalThis, 'releaseDiscardSyncs')()
      await window.kritaRecovery.sync()
    })
    await reloadSaved(ui)
    await openCachedFile(ui, '/Documents/duplicate.kra')
    await ui.wait(async () => (await documents(ui)).length === 1, 'saved document opened before path replacement')
    const unchanged = fingerprints(await documents(ui))
    const originalSaved = (await stored(page, false, 'saved'))[0]
    await page.evaluate(async (bytes) => {
      const fs = window.kritaTestFS
      fs.rename('/Documents/duplicate.kra', '/Documents/renamed.kra')
      fs.writeFile('/Documents/duplicate.kra', new Uint8Array(bytes))
      await window.kritaRecovery.sync()
    }, firstRecoveryBytes)
    await fileAction(ui, 'file_save')
    await ui.wait(() => ui.find({ name: 'kritaWasmDownloadDialog' }), 'old tab retains its saved version after cache replacement')
    const pendingDownload = page.waitForEvent('download')
    await ui.click({ name: 'kritaWasmDownload' })
    const download = await pendingDownload
    const originalDownload = info.outputPath('original-tab-version.kra')
    await download.saveAs(originalDownload)
    expect(createHash('sha256').update(readFileSync(originalDownload)).digest('hex')).toBe(originalSaved.sha256)
    await ui.click({ standardButton: 2097152 })
    await openCachedFile(ui, '/Documents/duplicate.kra')
    await ui.wait(async () => (await documents(ui)).length === 2, 'reused path loads its selected replacement')
    const replacement = fingerprints(await documents(ui))
    expect(replacement).toContainEqual(unchanged[0])
    expect(replacement).toContainEqual(firstPixels[0])
    ui.write('duplicate-recovery.json', {
      firstRecovery,
      both,
      firstPixels,
      namedDiscardDurable: true,
    })
  })

  test('Save As preserves another document’s abandoned recovery snapshot', async ({ page, web }, info) => {
    const ui = new KritaUI(page, web, info)
    await ui.start('&lang=en&autosaveSeconds=2')
    await ui.paint()
    await nativeSave(ui, 'abandoned-recovery.kra')
    await ui.click({ standardButton: 2097152 })
    const [x, y] = await ui.center(await ui.find({ class: 'KisQPainterCanvas', activeCanvas: true }))
    await page.mouse.move(x - 40, y + 30)
    await page.mouse.down()
    await page.mouse.move(x + 40, y + 30, { steps: 10 })
    await page.mouse.up()
    const originalPixels = fingerprints(await documents(ui))
    const original = await committed(ui)
    await reloadRecovery(ui, 4194304)
    await ui.paint({ width: 320, height: 240 })
    await nativeSave(ui, 'abandoned-recovery.kra', 'file_save_as', 'persistent', true)
    await ui.click({ standardButton: 2097152 })
    await page.evaluate(() => window.kritaRecovery.sync())
    expect(await stored(page)).toEqual(original)
    await reloadRecovery(ui)
    expect(fingerprints(await documents(ui))).toEqual(originalPixels)
    ui.web.check()
  })

  test('device Save, Save As, Close and Close All share the durable cache workflow', async ({ page, web }, info) => {
    const ui = new KritaUI(page, web, info)
    await ui.start('&lang=en&autosaveSeconds=60')
    // Identical basenames must remain distinct, and closing one upload must
    // not remove the other document's input while it is still open.
    const uploads: string[] = []
    for (const [index, width] of [48, 80].entries()) {
      const directory = info.outputPath(`upload-${index}`)
      mkdirSync(directory)
      const path = `${directory}/same.png`
      const bytes = await page.evaluate(async (width) => {
        const canvas = new OffscreenCanvas(width, 32)
        const context = canvas.getContext('2d')!
        context.fillStyle = width === 48
          ? '#ff0000'
          : '#0000ff'
        context.fillRect(0, 0, width, 32)
        return Array.from(new Uint8Array(await (await canvas.convertToBlob()).arrayBuffer()))
      }, width)
      writeFileSync(path, Buffer.from(bytes))
      uploads.push(path)
    }
    for (const method of ['picker', 'drop'] as const) {
      await fileAction(ui, 'file_open')
      if (method === 'picker') {
        const uploadFault = await abortUploadRead(page, 2)
        try {
          await page.locator('#device-file').setInputFiles(uploads)
          await expect(page.locator('#device-error')).toContainText('Injected upload read failure')
          const abandoned = await uploadFault.evaluate(state => state.paths.at(-1)!)
          expect(abandoned.endsWith('/same.png')).toBe(true)
          expect(await page.evaluate((path) => {
            try {
              window.kritaTestFS.lookupPath(path, { follow: true })
              return true
            }
            catch { return false }
          }, abandoned)).toBe(false)
          expect(await documents(ui)).toEqual([])
        }
        finally {
          await uploadFault.evaluate(state => state.restore())
          await uploadFault.dispose()
        }
        await expect(page.locator('#device-file')).toBeEnabled()
        const [chooser] = await Promise.all([
          page.waitForEvent('filechooser'),
          page.locator('#device-choose').click(),
        ])
        await chooser.setFiles(uploads)
      }
      else {
        await ui.chooseDeviceFile(uploads, method)
      }
      await ui.wait(async () => (await documents(ui)).length === 2, `both ${method} images open`)
      const opened = await documents(ui)
      expect(opened.map(doc => doc.width).sort((a, b) => a - b)).toEqual([48, 80])
      expect(new Set(opened.map(doc => doc.path)).size).toBe(2)
      expect(opened.every(doc => doc.path.endsWith('/same.png'))).toBe(true)
      const activePath = (await ui.canvases()).find(canvas => canvas.active)!.path
      const remaining = opened.find(doc => doc.path !== activePath)!
      await fileAction(ui, 'file_close')
      await ui.wait(async () => (await documents(ui)).length === 1, 'one batch image closes')
      expect(fingerprints(await documents(ui))).toEqual(fingerprints([remaining]))
      await ui.wait(() => page.evaluate((path) => {
        try {
          window.kritaTestFS.lookupPath(path, { follow: true })
          return false
        }
        catch { return true }
      }, activePath), 'closed upload input is released')
      expect(await page.evaluate(path => window.kritaTestFS.readFile(path).length, remaining.path)).toBeGreaterThan(0)
      await fileAction(ui, 'file_close_all')
      await ui.wait(async () => !(await documents(ui)).length, 'batch images close')
    }
    const source = await deviceFixture(ui)
    let downloads = 0
    page.on('download', () => downloads++)
    const results = []
    for (const action of [
      'file_close',
      'file_save',
      'file_save_as',
      'file_close_all',
      'save_incremental_backup',
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
      if (action !== 'file_close' && action !== 'file_close_all') {
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
    await editDeviceFile(ui, source)
    const groupSource = (await documents(ui))[0]
    await ui.click({ action: 'Layer' })
    await ui.click({ action: 'LayerGroup' })
    await ui.click({ action: 'create_quick_group' })
    await ui.wait(async () => (await documents(ui))[0].undoIndex > groupSource.undoIndex, 'real quick group created')
    await ui.click({ action: 'Layer' })
    await ui.click({ action: 'LayerImportExport' })
    await ui.click({ action: 'save_groups_as_images' })
    await ui.wait(() => ui.find({ class: 'KoDialog' }), 'Save Group Layers default path')
    await ui.click({ buttonRole: 0 })
    const uploadParent = groupSource.path.slice(0, groupSource.path.lastIndexOf('/'))
    await ui.wait(async () => (await stored(page, false, 'virtual')).some(file => file.path.startsWith(`${uploadParent}/`) && file.path.endsWith('.kra') && file.path !== groupSource.path), 'new group output committed outside Documents')
    const groupSaved = (await stored(page, false, 'virtual')).find(file => file.path.startsWith(`${uploadParent}/`) && file.path.endsWith('.kra') && file.path !== groupSource.path)!
    expect(await page.evaluate(path => window.kritaTestFS.readFile(path).length, groupSource.path)).toBeGreaterThan(0)
    await ui.click({ action: 'edit_undo' })
    await ui.wait(async () => (await documents(ui))[0].undoIndex === groupSource.undoIndex, 'group creation undone without removing its export')
    const layerOutput = '/Documents/Synchronous-layer.png'
    const exportLayer = async (previous?: string) => {
      await ui.click({ action: 'Layer' })
      await ui.click({ action: 'LayerImportExport' })
      await ui.click({ action: 'save_node_as_image' })
      await ui.wait(() => ui.find({ class: 'KisPreviewFileDialog' }), 'layer export cache destination')
      if (previous)
        await ui.click({ class: 'KritaTestFileItem', filePath: layerOutput })
      else await ui.replace({ name: 'fileNameEdit' }, layerOutput)
      await page.keyboard.press('Tab')
      await ui.click({ standardButton: 2048 })
      if (previous) {
        await ui.wait(() => ui.find({ standardButton: 16384 }), 'layer export overwrite confirmation')
        await ui.click({ standardButton: 16384 })
      }
      await ui.wait(async () => await ui.find({ class: 'KoDialog' }) || await ui.find({ class: 'QMessageBox' })
        || (await stored(page, false, 'saved')).some(file => file.path === layerOutput && file.sha256 !== previous), 'synchronous export options or outcome')
      if (await ui.find({ class: 'KoDialog' }))
        await ui.click({ buttonRole: 0 })
    }
    await exportLayer()
    await ui.wait(async () => (await stored(page, false, 'saved')).some(file => file.path === layerOutput), 'synchronous layer export acknowledged')
    const previousLayer = (await stored(page, false, 'saved')).find(file => file.path === layerOutput)!
    const [layerX, layerY] = await ui.center(await ui.find({ class: 'KisQPainterCanvas', activeCanvas: true }))
    await page.mouse.move(layerX - 30, layerY + 30)
    await page.mouse.down()
    await page.mouse.move(layerX + 30, layerY + 30, { steps: 8 })
    await page.mouse.up()
    const abortLayer = await abortCacheWrite(page, '/files/Synchronous-layer.png')
    try {
      await exportLayer(previousLayer.sha256)
      await ui.wait(() => ui.find({ class: 'QMessageBox' }), 'synchronous export reports rejected persistence')
      expect((await stored(page, false, 'saved')).find(file => file.path === layerOutput)?.sha256).toBe(previousLayer.sha256)
      await ui.click({ standardButton: 1024 })
    }
    finally {
      await abortLayer.evaluate(state => state.restore())
      await abortLayer.dispose()
    }
    await page.evaluate(() => window.kritaRecovery.sync())
    expect((await stored(page, false, 'saved')).find(file => file.path === layerOutput)?.sha256).toBe(previousLayer.sha256)
    await exportLayer(previousLayer.sha256)
    await ui.wait(async () => (await stored(page, false, 'saved')).some(file => file.path === layerOutput && file.sha256 !== previousLayer.sha256), 'synchronous export retry committed')
    const conversionPixels = fingerprints(await documents(ui))
    const uploadedPath = (await documents(ui))[0].path
    await convertToFileLayer(ui)
    await ui.wait(async () => JSON.stringify(fingerprints(await documents(ui))) === JSON.stringify(conversionPixels), 'file layer retains every original source pixel')
    expect((await stored(page, false, 'saved')).some(file => file.path === '/Documents/converted-layer.png' && file.size > 0)).toBe(true)
    const convertedPixels = fingerprints(await documents(ui))
    await nativeSave(ui, 'Converted-layer.kra')
    const convertedSaved = (await stored(page, false, 'saved')).find(file => file.path === '/Documents/Converted-layer.kra')!
    await ui.click({ standardButton: 2097152 })
    await fileAction(ui, 'file_close')
    await ui.wait(async () => !(await documents(ui)).length, 'converted document closes')
    await ui.wait(() => page.evaluate((path) => {
      try {
        window.kritaTestFS.lookupPath(path, { follow: true })
        return false
      }
      catch { return true }
    }, uploadedPath), 'converted upload input is removed')
    const groupAlias = await virtualFilesDirectory(page)
    expect((await stored(page, false, 'virtual')).find(file => file.path === groupSaved.path)?.sha256).toBe(groupSaved.sha256)
    await openCachedFile(ui, groupAlias + groupSaved.path)
    await ui.wait(async () => (await documents(ui)).length === 1, 'group export survives upload owner cleanup')
    await ui.wait(async () => await ui.darkPixels() > 100, 'persisted group export renders its actual pixels')
    expect(await page.evaluate((path) => {
      try {
        window.kritaTestFS.stat(path)
        return true
      }
      catch { return false }
    }, groupSource.path)).toBe(false)
    await fileAction(ui, 'file_close')
    await openCachedFile(ui, '/Documents/Converted-layer.kra')
    await ui.wait(async () => (await documents(ui)).length === 1, 'file-layer document reopens after upload cleanup')
    await expect.poll(async () => fingerprints(await documents(ui)), { message: 'referenced file-layer pixels restored' }).toEqual(convertedPixels)
    await ui.wait(async () => await ui.darkPixels() > 100, 'referenced image renders after upload cleanup')
    await fileAction(ui, 'file_close')
    results.push({
      action: 'convert_to_file_layer',
      path: '/Documents/Converted-layer.kra',
      sha256: convertedSaved.sha256,
      pixels: convertedPixels,
    })
    const linkedUploads = await linkedDeviceFiles(ui)
    const duplicateDirectory = info.outputPath('duplicate-linked')
    mkdirSync(duplicateDirectory)
    const duplicateKra = `${duplicateDirectory}/Converted-layer.kra`
    copyFileSync(linkedUploads[0], duplicateKra)
    const literalBackslash = `${duplicateDirectory}/asset\\reference.png`
    copyFileSync(uploads[0], literalBackslash)
    for (const method of ['picker', 'drop'] as const) {
      await fileAction(ui, 'file_open')
      if (method === 'picker') {
        const fault = await abortUploadRead(page, 3)
        try {
          await page.locator('#device-file').setInputFiles([
            ...linkedUploads,
            ...uploads,
          ])
          await expect(page.locator('#device-error')).toContainText('Injected upload read failure')
          const paths = await fault.evaluate(state => state.paths)
          expect(paths).toHaveLength(2)
          for (const path of paths) {
            expect(await page.evaluate((path) => {
              try {
                window.kritaTestFS.stat(path)
                return true
              }
              catch { return false }
            }, path)).toBe(false)
          }
          expect(await documents(ui)).toEqual([])
        }
        finally {
          await fault.evaluate(state => state.restore())
          await fault.dispose()
        }
      }
      await ui.chooseDeviceFile([
        ...linkedUploads,
        duplicateKra,
        ...uploads,
        ...(method === 'drop'
          ? [literalBackslash]
          : []),
      ], method)
      const count = method === 'drop'
        ? 6
        : 5
      await ui.wait(async () => (await documents(ui)).length === count, 'duplicate-basename projects and images all open with their supplied sibling')
      if (method === 'drop')
        expect((await documents(ui)).some(document => document.path.endsWith('/asset\\reference.png'))).toBe(true)
      const linkedProjects = (await documents(ui)).filter(doc => doc.path.endsWith('/Converted-layer.kra'))
      expect(linkedProjects).toHaveLength(2)
      for (const linked of linkedProjects)
        await expect.poll(async () => fingerprints((await documents(ui)).filter(doc => doc.path === linked.path))).toEqual(convertedPixels)
      const linked = linkedProjects[0]
      const imagePath = await page.evaluate((path) => {
        const fs = window.kritaTestFS
        return fs.isLink(fs.lstat(path).mode)
          ? fs.readlink(path)
          : path
      }, `${linked.path.slice(0, linked.path.lastIndexOf('/'))}/converted-layer.png`)
      while ((await documents(ui)).length > 1) {
        const count = (await documents(ui)).length
        await fileAction(ui, 'file_close')
        await ui.wait(async () => (await documents(ui)).length === count - 1, 'one sibling document closes')
      }
      expect(await page.evaluate(path => window.kritaTestFS.readFile(path).length, imagePath)).toBeGreaterThan(0)
      const name = `Linked-${method}.kra`
      if (method === 'picker') {
        const abort = await abortCacheWrite(page, `/virtual${imagePath}`)
        try {
          await fileAction(ui, 'file_save_as')
          await chooseSaveDestination(ui, name)
          await ui.wait(() => ui.find({ class: 'QMessageBox' }), 'linked-input IDB failure rejects the complete save')
          expect((await stored(page, false, 'saved')).some(file => file.path === `/Documents/${name}`)).toBe(false)
          expect((await stored(page, false, 'virtual')).some(file => file.path === imagePath)).toBe(false)
          await ui.click({ standardButton: 1024 })
        }
        finally {
          await abort.evaluate(state => state.restore())
          await abort.dispose()
        }
        await page.evaluate(() => window.kritaRecovery.sync())
        expect((await stored(page, false, 'saved')).some(file => file.path === `/Documents/${name}`)).toBe(false)
      }
      await nativeSave(ui, name, 'file_save_as')
      expect((await stored(page, false, 'virtual')).some(file => file.path === imagePath)).toBe(true)
      expect((await stored(page, false, 'virtual')).some(file => file.path === linked.path)).toBe(false)
      const saved = (await stored(page, false, 'saved')).find(file => file.path === `/Documents/${name}`)!
      await ui.click({ standardButton: 2097152 })
      if (method === 'picker') {
        await openCachedFile(ui, `/Documents/${name}`)
        await ui.wait(async () => (await documents(ui)).length === 2, 'cached reader opens while upload owner is alive')
        const original = (await ui.snapshot()).find(item => item.class === 'KritaTestTab' && item.index === 0 && item.text?.includes(name))!
        await ui.click({ class: 'KritaTestTab', index: 0, text: original.text })
        await fileAction(ui, 'file_close')
        await ui.wait(async () => (await documents(ui)).length === 1, 'upload owner closes while cached reader remains')
        expect(await page.evaluate(path => window.kritaTestFS.readFile(path).length, imagePath)).toBeGreaterThan(0)
        await expect.poll(async () => fingerprints(await documents(ui))).toEqual(convertedPixels)
      }
      await fileAction(ui, 'file_close')
      await ui.wait(async () => !(await documents(ui)).length, 'shared upload owner closes')
      await openCachedFile(ui, `/Documents/${name}`)
      await ui.wait(async () => (await documents(ui)).length === 1, 'saved linked upload opens after source cleanup')
      await expect.poll(async () => fingerprints(await documents(ui))).toEqual(convertedPixels)
      await fileAction(ui, 'file_close')
      results.push({
        action: `device_linked_${method}`,
        path: saved.path,
        sha256: saved.sha256,
        pixels: convertedPixels,
      })
    }
    // Relocate an actual self-contained KRA/PNG pair to a virtual directory.
    // Its relative file-layer link must behave the same before and after reload.
    await page.evaluate(async () => {
      const fs = window.kritaTestFS
      const root = `${window.kritaRecovery.directory}/virtual/home/linked`
      fs.mkdirTree(root)
      for (const name of ['Converted-layer.kra', 'converted-layer.png'])
        fs.writeFile(`${root}/${name}`, fs.readFile(`/Documents/${name}`))
      await window.kritaRecovery.sync()
    })
    await openCachedFile(ui, `${groupAlias}/home/linked/Converted-layer.kra`)
    await ui.wait(async () => (await documents(ui)).length === 1, 'virtual project with relative linked image opens')
    await expect.poll(async () => fingerprints(await documents(ui))).toEqual(convertedPixels)
    const linkedBeforeFailure = (await stored(page, false, 'virtual')).find(file => file.path === '/home/linked/converted-layer.png')!
    const abortLinked = await abortCacheWrite(page, '/virtual/home/linked/converted-layer.png')
    try {
      await ui.click({ action: 'Layer' })
      await ui.click({ action: 'LayerImportExport' })
      await ui.click({ action: 'save_node_as_image' })
      await ui.wait(() => ui.find({ class: 'KisPreviewFileDialog' }), 'virtual linked-image export')
      await browseCachedDirectory(ui, `${groupAlias}/home/linked`)
      await ui.click({ class: 'KritaTestFileItem', filePath: `${groupAlias}/home/linked/converted-layer.png` })
      await page.keyboard.press('Tab')
      await ui.click({ standardButton: 2048 })
      await ui.wait(() => ui.find({ standardButton: 16384 }), 'overwrite virtual linked image')
      await ui.click({ standardButton: 16384 })
      await ui.wait(() => ui.find({ class: 'KoDialog' }), 'virtual linked PNG options')
      await ui.click({ buttonRole: 0 })
      await ui.wait(() => ui.find({ class: 'QMessageBox' }), 'rejected virtual overwrite reports failure')
      expect((await stored(page, false, 'virtual')).find(file => file.path === linkedBeforeFailure.path)?.sha256).toBe(linkedBeforeFailure.sha256)
      await ui.click({ standardButton: 1024 })
    }
    finally {
      await abortLinked.evaluate(state => state.restore())
      await abortLinked.dispose()
    }
    await page.evaluate(() => window.kritaRecovery.sync())
    expect((await stored(page, false, 'virtual')).find(file => file.path === linkedBeforeFailure.path)?.sha256).toBe(linkedBeforeFailure.sha256)
    await fileAction(ui, 'file_close')
    await openCacheDialog(ui)
    await browseCachedDirectory(ui, `${groupAlias}/home/linked`)
    await nativeFileCommand(ui, `${groupAlias}/home/linked/converted-layer.png`, 'Delete')
    await ui.wait(() => ui.find({ class: 'QMessageBox' }), 'delete linked image confirmation')
    await ui.click({ standardButton: 16384 })
    await ui.wait(async () => !(await stored(page, false, 'virtual')).some(file => file.path === '/home/linked/converted-layer.png'), 'linked-image deletion reaches cache')
    await ui.click({ standardButton: 4194304 })
    const linkedImageMissing = () => page.evaluate(() => {
      try {
        window.kritaTestFS.stat('/home/linked/converted-layer.png')
        return false
      }
      catch { return true }
    })
    expect(await linkedImageMissing(), 'deleted linked image must not remain readable through its original path').toBe(true)
    await openCachedFile(ui, `${groupAlias}/home/linked/Converted-layer.kra`)
    await ui.wait(() => ui.find({ standardButton: 65536 }), 'missing linked image offers manual relocation')
    await ui.click({ standardButton: 65536 })
    await ui.wait(async () => (await documents(ui)).length === 1, 'virtual project opens with missing linked image')
    const missingPixels = fingerprints(await documents(ui))
    const missingSaved = (await stored(page, false, 'virtual')).find(file => file.path === '/home/linked/Converted-layer.kra')!
    await fileAction(ui, 'file_close')
    results.push({
      action: 'deleted_linked_image',
      path: missingSaved.path,
      sha256: missingSaved.sha256,
      pixels: missingPixels,
    })
    expect(downloads).toBe(0)
    await reloadSaved(ui)
    // Unrelated oversized exports must not prevent either ordinary or
    // virtual cached documents from opening.
    const failUnrelatedRead = () => page.evaluateHandle(() => {
      const unrelated = `${window.kritaRecovery.directory}/virtual/tmp/unrelated/payload`
      const fs = window.kritaTestFS
      fs.mkdirTree(unrelated.slice(0, unrelated.lastIndexOf('/')))
      fs.writeFile(unrelated, new Uint8Array([1, 2, 3]))
      const readFile = fs.readFile
      fs.readFile = new Proxy(readFile, {
        apply(target, receiver, argumentsList) {
          if (argumentsList[0] === unrelated)
            throw new RangeError('Unrelated cache allocation fault')
          return Reflect.apply(target, receiver, argumentsList)
        },
      })
      return () => {
        fs.readFile = readFile
        fs.unlink(unrelated)
      }
    })
    let restoreReads = await failUnrelatedRead()
    for (const result of [
      results[0],
      results.find(result => result.action === 'convert_to_file_layer')!,
      ...results.filter(result => result.action.startsWith('device_linked_')),
      results.at(-1)!,
    ]) {
      await openCachedFile(ui, result.path.startsWith('/Documents/')
        ? result.path
        : (await virtualFilesDirectory(page)) + result.path)
      if (result.action === 'deleted_linked_image') {
        await ui.wait(() => ui.find({ standardButton: 65536 }), 'missing linked image still offers relocation after reload')
        await ui.click({ standardButton: 65536 })
      }
      await ui.wait(async () => (await documents(ui)).length === 1, 'closed device document reopens from cache')
      await expect.poll(async () => fingerprints(await documents(ui)), { message: 'cached source pixels restored' }).toEqual(result.pixels)
      await fileAction(ui, 'file_close')
      await ui.wait(async () => (await documents(ui)).length === 0, 'reopened document closes')
    }
    await restoreReads.evaluate(restore => restore())
    await restoreReads.dispose()
    ui.web.check()
    // Incremental Save on an uploaded document is an internal native path,
    // independent of the bounded user file dialog. Its complete cached copy
    // must outlive upload-directory cleanup and restore the same logical path.
    const internalPixels = await editDeviceFile(ui, source)
    const initialUploadPath = (await documents(ui))[0].path
    await fileAction(ui, 'save_incremental_version')
    await ui.wait(() => ui.find({ name: 'kritaWasmDownloadDialog' }), 'internal incremental save commits')
    const internalPath = (await documents(ui))[0].path
    expect(internalPath.startsWith('/tmp/')).toBe(true)
    const internalBytes = await page.evaluate(path => Array.from(window.kritaTestFS.readFile(path)), internalPath)
    const readVirtualFile = async (path: string) => (await stored(page, true, 'virtual'))
      .find(file => file.path === path)
      ?.contents ?? null
    const durableBytes = await readVirtualFile(internalPath)
    expect(durableBytes).toEqual(internalBytes)
    await ui.click({ standardButton: 2097152 })
    const [x, y] = await ui.center(await ui.find({ class: 'KisQPainterCanvas', activeCanvas: true }))
    await page.mouse.move(x - 30, y - 30)
    await page.mouse.down()
    await page.mouse.move(x + 30, y - 25, { steps: 8 })
    await page.mouse.up()
    await ui.wait(async () => (await documents(ui))[0].modified, 'incremental document edited before backup')
    const updatedPixels = fingerprints(await documents(ui))
    expect(updatedPixels).not.toEqual(internalPixels)
    await fileAction(ui, 'save_incremental_backup')
    await ui.wait(() => ui.find({ name: 'kritaWasmDownloadDialog' }), 'incremental backup and updated main file committed')
    const backupPath = internalPath.replace(/\.kra$/i, '~000.kra')
    expect(await readVirtualFile(backupPath)).toEqual(internalBytes)
    expect(await readVirtualFile(`${internalPath}~`)).toEqual(internalBytes)
    const updatedBytes = await page.evaluate(path => Array.from(window.kritaTestFS.readFile(path)), internalPath)
    await ui.click({ standardButton: 2097152 })
    await fileAction(ui, 'file_close')
    await ui.wait(async () => !(await documents(ui)).length, 'upload directory owner closes')
    await ui.wait(() => page.evaluate((path) => {
      try {
        window.kritaTestFS.lookupPath(path, { follow: true })
        return false
      }
      catch { return true }
    }, initialUploadPath), 'unsaved original upload input is released while cached versions remain available')
    await reloadSaved(ui)
    expect(await page.evaluate(path => Array.from(window.kritaTestFS.readFile(path)), internalPath)).toEqual(updatedBytes)
    expect(await readVirtualFile(`${internalPath}~`)).toEqual(internalBytes)
    restoreReads = await failUnrelatedRead()
    const virtualAlias = await virtualFilesDirectory(page)
    await page.evaluate(alias => window.kritaTestFS.rename(alias, '/Documents/Renamed virtual files'), virtualAlias)
    await openCachedFile(ui, `/Documents/Renamed virtual files${internalPath}`)
    await ui.wait(async () => (await documents(ui)).length === 1, 'internal incremental file reopens through the bounded user file browser')
    expect(fingerprints(await documents(ui))).toEqual(updatedPixels)
    expect((await documents(ui))[0].path).toBe(internalPath)
    await fileAction(ui, 'file_close')
    await ui.wait(async () => !(await documents(ui)).length, 'updated internal document closes')
    await openCachedFile(ui, `/Documents/Renamed virtual files${backupPath}`)
    await ui.wait(async () => (await documents(ui)).length === 1, 'numbered virtual backup opens through renamed alias')
    expect(fingerprints(await documents(ui))).toEqual(internalPixels)
    await restoreReads.evaluate(restore => restore())
    await restoreReads.dispose()
    ui.write('device-save-workflow.json', {
      results,
      downloads,
      savedBeforeDownloadPrompt: true,
      internalPath,
      internalPixels,
      updatedPixels,
      backupPath,
    })
  })

  test('native cache rename and deletion persist and stale Recent entries cannot reopen them', async ({ page, web }, info) => {
    const ui = new KritaUI(page, web, info)
    await ui.start('&lang=en&autosaveSeconds=2')
    await ui.paint()
    const pixels = fingerprints(await documents(ui))
    const alias = await virtualFilesDirectory(page)
    await page.evaluate(() => window.kritaTestFS.mkdirTree(`${window.kritaRecovery.directory}/virtual/home`))
    const original = '/home/Recent-probe.kra'
    let renamed = ''
    await nativeSave(ui, `${alias.slice('/Documents/'.length)}${original}`)
    const saved = (await stored(page, true, 'virtual')).find(file => file.path === original)!
    expect(saved.size).toBeGreaterThan(0)
    await ui.click({ standardButton: 2097152 })
    await openCacheDialog(ui)
    const backing = await page.evaluate(() => `${window.kritaRecovery.directory}/virtual/home/Recent-probe.kra`)
    for (const outside of [original, backing]) {
      await ui.replace({ name: 'fileNameEdit' }, outside)
      await page.keyboard.press('Tab')
      await ui.click({ standardButton: 8192 })
      await ui.click({ name: 'fileNameEdit' })
      expect((await ui.find({ class: 'KisPreviewFileDialog' }))?.directory).toBe('/Documents')
      expect((await documents(ui)).length).toBe(1)
    }
    await ui.click({ standardButton: 4194304 })
    await ui.wait(async () => !await ui.find({ class: 'KisPreviewFileDialog' }), 'rejected external selections can be canceled without opening a document')
    expect((await documents(ui)).length).toBe(1)
    const [strokeX, strokeY] = await ui.center(await ui.find({ class: 'KisQPainterCanvas', activeCanvas: true }))
    await page.mouse.move(strokeX - 20, strokeY + 40)
    await page.mouse.down()
    await page.mouse.move(strokeX + 20, strokeY + 40, { steps: 8 })
    await page.mouse.up()
    await committed(ui)
    const named = (await stored(page, true))[0]
    await fileAction(ui, 'file_close')
    await ui.click({ standardButton: 65536 })
    await ui.wait(async () => !(await documents(ui)).length, 'virtual document closes')
    // Recreate a crash-leftover fixture from the real autosave bytes while the
    // current session still has its valid Recent entry (Recent is not persisted).
    await page.evaluate(async (file) => {
      window.kritaTestFS.writeFile(file.storagePath, new Uint8Array(file.contents!))
      await window.kritaRecovery.sync()
    }, named)
    await fileAction(ui, 'file_open_recent')
    const cancelRecent = (await ui.snapshot()).find(item => item.class === 'QMenuAction' && item.text?.includes('Recent-probe.kra'))!
    await ui.click({ class: 'QMenuAction', text: cancelRecent.text })
    await ui.wait(() => ui.find({ class: 'KisRecoverNamedAutosaveDialog' }), 'Recent offers named recovery')
    await ui.click({ name: 'btCancel' })
    await ui.wait(async () => !await ui.find({ class: 'KisRecoverNamedAutosaveDialog' }), 'named recovery canceled')
    expect(await documents(ui)).toEqual([])
    await fileAction(ui, 'file_open_recent')
    expect((await ui.snapshot()).some(item => item.class === 'QMenuAction' && item.text?.includes('Recent-probe.kra'))).toBe(true)
    expect((await stored(page, false, 'virtual')).find(file => file.path === original)?.sha256).toBe(saved.sha256)
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
    await page.evaluate(async (path) => {
      window.kritaTestFS.unlink(path)
      await window.kritaRecovery.sync()
    }, named.storagePath)
    const openFolder = async () => {
      await openCacheDialog(ui)
      await browseCachedDirectory(ui, `${alias}/home`)
    }
    const rejectStaleRecent = async (name: string, welcome = false) => {
      if (welcome) {
        await ui.wait(() => ui.find({ class: 'KritaTestRecentItem', filePath: `/home/${name}` }), 'welcome recent item')
        await ui.click({ class: 'KritaTestRecentItem', filePath: `/home/${name}` })
      }
      else {
        await fileAction(ui, 'file_open_recent')
        const item = (await ui.snapshot()).find(item => item.class === 'QMenuAction' && item.text?.includes(name))
        expect(item).toBeTruthy()
        await ui.click({ class: 'QMenuAction', text: item!.text })
      }
      await ui.click({ action: 'file' })
      const recent = await ui.find({ action: 'file_open_recent' })
      expect(recent).toBeTruthy()
      if (recent!.enabled) {
        await ui.click({ action: 'file_open_recent' })
        await ui.wait(async () => !(await ui.snapshot()).some(item => item.class === 'QMenuAction' && item.text?.includes(name)), 'stale recent entry is removed')
        await page.keyboard.press('Escape')
      }
      expect(await documents(ui)).toEqual([])
      await page.keyboard.press('Escape')
    }
    await openFolder()
    await nativeFileCommand(ui, `${alias}${original}`, 'Rename')
    await ui.wait(() => ui.find({ class: 'QExpandingLineEdit' }), 'native rename editor opens')
    await ui.click({ class: 'QExpandingLineEdit' })
    // Change the basename with native editing keys, retaining the MIME suffix.
    await page.keyboard.press('Home')
    await page.keyboard.press('Delete')
    await page.keyboard.press('Enter')
    const renamedItem = async () => (await ui.snapshot()).find(item => item.class === 'KritaTestFileItem'
      && item.filePath?.startsWith(`${alias}/home/`) && item.filePath.endsWith('.kra') && item.filePath !== `${alias}${original}`)
    await ui.wait(renamedItem, 'native file rename completes')
    renamed = (await renamedItem())!.filePath!.slice(alias.length)
    await ui.wait(async () => {
      const files = await stored(page, false, 'virtual')
      return files.some(file => file.path === renamed && file.sha256 === saved.sha256)
        && !files.some(file => file.path === original)
    }, 'rename reaches IndexedDB without another save or autosave')
    await ui.click({ standardButton: 4194304 })
    await page.evaluate(({ path, bytes }) => {
      const fs = window.kritaTestFS
      try {
        fs.unlink(path)
      }
      catch {}
      fs.writeFile(path, new Uint8Array(bytes!))
    }, { path: original, bytes: saved.contents })
    await rejectStaleRecent('Recent-probe.kra', true)
    await openCachedFile(ui, `${alias}${renamed}`)
    await ui.wait(async () => (await documents(ui)).length === 1, 'renamed file opens')
    expect(fingerprints(await documents(ui))).toEqual(pixels)
    await fileAction(ui, 'file_close')
    await reloadSaved(ui)
    await openCachedFile(ui, `${alias}${renamed}`)
    await ui.wait(async () => (await documents(ui)).length === 1, 'rename survives refresh')
    expect(fingerprints(await documents(ui))).toEqual(pixels)
    await fileAction(ui, 'file_close')
    await openFolder()
    await nativeFileCommand(ui, `${alias}${renamed}`, 'Delete')
    await ui.wait(() => ui.find({ class: 'QMessageBox' }), 'native delete confirmation')
    await ui.click({ standardButton: 16384 })
    await ui.wait(async () => !(await stored(page, false, 'virtual')).some(file => file.path === renamed), 'delete reaches IndexedDB without another save')
    await ui.click({ standardButton: 4194304 })
    await page.evaluate(({ path, bytes }) => {
      const fs = window.kritaTestFS
      try {
        fs.unlink(path)
      }
      catch {}
      fs.writeFile(path, new Uint8Array(bytes!))
    }, { path: renamed, bytes: saved.contents })
    await rejectStaleRecent(renamed.split('/').pop()!)
    await reloadSaved(ui)
    expect((await stored(page, false, 'virtual')).some(file => file.path === original || file.path === renamed)).toBe(false)
    await openFolder()
    expect(await ui.find({ class: 'KritaTestFileItem', filePath: `${alias}${renamed}` })).toBeUndefined()
    await ui.click({ standardButton: 4194304 })
    ui.web.check()
    ui.write('file-manager-persistence.json', {
      original,
      renamed,
      sha256: saved.sha256,
      pixels,
    })
  })

  test('closing Save stays open on cache cancellation or failure and waits for commit acknowledgement', async ({ page, web }, info) => {
    const ui = new KritaUI(page, web, info)
    await ui.start('&lang=en&autosaveSeconds=2')
    const source = await deviceFixture(ui)
    const pixels = await editDeviceFile(ui, source)
    const recoveryBeforeFailure = await committed(ui)
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

    for (const name of ['Failed-close.kra', 'Device-fixture.kra']) {
      await closeAndSave()
      const abort = await abortCacheWrite(page, `/files/${name}`)
      try {
        await chooseSaveDestination(ui, name, 'persistent', name === 'Device-fixture.kra')
        if (name === 'Device-fixture.kra') {
          await ui.wait(() => ui.find({ standardButton: 16384 }), 'overwrite saved baseline')
          await ui.click({ standardButton: 16384 })
        }
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
        await abort.evaluate(state => state.restore())
        await abort.dispose()
      }
      await page.evaluate(() => window.kritaRecovery.sync())
      expect(await stored(page, false, 'saved')).toEqual(before)
      expect((await stored(page)).some(file => file.storagePath === recoveryBeforeFailure[0].storagePath)).toBe(true)
    }

    await closeAndSave()
    const gate = await page.evaluateHandle(() => {
      const fs = window.kritaTestFS
      const original = fs.syncfs
      let release: (() => void) | undefined
      const state = {
        held: false,
        resume: () => {
          fs.syncfs = original
          release?.()
        },
      }
      fs.syncfs = (...args: [boolean, (error: unknown) => void] | [(error: unknown) => void, boolean?]) => {
        const populate = typeof args[0] === 'boolean'
          ? args[0]
          : Boolean(args[1])
        const done = (typeof args[0] === 'function'
          ? args[0]
          : args[1]) as (error: unknown) => void
        original(populate, (error: unknown) => {
          let ready = false
          try {
            ready = fs.isFile(fs.stat('/Documents/Committed-close.kra').mode)
          }
          catch {}
          if (ready && !state.held) {
            state.held = true
            release = () => done(error)
          }
          else {
            done(error)
          }
        })
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

  test('uploaded file-layer inputs survive native timed recovery', async ({ page, context, web }, info) => {
    const ui = new KritaUI(page, web, info)
    await ui.start('&lang=en&autosaveSeconds=2')
    await ui.paint()
    await nativeSave(ui, 'Link-base.kra')
    await ui.click({ standardButton: 2097152 })
    await convertToFileLayer(ui)
    await nativeSave(ui, 'Converted-layer.kra', 'file_save_as')
    await ui.click({ standardButton: 2097152 })
    const uploads = await linkedDeviceFiles(ui)
    const crossTreePixels = fingerprints(await documents(ui))
    const virtualAlias = await virtualFilesDirectory(page)
    await nativeSave(ui, `${virtualAlias.slice('/Documents/'.length)}/Cross-tree.kra`, 'file_save_as')
    await ui.click({ standardButton: 2097152 })
    await fileAction(ui, 'file_close')
    await page.evaluate(async () => {
      const fs = window.kritaTestFS
      fs.unlink('/Documents/Converted-layer.kra')
      await window.kritaRecovery.sync()
    })
    await fileAction(ui, 'file_open')
    await ui.chooseDeviceFile(uploads[0])
    await ui.wait(() => ui.find({ standardButton: 65536 }), 'missing input offers relocation')
    await ui.click({ standardButton: 65536 })
    await ui.wait(async () => (await documents(ui)).length === 1, 'missing-link document opens after explicit No')
    await nativeSave(ui, 'Missing-source.kra', 'file_save_as')
    expect((await stored(page, false, 'saved')).some(file => file.path === '/Documents/Missing-source.kra')).toBe(true)
    await ui.click({ standardButton: 2097152 })
    await fileAction(ui, 'file_close')
    await ui.wait(async () => !(await documents(ui)).length, 'missing-link document closes')
    await fileAction(ui, 'file_open')
    await ui.chooseDeviceFile(uploads)
    await ui.wait(async () => (await documents(ui)).length === 2, 'device KRA and linked PNG open')
    await fileAction(ui, 'file_close')
    await ui.wait(async () => (await documents(ui)).length === 1, 'linked PNG input is retained by KRA')
    await ui.click({ action: 'Layer' })
    await ui.click({ action: 'LayerNew' })
    await ui.click({ action: 'add_new_paint_layer' })
    const firstSnapshot = await committed(ui)
    const undoBeforeStroke = (await documents(ui))[0].undoIndex
    const [x, y] = await ui.center(await ui.find({ class: 'KisQPainterCanvas', activeCanvas: true }))
    await page.mouse.move(x - 25, y + 25)
    await page.mouse.down()
    await page.mouse.move(x + 25, y + 25, { steps: 8 })
    await page.mouse.up()
    await ui.wait(async () => (await documents(ui))[0].undoIndex > undoBeforeStroke, 'uploaded linked stroke committed')
    const before = fingerprints(await documents(ui))
    await committed(ui, 1, firstSnapshot[0].sha256)
    const uploaded = (await documents(ui))[0].path
    const image = `${uploaded.slice(0, uploaded.lastIndexOf('/'))}/converted-layer.png`
    expect((await stored(page, false, 'virtual')).some(file => file.path === image)).toBe(true)
    expect((await stored(page, false, 'virtual')).some(file => file.path === uploaded)).toBe(false)
    await reloadRecovery(ui)
    await expect.poll(async () => fingerprints(await documents(ui))).toEqual(before)
    await nativeSave(ui, 'Recovered-link-base.kra', 'file_save_as')
    await ui.click({ standardButton: 2097152 })
    await page.evaluate(() => window.kritaTestFS.mkdirTree('/Documents/reference-sketch'))
    await convertToFileLayer(ui, '/Documents/reference-sketch/session-reference.png')
    await ui.click({ action: 'Layer' })
    await ui.click({ action: 'LayerNew' })
    await ui.click({ action: 'add_new_paint_layer' })
    await nativeSave(ui, 'reference-sketch/Merged-linked.kra', 'file_save_as')
    await ui.click({ standardButton: 2097152 })
    const saved = fingerprints(await documents(ui))
    const firstSavedSnapshot = await stored(page)
    const undoBeforeSavedStroke = (await documents(ui))[0].undoIndex
    await page.mouse.move(x - 25, y - 25)
    await page.mouse.down()
    await page.mouse.move(x + 25, y - 25, { steps: 8 })
    await page.mouse.up()
    await ui.wait(async () => (await documents(ui))[0].undoIndex > undoBeforeSavedStroke, 'named linked stroke committed')
    const edited = fingerprints(await documents(ui))
    expect(edited).not.toEqual(saved)
    await committed(ui, 1, firstSavedSnapshot[0]?.sha256)
    await reloadRecovery(ui, 4194304)
    const [sameSessionSnapshot] = await committed(ui)
    const sourceFolder = await renameCachedFolder(ui, '/Documents/reference-sketch')
    await ui.wait(async () => {
      const [snapshot] = await stored(page)
      return snapshot?.sha256 === sameSessionSnapshot.sha256
        && decodeURIComponent(snapshot.path).endsWith(`${sourceFolder}/Merged-linked.kra-autosave.kra`.slice('/Documents/'.length))
    }, 'directory rename commits the original recovery snapshot at its new path')
    await reloadRecovery(ui)
    await expect.poll(async () => fingerprints(await documents(ui))).toEqual(edited)
    const linkedSession = await page.evaluate(() => window.kritaRecovery.directory)
    const emptyPage = await context.newPage()
    const empty = new KritaUI(emptyPage, web, info)
    web.statuses.length = 0
    await empty.start('&lang=en&autosaveSeconds=2')
    expect(await documents(empty)).toEqual([])
    // A different primary-session file with the same name must never supply
    // the imported recovery layer.
    await emptyPage.evaluate(async () => {
      const canvas = new OffscreenCanvas(32, 32)
      const context = canvas.getContext('2d')!
      context.fillStyle = '#ff00ff'
      context.fillRect(0, 0, 32, 32)
      const blob = await canvas.convertToBlob()
      window.kritaTestFS.mkdirTree('/Documents/reference-sketch')
      window.kritaTestFS.writeFile('/Documents/reference-sketch/session-reference.png', new Uint8Array(await blob.arrayBuffer()))
      await window.kritaRecovery.sync()
    })
    const emptySession = await emptyPage.evaluate(() => window.kritaRecovery.directory)
    // Exercise the same closed-session merge with the empty session selected first.
    await page.evaluate(([first, second]) => localStorage.setItem('krita.documents.v1', JSON.stringify([first, second])), [emptySession, linkedSession])
    await emptyPage.close()
    await page.close()
    const mergedPage = await context.newPage()
    const merged = new KritaUI(mergedPage, web, info)
    web.statuses.length = 0
    await mergedPage.goto(`${web.url}/?test=1&lang=en&autosaveSeconds=60`, { waitUntil: 'domcontentloaded' })
    await merged.waitForWidgets()
    await merged.wait(() => merged.find({ class: 'KisAutoSaveRecoveryDialog' }), 'merged linked document offers recovery')
    await merged.click({ class: 'QPushButton', buttonRole: 1 })
    await merged.waitForStartup()
    const parent = '/Documents/Other sessions'
    const importedPath = `${parent}/${linkedSession.split('/').at(-1)}`
    const renamedPath = await renameCachedFolder(merged, importedPath)
    const artwork = await renameCachedFolder(merged, `${renamedPath}${sourceFolder}`)
    const movedFile = `${artwork}/Merged-linked.kra`
    await merged.wait(async () => (await stored(mergedPage, false, 'saved')).some(file => file.path === movedFile), 'moved file reaches IndexedDB')
    await reloadRecovery(merged)
    await expect.poll(async () => fingerprints(await documents(merged))).toEqual(edited)
    expect((await documents(merged))[0].savedPath).toBe(movedFile)
    await fileAction(merged, 'file_save')
    await merged.wait(() => merged.find({ class: 'KisPreviewFileDialog', acceptMode: 1 }), 'recovered document asks for a save destination')
    expect((await merged.find({ class: 'KisPreviewFileDialog' }))?.directory).toBe(artwork)
    await merged.click({ standardButton: 4194304 })
    const renamedArtwork = await renameCachedFolder(merged, artwork)
    const renamedFile = `${renamedArtwork}/Merged-linked.kra`
    expect((await documents(merged))[0].savedPath).toBe(renamedFile)
    await fileAction(merged, 'file_close')
    await merged.wait(() => merged.find({ class: 'QMessageBox' }), 'closing recovered linked document offers discard')
    await merged.click({ standardButton: 65536 })
    await merged.wait(async () => !(await documents(merged)).length, 'recovered edits discarded independently of saved work')
    await committed(merged, 0)
    await openCachedFile(merged, renamedFile)
    await expect.poll(async () => fingerprints(await documents(merged))).toEqual(saved)
    await fileAction(merged, 'file_close')
    await openCacheDialog(merged)
    await browseCachedDirectory(merged, `${renamedPath}/Documents`)
    const renamedAlias = `${renamedPath}/Documents/${virtualAlias.slice('/Documents/'.length)}`
    const aliasItem = { class: 'KritaTestFileItem', filePath: renamedAlias }
    await merged.wait(() => merged.find(aliasItem), 'relative alias remains visible after rename')
    await mergedPage.mouse.dblclick(...await merged.center(await merged.find(aliasItem)))
    // Qt displays the canonical directory after following the alias.
    await merged.wait(async () => (await merged.find({ class: 'KisPreviewFileDialog' }))?.directory === renamedPath, 'relative alias opens the moved project directory')
    const savedItem = { class: 'KritaTestFileItem', filePath: `${renamedPath}/Cross-tree.kra` }
    await merged.wait(() => merged.find(savedItem), 'linked project visible through renamed alias')
    await mergedPage.mouse.dblclick(...await merged.center(await merged.find(savedItem)))
    await expect.poll(async () => fingerprints(await documents(merged))).toEqual(crossTreePixels)
    merged.write('uploaded-linked-autosave.json', {
      crossTreePixels,
      before,
      image,
      saved,
      edited,
      linkedSession,
      emptySession,
    })
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
    web.statuses.length = 0
    await page.reload({ waitUntil: 'domcontentloaded' })
    await ui.waitForWidgets()
    await ui.wait(() => ui.find({ class: 'KisAutoSaveRecoveryDialog' }), 'startup recovery before failed discard')
    await abortNextCacheDeletion(page)
    await ui.click({ class: 'QPushButton', buttonRole: 3 })
    await expect(page.locator('html')).toHaveAttribute('data-discard-delete-failed', 'true')
    await ui.wait(() => ui.find({ class: 'QMessageBox' }), 'startup discard failure is retryable')
    expect(await stored(page)).toEqual(saved)
    await page.evaluate(() => Reflect.get(globalThis, 'restoreDiscardDelete')())
    await ui.click({ standardButton: 1024 })
    await ui.wait(() => ui.find({ class: 'KisAutoSaveRecoveryDialog' }), 'recovery choices remain after failed discard')
    await ui.click({ class: 'QPushButton', buttonRole: 1 })
    await ui.waitForStartup()
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
    await abortNextCacheDeletion(page)
    await fileAction(ui, 'file_close')
    await ui.click({ standardButton: 65536 })
    await expect(page.locator('html')).toHaveAttribute('data-discard-delete-failed', 'true')
    await expect(page.locator('#recovery-error')).toContainText('Browser cache could not be saved')
    expect(fingerprints(await documents(ui))).toEqual(before)
    expect((await documents(ui))[0].modified).toBe(true)
    expect(await stored(page)).toHaveLength(1)
    await page.evaluate(async () => {
      Reflect.get(globalThis, 'restoreDiscardDelete')()
      await window.kritaRecovery.sync()
    })
    await fileAction(ui, 'file_close')
    await ui.click({ standardButton: 65536 })
    await ui.wait(async () => (await ui.documents()).length === 0, 'explicit document discard')
    expect(await stored(page)).toEqual([])
    expect(await stored(page, false, 'virtual'), 'discard leaves no permanent copies of temporary recovery exports').toEqual([])
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
    // Incremental versions stay in the same cache namespace, including the
    // subsequent ordinary Save; canonical paths must not create External copies.
    await fileAction(ui, 'save_incremental_version')
    await ui.wait(() => ui.find({ name: 'kritaWasmDownloadDialog' }), 'incremental cache save')
    await ui.click({ standardButton: 2097152 })
    const versions = await stored(page, false, 'saved')
    expect(versions.map(file => file.path).sort()).toEqual(['/Documents/manual-recovery.kra', '/Documents/manual-recovery_001.kra'])
    const versionCanvas = await ui.center(await ui.find({ class: 'KisQPainterCanvas', activeCanvas: true }))
    await page.mouse.move(versionCanvas[0] - 15, versionCanvas[1] - 15)
    await page.mouse.down()
    await page.mouse.move(versionCanvas[0] + 30, versionCanvas[1] - 10, { steps: 5 })
    await page.mouse.up()
    await ui.wait(async () => (await documents(ui)).some(document => document.path === '/Documents/manual-recovery_001.kra' && document.modified), 'incremental version edited')
    await fileAction(ui, 'file_save')
    await ui.wait(async () => await ui.find({ name: 'kritaWasmDownloadDialog' }) || await ui.find({ class: 'KisPreviewFileDialog' }), 'ordinary Save after incremental')
    expect(await ui.find({ class: 'KisPreviewFileDialog' })).toBeUndefined()
    await ui.wait(() => ui.find({ name: 'kritaWasmDownloadDialog' }), 'ordinary Save completes')
    await ui.click({ standardButton: 2097152 })
    expect((await stored(page, false, 'saved')).map(file => file.path).sort()).toEqual(versions.map(file => file.path).sort())
    ui.write('autosave-manual-import.json', { manualDownloadSkipped: true, recoveredDocuments: imported, incrementalFiles: versions })
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
      const scriptFailure = await context.newPage()
      await scriptFailure.addInitScript(() => {
        const append = HTMLHeadElement.prototype.appendChild
        HTMLHeadElement.prototype.appendChild = function <T extends Node>(node: T): T {
          if (node instanceof HTMLScriptElement && new URL(node.src).pathname.endsWith('/krita.js'))
            node.src = new URL('/injected-runtime-load-failure.js', location.href).href
          return append.call(this, node) as T
        }
      })
      await scriptFailure.goto(`${web.url}/?test=1&autosaveSeconds=60`)
      await expect(scriptFailure.locator('#failure')).toBeVisible()
      await expect.poll(() => web.statuses.some(status => status.startsWith('FAIL:'))).toBe(true)
      web.statuses.length = 0
      const failedPage = await context.newPage()
      await failedPage.addInitScript(() => {
        const open = IDBIndex.prototype.openKeyCursor
        let injected = false
        IDBIndex.prototype.openKeyCursor = function (...args) {
          const request = open.apply(this, args)
          if (!injected && this.objectStore.name === 'FILE_DATA' && this.objectStore.transaction.mode === 'readonly') {
            injected = true
            document.documentElement.dataset.cacheReadAborted = 'true'
            this.objectStore.transaction.abort()
          }
          return request
        }
      })
      await failedPage.goto(`${web.url}/?test=1&autosaveSeconds=60`)
      await expect(failedPage.locator('html')).toHaveAttribute('data-cache-read-aborted', 'true')
      await expect(failedPage.locator('#failure')).toBeVisible()
      await expect.poll(() => web.statuses.some(status => status.startsWith('FAIL:'))).toBe(true)
      web.statuses.length = 0
      // Leave the failed tab open. It must not keep the saved sessions locked
      // and hide them from the healthy tab that follows.
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
      await failedPage.close()
      await scriptFailure.close()
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
      const rejected = new WeakSet<IDBTransaction>()
      IDBObjectStore.prototype.put = function (...args) {
        const request = put.apply(this, args)
        if (this.transaction.db.name === window.kritaRecovery.directory && !rejected.has(this.transaction)) {
          rejected.add(this.transaction)
          const failure = this.add(args[0], args[1])
          failure.onerror = () => this.transaction.abort()
        }
        return request
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

  test('closing with Save as PNG commits native layers before the document is destroyed', async ({ page, web }, info) => {
    const ui = new KritaUI(page, web, info)
    await ui.start('&autosaveSeconds=60')
    await ui.paint()
    const before = fingerprints(await documents(ui))
    expect(await stored(page)).toHaveLength(0)
    await fileAction(ui, 'file_close')
    await ui.wait(() => ui.find({ standardButton: 16384 }), 'close asks to Save')
    await ui.click({ standardButton: 16384 })
    await chooseSaveDestination(ui, 'close.png')
    await ui.wait(async () => await ui.find({ class: 'KoDialog' }) || await ui.find({ name: 'kritaWasmDownloadDialog' }), 'PNG options or completed save')
    if (await ui.find({ class: 'KoDialog' }))
      await ui.click({ buttonRole: 0 })
    await ui.wait(() => ui.find({ name: 'kritaWasmDownloadDialog' }), 'close Save download prompt')
    await ui.wait(async () => !(await documents(ui)).length, 'saved document closes')
    await committed(ui)
    await ui.click({ standardButton: 2097152 })
    await reloadRecovery(ui)
    expect(fingerprints(await documents(ui))).toEqual(before)
  })

  test('non-native Save retains native layers and PNG export preserves recovery', async ({ page, web }, info) => {
    const ui = new KritaUI(page, web, info)
    // No periodic snapshot should be needed: non-native Save must trigger the
    // native recovery exporter even after it marks the document clean.
    await ui.start('&autosaveSeconds=60')
    await ui.paint()
    await page.evaluate(async () => {
      const fs = window.kritaTestFS
      fs.mkdirTree('/Documents/original')
      fs.mkdirTree('/Documents/flattened')
      const canvas = new OffscreenCanvas(32, 32)
      const context = canvas.getContext('2d')!
      context.fillStyle = '#ff00ff'
      context.fillRect(0, 0, 32, 32)
      const blob = await canvas.convertToBlob()
      fs.writeFile('/Documents/flattened/reference.png', new Uint8Array(await blob.arrayBuffer()))
    })
    await nativeSave(ui, 'Link-base.kra')
    await ui.click({ standardButton: 2097152 })
    await convertToFileLayer(ui, '/Documents/original/reference.png')
    await ui.click({ action: 'Layer' })
    await ui.click({ action: 'LayerNew' })
    await ui.click({ action: 'add_new_paint_layer' })
    let before = fingerprints(await documents(ui))
    await nativeSave(ui, 'original/layered.kra', 'file_save_as')
    await ui.click({ standardButton: 2097152 })
    await nativeSave(ui, 'flattened/flattened-save.png', 'file_save_as')
    await ui.click({ standardButton: 2097152 })
    await ui.wait(async () => !(await documents(ui))[0].saving, 'forced native snapshot completes')
    let saved = await committed(ui)
    expect((await ui.documents())[0]).toMatchObject({ modified: false })
    await reloadRecovery(ui)
    expect(fingerprints(await documents(ui))).toEqual(before)
    const [x, y] = await ui.center(await ui.find({ class: 'KisQPainterCanvas', activeCanvas: true }))
    await page.mouse.move(x - 30, y + 30)
    await page.mouse.down()
    await page.mouse.move(x + 30, y + 30, { steps: 8 })
    await page.mouse.up()
    await ui.wait(async () => (await documents(ui))[0].modified, 'same PNG document edited before overwrite')
    before = fingerprints(await documents(ui))
    await nativeSave(ui, 'flattened/flattened-save.png', 'file_save_as', 'persistent', true)
    await ui.click({ standardButton: 2097152 })
    const replacement = await committed(ui)
    expect(replacement[0].sha256).not.toBe(saved[0].sha256)
    saved = replacement
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

  for (const discard of [false, true]) {
    test(`live tabs stay isolated and closed sessions merge (${discard ? 'discard' : 'recover'})`, async ({ page, context, web }, info) => {
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
      const secondId = await secondPage.evaluate(() => window.kritaRecovery.directory.split('/').at(-1)!)
      const originalCompanion = await page.evaluate(async (id) => {
        const fs = window.kritaTestFS
        const root = `/Documents/Other sessions/${id}`
        fs.mkdirTree(`${root}/notes.txt`)
        fs.writeFile(`${root}/drafts`, 'primary file conflict')
        fs.writeFile(`${root}/notes.txt/keep.txt`, 'primary directory conflict')
        const canvas = new OffscreenCanvas(1, 1)
        const paint = canvas.getContext('2d')!
        paint.fillStyle = '#ff0000'
        paint.fillRect(0, 0, 1, 1)
        const image = new Uint8Array(await (await canvas.convertToBlob()).arrayBuffer())
        fs.mkdirTree(`${root}/tmp/export_images`)
        fs.writeFile(`${root}/tmp/export.qml`, 'import QtQuick 2.0; Image { source: "export_images/layer.png" }')
        fs.writeFile(`${root}/tmp/export_images/layer.png`, image)
        await window.kritaRecovery.sync()
        return Array.from(image)
      }, secondId)
      const secondaryAlias = await virtualFilesDirectory(secondPage)
      const incomingCompanion = await secondPage.evaluate(async (alias) => {
        const fs = window.kritaTestFS
        fs.rename(alias, '/Documents/Internal files')
        fs.mkdirTree('/Documents/drafts')
        fs.writeFile('/Documents/drafts/child.txt', 'secondary directory contents')
        fs.writeFile('/Documents/notes.txt', 'secondary file contents')
        const virtual = `${window.kritaRecovery.directory}/virtual`
        fs.mkdirTree(`${virtual}/tmp`)
        const recovery = window.kritaRecovery.recoveryDirectory
        const snapshot = fs.readdir(recovery).find(name => name.endsWith('-autosave.kra'))!
        fs.writeFile(`${virtual}/tmp/session.kra`, fs.readFile(`${recovery}/${snapshot}`))
        fs.rename(`${recovery}/${snapshot}`, `${recovery}/.krita-named-${encodeURIComponent('../tmp/session.kra')}-autosave.kra`)
        const canvas = new OffscreenCanvas(1, 1)
        const paint = canvas.getContext('2d')!
        for (const [root, color] of [
          ['/Documents', '#00ff00'],
          ['/Documents/Virtual filesystem', '#ff0000'],
          [virtual, '#0000ff'],
        ]) {
          paint.fillStyle = color
          paint.fillRect(0, 0, 1, 1)
          const image = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer())
          fs.mkdirTree(`${root}/tmp/export_images`)
          fs.writeFile(`${root}/tmp/export.qml`, 'import QtQuick 2.0; Image { source: "export_images/layer.png" }')
          fs.writeFile(`${root}/tmp/export_images/layer.png`, image)
        }
        await window.kritaRecovery.sync()
        return Array.from(fs.readFile('/Documents/tmp/export_images/layer.png'))
      }, secondaryAlias)
      expect(fingerprints(await documents(first))).toEqual(firstPixels)
      expect(await stored(page)).toHaveLength(1)
      // Closing the browser pages does not run Krita's explicit Discard command.
      await secondPage.close()
      await page.close()
      const thirdPage = await context.newPage()
      const third = new KritaUI(thirdPage, web, info)
      web.statuses.length = 0
      await thirdPage.addInitScript(() => {
        const sessions: string[] = JSON.parse(localStorage.getItem('krita.documents.v1')!)
        if (sessions.length < 2)
          return
        const primary = sessions[0]
        // Hold the primary operation while a secondary mount reports I/O failure.
        // Starting Krita or releasing its save queue before this settles would
        // allow a subsequent save to race the unfinished primary write.
        Object.defineProperty(globalThis, 'kritaRecovery', {
          configurable: true,
          get: () => undefined,
          set(state: typeof window.kritaRecovery) {
            Object.defineProperty(globalThis, 'kritaRecovery', { configurable: true, writable: true, value: state })
            const install = state.install
            state.install = (module) => {
              const sync = module.IDBFS.syncfs
              let held = false
              let failed = false
              module.IDBFS.syncfs = (mount, populate, done) => {
                if (!populate && mount.mountpoint === primary && !held) {
                  held = true
                  Reflect.set(globalThis, 'releaseMigrationPrimary', () => sync(mount, populate, done))
                }
                else if (!populate && mount.mountpoint !== primary && !failed) {
                  failed = true
                  document.documentElement.dataset.migrationFailureInjected = 'true'
                  done(29 /* EIO */)
                  document.documentElement.dataset.migrationFailureReturned = 'true'
                }
                else {
                  sync(mount, populate, done)
                }
              }
              install(module)
            }
          },
        })
      })
      await thirdPage.goto(`${web.url}/?test=1&autosaveSeconds=2`, { waitUntil: 'domcontentloaded' })
      await expect(thirdPage.locator('html')).toHaveAttribute('data-migration-failure-injected', 'true', { timeout: 90_000 })
      await expect(thirdPage.locator('html')).toHaveAttribute('data-migration-failure-returned', 'true')
      expect(await thirdPage.evaluate(() => ({
        pending: window.kritaRecovery.pending,
        error: window.kritaRecovery.error,
        ready: Boolean(window.kritaRecovery.widgetsReady),
      }))).toEqual({ pending: 1, error: null, ready: false })
      await thirdPage.evaluate(() => Reflect.get(globalThis, 'releaseMigrationPrimary')())
      await expect(thirdPage.locator('#recovery-error')).toContainText('Browser cache could not be saved')
      await third.waitForWidgets()
      await third.wait(() => third.find({ class: 'KisAutoSaveRecoveryDialog' }), 'both abandoned sessions offered')
      if (!discard) {
        const copied = await stored(thirdPage)
        expect(copied).toHaveLength(2)
        web.statuses.length = 0
        await thirdPage.reload({ waitUntil: 'domcontentloaded' })
        await expect(thirdPage.locator('html')).toHaveAttribute('data-migration-failure-injected', 'true', { timeout: 90_000 })
        await thirdPage.evaluate(() => Reflect.get(globalThis, 'releaseMigrationPrimary')())
        await third.waitForWidgets()
        await third.wait(() => third.find({ class: 'KisAutoSaveRecoveryDialog' }), 'interrupted merge retries without duplicating work')
        expect(await stored(thirdPage)).toEqual(copied)
      }
      if (discard) {
        // Fail the actual source-retirement transaction. Preflight failure
        // must preserve the primary snapshots before deleting any of them.
        const snapshots = await stored(thirdPage)
        await abortNextCacheDeletion(thirdPage, `/krita/storage/${secondId}/`)
        await third.click({ class: 'QPushButton', buttonRole: 3 })
        await expect(thirdPage.locator('html')).toHaveAttribute('data-discard-delete-failed', 'true')
        await third.wait(() => third.find({ class: 'QMessageBox' }), 'source retirement failure keeps startup recovery retryable')
        expect(await stored(thirdPage)).toEqual(snapshots)
        await thirdPage.evaluate(() => Reflect.get(globalThis, 'restoreDiscardDelete')())
        await third.click({ standardButton: 1024 })
        await third.wait(() => third.find({ class: 'KisAutoSaveRecoveryDialog' }), 'retry pending session retirement')
        // The retry retires source copies before acknowledged snapshot deletion,
        // so the next startup cannot resurrect discarded work.
        await third.click({ class: 'QPushButton', buttonRole: 3 })
        await third.waitForStartup()
        await committed(third, 0)
        await reloadSaved(third)
        expect(await third.documents()).toEqual([])
      }
      else {
        await third.click({ class: 'QPushButton', buttonRole: 0 })
        await third.waitForStartup()
        const recovered = fingerprints(await documents(third))
        expect(recovered.sort((a, b) => a.width - b.width)).toEqual([
          ...firstPixels,
          ...secondPixels,
        ].sort((a, b) => a.width - b.width))
        await committed(third, 2)
      }
      const savedContents = await thirdPage.evaluate(() => {
        const fs = window.kritaTestFS
        const contents: string[] = []
        const visit = (path: string) => {
          for (const name of fs.readdir(path).filter(name => name !== '.' && name !== '..')) {
            const child = `${path}/${name}`
            if (fs.isLink(fs.lstat(child).mode))
              continue
            if (fs.isDir(fs.stat(child).mode))
              visit(child)
            else if (!/\.(?:qml|png|kra)$/.test(name))
              contents.push(fs.readFile(child, { encoding: 'utf8' }))
          }
        }
        visit('/Documents')
        return contents
      })
      const imported = await thirdPage.evaluate((id) => {
        const fs = window.kritaTestFS
        const parent = '/Documents/Other sessions'
        const roots = fs.readdir(parent).filter(name => name.startsWith(id) && name !== id)
        if (roots.length !== 1)
          throw new Error(`Expected one separate imported session, got ${roots.length}`)
        const root = `${parent}/${roots[0]}`
        const readCompanion = (directory: string) => {
          const qml = fs.readFile(`${directory}/export.qml`, { encoding: 'utf8' })
          const relative = qml.match(/source: "([^"]+)"/)![1]
          return Array.from(fs.readFile(`${directory}/${relative}`))
        }
        const importedFiles = `${root}/Documents`
        const virtual = ['Virtual filesystem', 'Internal files'].map((name) => {
          const directory = `${importedFiles}/${name}/tmp`
          const qml = fs.readFile(`${directory}/export.qml`, { encoding: 'utf8' })
          const relative = qml.match(/source: "([^"]+)"/)![1]
          return {
            name,
            companion: Array.from(fs.readFile(`${directory}/${relative}`)),
          }
        })
        return {
          virtual,
          original: readCompanion(`${parent}/${id}/tmp`),
          incoming: readCompanion(`${importedFiles}/tmp`),
        }
      }, secondId)
      expect(imported.original).toEqual(originalCompanion)
      expect(imported.incoming).toEqual(incomingCompanion)
      const virtualCopies = imported.virtual
      expect(virtualCopies).toHaveLength(2)
      expect(virtualCopies[0].companion).not.toEqual(virtualCopies[1].companion)
      expect(virtualCopies.map(copy => copy.name).sort()).toEqual(['Internal files', 'Virtual filesystem'])
      expect(savedContents.sort()).toEqual([
        'primary file conflict',
        'primary directory conflict',
        'secondary directory contents',
        'secondary file contents',
      ].sort())
      third.web.check()
      third.write('autosave-tabs.json', {
        firstDirectory,
        originalPixels: [
          ...firstPixels,
          ...secondPixels,
        ],
        discardedAfterMigrationFailure: discard,
      })
    })
  }

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
