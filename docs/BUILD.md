# Building and validating Krita Wasm

## Toolchain and dependencies

The application build supports Linux x86-64. Use CMake 3.19 or later, Ninja, pkg-config, Python 3.12 or later and Node.js 26 and the pnpm version pinned in `package.json`. The Linux offline-build check uses the system libseccomp runtime through the pinned `pyseccomp` Python package. Emscripten is pinned by `.emscripten-version`; `scripts/with-emsdk` discovers the existing installation from `EMSDK` or `emcc` on `PATH`, checks the version and never installs or activates it.

```sh
python3 -m venv build/python-checks
. build/python-checks/bin/activate
python -m pip install -r requirements.txt
pnpm install --frozen-lockfile
python3 scripts/sdk.py fetch
python3 scripts/fetch-fonts.py
```

The SDK fetch step resolves the current `latest` Nightly release from krita-port/krita-prebuilder and downloads the SDK and internationalization binary archives. GitHub’s asset digests verify the downloads, and digest-keyed caches preserve earlier versions. There are no manually maintained SDK pins. The successful selection is recorded automatically in `build/sdk-release.json`; subsequent builds use that selection offline until the next fetch. `python3 scripts/sdk.py verify` validates the selected archives and extracted inventories without accessing the network. Downloaded archives and extracted dependencies live in `cache/`. Build products and generated sources live in `build/`; deployable packages live in `dist/`. Use disk-backed storage for complete builds.

No Qt, KDE Frameworks, external library or Emscripten port is compiled by the application build. The SDK supplies host tools and a frozen Emscripten cache. Runtime fonts are fixed upstream packages with member checksums. Their cache keys include the complete lock metadata. SDK recipe changes belong in krita-prebuilder.

## Source preparation and compilation

```sh
git submodule update --init --recursive
python3 scripts/project.py prepare-source
python3 scripts/offline-exec.py scripts/package-krita.py --output dist/krita
```

The Krita revision is read directly from the clean `krita/` submodule’s `HEAD` and checked against its Git index entry when present. CI initializes the commit pinned by that submodule entry. The preparer archives that commit, validates and applies every patch in `patches/series`, and records the patch digest. It refuses to overwrite an existing prepared tree. After changing patches, run preparation again to create the new tree; the command prints its path. During configuration, the managed build-source symlink switches to that tree. Byte-identical files retain their timestamps when the previous tree still matches its recorded inventory.

`BUILD_JOBS=6` is the local default; lower it on small machines. `scripts/build-krita all` configures and builds without packaging. Compilation units and linked archives are audited against Krita, local integration, generated build files and verified prebuilt roots. `offline-exec.py` uses Linux seccomp to deny new IPv4 and IPv6 sockets only in the build process and its children. Build subprocess output is streamed to the caller.

The target is wasm32 with pthreads, growing memory up to 4 GiB, static Qt 6, JSPI and native Wasm exceptions. Binaryen rewrites exception handling to standard `try_table`; post-upload validation rejects legacy exception instructions. The application assumes a 4 GiB RAM budget rather than probing unsupported browser physical-memory APIs. Browser/engine limits may still be lower.

## Packaging and hosting

```sh
pnpm dev
pnpm preview
```

To set the production download link, add `--release-url https://github.com/OWNER/REPOSITORY/releases` to the packaging command above. Use a fresh output directory outside `web/`, `src/`, `krita/`, `build/sources/`, and `build/web/` for each package. Packaging rebuilds first, installs into a temporary disk directory, compiles launcher messages, includes Krita and SDK resources, and creates a deterministic gzip/tar runtime bundle. `dist/krita` supports automatic local loading; `dist/krita/pages` contains only the lightweight manual loader, also distributed as deterministic `krita.pages.tar.gz`. Packaging runs `pnpm build:web` to build `web/index.html`, TypeScript and the separate stylesheet with Vite. It includes the hashed JS/CSS assets and a root-scoped Service Worker in both launchers. `pnpm dev` runs Vite’s development server on port 5173 with frontend updates and automatic loading from the existing runtime package. `pnpm preview` serves the built manual loader on port 4173. Both bind to `0.0.0.0` and fail if the selected port is occupied. Preview uses a manual-loading descriptor with a download link to its local archive, independently of the production Release URL; the archive remains absent from the Pages deployment. Set `KRITA_WEB_DIR=dist/another-build` to use another runtime package with either command, and use `--port` to change its port. Relative asset URLs support deployment under a GitHub Pages project path.

Project-added messages for every bundled Krita locale, including region and script variants, are maintained in separate `web/messages/<locale>.json` files. Packaging merges them and rejects missing languages, incomplete keys, empty values and mismatched placeholders, then generates both native `krita-wasm.mo` catalogs and the webpage index. Existing translated Krita labels take precedence over project fallbacks. A small `i18n.json` is also included in the Pages loader so its instructions are translated before a runtime is imported. New translations have not yet received native-speaker review.

The loader decompresses gzip using the browser’s `DecompressionStream` and parses the tar entries with path, format and required-file checks. Runtime CacheStorage is separate from document IDBFS. A fixed application namespace is used per origin; internal session IDs are not displayed as user directories. The native file dialog exposes `/Documents`. Saved documents and disposable recovery snapshots have independent lifetimes.

Serve over HTTPS or loopback HTTP. The Service Worker supplies COOP/COEP for static hosting and must control the page before startup. Supplying headers on an insecure LAN HTTP server does not enable a secure context. For phones and tablets, use HTTPS and install/trust the development certificate on the device. There is no application backend.

To build from source, clone this repository, initialize its pinned Krita submodule and follow the commands above. Dependency recipes, patches and pinned upstream download URLs are maintained in the krita-prebuilder repository. The application does not produce a separate source archive.

## Checks

With the Python environment above active:

```sh
ruff format --check scripts tests
ruff check scripts tests
mypy
scripts/format.sh --check
pnpm lint
pnpm typecheck
pnpm test
python3 -m unittest discover -s tests -v
npx playwright install chromium firefox webkit
pnpm test:browser
```

On Linux, browser installation also requires system runtime libraries. Run `npx playwright install-deps --dry-run chromium firefox webkit` to inspect the required packages, then install missing ones with your distribution package manager (`sudo apt install ...` on Ubuntu). The browser download command above does not install system libraries.

The browser suite uses up to three workers. CI retries a failed case up to three times, for at most four attempts; a case that passes on retry is reported as flaky without failing CI. Local runs do not retry. The per-test budget is 240 seconds, including setup. Navigation has a 60-second limit, application startup and bridge readiness have 90 seconds, and ordinary assertions and actions have 30 seconds. Native import and save completion waits retain 180 seconds. Individual waits share the remaining test budget.

UI-only scenarios share a live Krita workbench within each browser worker and locale. Each successful case closes its documents through Krita, hides the text-properties docker, restores the floating settings button, cleans up its temporary files and checks that preferences remain unchanged. Startup, reload, persistence, recovery, multiple-tab and Quit scenarios keep isolated contexts and origins; entering one also closes any cached workbench. Playwright still collects per-test traces and failure screenshots, and a failed test restarts its worker before the remaining cases run.

To run the shared UI group without the lifecycle suite:

```sh
pnpm test:browser --grep 'UI workbench'
```

Each shared case writes `workbench-startup.json` with its session ID, actual startup/reuse time, document time origin and runtime download count, plus `workbench-reset.json` after cleanup. Reused cases assert that they keep the same document and do not download the runtime again. These timings cover startup preparation; they do not estimate the total runtime of the complete suite.

The format script uses clang-format 22; omit `--check` to apply formatting. ESLint uses `@antfu/eslint-config`; asynchronous entry modules and ambient declarations have narrowly scoped rules. Python functions are typed and checked with strict mypy. TypeScript 6 checks the page, Service Worker and tests with full strict declaration checking. The ESLint configuration is checked separately with `skipLibCheck` because Antfu 10.0.0’s generated declarations have upstream errors under TypeScript 6. Playwright uses one test implementation across Chromium, Firefox and WebKit, with isolated loopback servers. It covers first Service Worker control, reload, manual bundle loading, multilingual UI, settings, drawing, large-canvas undo/redo, KRA and PNG downloads, browser-cache files, autosave, recovery and multi-tab storage. Autosave tests shorten the actual application interval instead of waiting seven minutes. Browser traces and failure screenshots are written under `build/logs/`. CI asks the pinned Playwright version which system packages are missing, then uses `apt` to install only that list.

CI runs the cheapest formatting checks first, then lint/unit tests, builds and uploads packages, and then verifies catalogs, distributed Wasm instructions and unchanged SDK inventories. Separate Chromium, Firefox and WebKit jobs test the same build artifact in parallel and upload their own reports. After each attempt, each job uploads its cumulative list of passing tests as `test-result-<browser>-<attempt>`, even if other tests fail. A rerun resumes from the most recent available list for that browser in the same workflow run when the build manifest matches. A new workflow run starts with the full suite. A successful push or manual run on `main` with all three browser jobs passing updates the **Nightly build** prerelease at tag `latest` with `krita.bundle.tar.gz`, `krita.pages.tar.gz`, and `build.json`. The packaged Pages loader links to this prerelease. The resolved Nightly assets and inventories are recorded in `build.json`. Builds reuse the locally selected SDK until a later fetch selects another Nightly; the same application revision can therefore use different SDK releases. A successful build, passing browser tests and byte-identical independent compiler rebuilds are different claims; CI does not currently perform two independent full compiler rebuilds.
