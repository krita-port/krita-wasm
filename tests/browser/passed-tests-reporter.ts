import type { FullConfig, Reporter, Suite } from '@playwright/test/reporter'
import { appendFileSync } from 'node:fs'
import { relative, sep } from 'node:path'
import process from 'node:process'

export default class PassedTestsReporter implements Reporter {
  private rootDir = ''
  private suite?: Suite
  private hadRunnerError = false

  onBegin(config: FullConfig, suite: Suite) {
    this.rootDir = config.rootDir
    this.suite = suite
  }

  onError() {
    this.hadRunnerError = true
  }

  onEnd() {
    const output = process.env.KRITA_BROWSER_RESULTS
    if (!output || !this.suite || this.hadRunnerError) {
      return
    }

    const entries = this.suite.allTests().map((test) => {
      const [, project, , ...titles] = test.titlePath()
      const file = relative(this.rootDir, test.location.file).split(sep).join('/')
      return {
        test,
        parts: [`[${project}]`, file, ...titles],
      }
    })
    // Playwright also accepts suite prefixes. Only record unambiguous test paths.
    const suitePaths = new Set(entries.flatMap(({ parts }) =>
      parts.slice(2, -1).map((_, index) => parts.slice(0, index + 3).join(' › ')),
    ))
    const passed = entries
      .filter(({ test, parts }) => test.expectedStatus === 'passed'
        && test.results.at(-1)?.status === 'passed'
        && parts.every(part => part !== '' && part === part.trim() && !/[\r\n›]/.test(part))
        && !suitePaths.has(parts.join(' › ')))
      .map(({ parts }) => parts.join(' › '))
    if (passed.length > 0) {
      appendFileSync(output, `${passed.join('\n')}\n`)
    }
  }
}
