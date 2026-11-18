// Shared PDF core of qpdf-node: memory-based PDF operations on top of qpdf.
//
// Both bindings (the Node.js N-API addon and the Emscripten module) sit on this
// header. It does not include any qpdf header, so bindings compile without
// qpdf's include paths.
//
// Exceptions: every function here throws only qpdf_node::Error. Anything qpdf
// or the standard library throws is converted at this boundary, so a binding
// needs a single `catch (const qpdf_node::Error&)` and never lets a C++
// exception cross into JavaScript.
#pragma once

#include <cstddef>
#include <cstdint>
#include <memory>
#include <optional>
#include <stdexcept>
#include <string>
#include <vector>

namespace qpdf_node {

using Bytes = std::vector<std::uint8_t>;

enum class ErrorKind {
  // The request itself is wrong (bad option, bad page range syntax, page 0).
  InvalidArgument,
  // The request was well formed but could not be carried out (not a PDF, page
  // beyond the end, unreadable file, wrong password).
  OperationFailed,
};

class Error : public std::runtime_error {
 public:
  Error(ErrorKind kind, const std::string& message);
  ErrorKind kind() const { return kind_; }

 private:
  ErrorKind kind_;
};

// A selection of pages written as text, e.g. "1-3", "4-z", "r1", "7-3,1".
//
//   N        page N (1-based)
//   z        the last page
//   rN       the Nth page from the end; r1 is the last page
//   A-B      pages A through B; if B is before A the pages run backwards
//   a,b,c    the parts, in the order written
//
// A page may be selected more than once. Pages beyond the document are an
// error when the range is resolved, never clamped.
class PageRange {
 public:
  // Throws InvalidArgument when `text` is not valid range syntax.
  static PageRange parse(const std::string& text);

  // Returns the 1-based page numbers this range selects in a document with
  // `page_count` pages. Throws OperationFailed when a page is out of bounds.
  std::vector<std::uint32_t> resolve(std::uint32_t page_count) const;

 private:
  struct Bound {
    bool from_end;
    std::uint32_t number;  // from_end: 1 is the last page; otherwise 1-based
  };
  struct Part {
    Bound first;
    Bound last;
  };
  std::vector<Part> parts_;
};

// A parsed PDF. Opening parses it once; the handle is then reused for any
// number of extractions. Copying the bytes in (openMemory) means the caller's
// buffer is not needed afterwards.
//
// qpdf's objects are not thread-safe and copied streams read lazily from the
// source while the output is written, so operations on one Document run one at
// a time (each takes the document's lock for its whole duration). Different
// Documents run in parallel.
class Document : public std::enable_shared_from_this<Document> {
 public:
  ~Document();
  Document(const Document&) = delete;
  Document& operator=(const Document&) = delete;

  // Parses PDF bytes; the Document keeps `bytes` for as long as it lives, so the
  // caller's own buffer is not needed afterwards. `password` is only used for
  // encrypted PDFs; pass "" for none.
  static std::shared_ptr<Document> openMemory(Bytes bytes, const std::string& password);
  // Copies `size` bytes first.
  static std::shared_ptr<Document> openMemory(
      const std::uint8_t* data, std::size_t size, const std::string& password);

  // Parses the PDF at `path`. qpdf reads the file lazily, so it must not be
  // modified while the Document is in use.
  static std::shared_ptr<Document> openFile(
      const std::string& path, const std::string& password);

  // Counted by walking the page tree, not by trusting /Count.
  std::uint32_t pageCount() const { return page_count_; }

  // Returns a new unencrypted PDF holding `pages` (1-based) in the given order.
  // Throws InvalidArgument when `pages` is empty, repeats a page, or names a
  // page outside 1..pageCount().
  Bytes extractPages(const std::vector<std::uint32_t>& pages);

  class Impl;
  Impl& impl() { return *impl_; }

 private:
  Document(std::unique_ptr<Impl> impl, std::uint32_t page_count);
  std::unique_ptr<Impl> impl_;
  std::uint32_t page_count_;
};

// Pages taken from one document, in output order. Pages are 1-based.
struct PageSelection {
  std::shared_ptr<Document> document;
  std::vector<std::uint32_t> pages;
};

// Builds one unencrypted PDF from the selections, in order, and returns its
// bytes. Selections may name the same document several times.
Bytes assemblePages(const std::vector<PageSelection>& selections);

// One input of mergeMemory: a whole PDF, or the pages of it selected by `pages`.
struct MemoryMergeInput {
  Bytes bytes;
  std::optional<PageRange> pages;  // empty: every page
};

// Concatenates PDFs held in memory, in order, into one unencrypted PDF. An
// input that contributes no pages is skipped. Errors name the failing input by
// index. Throws InvalidArgument when `inputs` is empty or an input has no bytes,
// and OperationFailed when an input is not a readable PDF, its range names a
// page beyond the document, or no input contributes any page.
Bytes mergeMemory(std::vector<MemoryMergeInput> inputs);

// The version of the qpdf library this core was built with, e.g. "12.4.2".
std::string qpdfVersion();

}  // namespace qpdf_node
