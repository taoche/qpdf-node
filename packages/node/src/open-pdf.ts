import { mkdtempSync, rmSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PdqError, toPdqError } from "./errors";
import { merge, pageCount } from "./operations";
import { describe, invalidArgument } from "./options";

/**
 * A PDF opened from bytes. See {@link openPdf} for what this does and does not
 * do. Call {@link OpenedPdf.close} in a `finally` block.
 */
export interface OpenedPdf {
  /** Number of pages in the opened PDF. */
  readonly pageCount: number;

  /**
   * Returns a new unencrypted PDF holding the given pages, in the given order.
   *
   * Pages are 1-based integers between 1 and {@link OpenedPdf.pageCount}.
   * The array must not be empty and must not repeat a page: pdq 0.5.1 would
   * write a page tree that references the same page object twice, which is not
   * a well-formed PDF, so repeats are rejected. Every page is validated before
   * any work starts. May be called any number of times,
   * including concurrently, until {@link OpenedPdf.close}.
   */
  extract(pages: readonly number[]): Promise<Uint8Array>;

  /**
   * Deletes the temporary files behind this object. Idempotent. Waits for
   * extractions already in progress, which still complete; later `extract`
   * calls reject with `INVALID_ARGUMENT`.
   */
  close(): Promise<void>;
}

/**
 * Best-effort cleanup for callers that forget {@link OpenedPdf.close}: when an
 * OpenedPdf is garbage collected, its temporary directory is removed
 * synchronously. GC timing is not guaranteed and nothing runs at process exit,
 * so this is a safety net, not a substitute for `close()`.
 */
const abandonedDirectoryCleanup = new FinalizationRegistry<string>((directory) => {
  try {
    rmSync(directory, { recursive: true, force: true });
  } catch {
    // Nothing useful to do from a finalizer.
  }
});

/**
 * Opens a PDF from bytes so that pages can be extracted from it.
 *
 * **This is a compatibility bridge, not an in-memory engine.** pdq 0.5.1 only
 * works on files, so `openPdf` writes `input` once to a private (mode 0700)
 * temporary directory and counts its pages there. Every `extract` then runs
 * pdq's path-based merge with a page range against that file, writes the result
 * to another temporary file, reads it back, and deletes it. The document is
 * parsed again on each `extract` (nothing is parsed once and kept), and the
 * bytes are copied to and from disk. Expect disk I/O proportional to the input
 * and output sizes on every call. Node.js only.
 *
 * Always call {@link OpenedPdf.close} in a `finally` block.
 *
 * Encrypted inputs that need a real password are not supported through this
 * function; inputs with an empty user password open and the output is
 * unencrypted.
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

  const directory = await mkdtemp(join(tmpdir(), "pdq-node-"));
  try {
    const inputPath = join(directory, "input.pdf");
    await writeFile(inputPath, input, { mode: 0o600 });
    const pages = await pageCount({ input: inputPath });
    return new TemporaryFilePdf(directory, inputPath, pages);
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    const pdqError = toPdqError(error);
    throw new PdqError(
      pdqError.code,
      `openPdf could not read the input bytes. byteLength=${input.length}: ${pdqError.message}`,
      { cause: error },
    );
  }
}

class TemporaryFilePdf implements OpenedPdf {
  readonly pageCount: number;
  private readonly directory: string;
  private readonly inputPath: string;
  private readonly inFlight = new Set<Promise<unknown>>();
  private nextOutputNumber = 1;
  private closing: Promise<void> | undefined;

  constructor(directory: string, inputPath: string, pageCount: number) {
    this.directory = directory;
    this.inputPath = inputPath;
    this.pageCount = pageCount;
    abandonedDirectoryCleanup.register(this, directory, this);
  }

  extract(pages: readonly number[]): Promise<Uint8Array> {
    if (this.closing !== undefined) {
      return Promise.reject(invalidArgument("extract called on a closed OpenedPdf"));
    }
    let pageRange: string;
    try {
      pageRange = this.toPageRange(pages);
    } catch (error) {
      return Promise.reject(error);
    }
    const extraction = this.extractRange(pageRange);
    this.inFlight.add(extraction);
    const forget = (): void => {
      this.inFlight.delete(extraction);
    };
    extraction.then(forget, forget);
    return extraction;
  }

  close(): Promise<void> {
    if (this.closing === undefined) {
      this.closing = this.removeAfterInFlight();
    }
    return this.closing;
  }

  private toPageRange(pages: readonly number[]): string {
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
    return pages.join(",");
  }

  private async extractRange(pageRange: string): Promise<Uint8Array> {
    const outputPath = join(this.directory, `extract-${this.nextOutputNumber++}.pdf`);
    try {
      await merge({ inputs: [{ path: this.inputPath, pages: pageRange }], output: outputPath });
      return await readFile(outputPath);
    } finally {
      await rm(outputPath, { force: true });
    }
  }

  private async removeAfterInFlight(): Promise<void> {
    await Promise.allSettled([...this.inFlight]);
    abandonedDirectoryCleanup.unregister(this);
    await rm(this.directory, { recursive: true, force: true });
  }
}
