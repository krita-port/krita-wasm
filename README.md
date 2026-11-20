# Krita for WebAssembly

Run Krita in a browser with a static Qt 6 build, multithreaded painting, editable KRA files and local document storage. Krita is included as the top-level `krita/` submodule; this project maintains the browser integration and patches. Prebuilt dependencies come from [krita-prebuilder](https://github.com/krita-port/krita-prebuilder).

This is an experimental desktop-browser port. It uses the software canvas and requires WebAssembly threads, JSPI and cross-origin isolation. Python plugins, G’MIC, video, printing and desktop integration are unavailable.

## Build and run

Follow [the build guide](docs/BUILD.md) to fetch the prebuilt dependencies and create a local package. Then start the development server:

```sh
pnpm dev
```

Open <http://127.0.0.1:5173/>. The first visit installs a Service Worker and reloads to enable isolation. Vite serves the frontend sources with live updates and loads the existing compressed runtime automatically.

`pnpm preview` serves the lightweight production loader at <http://127.0.0.1:4173/>. Download the linked runtime bundle, then select or drop it into the page. Subsequent visits reuse the runtime in CacheStorage. Both servers listen on `0.0.0.0`; access from another device requires HTTPS with a trusted certificate because a LAN HTTP address is not a secure context.

## Documents and settings

Open and Save offer the browser cache and device file transfer. The Open dialog offers a browser-cache button and a separate device upload area where you can select or drop a local image; the runtime bundle loader supports the same two upload methods. Manually saved browser files and autosave snapshots are stored in IndexedDB through IDBFS. Discarding a recovery snapshot preserves manually saved files. Browser storage belongs to the exact origin, including the port; clearing site data removes it. Export important work to your device.

The draggable settings button controls language, widget style, appearance and corner radii. The added dialogs and download loader cover all bundled Krita languages. Appearance follows the browser by default. Krita draws its own interface through Qt and uses packaged fonts.

## Static hosting

Deploy only the generated `pages/` directory to GitHub Pages or another HTTPS static host. Put `krita.bundle.tar.gz` on a GitHub Release. On GitHub Pages, the default link is inferred from the site’s owner and project path. Pass `--release-url https://github.com/OWNER/REPOSITORY/releases` when packaging to choose the link shown by the loader. The page never downloads the large runtime until the user supplies a file; no preconfigured runtime checksum is needed.

## Browser support

The browser must expose Service Workers, CacheStorage, IndexedDB, Web Locks, `SharedArrayBuffer`, Wasm threads and the JSPI APIs `WebAssembly.Suspending` and `WebAssembly.promising`. Cross-origin isolation is required. Playwright exercises Chromium, Firefox and WebKit; its bundled engines can differ from installed system browsers.

### Firefox microtask reordering notice

Firefox can report `The execution of microtasks on this page was reordered to avoid unsafe execution` during startup. This means a browser API deferred a Promise resolution that could execute page JavaScript to a new microtask. Mozilla describes this as a protective scheduling change that normally requires no website action. The warning alone does not establish a startup failure or a JSPI/Qt defect; an accompanying visible malfunction needs separate investigation. See [Mozilla’s explanation](https://github.com/mozilla-firefox/firefox/blob/main/dom/docs/promise/safe-promise-resolve.md).

### Epiphany / WebKitGTK

Epiphany 49.2 with WebKitGTK 2.52.6 cannot run this build. Tests with both Service Worker isolation and server-supplied headers reached `crossOriginIsolated = true`, but `SharedArrayBuffer` and both JSPI APIs remained unavailable.

| Configuration | SharedArrayBuffer | JSPI |
| --- | --- | --- |
| Epiphany / WebKitGTK 2.52.6, default settings | Unavailable | Unavailable |
| Same version with `JSC_useSharedArrayBuffer=true` | Available; shared Worker memory verified | Unavailable |
| Playwright WebKit 27.2, headed GTK and headless WPE | Available after isolation | Available |

The older GTK port does not automatically expose the shared-memory constructor after isolation. The `JSC_useSharedArrayBuffer=true` environment variable enables it, but does not add JSPI; this version rejects `JSC_useJSPI=true` as an invalid option. Forcing shared memory also exposes it on non-isolated pages, so do not set that variable globally for ordinary browsing.

Playwright ships its own newer WebKit build. Its successful tests do not imply that the system Epiphany build has the same capabilities. Upstream added automatic shared-memory enablement for isolated GTK/WPE processes in [this WebKit change](https://github.com/WebKit/WebKit/commit/104506cdb2c4). The [WebKitGTK 2.54.2 feature definitions](https://github.com/WebKit/WebKit/blob/webkitgtk-2.54.2/Source/WTF/Scripts/Preferences/UnifiedWebPreferences.yaml) include JSPI enabled by default, but a complete Krita run on that release has not been verified. A flag alone cannot make the tested 2.52.6 installation compatible.

## License

This application is licensed under GNU GPL version 3 only (`GPL-3.0-only`); see [LICENSE](LICENSE). Upstream files and third-party components retain their own notices. Application source and build recipes are available in this repository and its pinned Krita submodule. Dependency source versions and recipes are maintained in [krita-prebuilder](https://github.com/krita-port/krita-prebuilder); `build.json` records the dependencies used for each build. Runtime bundles carry dependency and font license notices.
