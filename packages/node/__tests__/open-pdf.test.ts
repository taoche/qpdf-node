import { strict as assert } from "node:assert";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { openPdf, pageCount } from "../src/index";
import { rejectionOf } from "./helpers/assertions";
import { makeTempDirectory, markersInBytes, pdfWithMarkers } from "./helpers/pdf";

const ALL_MARKERS = ["A1", "A2", "A3", "A4", "A5"];

// openPdf creates its private directories under os.tmpdir(), so point that at a
// directory this file owns and the tests can see exactly what was left behind.
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

function openedDirectories(): string[] {
  return readdirSync(temporaryRoot);
}

function filesIn(directoryName: string): string[] {
  return readdirSync(join(temporaryRoot, directoryName));
}

function fivePagePdf(): Buffer {
  return pdfWithMarkers(ALL_MARKERS);
}

async function pagesIn(bytes: Uint8Array): Promise<number> {
  const path = join(scratch, `check-${Math.random().toString(36).slice(2)}.pdf`);
  writeFileSync(path, bytes);
  return pageCount({ input: path });
}

describe("openPdf", () => {
  it("opens a Buffer and reports its page count", async () => {
    const pdf = await openPdf(fivePagePdf());
    try {
      assert.equal(pdf.pageCount, 5);
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

  it("extracts pages in the caller's order as an unencrypted PDF", async () => {
    const pdf = await openPdf(fivePagePdf());
    try {
      const output = await pdf.extract([4, 1, 5]);

      assert.ok(output instanceof Uint8Array);
      assert.equal(Buffer.from(output).subarray(0, 5).toString("latin1"), "%PDF-");
      assert.ok(!Buffer.from(output).toString("latin1").includes("/Encrypt"));
      assert.deepEqual(markersInBytes(output, ALL_MARKERS), ["A4", "A1", "A5"]);
      assert.equal(await pagesIn(output), 3);
    } finally {
      await pdf.close();
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
      ]);

      assert.deepEqual(markersInBytes(first, ALL_MARKERS), ["A1"]);
      assert.deepEqual(markersInBytes(second, ALL_MARKERS), ["A5", "A4"]);
      assert.deepEqual(markersInBytes(concurrent[0], ALL_MARKERS), ["A2"]);
      assert.deepEqual(markersInBytes(concurrent[1], ALL_MARKERS), ["A3", "A2"]);
      assert.deepEqual(markersInBytes(concurrent[2], ALL_MARKERS), ["A5"]);
    } finally {
      await pdf.close();
    }
  });

  it("does not change the caller's input bytes or depend on them after opening", async () => {
    const input = fivePagePdf();
    const pdf = await openPdf(input);
    try {
      input.fill(0);

      const output = await pdf.extract([3]);

      assert.deepEqual(markersInBytes(output, ALL_MARKERS), ["A3"]);
    } finally {
      await pdf.close();
    }
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
    assert.deepEqual(openedDirectories(), []);
  });

  it("rejects bytes that are not a PDF with OPERATION_FAILED and leaves no files", async () => {
    const error = await rejectionOf(openPdf(Buffer.from("this is not a pdf")));

    assert.equal(error.code, "OPERATION_FAILED");
    assert.match(error.message, /openPdf could not read the input bytes\. byteLength=17/);
    assert.deepEqual(openedDirectories(), []);
  });

  it("rejects invalid pages with INVALID_ARGUMENT before writing any output", async () => {
    const pdf = await openPdf(fivePagePdf());
    try {
      const [directoryName] = openedDirectories();
      assert.ok(directoryName);
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
      assert.deepEqual(filesIn(directoryName), ["input.pdf"]);
    } finally {
      await pdf.close();
    }
  });

  it("leaves only the input file in its directory between extracts", async () => {
    const pdf = await openPdf(fivePagePdf());
    try {
      const [directoryName] = openedDirectories();
      assert.ok(directoryName);
      assert.deepEqual(filesIn(directoryName), ["input.pdf"]);

      await pdf.extract([1, 2]);
      await Promise.all([pdf.extract([3]), pdf.extract([4])]);

      assert.deepEqual(filesIn(directoryName), ["input.pdf"]);
    } finally {
      await pdf.close();
    }
    assert.deepEqual(openedDirectories(), []);
  });

  it("close is idempotent and extract after close rejects", async () => {
    const pdf = await openPdf(fivePagePdf());
    assert.equal(openedDirectories().length, 1);

    await pdf.close();
    await pdf.close();
    await Promise.all([pdf.close(), pdf.close()]);

    assert.deepEqual(openedDirectories(), []);
    const error = await rejectionOf(pdf.extract([1]));
    assert.equal(error.code, "INVALID_ARGUMENT");
    assert.match(error.message, /closed/);
    assert.equal(pdf.pageCount, 5);
  });

  it("close waits for extractions already in progress", async () => {
    const pdf = await openPdf(fivePagePdf());

    const extraction = pdf.extract([5, 4, 3]);
    await pdf.close();
    const output = await extraction;

    assert.deepEqual(markersInBytes(output, ALL_MARKERS), ["A5", "A4", "A3"]);
    assert.deepEqual(openedDirectories(), []);
  });

  it("keeps separate opened PDFs independent", async () => {
    const first = await openPdf(pdfWithMarkers(["A1", "A2"]));
    const second = await openPdf(pdfWithMarkers(["A1", "A2", "A3"]));
    try {
      assert.equal(openedDirectories().length, 2);
      await first.close();
      assert.equal(openedDirectories().length, 1);

      const output = await second.extract([3, 1]);

      assert.deepEqual(markersInBytes(output, ALL_MARKERS), ["A3", "A1"]);
    } finally {
      await first.close();
      await second.close();
    }
  });

  it("creates its directory under the system temporary directory", async () => {
    const pdf = await openPdf(fivePagePdf());
    try {
      assert.equal(tmpdir(), temporaryRoot);
      const [directoryName] = openedDirectories();
      assert.match(directoryName ?? "", /^pdq-node-/);
      assert.equal(
        readFileSync(join(temporaryRoot, directoryName ?? "", "input.pdf")).length,
        fivePagePdf().length,
      );
    } finally {
      await pdf.close();
    }
  });
});
