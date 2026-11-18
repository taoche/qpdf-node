# Development

## Building from source

Developed and verified on macOS arm64 (Apple Clang 21, CMake 3.29.5, Node 24.14). Linux and Windows
builds are done by the release workflow (see [releasing.md](releasing.md)).

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

The WebAssembly build is described in [webassembly.md](webassembly.md).

## Tests

The tests build their small PDFs in memory; when a `qpdf` executable is on `PATH`, tests also
run `qpdf --check` on outputs (not required). Not covered by tests: encrypted inputs and passwords
(needs an encrypted fixture), and very large files.

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
                           package-platform, package-root, smoke-test-packages, verify-release,
                           publish-packages)
.github/workflows/         release.yml: build the five addons, stage, test and publish six packages
```

## Addon loading order

At load time the addon is looked up in this order:

1. `build/Release/qpdf_node.node` inside the package directory: a source checkout after
   `pnpm run build:native`. Published packages do not contain it.
2. The platform package for the running Node.js (`qpdf-node-<platform>-<arch>[-abi]`).

A file that exists but fails to load is reported as is, and an unsupported platform gets an error
that lists the supported packages.
