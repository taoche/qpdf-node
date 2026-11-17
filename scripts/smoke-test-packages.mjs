// Packs the staged root package and one staged platform package, checks both
// tarballs' contents, installs them the way a user's npm would (into an empty
// project with no build/Release) and runs a small PDF operation. It proves the
// root package declares the platform packages, that the platform package for this
// machine carries the addon, and that the loader loads that addon from it:
//
//   node scripts/smoke-test-packages.mjs --root build/npm/qpdf-node \
//     --platform build/npm/qpdf-node-darwin-arm64
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { currentTarget, findPlatform, platforms } from "./release-lib.mjs";

const { values } = parseArgs({
  options: { root: { type: "string" }, platform: { type: "string" } },
});
assert.ok(
  values.root && values.platform,
  "usage: smoke-test-packages.mjs --root <dir> --platform <dir>",
);

// npm is a .cmd shim on Windows, which execFile cannot start without a shell.
function npm(args, cwd) {
  return execFileSync("npm", args, {
    cwd,
    encoding: "utf8",
    shell: process.platform === "win32",
    stdio: ["ignore", "pipe", "inherit"],
  });
}

/** Packs `directory` and returns the tarball path and the `npm pack --json` entry. */
function pack(directory, tarballDirectory, cwd) {
  const [packed] = JSON.parse(
    npm(["pack", resolve(directory), "--pack-destination", tarballDirectory, "--json"], cwd),
  );
  return { tarball: join(tarballDirectory, packed.filename), packed };
}

function assertContains(packed, requiredPaths) {
  const packedPaths = packed.files.map((file) => file.path);
  for (const path of requiredPaths) {
    assert.ok(
      packedPaths.includes(path),
      `the ${packed.name} tarball lacks ${path}. files=${packedPaths.join(",")}`,
    );
  }
  return packedPaths;
}

function describeSize(packed) {
  return (
    `Tarball ${packed.filename}: ${packed.files.length} files, ` +
    `${(packed.size / 1e3).toFixed(0)} kB compressed, ${(packed.unpackedSize / 1e3).toFixed(0)} kB unpacked`
  );
}

const expectedPlatform = findPlatform(currentTarget());
const platformManifest = JSON.parse(
  readFileSync(join(resolve(values.platform), "package.json"), "utf8"),
);
assert.equal(
  platformManifest.name,
  expectedPlatform.name,
  `--platform must be the package for this machine (${expectedPlatform.target})`,
);
const rootManifest = JSON.parse(readFileSync(join(resolve(values.root), "package.json"), "utf8"));
assert.equal(rootManifest.name, "qpdf-node");
assert.equal(platformManifest.version, rootManifest.version, "root and platform versions differ");
for (const platform of platforms) {
  assert.equal(
    rootManifest.optionalDependencies?.[platform.name],
    rootManifest.version,
    `the root package must depend on ${platform.name}@${rootManifest.version}`,
  );
}
assert.equal(rootManifest.dependencies, undefined, "the root package has no hard dependencies");

const workDirectory = mkdtempSync(join(tmpdir(), "qpdf-node-smoke-"));
try {
  const tarballDirectory = join(workDirectory, "tarballs");
  const project = join(workDirectory, "project");
  mkdirSync(tarballDirectory);
  mkdirSync(project);

  const root = pack(values.root, tarballDirectory, workDirectory);
  const rootPaths = assertContains(root.packed, [
    "package.json",
    "README.md",
    "LICENSE",
    "THIRD_PARTY_NOTICES.md",
    "dist/index.js",
    "dist/index.d.ts",
    "dist/native-loader.js",
  ]);
  assert.deepEqual(
    rootPaths.filter((path) => path.endsWith(".node")),
    [],
    "the root package must not contain an addon",
  );
  const platformPackage = pack(values.platform, tarballDirectory, workDirectory);
  const platformPaths = assertContains(platformPackage.packed, [
    "package.json",
    "README.md",
    "LICENSE",
    "THIRD_PARTY_NOTICES.md",
    "qpdf_node.node",
  ]);
  assert.deepEqual(
    platformPaths.filter((path) => path.endsWith(".node")),
    ["qpdf_node.node"],
    "a platform package holds exactly one addon",
  );
  console.log(describeSize(root.packed));
  console.log(describeSize(platformPackage.packed));

  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "smoke", private: true }));
  // The root tarball's optionalDependencies name registry packages that may not
  // be published yet, so the platform package is installed from its tarball and
  // the registry is not asked for the optional ones.
  npm(
    [
      "install",
      "--omit=optional",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      root.tarball,
      platformPackage.tarball,
    ],
    project,
  );

  const installedRoot = join(project, "node_modules", "qpdf-node");
  assert.ok(!existsSync(join(installedRoot, "build")), "the root package must not ship build/");
  assert.ok(!existsSync(join(installedRoot, "native")), "the root package must not ship native/");
  assert.deepEqual(
    readdirSync(join(project, "node_modules")).filter((name) => !name.startsWith(".")),
    ["qpdf-node", platformManifest.name].sort(),
    "only the root and the platform package are installed",
  );

  const script = `
    const assert = require("node:assert/strict");
    const Module = require("node:module");
    // Record every addon file Node.js loads.
    const loadedAddons = [];
    const loadAddon = Module._extensions[".node"];
    Module._extensions[".node"] = (module, filename) => {
      loadedAddons.push(filename);
      return loadAddon(module, filename);
    };
    const { openPdf, qpdfVersion } = require("qpdf-node");
    const objects = [
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] >>",
    ];
    let body = "%PDF-1.4\\n";
    const offsets = objects.map((object, index) => {
      const offset = body.length;
      body += (index + 1) + " 0 obj\\n" + object + "\\nendobj\\n";
      return offset;
    });
    const xref = body.length;
    body += "xref\\n0 " + (objects.length + 1) + "\\n0000000000 65535 f \\n";
    for (const offset of offsets) body += String(offset).padStart(10, "0") + " 00000 n \\n";
    body += "trailer\\n<< /Size " + (objects.length + 1) + " /Root 1 0 R >>\\nstartxref\\n" + xref + "\\n%%EOF\\n";
    (async () => {
      const pdf = await openPdf(Buffer.from(body, "latin1"));
      assert.equal(pdf.pageCount, 2);
      const extracted = await pdf.extract([2]);
      assert.ok(extracted.length > 0);
      await pdf.close();
      assert.equal(loadedAddons.length, 1, "expected exactly one addon to load: " + loadedAddons);
      console.log("qpdf " + qpdfVersion() + " loaded from " + loadedAddons[0]);
    })().catch((error) => { console.error(error); process.exit(1); });
  `;
  writeFileSync(join(project, "smoke.cjs"), script);
  const output = execFileSync(process.execPath, ["smoke.cjs"], { cwd: project, encoding: "utf8" });
  const expectedPath = join("node_modules", platformManifest.name, "qpdf_node.node");
  assert.ok(
    output.includes(expectedPath),
    `the addon was not loaded from ${expectedPath}. output=${output}`,
  );
  process.stdout.write(output);
} finally {
  rmSync(workDirectory, { recursive: true, force: true });
}
