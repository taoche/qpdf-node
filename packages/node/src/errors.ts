export type QpdfErrorCode = "INVALID_ARGUMENT" | "OPERATION_FAILED";

/**
 * The only error type this package rejects with.
 *
 * - `INVALID_ARGUMENT`: the request was rejected before any output was written
 *   (wrong type, empty path, bad page range syntax, page 0 or repeated, output
 *   equal to an input, use after `close()`).
 * - `OPERATION_FAILED`: qpdf could not read an input or write an output (missing
 *   file, not a PDF, page out of bounds, wrong password, unwritable directory).
 */
export class QpdfError extends Error {
  readonly code: QpdfErrorCode;

  constructor(code: QpdfErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "QpdfError";
    this.code = code;
  }
}

/** The native addon rejects with an Error whose `code` is already a {@link QpdfErrorCode}. */
export function toQpdfError(error: unknown): QpdfError {
  if (error instanceof QpdfError) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  const nativeCode = (error as { code?: unknown } | null)?.code;
  const code: QpdfErrorCode =
    nativeCode === "INVALID_ARGUMENT" ? "INVALID_ARGUMENT" : "OPERATION_FAILED";
  return new QpdfError(code, message, { cause: error });
}
