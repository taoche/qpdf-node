// Helpers shared by the core's translation units. Not part of the public core
// API.
#pragma once

#include <functional>
#include <string>

#include "pdf_core.hh"

namespace qpdf_node::internal {

// Runs `work`, converting anything it throws into qpdf_node::Error.
void runGuarded(const std::function<void()>& work);

// Like assemblePages, but writes the PDF to `output_path` (replacing it) instead
// of returning bytes. Not atomic; callers that need atomicity write to a
// temporary path and rename.
void assemblePagesToFile(const std::vector<PageSelection>& selections, const std::string& output_path);

}  // namespace qpdf_node::internal
