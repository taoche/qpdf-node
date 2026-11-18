# WebAssembly build

Needs the [Emscripten SDK](https://emscripten.org/docs/getting_started/downloads.html) (tested with
emcc 7.0.0). No `wasm-pack`, no Rust.

```sh
source /path/to/emsdk/emsdk_env.sh
pnpm build:wasm     # emcmake cmake -S . -B build/wasm ... && cmake --build build/wasm --target qpdf_wasm
pnpm test:wasm      # runs native/wasm/smoke-test.mjs against build/wasm/qpdf-core.mjs under Node.js
```

Output: `build/wasm/qpdf-core.mjs` (ES module, `createQpdfCore()`) and `build/wasm/qpdf-core.wasm`
(about 1.3 MB). It uses native WebAssembly exceptions (`-fwasm-exceptions`) and a 2 MB stack.

```js
import createQpdfCore from "./qpdf-core.mjs";
const core = await createQpdfCore();
const pdf = core.openPdf(uint8Array); // sync; throws Error with .code on failure
pdf.pageCount;
const bytes = pdf.extract([3, 1, 2]); // Uint8Array, a copy out of WebAssembly memory
pdf.close();
```

The WebAssembly API is **synchronous and in memory**: `openPdf(Uint8Array)`, `pageCount`,
`extract(pages)`, `close()`, `mergeBytes(inputs)`, `qpdfVersion()`. It has no file-system operations (`merge`,
`splitPages`, path `pageCount` are Node-only) and no password option yet. Because a large document
blocks while it is parsed or written, **run it in a Web Worker**. `native/wasm/qpdf-worker.mjs` is a
ready-made worker with a small `postMessage` protocol that transfers PDF bytes instead of copying
them; put `qpdf-core.mjs` and `qpdf-core.wasm` next to it and start it with
`new Worker(new URL("./qpdf-worker.mjs", import.meta.url), { type: "module" })` (protocol in the
file's header comment).

## Verification status

The WebAssembly module was built and its smoke test passed under Node.js.
It has not been run in a browser or a Web Worker, and `qpdf-worker.mjs` has not been run at all.
It is **not published to npm**: the release workflow builds it (`wasm-build` job), runs the Node.js
smoke test and uploads `qpdf-core.mjs`, `qpdf-core.wasm` and `qpdf-worker.mjs` as the
`qpdf-wasm-build` workflow artifact. Nothing in `qpdf-node` depends on it, and the publish job does
not wait for it. A separate package (for example `qpdf-node-wasm`) should only be added after it is
verified in a browser.
