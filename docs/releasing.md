# Releasing

> **Status: 0.2.1 (prepared, not yet released).** The release workflow (`.github/workflows/release.yml`)
> is written to build and test the prebuilt addons on every supported platform, but has not run for
> 0.2.1 yet; see [What was and was not validated](#what-was-and-was-not-validated-locally).

Six packages, all at the same version: the five platform packages of the
[table below](#platform-runners) and the root `qpdf-node`. The root lists every platform package in
`optionalDependencies` at that exact version; npm installs only the one whose `os`, `cpu` and `libc`
fields match the machine. The root contains no binary, and each platform package contains one
`qpdf_node.node`, `LICENSE` and `THIRD_PARTY_NOTICES.md` (qpdf's Apache-2.0 license and notices).

The workspace manifest `packages/node/package.json` is `private` and does not list the platform
packages (they are not on the registry before a release, so `pnpm install --frozen-lockfile` could not
resolve them). Published packages are instead staged by checked-in scripts into `build/npm/`:

| Command                                                     | What it does                                                                                                                                                                   |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm verify:release [--tag vX.Y.Z]`                        | Checks that package version, `CMakeLists.txt` version, the tag, the repository URL, the root scripts and the workflow's runner list agree.                                     |
| `pnpm stage:addon [--target T] [--addon F] [--out D]`       | Copies a built addon to `D/qpdf_node.<T>.node` (the CI artifact name; defaults: this machine, built addon, `build/addons`).                                                    |
| `pnpm package:platform --all --addons D [--out build/npm]`  | Stages all five `qpdf-node-<T>` packages from `D/qpdf_node.<T>.node`; fails if one is missing. `--target T [--addon F]` stages one.                                            |
| `pnpm --filter qpdf-node run build:ts && pnpm package:root` | Stages `qpdf-node` (compiled JS, declarations, license files, `optionalDependencies`). It contains no binary.                                                                  |
| `pnpm smoke:packages --root DIR --platform DIR`             | Packs the root and one platform package, installs both into an empty project with no `build/`, runs a PDF operation and checks the addon was loaded from the platform package. |
| `pnpm publish:packages [--dir build/npm] [--dry-run]`       | Publishes the five platform packages first and `qpdf-node` last; skips versions already on the registry.                                                                       |

To cut a release: bump `version` in `packages/node/package.json` **and** `project(... VERSION ...)` in
`CMakeLists.txt`, merge, then push the tag `vX.Y.Z`. The workflow `release.yml` then:

1. `prepare`: `pnpm check` and `verify:release`.
2. `build-native` (one job per platform, in parallel): `pnpm build`, `pnpm test` against the built
   addon, then uploads the addon as `qpdf_node.<target>.node` (artifact `addon-<target>`).
3. `package`: downloads all five addons, builds the TypeScript and stages the five platform packages
   and the root package (artifact `npm-packages`).
4. `test-artifacts` (per platform, Node.js 20): downloads the packages, packs the root and that
   platform's package, installs both into an empty project and runs `smoke:packages`. This proves the
   package layout and the loader on each supported runner, not just the build.
5. `publish`: publishes the five platform packages, then `qpdf-node`. A failure in any earlier job
   stops the release before anything is published. If a publish fails part-way, fix the cause and
   re-run the job: versions already published are skipped. Versions with a prerelease suffix
   (`0.3.0-rc.1`) are published under the `next` dist-tag.
6. `wasm-build` runs independently (see [webassembly.md](webassembly.md)); it is not part of
   the npm packages.

Running the workflow by hand (Actions, "Run workflow") does steps 1-4 and `npm publish --dry-run` of
all six packages. It publishes nothing and needs no npm credentials.

The staged `repository`, `homepage` and `bugs` fields point at `taoche/qpdf-node`
(`QPDF_NODE_REPOSITORY_URL` or `GITHUB_REPOSITORY` overrides `repository`). npm provenance requires the
published `repository` to match the repository that runs the workflow.

## Platform runners

| Platform package            | OS / CPU             | Built on GitHub runner | Notes                                               |
| --------------------------- | -------------------- | ---------------------- | --------------------------------------------------- |
| `qpdf-node-darwin-arm64`    | macOS, Apple silicon | `macos-15`             | Locally built and tested. Minimum macOS 12.         |
| `qpdf-node-darwin-x64`      | macOS, Intel         | `macos-15-intel`       | Built by CI only. Minimum macOS 12.                 |
| `qpdf-node-linux-x64-gnu`   | Linux x64, glibc     | `ubuntu-22.04`         | Built by CI only. glibc 2.35 or newer.              |
| `qpdf-node-linux-arm64-gnu` | Linux arm64, glibc   | `ubuntu-22.04-arm`     | Built by CI only. glibc 2.35 or newer.              |
| `qpdf-node-win32-x64-msvc`  | Windows x64          | `windows-2022`         | Built by CI only. Needs the Microsoft VC++ runtime. |

**Not supported:** musl Linux (Alpine), 32-bit systems, Windows arm64, FreeBSD. The loader reports
these as unsupported (musl is detected and is not mistaken for glibc); build from source there.
"Built by CI only" means the workflow is written for it but no one has yet seen it run: expect to fix
the first run of each non-macOS-arm64 job. On Windows, paths with characters outside the system code
page are untested (path handling in `native/core/file_operations.cc` uses `std::filesystem` with
narrow strings).

## Package sizes

Measured on the darwin-arm64 package; the other four are expected to be similar since they are built
from the same sources, but have not been measured:

| Package                    | Compressed   | Unpacked     |
| -------------------------- | ------------ | ------------ |
| `qpdf-node` (root)         | about 31 kB  | about 94 kB  |
| one platform package       | about 1.0 MB | about 2.6 MB |
| what `npm install` fetches | about 1.0 MB | about 2.7 MB |

The exact sizes are printed by `npm pack` and by `pnpm smoke:packages`.

## What was and was not validated locally

Validated on macOS arm64: `pnpm install --frozen-lockfile`, `pnpm check`, `pnpm build`, `pnpm test`,
`verify:release`, `stage:addon`, `package:platform --all`, `package:root`, `publish:packages --dry-run`
(all six packages), and `smoke:packages` (root and `qpdf-node-darwin-arm64` tarballs installed into an
empty project; the addon loads from `node_modules/qpdf-node-darwin-arm64/qpdf_node.node`). Installing
only the root tarball, with its five platform packages redirected to local tarballs, installed just the
darwin-arm64 one, which shows npm's `os`/`cpu` selection. Locally the other four addon files were
stand-in copies of the arm64 addon, so only the darwin-arm64 selection was exercised end to end. The
loader's choice for the other targets and for musl is covered by unit tests with a fake file system.

**Not validated locally:** the Linux, Windows and macOS x64 builds, the per-runner tarball smoke
tests, and the WebAssembly job. An attempt to build the Linux arm64 addon in an `ubuntu:22.04` Docker
container was abandoned: cmake-js stopped with "C++ Compiler toolset is not available" because only
`g++-12` (no plain `g++`) was installed there. GitHub's Ubuntu runners ship `g++`, and the workflow
additionally installs `g++-12` and exports `CC` / `CXX`, but whether cmake-js accepts that
combination there is unverified. The first workflow run is the real test of these jobs; use the
manual "Run workflow" dry run before pushing a tag.

## npm credentials

All five platform packages and `qpdf-node` must be publishable by the workflow. Two options:

- **Token (needed for the first publish of the platform packages).** The platform package names do not
  exist yet, so the token must be allowed to create new packages (for example a granular token
  with read/write on all packages, which you can narrow afterwards) and also publish `qpdf-node`.
  Store it as the repository secret `NPM_TOKEN`. The workflow passes it only to the publish step as
  `NODE_AUTH_TOKEN`; npm does not print it. Use an account with 2FA enforced for publishing
  "authorization only", or an automation token, since CI cannot enter a one-time password.
- **Trusted publishing (recommended after the first release).** In each package's settings on
  npmjs.com, add a GitHub Actions trusted publisher: this repository and workflow file `release.yml`.
  Trusted publishers can only be added to packages that already exist, hence the token for the first
  release. The publish job has `id-token: write` and runs Node.js 24 (npm 11.5.1 or newer, as
  trusted publishing requires); once configured, delete `NPM_TOKEN`. On tag pushes the scripts pass
  `--provenance`.

The workflow does not create a GitHub release and uses no other secrets.

## 0.2.0 versus 0.2.1

- **`qpdf-node@0.2.0`** was published as one self-contained package that bundled all five addons
  (roughly 17 MB unpacked and 6-7 MB compressed, an estimate from five addons of about 3 MB each) and had no `optionalDependencies`. It stays on npm
  unchanged: npm versions are immutable.
- **`qpdf-node@0.2.1` and later** use the layout above: a JavaScript-only root package plus one small
  platform package per system. Installing is smaller and faster, and the API is identical. Nothing
  in your code changes; just `npm install qpdf-node@latest`.

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
