// Stages the one publishable package, qpdf-node: the compiled TypeScript plus
// every supported platform's addon.
//
//   pnpm --filter qpdf-node run build:ts
//   node scripts/stage-addon.mjs --target <T>      (on each platform; CI does this)
//   node scripts/package-root.mjs [--addons build/addons] [--out build/npm]
//
// <addons> must hold qpdf_node.<target>.node for every target in
// scripts/release-lib.mjs. The staged package.json differs from
// packages/node/package.json on purpose: it is not private, has no scripts or
// devDependencies, and lists what is shipped. It has no dependencies at all.
import { cpSync, copyFileSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import {
  bundledAddonDirectoryName,
  packageDirectory,
  platforms,
  readSourceManifest,
  repositoryField,
  repositoryRoot,
} from "./release-lib.mjs";

const { values } = parseArgs({ options: { out: { type: "string" }, addons: { type: "string" } } });
const outputRoot = resolve(values.out ?? join(repositoryRoot, "build", "npm"));
const addonsDirectory = resolve(values.addons ?? join(repositoryRoot, "build", "addons"));
const source = readSourceManifest();

const distribution = join(packageDirectory, "dist");
if (!statSync(join(distribution, "index.js"), { throwIfNoEntry: false })?.isFile()) {
  throw new Error(
    `The TypeScript build is missing; run \`pnpm --filter qpdf-node run build:ts\`. dist=${distribution}`,
  );
}

const missingAddons = platforms
  .filter(
    (platform) =>
      !statSync(join(addonsDirectory, platform.addonFileName), {
        throwIfNoEntry: false,
      })?.isFile(),
  )
  .map((platform) => platform.addonFileName);
if (missingAddons.length > 0) {
  throw new Error(
    `Addons are missing; every supported platform must be built first. missing=${missingAddons.join(",")}, addons=${addonsDirectory}`,
  );
}

const packageRoot = join(outputRoot, "qpdf-node");
rmSync(packageRoot, { recursive: true, force: true });
mkdirSync(join(packageRoot, bundledAddonDirectoryName), { recursive: true });
cpSync(distribution, join(packageRoot, "dist"), { recursive: true });
for (const platform of platforms) {
  copyFileSync(
    join(addonsDirectory, platform.addonFileName),
    join(packageRoot, bundledAddonDirectoryName, platform.addonFileName),
  );
}
for (const fileName of ["LICENSE", "THIRD_PARTY_NOTICES.md", "README.md"]) {
  copyFileSync(join(repositoryRoot, fileName), join(packageRoot, fileName));
}

const manifest = {
  name: source.name,
  version: source.version,
  description: source.description,
  keywords: source.keywords,
  license: source.license,
  homepage: source.homepage,
  bugs: source.bugs,
  repository: repositoryField() ?? source.repository,
  main: source.main,
  types: source.types,
  files: ["dist", bundledAddonDirectoryName, "LICENSE", "THIRD_PARTY_NOTICES.md", "README.md"],
  engines: source.engines,
};
writeFileSync(join(packageRoot, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(`Staged ${source.name}@${source.version} at ${packageRoot}`);
