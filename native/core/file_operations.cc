#include "file_operations.hh"

#include <algorithm>
#include <atomic>
#include <filesystem>
#include <system_error>

#include "internal.hh"

namespace qpdf_node {

namespace fs = std::filesystem;

namespace {

std::atomic<std::uint64_t> temporary_counter{0};

// Runs `write(path)` against a file beside `final_path`, then renames it into
// place, so readers never see a half-written output.
template <typename Write>
void writeAtomically(const std::string& final_path, Write write) {
  std::string temporary_path =
      final_path + ".tmp-" + std::to_string(temporary_counter.fetch_add(1));
  try {
    write(temporary_path);
    std::error_code error;
    fs::rename(temporary_path, final_path, error);
    if (error) {
      throw Error(
          ErrorKind::OperationFailed,
          "could not move the output into place. output=" + final_path + ": " + error.message());
    }
  } catch (...) {
    std::error_code ignored;
    fs::remove(temporary_path, ignored);
    throw;
  }
}

std::string zeroPadded(std::uint64_t number, std::size_t width) {
  std::string digits = std::to_string(number);
  return std::string(digits.size() < width ? width - digits.size() : 0, '0') + digits;
}

std::string substitutePlaceholder(const std::string& pattern, const std::string& number) {
  std::string result = pattern;
  result.replace(result.find("%d"), 2, number);
  return result;
}

std::size_t countPlaceholders(const std::string& pattern) {
  std::size_t count = 0;
  for (std::size_t at = pattern.find("%d"); at != std::string::npos; at = pattern.find("%d", at + 2)) {
    ++count;
  }
  return count;
}

}  // namespace

void validate(const MergeRequest& request) {
  if (request.inputs.empty()) {
    throw Error(ErrorKind::InvalidArgument, "merge requires at least one input. inputs=[]");
  }
  if (request.output.empty()) {
    throw Error(ErrorKind::InvalidArgument, "merge output must not be empty");
  }
  for (std::size_t index = 0; index < request.inputs.size(); ++index) {
    if (request.inputs[index].path.empty()) {
      throw Error(
          ErrorKind::InvalidArgument, "merge inputs[" + std::to_string(index) + "] path must not be empty");
    }
  }
}

void validate(const SplitPagesRequest& request) {
  if (request.input.empty()) {
    throw Error(ErrorKind::InvalidArgument, "splitPages input must not be empty");
  }
  std::size_t placeholders = countPlaceholders(request.output_pattern);
  if (placeholders != 1) {
    throw Error(
        ErrorKind::InvalidArgument,
        "splitPages outputPattern must contain exactly one \"%d\". placeholderCount=" +
            std::to_string(placeholders) + ", outputPattern=" + request.output_pattern);
  }
  if (request.pages_per_file == 0) {
    throw Error(ErrorKind::InvalidArgument, "splitPages pagesPerFile must be at least 1. pagesPerFile=0");
  }
}

void merge(const MergeRequest& request) {
  validate(request);

  std::vector<PageSelection> selections;
  for (std::size_t index = 0; index < request.inputs.size(); ++index) {
    const MergeInput& input = request.inputs[index];
    std::error_code error;
    if (fs::equivalent(input.path, request.output, error)) {
      throw Error(
          ErrorKind::InvalidArgument,
          "merge output must not be the same file as an input. inputIndex=" + std::to_string(index) +
              ", path=" + request.output);
    }
    std::shared_ptr<Document> document;
    try {
      document = Document::openFile(input.path, request.password);
    } catch (const Error& cause) {
      throw Error(
          cause.kind(),
          "merge could not read input. inputIndex=" + std::to_string(index) + ", path=" + input.path +
              ": " + cause.what());
    }
    std::vector<std::uint32_t> pages;
    if (input.pages) {
      try {
        pages = input.pages->resolve(document->pageCount());
      } catch (const Error& cause) {
        throw Error(
            cause.kind(),
            "merge inputs[" + std::to_string(index) + "].pages cannot be applied. path=" + input.path +
                ": " + cause.what());
      }
    } else {
      for (std::uint32_t page = 1; page <= document->pageCount(); ++page) {
        pages.push_back(page);
      }
    }
    if (pages.empty()) {
      continue;  // an input with no pages contributes nothing
    }
    selections.push_back(PageSelection{document, pages});
  }
  if (selections.empty()) {
    throw Error(ErrorKind::OperationFailed, "merge has no pages to write. output=" + request.output);
  }

  writeAtomically(request.output, [&](const std::string& temporary_path) {
    internal::assemblePagesToFile(selections, temporary_path);
  });
}

void splitPages(const SplitPagesRequest& request) {
  validate(request);

  std::shared_ptr<Document> document;
  try {
    document = Document::openFile(request.input, request.password);
  } catch (const Error& cause) {
    throw Error(cause.kind(), "splitPages could not read input. path=" + request.input + ": " + cause.what());
  }
  std::uint32_t page_count = document->pageCount();
  if (page_count == 0) {
    throw Error(ErrorKind::OperationFailed, "splitPages input has no pages. path=" + request.input);
  }

  std::uint32_t pages_per_file = request.pages_per_file;
  std::uint64_t file_count = (static_cast<std::uint64_t>(page_count) + pages_per_file - 1) / pages_per_file;
  std::size_t width = std::to_string(pages_per_file == 1 ? page_count : file_count).size();

  for (std::uint64_t file_index = 0; file_index < file_count; ++file_index) {
    std::uint32_t first_page = static_cast<std::uint32_t>(file_index * pages_per_file + 1);
    std::uint32_t last_page = static_cast<std::uint32_t>(
        std::min<std::uint64_t>(static_cast<std::uint64_t>(first_page) + pages_per_file - 1, page_count));
    std::vector<std::uint32_t> pages;
    for (std::uint32_t page = first_page; page <= last_page; ++page) {
      pages.push_back(page);
    }
    std::uint64_t number = pages_per_file == 1 ? first_page : file_index + 1;
    std::string output_path = substitutePlaceholder(request.output_pattern, zeroPadded(number, width));
    writeAtomically(output_path, [&](const std::string& temporary_path) {
      internal::assemblePagesToFile({PageSelection{document, pages}}, temporary_path);
    });
  }
}

std::uint32_t pageCount(const std::string& path, const std::string& password) {
  if (path.empty()) {
    throw Error(ErrorKind::InvalidArgument, "pageCount input must not be empty");
  }
  try {
    return Document::openFile(path, password)->pageCount();
  } catch (const Error& cause) {
    throw Error(cause.kind(), "pageCount could not read input. path=" + path + ": " + cause.what());
  }
}

}  // namespace qpdf_node
