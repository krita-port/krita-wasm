import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const cli = fileURLToPath(import.meta.resolve('@playwright/test/cli'))
const reporter = fileURLToPath(new URL('./browser/passed-tests-reporter.ts', import.meta.url))

test('Playwright resumes only tests that passed in an earlier attempt', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'krita-browser-resume-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const resultFile = join(root, 'passed.txt')
  await writeFile(resultFile, '# build sample\n')
  await writeFile(join(root, 'playwright.config.ts'), `
    export default { projects: [{ name: 'firefox' }], workers: 1, retries: 1 }
  `)
  await writeFile(join(root, 'workflows.spec.ts'), `
    import { expect, test } from ${JSON.stringify(fileURLToPath(import.meta.resolve('@playwright/test')))}
    test.describe('completed', () => {
      test('workflow', ({}, info) => expect(info.retry).toBe(1))
    })
    test.describe('pending', () => {
      test('workflow', () => expect(process.env.ATTEMPT).toBe('2'))
    })
    test.skip('skipped', () => {})
    test('expected failure', () => {
      test.fail()
      throw new Error('expected')
    })
  `)

  function run(attempt: string, ...args: string[]) {
    const result = spawnSync(process.execPath, [
      cli,
      'test',
      '--reporter',
      'list',
      '--add-reporter',
      reporter,
      ...args,
    ], {
      cwd: root,
      env: { ...process.env, ATTEMPT: attempt, KRITA_BROWSER_RESULTS: resultFile },
      encoding: 'utf-8',
      timeout: 30_000,
    })
    assert.ifError(result.error)
    return { status: result.status, output: result.stdout + result.stderr }
  }

  const first = run('1')
  assert.equal(first.status, 1, first.output)
  const header = '# build sample\n'
  const completed = '[firefox] › workflows.spec.ts › completed › workflow\n'
  assert.equal(await readFile(resultFile, 'utf-8'), header + completed)

  const resume = ['--test-list-invert', resultFile]
  const second = run('2', ...resume)
  assert.equal(second.status, 0, second.output)
  assert.doesNotMatch(second.output, /completed › workflow/)
  const pending = '[firefox] › workflows.spec.ts › pending › workflow\n'
  assert.equal(await readFile(resultFile, 'utf-8'), header + completed + pending)

  const nothingLeft = run('3', ...resume, '--grep', 'workflow$')
  assert.equal(nothingLeft.status, 0, nothingLeft.output)
  assert.equal(await readFile(resultFile, 'utf-8'), header + completed + pending)
})
