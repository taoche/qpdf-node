import { strict as assert } from "node:assert";
import { join } from "node:path";
import { describe, test } from "node:test";
import { pathToFileURL } from "node:url";

import {
  detectRuntimePlatform,
  loadNativeBinding,
  platformPackageName,
  supportedPlatformPackages,
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

describe("platformPackageName", () => {
  const cases: Array<[RuntimePlatform, string | undefined]> = [
    [{ platform: "darwin", arch: "arm64", libc: undefined }, "qpdf-node-darwin-arm64"],
    [{ platform: "darwin", arch: "x64", libc: undefined }, "qpdf-node-darwin-x64"],
    [{ platform: "linux", arch: "x64", libc: "glibc" }, "qpdf-node-linux-x64-gnu"],
    [{ platform: "linux", arch: "arm64", libc: "glibc" }, "qpdf-node-linux-arm64-gnu"],
    [{ platform: "win32", arch: "x64", libc: undefined }, "qpdf-node-win32-x64-msvc"],
    [{ platform: "linux", arch: "x64", libc: "musl" }, undefined],
    [{ platform: "linux", arch: "x64", libc: undefined }, undefined],
    [{ platform: "linux", arch: "ia32", libc: "glibc" }, undefined],
    [{ platform: "win32", arch: "arm64", libc: undefined }, undefined],
    [{ platform: "freebsd", arch: "x64", libc: undefined }, undefined],
  ];
  for (const [runtime, expected] of cases) {
    test(`${runtime.platform} ${runtime.arch} ${runtime.libc ?? "-"}`, () => {
      assert.equal(platformPackageName(runtime), expected);
    });
  }

  test("supported packages match the release script's platform table", async () => {
    const releaseLibUrl = pathToFileURL(
      join(__dirname, "..", "..", "..", "scripts", "release-lib.mjs"),
    );
    const { platforms } = (await import(releaseLibUrl.href)) as {
      platforms: Array<{ name: string }>;
    };
    assert.deepEqual([...supportedPlatformPackages].sort(), platforms.map((p) => p.name).sort());
  });
});

describe("loadNativeBinding", () => {
  const darwin: RuntimePlatform = { platform: "darwin", arch: "arm64", libc: undefined };

  test("prefers the development build over a platform package", () => {
    const env = environment({
      runtime: darwin,
      existingFiles: [developmentAddon],
      modules: { [developmentAddon]: fakeBinding, "qpdf-node-darwin-arm64": {} },
    });
    assert.equal(loadNativeBinding(env), fakeBinding);
    assert.deepEqual(env.requested, [developmentAddon]);
  });

  test("a development addon that fails to load is reported, not replaced", () => {
    const failure = Object.assign(new Error("dlopen failed"), { code: "ERR_DLOPEN_FAILED" });
    const env = environment({
      runtime: darwin,
      existingFiles: [developmentAddon],
      modules: { [developmentAddon]: failure, "qpdf-node-darwin-arm64": fakeBinding },
    });
    assert.throws(() => loadNativeBinding(env), /dlopen failed/);
  });

  test("falls back to the platform package", () => {
    const env = environment({
      runtime: darwin,
      modules: { "qpdf-node-darwin-arm64": fakeBinding },
    });
    assert.equal(loadNativeBinding(env), fakeBinding);
    assert.deepEqual(env.requested, ["qpdf-node-darwin-arm64"]);
  });

  test("names the missing platform package and how to fix it", () => {
    const env = environment({ runtime: darwin });
    assert.throws(
      () => loadNativeBinding(env),
      (error: Error) => {
        assert.match(error.message, /qpdf-node-darwin-arm64/);
        assert.match(error.message, /--omit=optional/);
        assert.equal((error.cause as NodeJS.ErrnoException).code, "MODULE_NOT_FOUND");
        return true;
      },
    );
  });

  test("reports a platform package that exists but fails to load", () => {
    const failure = Object.assign(new Error("dlopen: libstdc++ too old"), {
      code: "ERR_DLOPEN_FAILED",
    });
    const env = environment({ runtime: darwin, modules: { "qpdf-node-darwin-arm64": failure } });
    assert.throws(
      () => loadNativeBinding(env),
      (error: Error) => {
        assert.match(error.message, /found its native addon package qpdf-node-darwin-arm64/);
        assert.match(error.message, /libstdc\+\+ too old/);
        assert.equal(error.cause, failure);
        return true;
      },
    );
  });

  test("a dependency missing from inside the platform package is not 'package not found'", () => {
    const env = environment({
      runtime: darwin,
      modules: { "qpdf-node-darwin-arm64": moduleNotFound("some-other-lib") },
    });
    assert.throws(() => loadNativeBinding(env), /found its native addon package/);
  });

  test("unsupported platform lists what is supported", () => {
    const env = environment({ runtime: { platform: "linux", arch: "x64", libc: "musl" } });
    assert.throws(
      () => loadNativeBinding(env),
      (error: Error) => {
        assert.match(error.message, /no prebuilt native addon/);
        assert.match(error.message, /platform=linux, arch=x64, libc=musl/);
        assert.match(error.message, /qpdf-node-linux-x64-gnu/);
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
