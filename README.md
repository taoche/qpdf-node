# pdq-node

Node.js bindings for [pdq](https://crates.io/crates/pdq), a fast pure-Rust PDF split/merge
library. `pdq-node` is a native addon built with [napi-rs](https://napi.rs): file-path operations
that run on the libuv thread pool and return promises.

> **Status: pre-release (0.1.0), Node.js only.** Nothing is published to npm yet, and no
> prebuilt binaries exist. You build the addon from source. **WebAssembly is not supported**:
> pdq is built around file paths and memory-mapped files and is not a WASM-ready core. See
> [Roadmap](#roadmap).

## API

```ts
import { merge, splitPages, pageCount, PdqError } from "pdq-node";

// Concatenate PDFs. A string input is shorthand for { path }.
await merge({
  inputs: ["cover.pdf", { path: "body.pdf", pages: "2-z" }],
  output: "out/book.pdf",
});

// One file per page: out/page-01.pdf, out/page-02.pdf, ...
await splitPages({ input: "book.pdf", outputPattern: "out/page-%d.pdf" });

// Chunks of at most 50 pages: out/chunk-1.pdf, out/chunk-2.pdf, ...
await splitPages({ input: "book.pdf", outputPattern: "out/chunk-%d.pdf", pagesPerFile: 50 });

const pages: number = await pageCount({ input: "book.pdf" });
```

All functions take a single options object and return a promise. Paths are strings; relative paths
are relative to the process working directory. Every output directory must already exist.

### `merge(options): Promise<void>`

| Option     | Type                                | Description                                                                                                                    |
| ---------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `inputs`   | `Array<string \| { path; pages? }>` | Inputs in output order. At least one.                                                                                          |
| `output`   | `string`                            | Output file. An existing file is replaced; the write goes to a temporary file next to it and is renamed into place on success. |
| `password` | `string?`                           | Only for encrypted inputs that do not open with the empty user password.                                                       |

`pages` selects pages of one input, in output order, using pdq's page-range syntax. Page numbers are
1-based, `z` is the last page, `rN` is the Nth page from the end, `7-3` runs backwards, and commas
combine parts:

| Expression | Selects                               |
| ---------- | ------------------------------------- |
| `5`        | page 5                                |
| `1-3`      | pages 1, 2, 3                         |
| `4-z`      | page 4 through the last page          |
| `r1`       | the last page                         |
| `r10-r1`   | the last ten pages, in document order |
| `7-3,1,r1` | pages 7 down to 3, then 1, then last  |

Out-of-bounds pages are an error, not clamped. `output` must not be one of the inputs.

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
replaced. `splitPages` resolves with nothing: it does not report the names it wrote, so list the
output directory or compute them from the rules above.

### `pageCount(options): Promise<number>`

`{ input, password? }`. Counts pages by walking the page tree, so it agrees with what `merge` and
`splitPages` would use even when the file's `/Count` entry is wrong.

### Errors

Every promise rejects with `PdqError`, which has a `code` and, for native failures, a `cause`:

- `INVALID_ARGUMENT`: the options were rejected (wrong type, empty path, no inputs, bad page range,
  missing or repeated `%d`, `output` equal to an input). Nothing was read or written.
- `OPERATION_FAILED`: pdq could not do the work (missing or unreadable input, not a PDF, page out of
  bounds, wrong password, unwritable output directory). The message names the operation and the
  paths involved. This package never puts passwords in messages.

```ts
try {
  await merge({ inputs: ["a.pdf", "missing.pdf"], output: "out.pdf" });
} catch (error) {
  if (error instanceof PdqError) console.error(error.code, error.message);
}
```

Option objects are validated at run time, so calls from untyped JavaScript get the same errors.

## Requirements and building from source

- **Node.js 20 or newer** (the addon uses Node-API 8). Developed and tested on Node 24.14.0 on macOS
  arm64; other Node versions and platforms are not yet tested.
- **Rust 1.92 or newer**, which pdq 0.5.1 requires. `rust-toolchain.toml` selects 1.92 through
  rustup.
- [pnpm](https://pnpm.io) 10.

```sh
pnpm install
pnpm build          # release native addon + TypeScript -> packages/node/dist
```

`pnpm build:debug` (inside `packages/node`) builds an unoptimized addon faster. The addon is written
to `packages/node/native/pdq-node.<platform>-<arch>.node`, next to the generated loader.

Prebuilt binaries for other platforms need per-platform npm packages (`napi create-npm-dirs`,
`napi prepublish`) and CI that builds each target. That is not set up yet, so a tarball from
`npm pack` contains only the binary built on the packing machine.

## Behavior and limitations of pdq

These come from pdq 0.5.1, which this package pins exactly and does not modify. See
[pdq's README](https://github.com/meistrari/pdq#scope) for its full scope.

- **Outputs are always unencrypted**, even when the input was encrypted. Encrypted inputs (RC4,
  AES-128, AES-256) are decrypted on load; owner-password-only files open without a password.
- No linearization ("fast web view"), and no encryption of outputs.
- Forms, outlines and named destinations are not restructured when pages are extracted. Page content,
  resources, annotations, `/Info` and XMP metadata are kept. A digital signature survives as data but
  is no longer valid on a subset.
- Damaged cross-reference data is repaired automatically; pdq prints one warning line to the
  process's stderr when it does.
- `splitPages` writes files in parallel and does not write atomically: a failure part-way through can
  leave some output files behind. `merge` writes atomically.
- Only file paths are supported. There is no bytes or stream API; input files are memory-mapped, so do
  not modify them while an operation runs.
- Each operation occupies one libuv thread-pool thread (`UV_THREADPOOL_SIZE`, default 4), and pdq
  may use further threads internally for page writes.
- pdq's `render`, `text`, and `dimensions` features are not exposed; the `render`/`text` crate
  features are disabled so hayro is not compiled in.
- Not covered by tests yet: encrypted inputs and passwords (needs an encrypted fixture), damaged-PDF
  repair, and very large files.

## Repository layout

```
Cargo.toml                 Rust workspace
crates/pdq-core/           Validation + calls into the pdq crate. No Node dependency; Rust tests here.
packages/node/             The npm package "pdq-node"
  src/lib.rs               napi-rs binding: maps JS options onto pdq-core, runs work as AsyncTask
  src/index.ts             Public TypeScript API, option validation, PdqError
  native/                  Generated by napi-rs: loader (index.js), declarations, the .node binary
  __tests__/               Node tests
scripts/                   generate-third-party-notices.mjs
```

`pdq-core` is the boundary a future second binding would share. Everything above it
(`packages/node`) is Node-specific.

## Development

```sh
pnpm install
pnpm --filter pdq-node build:debug   # the Node tests need the native addon built
pnpm test                            # cargo test --workspace, then the Node tests
pnpm check                           # cargo fmt --check, clippy -D warnings, prettier --check, tsc --noEmit
pnpm format                          # cargo fmt, prettier --write
```

Tests build their own small PDFs in memory or in temp directories (no binary fixtures are committed),
and need neither qpdf nor network access.

After changing dependencies, regenerate the license file: `node scripts/generate-third-party-notices.mjs`.

## Roadmap

- WebAssembly is **out of scope for this release**. pdq reads and writes by path with memory maps and
  temp-file renames, so a WASM package would need either an upstream bytes API in pdq or a different
  core. That decision is open; no WASM claim is made.
- Prebuilt binaries and npm publishing.

## License

The source in this repository (the Rust binding and the TypeScript wrapper) is under the
[MIT License](LICENSE). The compiled addon statically links the
[pdq](https://github.com/meistrari/pdq) crate, which is under the
[Artistic License 2.0](LICENSE-ARTISTIC-2.0), plus other crates listed in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). The published package is therefore licensed
`MIT AND Artistic-2.0` as a whole. pdq's source is not copied here: it is downloaded from crates.io
at build time, pinned to version 0.5.1.

This project is not affiliated with the pdq authors.
