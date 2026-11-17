// Publishes the staged qpdf-node package.
//
//   node scripts/publish-package.mjs --dir build/npm [--dry-run]
//
// Re-runnable: a version that is already on the registry is skipped.
// Authentication comes from the environment (NODE_AUTH_TOKEN written by
// actions/setup-node, or npm trusted publishing); this script never reads or
// prints credentials. A version with a prerelease suffix is published under the
// "next" dist-tag instead of "latest".
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: { dir: { type: "string" }, "dry-run": { type: "boolean", default: false } },
});
const stagingDirectory = resolve(values.dir ?? join("build", "npm"));
const dryRun = values["dry-run"];

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

const directory = join(stagingDirectory, "qpdf-node");
const manifestPath = join(directory, "package.json");
if (!existsSync(manifestPath)) {
  throw new Error(`Staged package is missing. package=qpdf-node, expected=${manifestPath}`);
}
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
if (manifest.name !== "qpdf-node") {
  throw new Error(`The staged package has an unexpected name. name=${manifest.name}`);
}
if (manifest.optionalDependencies !== undefined || manifest.dependencies !== undefined) {
  throw new Error("The staged package must not have dependencies: it bundles every addon.");
}
const { name, version } = manifest;
const distributionTag = version.includes("-") ? "next" : "latest";

if (!dryRun && isPublished(name, version)) {
  console.log(`Skipping ${name}@${version}: already published.`);
} else {
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
