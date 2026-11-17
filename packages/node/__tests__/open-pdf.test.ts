import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { openPdf, pageCount } from "../src/index";
import { rejectionOf } from "./helpers/assertions";
import {
  makeTempDirectory,
  markersInBytes,
  pdfWithInheritedPageAttributes,
  pdfWithLinkToLaterPage,
  pdfWithMarkers,
} from "./helpers/pdf";

const ALL_MARKERS = ["A1", "A2", "A3", "A4", "A5"];

// The handle is in-memory. Point the temporary directory at one this file owns
// so the tests can prove that opening and extracting write nothing to it.
const originalTemporaryDirectory = {
  TMPDIR: process.env.TMPDIR,
  TEMP: process.env.TEMP,
  TMP: process.env.TMP,
};
const scratch = makeTempDirectory();
const temporaryRoot = join(scratch, "tmp-root");

before(() => {
  mkdirSync(temporaryRoot);
  process.env.TMPDIR = temporaryRoot;
  process.env.TEMP = temporaryRoot;
  process.env.TMP = temporaryRoot;
});

after(() => {
  for (const [name, value] of Object.entries(originalTemporaryDirectory)) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
  rmSync(scratch, { recursive: true, force: true });
});

function fivePagePdf(): Buffer {
  return pdfWithMarkers(ALL_MARKERS);
}

async function pagesIn(bytes: Uint8Array): Promise<number> {
  const path = join(scratch, `check-${Math.random().toString(36).slice(2)}.pdf`);
  writeFileSync(path, bytes);
  return pageCount({ input: path });
}

/** `qpdf --check`, when a qpdf executable happens to be installed; the addon is the main oracle. */
function checkWithQpdfExecutable(bytes: Uint8Array): void {
  if (spawnSync("qpdf", ["--version"]).error !== undefined) {
    return;
  }
  const path = join(scratch, `qpdf-check-${Math.random().toString(36).slice(2)}.pdf`);
  writeFileSync(path, bytes);
  const result = spawnSync("qpdf", ["--check", path], { encoding: "utf8" });
  assert.equal(result.status, 0, `qpdf --check failed: ${result.stdout}${result.stderr}`);
}

describe("openPdf", () => {
  it("extracts pages [3, 1, 2] from bytes in caller order (the PR-shaped workflow)", async () => {
    const input = pdfWithMarkers(["A1", "A2", "A3", "A4"]);
    const pdf = await openPdf(input);
    try {
      assert.equal(pdf.pageCount, 4);

      const output = await pdf.extract([3, 1, 2]);

      assert.ok(output instanceof Uint8Array);
      assert.equal(Buffer.from(output).subarray(0, 5).toString("latin1"), "%PDF-");
      assert.ok(!Buffer.from(output).toString("latin1").includes("/Encrypt"));
      assert.deepEqual(markersInBytes(output, ALL_MARKERS), ["A3", "A1", "A2"]);
      assert.equal(await pagesIn(output), 3);
      checkWithQpdfExecutable(output);

      const reopened = await openPdf(output);
      try {
        assert.equal(reopened.pageCount, 3);
        assert.deepEqual(markersInBytes(await reopened.extract([1]), ALL_MARKERS), ["A3"]);
        assert.deepEqual(markersInBytes(await reopened.extract([3]), ALL_MARKERS), ["A2"]);
      } finally {
        await reopened.close();
      }
    } finally {
      await pdf.close();
    }
  });

  it("extracts a single page that stays complete", async () => {
    const pdf = await openPdf(fivePagePdf());
    try {
      const output = await pdf.extract([4]);
      const text = Buffer.from(output).toString("latin1");

      assert.deepEqual(markersInBytes(output, ALL_MARKERS), ["A4"]);
      assert.equal(await pagesIn(output), 1);
      // The page's own content, font, and size travel with it.
      assert.match(text, /\/BaseFont \/Helvetica/);
      assert.match(text, /\/MediaBox \[ ?0 0 200 200 ?\]/);
      assert.match(text, /BT \/F1 12 Tf 20 100 Td \(A4\) Tj ET/);
      checkWithQpdfExecutable(output);
    } finally {
      await pdf.close();
    }
  });

  it("copies resources and sizes a page inherits from the page tree", async () => {
    const pdf = await openPdf(pdfWithInheritedPageAttributes(["A1", "A2", "A3"]));
    try {
      const output = await pdf.extract([2]);
      const text = Buffer.from(output).toString("latin1");

      assert.deepEqual(markersInBytes(output, ALL_MARKERS), ["A2"]);
      assert.match(text, /\/MediaBox/);
      assert.match(text, /\[ ?0 0 300 400 ?\]/);
      assert.match(text, /\/BaseFont \/Helvetica/);
      assert.match(text, /\/F1 /);
      checkWithQpdfExecutable(output);
    } finally {
      await pdf.close();
    }
  });

  it("keeps a link annotation but does not pull in the page it points to", async () => {
    const pdf = await openPdf(pdfWithLinkToLaterPage());
    try {
      const output = await pdf.extract([1]);
      const text = Buffer.from(output).toString("latin1");

      assert.equal(await pagesIn(output), 1);
      assert.deepEqual(markersInBytes(output, ["L1", "L2", "L3"]), ["L1"]);
      assert.match(text, /\/Subtype \/Link/);
      checkWithQpdfExecutable(output);
    } finally {
      await pdf.close();
    }
  });

  it("produces identical bytes for identical requests", async () => {
    const pdf = await openPdf(fivePagePdf());
    try {
      const first = await pdf.extract([5, 2]);
      const second = await pdf.extract([5, 2]);

      assert.deepEqual(Buffer.from(first), Buffer.from(second));
    } finally {
      await pdf.close();
    }
  });

  it("accepts a plain Uint8Array and a view into a larger buffer", async () => {
    const bytes = fivePagePdf();
    const plain = new Uint8Array(bytes);
    const padded = Buffer.concat([Buffer.from("junk"), bytes]);
    const view = new Uint8Array(padded.buffer, padded.byteOffset + 4, bytes.length);

    for (const input of [plain, view]) {
      const pdf = await openPdf(input);
      try {
        assert.equal(pdf.pageCount, 5);
        const output = await pdf.extract([2]);
        assert.deepEqual(markersInBytes(output, ALL_MARKERS), ["A2"]);
      } finally {
        await pdf.close();
      }
    }
  });

  it("supports many extracts, sequential and concurrent, from one opened PDF", async () => {
    const pdf = await openPdf(fivePagePdf());
    try {
      const first = await pdf.extract([1]);
      const second = await pdf.extract([5, 4]);
      const concurrent = await Promise.all([
        pdf.extract([2]),
        pdf.extract([3, 2]),
        pdf.extract([5]),
        pdf.extract([4, 3, 2, 1]),
        pdf.extract([1, 5]),
      ]);

      assert.deepEqual(markersInBytes(first, ALL_MARKERS), ["A1"]);
      assert.deepEqual(markersInBytes(second, ALL_MARKERS), ["A5", "A4"]);
      assert.deepEqual(markersInBytes(concurrent[0] as Uint8Array, ALL_MARKERS), ["A2"]);
      assert.deepEqual(markersInBytes(concurrent[1] as Uint8Array, ALL_MARKERS), ["A3", "A2"]);
      assert.deepEqual(markersInBytes(concurrent[2] as Uint8Array, ALL_MARKERS), ["A5"]);
      assert.deepEqual(markersInBytes(concurrent[3] as Uint8Array, ALL_MARKERS), [
        "A4",
        "A3",
        "A2",
        "A1",
      ]);
      assert.deepEqual(markersInBytes(concurrent[4] as Uint8Array, ALL_MARKERS), ["A1", "A5"]);
    } finally {
      await pdf.close();
    }
  });

  it("handles a larger document and many concurrent extracts", async () => {
    const markers = Array.from({ length: 300 }, (_, index) => `P${index + 1}`);
    const pdf = await openPdf(pdfWithMarkers(markers));
    try {
      assert.equal(pdf.pageCount, 300);
      const outputs = await Promise.all(
        Array.from({ length: 40 }, (_, index) => pdf.extract([300 - index, index + 1])),
      );

      outputs.forEach((output, index) => {
        assert.deepEqual(markersInBytes(output, markers), [`P${300 - index}`, `P${index + 1}`]);
      });
    } finally {
      await pdf.close();
    }
  });

  it("extracts without blocking the event loop", async () => {
    const markers = Array.from({ length: 2000 }, (_, index) => `P${index + 1}`);
    const pdf = await openPdf(pdfWithMarkers(markers));
    try {
      const promise = pdf.extract(markers.map((_, index) => index + 1));
      let immediateRanBeforeSettling = false;
      setImmediate(() => {
        immediateRanBeforeSettling = true;
      });
      const output = await promise;

      assert.equal(immediateRanBeforeSettling, true);
      assert.equal(await pagesIn(output), 2000);
    } finally {
      await pdf.close();
    }
  });

  it("does not change the caller's input bytes or depend on them after opening", async () => {
    const input = fivePagePdf();
    const snapshot = Buffer.from(input);
    const pdf = await openPdf(input);
    try {
      assert.deepEqual(input, snapshot);
      input.fill(0);

      const output = await pdf.extract([3]);

      assert.deepEqual(markersInBytes(output, ALL_MARKERS), ["A3"]);
    } finally {
      await pdf.close();
    }
  });

  it("writes nothing to the temporary directory", async () => {
    const pdf = await openPdf(fivePagePdf());
    try {
      await pdf.extract([1, 2]);
      await Promise.all([pdf.extract([3]), pdf.extract([4])]);

      assert.deepEqual(readdirSync(temporaryRoot), []);
    } finally {
      await pdf.close();
    }
    assert.deepEqual(readdirSync(temporaryRoot), []);
  });

  it("rejects input that is not a non-empty Uint8Array with INVALID_ARGUMENT", async () => {
    const cases: Array<[string, unknown, RegExp]> = [
      ["string", "%PDF-1.4", /must be a Uint8Array or Buffer. received=string/],
      ["undefined", undefined, /received=undefined/],
      ["null", null, /received=null/],
      ["number array", [37, 80, 68, 70], /received=array/],
      ["ArrayBuffer", new ArrayBuffer(8), /received=object/],
      ["empty Uint8Array", new Uint8Array(0), /must not be empty/],
      ["empty Buffer", Buffer.alloc(0), /must not be empty/],
    ];

    for (const [name, input, message] of cases) {
      const error = await rejectionOf(openPdf(input as never));
      assert.equal(error.code, "INVALID_ARGUMENT", name);
      assert.match(error.message, message, name);
    }
  });

  it("rejects bytes that are not a PDF with OPERATION_FAILED", async () => {
    const error = await rejectionOf(openPdf(Buffer.from("this is not a pdf")));

    assert.equal(error.code, "OPERATION_FAILED");
    assert.match(error.message, /openPdf could not read the input bytes\. byteLength=17/);
  });

  it("repairs a PDF whose cross-reference offset is wrong", async () => {
    const damaged = Buffer.from(
      fivePagePdf()
        .toString("latin1")
        .replace(/startxref\n\d+/, "startxref\n999999"),
      "latin1",
    );

    const pdf = await openPdf(damaged);
    try {
      assert.equal(pdf.pageCount, 5);
      assert.deepEqual(markersInBytes(await pdf.extract([2, 4]), ALL_MARKERS), ["A2", "A4"]);
    } finally {
      await pdf.close();
    }
  });

  it("rejects a truncated PDF that cannot be repaired with OPERATION_FAILED", async () => {
    const error = await rejectionOf(openPdf(fivePagePdf().subarray(0, 60)));

    assert.equal(error.code, "OPERATION_FAILED");
  });

  it("rejects invalid pages with INVALID_ARGUMENT", async () => {
    const pdf = await openPdf(fivePagePdf());
    try {
      const cases: Array<[string, unknown, RegExp]> = [
        ["not an array", 1, /extract pages must be an array/],
        ["empty", [], /extract pages must not be empty/],
        ["zero", [0], /pages\[0\] must be an integer between 1 and 5. received=0/],
        ["negative", [1, -2], /pages\[1\] .* received=-2/],
        ["fraction", [1.5], /received=1.5/],
        ["NaN", [Number.NaN], /received=NaN/],
        ["Infinity", [Number.POSITIVE_INFINITY], /received=Infinity/],
        ["string", ["1"], /received=1/],
        ["past the last page", [1, 6], /pages\[1\] .* received=6/],
        ["repeated page", [2, 3, 2], /must not repeat a page. pages\[2\]=2/],
      ];

      for (const [name, pages, message] of cases) {
        const error = await rejectionOf(pdf.extract(pages as never));
        assert.equal(error.code, "INVALID_ARGUMENT", name);
        assert.match(error.message, message, name);
      }
      // The handle is still usable after rejected requests.
      assert.deepEqual(markersInBytes(await pdf.extract([5]), ALL_MARKERS), ["A5"]);
    } finally {
      await pdf.close();
    }
  });

  it("close is idempotent and extract after close rejects", async () => {
    const pdf = await openPdf(fivePagePdf());

    await pdf.close();
    await pdf.close();
    await Promise.all([pdf.close(), pdf.close()]);

    const error = await rejectionOf(pdf.extract([1]));
    assert.equal(error.code, "INVALID_ARGUMENT");
    assert.match(error.message, /closed/);
    assert.equal(pdf.pageCount, 5);
  });

  it("close waits for extractions already in progress, which still complete", async () => {
    const pdf = await openPdf(fivePagePdf());

    const extraction = pdf.extract([5, 4, 3]);
    await pdf.close();
    const output = await extraction;

    assert.deepEqual(markersInBytes(output, ALL_MARKERS), ["A5", "A4", "A3"]);
  });

  it("keeps separate opened PDFs independent", async () => {
    const first = await openPdf(pdfWithMarkers(["A1", "A2"]));
    const second = await openPdf(pdfWithMarkers(["A1", "A2", "A3"]));
    try {
      await first.close();

      const output = await second.extract([3, 1]);

      assert.deepEqual(markersInBytes(output, ALL_MARKERS), ["A3", "A1"]);
    } finally {
      await first.close();
      await second.close();
    }
  });
});
