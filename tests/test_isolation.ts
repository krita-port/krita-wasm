import assert from 'node:assert/strict'
import { ensureIsolation } from '../web/isolation.ts'

// WebKitGTK can establish COOP/COEP isolation without exposing shared memory.
// Detect this separately, before registering a Worker or attempting a reload.
const original: Record<string, PropertyDescriptor> = Object.getOwnPropertyDescriptors(globalThis)
try {
  Object.defineProperty(globalThis, 'crossOriginIsolated', { value: true, configurable: true })
  Object.defineProperty(globalThis, 'SharedArrayBuffer', { value: undefined, configurable: true })
  await assert.rejects(ensureIsolation(), /isolation is active.*does not provide SharedArrayBuffer/)
}
finally {
  for (const name of ['crossOriginIsolated', 'SharedArrayBuffer']) {
    if (original[name])
      Object.defineProperty(globalThis, name, original[name])
    else Reflect.deleteProperty(globalThis, name)
  }
}
