// Installs the staged root package and one staged platform package the way a
// user would (from tarballs, into an empty project with no build/Release), then
// runs a small PDF operation. It proves the platform package is found and the
// addon loads from it:
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

const workDirectory = mkdtempSync(join(tmpdir(), "qpdf-node-smoke-"));
try {
  const tarballDirectory = join(workDirectory, "tarballs");
  const project = join(workDirectory, "project");
  mkdirSync(tarballDirectory);
  mkdirSync(project);

  for (const directory of [values.root, values.platform]) {
    npm(["pack", resolve(directory), "--pack-destination", tarballDirectory], workDirectory);
  }
  const tarballs = readdirSync(tarballDirectory).map((name) => join(tarballDirectory, name));
  assert.equal(tarballs.length, 2, `expected two tarballs. found=${tarballs.join(",")}`);

  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "smoke", private: true }));
  // The root tarball's optionalDependencies name registry packages that may not
  // be published yet; the platform tarball is installed explicitly instead.
  npm(
    ["install", "--omit=optional", "--ignore-scripts", "--no-audit", "--no-fund", ...tarballs],
    project,
  );

  assert.ok(
    !existsSync(join(project, "node_modules", "qpdf-node", "build")),
    "the root package must not ship a build directory",
  );

  const script = `
    const assert = require("node:assert/strict");
    const { openPdf, qpdfVersion } = require("qpdf-node");
    const platformPackage = require.resolve(process.argv[2]);
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
      console.log("qpdf " + qpdfVersion() + " loaded from " + platformPackage);
    })().catch((error) => { console.error(error); process.exit(1); });
  `;
  const platformName = JSON.parse(
    readFileSync(join(resolve(values.platform), "package.json"), "utf8"),
  ).name;
  writeFileSync(join(project, "smoke.cjs"), script);
  const output = execFileSync(process.execPath, ["smoke.cjs", platformName], {
    cwd: project,
    encoding: "utf8",
  });
  assert.ok(
    output.includes(join("node_modules", platformName)),
    `the addon was not loaded from the platform package. output=${output}`,
  );
  process.stdout.write(output);
} finally {
  rmSync(workDirectory, { recursive: true, force: true });
}
