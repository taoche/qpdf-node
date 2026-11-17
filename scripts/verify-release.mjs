// Fails when the repository is not in a releasable state:
//
//   node scripts/verify-release.mjs [--tag v0.2.0]
//
// Checks that the workspace manifest, CMakeLists.txt and (when given) the git
// tag agree on one version, and that the manifest is the one the release scripts
// expect (name, private, no binary files, no hand-written platform dependencies).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { platforms, readSourceManifest, repositoryRoot } from "./release-lib.mjs";

const { values } = parseArgs({ options: { tag: { type: "string" } } });
const manifest = readSourceManifest();
const problems = [];

if (manifest.name !== "qpdf-node") {
  problems.push(`packages/node/package.json name must be qpdf-node, found ${manifest.name}`);
}
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(manifest.version)) {
  problems.push(`version is not a plain semver version. version=${manifest.version}`);
}
if (manifest.private !== true) {
  problems.push(
    "packages/node/package.json must stay private: publish the staged packages instead",
  );
}
if (manifest.optionalDependencies !== undefined) {
  problems.push(
    "packages/node/package.json must not list optionalDependencies: they are added to the staged " +
      "package by scripts/package-root.mjs (the platform packages are not on the registry before a release)",
  );
}

const cmakeVersion = readFileSync(join(repositoryRoot, "CMakeLists.txt"), "utf8").match(
  /project\(qpdf_node VERSION (\S+)/,
)?.[1];
const baseVersion = manifest.version.split("-")[0];
if (cmakeVersion !== baseVersion) {
  problems.push(
    `CMakeLists.txt project VERSION does not match the package version. cmake=${cmakeVersion}, package=${manifest.version}`,
  );
}

const workflow = readFileSync(join(repositoryRoot, ".github", "workflows", "release.yml"), "utf8");
for (const platform of platforms) {
  const entry = `- target: ${platform.target}\n            runner: ${platform.runner}\n`;
  const occurrences = workflow.split(entry).length - 1;
  if (occurrences !== 2) {
    problems.push(
      `.github/workflows/release.yml must list target ${platform.target} on runner ${platform.runner} in both matrices. found=${occurrences}`,
    );
  }
}

if (values.tag !== undefined && values.tag !== `v${manifest.version}`) {
  problems.push(
    `The tag does not match the package version. tag=${values.tag}, expected=v${manifest.version}`,
  );
}

if (problems.length > 0) {
  console.error(problems.map((problem) => `- ${problem}`).join("\n"));
  process.exit(1);
}
console.log(
  `Release check passed. version=${manifest.version}, packages=${[...platforms.map((p) => p.name), "qpdf-node"].join(",")}`,
);
