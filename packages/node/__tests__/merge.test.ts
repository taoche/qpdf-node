import { strict as assert } from "node:assert";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { merge, pageCount } from "../src/index";
import { rejectionOf } from "./helpers/assertions";
import { makeTempDirectory, markersIn, writePdf } from "./helpers/pdf";

const directory = makeTempDirectory();
after(() => rmSync(directory, { recursive: true, force: true }));

const ALL_MARKERS = ["A1", "A2", "A3", "B1", "B2"];

describe("merge", () => {
  it("concatenates whole inputs in order", async () => {
    const first = writePdf(directory, "a.pdf", ["A1", "A2", "A3"]);
    const second = writePdf(directory, "b.pdf", ["B1", "B2"]);
    const output = join(directory, "merged.pdf");

    const result = await merge({ inputs: [first, { path: second }], output });

    assert.equal(result, undefined);
    assert.equal(await pageCount({ input: output }), 5);
    assert.deepEqual(markersIn(output, ALL_MARKERS), ALL_MARKERS);
    assert.ok(readFileSync(output).toString("latin1").startsWith("%PDF-"));
    assert.ok(!readFileSync(output).toString("latin1").includes("/Encrypt"));
  });

  it("selects pages per input", async () => {
    const first = writePdf(directory, "sel-a.pdf", ["A1", "A2", "A3"]);
    const second = writePdf(directory, "sel-b.pdf", ["B1", "B2"]);
    const output = join(directory, "selected.pdf");

    await merge({
      inputs: [
        { path: first, pages: "3,1" },
        { path: second, pages: "r1" },
      ],
      output,
    });

    assert.equal(await pageCount({ input: output }), 3);
    assert.deepEqual(markersIn(output, ALL_MARKERS), ["A3", "A1", "B2"]);
  });

  it("resolves page ranges: z, rN, reversed ranges, and comma-separated parts", async () => {
    const input = writePdf(directory, "ranges.pdf", ["A1", "A2", "A3", "B1", "B2"]);
    const cases: Array<[string, string[]]> = [
      ["2", ["A2"]],
      ["2-4", ["A2", "A3", "B1"]],
      ["4-z", ["B1", "B2"]],
      ["z", ["B2"]],
      ["r1", ["B2"]],
      ["r2-r1", ["B1", "B2"]],
      ["r5-r1", ["A1", "A2", "A3", "B1", "B2"]],
      ["4-2", ["B1", "A3", "A2"]],
      ["5-3,1", ["B2", "B1", "A3", "A1"]],
      ["3,1,2", ["A3", "A1", "A2"]],
      ["1-2,z,r2", ["A1", "A2", "B2", "B1"]],
    ];

    for (const [range, expected] of cases) {
      const output = join(directory, `range-${range.replaceAll(",", "_")}.pdf`);
      await merge({ inputs: [{ path: input, pages: range }], output });

      assert.equal(await pageCount({ input: output }), expected.length, range);
      assert.deepEqual(markersIn(output, ALL_MARKERS), expected, range);
    }
  });

  it("writes a page twice when a range names it twice", async () => {
    const input = writePdf(directory, "twice.pdf", ["A1", "A2", "A3"]);
    const output = join(directory, "twice-out.pdf");

    await merge({ inputs: [{ path: input, pages: "2,2,1" }], output });

    assert.equal(await pageCount({ input: output }), 3);
  });

  it("resolves relative paths against the working directory", async () => {
    writePdf(directory, "rel-a.pdf", ["A1"]);
    writePdf(directory, "rel-b.pdf", ["B1"]);
    const originalDirectory = process.cwd();
    process.chdir(directory);
    try {
      await merge({ inputs: ["rel-a.pdf", "rel-b.pdf"], output: "rel-out.pdf" });
    } finally {
      process.chdir(originalDirectory);
    }

    assert.deepEqual(markersIn(join(directory, "rel-out.pdf"), ALL_MARKERS), ["A1", "B1"]);
  });

  it("does its work off the calling stack", async () => {
    const markers = Array.from({ length: 1000 }, (_, index) => `P${index}`);
    const big = writePdf(directory, "big.pdf", markers);
    const output = join(directory, "big-merged.pdf");

    const promise = merge({
      inputs: [
        { path: big, pages: "1-z" },
        { path: big, pages: "1-z" },
      ],
      output,
    });
    const outputExistedSynchronously = existsSync(output);
    let immediateRanBeforeSettling = false;
    setImmediate(() => {
      immediateRanBeforeSettling = true;
    });
    await promise;

    assert.equal(outputExistedSynchronously, false);
    assert.equal(immediateRanBeforeSettling, true);
    assert.equal(await pageCount({ input: output }), 2000);
  });

  it("rejects options of the wrong shape with INVALID_ARGUMENT", async () => {
    const output = join(directory, "never.pdf");
    const cases: Array<[string, unknown, RegExp]> = [
      ["undefined options", undefined, /merge options must be an object/],
      ["array options", [], /merge options must be an object/],
      ["missing inputs", { output }, /merge options\.inputs must be an array/],
      ["empty inputs", { inputs: [], output }, /at least one input/],
      ["numeric input", { inputs: [1], output }, /merge options\.inputs\[0\] must be an object/],
      [
        "empty input path",
        { inputs: [{ path: "" }], output },
        /merge options\.inputs\[0\]\.path must not be empty/,
      ],
      [
        "non-string pages",
        { inputs: [{ path: "x.pdf", pages: 1 }], output },
        /inputs\[0\]\.pages must be a string/,
      ],
      ["missing output", { inputs: ["x.pdf"] }, /merge options\.output must be a string/],
      [
        "empty output",
        { inputs: ["x.pdf"], output: "" },
        /merge options\.output must not be empty/,
      ],
      [
        "non-string password",
        { inputs: ["x.pdf"], output, password: 1 },
        /merge options\.password must be a string/,
      ],
    ];

    for (const [name, options, message] of cases) {
      const error = await rejectionOf(merge(options as never));
      assert.equal(error.code, "INVALID_ARGUMENT", name);
      assert.match(error.message, message, name);
    }
    assert.equal(existsSync(output), false);
  });

  it("rejects page range syntax errors with INVALID_ARGUMENT", async () => {
    const input = writePdf(directory, "syntax.pdf", ["A1", "A2"]);
    const output = join(directory, "syntax-out.pdf");

    for (const pages of [
      "",
      "1-",
      "-2",
      "a",
      "1,,2",
      "1,",
      "r",
      "r0",
      "1--2",
      "1 2",
      "4294967296",
    ]) {
      const error = await rejectionOf(merge({ inputs: [{ path: input, pages }], output }));

      assert.equal(error.code, "INVALID_ARGUMENT", JSON.stringify(pages));
      assert.match(error.message, /inputs\[0\]\.pages is not a valid page range/, pages);
    }
    assert.equal(existsSync(output), false);
  });

  it("rejects an invalid page range and writes nothing", async () => {
    const input = writePdf(directory, "range.pdf", ["A1"]);
    const output = join(directory, "range-out.pdf");

    const error = await rejectionOf(merge({ inputs: [{ path: input, pages: "0" }], output }));

    assert.equal(error.code, "INVALID_ARGUMENT");
    assert.match(error.message, /inputs\[0\]\.pages/);
    assert.equal(existsSync(output), false);
  });

  it("rejects an out-of-bounds page as OPERATION_FAILED", async () => {
    const input = writePdf(directory, "bounds.pdf", ["A1", "A2"]);
    const output = join(directory, "bounds-out.pdf");

    const error = await rejectionOf(merge({ inputs: [{ path: input, pages: "9" }], output }));

    assert.equal(error.code, "OPERATION_FAILED");
    assert.match(error.message, /out of bounds/);
    assert.equal(existsSync(output), false);
  });

  it("rejects an output that is also an input and leaves the input intact", async () => {
    const input = writePdf(directory, "same.pdf", ["A1"]);
    const before = readFileSync(input);

    const error = await rejectionOf(merge({ inputs: [input], output: input }));

    assert.equal(error.code, "INVALID_ARGUMENT");
    assert.match(error.message, /same file as an input/);
    assert.deepEqual(readFileSync(input), before);
  });

  it("reports a missing input with its path", async () => {
    const error = await rejectionOf(
      merge({ inputs: [join(directory, "missing.pdf")], output: join(directory, "m-out.pdf") }),
    );

    assert.equal(error.code, "OPERATION_FAILED");
    assert.match(error.message, /missing\.pdf/);
  });

  it("reports an input that is not a PDF", async () => {
    const input = join(directory, "not.pdf");
    writeFileSync(input, "this is not a pdf");

    const error = await rejectionOf(
      merge({ inputs: [input], output: join(directory, "n-out.pdf") }),
    );

    assert.equal(error.code, "OPERATION_FAILED");
    assert.match(error.message, /not\.pdf/);
  });

  it("reports a missing output directory", async () => {
    const input = writePdf(directory, "dir.pdf", ["A1"]);

    const error = await rejectionOf(
      merge({ inputs: [input], output: join(directory, "no-such-directory", "out.pdf") }),
    );

    assert.equal(error.code, "OPERATION_FAILED");
    assert.match(error.message, /no-such-directory/);
  });
});
