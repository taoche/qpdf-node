// Web Worker wrapper around the WebAssembly module. The page talks to it with
// postMessage; PDF bytes are transferred, not copied, in both directions, and
// all PDF work runs off the page's main thread.
//
//   const worker = new Worker(new URL("./qpdf-worker.mjs", import.meta.url), { type: "module" });
//   worker.postMessage({ requestId: 1, type: "open", bytes }, [bytes.buffer]);
//   // -> { requestId: 1, ok: true, documentId, pageCount }
//   worker.postMessage({ requestId: 2, type: "extract", documentId, pages: [3, 1, 2] });
//   // -> { requestId: 2, ok: true, bytes: Uint8Array }   (transferred)
//   worker.postMessage({ requestId: 3, type: "close", documentId });
//   // -> { requestId: 3, ok: true }
//   worker.postMessage({ requestId: 4, type: "merge", inputs: [first, { bytes: second, pages: "2-z" }] });
//   // -> { requestId: 4, ok: true, bytes: Uint8Array }   (transferred)
//
// Failures reply { requestId, ok: false, code: "INVALID_ARGUMENT" | "OPERATION_FAILED", message }.
//
// qpdf-core.mjs and qpdf-core.wasm are the build outputs (see README.md) and
// must sit next to this file.
import createQpdfCore from "./qpdf-core.mjs";

const ready = createQpdfCore();
const documents = new Map();
let nextDocumentId = 1;

function requireDocument(documentId) {
  const document = documents.get(documentId);
  if (document === undefined) {
    const error = new Error(`unknown or closed document. documentId=${documentId}`);
    error.code = "INVALID_ARGUMENT";
    throw error;
  }
  return document;
}

self.onmessage = async (event) => {
  const { requestId, type } = event.data;
  try {
    const core = await ready;
    if (type === "open") {
      const document = core.openPdf(event.data.bytes);
      const documentId = nextDocumentId++;
      documents.set(documentId, document);
      self.postMessage({ requestId, ok: true, documentId, pageCount: document.pageCount });
    } else if (type === "extract") {
      const bytes = requireDocument(event.data.documentId).extract(event.data.pages);
      self.postMessage({ requestId, ok: true, bytes }, [bytes.buffer]);
    } else if (type === "merge") {
      const bytes = core.mergeBytes(event.data.inputs);
      self.postMessage({ requestId, ok: true, bytes }, [bytes.buffer]);
    } else if (type === "close") {
      documents.get(event.data.documentId)?.close();
      documents.delete(event.data.documentId);
      self.postMessage({ requestId, ok: true });
    } else {
      const error = new Error(`unknown request type. type=${String(type)}`);
      error.code = "INVALID_ARGUMENT";
      throw error;
    }
  } catch (error) {
    self.postMessage({
      requestId,
      ok: false,
      code: error.code ?? "OPERATION_FAILED",
      message: error.message,
    });
  }
};
