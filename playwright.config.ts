import process from 'node:process'
import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/browser',
  testMatch: ['krita.spec.ts', 'autosave.spec.ts', 'persistence-profile.spec.ts'],
  outputDir: 'build/logs/playwright',
  timeout: 240_000,
  expect: { timeout: 30_000 },
  workers: 3,
  retries: process.env.CI ? 3 : 0,
  reporter: [
    ['list'],
    [
      'html',
      { outputFolder: 'build/logs/playwright-report', open: 'never' },
    ],
  ],
  use: {
    actionTimeout: 30_000,
    navigationTimeout: 60_000,
    viewport: { width: 1280, height: 900 },
    acceptDownloads: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: (['chromium', 'firefox', 'webkit'] as const).map(name => ({
    name,
    use: { browserName: name },
  })),
})
