// Stages platform packages (qpdf-node-<target>), each holding one built addon:
//
//   node scripts/package-platform.mjs [--target darwin-arm64] \
//     [--addon packages/node/build/Release/qpdf_node.node] [--out build/npm]
//   node scripts/package-platform.mjs --all --addons build/addons [--out build/npm]
//
// The first form stages one target from an addon file (defaults: this machine,
// the addon that `build:native` wrote). The second stages every supported target
// from <addons>/qpdf_node.<target>.node, the files `stage-addon.mjs` produces, and
// fails if any is missing.
//
// Output: <out>/qpdf-node-<target>/ with package.json (os, cpu and, on Linux,
// libc fields so npm installs it only where it can run), qpdf_node.node, LICENSE,
// THIRD_PARTY_NOTICES.md and README.md. Publish it with `npm publish <dir>`.

import { copyFileSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import {
  currentTarget,
  findPlatform,
  packageDirectory,
  platforms,
  readSourceManifest,
  repositoryField,
  repositoryRoot,
} from "./release-lib.mjs";

const { values } = parseArgs({
  options: {
    target: { type: "string" },
    addon: { type: "string" },
    addons: { type: "string" },
    all: { type: "boolean", default: false },
    out: { type: "string" },
  },
});

const outputRoot = resolve(values.out ?? join(repositoryRoot, "build", "npm"));
const source = readSourceManifest();

function isFile(path) {
  return statSync(path, { throwIfNoEntry: false })?.isFile() === true;
}

function stagePlatformPackage(platform, addonPath) {
  if (!isFile(addonPath)) {
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
    keywords: source.keywords,
    license: source.license,
    homepage: source.homepage,
    bugs: source.bugs,
    repository: repositoryField() ?? source.repository,
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
}

if (values.all) {
  if (values.addons === undefined) {
    throw new Error("--all needs --addons <directory holding qpdf_node.<target>.node files>");
  }
  const addonsDirectory = resolve(values.addons);
  const missing = platforms
    .filter((platform) => !isFile(join(addonsDirectory, platform.addonFileName)))
    .map((platform) => platform.addonFileName);
  if (missing.length > 0) {
    throw new Error(
      `Addons are missing; every supported platform must be built first. missing=${missing.join(",")}, addons=${addonsDirectory}`,
    );
  }
  for (const platform of platforms) {
    stagePlatformPackage(platform, join(addonsDirectory, platform.addonFileName));
  }
} else {
  const platform = findPlatform(values.target ?? currentTarget());
  const addonPath =
    values.addon !== undefined
      ? resolve(values.addon)
      : values.addons !== undefined
        ? join(resolve(values.addons), platform.addonFileName)
        : join(packageDirectory, "build", "Release", "qpdf_node.node");
  stagePlatformPackage(platform, addonPath);
}
