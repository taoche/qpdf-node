# qpdf-node

Extract, merge and split PDF pages from Node.js and (experimentally) the browser, on top of
[qpdf](https://github.com/qpdf/qpdf) (C++, Apache-2.0). One shared C++ core serves two bindings:

- **Node.js**: a C++ [N-API](https://nodejs.org/api/n-api.html) addon written with `node-addon-api`,
  built with CMake through `cmake-js`. Work runs on the libuv thread pool.
- **WebAssembly**: an Emscripten/embind module over the same core, bytes in and bytes out, meant to
  run inside a Web Worker.

No `qpdf` executable is spawned, and the stale third-party `qpdf-wasm` npm package is not used.

> **Status: pre-release (0.2.0).** Nothing is published to npm and no prebuilt binaries exist: you
> build the addon from source. This package replaces the earlier `pdq-node` (Rust/pdq); see
> [Changes from pdq-node](#changes-from-pdq-node).

## API

```ts
import { merge, splitPages, pageCount, openPdf, qpdfVersion, QpdfError } from "qpdf-node";

// Bytes in, bytes out. The document is parsed once and kept in memory.
const pdf = await openPdf(bytes); // Buffer or Uint8Array
try {
  console.log(pdf.pageCount);
  const subset: Uint8Array = await pdf.extract([3, 1, 2]); // 1-based, in this order
} finally {
  await pdf.close();
}

// Path-based. A string input is shorthand for { path }.
await merge({
  inputs: ["cover.pdf", { path: "body.pdf", pages: "2-z" }],
  output: "out/book.pdf",
});
await splitPages({ input: "book.pdf", outputPattern: "out/page-%d.pdf" }); // page-01.pdf, ...
await splitPages({ input: "book.pdf", outputPattern: "out/chunk-%d.pdf", pagesPerFile: 50 });
const pages: number = await pageCount({ input: "book.pdf" });
qpdfVersion(); // "12.4.2"
```

Every function returns a promise and runs its PDF work off the event loop. Paths are strings;
relative paths are relative to the process working directory. Output directories must already exist.

### `openPdf(input): Promise<OpenedPdf>`

`input` is a non-empty `Uint8Array` (a `Buffer` is one). The bytes are copied into the addon and
parsed **once**; the parsed qpdf document stays in memory inside the handle and every `extract`
reuses it. Nothing is written to disk. Changing `input` after `openPdf` resolves has no effect.

| Member           | Description                                                                                                                                                                                                                                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pageCount`      | Number of pages, counted by walking the page tree (not by trusting `/Count`).                                                                                                                                                                                                                                |
| `extract(pages)` | A new unencrypted PDF (`Buffer`) holding `pages` in the given order. `pages` is a non-empty array of **distinct** integers from 1 to `pageCount`; anything else rejects with `INVALID_ARGUMENT` before any work starts. Output is deterministic: the same request on the same handle returns the same bytes. |
| `close()`        | Idempotent. Waits for extractions already in progress, which still complete; later `extract` calls reject with `INVALID_ARGUMENT`. Releases the parsed document. A handle that is garbage collected without `close()` is released too, but possibly late, so close it in a `finally`.                        |

`extract` calls may overlap, but they run one after another for a given handle: qpdf's objects are
not thread-safe, and copied streams are read lazily from the source while the output is written, so
the handle serializes them. Different handles run in parallel.

What `extract` copies: the selected pages with everything they reference (content, fonts, images,
annotations), resources and sizes a page inherits from the page tree pushed onto the page, and the
source's PDF version. Streams are copied exactly as stored (no decoding, no recompression). Links
that point at pages that were not selected are left dangling (null), they do not drag those pages
in. Interactive form fields, outlines and named destinations are not restructured; a digital
signature survives as data but is no longer valid on a subset.

Encrypted inputs that need a real password are not supported by `openPdf`; inputs that open with
the empty user password work and the output is unencrypted. A damaged PDF is repaired when qpdf
can, silently; otherwise `openPdf` rejects with `OPERATION_FAILED`.

### `merge(options): Promise<void>`

| Option     | Type                                | Description                                                                                                   |
| ---------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `inputs`   | `Array<string \| { path; pages? }>` | Inputs in output order. At least one.                                                                         |
| `output`   | `string`                            | Output file. An existing file is replaced. It is written beside the target and renamed into place on success. |
| `password` | `string?`                           | Only for encrypted inputs that do not open with the empty user password. Used for every input.                |

`pages` selects pages of one input, in output order:

| Expression | Selects                               |
| ---------- | ------------------------------------- |
| `5`        | page 5                                |
| `1-3`      | pages 1, 2, 3                         |
| `4-z`      | page 4 through the last page          |
| `z`, `r1`  | the last page                         |
| `r10-r1`   | the last ten pages, in document order |
| `7-3,1,r1` | pages 7 down to 3, then 1, then last  |

Pages are 1-based, `z` is the last page, `rN` is the Nth page from the end, `A-B` with `B` before `A`
runs backwards, and commas join parts in the order written. Whitespace is not allowed. A page may be
listed more than once (the second use is a shallow copy). Bad syntax rejects with `INVALID_ARGUMENT`
before any file is touched; a page beyond the document rejects with `OPERATION_FAILED` and is never
clamped. `output` must not be one of the inputs.

### `splitPages(options): Promise<void>`

| Option          | Type      | Description                                                                    |
| --------------- | --------- | ------------------------------------------------------------------------------ |
| `input`         | `string`  | The PDF to split.                                                              |
| `outputPattern` | `string`  | Output path template with exactly one `%d`.                                    |
| `pagesPerFile`  | `number?` | Consecutive pages per output file, an integer from 1 to 4294967295. Default 1. |
| `password`      | `string?` | Only for encrypted inputs that do not open with the empty user password.       |

With one page per file, `%d` is the original page number, zero-padded to the width of the last page
number (`page-07.pdf` in a 12-page file). With `pagesPerFile > 1`, `%d` is the 1-based chunk number,
zero-padded to the width of the chunk count; the last chunk may be short. Existing files are
replaced; each file is written atomically, one after another. A failure part-way leaves the files
already written. `splitPages` resolves with nothing.

### `pageCount(options): Promise<number>`

`{ input, password? }`. Counts pages by walking the page tree.

### Errors

Every promise rejects with `QpdfError`, which has a `code` and, for native failures, a `cause`:

- `INVALID_ARGUMENT`: the request was rejected before any output was written (wrong type, empty path,
  no inputs, bad page range syntax or page 0, missing or repeated `%d`, `output` equal to an input,
  use after `close()`).
- `OPERATION_FAILED`: qpdf could not do the work (missing or unreadable input, not a PDF, page out of
  bounds, wrong password, unwritable output directory). Messages name the operation and the paths
  involved; passwords are never put in messages.

Option objects are validated at run time, so untyped JavaScript gets the same errors. No C++
exception ever reaches JavaScript: the core converts everything qpdf throws into one error type at
its boundary, and the bindings turn that into a rejected promise (Node) or a JavaScript `Error`
with the same `code` (WebAssembly).

## Building from source

Developed and verified on macOS arm64 only (Apple Clang 21, CMake 3.29.5, Node 24.14). Linux and
Windows builds have not been tried.

Requirements: Node.js 20 or newer, [pnpm](https://pnpm.io) 10, [CMake](https://cmake.org) 3.20 or
newer, a C++20 compiler, and network access at configure time
(CMake fetches the pinned sources below; for offline builds pass
`-DFETCHCONTENT_SOURCE_DIR_QPDF=<dir>` and `-DFETCHCONTENT_SOURCE_DIR_ZLIB=<dir>` pointing at
checkouts of the pinned commits; libjpeg-turbo is fetched by a nested build and has no such override).

```sh
pnpm install
pnpm build          # native addon (cmake-js, Release) + TypeScript -> packages/node/dist
pnpm test           # Node tests against the built addon
pnpm check          # prettier --check, tsc --noEmit
pnpm format         # prettier --write
```

`pnpm --filter qpdf-node build:native:debug` builds an unoptimized addon. The addon is written to
`packages/node/build/Release/qpdf_node.node`; the first build compiles qpdf and takes a few minutes.
It only links the system C++ runtime and libc.

### Pinned dependencies

All are fetched by CMake (`cmake/ThirdParty.cmake`) at a full commit hash, so a moved tag cannot
change a build:

| Dependency    | Version | Commit                                     |
| ------------- | ------- | ------------------------------------------ |
| qpdf          | 12.4.2  | `4eba95899886e851cc41d76886483b347612f2a8` |
| zlib          | 1.3.1   | `51b7f2abdade71cd9bb0e7a373ef2610ec6f9daf` |
| libjpeg-turbo | 3.1.4.1 | `9217719d3a58633923b096af4c1d50d304768a64` |

qpdf is built with its own crypto code (no OpenSSL or GnuTLS) and with zlib and libjpeg-turbo built
from the sources above rather than found on the system, so native and WebAssembly builds link the
same versions. To bump qpdf, change the commit and version comment in `cmake/ThirdParty.cmake`, then
rebuild, rerun the tests, and regenerate the notices (`node scripts/generate-third-party-notices.mjs`).

### WebAssembly build

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
`extract(pages)`, `close()`, `qpdfVersion()`. It has no file-system operations (`merge`,
`splitPages`, path `pageCount` are Node-only) and no password option yet. Because a large document
blocks while it is parsed or written, **run it in a Web Worker**. `native/wasm/qpdf-worker.mjs` is a
ready-made worker with a small `postMessage` protocol that transfers PDF bytes instead of copying
them; put `qpdf-core.mjs` and `qpdf-core.wasm` next to it and start it with
`new Worker(new URL("./qpdf-worker.mjs", import.meta.url), { type: "module" })` (protocol in the
file's header comment).

**Verification status:** the WebAssembly module was built and its smoke test passed under Node.js.
It has not been run in a browser or a Web Worker, and `qpdf-worker.mjs` has not been run at all.

## Behavior and limitations

- Outputs are always unencrypted, even when the input was encrypted (qpdf decrypts on load).
- No linearization and no output encryption.
- Output is deterministic (qpdf's deterministic `/ID`), written with streams preserved and a newline
  before `endstream`.
- qpdf repairs damaged cross-reference data when it can. Its warnings are discarded.
- Inputs are read lazily from disk by qpdf (not memory-mapped by this package): do not modify an input
  file while an operation on it runs.
- `splitPages` writes files one after another (not in parallel). `merge` and each split file are
  written atomically.
- One libuv thread-pool thread is used per operation (`UV_THREADPOOL_SIZE`, default 4).
- Not covered by tests: encrypted inputs and passwords (needs an encrypted fixture), and very large
  files. The tests build their small PDFs in memory; when a `qpdf` executable is on `PATH`, tests also
  run `qpdf --check` on outputs (not required).

## Changes from pdq-node

- The package is now `qpdf-node` and the error class `QpdfError` (codes unchanged). The Rust
  workspace, napi-rs, and the pdq crate are gone; the Artistic-2.0 license text went with pdq.
- `openPdf` no longer uses temporary files: it keeps one parsed in-memory qpdf document. Repeated
  pages in `extract` are still rejected (the earlier limitation), although qpdf could write them.
- `merge` page ranges are the same syntax, now parsed by this package (`native/core/page_range.cc`);
  `z` and `r1` both mean the last page. A page may now be repeated in a `merge` range.
- Streams are no longer re-encoded differently from the source; output bytes differ from pdq's.
- Damaged-file repair is qpdf's, and its warnings are silent instead of printed to stderr.
- `splitPages` is sequential and per-file atomic.
- Output `merge` of an input with no pages is skipped; if nothing remains it rejects with
  `OPERATION_FAILED`.

## Repository layout

```
CMakeLists.txt             Root build: pinned dependencies, core, and the addon / WebAssembly targets
cmake/ThirdParty.cmake     Pinned qpdf, zlib, libjpeg-turbo
native/core/               Shared C++ core (no Node or Emscripten dependency)
  pdf_core.hh              Public core API: Document, PageRange, assemblePages, Error
  document.cc              qpdf-backed open / extract / assemble, exception boundary
  page_range.cc            Page range parser
  file_operations.{hh,cc}  Path-based merge / splitPages / pageCount (not in WebAssembly)
native/node/               N-API addon (node-addon-api): addon.cc, CMakeLists.txt
native/wasm/               Emscripten module: wasm_bindings.cc, qpdf-worker.mjs, smoke-test.mjs
packages/node/             The npm package "qpdf-node": TypeScript wrapper and tests
scripts/                   generate-third-party-notices.mjs
```

## License

The source in this repository is under the [MIT License](LICENSE). The compiled addon and
WebAssembly module statically link [qpdf](https://github.com/qpdf/qpdf) (Apache License 2.0), zlib,
and libjpeg-turbo; their licenses are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). The
package is licensed `MIT AND Apache-2.0` as a whole. This project is not affiliated with the qpdf
authors.
