# qpdf-node

Extract, merge and split PDF pages from Node.js and (experimentally) the browser, on top of
[qpdf](https://github.com/qpdf/qpdf) (C++, Apache-2.0). One shared C++ core serves two bindings:

- **Node.js**: a C++ [N-API](https://nodejs.org/api/n-api.html) addon written with `node-addon-api`,
  built with CMake through `cmake-js`. Work runs on the libuv thread pool.
- **WebAssembly**: an Emscripten/embind module over the same core, bytes in and bytes out, meant to
  run inside a Web Worker.

No `qpdf` executable is spawned, and the stale third-party `qpdf-wasm` npm package is not used.

> **Status: pre-release (0.2.0).** Not yet published to npm. The release workflow
> (`.github/workflows/release.yml`) is written to publish one package with prebuilt addons for every
> supported platform, but it has not run yet:
> see [Releasing](#releasing) and [Platform support](#platform-support) for what is and is not verified.
> This package replaces the earlier `pdq-node` (Rust/pdq); see
> [Changes from pdq-node](#changes-from-pdq-node).

## Install

```sh
npm install qpdf-node
```

`qpdf-node` is **one package** that contains the JavaScript, the type declarations and the native
addon for every supported platform (see [Platform support](#platform-support)). There are no
platform packages, no `optionalDependencies` and no install scripts, so `--omit=optional`,
`--ignore-scripts` and copying `node_modules` between machines of the same platform all work. The
package is **about 17 MB unpacked and 6-7 MB compressed** (five addons of roughly 3 MB each; the
exact size is printed by `npm pack` and by `pnpm smoke:package`).

At load time the addon is looked up in this order:

1. `build/Release/qpdf_node.node` inside the package directory: a source checkout after
   `pnpm run build:native`. Published packages do not contain it.
2. `native/qpdf_node.<target>.node` inside the package, chosen for the running Node.js (the names are
   in the table below).

A file that exists but fails to load is reported as is, and an unsupported platform gets an error
that lists the bundled addons.

## Platform support

| Bundled file (`native/`)         | OS / CPU             | Built on GitHub runner | Notes                                               |
| -------------------------------- | -------------------- | ---------------------- | --------------------------------------------------- |
| `qpdf_node.darwin-arm64.node`    | macOS, Apple silicon | `macos-15`             | Locally built and tested. Minimum macOS 12.         |
| `qpdf_node.darwin-x64.node`      | macOS, Intel         | `macos-15-intel`       | Built by CI only. Minimum macOS 12.                 |
| `qpdf_node.linux-x64-gnu.node`   | Linux x64, glibc     | `ubuntu-22.04`         | Built by CI only. glibc 2.35 or newer.              |
| `qpdf_node.linux-arm64-gnu.node` | Linux arm64, glibc   | `ubuntu-22.04-arm`     | Built by CI only. glibc 2.35 or newer.              |
| `qpdf_node.win32-x64-msvc.node`  | Windows x64          | `windows-2022`         | Built by CI only. Needs the Microsoft VC++ runtime. |

**Not supported:** musl Linux (Alpine), 32-bit systems, Windows arm64, FreeBSD. The loader reports
these as unsupported (musl is detected and is not mistaken for glibc); build from source there.
"Built by CI only" means the workflow is written for it but no one has yet seen it run: expect to fix
the first run of each non-macOS-arm64 job. On Windows, paths with characters outside the system code
page are untested (path handling in `native/core/file_operations.cc` uses `std::filesystem` with
narrow strings).

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

Developed and verified on macOS arm64 (Apple Clang 21, CMake 3.29.5, Node 24.14). Linux and Windows
builds are done by the release workflow (see [Releasing](#releasing)).

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
It is **not published to npm**: the release workflow builds it (`wasm-build` job), runs the Node.js
smoke test and uploads `qpdf-core.mjs`, `qpdf-core.wasm` and `qpdf-worker.mjs` as the
`qpdf-wasm-build` workflow artifact. Nothing in `qpdf-node` depends on it, and the publish job does
not wait for it. A separate package (for example `qpdf-node-wasm`) should only be added after it is
verified in a browser.

## Releasing

The release is **one npm package, `qpdf-node`**, holding the compiled TypeScript and all five
addons in `native/` (see the [table above](#platform-support)). Expect roughly 17 MB unpacked and
6-7 MB compressed.

The workspace manifest `packages/node/package.json` is `private`. The published package is staged by
checked-in scripts into `build/npm/qpdf-node`:

| Command                                                     | What it does                                                                                                                                                                     |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm verify:release [--tag vX.Y.Z]`                        | Checks that package version, `CMakeLists.txt` version, the tag, the repository URL and the workflow's runner list agree.                                                         |
| `pnpm stage:addon [--target T] [--addon F] [--out D]`       | Copies a built addon to `D/qpdf_node.<T>.node` (defaults: this machine, the built addon, `build/addons`).                                                                        |
| `pnpm --filter qpdf-node run build:ts && pnpm package:root` | Stages `qpdf-node` into `build/npm`: compiled JS and declarations, `native/` with **all five** addons from `build/addons`, license files, README. Fails if any addon is missing. |
| `pnpm smoke:package --package DIR`                          | Packs the staged package, checks the tarball contents, installs the tarball into an empty project with no `build/`, runs a PDF operation and checks which addon file loaded.     |
| `pnpm publish:package [--dir build/npm] [--dry-run]`        | Publishes `qpdf-node` (skipped if that version is already on the registry).                                                                                                      |

To cut a release: bump `version` in `packages/node/package.json` **and** `project(... VERSION ...)` in
`CMakeLists.txt`, merge, then push the tag `vX.Y.Z`. The workflow `release.yml` then:

1. `prepare`: `pnpm check` and `verify:release`.
2. `build-native` (one job per platform, in parallel): `pnpm build`, `pnpm test` against the built
   addon, then uploads the addon as `qpdf_node.<target>.node` (artifact `addon-<target>`).
3. `package`: downloads all five addons, builds the TypeScript and stages the single `qpdf-node`
   package (artifact `qpdf-node`).
4. `test-artifacts` (per platform, Node.js 20): downloads that package, packs it, installs the tarball
   into an empty project and runs `smoke:package`. This proves the package layout and the loader on
   each supported runner, not just the build.
5. `publish`: publishes `qpdf-node`. A failure in any earlier job stops the release before anything is
   published. Versions with a prerelease suffix (`0.3.0-rc.1`) are published under the `next` dist-tag.
6. `wasm-build` runs independently (see [WebAssembly build](#webassembly-build)); it is not part of
   the npm package.

Running the workflow by hand (Actions, "Run workflow") does steps 1-4 and `npm publish --dry-run`.
It publishes nothing and needs no npm credentials.

The staged `repository`, `homepage` and `bugs` fields point at `taoche/qpdf-node`
(`QPDF_NODE_REPOSITORY_URL` or `GITHUB_REPOSITORY` overrides `repository`). npm provenance requires the
published `repository` to match the repository that runs the workflow.

### What was and was not validated locally

Validated on macOS arm64: `pnpm install --frozen-lockfile`, `pnpm check`, `pnpm build`, `pnpm test`,
`verify:release`, `stage:addon`, `package:root`, `npm pack --dry-run`, `publish:package --dry-run`, and
`smoke:package` (the tarball installed into an empty project; the addon loads from
`node_modules/qpdf-node/native/qpdf_node.darwin-arm64.node`). Locally the other four addon files were
stand-in copies of the arm64 addon, so the package size printed locally (about 13 MB unpacked, 5 MB
compressed) is not the real one, and only the darwin-arm64 selection was exercised end to end. The
loader's choice for the other targets and for musl is covered by unit tests with a fake file system.

**Not validated locally:** the Linux, Windows and macOS x64 builds, the per-runner tarball smoke
tests, and the WebAssembly job. An attempt to build the Linux arm64 addon in an `ubuntu:22.04` Docker
container was abandoned: cmake-js stopped with "C++ Compiler toolset is not available" because only
`g++-12` (no plain `g++`) was installed there. GitHub's Ubuntu runners ship `g++`, and the workflow
additionally installs `g++-12` and exports `CC` / `CXX`, but whether cmake-js accepts that
combination there is unverified. The first workflow run is the real test of these jobs; use the
manual "Run workflow" dry run before pushing a tag.

### npm credentials

Only `qpdf-node` is published. Two options:

- **Token (needed for the first publish).** Create a granular access token on npmjs.com that may
  publish `qpdf-node` (for a package that does not exist yet, npm needs a token allowed to create new
  packages, for example scoped to all packages, which you can narrow afterwards) and store it as the
  repository secret `NPM_TOKEN`. The workflow passes it only to the publish step as `NODE_AUTH_TOKEN`;
  npm does not print it. Use an account with 2FA enforced for publishing "authorization only", or an
  automation token, since CI cannot enter a one-time password.
- **Trusted publishing (recommended after the first release).** In the package's settings on npmjs.com,
  add a GitHub Actions trusted publisher: this repository and workflow file `release.yml`. Trusted
  publishers can only be added to packages that already exist, hence the token for the first release.
  The publish job has `id-token: write` and runs Node.js 24 (npm 11.5.1 or newer, as trusted
  publishing requires); once configured, delete `NPM_TOKEN`. On tag pushes the scripts pass
  `--provenance`.

The workflow does not create a GitHub release and uses no other secrets.

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
packages/node/             The "qpdf-node" TypeScript wrapper (src/native-loader.ts finds the addon) and tests
scripts/                   generate-third-party-notices.mjs; release scripts (release-lib, stage-addon,
                           package-root, smoke-test-package, verify-release, publish-package)
.github/workflows/         release.yml: build the five addons, stage, test and publish the one package
```

## License

The source in this repository is under the [MIT License](LICENSE). The compiled addon and
WebAssembly module statically link [qpdf](https://github.com/qpdf/qpdf) (Apache License 2.0), zlib,
and libjpeg-turbo; their licenses are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). The
package is licensed `MIT AND Apache-2.0` as a whole. This project is not affiliated with the qpdf
authors.
