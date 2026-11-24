// Browser defaults must be cancelled during DOM dispatch. Qt may process the
// key later, or suspend inside a synchronous save dialog before cancelling it.
export function installSaveShortcutGuard(surface: EventTarget, target: EventTarget = (surface as HTMLElement).ownerDocument.defaultView!) {
  const onKeyDown = (delivered: Event) => {
    const event = delivered as KeyboardEvent
    if (!(event.ctrlKey || event.metaKey) || event.altKey || event.isComposing || event.keyCode === 229)
      return
    if (event.key?.toLowerCase() !== 's' || !event.composedPath().includes(surface))
      return
    // Keep the original event flowing to Qt's shortcut map. Triggering a Save
    // action here as well would invoke it twice and bypass modal/disabled state.
    event.preventDefault()
  }
  target.addEventListener('keydown', onKeyDown, { capture: true, passive: false })
  return () => target.removeEventListener('keydown', onKeyDown, { capture: true })
}
