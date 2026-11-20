import { bindFileUpload } from './file-upload.ts'

// The archive is standard gzip + USTAR, produced by scripts/package-krita.py.
interface BundleConfig { schema: number, mode: 'auto' | 'manual', filename: string, cache_version?: string, release_url: string | null }
interface CachedRuntime { id: string, files: Record<string, number>, version: string | null }
export interface Bundle { base: URL, resourceBytes: number }

const decoder = new TextDecoder('utf-8', { fatal: true })
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
  const seen = new Set()
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
  const cache = await caches.open(`krita-runtime-v2:${scope.href}`)
  const activeURL = new URL('.runtime/active.json', scope)
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
    const base = new URL(`.runtime/${state.id}/`, scope)
    for (const name of runtimeNames) {
      const item = await cache.match(new URL(name, base))
      if (!item || Number(item.headers.get('Content-Length')) !== state.files[name])
        return null
    }
    return state
  }
  const install = async (blob: Blob) => {
    status.textContent = t('loading')
    const state: CachedRuntime = {
      id: crypto.randomUUID().replaceAll('-', ''),
      files: {},
      version: config.cache_version ?? null,
    }
    const base = new URL(`.runtime/${state.id}/`, scope)
    try {
      await readTar(blob.stream().pipeThrough(new DecompressionStream('gzip')), async (name, data) => {
        if (!runtimeNames.includes(name))
          throw new Error('Unexpected runtime bundle file.')
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
      }, 0x7FFFFFFF)
      if (Object.keys(state.files).length !== runtimeNames.length)
        throw new Error('Runtime bundle is missing files.')
      // Publish the selected runtime only after all archive/cache writes pass.
      await cache.put(activeURL, new Response(JSON.stringify(state)))
      return state
    }
    catch (failure) {
      await Promise.all(Object.keys(state.files).map(name => cache.delete(new URL(name, base))))
      throw failure
    }
  }
  let state = await complete()
  if (!state) {
    if (config.mode === 'auto') {
      status.textContent = t('loading')
      const download = await fetch(new URL(config.filename, scope))
      if (!download.ok)
        throw new Error(`Runtime bundle: HTTP ${download.status}`)
      state = await install(await download.blob())
    }
    else {
      const panel = document.querySelector<HTMLElement>('#bundle-panel')!
      const input = document.querySelector<HTMLInputElement>('#bundle-file')!
      const drop = document.querySelector<HTMLElement>('#bundle-drop')!
      const error = document.querySelector<HTMLElement>('#bundle-error')!
      const link = document.querySelector<HTMLAnchorElement>('#bundle-release')!
      const url = releaseLink(config, scope)
      if (url) {
        const target = new URL(url)
        if (target.protocol !== 'https:' && target.origin !== scope.origin)
          throw new Error('Release links require HTTPS.')
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
        const release = bindFileUpload(input, drop, async (file) => {
          error.textContent = ''
          const selected = await install(file)
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
      await cache.delete(activeURL)
      location.reload()
    })
  }
  return {
    base: new URL(`.runtime/${state.id}/`, scope),
    resourceBytes: state.files['resources.tar'],
  }
}

export async function loadBundleResources(bundle: Bundle) {
  const response = await fetch(new URL('resources.tar', bundle.base))
  if (!response.ok)
    throw new Error(`Packed resources: HTTP ${response.status}`)
  const resources: { destination: string, data: Uint8Array<ArrayBuffer> }[] = []
  await readTar(response.body!, (name, data) => {
    if (![
      'krita/',
      'fonts/',
      'etc/fonts/',
      'usr/share/fontconfig/',
    ].some(prefix => name.startsWith(prefix))) {
      throw new Error('Unexpected resource destination.')
    }
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
