// Emscripten (embind) binding for the qpdf-node core.
//
// Everything is synchronous and in memory: bytes in, bytes out. Run it inside a
// Web Worker so a large document does not block the page (see README.md).
//
// Errors: qpdf_node::Error is caught here, never thrown into JavaScript as a C++
// exception. Each failure is thrown as a JavaScript Error with `code` set to
// "INVALID_ARGUMENT" or "OPERATION_FAILED".
#include <emscripten/bind.h>
#include <emscripten/val.h>

#include <cmath>
#include <memory>
#include <optional>
#include <string>
#include <vector>

#include "pdf_core.hh"

namespace {

using emscripten::val;
using qpdf_node::Bytes;
using qpdf_node::Document;
using qpdf_node::Error;
using qpdf_node::ErrorKind;

struct Failure {
  std::string code;
  std::string message;
};

Failure toFailure(ErrorKind kind, const std::string& message) {
  return Failure{kind == ErrorKind::InvalidArgument ? "INVALID_ARGUMENT" : "OPERATION_FAILED", message};
}

// Throws `failure` as a JavaScript Error. Callers invoke it only after their
// try/catch has finished, so no C++ exception is in flight while the JavaScript
// one unwinds.
[[noreturn]] void throwJavaScriptError(const Failure& failure) {
  val error = val::global("Error").new_(failure.message);
  error.set("code", failure.code);
  error.throw_();
  __builtin_unreachable();
}

// Runs `work`; a failure becomes a JavaScript Error.
template <typename Work>
auto runOrThrow(Work work) -> decltype(work()) {
  std::optional<Failure> failure;
  std::optional<decltype(work())> result;
  try {
    result.emplace(work());
  } catch (const Error& error) {
    failure = toFailure(error.kind(), error.what());
  } catch (...) {
    failure = toFailure(ErrorKind::OperationFailed, "unexpected failure inside the native core");
  }
  if (failure) {
    throwJavaScriptError(*failure);
  }
  return std::move(*result);
}

val toUint8Array(const Bytes& bytes) {
  // new Uint8Array(view) copies out of WebAssembly memory, which may move when it grows.
  return val::global("Uint8Array").new_(val(emscripten::typed_memory_view(bytes.size(), bytes.data())));
}

std::vector<std::uint32_t> readPages(const val& array) {
  if (!array.instanceof (val::global("Array"))) {
    throw Error(ErrorKind::InvalidArgument, "extract pages must be an array");
  }
  std::vector<std::uint32_t> pages;
  unsigned length = array["length"].as<unsigned>();
  for (unsigned index = 0; index < length; ++index) {
    val element = array[index];
    double number = element.typeOf().as<std::string>() == "number" ? element.as<double>() : 0;
    if (!std::isfinite(number) || std::floor(number) != number || number < 1 || number > 4294967295.0) {
      throw Error(
          ErrorKind::InvalidArgument,
          "extract pages[" + std::to_string(index) + "] must be an integer between 1 and 4294967295");
    }
    pages.push_back(static_cast<std::uint32_t>(number));
  }
  return pages;
}

class PdfDocument {
 public:
  explicit PdfDocument(std::shared_ptr<Document> document) : document_(std::move(document)) {}

  std::uint32_t pageCount() const { return document_ ? document_->pageCount() : 0; }

  // extract(pages: number[]): Uint8Array. Pages are 1-based and in output order.
  val extract(const val& pages) {
    Bytes bytes = runOrThrow([&] {
      if (!document_) {
        throw Error(ErrorKind::InvalidArgument, "extract called on a closed document");
      }
      return document_->extractPages(readPages(pages));
    });
    return toUint8Array(bytes);
  }

  // Frees the parsed document. Idempotent.
  void close() { document_.reset(); }

 private:
  std::shared_ptr<Document> document_;
};

// openPdf(bytes: Uint8Array): PdfDocument
PdfDocument openPdf(const val& input) {
  std::shared_ptr<Document> document = runOrThrow([&] {
    if (!input.instanceof (val::global("Uint8Array"))) {
      throw Error(ErrorKind::InvalidArgument, "openPdf input must be a Uint8Array");
    }
    size_t size = input["length"].as<size_t>();
    Bytes bytes(size);
    if (size > 0) {
      val(emscripten::typed_memory_view(size, bytes.data())).call<void>("set", input);
    }
    return Document::openMemory(std::move(bytes), "");
  });
  return PdfDocument(std::move(document));
}

std::string qpdfVersion() { return qpdf_node::qpdfVersion(); }

}  // namespace

EMSCRIPTEN_BINDINGS(qpdf_core) {
  emscripten::class_<PdfDocument>("PdfDocument")
      .property("pageCount", &PdfDocument::pageCount)
      .function("extract", &PdfDocument::extract)
      .function("close", &PdfDocument::close);
  emscripten::function("openPdf", &openPdf);
  emscripten::function("qpdfVersion", &qpdfVersion);
}
