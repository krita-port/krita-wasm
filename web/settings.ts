type NativeSetter = (value: number) => number
type Scheme = 'light' | 'dark'

export const widgetStyleKey = 'krita.widget-style'

export function installCornerSettings(windowInput: HTMLInputElement, controlInput: HTMLInputElement, storage: Storage | undefined) {
  const key = 'krita.corner-radius'
  let values: Partial<Record<'window' | 'controls', number>> | undefined
  try {
    values = JSON.parse(storage?.getItem(key) || 'null')
  }
  catch { /* Use defaults. */ }
  let request: NativeSetter | undefined
  const apply = () => {
    const windowRadius = Number(windowInput.value)
    const controlRadius = Number(controlInput.value)
    document.documentElement.style.setProperty('--app-window-radius', `${windowRadius}px`)
    document.documentElement.style.setProperty('--app-control-radius', `${controlRadius}px`);
    (windowInput.nextElementSibling as HTMLOutputElement).value = `${windowRadius}px`;
    (controlInput.nextElementSibling as HTMLOutputElement).value = `${controlRadius}px`
    request?.(controlRadius)
  }
  for (const [input, name, fallback, max] of [
    [windowInput, 'window', 8, 24],
    [controlInput, 'controls', 4, 12],
  ] as const) {
    const value = values?.[name]
    input.value = String(typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max
      ? value
      : fallback)
    input.addEventListener('input', () => {
      apply()
      try {
        storage?.setItem(key, JSON.stringify({
          window: Number(windowInput.value),
          controls: Number(controlInput.value),
        }))
      }
      catch { /* Live switching still works without persistence. */ }
    })
  }
  apply()
  return {
    connectNative(setter: NativeSetter) {
      request = setter
      apply()
    },
  }
}

export function installAppearance(select: HTMLSelectElement, storage: Storage | undefined) {
  const key = 'krita.color-scheme'
  const root = document.documentElement
  const media = window.matchMedia('(prefers-color-scheme: dark)')
  let choice: 'auto' | Scheme = 'auto'
  try {
    const saved = storage?.getItem(key)
    if (saved === 'light' || saved === 'dark')
      choice = saved
  }
  catch { /* Use browser preference. */ }
  let request: NativeSetter | undefined, pending: Scheme | null
  let nativeReady = false
  const colors = {
    window: '--app-surface',
    windowText: '--app-text',
    button: '--app-button',
    buttonText: '--app-button-text',
    border: '--app-border',
    accent: '--app-accent',
    accentText: '--app-accent-text',
    link: '--app-link',
  } as const
  const scheme = () => choice === 'auto'
    ? (media.matches ? 'dark' : 'light')
    : choice
  const remember = () => {
    try {
      if (choice === 'auto')
        storage?.removeItem(key)
      else storage?.setItem(key, choice)
    }
    catch { /* Live switching still works without persistence. */ }
  }
  const show = (value: Scheme) => {
    root.dataset.colorScheme = value
    root.style.colorScheme = value
    root.style.setProperty('--app-title-icon-filter', value === 'dark'
      ? 'invert(1)'
      : 'none')
  }
  const send = () => {
    // Startup palette acknowledgements also track the latest choice, including
    // changes made while the native bridge is not ready to send it yet.
    pending = scheme()
    if (!request || !nativeReady)
      return
    if (!request(pending === 'dark'
      ? 1
      : 0)) {
      pending = null
    }
  }
  const apply = () => {
    select.value = choice
    show(scheme())
    for (const property of Object.values(colors)) root.style.removeProperty(property)
    send()
  }
  const paletteChanged = () => {
    const state = globalThis.kritaPalette
    if (!state)
      return
    const first = !nativeReady
    nativeReady = true
    const current = state.dark ? 'dark' : 'light'
    if (!first && request && !pending && current !== scheme()) {
      // An opposite-brightness theme selected inside Krita is a manual choice.
      choice = current
      select.value = choice
      remember()
    }
    if (current === pending)
      pending = null
    show(current)
    for (const [name, property] of (Object.entries(colors) as [keyof typeof colors, string][])) root.style.setProperty(property, state[name])
    if (first && current !== scheme())
      send()
  }
  select.addEventListener('change', () => {
    choice = select.value as 'auto' | Scheme
    remember()
    apply()
  })
  media.addEventListener('change', () => {
    if (choice === 'auto')
      apply()
  })
  window.addEventListener('krita-palette-change', paletteChanged)
  apply()
  return {
    scheme,
    connectNative(setter: NativeSetter) {
      request = setter
      pending = scheme()
      const shadow = document.querySelector<HTMLElement>('#qt-shadow-container')!.shadowRoot!
      // Qt Wasm 6.10 toggles maximization on title-bar double-click even when
      // WindowMaximizeButtonHint is absent. Honor that hint in its DOM frame.
      shadow.addEventListener('dblclick', (event) => {
        const title = event.target instanceof Element
          ? event.target.closest('.title-bar')
          : null
        if (!title)
          return
        const buttons = [
          ...title.querySelectorAll('.action-button'),
        ]
        if (buttons.slice(0, 2).every(button => !button.getClientRects().length)) {
          event.preventDefault()
          event.stopImmediatePropagation()
        }
      }, true)
      const style = document.createElement('style')
      style.textContent = `
        .qt-screen { --border-width: 1px; }
        .qt-decorated-window { background-color: var(--app-surface); color: var(--app-text); }
        .qt-decorated-window.has-border { border-color: var(--app-border); }
        .qt-decorated-window .title-bar .window-name { color: var(--app-text); }
        .qt-decorated-window .title-bar .action-button img { filter: var(--app-title-icon-filter); }
        .qt-decorated-window .title-bar .action-button:hover img { opacity: .7; }
        .qt-decorated-window .title-bar .action-button:active img { opacity: .5; }
        .qt-decorated-window.has-title:not(.maximized):not(.frameless) { border-radius: var(--app-window-radius); }
        .qt-decorated-window.has-title:not(.maximized):not(.frameless) > .title-bar { border-radius: var(--app-window-radius) var(--app-window-radius) 0 0; }
        .qt-decorated-window.has-title:not(.maximized):not(.frameless) > .qt-window { border-radius: 0 0 var(--app-window-radius) var(--app-window-radius); }
      `
      shadow.append(style)
      if (globalThis.kritaPalette)
        paletteChanged()
      // The initial palette may predate the user's choice during loading.
      if (nativeReady && (globalThis.kritaPalette!.dark ? 'dark' : 'light') !== scheme())
        send()
    },
  }
}

export function installWidgetStyleSettings(select: HTMLSelectElement, request: NativeSetter, storage: Storage | undefined) {
  const update = () => {
    const state = globalThis.kritaWidgetStyleState
    if (!state?.available?.length)
      return
    select.replaceChildren(...state.available.map(name => new Option(name, name.toLowerCase())))
    select.value = state.current
    select.disabled = false
    try {
      storage?.setItem(widgetStyleKey, state.current)
    }
    catch { /* Keep the live style when storage is unavailable. */ }
  }
  window.addEventListener('krita-widget-style-change', update)
  select.addEventListener('change', () => {
    select.disabled = true
    if (!request(select.selectedIndex))
      update()
  })
  update()
}

export function installSettings(button: HTMLButtonElement, dialog: HTMLDialogElement, close: HTMLButtonElement, storage: Storage | undefined) {
  const positionKey = 'krita.settings-position'
  let position: { x: number, y: number } | undefined
  let drag: { pointer: number, x: number, y: number, left: number, top: number } | null
  let moved = false
  let previousFocus: Element | null
  const place = (x: number, y: number) => {
    const { width, height } = button.getBoundingClientRect()
    const left = Math.max(8, Math.min(x, document.documentElement.clientWidth - width - 8))
    const top = Math.max(8, Math.min(y, document.documentElement.clientHeight - height - 8))
    button.style.left = `${left}px`
    button.style.top = `${top}px`
    button.style.right = 'auto'
  }
  try {
    const saved = JSON.parse(storage?.getItem(positionKey) || 'null')
    if (Number.isFinite(saved?.x) && Number.isFinite(saved?.y)) {
      position = { x: saved.x, y: saved.y }
      place(position.x, position.y)
    }
  }
  catch { /* Settings remain usable when browser storage is unavailable. */ }
  button.addEventListener('pointerdown', (event) => {
    if (!event.isPrimary || event.button !== 0)
      return
    event.preventDefault()
    event.stopPropagation()
    const rect = button.getBoundingClientRect()
    drag = {
      pointer: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      left: rect.left,
      top: rect.top,
    }
    moved = false
    button.setPointerCapture(event.pointerId)
  })
  button.addEventListener('pointermove', (event) => {
    if (!drag || drag.pointer !== event.pointerId)
      return
    event.stopPropagation()
    const dx = event.clientX - drag.x
    const dy = event.clientY - drag.y
    if (!moved && Math.hypot(dx, dy) < 5)
      return
    moved = true
    button.classList.add('dragging')
    place(drag.left + dx, drag.top + dy)
    const rect = button.getBoundingClientRect()
    position = { x: rect.left, y: rect.top }
  })
  button.addEventListener('pointerup', (event) => {
    if (!drag || drag.pointer !== event.pointerId)
      return
    event.stopPropagation()
    if (moved) {
      const rect = button.getBoundingClientRect()
      try {
        storage?.setItem(positionKey, JSON.stringify({ x: rect.left, y: rect.top }))
      }
      catch { /* Keep the current position. */ }
    }
    drag = null
    button.classList.remove('dragging')
  })
  button.addEventListener('pointercancel', () => {
    drag = null
    button.classList.remove('dragging')
  })
  button.addEventListener('click', (event) => {
    event.stopPropagation()
    // Pointer capture still produces a click after a drag. Keyboard activation
    // has detail=0 and must remain available after a cancelled pointer gesture.
    if (moved && event.detail !== 0) {
      event.preventDefault()
      return
    }
    if (!dialog.open) {
      previousFocus = document.activeElement
      while (previousFocus?.shadowRoot?.activeElement) previousFocus = previousFocus.shadowRoot.activeElement
      dialog.showModal()
    }
    button.setAttribute('aria-expanded', 'true')
  })
  close.addEventListener('click', () => dialog.close())
  dialog.addEventListener('close', () => {
    button.setAttribute('aria-expanded', 'false')
    if (previousFocus instanceof HTMLElement)
      previousFocus.focus({ preventScroll: true })
  })
  dialog.addEventListener('keydown', (event) => {
    event.stopPropagation()
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's')
      event.preventDefault()
  })
  dialog.addEventListener('keyup', event => event.stopPropagation())
  window.addEventListener('resize', () => {
    if (position)
      place(position.x, position.y)
  })
}
