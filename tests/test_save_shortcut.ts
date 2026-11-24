import assert from 'node:assert/strict'
import test from 'node:test'
import { installSaveShortcutGuard } from '../web/save-shortcut.ts'

const surface = new EventTarget()
function key(options: Partial<KeyboardEvent> = {}, inside = true, type = 'keydown') {
  const event = new Event(type, { cancelable: true })
  Object.assign(event, {
    key: 's',
    ctrlKey: true,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    isComposing: false,
    keyCode: 83,
    ...options,
  })
  event.composedPath = () => inside
    ? [
        new EventTarget(),
        new EventTarget(),
        surface,
        new EventTarget(),
      ]
    : [
        new EventTarget(),
      ]
  return event
}

test('cancel browser Save/Save As while the original event reaches Qt exactly once', () => {
  for (const modifiers of [
    {},
    { shiftKey: true, key: 'S' },
    { ctrlKey: false, metaKey: true },
    { repeat: true },
  ]) {
    const target = new EventTarget()
    installSaveShortcutGuard(surface, target)
    const event = key(modifiers)
    let received = 0
    target.addEventListener('keydown', (delivered) => {
      assert.equal(delivered, event)
      assert.equal(delivered.defaultPrevented, true)
      received++
    })
    assert.equal(target.dispatchEvent(event), false)
    assert.equal(received, 1)
  }
})

test('preserve typing, IME, AltGr, unrelated shortcuts and keys outside Krita', () => {
  const target = new EventTarget()
  installSaveShortcutGuard(surface, target)
  for (const event of [
    key({ ctrlKey: false }),
    key({ isComposing: true }),
    key({ keyCode: 229 }),
    key({ altKey: true }),
    key({ key: 'c' }),
    key({ key: 'v' }),
    key({ key: 'r' }),
    key({}, false),
    key({}, true, 'keyup'),
  ]) {
    assert.equal(target.dispatchEvent(event), true)
    assert.equal(event.defaultPrevented, false)
  }
})

test('the guard can be removed without retaining shortcut ownership', () => {
  const target = new EventTarget()
  const remove = installSaveShortcutGuard(surface, target)
  remove()
  assert.equal(target.dispatchEvent(key()), true)
})
