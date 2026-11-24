import type { BrowserContext } from '@playwright/test'
import type { DocumentSnapshot } from './native.js'
import { expect, test } from './fixtures.ts'
import { KritaUI } from './krita-ui.ts'

test('IDBFS recovery survives closing and restarting an owned browser profile', async ({ web, playwright, browserName }, info) => {
  const profile = info.outputPath('browser-profile')
  let context: BrowserContext | null = null
  const launch = async () => {
    context = await playwright[browserName].launchPersistentContext(profile, {
      headless: true,
      locale: 'en-US',
      viewport: { width: 1280, height: 900 },
    })
    const page = context.pages()[0] || await context.newPage()
    return new KritaUI(page, web, info)
  }
  const pixels = async (ui: KritaUI) => (await ui.snapshot<DocumentSnapshot>(true)).filter(item => item.class === 'KritaTestDocument').map(({ width, height, layerPixels }) => ({ width, height, layerPixels }))
  try {
    const original = await launch()
    await original.start('&autosaveSeconds=2')
    await original.paint()
    const before = await pixels(original)
    await original.wait(() => original.page.evaluate(async () => {
      if (window.kritaRecovery.pending)
        return false
      const document = window.kritaTestSnapshot().find(item => item.class === 'KritaTestDocument') as DocumentSnapshot | undefined
      if (!document?.recoveryPath)
        return false
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(window.kritaRecovery.directory)
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      try {
        return await new Promise((resolve, reject) => {
          const transaction = db.transaction('FILE_DATA', 'readonly')
          const request = transaction.objectStore('FILE_DATA').get(document.recoveryPath)
          transaction.oncomplete = () => resolve(request.result?.contents?.length > 0)
          transaction.onerror = () => reject(transaction.error)
        })
      }
      finally {
        db.close()
      }
    }), 'real IDBFS transaction commits before browser shutdown')
    await context!.close()
    context = null
    web.statuses.length = 0
    web.requests.length = 0
    const restored = await launch()
    await restored.page.goto(`${web.url}/?test=1&autosaveSeconds=2`, { waitUntil: 'domcontentloaded' })
    await restored.waitForWidgets()
    await restored.wait(() => restored.find({ class: 'KisAutoSaveRecoveryDialog' }), 'persisted profile offers native recovery')
    await restored.shot('persistent-recovery-dialog')
    await restored.click({ class: 'QPushButton', buttonRole: 0 })
    await restored.waitForStartup()
    expect(await pixels(restored)).toEqual(before)
    await restored.shot('persistent-recovered')
    restored.web.check()
    restored.write('persistent-profile-recovery.json', {
      browser: browserName,
      intervalSeconds: 2,
      browserRestarted: true,
      before,
    })
  }
  finally {
    await (context as BrowserContext | null)?.close()
  }
})
