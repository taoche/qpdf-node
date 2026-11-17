import { strict as assert } from "node:assert";

import { QpdfError } from "../../src/index";

/** Awaits a promise that must reject, and returns the QpdfError it rejected with. */
export async function rejectionOf(promise: Promise<unknown>): Promise<QpdfError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof QpdfError, `expected QpdfError, got ${String(error)}`);
    return error;
  }
  return assert.fail("expected the promise to reject");
}
