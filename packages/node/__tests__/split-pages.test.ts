import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { pageCount, splitPages } from "../src/index";
import { rejectionOf } from "./helpers/assertions";
import { makeTempDirectory, markersIn, writePdf } from "./helpers/pdf";

const directory = makeTempDirectory();
after(() => rmSync(directory, { recursive: true, force: true }));

function makeOutputDirectory(name: string): string {
  const path = join(directory, name);
  mkdirSync(path);
  return path;
}

describe("splitPages", () => {
  it("writes one file per page", async () => {
    const input = writePdf(directory, "in.pdf", ["P1", "P2", "P3"]);
    const outputs = makeOutputDirectory("one-per-page");

    const result = await splitPages({ input, outputPattern: join(outputs, "page-%d.pdf") });

    assert.equal(result, undefined);
    assert.deepEqual(readdirSync(outputs).sort(), ["page-1.pdf", "page-2.pdf", "page-3.pdf"]);
    for (const [index, marker] of ["P1", "P2", "P3"].entries()) {
      const output = join(outputs, `page-${index + 1}.pdf`);
      assert.deepEqual(markersIn(output, ["P1", "P2", "P3"]), [marker]);
      assert.equal(await pageCount({ input: output }), 1);
    }
  });

  it("zero-pads page numbers to the width of the last page number", async () => {
    const markers = Array.from({ length: 10 }, (_, index) => `P${index + 1}`);
    const input = writePdf(directory, "ten.pdf", markers);
    const outputs = makeOutputDirectory("padded");

    await splitPages({ input, outputPattern: join(outputs, "p%d.pdf") });

    const names = readdirSync(outputs).sort();
    assert.equal(names.length, 10);
    assert.equal(names[0], "p01.pdf");
    assert.equal(names[9], "p10.pdf");
  });

  it("groups pages into chunks", async () => {
    const input = writePdf(directory, "five.pdf", ["P1", "P2", "P3", "P4", "P5"]);
    const outputs = makeOutputDirectory("chunks");

    await splitPages({ input, outputPattern: join(outputs, "chunk-%d.pdf"), pagesPerFile: 2 });

    assert.deepEqual(readdirSync(outputs).sort(), ["chunk-1.pdf", "chunk-2.pdf", "chunk-3.pdf"]);
    assert.equal(await pageCount({ input: join(outputs, "chunk-1.pdf") }), 2);
    assert.equal(await pageCount({ input: join(outputs, "chunk-3.pdf") }), 1);
    assert.deepEqual(markersIn(join(outputs, "chunk-2.pdf"), ["P1", "P2", "P3", "P4", "P5"]), [
      "P3",
      "P4",
    ]);
  });

  it("does its work off the calling stack", async () => {
    const markers = Array.from({ length: 2000 }, (_, index) => `P${index}`);
    const input = writePdf(directory, "many.pdf", markers);
    const outputs = makeOutputDirectory("many");

    const promise = splitPages({
      input,
      outputPattern: join(outputs, "p%d.pdf"),
      pagesPerFile: 500,
    });
    const wroteSynchronously = readdirSync(outputs).length > 0;
    await promise;

    assert.equal(wroteSynchronously, false);
    assert.equal(readdirSync(outputs).length, 4);
  });

  it("rejects options of the wrong shape with INVALID_ARGUMENT", async () => {
    const input = writePdf(directory, "shape.pdf", ["P1"]);
    const outputPattern = join(directory, "shape-%d.pdf");
    const cases: Array<[string, unknown, RegExp]> = [
      ["null options", null, /splitPages options must be an object/],
      ["missing input", { outputPattern }, /splitPages options\.input must be a string/],
      ["empty input", { input: "", outputPattern }, /splitPages options\.input must not be empty/],
      ["missing pattern", { input }, /splitPages options\.outputPattern must be a string/],
      [
        "pattern without placeholder",
        { input, outputPattern: join(directory, "shape.pdf") },
        /exactly one "%d"/,
      ],
      [
        "pattern with two placeholders",
        { input, outputPattern: join(directory, "%d-%d.pdf") },
        /exactly one "%d"/,
      ],
      [
        "zero pagesPerFile",
        { input, outputPattern, pagesPerFile: 0 },
        /pagesPerFile must be an integer/,
      ],
      [
        "fractional pagesPerFile",
        { input, outputPattern, pagesPerFile: 1.5 },
        /pagesPerFile must be an integer/,
      ],
      [
        "string pagesPerFile",
        { input, outputPattern, pagesPerFile: "2" },
        /pagesPerFile must be an integer/,
      ],
      [
        "oversized pagesPerFile",
        { input, outputPattern, pagesPerFile: 2 ** 32 },
        /pagesPerFile must be an integer/,
      ],
      [
        "non-string password",
        { input, outputPattern, password: {} },
        /splitPages options\.password must be a string/,
      ],
    ];

    for (const [name, options, message] of cases) {
      const error = await rejectionOf(splitPages(options as never));
      assert.equal(error.code, "INVALID_ARGUMENT", name);
      assert.match(error.message, message, name);
    }
    assert.equal(existsSync(join(directory, "shape-1.pdf")), false);
  });

  it("reports a missing input with its path", async () => {
    const error = await rejectionOf(
      splitPages({
        input: join(directory, "missing.pdf"),
        outputPattern: join(directory, "missing-%d.pdf"),
      }),
    );

    assert.equal(error.code, "OPERATION_FAILED");
    assert.match(error.message, /missing\.pdf/);
  });

  it("reports a missing output directory", async () => {
    const input = writePdf(directory, "nodir.pdf", ["P1"]);

    const error = await rejectionOf(
      splitPages({ input, outputPattern: join(directory, "no-such-directory", "p%d.pdf") }),
    );

    assert.equal(error.code, "OPERATION_FAILED");
  });
});
