import { QpdfError, toQpdfError } from "./errors";
import { native } from "./native";
import type { NativeDocument } from "./native-binding";
import { describe, invalidArgument } from "./options";

/**
 * A PDF opened from bytes. See {@link openPdf}. Call {@link OpenedPdf.close} in
 * a `finally` block.
 */
export interface OpenedPdf {
  /** Number of pages in the opened PDF. */
  readonly pageCount: number;

  /**
   * Returns a new unencrypted PDF holding the given pages, in the given order.
   *
   * Pages are 1-based integers between 1 and {@link OpenedPdf.pageCount}. The
   * array must not be empty and must not repeat a page. Every page is validated
   * before any work starts. May be called any number of times, including
   * concurrently, until {@link OpenedPdf.close}. Calls on one `OpenedPdf` run
   * one after another on the libuv thread pool (qpdf's document objects are not
   * thread-safe); different `OpenedPdf`s run in parallel.
   *
   * Streams (page content, images, fonts) are copied as they are, without
   * decoding or recompressing. Resources a page inherits from the page tree are
   * copied onto the page.
   */
  extract(pages: readonly number[]): Promise<Uint8Array>;

  /**
   * Releases the parsed document. Idempotent. Waits for extractions already in
   * progress, which still complete; later `extract` calls reject with
   * `INVALID_ARGUMENT`.
   */
  close(): Promise<void>;
}

/**
 * Opens a PDF from bytes so that pages can be extracted from it.
 *
 * The bytes are copied into the addon and parsed once, on the libuv thread
 * pool. The parsed qpdf document stays in memory inside the returned handle, and
 * every `extract` reuses it: nothing is written to disk and the input is not
 * parsed again. Changing `input` after this call resolves has no effect.
 *
 * Always call {@link OpenedPdf.close} in a `finally` block. If you forget, the
 * memory is released when the handle is garbage collected, which may be late.
 *
 * Encrypted inputs that need a real password are not supported through this
 * function; inputs with an empty user password open and the output is
 * unencrypted. A damaged PDF is repaired when qpdf can (warnings are
 * discarded); otherwise opening rejects.
 *
 * Rejects with `INVALID_ARGUMENT` when `input` is not a non-empty `Uint8Array`
 * (a `Buffer` is one), and with `OPERATION_FAILED` when the bytes are not a
 * readable PDF.
 */
export async function openPdf(input: Uint8Array): Promise<OpenedPdf> {
  if (!(input instanceof Uint8Array)) {
    throw invalidArgument(
      `openPdf input must be a Uint8Array or Buffer. received=${describe(input)}`,
    );
  }
  if (input.length === 0) {
    throw invalidArgument("openPdf input must not be empty. byteLength=0");
  }

  let document: NativeDocument;
  try {
    document = await native.openDocument(input);
  } catch (error) {
    const qpdfError = toQpdfError(error);
    throw new QpdfError(
      qpdfError.code,
      `openPdf could not read the input bytes. byteLength=${input.length}: ${qpdfError.message}`,
      { cause: error },
    );
  }
  return new NativePdf(document);
}

class NativePdf implements OpenedPdf {
  readonly pageCount: number;
  private readonly document: NativeDocument;
  private readonly inFlight = new Set<Promise<unknown>>();
  private closing: Promise<void> | undefined;

  constructor(document: NativeDocument) {
    this.document = document;
    this.pageCount = document.pageCount;
  }

  extract(pages: readonly number[]): Promise<Uint8Array> {
    if (this.closing !== undefined) {
      return Promise.reject(invalidArgument("extract called on a closed OpenedPdf"));
    }
    try {
      this.validatePages(pages);
    } catch (error) {
      return Promise.reject(error);
    }
    const extraction = this.document.extract([...pages]).catch((error: unknown) => {
      throw toQpdfError(error);
    });
    this.inFlight.add(extraction);
    const forget = (): void => {
      this.inFlight.delete(extraction);
    };
    extraction.then(forget, forget);
    return extraction;
  }

  close(): Promise<void> {
    if (this.closing === undefined) {
      this.closing = this.releaseAfterInFlight();
    }
    return this.closing;
  }

  private validatePages(pages: readonly number[]): void {
    if (!Array.isArray(pages)) {
      throw invalidArgument(`extract pages must be an array. received=${describe(pages)}`);
    }
    if (pages.length === 0) {
      throw invalidArgument("extract pages must not be empty. pages=[]");
    }
    const seen = new Set<number>();
    pages.forEach((page, index) => {
      if (!Number.isInteger(page) || page < 1 || page > this.pageCount) {
        throw invalidArgument(
          `extract pages[${index}] must be an integer between 1 and ${this.pageCount}. received=${String(page)}`,
        );
      }
      if (seen.has(page)) {
        throw invalidArgument(
          `extract pages must not repeat a page. pages[${index}]=${page}, pageCount=${this.pageCount}`,
        );
      }
      seen.add(page);
    });
  }

  private async releaseAfterInFlight(): Promise<void> {
    await Promise.allSettled([...this.inFlight]);
    this.document.close();
  }
}
