// Stages one platform package (qpdf-node-<target>) holding a built addon:
//
//   node scripts/package-platform.mjs [--target darwin-arm64] \
//     [--addon packages/node/build/Release/qpdf_node.node] [--out build/npm]
//
// Output: <out>/qpdf-node-<target>/ with package.json, qpdf_node.node, LICENSE,
// THIRD_PARTY_NOTICES.md and README.md. Publish it with `npm publish <dir>`.

import { copyFileSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import {
  currentTarget,
  findPlatform,
  packageDirectory,
  readSourceManifest,
  repositoryField,
  repositoryRoot,
} from "./release-lib.mjs";

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
const outputRoot = resolve(values.out ?? join(repositoryRoot, "build", "npm"));
const source = readSourceManifest();

if (!statSync(addonPath, { throwIfNoEntry: false })?.isFile()) {
  throw new Error(
    `The addon to package does not exist. target=${platform.target}, addon=${addonPath}`,
  );
}

const packageRoot = join(outputRoot, platform.name);
rmSync(packageRoot, { recursive: true, force: true });
mkdirSync(packageRoot, { recursive: true });

copyFileSync(addonPath, join(packageRoot, "qpdf_node.node"));
for (const fileName of ["LICENSE", "THIRD_PARTY_NOTICES.md"]) {
  copyFileSync(join(repositoryRoot, fileName), join(packageRoot, fileName));
}

const manifest = {
  name: platform.name,
  version: source.version,
  description: `Prebuilt ${platform.target} native addon for qpdf-node. Install qpdf-node, not this package.`,
  license: source.license,
  repository: repositoryField(),
  main: "qpdf_node.node",
  files: ["qpdf_node.node", "LICENSE", "THIRD_PARTY_NOTICES.md", "README.md"],
  os: [platform.os],
  cpu: [platform.cpu],
  libc: platform.libc === null ? undefined : [platform.libc],
  engines: source.engines,
};
writeFileSync(join(packageRoot, "package.json"), JSON.stringify(manifest, null, 2) + "\n");

writeFileSync(
  join(packageRoot, "README.md"),
  `# ${platform.name}\n\n` +
    `Prebuilt native addon of [qpdf-node](https://www.npmjs.com/package/qpdf-node) for ` +
    `${platform.os} ${platform.cpu}${platform.libc === null ? "" : ` (${platform.libc})`}. ` +
    `It is installed automatically as an optional dependency of \`qpdf-node\` and has no API of its own.\n\n` +
    `The addon statically links qpdf (Apache-2.0), zlib and libjpeg-turbo; see THIRD_PARTY_NOTICES.md.\n`,
);

console.log(`Staged ${platform.name}@${source.version} at ${packageRoot}`);
