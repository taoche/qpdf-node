/** Shape of the C++ N-API addon (native/node/addon.cc). Not public API. */

export interface NativeDocument {
  readonly pageCount: number;
  /** Pages are 1-based integers. Resolves with the new PDF's bytes. */
  extract(pages: number[]): Promise<Uint8Array>;
  /** Drops this handle's reference. Extractions already started still finish. */
  close(): void;
}

export interface NativeMergeInput {
  path: string;
  pages?: string;
}

export interface NativeMergeOptions {
  inputs: NativeMergeInput[];
  output: string;
  password?: string;
}

export interface NativeMergeBytesInput {
  bytes: Uint8Array;
  pages?: string;
}

export interface NativeMergeBytesOptions {
  inputs: NativeMergeBytesInput[];
}

export interface NativeSplitPagesOptions {
  input: string;
  outputPattern: string;
  pagesPerFile?: number;
  password?: string;
}

export interface NativePageCountOptions {
  input: string;
  password?: string;
}

export interface NativeBinding {
  openDocument(bytes: Uint8Array, password?: string): Promise<NativeDocument>;
  mergeNative(options: NativeMergeOptions): Promise<void>;
  mergeBytesNative(options: NativeMergeBytesOptions): Promise<Uint8Array>;
  splitPagesNative(options: NativeSplitPagesOptions): Promise<void>;
  pageCountNative(options: NativePageCountOptions): Promise<number>;
  qpdfVersion(): string;
}
