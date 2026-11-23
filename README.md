# qpdf-node

Extract, merge and split PDF pages from Node.js, on top of [qpdf](https://github.com/qpdf/qpdf)
(C++, Apache-2.0). A C++ [N-API](https://nodejs.org/api/n-api.html) addon does the work on the libuv
thread pool: no `qpdf` executable is spawned. An experimental WebAssembly build for the browser
exists too (see [WebAssembly](#webassembly)).

## Install

```sh
npm install qpdf-node
```

That is the only package you install. `qpdf-node` lists one platform package per supported system in
`optionalDependencies`, each marked with `os`, `cpu` and (on Linux) `libc`, so npm, pnpm and yarn
download only the one that matches your machine. The platform packages hold the native addon and have
no API, so do not depend on them directly. There are no install scripts and no download at install
time.

Install without optional dependencies (`--omit=optional`, `--no-optional`) or copy `node_modules`
between platforms, and the platform package is missing: the loader then fails with an error that
names the missing package. Reinstall on the target machine. Requires Node.js 20 or newer.

## Supported platforms

| OS / CPU             | Platform package            | Notes                     |
| -------------------- | --------------------------- | ------------------------- |
| macOS, Apple silicon | `qpdf-node-darwin-arm64`    | macOS 12 or newer.        |
| macOS, Intel         | `qpdf-node-darwin-x64`      | macOS 12 or newer.        |
| Linux x64, glibc     | `qpdf-node-linux-x64-gnu`   | glibc 2.35 or newer.      |
| Linux arm64, glibc   | `qpdf-node-linux-arm64-gnu` | glibc 2.35 or newer.      |
| Windows x64          | `qpdf-node-win32-x64-msvc`  | Not published to npm yet. |

Windows x64 has no prebuilt package on npm yet, so `npm install` skips it there and the loader
reports the missing package; [build from source](https://github.com/taoche/qpdf-node/blob/main/docs/development.md)
until it is published.

Not supported: musl Linux (Alpine), 32-bit systems, Windows arm64, FreeBSD. The loader reports these
as unsupported; build from source there.

## Quick start

```ts
import {
  merge,
  mergeBytes,
  splitPages,
  pageCount,
  openPdf,
  qpdfVersion,
  QpdfError,
} from "qpdf-node";

// Bytes in, bytes out. The document is parsed once and kept in memory.
const pdf = await openPdf(bytes); // Buffer or Uint8Array
try {
  console.log(pdf.pageCount);
  const subset: Uint8Array = await pdf.extract([3, 1, 2]); // 1-based, in this order
} finally {
  await pdf.close();
}

const book: Uint8Array = await mergeBytes({
  inputs: [coverBytes, { bytes: bodyBytes, pages: "2-z" }],
});

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

## API

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

### `mergeBytes(options): Promise<Uint8Array>`

| Option   | Type                                     | Description                                                         |
| -------- | ---------------------------------------- | ------------------------------------------------------------------- |
| `inputs` | `Array<Uint8Array \| { bytes; pages? }>` | Inputs in output order. At least one. A `Buffer` is a `Uint8Array`. |

The in-memory counterpart of `merge`: same `pages` syntax, same unencrypted output, same bytes for
the same inputs. Nothing is written to disk, and the input buffers are copied before the call
returns. Errors name the failing input (`inputs[1]`). Encrypted inputs that need a real password are
not supported, as with `openPdf`.

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
  files.

## WebAssembly

An experimental Emscripten/embind build of the same C++ core exists for use in a Web Worker. It is
**not published to npm** and has only been smoke-tested under Node.js, not in a browser. Its API is
synchronous and in memory (no file-system operations). See
[docs/webassembly.md](https://github.com/taoche/qpdf-node/blob/main/docs/webassembly.md).

## Contributing and maintainers

Building from source, tests, repository layout and the release procedure are documented in
[docs/development.md](https://github.com/taoche/qpdf-node/blob/main/docs/development.md) and
[docs/releasing.md](https://github.com/taoche/qpdf-node/blob/main/docs/releasing.md).

## License

The source in this repository is under the [MIT License](LICENSE). The compiled addon and
WebAssembly module statically link [qpdf](https://github.com/qpdf/qpdf) (Apache License 2.0), zlib,
and libjpeg-turbo; their licenses are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). The
package is licensed `MIT AND Apache-2.0` as a whole. This project is not affiliated with the qpdf
authors.
