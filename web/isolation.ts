// Resolve only when this document can safely instantiate a threaded Wasm app.
export async function ensureIsolation() {
  if (globalThis.crossOriginIsolated && typeof SharedArrayBuffer === 'undefined')
    throw new Error('Cross-origin isolation is active, but this browser does not provide SharedArrayBuffer, which is required for Wasm threads.')
  if (!globalThis.isSecureContext || !('serviceWorker' in navigator)) {
    throw new Error('A secure context with Service Worker support is required.')
  }
  const scope = new URL('./', location.href)
  const reloadKey = `krita-isolation-reload:${scope.href}`
  const workerURL = new URL('isolation-sw.js', scope)
  const registration = await navigator.serviceWorker.register(
    workerURL,
    { scope: scope.href, updateViaCache: 'none' },
  )
  // Cached runtime URLs need this scope's Worker even when a server or a
  // parent scope already supplied isolation. Wait for an update to activate.
  const installing = registration.installing || registration.waiting
  if (installing && installing.state !== 'activated') {
    await new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>
      const changed = () => {
        if (!['activated', 'redundant'].includes(installing.state))
          return
        clearTimeout(timer)
        installing.removeEventListener('statechange', changed)
        if (installing.state === 'activated')
          resolve()
        else reject(new Error('Service Worker installation failed.'))
      }
      timer = setTimeout(() => {
        installing.removeEventListener('statechange', changed)
        reject(new Error('Timed out activating Service Worker.'))
      }, 20000)
      installing.addEventListener('statechange', changed)
      changed()
    })
  }
  await navigator.serviceWorker.ready
  const controlled = () => navigator.serviceWorker.controller?.scriptURL === workerURL.href
    && navigator.serviceWorker.controller === registration.active
  if (!controlled()) {
    await new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>
      const changed = () => {
        if (!controlled())
          return
        clearTimeout(timer)
        navigator.serviceWorker.removeEventListener('controllerchange', changed)
        resolve()
      }
      timer = setTimeout(() => {
        navigator.serviceWorker.removeEventListener('controllerchange', changed)
        reject(new Error('Timed out waiting for Service Worker control.'))
      }, 20000)
      navigator.serviceWorker.addEventListener('controllerchange', changed)
      changed()
    })
  }
  if (globalThis.crossOriginIsolated && typeof SharedArrayBuffer !== 'undefined') {
    sessionStorage.removeItem(reloadKey)
    return
  }
  if (!registration.active || sessionStorage.getItem(reloadKey)) {
    throw new Error('Cross-origin isolation failed after reload; check browser and Worker support.')
  }
  sessionStorage.setItem(reloadKey, '1')
  location.reload()
  // The old document must not start downloading or instantiating the application.
  await new Promise(() => {})
}
