// Runs the WebAssembly module under Node.js:
//   node native/wasm/smoke-test.mjs build/wasm/qpdf-core.mjs
// It exercises the in-memory workflow (open bytes, extract [3, 1, 2], errors,
// close) and exits non-zero on any failure.
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const modulePath = process.argv[2];
assert.ok(modulePath, "usage: node smoke-test.mjs <path to qpdf-core.mjs>");
const { default: createQpdfCore } = await import(pathToFileURL(resolve(modulePath)).href);
const core = await createQpdfCore();

function pdfWithMarkers(markers) {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${markers.map((_, i) => `${4 + i * 2} 0 R`).join(" ")}] /Count ${markers.length} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  markers.forEach((marker, i) => {
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`,
    );
    const content = `BT /F1 12 Tf 20 100 Td (${marker}) Tj ET`;
    objects.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  });
  let body = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((object, i) => {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(body, "latin1"));
}

function markersIn(bytes, candidates) {
  const text = Buffer.from(bytes).toString("latin1");
  return candidates
    .map((marker) => ({ marker, at: text.indexOf(`(${marker})`) }))
    .filter((found) => found.at >= 0)
    .sort((a, b) => a.at - b.at)
    .map((found) => found.marker);
}

function errorFrom(work) {
  try {
    work();
  } catch (error) {
    return error;
  }
  return assert.fail("expected an error");
}

const all = ["A1", "A2", "A3", "A4"];
const document = core.openPdf(pdfWithMarkers(all));
assert.equal(document.pageCount, 4);

const output = document.extract([3, 1, 2]);
assert.ok(output instanceof Uint8Array);
assert.equal(Buffer.from(output).subarray(0, 5).toString("latin1"), "%PDF-");
assert.deepEqual(markersIn(output, all), ["A3", "A1", "A2"]);
const reopened = core.openPdf(output);
assert.equal(reopened.pageCount, 3);
reopened.close();

for (const pages of [[], [0], [5], [1, 1], [1.5], "1"]) {
  const error = errorFrom(() => document.extract(pages));
  assert.ok(error instanceof Error, JSON.stringify(pages));
  assert.equal(error.code, "INVALID_ARGUMENT", JSON.stringify(pages));
}
const notPdf = errorFrom(() => core.openPdf(new Uint8Array(Buffer.from("not a pdf"))));
assert.equal(notPdf.code, "OPERATION_FAILED");

document.close();
document.close();
assert.equal(errorFrom(() => document.extract([1])).code, "INVALID_ARGUMENT");
console.log(`qpdf ${core.qpdfVersion()} WebAssembly smoke test passed`);
