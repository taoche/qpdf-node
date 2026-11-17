#include <algorithm>
#include <functional>
#include <mutex>
#include <new>
#include <set>

#include <qpdf/Buffer.hh>
#include <qpdf/PDFVersion.hh>
#include <qpdf/QPDF.hh>
#include <qpdf/QPDFPageDocumentHelper.hh>
#include <qpdf/QPDFPageObjectHelper.hh>
#include <qpdf/QPDFWriter.hh>

#include "internal.hh"

namespace qpdf_node {

Error::Error(ErrorKind kind, const std::string& message) : std::runtime_error(message), kind_(kind) {}

namespace internal {

void runGuarded(const std::function<void()>& work) {
  try {
    work();
  } catch (const Error&) {
    throw;
  } catch (const std::bad_alloc&) {
    throw Error(ErrorKind::OperationFailed, "out of memory");
  } catch (const std::exception& error) {
    throw Error(ErrorKind::OperationFailed, error.what());
  } catch (...) {
    throw Error(ErrorKind::OperationFailed, "unknown error inside qpdf");
  }
}

}  // namespace internal

class Document::Impl {
 public:
  // Declaration order matters: qpdf reads `bytes` for as long as `qpdf` is
  // alive, so `bytes` is declared first and destroyed last.
  Bytes bytes;
  QPDF qpdf;
  // Every page, in document order, found once when the document is opened.
  std::vector<QPDFPageObjectHelper> pages;
  std::mutex mutex;

  Impl() { qpdf.setSuppressWarnings(true); }

  void loadPages() { pages = QPDFPageDocumentHelper(qpdf).getAllPages(); }
};

Document::Document(std::unique_ptr<Impl> impl, std::uint32_t page_count)
    : impl_(std::move(impl)), page_count_(page_count) {}

Document::~Document() = default;

std::shared_ptr<Document> Document::openMemory(
    const std::uint8_t* data, std::size_t size, const std::string& password) {
  return openMemory(Bytes(data, data + size), password);
}

std::shared_ptr<Document> Document::openMemory(Bytes bytes, const std::string& password) {
  if (bytes.empty()) {
    throw Error(ErrorKind::InvalidArgument, "PDF bytes must not be empty. byteLength=0");
  }
  std::shared_ptr<Document> document;
  internal::runGuarded([&] {
    auto impl = std::make_unique<Impl>();
    impl->bytes = std::move(bytes);
    impl->qpdf.processMemoryFile(
        "input bytes",
        reinterpret_cast<const char*>(impl->bytes.data()),
        impl->bytes.size(),
        password.empty() ? nullptr : password.c_str());
    impl->loadPages();
    auto page_count = static_cast<std::uint32_t>(impl->pages.size());
    document.reset(new Document(std::move(impl), page_count));
  });
  return document;
}

std::shared_ptr<Document> Document::openFile(const std::string& path, const std::string& password) {
  std::shared_ptr<Document> document;
  internal::runGuarded([&] {
    auto impl = std::make_unique<Impl>();
    impl->qpdf.processFile(path.c_str(), password.empty() ? nullptr : password.c_str());
    impl->loadPages();
    auto page_count = static_cast<std::uint32_t>(impl->pages.size());
    document.reset(new Document(std::move(impl), page_count));
  });
  return document;
}

Bytes Document::extractPages(const std::vector<std::uint32_t>& pages) {
  std::set<std::uint32_t> seen;
  for (std::size_t index = 0; index < pages.size(); ++index) {
    if (!seen.insert(pages[index]).second) {
      throw Error(
          ErrorKind::InvalidArgument,
          "pages must not repeat a page. index=" + std::to_string(index) +
              ", page=" + std::to_string(pages[index]));
    }
  }
  return assemblePages({PageSelection{shared_from_this(), pages}});
}

namespace {

// Checks the selections and locks every distinct document they use. Locks are
// taken in address order, so two assemblies over the same documents cannot
// deadlock.
std::vector<std::unique_lock<std::mutex>> lockDocuments(const std::vector<PageSelection>& selections) {
  if (selections.empty()) {
    throw Error(ErrorKind::InvalidArgument, "selections must not be empty");
  }
  std::vector<Document*> documents;
  for (std::size_t index = 0; index < selections.size(); ++index) {
    const PageSelection& selection = selections[index];
    if (!selection.document) {
      throw Error(ErrorKind::InvalidArgument, "selection has no document. index=" + std::to_string(index));
    }
    if (selection.pages.empty()) {
      throw Error(ErrorKind::InvalidArgument, "pages must not be empty. index=" + std::to_string(index));
    }
    for (std::uint32_t page : selection.pages) {
      if (page < 1 || page > selection.document->pageCount()) {
        throw Error(
            ErrorKind::InvalidArgument,
            "page must be between 1 and pageCount. page=" + std::to_string(page) +
                ", pageCount=" + std::to_string(selection.document->pageCount()) +
                ", index=" + std::to_string(index));
      }
    }
    documents.push_back(selection.document.get());
  }
  std::sort(documents.begin(), documents.end());
  documents.erase(std::unique(documents.begin(), documents.end()), documents.end());

  std::vector<std::unique_lock<std::mutex>> locks;
  for (Document* document : documents) {
    locks.emplace_back(document->impl().mutex);
  }
  return locks;
}

// Copies the selected pages into a new PDF and writes it. `configureOutput` picks
// the destination; `collectOutput` runs after the write, still under the locks.
// qpdf copies pages lazily: stream data is read from the source documents while
// the output is written, so the source locks are held until the write is done.
void assemble(
    const std::vector<PageSelection>& selections,
    const std::function<void(QPDFWriter&)>& configureOutput,
    const std::function<void(QPDFWriter&)>& collectOutput) {
  auto locks = lockDocuments(selections);

  QPDF output;
  output.setSuppressWarnings(true);
  output.emptyPDF();
  QPDFPageDocumentHelper output_pages(output);
  PDFVersion version;
  for (const PageSelection& selection : selections) {
    Document::Impl& source = selection.document->impl();
    version.updateIfGreater(source.qpdf.getVersionAsPDFVersion());
    for (std::uint32_t page : selection.pages) {
      // For a page of another document qpdf first pushes inherited page
      // attributes (/Resources, /MediaBox, ...) down onto the page, then copies
      // the page and everything it references. A page that was already added is
      // shallow-copied rather than added twice.
      output_pages.addPage(source.pages[page - 1], false);
    }
  }

  QPDFWriter writer(output);
  writer.setMinimumPDFVersion(version);
  // Keep streams exactly as they are in the source: no recompression, no decoding.
  writer.setStreamDataMode(qpdf_s_preserve);
  // A newline before every `endstream`, as the PDF specification asks.
  writer.setNewlineBeforeEndstream(true);
  // The same input and page list always produce the same bytes.
  writer.setDeterministicID(true);
  configureOutput(writer);
  writer.write();
  collectOutput(writer);
}

}  // namespace

Bytes assemblePages(const std::vector<PageSelection>& selections) {
  Bytes result;
  internal::runGuarded([&] {
    assemble(
        selections,
        [](QPDFWriter& writer) { writer.setOutputMemory(); },
        [&](QPDFWriter& writer) {
          std::shared_ptr<Buffer> buffer = writer.getBufferSharedPointer();
          result.assign(buffer->getBuffer(), buffer->getBuffer() + buffer->getSize());
        });
  });
  return result;
}

std::string qpdfVersion() { return QPDF::QPDFVersion(); }

namespace internal {

void assemblePagesToFile(const std::vector<PageSelection>& selections, const std::string& output_path) {
  runGuarded([&] {
    assemble(
        selections,
        [&](QPDFWriter& writer) { writer.setOutputFilename(output_path.c_str()); },
        [](QPDFWriter&) {});
  });
}

}  // namespace internal

}  // namespace qpdf_node
