import { strict as assert } from "node:assert";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { merge, mergeBytes, pageCount } from "../src/index";
import { rejectionOf } from "./helpers/assertions";
import {
  makeTempDirectory,
  markerOccurrences,
  markersInBytes,
  pdfWithInheritedPageAttributes,
  pdfWithMarkers,
} from "./helpers/pdf";

const directory = makeTempDirectory();
after(() => rmSync(directory, { recursive: true, force: true }));

const ALL_MARKERS = ["A1", "A2", "A3", "B1", "B2"];

async function pagesIn(bytes: Uint8Array): Promise<number> {
  const path = join(directory, `check-${Math.random().toString(36).slice(2)}.pdf`);
  writeFileSync(path, bytes);
  return pageCount({ input: path });
}

describe("mergeBytes", () => {
  it("concatenates whole inputs in order", async () => {
    const first = pdfWithMarkers(["A1", "A2", "A3"]);
    const second = pdfWithMarkers(["B1", "B2"]);

    const merged = await mergeBytes({ inputs: [first, { bytes: second }] });

    assert.ok(merged instanceof Uint8Array);
    assert.equal(await pagesIn(merged), 5);
    assert.deepEqual(markersInBytes(merged, ALL_MARKERS), ALL_MARKERS);
    const text = Buffer.from(merged).toString("latin1");
    assert.ok(text.startsWith("%PDF-"));
    assert.ok(!text.includes("/Encrypt"));
  });

  it("selects pages per input with the same range syntax as merge", async () => {
    const first = pdfWithMarkers(["A1", "A2", "A3"]);
    const second = pdfWithMarkers(["B1", "B2"]);

    const merged = await mergeBytes({
      inputs: [
        { bytes: first, pages: "3,1" },
        { bytes: second, pages: "r1" },
      ],
    });

    assert.equal(await pagesIn(merged), 3);
    assert.deepEqual(markerOccurrences(merged), ["A3", "A1", "B2"]);
  });

  it("accepts one input and returns a copy of its pages", async () => {
    const merged = await mergeBytes({ inputs: [pdfWithMarkers(["A1", "A2"])] });

    assert.equal(await pagesIn(merged), 2);
  });

  it("merges the same bytes twice", async () => {
    const source = pdfWithMarkers(["A1", "A2"]);

    const merged = await mergeBytes({ inputs: [source, source] });

    assert.deepEqual(markerOccurrences(merged), ["A1", "A2", "A1", "A2"]);
  });

  it("keeps attributes a page inherits from its page tree", async () => {
    const merged = await mergeBytes({
      inputs: [pdfWithInheritedPageAttributes(["A1"]), pdfWithMarkers(["B1"])],
    });

    const text = Buffer.from(merged).toString("latin1");
    assert.match(text, /\[\s*0\s+0\s+300\s+400\s*\]/);
    assert.deepEqual(markerOccurrences(merged), ["A1", "B1"]);
  });

  it("does not read the input buffers after it resolves", async () => {
    const first = Buffer.from(pdfWithMarkers(["A1"]));
    const pending = mergeBytes({ inputs: [first, pdfWithMarkers(["B1"])] });
    first.fill(0);

    const merged = await pending;

    assert.deepEqual(markerOccurrences(merged), ["A1", "B1"]);
  });

  it("produces the same bytes as the path-based merge", async () => {
    const firstBytes = pdfWithMarkers(["A1", "A2", "A3"]);
    const secondBytes = pdfWithMarkers(["B1", "B2"]);
    const firstPath = join(directory, "eq-a.pdf");
    const secondPath = join(directory, "eq-b.pdf");
    const outputPath = join(directory, "eq-out.pdf");
    writeFileSync(firstPath, firstBytes);
    writeFileSync(secondPath, secondBytes);
    await merge({ inputs: [firstPath, { path: secondPath, pages: "2,1" }], output: outputPath });

    const merged = await mergeBytes({ inputs: [firstBytes, { bytes: secondBytes, pages: "2,1" }] });

    assert.deepEqual(Buffer.from(merged), readFileSync(outputPath));
  });

  describe("rejections", () => {
    it("rejects an empty inputs array with INVALID_ARGUMENT", async () => {
      const error = await rejectionOf(mergeBytes({ inputs: [] }));

      assert.equal(error.code, "INVALID_ARGUMENT");
      assert.match(error.message, /at least one input/);
    });

    it("rejects options that are not an object", async () => {
      const error = await rejectionOf(mergeBytes(undefined as never));

      assert.equal(error.code, "INVALID_ARGUMENT");
    });

    it("rejects an input that is not bytes, naming its index", async () => {
      const error = await rejectionOf(
        mergeBytes({ inputs: [pdfWithMarkers(["A1"]), "a.pdf" as never] }),
      );

      assert.equal(error.code, "INVALID_ARGUMENT");
      assert.match(error.message, /inputs\[1\]/);
    });

    it("rejects empty bytes, naming the index", async () => {
      const error = await rejectionOf(mergeBytes({ inputs: [new Uint8Array(0)] }));

      assert.equal(error.code, "INVALID_ARGUMENT");
      assert.match(error.message, /inputs\[0\]/);
    });

    it("rejects bytes that are not a PDF with OPERATION_FAILED, naming the index", async () => {
      const error = await rejectionOf(
        mergeBytes({ inputs: [pdfWithMarkers(["A1"]), Buffer.from("not a pdf at all")] }),
      );

      assert.equal(error.code, "OPERATION_FAILED");
      assert.match(error.message, /inputs\[1\]/);
    });

    it("rejects a malformed page range with INVALID_ARGUMENT", async () => {
      const error = await rejectionOf(
        mergeBytes({ inputs: [{ bytes: pdfWithMarkers(["A1"]), pages: "2-" }] }),
      );

      assert.equal(error.code, "INVALID_ARGUMENT");
      assert.match(error.message, /inputs\[0\]\.pages/);
    });

    it("rejects a page beyond the document with OPERATION_FAILED and reports the page count", async () => {
      const error = await rejectionOf(
        mergeBytes({ inputs: [{ bytes: pdfWithMarkers(["A1", "A2"]), pages: "3" }] }),
      );

      assert.equal(error.code, "OPERATION_FAILED");
      assert.match(error.message, /inputs\[0\]\.pages/);
    });
  });
});
