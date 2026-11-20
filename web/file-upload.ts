import type { KritaModule } from './runtime.js'

export function bindFileUpload(input: HTMLInputElement, drop: HTMLElement, consume: (file: File, signal: AbortSignal) => Promise<void>, failed: (error: unknown) => void) {
  const controller = new AbortController()
  let busy = false
  input.disabled = false
  input.value = ''
  const load = async (file: File | undefined) => {
    if (!file || busy || controller.signal.aborted)
      return
    busy = true
    input.disabled = true
    drop.setAttribute('aria-busy', 'true')
    try {
      await consume(file, controller.signal)
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
  input.addEventListener('change', () => load(input.files?.[0]), { signal: controller.signal })
  drop.addEventListener('dragover', (event) => {
    event.preventDefault()
    if (event.dataTransfer)
      event.dataTransfer.dropEffect = busy ? 'none' : 'copy'
  }, { signal: controller.signal })
  drop.addEventListener('drop', (event) => {
    event.preventDefault()
    void load(event.dataTransfer?.files[0])
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
  globalThis.kritaChooseFile = async (directory, title) => {
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
    return new Promise<string | null>((resolve) => {
      let selected: string | null = null
      const chooseCache = () => {
        selected = 'cache'
        dialog.close()
      }
      cache.disabled = false
      cache.addEventListener('click', chooseCache)
      const release = bindFileUpload(input, drop, async (file, signal) => {
        error.textContent = ''
        cache.disabled = true
        const name = file.name.split(/[\\/]/).at(-1)
        if (!name || name === '.' || name === '..' || name.includes('\0'))
          throw new TypeError('Invalid file name.')
        const data = new Uint8Array(await file.arrayBuffer())
        if (signal.aborted)
          return
        const path = `${directory}/${name}`
        module.FS.writeFile(path, data, { canOwn: true })
        selected = path
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
