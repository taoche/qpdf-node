import { existsSync } from "node:fs";
import { join } from "node:path";

import type { NativeBinding } from "./native-binding";

/** What the loader needs to know about the machine it runs on. */
export interface RuntimePlatform {
  platform: string;
  arch: string;
  /** Only meaningful on Linux: the C library this Node.js process runs on. */
  libc: "glibc" | "musl" | undefined;
}

/** Prebuilt targets, keyed by `${platform}-${arch}` (plus `-glibc` on Linux), to their addon file names. */
const bundledAddonFileNames: Readonly<Record<string, string>> = {
  "darwin-arm64": "qpdf_node.darwin-arm64.node",
  "darwin-x64": "qpdf_node.darwin-x64.node",
  "linux-x64-glibc": "qpdf_node.linux-x64-gnu.node",
  "linux-arm64-glibc": "qpdf_node.linux-arm64-gnu.node",
  "win32-x64": "qpdf_node.win32-x64-msvc.node",
};

export const supportedAddonFileNames: readonly string[] = Object.values(bundledAddonFileNames);

/** Path of the addon that `pnpm run build:native` writes, relative to `dist/` or `src/`. */
function developmentAddonPath(directory: string): string {
  return join(directory, "..", "build", "Release", "qpdf_node.node");
}

/** Path of a bundled addon inside the published package, relative to `dist/`. */
function bundledAddonPath(directory: string, addonFileName: string): string {
  return join(directory, "..", "native", addonFileName);
}

/** The bundled addon's file name for `runtime`, or undefined when no prebuilt exists. */
export function bundledAddonFileName(runtime: RuntimePlatform): string | undefined {
  const key =
    runtime.platform === "linux"
      ? `linux-${runtime.arch}-${runtime.libc ?? "unknown"}`
      : `${runtime.platform}-${runtime.arch}`;
  return bundledAddonFileNames[key];
}

export function detectRuntimePlatform(): RuntimePlatform {
  return {
    platform: process.platform,
    arch: process.arch,
    libc: process.platform === "linux" ? detectLinuxLibc() : undefined,
  };
}

function detectLinuxLibc(): "glibc" | "musl" | undefined {
  // glibc builds of Node.js report the glibc version; musl builds do not.
  const report = process.report as
    (NodeJS.ProcessReport & { excludeNetwork?: boolean }) | undefined;
  if (report === undefined || report === null) {
    return undefined;
  }
  const previousExcludeNetwork = report.excludeNetwork;
  report.excludeNetwork = true; // skip the slow network interface lookup
  try {
    const header = (report.getReport() as unknown as { header?: { glibcVersionRuntime?: string } })
      .header;
    return header?.glibcVersionRuntime === undefined ? "musl" : "glibc";
  } finally {
    report.excludeNetwork = previousExcludeNetwork;
  }
}

function describeRuntime(runtime: RuntimePlatform): string {
  const libc = runtime.platform === "linux" ? `, libc=${runtime.libc ?? "unknown"}` : "";
  return `platform=${runtime.platform}, arch=${runtime.arch}${libc}`;
}

export interface NativeLoaderEnvironment {
  /** Directory of the loader's own file (`src/` or `dist/`). */
  directory: string;
  runtime: RuntimePlatform;
  fileExists(path: string): boolean;
  requireModule(specifier: string): unknown;
}

/**
 * Loads the addon. Order:
 *   1. `build/Release/qpdf_node.node` next to the package, if present: a source checkout
 *      after `pnpm run build:native`. Published packages do not contain it.
 *   2. `native/qpdf_node.<target>.node` in the package for this runtime: every supported
 *      platform's addon is bundled in the one published package.
 * A file that exists but fails to load (wrong architecture, missing system library) is
 * reported as is, never silently replaced by another binary.
 */
export function loadNativeBinding(environment: NativeLoaderEnvironment): NativeBinding {
  const developmentAddon = developmentAddonPath(environment.directory);
  if (environment.fileExists(developmentAddon)) {
    return environment.requireModule(developmentAddon) as NativeBinding;
  }

  const addonFileName = bundledAddonFileName(environment.runtime);
  if (addonFileName === undefined) {
    throw new Error(
      `qpdf-node has no prebuilt native addon for this platform. ${describeRuntime(environment.runtime)}. ` +
        `Bundled addons: ${supportedAddonFileNames.join(", ")}. ` +
        "To use another platform, build the addon from source (see the qpdf-node README).",
    );
  }

  const addonPath = bundledAddonPath(environment.directory, addonFileName);
  if (!environment.fileExists(addonPath)) {
    throw new Error(
      `qpdf-node could not find its bundled native addon ${addonFileName} ` +
        `(${describeRuntime(environment.runtime)}, expected at ${addonPath}). ` +
        "The published package contains it: reinstall qpdf-node. " +
        "In a source checkout, run `pnpm run build:native` instead.",
    );
  }

  try {
    return environment.requireModule(addonPath) as NativeBinding;
  } catch (error) {
    throw new Error(
      `qpdf-node found its bundled native addon ${addonFileName} but could not load it ` +
        `(${describeRuntime(environment.runtime)}): ${String(error)}`,
      { cause: error },
    );
  }
}

export function loadNativeBindingForCurrentProcess(directory: string): NativeBinding {
  return loadNativeBinding({
    directory,
    runtime: detectRuntimePlatform(),
    fileExists: existsSync,
    requireModule: require,
  });
}
