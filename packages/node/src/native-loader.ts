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

/** Prebuilt targets, as `${platform}-${arch}` (plus `-gnu` / `-msvc`) package suffixes. */
const platformPackageNames: Readonly<Record<string, string>> = {
  "darwin-arm64": "qpdf-node-darwin-arm64",
  "darwin-x64": "qpdf-node-darwin-x64",
  "linux-x64-glibc": "qpdf-node-linux-x64-gnu",
  "linux-arm64-glibc": "qpdf-node-linux-arm64-gnu",
  "win32-x64": "qpdf-node-win32-x64-msvc",
};

export const supportedPlatformPackages: readonly string[] = Object.values(platformPackageNames);

/** Path of the addon that `pnpm run build:native` writes, relative to `dist/` or `src/`. */
function developmentAddonPath(directory: string): string {
  return join(directory, "..", "build", "Release", "qpdf_node.node");
}

/** The npm package holding the addon for `runtime`, or undefined when no prebuilt exists. */
export function platformPackageName(runtime: RuntimePlatform): string | undefined {
  const key =
    runtime.platform === "linux"
      ? `linux-${runtime.arch}-${runtime.libc ?? "unknown"}`
      : `${runtime.platform}-${runtime.arch}`;
  return platformPackageNames[key];
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

function isModuleNotFound(error: unknown, moduleName: string): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const { code, message } = error as { code?: unknown; message?: unknown };
  // A missing dependency *of* the addon also has this code; only the addon itself counts.
  return (
    code === "MODULE_NOT_FOUND" &&
    typeof message === "string" &&
    message.split("\n")[0]?.includes(`'${moduleName}'`) === true
  );
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
 *   2. The platform package for this runtime (an optional dependency of qpdf-node).
 * A file that exists but fails to load (wrong architecture, missing system library) is
 * reported as is, never silently replaced by another binary.
 */
export function loadNativeBinding(environment: NativeLoaderEnvironment): NativeBinding {
  const developmentAddon = developmentAddonPath(environment.directory);
  if (environment.fileExists(developmentAddon)) {
    return environment.requireModule(developmentAddon) as NativeBinding;
  }

  const packageName = platformPackageName(environment.runtime);
  if (packageName === undefined) {
    throw new Error(
      `qpdf-node has no prebuilt native addon for this platform. ${describeRuntime(environment.runtime)}. ` +
        `Supported packages: ${supportedPlatformPackages.join(", ")}. ` +
        "To use another platform, build the addon from source (see the qpdf-node README).",
    );
  }

  try {
    return environment.requireModule(packageName) as NativeBinding;
  } catch (error) {
    if (isModuleNotFound(error, packageName)) {
      throw new Error(
        `qpdf-node could not find its native addon package ${packageName} ` +
          `(${describeRuntime(environment.runtime)}). It is installed as an optional dependency of qpdf-node: ` +
          "reinstall without --omit=optional / --no-optional, and do not copy node_modules between platforms. " +
          "In a source checkout, run `pnpm run build:native` instead.",
        { cause: error },
      );
    }
    throw new Error(
      `qpdf-node found its native addon package ${packageName} but could not load it ` +
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
