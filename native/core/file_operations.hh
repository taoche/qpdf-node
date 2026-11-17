// Path-based operations (merge, split, page count). Not part of the WebAssembly
// build, which has no file system access.
#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

#include "pdf_core.hh"

namespace qpdf_node {

struct MergeInput {
  std::string path;
  std::optional<PageRange> pages;  // empty: every page
};

struct MergeRequest {
  std::vector<MergeInput> inputs;
  std::string output;
  std::string password;  // "": none
};

struct SplitPagesRequest {
  std::string input;
  // Contains exactly one "%d".
  std::string output_pattern;
  std::uint32_t pages_per_file = 1;
  std::string password;
};

// Each validate function throws InvalidArgument without touching the file
// system, so a binding can reject a bad request before queueing any work. The
// operations below call them too.
void validate(const MergeRequest& request);
void validate(const SplitPagesRequest& request);

// Concatenates the inputs, in order, into request.output. The output appears
// atomically (written beside it, then renamed) and is never one of the inputs.
void merge(const MergeRequest& request);

// One file per page, or per chunk of pages_per_file pages. With one page per
// file, "%d" is the original page number zero-padded to the width of the last
// page number; with larger chunks it is the 1-based chunk number zero-padded to
// the width of the chunk count. Files are written one after another, each
// atomically; a failure part-way leaves the files already written.
void splitPages(const SplitPagesRequest& request);

std::uint32_t pageCount(const std::string& path, const std::string& password);

}  // namespace qpdf_node
