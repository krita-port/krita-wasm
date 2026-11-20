import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { Script } from 'node:vm'
import { gzipSync } from 'node:zlib'
import vitePackage from 'vite/package.json' with { type: 'json' }

const executable = fileURLToPath(new URL(vitePackage.bin.vite, import.meta.resolve('vite/package.json')))
const flags = ['--host', '127.0.0.1']
const environment = { ...process.env }

async function startServer(t: TestContext, root: string, mode: string) {
  const child = spawn(process.execPath, [
    executable,
    ...(mode === 'dev'
      ? []
      : ['preview', '--outDir', root]),
    '--config',
    resolve('vite.config.ts'),
    '--mode',
    mode,
    '--port',
    '0',
    ...flags,
  ], {
    env: { ...environment, KRITA_WEB_DIR: root },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const closed = once(child, 'close')
  t.after(async () => {
    child.kill('SIGTERM')
    await closed
  })
  return new Promise<URL>((resolve, reject) => {
    let output = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`Vite did not start: ${output}`))
    }, 20_000)
    const collect = (chunk: Buffer) => {
      output += chunk.toString()
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+/)
      if (match) {
        clearTimeout(timer)
        resolve(new URL(match[0]))
      }
    }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      reject(new Error(`Vite exited (${code}): ${output}`))
    })
  })
}

for (const mode of ['dev', 'auto', 'manual']) {
  test(`actual Vite CLI preserves ${mode} hosting and fixed ports`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'krita-preview-'))
    t.after(() => rm(root, { recursive: true, force: true }))
    await mkdir(join(root, 'pages'))
    await mkdir(join(root, 'unlisted'))
    await writeFile(join(root, 'index.html'), '<title>Krita</title>')
    await writeFile(join(root, 'bundle.json'), JSON.stringify({ mode: 'auto' }))
    await writeFile(join(root, 'i18n.json'), JSON.stringify({
      languages: ['en'],
    }))
    await writeFile(join(root, 'pages/bundle.json'), JSON.stringify({ mode: 'manual' }))
    const archive = gzipSync(Buffer.from('local release archive'))
    await writeFile(join(root, 'krita.bundle.tar.gz'), archive)
    const base = await startServer(t, root, mode)
    const request = (path: string, headers = {}) => fetch(new URL(path, base), {
      headers: { Connection: 'close', ...headers },
    })
    const index = await request('/')
    assert.equal(index.status, 200)
    assert.match(index.headers.get('content-type')!, /text\/html/)
    assert.equal(index.headers.get('cache-control'), 'no-store')
    if (mode === 'dev') {
      const html = await index.text()
      assert.match(html, /\/@vite\/client/)
      const entry = [
        ...html.matchAll(/<script\b[^>]+\bsrc="([^"]+)"/g),
      ]
        .map(match => match[1])
        .find(path => !path.includes('/@vite/client'))
      assert.ok(entry)
      const module = await request(entry)
      assert.equal(module.status, 200)
      assert.match(module.headers.get('content-type')!, /javascript/)
      assert.ok((await module.text()).length)
      const stylesheet = html.match(/<link\b(?=[^>]+\brel="stylesheet")[^>]+\bhref="([^"]+)"/)?.[1]
      assert.ok(stylesheet)
      const css = await request(stylesheet, { Accept: 'text/css' })
      assert.match(css.headers.get('content-type')!, /text\/css/)
      assert.ok((await css.text()).length)
      const worker = await request('/isolation-sw.js')
      assert.equal(worker.status, 200)
      const script = await worker.text()
      assert.doesNotThrow(() => new Script(script))
      const messages = await request('/i18n.json')
      assert.equal(messages.status, 200)
      assert.deepEqual(await messages.json(), {
        languages: ['en'],
      })
    }
    else {
      assert.equal(await index.text(), '<title>Krita</title>')
    }
    const descriptor = await request('/bundle.json')
    assert.equal(descriptor.status, 200)
    assert.equal(descriptor.headers.get('cache-control'), 'no-store')
    assert.deepEqual(await descriptor.json(), {
      mode: mode === 'dev'
        ? 'auto'
        : mode,
    })
    const download = await request('/krita.bundle.tar.gz')
    assert.equal(download.status, 200)
    assert.equal(download.headers.get('cache-control'), 'no-store')
    assert.equal(download.headers.get('content-type'), 'application/gzip')
    assert.equal(download.headers.get('content-encoding'), 'identity')
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), archive)
    const range = await request('/krita.bundle.tar.gz', { Range: 'bytes=0-4' })
    assert.equal(range.status, 206)
    assert.deepEqual(Buffer.from(await range.arrayBuffer()), archive.subarray(0, 5))
    for (const path of ['/missing.js', '/unlisted/']) {
      const missing = await request(path)
      assert.equal(missing.status, 404)
      await missing.arrayBuffer()
    }
    const occupied = spawnSync(process.execPath, [
      executable,
      ...(mode === 'dev'
        ? []
        : ['preview', '--outDir', root]),
      '--config',
      resolve('vite.config.ts'),
      '--mode',
      mode,
      '--port',
      base.port,
      ...flags,
    ], {
      env: { ...environment, KRITA_WEB_DIR: root },
      timeout: 10_000,
    })
    assert.ifError(occupied.error)
    assert.equal(occupied.signal, null)
    assert.equal(occupied.status, 1, occupied.stdout.toString() + occupied.stderr.toString())
  })
}

test('actual Vite build emits loadable CSS and JS with a root-scoped classic worker', async (t) => {
  await mkdir(resolve('build'), { recursive: true })
  const root = await mkdtemp(join(resolve('build'), 'vite-build-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const built = spawnSync(process.execPath, [
    executable,
    'build',
    '--config',
    resolve('vite.config.ts'),
    '--outDir',
    root,
  ], { env: environment, timeout: 30_000 })
  assert.ifError(built.error)
  assert.equal(built.status, 0, built.stdout.toString() + built.stderr.toString())
  const html = await readFile(join(root, 'index.html'), 'utf8')
  const script = html.match(/<script\b[^>]+\bsrc="([^"]+)"/)?.[1]
  const stylesheet = html.match(/<link\b(?=[^>]+\brel="stylesheet")[^>]+\bhref="([^"]+)"/)?.[1]
  assert.ok(script)
  assert.ok(stylesheet)
  assert.ok((await readFile(join(root, script))).byteLength)
  assert.ok((await readFile(join(root, stylesheet))).byteLength)
  const worker = await readFile(join(root, 'isolation-sw.js'), 'utf8')
  assert.doesNotThrow(() => new Script(worker))
})
