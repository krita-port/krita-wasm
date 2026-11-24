# Project instructions

- Keep `krita` at its pinned, clean upstream commit. Apply `patches/series` only to derived sources under `build/`.
- Classify required port changes under `port/` and general upstream fixes under `upstream-fixes/`; keep one explicit application order with consecutive numbering across both categories.
- Consume verified dependency releases from krita-prebuilder. Do not compile external dependencies in this repository or change a shared Emscripten installation.
- Keep the static Qt, pthreads, JSPI and native Wasm exception ABI consistent across dependencies and the application.
- Preserve manually saved documents independently of disposable recovery snapshots. Public previews listen on `0.0.0.0`.
- See [the build guide](docs/BUILD.md) for build and validation commands.
