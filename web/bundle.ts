import { bindFileUpload } from './file-upload.ts'

// The archive is standard gzip + USTAR, produced by scripts/package-krita.py.
interface BundleConfig { schema: number, mode: 'auto' | 'manual', filename: string, cache_version?: string, release_url: string | null }
interface CachedRuntime { id: string, files: Record<string, number>, version: string | null }
export interface Bundle { base: URL, resourceBytes: number, ready: () => Promise<void>, cancel: () => Promise<void> }

const decoder = new TextDecoder('utf-8', { fatal: true })
function isSupportedRuntime(runtime: { jspi?: unknown, cxx_exceptions?: unknown, startup_event?: unknown, file_dialog?: unknown } | null | undefined) {
  return runtime?.jspi === true && runtime.cxx_exceptions === 'wasm-native'
    && runtime.startup_event === 'krita-ready' && runtime.file_dialog === 'linked-batch'
}
const runtimeNames = [
  'COPYING',
  'i18n.json',
  'krita.js',
  'krita.wasm',
  'qtloader.js',
  'resources.tar',
  'runtime.json',
]

export async function readTar(stream: ReadableStream<Uint8Array>, consume: (name: string, data: Uint8Array<ArrayBuffer>) => unknown, maxEntryBytes: number) {
  const reader = stream.getReader()
  let pending: Uint8Array = new Uint8Array()
  let offset = 0
  const read = async (size: number) => {
    const result = new Uint8Array(size)
    let written = 0
    while (written < size) {
      if (offset === pending.length) {
        const next = await reader.read()
        if (next.done)
          throw new Error('Truncated runtime archive.')
        pending = next.value
        offset = 0
      }
      const count = Math.min(size - written, pending.length - offset)
      result.set(pending.subarray(offset, offset + count), written)
      offset += count
      written += count
    }
    return result
  }
  const text = (header: Uint8Array, start: number, length: number) => decoder.decode(header.subarray(start, start + length)).split('\0')[0]
  const octal = (value: string) => {
    const trimmed = value.trim()
    if (!/^[0-7]+$/.test(trimmed))
      throw new Error('Invalid archive number.')
    return Number.parseInt(trimmed, 8)
  }
  const seen = new Set<string>()
  const directories = new Set<string>()
  try {
    while (true) {
      const header = await read(512)
      if (header.every(byte => byte === 0)) {
        if (!(await read(512)).every(byte => byte === 0))
          throw new Error('Invalid archive terminator.')
        // Drain padding and the gzip trailer so decompression errors propagate.
        if (pending.subarray(offset).some(byte => byte !== 0))
          throw new Error('Invalid archive padding.')
        while (true) {
          const next = await reader.read()
          if (next.done)
            return
          if (next.value.some(byte => byte !== 0))
            throw new Error('Invalid archive padding.')
        }
      }
      let checksum = 0
      for (let i = 0; i < 512; ++i) {
        checksum += i >= 148 && i < 156
          ? 32
          : header[i]
      }
      if (checksum !== octal(text(header, 148, 8)) || text(header, 257, 6) !== 'ustar')
        throw new Error('Invalid USTAR header.')
      const prefix = text(header, 345, 155)
      const name = (prefix
        ? `${prefix}/`
        : '') + text(header, 0, 100)
      if (!name || name.includes('\\') || name.split('/').some(part => !part || part === '.' || part === '..') || seen.has(name))
        throw new Error('Invalid or duplicate archive path.')
      if (directories.has(name))
        throw new Error('Archive file and directory conflict.')
      for (let slash = name.indexOf('/'); slash !== -1; slash = name.indexOf('/', slash + 1)) {
        const directory = name.slice(0, slash)
        if (seen.has(directory))
          throw new Error('Archive file and directory conflict.')
        directories.add(directory)
      }
      if (![0, 48].includes(header[156]))
        throw new Error('Only regular runtime files are supported.')
      const size = octal(text(header, 124, 12))
      if (!Number.isSafeInteger(size) || size > maxEntryBytes)
        throw new Error('Runtime archive entry is too large.')
      seen.add(name)
      await consume(name, await read(size))
      await read((512 - size % 512) % 512)
    }
  }
  finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

function releaseLink(config: BundleConfig, scope: URL) {
  if (config.release_url)
    return config.release_url
  const match = scope.hostname.match(/^([a-z0-9-]+)\.github\.io$/i)
  if (!match) {
    return [
      'localhost',
      '127.0.0.1',
      '0.0.0.0',
      '[::1]',
    ].includes(scope.hostname)
      ? new URL(`../${config.filename}`, scope).href
      : null
  }
  const repository = scope.pathname.split('/').filter(Boolean)[0] || `${match[1]}.github.io`
  return `https://github.com/${match[1]}/${encodeURIComponent(repository)}/releases`
}

export async function prepareBundle(status: HTMLElement, t: (key: string) => string): Promise<Bundle> {
  const scope = new URL('./', location.href)
  const response = await fetch(new URL('bundle.json', scope))
  if (!response.ok)
    throw new Error(`Bundle configuration: HTTP ${response.status}`)
  const config: BundleConfig = await response.json()
  if (config.schema !== 2 || !['auto', 'manual'].includes(config.mode)
    || config.filename !== 'krita.bundle.tar.gz'
    || (config.mode === 'auto' && typeof config.cache_version !== 'string')) {
    throw new Error('Invalid runtime bundle configuration.')
  }
  const cacheName = `krita-runtime-v2:${scope.href}`
  const cache = await caches.open(cacheName)
  const activeURL = new URL('.runtime/active.json', scope)
  const activeLock = `${cacheName}:active`
  const pins = new Map<string, () => void>()
  const pin = (id: string) => new Promise<void>((resolve, reject) => {
    if (pins.has(id)) {
      resolve()
      return
    }
    navigator.locks.request(`${cacheName}:${id}`, { mode: 'shared' }, () => new Promise<void>((release) => {
      pins.set(id, release)
      resolve()
    })).catch(reject)
  })
  const unpin = (id: string) => {
    pins.get(id)?.()
    pins.delete(id)
  }
  const removeGeneration = async (id: string) => {
    const base = new URL(`.runtime/${id}/`, scope)
    for (const request of await cache.keys()) {
      if (request.url.startsWith(base.href))
        await cache.delete(request)
    }
  }
  const prune = async () => {
    const generations = new Map<string, Request[]>()
    for (const request of await cache.keys()) {
      const relative = request.url.slice(new URL('.runtime/', scope).href.length)
      const id = relative.split('/')[0]
      if (!request.url.startsWith(new URL('.runtime/', scope).href) || !/^[a-f0-9]{32}$/.test(id))
        continue
      const entries = generations.get(id) || []
      entries.push(request)
      generations.set(id, entries)
    }
    for (const [id, entries] of generations) {
      await navigator.locks.request(`${cacheName}:${id}`, { ifAvailable: true }, async (lock) => {
        if (!lock)
          return
        const published = await cache.match(activeURL)
        if ((await published?.json().catch(() => null))?.id === id)
          return
        await Promise.all(entries.map(request => cache.delete(request)))
      })
    }
  }
  const complete = async () => {
    const active = await cache.match(activeURL)
    if (!active)
      return null
    let state: CachedRuntime
    try {
      state = await active.json()
    }
    catch {
      return null
    }
    if (!/^[a-f0-9]{32}$/.test(state.id) || !state.files
      || Object.keys(state.files).sort().join() !== runtimeNames.join()
      || (config.mode === 'auto' && state.version !== config.cache_version)) {
      return null
    }
    await pin(state.id)
    const base = new URL(`.runtime/${state.id}/`, scope)
    try {
      for (const name of runtimeNames) {
        const item = await cache.match(new URL(name, base))
        if (!item || state.files[name] <= 0 || Number(item.headers.get('Content-Length')) !== state.files[name]) {
          unpin(state.id)
          return null
        }
      }
      const runtime = await (await cache.match(new URL('runtime.json', base)))?.json().catch(() => null)
      if (!isSupportedRuntime(runtime)) {
        unpin(state.id)
        return null
      }
      return state
    }
    catch (error) {
      unpin(state.id)
      throw error
    }
  }
  const unpack = async (blob: Blob, consume: (name: string, data: Uint8Array<ArrayBuffer>) => Promise<void>) => {
    let count = 0
    await readTar(blob.stream().pipeThrough(new DecompressionStream('gzip')), async (name, data) => {
      if (!runtimeNames.includes(name) || !data.length)
        throw new Error('Unexpected or empty runtime bundle file.')
      if (name === 'krita.wasm' && !WebAssembly.validate(data))
        throw new Error('Invalid WebAssembly module.')
      if (name === 'i18n.json') {
        const index = JSON.parse(decoder.decode(data))
        if (!index || !Array.isArray(index.languages) || !index.languages.length
          || index.languages.some((language: unknown) => typeof language !== 'string' || !language)) {
          throw new Error('Invalid runtime language index.')
        }
      }
      if (name === 'runtime.json') {
        const runtime = JSON.parse(decoder.decode(data))
        if (!isSupportedRuntime(runtime))
          throw new Error('Invalid runtime configuration.')
      }
      if (name === 'resources.tar')
        await readResources(new Blob([data]).stream(), () => {}, data.length)
      count++
      await consume(name, data)
    }, 0x7FFFFFFF)
    if (count !== runtimeNames.length)
      throw new Error('Runtime bundle is missing files.')
  }
  const install = async (blob: Blob, retry = true): Promise<CachedRuntime> => {
    status.textContent = t('loading')
    const state: CachedRuntime = {
      id: crypto.randomUUID().replaceAll('-', ''),
      files: {},
      version: config.cache_version ?? null,
    }
    await pin(state.id)
    const base = new URL(`.runtime/${state.id}/`, scope)
    try {
      await unpack(blob, async (name, data) => {
        const type = name.endsWith('.js')
          ? 'text/javascript'
          : name.endsWith('.wasm')
            ? 'application/wasm'
            : 'application/octet-stream'
        await cache.put(new URL(name, base), new Response(data, {
          headers: {
            'Content-Type': type,
            'Content-Length': String(data.length),
          },
        }))
        state.files[name] = data.length
      })
      // Keep the candidate private until the real Krita window starts.
      return state
    }
    catch (failure) {
      unpin(state.id)
      await removeGeneration(state.id)
      if (retry && failure instanceof DOMException && failure.name === 'QuotaExceededError') {
        // Validate the complete user-supplied replacement before making room.
        // Never delete IndexedDB documents or a generation held by another tab.
        await unpack(blob, async () => {})
        const previous = await cache.match(activeURL)
        const id = (await previous?.json().catch(() => null))?.id
        if (typeof id === 'string' && /^[a-f0-9]{32}$/.test(id)) {
          const removed = await navigator.locks.request(`${cacheName}:${id}`, { ifAvailable: true }, async (lock) => {
            if (!lock)
              return false
            return navigator.locks.request(activeLock, async () => {
              if ((await (await cache.match(activeURL))?.json())?.id !== id)
                return false
              // eslint-disable-next-line no-alert -- Freeing the only cached runtime needs an explicit choice.
              if (!window.confirm(t('clearRuntimeCache')))
                return false
              await cache.delete(activeURL)
              await removeGeneration(id)
              return true
            })
          })
          if (removed)
            return install(blob, false)
        }
      }
      throw failure
    }
  }
  const choose = config.mode === 'manual' && new URL(location.href).searchParams.get('bundle') === 'choose'
  let candidate = false
  let cancelled = false
  let state = choose
    ? null
    : await complete()
  await prune()
  // Another tab may publish while an obsolete generation is being collected.
  if (!choose)
    state ||= await complete()
  if (!state) {
    if (config.mode === 'auto') {
      status.textContent = t('loading')
      const download = await fetch(new URL(config.filename, scope))
      if (!download.ok)
        throw new Error(`Runtime bundle: HTTP ${download.status}`)
      const blob = await download.blob()
      const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())), byte => byte.toString(16).padStart(2, '0')).join('')
      if (digest !== config.cache_version)
        throw new Error('Runtime bundle does not match its configuration; reload to retry.')
      state = await install(blob)
      candidate = true
    }
    else {
      const panel = document.querySelector<HTMLElement>('#bundle-panel')!
      const input = document.querySelector<HTMLInputElement>('#bundle-file')!
      const drop = document.querySelector<HTMLElement>('#bundle-drop')!
      const error = document.querySelector<HTMLElement>('#bundle-error')!
      const link = document.querySelector<HTMLAnchorElement>('#bundle-release')!
      const url = releaseLink(config, scope)
      const target = url && URL.canParse(url, scope)
        ? new URL(url, scope)
        : null
      // A malformed optional download link must not disable local import.
      if (target && (target.protocol === 'https:' || target.origin === scope.origin)) {
        link.href = target.href
        if (target.origin === scope.origin) {
          link.download = config.filename
        }
      }
      else {
        link.hidden = true
      }
      link.textContent = t('download')
      document.querySelector<HTMLElement>('#bundle-prompt')!.textContent = t('bundlePrompt').replace('{filename}', config.filename)
      document.querySelector<HTMLElement>('#bundle-choose')!.textContent = t('filePrompt')
      document.querySelector<HTMLElement>('#bundle-cache')!.textContent = t('bundleCache')
      panel.hidden = false
      status.textContent = t('openDevice')
      state = await new Promise<CachedRuntime>((resolve) => {
        const release = bindFileUpload(input, drop, async ([file]) => {
          error.textContent = ''
          const selected = await install(file)
          candidate = true
          const url = new URL(location.href)
          url.searchParams.delete('bundle')
          history.replaceState(null, '', url)
          panel.hidden = true
          release()
          resolve(selected)
        }, (failure) => {
          error.textContent = `${t('error')}: ${failure instanceof Error
            ? failure.message
            : String(failure)}`
          status.textContent = t('openDevice')
        })
      })
    }
  }
  else {
    status.textContent = t('loading')
  }
  if (config.mode === 'manual') {
    const replace = document.querySelector<HTMLButtonElement>('#bundle-replace')!
    replace.textContent = t('replaceBundle')
    replace.hidden = false
    replace.addEventListener('click', async () => {
      // eslint-disable-next-line no-alert -- Replacing a runtime must explicitly confirm loss of unsaved work.
      if (!window.confirm(t('changeWarning')))
        return
      // Choosing a replacement is local to this tab until installation
      // publishes it. Other tabs retain the current saved selection.
      const url = new URL(location.href)
      url.searchParams.set('bundle', 'choose')
      location.assign(url.href)
    })
  }
  return {
    base: new URL(`.runtime/${state.id}/`, scope),
    resourceBytes: state.files['resources.tar'],
    async ready() {
      await navigator.locks.request(activeLock, async () => {
        if (cancelled)
          throw new Error('Runtime startup was cancelled.')
        if (candidate) {
          await cache.put(activeURL, new Response(JSON.stringify(state)))
          candidate = false
        }
      })
      await prune().catch(error => console.warn('Unused runtime cache cleanup failed', error))
    },
    async cancel() {
      await navigator.locks.request(activeLock, async () => {
        cancelled = true
        unpin(state.id)
        if (!candidate)
          return
        candidate = false
        await removeGeneration(state.id)
      })
    },
  }
}

async function readResources(stream: ReadableStream<Uint8Array>, consume: (name: string, data: Uint8Array<ArrayBuffer>) => unknown, bytes: number) {
  await readTar(stream, (name, data) => {
    if (![
      'krita/',
      'fonts/',
      'etc/fonts/',
      'usr/share/fontconfig/',
    ].some(prefix => name.startsWith(prefix))) {
      throw new Error('Unexpected resource destination.')
    }
    return consume(name, data)
  }, bytes)
}

export async function loadBundleResources(bundle: Bundle) {
  const response = await fetch(new URL('resources.tar', bundle.base))
  if (!response.ok)
    throw new Error(`Packed resources: HTTP ${response.status}`)
  const resources: { destination: string, data: Uint8Array<ArrayBuffer> }[] = []
  await readResources(response.body!, (name, data) => {
    resources.push({ destination: `/${name}`, data })
  }, bundle.resourceBytes)
  return resources
}

export async function loadRuntimeScript(url: URL) {
  await new Promise<void>((resolve, reject) => {
    const script = document.createElement('script')
    script.src = url.href
    script.onload = () => resolve()
    script.onerror = () => reject(new Error(`Runtime script could not load: ${url.pathname}`))
    document.head.appendChild(script)
  })
}
