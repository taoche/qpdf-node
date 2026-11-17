// Shared helpers for the release scripts: the supported platform table, the
// source manifest, and the reading of the repository's version. The release is
// the root package qpdf-node (JavaScript only) plus one package per platform that
// holds that platform's addon; the root lists them as optionalDependencies.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
export const packageDirectory = join(repositoryRoot, "packages", "node");

/** The file name of the addon in the CI artifact that carries it from the build job to staging. */
export function addonFileNameFor(target) {
  return `qpdf_node.${target}.node`;
}

/**
 * Every prebuilt target. `name` is the npm package that holds the addon for it
 * and must equal what packages/node/src/native-loader.ts computes at run time
 * (a test checks this). `runner` is the GitHub Actions runner that builds it.
 */
function definePlatform(target, os, cpu, libc, runner) {
  return {
    target,
    name: `qpdf-node-${target}`,
    addonFileName: addonFileNameFor(target),
    os,
    cpu,
    libc,
    runner,
  };
}

export const platforms = [
  definePlatform("darwin-arm64", "darwin", "arm64", null, "macos-15"),
  definePlatform("darwin-x64", "darwin", "x64", null, "macos-15-intel"),
  definePlatform("linux-x64-gnu", "linux", "x64", "glibc", "ubuntu-22.04"),
  definePlatform("linux-arm64-gnu", "linux", "arm64", "glibc", "ubuntu-22.04-arm"),
  definePlatform("win32-x64-msvc", "win32", "x64", null, "windows-2022"),
];

export function findPlatform(target) {
  const platform = platforms.find((candidate) => candidate.target === target);
  if (platform === undefined) {
    throw new Error(
      `Unknown platform target. target=${target}, known=${platforms.map((p) => p.target).join(",")}`,
    );
  }
  return platform;
}

/** The target of the machine running this script, e.g. "darwin-arm64". */
export function currentTarget() {
  const match = platforms.find(
    (platform) => platform.os === process.platform && platform.cpu === process.arch,
  );
  if (match === undefined) {
    throw new Error(
      `No prebuilt target for this machine. platform=${process.platform}, arch=${process.arch}`,
    );
  }
  return match.target;
}

export function readSourceManifest() {
  return JSON.parse(readFileSync(join(packageDirectory, "package.json"), "utf8"));
}

/**
 * An override for the repository URL recorded in the published manifest:
 * QPDF_NODE_REPOSITORY_URL wins, then GITHUB_REPOSITORY. Returns undefined when
 * neither is set, in which case the source manifest's `repository` is used.
 */
export function repositoryField(environment = process.env) {
  const explicit = environment.QPDF_NODE_REPOSITORY_URL;
  if (explicit) {
    return { type: "git", url: explicit };
  }
  const slug = environment.GITHUB_REPOSITORY;
  if (slug) {
    return { type: "git", url: `git+https://github.com/${slug}.git` };
  }
  return undefined;
}
