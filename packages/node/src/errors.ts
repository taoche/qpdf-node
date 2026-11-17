export type PdqErrorCode = "INVALID_ARGUMENT" | "OPERATION_FAILED";

/**
 * The only error type this package rejects with.
 *
 * - `INVALID_ARGUMENT`: the options were rejected before or while validating,
 *   and no output was written.
 * - `OPERATION_FAILED`: pdq could not read an input or write an output (missing
 *   file, not a PDF, page out of bounds, wrong password, unwritable directory).
 */
export class PdqError extends Error {
  readonly code: PdqErrorCode;

  constructor(code: PdqErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PdqError";
    this.code = code;
  }
}

/** napi-rs reports the Rust-side status name (`InvalidArg`, `GenericFailure`) as `code`. */
export function toPdqError(error: unknown): PdqError {
  if (error instanceof PdqError) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  const nativeCode = (error as { code?: unknown } | null)?.code;
  const code: PdqErrorCode = nativeCode === "InvalidArg" ? "INVALID_ARGUMENT" : "OPERATION_FAILED";
  return new PdqError(code, message, { cause: error });
}
