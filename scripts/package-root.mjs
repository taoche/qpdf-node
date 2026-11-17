// Stages the publishable root package, qpdf-node, from the compiled TypeScript:
//
//   pnpm --filter qpdf-node run build:ts
//   node scripts/package-root.mjs [--out build/npm]
//
// The staged package.json differs from packages/node/package.json on purpose:
// it lists every platform package as an optionalDependency at the same exact
// version (they do not exist on the registry until a release publishes them, so
// the workspace manifest cannot list them), and drops scripts and
// devDependencies. The root package contains no binary: npm picks the one
// platform package whose os, cpu and libc match the machine.

import { cpSync, copyFileSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import {
  packageDirectory,
  platforms,
  readSourceManifest,
  repositoryField,
  repositoryRoot,
} from "./release-lib.mjs";

const { values } = parseArgs({ options: { out: { type: "string" } } });
const outputRoot = resolve(values.out ?? join(repositoryRoot, "build", "npm"));
const source = readSourceManifest();

const distribution = join(packageDirectory, "dist");
if (!statSync(join(distribution, "index.js"), { throwIfNoEntry: false })?.isFile()) {
  throw new Error(
    `The TypeScript build is missing; run \`pnpm --filter qpdf-node run build:ts\`. dist=${distribution}`,
  );
}

const packageRoot = join(outputRoot, "qpdf-node");
rmSync(packageRoot, { recursive: true, force: true });
mkdirSync(packageRoot, { recursive: true });
cpSync(distribution, join(packageRoot, "dist"), { recursive: true });
for (const fileName of ["LICENSE", "THIRD_PARTY_NOTICES.md", "README.md"]) {
  copyFileSync(join(repositoryRoot, fileName), join(packageRoot, fileName));
}

const optionalDependencies = {};
for (const platform of platforms) {
  optionalDependencies[platform.name] = source.version;
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
  files: ["dist", "LICENSE", "THIRD_PARTY_NOTICES.md", "README.md"],
  engines: source.engines,
  optionalDependencies,
};
writeFileSync(join(packageRoot, "package.json"), JSON.stringify(manifest, null, 2) + "\n");

console.log(`Staged ${source.name}@${source.version} at ${packageRoot}`);
