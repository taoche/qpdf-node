import { strict as assert } from "node:assert";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { pageCount, QpdfError } from "../src/index";
import { makeTempDirectory, writePdf } from "./helpers/pdf";

const directory = makeTempDirectory();
after(() => rmSync(directory, { recursive: true, force: true }));

describe("pageCount", () => {
  it("counts pages", async () => {
    const input = writePdf(directory, "three.pdf", ["P1", "P2", "P3"]);

    assert.equal(await pageCount({ input }), 3);
  });

  it("rejects options of the wrong shape with INVALID_ARGUMENT", async () => {
    await assert.rejects(pageCount("x.pdf" as never), (error: unknown) => {
      assert.ok(error instanceof QpdfError);
      assert.equal(error.code, "INVALID_ARGUMENT");
      assert.match(error.message, /pageCount options must be an object/);
      return true;
    });
    await assert.rejects(pageCount({ input: "" }), (error: unknown) => {
      assert.ok(error instanceof QpdfError);
      assert.equal(error.code, "INVALID_ARGUMENT");
      return true;
    });
  });

  it("reports an input that is not a PDF with its path", async () => {
    const input = join(directory, "not.pdf");
    writeFileSync(input, "this is not a pdf");

    await assert.rejects(pageCount({ input }), (error: unknown) => {
      assert.ok(error instanceof QpdfError);
      assert.equal(error.code, "OPERATION_FAILED");
      assert.match(error.message, /not\.pdf/);
      return true;
    });
  });
});
