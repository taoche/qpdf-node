import type * as binding from "./native-binding";
import { native } from "./native";
import { toQpdfError } from "./errors";
import {
  invalidArgument,
  optionalPositiveUint32,
  optionalString,
  requireNonEmptyString,
  requireObject,
} from "./options";

/** One merge input: a whole PDF, or the pages of it selected by `pages`. */
export interface MergeInputOptions {
  /** Path to the input PDF. Relative paths are relative to the process working directory. */
  path: string;
  /**
   * Page range selecting pages of this input, in output order: `"1-3"`,
   * `"4-z"`, `"r1"`, `"7-3,1"`. Pages are 1-based, `z` is the last page, `rN` is
   * the Nth page from the end (`r1` is the last), `7-3` runs backwards, and
   * commas combine parts in the order written. A page may be listed more than
   * once. Bad syntax rejects with `INVALID_ARGUMENT`; out-of-bounds pages reject
   * with `OPERATION_FAILED` and are never clamped. Omit to take every page.
   */
  pages?: string;
}

export interface MergeOptions {
  /** Inputs in output order. A plain string is shorthand for `{ path }`. */
  inputs: ReadonlyArray<string | MergeInputOptions>;
  /**
   * Where to write the merged PDF. An existing file is replaced. The directory
   * must already exist. It must not be one of the inputs.
   */
  output: string;
  /** Only for encrypted inputs that do not open with the empty user password. */
  password?: string;
}

export interface SplitPagesOptions {
  /** Path to the input PDF. */
  input: string;
  /**
   * Output path template containing exactly one `%d`, e.g. `"out/page-%d.pdf"`.
   * With one page per file, `%d` is the original page number, zero-padded to
   * the width of the last page number (`page-07.pdf` in a 12-page file). With
   * `pagesPerFile > 1`, `%d` is the 1-based chunk number, zero-padded to the
   * width of the chunk count. Existing files are replaced. The directory must
   * already exist.
   */
  outputPattern: string;
  /** Consecutive pages per output file. Defaults to 1. */
  pagesPerFile?: number;
  /** Only for encrypted inputs that do not open with the empty user password. */
  password?: string;
}

export interface PageCountOptions {
  input: string;
  /** Only for encrypted inputs that do not open with the empty user password. */
  password?: string;
}

/**
 * Concatenates PDFs into one unencrypted PDF.
 *
 * The work runs on the libuv thread pool, not on the event loop. Rejects with
 * {@link QpdfError}.
 */
export async function merge(options: MergeOptions): Promise<void> {
  try {
    await native.mergeNative(parseMergeOptions(options));
  } catch (error) {
    throw toQpdfError(error);
  }
}

/**
 * Splits a PDF into one file per page, or per chunk of `pagesPerFile` pages.
 * Outputs are unencrypted. The names of the written files follow
 * {@link SplitPagesOptions.outputPattern}.
 *
 * The work runs on the libuv thread pool, not on the event loop. Rejects with
 * {@link QpdfError}.
 */
export async function splitPages(options: SplitPagesOptions): Promise<void> {
  try {
    await native.splitPagesNative(parseSplitPagesOptions(options));
  } catch (error) {
    throw toQpdfError(error);
  }
}

/**
 * Counts pages by walking the page tree (not by trusting the `/Count` entry).
 * Rejects with {@link QpdfError}.
 */
export async function pageCount(options: PageCountOptions): Promise<number> {
  try {
    return await native.pageCountNative(parsePageCountOptions(options));
  } catch (error) {
    throw toQpdfError(error);
  }
}

function parseMergeOptions(options: unknown): binding.NativeMergeOptions {
  const fields = requireObject("merge options", options);
  const inputs = fields.inputs;
  if (!Array.isArray(inputs)) {
    throw invalidArgument(`merge options.inputs must be an array. received=${typeof inputs}`);
  }
  return {
    inputs: inputs.map((input, index) => parseMergeInput(`merge options.inputs[${index}]`, input)),
    output: requireNonEmptyString("merge options.output", fields.output),
    password: optionalString("merge options.password", fields.password),
  };
}

function parseMergeInput(label: string, input: unknown): binding.NativeMergeInput {
  if (typeof input === "string") {
    return { path: requireNonEmptyString(label, input) };
  }
  const fields = requireObject(label, input);
  return {
    path: requireNonEmptyString(`${label}.path`, fields.path),
    pages: optionalString(`${label}.pages`, fields.pages),
  };
}

function parseSplitPagesOptions(options: unknown): binding.NativeSplitPagesOptions {
  const fields = requireObject("splitPages options", options);
  return {
    input: requireNonEmptyString("splitPages options.input", fields.input),
    outputPattern: requireNonEmptyString("splitPages options.outputPattern", fields.outputPattern),
    pagesPerFile: optionalPositiveUint32("splitPages options.pagesPerFile", fields.pagesPerFile),
    password: optionalString("splitPages options.password", fields.password),
  };
}

function parsePageCountOptions(options: unknown): binding.NativePageCountOptions {
  const fields = requireObject("pageCount options", options);
  return {
    input: requireNonEmptyString("pageCount options.input", fields.input),
    password: optionalString("pageCount options.password", fields.password),
  };
}
