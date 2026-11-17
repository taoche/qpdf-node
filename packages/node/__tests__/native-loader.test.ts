import { strict as assert } from "node:assert";
import { join } from "node:path";
import { describe, test } from "node:test";
import { pathToFileURL } from "node:url";

import {
  bundledAddonFileName,
  detectRuntimePlatform,
  loadNativeBinding,
  supportedAddonFileNames,
} from "../src/native-loader";
import type { NativeLoaderEnvironment, RuntimePlatform } from "../src/native-loader";
import type { NativeBinding } from "../src/native-binding";
import { native } from "../src/native";

const fakeBinding = { qpdfVersion: () => "fake" } as unknown as NativeBinding;
const directory = join("/package", "dist");
const developmentAddon = join("/package", "build", "Release", "qpdf_node.node");

function moduleNotFound(moduleName: string): Error {
  return Object.assign(new Error(`Cannot find module '${moduleName}'\nRequire stack:\n- x`), {
    code: "MODULE_NOT_FOUND",
  });
}

function environment(overrides: {
  runtime: RuntimePlatform;
  existingFiles?: string[];
  modules?: Record<string, unknown>;
}): NativeLoaderEnvironment & { requested: string[] } {
  const requested: string[] = [];
  return {
    directory,
    runtime: overrides.runtime,
    requested,
    fileExists: (path) => overrides.existingFiles?.includes(path) === true,
    requireModule: (specifier) => {
      requested.push(specifier);
      const loaded = overrides.modules?.[specifier];
      if (loaded === undefined) {
        throw moduleNotFound(specifier);
      }
      if (loaded instanceof Error) {
        throw loaded;
      }
      return loaded;
    },
  };
}

describe("bundledAddonFileName", () => {
  const cases: Array<[RuntimePlatform, string | undefined]> = [
    [{ platform: "darwin", arch: "arm64", libc: undefined }, "qpdf_node.darwin-arm64.node"],
    [{ platform: "darwin", arch: "x64", libc: undefined }, "qpdf_node.darwin-x64.node"],
    [{ platform: "linux", arch: "x64", libc: "glibc" }, "qpdf_node.linux-x64-gnu.node"],
    [{ platform: "linux", arch: "arm64", libc: "glibc" }, "qpdf_node.linux-arm64-gnu.node"],
    [{ platform: "win32", arch: "x64", libc: undefined }, "qpdf_node.win32-x64-msvc.node"],
    [{ platform: "linux", arch: "x64", libc: "musl" }, undefined],
    [{ platform: "linux", arch: "x64", libc: undefined }, undefined],
    [{ platform: "linux", arch: "ia32", libc: "glibc" }, undefined],
    [{ platform: "win32", arch: "arm64", libc: undefined }, undefined],
    [{ platform: "freebsd", arch: "x64", libc: undefined }, undefined],
  ];
  for (const [runtime, expected] of cases) {
    test(`${runtime.platform} ${runtime.arch} ${runtime.libc ?? "-"}`, () => {
      assert.equal(bundledAddonFileName(runtime), expected);
    });
  }

  test("supported addons match the release script's platform table", async () => {
    const releaseLibUrl = pathToFileURL(
      join(__dirname, "..", "..", "..", "scripts", "release-lib.mjs"),
    );
    const { platforms } = (await import(releaseLibUrl.href)) as {
      platforms: Array<{ addonFileName: string }>;
    };
    assert.deepEqual(
      [...supportedAddonFileNames].sort(),
      platforms.map((p) => p.addonFileName).sort(),
    );
  });
});

describe("loadNativeBinding", () => {
  const darwin: RuntimePlatform = { platform: "darwin", arch: "arm64", libc: undefined };
  const darwinAddon = join("/package", "native", "qpdf_node.darwin-arm64.node");

  test("prefers the development build over the bundled addon", () => {
    const env = environment({
      runtime: darwin,
      existingFiles: [developmentAddon, darwinAddon],
      modules: { [developmentAddon]: fakeBinding, [darwinAddon]: {} },
    });
    assert.equal(loadNativeBinding(env), fakeBinding);
    assert.deepEqual(env.requested, [developmentAddon]);
  });

  test("a development addon that fails to load is reported, not replaced", () => {
    const failure = Object.assign(new Error("dlopen failed"), { code: "ERR_DLOPEN_FAILED" });
    const env = environment({
      runtime: darwin,
      existingFiles: [developmentAddon, darwinAddon],
      modules: { [developmentAddon]: failure, [darwinAddon]: fakeBinding },
    });
    assert.throws(() => loadNativeBinding(env), /dlopen failed/);
  });

  test("falls back to the bundled addon for this platform", () => {
    const env = environment({
      runtime: darwin,
      existingFiles: [darwinAddon],
      modules: { [darwinAddon]: fakeBinding },
    });
    assert.equal(loadNativeBinding(env), fakeBinding);
    assert.deepEqual(env.requested, [darwinAddon]);
  });

  test("selects the bundled addon by platform, architecture and libc", () => {
    const linuxAddon = join("/package", "native", "qpdf_node.linux-arm64-gnu.node");
    const env = environment({
      runtime: { platform: "linux", arch: "arm64", libc: "glibc" },
      existingFiles: [darwinAddon, linuxAddon],
      modules: { [darwinAddon]: {}, [linuxAddon]: fakeBinding },
    });
    assert.equal(loadNativeBinding(env), fakeBinding);
    assert.deepEqual(env.requested, [linuxAddon]);
  });

  test("names the missing bundled addon and how to fix it", () => {
    const env = environment({ runtime: darwin });
    assert.throws(
      () => loadNativeBinding(env),
      (error: Error) => {
        assert.match(error.message, /bundled native addon qpdf_node\.darwin-arm64\.node/);
        assert.match(error.message, /reinstall qpdf-node/);
        assert.match(error.message, /build:native/);
        return true;
      },
    );
    assert.deepEqual(env.requested, []);
  });

  test("reports a bundled addon that exists but fails to load", () => {
    const failure = Object.assign(new Error("dlopen: libstdc++ too old"), {
      code: "ERR_DLOPEN_FAILED",
    });
    const env = environment({
      runtime: darwin,
      existingFiles: [darwinAddon],
      modules: { [darwinAddon]: failure },
    });
    assert.throws(
      () => loadNativeBinding(env),
      (error: Error) => {
        assert.match(error.message, /found its bundled native addon qpdf_node\.darwin-arm64\.node/);
        assert.match(error.message, /libstdc\+\+ too old/);
        assert.equal(error.cause, failure);
        return true;
      },
    );
  });

  test("unsupported platform lists what is bundled", () => {
    const env = environment({ runtime: { platform: "linux", arch: "x64", libc: "musl" } });
    assert.throws(
      () => loadNativeBinding(env),
      (error: Error) => {
        assert.match(error.message, /no prebuilt native addon/);
        assert.match(error.message, /platform=linux, arch=x64, libc=musl/);
        assert.match(error.message, /qpdf_node\.linux-x64-gnu\.node/);
        return true;
      },
    );
    assert.deepEqual(env.requested, []);
  });
});

describe("the loader in this process", () => {
  test("detects this machine and loads an addon", () => {
    const runtime = detectRuntimePlatform();
    assert.equal(runtime.platform, process.platform);
    assert.equal(typeof native.qpdfVersion(), "string");
  });
});
