// Publishes the staged packages: every platform package first, the root
// package last, so a user can never install a root package whose optional
// dependencies are not yet on the registry.
//
//   node scripts/publish-packages.mjs --dir build/npm [--dry-run]
//
// Re-runnable: a package@version that is already on the registry is skipped.
// Authentication comes from the environment (NODE_AUTH_TOKEN written by
// actions/setup-node, or npm trusted publishing); this script never reads or
// prints credentials. A version with a prerelease suffix is published under the
// "next" dist-tag instead of "latest".

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { platforms } from "./release-lib.mjs";

const { values } = parseArgs({
  options: { dir: { type: "string" }, "dry-run": { type: "boolean", default: false } },
});
const stagingDirectory = resolve(values.dir ?? join("build", "npm"));
const dryRun = values["dry-run"];

const packageNames = [...platforms.map((platform) => platform.name), "qpdf-node"];

function npm(args, options = {}) {
  return spawnSync("npm", args, {
    encoding: "utf8",
    shell: process.platform === "win32",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
}

function isPublished(name, version) {
  const result = npm(["view", `${name}@${version}`, "version", "--json"]);
  if (result.status === 0) {
    return result.stdout.trim() !== "";
  }
  if (/E404|code E404|404 Not Found/.test(result.stderr + result.stdout)) {
    return false;
  }
  throw new Error(
    `Could not query the registry. package=${name}@${version}, exit=${result.status}`,
  );
}

const manifests = packageNames.map((name) => {
  const directory = join(stagingDirectory, name);
  const manifestPath = join(directory, "package.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`Staged package is missing. package=${name}, expected=${manifestPath}`);
  }
  return { name, directory, manifest: JSON.parse(readFileSync(manifestPath, "utf8")) };
});

const versions = new Set(manifests.map(({ manifest }) => manifest.version));
if (versions.size !== 1) {
  throw new Error(`Staged packages disagree on the version. versions=${[...versions].join(",")}`);
}
const [version] = versions;
const distributionTag = version.includes("-") ? "next" : "latest";

const rootManifest = manifests.at(-1).manifest;
for (const platform of platforms) {
  if (rootManifest.optionalDependencies?.[platform.name] !== version) {
    throw new Error(
      `The root package does not depend on ${platform.name}@${version}. found=${rootManifest.optionalDependencies?.[platform.name]}`,
    );
  }
}

for (const { name, directory } of manifests) {
  if (!dryRun && isPublished(name, version)) {
    console.log(`Skipping ${name}@${version}: already published.`);
    continue;
  }
  const args = ["publish", directory, "--access", "public", "--tag", distributionTag];
  if (dryRun) {
    args.push("--dry-run");
  } else if (process.env.GITHUB_ACTIONS === "true") {
    args.push("--provenance");
  }
  console.log(
    `${dryRun ? "Dry-run publishing" : "Publishing"} ${name}@${version} (tag ${distributionTag})`,
  );
  // stdout/stderr go to the log; npm does not print the auth token.
  execFileSync("npm", args, { stdio: "inherit", shell: process.platform === "win32" });
}
