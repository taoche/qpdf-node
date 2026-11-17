// Copies one built addon to its platform-specific file name, ready to be
// uploaded as a CI artifact and turned into a platform package by
// package-platform.mjs --all:
//
//   node scripts/stage-addon.mjs [--target darwin-arm64] \
//     [--addon packages/node/build/Release/qpdf_node.node] [--out build/addons]
//
// Output: <out>/qpdf_node.<target>.node
import { copyFileSync, mkdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { currentTarget, findPlatform, packageDirectory, repositoryRoot } from "./release-lib.mjs";

const { values } = parseArgs({
  options: {
    target: { type: "string" },
    addon: { type: "string" },
    out: { type: "string" },
  },
});

const platform = findPlatform(values.target ?? currentTarget());
const addonPath = resolve(
  values.addon ?? join(packageDirectory, "build", "Release", "qpdf_node.node"),
);
const outputDirectory = resolve(values.out ?? join(repositoryRoot, "build", "addons"));

if (!statSync(addonPath, { throwIfNoEntry: false })?.isFile()) {
  throw new Error(
    `The addon to stage does not exist. target=${platform.target}, addon=${addonPath}`,
  );
}

mkdirSync(outputDirectory, { recursive: true });
const stagedPath = join(outputDirectory, platform.addonFileName);
copyFileSync(addonPath, stagedPath);
console.log(`Staged ${platform.addonFileName} at ${stagedPath}`);
