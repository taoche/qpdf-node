// Packs the staged qpdf-node package, checks the tarball's contents, installs the
// tarball the way a user would (into an empty project with no build/Release),
// and runs a small PDF operation. It proves that every platform's addon ships in
// the tarball and that the loader picks the bundled addon for this machine:
//
//   node scripts/smoke-test-package.mjs --package build/npm/qpdf-node
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

import {
  bundledAddonDirectoryName,
  currentTarget,
  findPlatform,
  platforms,
} from "./release-lib.mjs";

const { values } = parseArgs({ options: { package: { type: "string" } } });
assert.ok(values.package, "usage: smoke-test-package.mjs --package <staged qpdf-node dir>");

// npm is a .cmd shim on Windows, which execFile cannot start without a shell.
function npm(args, cwd) {
  return execFileSync("npm", args, {
    cwd,
    encoding: "utf8",
    shell: process.platform === "win32",
    stdio: ["ignore", "pipe", "inherit"],
  });
}

const expectedAddon = findPlatform(currentTarget()).addonFileName;
const workDirectory = mkdtempSync(join(tmpdir(), "qpdf-node-smoke-"));
try {
  const tarballDirectory = join(workDirectory, "tarballs");
  const project = join(workDirectory, "project");
  mkdirSync(tarballDirectory);
  mkdirSync(project);

  const [packed] = JSON.parse(
    npm(
      ["pack", resolve(values.package), "--pack-destination", tarballDirectory, "--json"],
      workDirectory,
    ),
  );
  const packedPaths = packed.files.map((file) => file.path);
  const requiredPaths = [
    "package.json",
    "README.md",
    "LICENSE",
    "THIRD_PARTY_NOTICES.md",
    "dist/index.js",
    "dist/index.d.ts",
    ...platforms.map((platform) => `${bundledAddonDirectoryName}/${platform.addonFileName}`),
  ];
  for (const path of requiredPaths) {
    assert.ok(
      packedPaths.includes(path),
      `the tarball lacks ${path}. files=${packedPaths.join(",")}`,
    );
  }
  const unexpected = packedPaths.filter(
    (path) => path.endsWith(".node") && !path.startsWith(`${bundledAddonDirectoryName}/`),
  );
  assert.deepEqual(unexpected, [], "addons outside the bundled directory");
  console.log(
    `Tarball ${packed.filename}: ${packed.files.length} files, ` +
      `${(packed.size / 1e6).toFixed(1)} MB compressed, ${(packed.unpackedSize / 1e6).toFixed(1)} MB unpacked`,
  );

  const [tarball] = readdirSync(tarballDirectory).map((name) => join(tarballDirectory, name));
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "smoke", private: true }));
  npm(["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball], project);

  const installed = join(project, "node_modules", "qpdf-node");
  assert.ok(!existsSync(join(installed, "build")), "the package must not ship a build directory");
  const installedManifest = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
  assert.equal(installedManifest.optionalDependencies, undefined, "no optionalDependencies");
  assert.equal(installedManifest.dependencies, undefined, "no dependencies");
  assert.deepEqual(
    readdirSync(join(project, "node_modules")).filter((name) => !name.startsWith(".")),
    ["qpdf-node"],
    "only qpdf-node is installed",
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
  const expectedPath = join("node_modules", "qpdf-node", bundledAddonDirectoryName, expectedAddon);
  assert.ok(
    output.includes(expectedPath),
    `the addon was not loaded from ${expectedPath}. output=${output}`,
  );
  process.stdout.write(output);
} finally {
  rmSync(workDirectory, { recursive: true, force: true });
}
