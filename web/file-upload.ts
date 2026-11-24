import type { KritaModule } from './runtime.js'

export function bindFileUpload(input: HTMLInputElement, drop: HTMLElement, consume: (files: File[], signal: AbortSignal) => Promise<void>, failed: (error: unknown) => void) {
  const controller = new AbortController()
  let busy = false
  input.disabled = false
  input.value = ''
  const load = async (list: FileList | null | undefined) => {
    if (!list?.length || busy || controller.signal.aborted)
      return
    busy = true
    input.disabled = true
    drop.setAttribute('aria-busy', 'true')
    try {
      const files = Array.from(list)
      await consume(input.multiple
        ? files
        : files.slice(0, 1), controller.signal)
    }
    catch (error) {
      if (!controller.signal.aborted)
        failed(error)
    }
    finally {
      if (!controller.signal.aborted) {
        busy = false
        input.disabled = false
        input.value = ''
        drop.removeAttribute('aria-busy')
      }
    }
  }
  input.addEventListener('change', () => load(input.files), { signal: controller.signal })
  drop.addEventListener('dragover', (event) => {
    event.preventDefault()
    if (event.dataTransfer)
      event.dataTransfer.dropEffect = busy ? 'none' : 'copy'
  }, { signal: controller.signal })
  drop.addEventListener('drop', (event) => {
    event.preventDefault()
    void load(event.dataTransfer?.files)
  }, { signal: controller.signal })
  return () => {
    controller.abort()
    input.disabled = false
    input.value = ''
    drop.removeAttribute('aria-busy')
  }
}

export function installFileDialog(module: KritaModule, t: (key: string) => string) {
  const dialog = document.querySelector<HTMLDialogElement>('#file-open')!
  const input = document.querySelector<HTMLInputElement>('#device-file')!
  const drop = document.querySelector<HTMLElement>('#device-drop')!
  const error = document.querySelector<HTMLElement>('#device-error')!
  const close = document.querySelector<HTMLButtonElement>('#file-close')!
  const cache = document.querySelector<HTMLButtonElement>('#file-cache')!
  close.addEventListener('click', () => dialog.close())
  globalThis.kritaChooseFiles = async (directory, title) => {
    if (dialog.open)
      return null
    document.querySelector<HTMLElement>('#file-title')!.textContent = title
    document.querySelector<HTMLElement>('#file-source')!.textContent = t('openSource')
    document.querySelector<HTMLElement>('#cache-title')!.textContent = t('browserCache')
    cache.textContent = t('openCache')
    document.querySelector<HTMLElement>('#device-title')!.textContent = t('openDevice')
    document.querySelector<HTMLElement>('#device-choose')!.textContent = t('filePrompt')
    close.setAttribute('aria-label', t('close'))
    close.title = t('close')
    error.textContent = ''
    return new Promise<string[] | null>((resolve) => {
      let selected: string[] | null = null
      const chooseCache = () => {
        selected = ['cache']
        dialog.close()
      }
      cache.disabled = false
      cache.addEventListener('click', chooseCache)
      const release = bindFileUpload(input, drop, async (files, signal) => {
        error.textContent = ''
        cache.disabled = true
        const paths: string[] = []
        const folders = new Set<string>()
        try {
          for (const [index, file] of files.entries()) {
            const name = file.name
            if (!name || name === '.' || name === '..' || name.includes('\0') || name.includes('/'))
              throw new TypeError('Invalid file name.')
            const data = new Uint8Array(await file.arrayBuffer())
            if (signal.aborted || !dialog.open)
              return
            // Keep unambiguous siblings together so linked images resolve.
            // Duplicate basenames retain separate inputs without guessing links.
            const duplicate = files.some((other, otherIndex) => otherIndex !== index && other.name === name)
            const folder = `${directory}/${duplicate ? index : 'shared'}`
            module.FS.mkdirTree(folder)
            folders.add(folder)
            const path = `${folder}/${name}`
            module.FS.writeFile(path, data, { canOwn: true })
            paths.push(path)
          }
          // Duplicate document names keep separate files, while unambiguous
          // assets remain visible as siblings without another byte copy.
          const shared = `${directory}/shared`
          for (const folder of folders) {
            if (folder === shared || !folders.has(shared))
              continue
            for (const path of paths.filter(path => path.startsWith(`${shared}/`)))
              module.FS.symlink(path, `${folder}/${path.slice(path.lastIndexOf('/') + 1)}`)
          }
        }
        catch (failure) {
          for (const folder of folders) {
            for (const name of module.FS.readdir(folder).filter(name => name !== '.' && name !== '..'))
              module.FS.unlink(`${folder}/${name}`)
            module.FS.rmdir(folder)
          }
          throw failure
        }
        selected = paths
        dialog.close()
      }, (failure) => {
        cache.disabled = false
        error.textContent = `${t('error')}: ${failure instanceof Error
          ? failure.message
          : String(failure)}`
      })
      dialog.addEventListener('close', () => {
        release()
        cache.removeEventListener('click', chooseCache)
        cache.disabled = false
        resolve(selected)
      }, { once: true })
      dialog.showModal()
    })
  }
}
