import { strict as assert } from "node:assert";

import { PdqError } from "../../src/index";

/** Awaits a promise that must reject, and returns the PdqError it rejected with. */
export async function rejectionOf(promise: Promise<unknown>): Promise<PdqError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof PdqError, `expected PdqError, got ${String(error)}`);
    return error;
  }
  return assert.fail("expected the promise to reject");
}
