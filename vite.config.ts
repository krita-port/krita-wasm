import { resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

const projectRoot = fileURLToPath(new URL('.', import.meta.url))
const runtimeDirectory = resolve(projectRoot, process.env.KRITA_WEB_DIR || 'dist/krita')

export default defineConfig(({ isPreview, mode }) => ({
  root: resolve(projectRoot, 'web'),
  base: './',
  publicDir: false,
  appType: 'mpa',
  build: {
    outDir: isPreview
      ? runtimeDirectory
      : resolve(projectRoot, 'build/web'),
    emptyOutDir: true,
    target: 'es2022',
    modulePreload: { polyfill: false },
    rolldownOptions: {
      input: {
        'index': resolve(projectRoot, 'web/index.html'),
        'isolation-sw': resolve(projectRoot, 'web/isolation-sw.ts'),
      },
      output: {
        entryFileNames: chunk => chunk.name === 'isolation-sw'
          ? 'isolation-sw.js'
          : 'assets/[name]-[hash].js',
      },
    },
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    headers: { 'Cache-Control': 'no-store' },
    fs: {
      allow: [projectRoot, runtimeDirectory],
    },
  },
  preview: {
    host: '0.0.0.0',
    port: mode === 'manual'
      ? 4173
      : 5173,
    strictPort: true,
    headers: { 'Cache-Control': 'no-store' },
  },
  plugins: [
    {
      name: 'packaged-krita',
      configureServer({ middlewares }) {
        middlewares.use((request, response, next) => {
          if (request.url === '/isolation-sw.js')
            request.url = '/isolation-sw.ts?worker_file&type=classic'
          if (request.url === '/krita.bundle.tar.gz') {
            response.setHeader('Content-Type', 'application/gzip')
            response.setHeader('Content-Encoding', 'identity')
          }
          if (['/bundle.json', '/i18n.json', '/krita.bundle.tar.gz'].includes(request.url || ''))
            request.url = `/@fs${resolve(runtimeDirectory, request.url!.slice(1))}`
          next()
        })
      },
      configurePreviewServer({ middlewares }) {
        middlewares.use((request, response, next) => {
          if (mode === 'manual' && request.url === '/bundle.json')
            request.url = '/pages/bundle.json'
          if (request.url === '/krita.bundle.tar.gz') {
            // Keep the archive opaque rather than advertising HTTP gzip encoding.
            response.setHeader('Content-Type', 'application/gzip')
            response.setHeader('Content-Encoding', 'identity')
          }
          next()
        })
      },
    },
  ],
}))
