const worker = globalThis as unknown as ServiceWorkerGlobalScope

// No offline cache: navigation and asset versioning can be added independently.
worker.addEventListener('install', event => event.waitUntil(worker.skipWaiting()))
worker.addEventListener('activate', event => event.waitUntil(worker.clients.claim()))
worker.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.cache === 'only-if-cached' && request.mode !== 'same-origin')
    return
  if (new URL(request.url).origin !== worker.location.origin)
    return
  event.respondWith((async () => {
    const scope = new URL(worker.registration.scope)
    const runtime = new URL(request.url).pathname.slice(scope.pathname.length).match(/^\.runtime\/[a-f0-9]{32}\//)
    const response = runtime
      ? await (await caches.open(`krita-runtime-v2:${scope.href}`)).match(request) || new Response('Runtime file is not cached.', { status: 404 })
      : await fetch(request)
    if (response.status === 0)
      return response
    const headers = new Headers(response.headers)
    headers.set('Cross-Origin-Opener-Policy', 'same-origin')
    headers.set('Cross-Origin-Embedder-Policy', 'require-corp')
    headers.set('Cross-Origin-Resource-Policy', 'same-origin')
    // Some browsers expose a stream even for a response with no body. Passing
    // that stream to the Response constructor is invalid for these statuses.
    const body = request.method === 'HEAD' || [204, 205, 304].includes(response.status)
      ? null
      : response.body
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    })
  })())
})
