import type { Browser, BrowserContext, ConsoleMessage, Page, Request, TestInfo } from '@playwright/test'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { randomUUID } from 'node:crypto'
import { appendFileSync, createReadStream, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, resolve, sep } from 'node:path'
import process from 'node:process'
import { test as base, expect } from '@playwright/test'
import playwrightPackage from '@playwright/test/package.json' with { type: 'json' }
import { artifact, KritaUI } from './krita-ui.ts'

export interface WebFixture {
  root: string
  messages: string[]
  statuses: string[]
  requests: string[]
  url: string
  previewURL: string
  check: () => void
  ready: (status?: string, timeout?: number) => Promise<void>
}

interface WebServer {
  web: WebFixture
  close: () => Promise<void>
}

async function serve(info: () => TestInfo | undefined): Promise<WebServer> {
  const root = resolve(process.env.KRITA_WEB_DIR || 'dist/krita')
  statSync(root)
  const messages: string[] = []
  const statuses: string[] = []
  const requests: string[] = []
  const server = createServer({ maxHeaderSize: 128 * 1024 })
  const previewServer = createServer({ maxHeaderSize: 128 * 1024 })
  const onRequest = (request: IncomingMessage, response: ServerResponse) => {
    const manual = request.socket.localPort === (previewServer.address() as AddressInfo).port
    const directory = manual
      ? resolve(root, 'pages')
      : root
    const url = new URL(request.url!, 'http://localhost')
    response.setHeader('Cache-Control', 'no-store')
    if (url.pathname === '/__probe_log' || url.pathname === '/__probe_result') {
      messages.push(...url.searchParams.getAll('message'))
      statuses.push(...url.searchParams.getAll('status'))
      const current = info()
      if (current)
        appendFileSync(current.outputPath('events.jsonl'), `${JSON.stringify(Object.fromEntries(url.searchParams))}\n`)
      response.writeHead(204).end()
      return
    }
    requests.push(url.pathname)
    if (url.pathname === '/__blank') {
      response.writeHead(200, { 'Content-Type': 'text/html' }).end('<title>Service Worker parent-scope check</title>')
      return
    }
    try {
      const deployedPath = url.pathname.replace(/^\/nested\//, '/')
      const pathname = deployedPath.endsWith('/')
        ? `${deployedPath}index.html`
        : deployedPath
      const download = manual && pathname === '/krita.bundle.tar.gz'
      const path = download
        ? resolve(root, 'krita.bundle.tar.gz')
        : resolve(directory, `.${decodeURIComponent(pathname)}`)
      if (!path.startsWith((download ? root : directory) + sep))
        throw new Error('Invalid path')
      const stat = statSync(path)
      if (!stat.isFile())
        throw new Error('Not a file')
      const mime: Record<string, string> = {
        '.html': 'text/html',
        '.js': 'text/javascript',
        '.css': 'text/css',
        '.json': 'application/json',
        '.wasm': 'application/wasm',
        '.png': 'image/png',
      }
      response.setHeader('Content-Type', mime[extname(path)] || 'application/octet-stream')
      response.setHeader('Content-Length', stat.size)
      if (request.method === 'HEAD')
        response.end()
      else createReadStream(path).on('error', () => response.destroy()).pipe(response)
    }
    catch {
      response.writeHead(404).end()
    }
  }
  server.on('request', onRequest)
  previewServer.on('request', onRequest)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  await new Promise<void>(resolve => previewServer.listen(0, '127.0.0.1', resolve))
  const web: WebFixture = {
    root,
    messages,
    statuses,
    requests,
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    previewURL: `http://127.0.0.1:${(previewServer.address() as AddressInfo).port}`,
    check() {
      const failure = statuses.find(status => status.startsWith('FAIL:'))
      if (failure)
        throw new Error(failure)
    },
    async ready(status = 'KRITA_WASM_WINDOW_READY', timeout = 90_000) {
      await expect.poll(() => {
        web.check()
        return statuses.includes(status)
      }, { timeout, message: status }).toBe(true)
    },
  }
  return {
    web,
    async close() {
      for (const current of [server, previewServer]) {
        current.closeAllConnections()
        await new Promise<void>(resolve => current.close(() => resolve()))
      }
    },
  }
}

async function portableFiles(context: BrowserContext) {
  await context.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker'])
      Object.defineProperty(window, name, { value: undefined, configurable: true })
  })
}

function monitor(context: BrowserContext, browser: Browser, info: TestInfo) {
  const record = (data: unknown) => appendFileSync(info.outputPath('browser.jsonl'), `${JSON.stringify(data)}\n`)
  record({
    type: 'browser',
    engine: info.project.name,
    version: browser.version(),
    playwright: playwrightPackage.version,
  })
  record({ type: 'file-transfer', path: 'HTML file input and browser download; optional File System Access pickers disabled' })
  const cleanups: (() => void)[] = []
  const attach = (page: Page) => {
    const consoleMessage = (message: ConsoleMessage) => record({
      type: 'console',
      level: message.type(),
      text: message.text(),
    })
    const pageError = (error: Error) => record({
      type: 'pageerror',
      text: String(error),
    })
    const requestFailed = (request: Request) => record({
      type: 'requestfailed',
      url: request.url(),
      error: request.failure(),
    })
    const crash = () => record({ type: 'crash' })
    page.on('console', consoleMessage)
    page.on('pageerror', pageError)
    page.on('requestfailed', requestFailed)
    page.on('crash', crash)
    cleanups.push(() => {
      page.off('console', consoleMessage)
      page.off('pageerror', pageError)
      page.off('requestfailed', requestFailed)
      page.off('crash', crash)
    })
  }
  context.pages().forEach(attach)
  context.on('page', attach)
  return () => {
    context.off('page', attach)
    cleanups.forEach(cleanup => cleanup())
  }
}

interface WorkbenchSession {
  key: string
  id: string
  uses: number
  context: BrowserContext
  page: Page
  server: WebServer
  info?: TestInfo
  temporaryFiles: string[]
  documentId: string
  preferences: Record<string, string | null>
  settingsPosition: { x: number, y: number }
}
interface WorkbenchState { session?: WorkbenchSession }

async function closeWorkbench(state: WorkbenchState) {
  const session = state.session
  state.session = undefined
  if (session) {
    try {
      await session.context.close()
    }
    finally {
      await session.server.close()
    }
  }
}

async function resetWorkbench(ui: KritaUI, session: WorkbenchSession) {
  const { page } = ui
  await page.keyboard.press('Escape')
  if (await page.locator('#page-settings').evaluate(element => (element as HTMLDialogElement).open))
    await page.locator('#settings-close').click()
  if ((await ui.snapshot()).some(widget => widget.qml_source === 'qrc:/TextProperties.qml')) {
    const state = await ui.state()
    const title = artifact('catalog', ui.web.root, [
      '--languages',
      JSON.stringify(state.languages),
    ])['Text Properties']
    await ui.click({ action: 'settings' })
    await ui.click({ action: 'settings_dockers_menu' })
    await ui.click({ class: 'QMenuAction', text: title })
  }
  if ((await ui.documents()).length) {
    await page.keyboard.press('b')
    await ui.click({ action: 'file' })
    await ui.click({ action: 'file_close_all' })
    await ui.wait(async () => {
      if (await ui.find({ standardButton: 65536 }))
        await ui.click({ standardButton: 65536 })
      return !(await ui.documents()).length
    }, 'shared workbench closes every document through Krita')
  }
  const button = page.locator('#settings-toggle')
  const box = (await button.boundingBox())!
  const target = session.settingsPosition
  if (Math.abs(box.x - target.x) > 1 || Math.abs(box.y - target.y) > 1) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(target.x + box.width / 2, target.y + box.height / 2, { steps: 5 })
    await page.mouse.up()
  }
  const removed = await page.evaluate(({ before, preferences }) => {
    const fs = window.kritaTestFS
    const removed: string[] = []
    for (const name of fs.readdir('/tmp')) {
      if (!before.includes(name) && fs.isFile(fs.stat(`/tmp/${name}`).mode)) {
        fs.unlink(`/tmp/${name}`)
        removed.push(name)
      }
    }
    const position = preferences['krita.settings-position']
    if (position === null)
      localStorage.removeItem('krita.settings-position')
    else
      localStorage.setItem('krita.settings-position', position)
    return removed
  }, { before: session.temporaryFiles, preferences: session.preferences })
  const preferences = await page.evaluate(keys => Object.fromEntries(keys.map(key => [
    key,
    localStorage.getItem(key),
  ])), Object.keys(session.preferences))
  expect(preferences).toEqual(session.preferences)
  ui.web.check()
  expect(await ui.documents()).toEqual([])
  ui.write('workbench-reset.json', { documents: 0, preferences, removedTemporaryFiles: removed })
}

const test = base.extend<{
  web: WebFixture
  workbench: () => Promise<KritaUI>
}, { workbenchState: WorkbenchState }>({
  workbenchState: [
    // eslint-disable-next-line no-empty-pattern -- Playwright requires destructured fixture parameters.
    async ({}, use) => {
      const state: WorkbenchState = {}
      try {
        await use(state)
      }
      finally {
        await closeWorkbench(state)
      }
    },
    { scope: 'worker' },
  ],
  web: async ({ workbenchState }, use, info) => {
    // Lifecycle tests always get a fresh context and their own origins.
    await closeWorkbench(workbenchState)
    const server = await serve(() => info)
    try {
      await use(server.web)
    }
    finally {
      await server.close()
    }
  },
  context: async ({ context, browser }, use, info) => {
    await portableFiles(context)
    const detach = monitor(context, browser, info)
    try {
      await use(context)
    }
    finally {
      detach()
    }
  },
  workbench: async ({ workbenchState, browser, locale, viewport }, use, info) => {
    let ui: KritaUI | undefined
    let session: WorkbenchSession | undefined
    let detach: (() => void) | undefined
    try {
      await use(async () => {
        const start = performance.now()
        const key = JSON.stringify({ locale, viewport })
        if (workbenchState.session?.key !== key)
          await closeWorkbench(workbenchState)
        session = workbenchState.session
        const reused = !!session
        if (!session) {
          const context = await browser.newContext({ locale, viewport, acceptDownloads: true })
          await portableFiles(context)
          const page = await context.newPage()
          const server = await serve(() => workbenchState.session?.info)
          session = {
            key,
            id: randomUUID(),
            uses: 0,
            context,
            page,
            server,
            info,
            temporaryFiles: [],
            documentId: '',
            preferences: {},
            settingsPosition: { x: 0, y: 0 },
          }
          workbenchState.session = session
        }
        session.info = info
        const web = session.server.web
        web.check()
        if (reused) {
          web.messages.length = 0
          web.statuses.length = 0
          web.requests.length = 0
        }
        detach = monitor(session.context, browser, info)
        ui = new KritaUI(session.page, web, info)
        if (!reused) {
          await ui.start()
          await expect(session.page.locator('#widget-style')).toBeEnabled()
          session.documentId = await session.page.evaluate(() => window.kritaWorkbenchDocument = crypto.randomUUID())
          session.preferences = await session.page.evaluate(() => Object.fromEntries([
            'krita.settings-position',
            'krita.widget-style',
            'krita.color-scheme',
            'krita.corner-radius',
            'krita.ui-languages',
          ].map(key => [
            key,
            localStorage.getItem(key),
          ])))
          session.temporaryFiles = await session.page.evaluate(() => window.kritaTestFS.readdir('/tmp'))
          const box = (await session.page.locator('#settings-toggle').boundingBox())!
          session.settingsPosition = { x: box.x, y: box.y }
        }
        else {
          await ui.waitForWidgets()
          expect(await ui.documents()).toEqual([])
          await expect(session.page.locator('canvas.qt-window-canvas:visible')).toHaveCount(1)
          expect(await session.page.evaluate(() => window.kritaWorkbenchDocument)).toBe(session.documentId)
        }
        expect(web.requests.filter(path => path.endsWith('/krita.bundle.tar.gz'))).toHaveLength(reused ? 0 : 1)
        session.uses++
        ui.write('workbench-startup.json', {
          session: session.id,
          use: session.uses,
          reused,
          milliseconds: performance.now() - start,
          documentTimeOrigin: await session.page.evaluate(() => performance.timeOrigin),
          runtimeDownloads: web.requests.filter(path => path.endsWith('/krita.bundle.tar.gz')).length,
        })
        return ui
      })
      if (ui && session && info.status === info.expectedStatus)
        await resetWorkbench(ui, session)
    }
    finally {
      if (session)
        session.info = undefined
      detach?.()
    }
  },
})
export { expect, test }

// Inspect the actual IDBFS database in a separate readonly transaction. A MEMFS
// file, a timer callback or an in-memory "saved" flag is not persistence proof.
export async function stored(page: Page, contents = false, kind: 'recovery' | 'saved' | 'virtual' = 'recovery') {
  return page.evaluate(async ({ contents, kind }) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(window.kritaRecovery.directory)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    try {
      const entries = await new Promise<{ key: string, contents?: Uint8Array<ArrayBuffer> | Int8Array<ArrayBuffer>, mode: number }[]>((resolve, reject) => {
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
      const storageRoot = kind === 'recovery'
        ? window.kritaRecovery.recoveryDirectory
        : kind === 'virtual'
          ? `${window.kritaRecovery.directory}/virtual`
          : window.kritaRecovery.filesStorageDirectory
      return await Promise.all(entries.filter(entry => entry.contents && entry.key.startsWith(`${storageRoot}/`)
        && (kind === 'saved'
          ? /\.(?:kra|png)$/.test(entry.key)
          : kind === 'recovery'
            ? entry.key.endsWith('-autosave.kra')
            : true)).map(async entry => ({
        path: kind === 'saved'
          ? window.kritaRecovery.filesDirectory + entry.key.slice(storageRoot.length)
          : kind === 'virtual'
            ? entry.key.slice(storageRoot.length)
            : entry.key,
        storagePath: entry.key,
        size: entry.contents!.length,
        sha256: [
          ...new Uint8Array(await crypto.subtle.digest('SHA-256', entry.contents!)),
        ].map(x => x.toString(16).padStart(2, '0')).join(''),
        ...(contents
          ? {
              contents: Array.from(new Uint8Array(entry.contents!)),
            }
          : {}),
      })))
    }
    finally {
      db.close()
    }
  }, { contents, kind })
}
