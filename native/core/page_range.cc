#include <cstddef>
#include <limits>

#include "pdf_core.hh"

namespace qpdf_node {

namespace {

[[noreturn]] void invalidSyntax(const std::string& text, std::size_t position, const char* reason) {
  throw Error(
      ErrorKind::InvalidArgument,
      std::string("page range is not valid: ") + reason + ". range=\"" + text +
          "\", position=" + std::to_string(position));
}

}  // namespace

PageRange PageRange::parse(const std::string& text) {
  PageRange range;
  std::size_t position = 0;

  auto parseBound = [&]() -> Bound {
    bool from_end = false;
    if (position < text.size() && text[position] == 'z') {
      ++position;
      return Bound{true, 1};
    }
    if (position < text.size() && text[position] == 'r') {
      from_end = true;
      ++position;
    }
    std::size_t digits_start = position;
    std::uint64_t number = 0;
    while (position < text.size() && text[position] >= '0' && text[position] <= '9') {
      number = number * 10 + static_cast<std::uint64_t>(text[position] - '0');
      if (number > std::numeric_limits<std::uint32_t>::max()) {
        invalidSyntax(text, digits_start, "page number is too large");
      }
      ++position;
    }
    if (position == digits_start) {
      invalidSyntax(text, position, "expected a page number, \"z\", or \"r\" and a page number");
    }
    if (number == 0) {
      invalidSyntax(text, digits_start, "page numbers start at 1");
    }
    return Bound{from_end, static_cast<std::uint32_t>(number)};
  };

  if (text.empty()) {
    invalidSyntax(text, 0, "range is empty");
  }
  while (true) {
    Bound first = parseBound();
    Bound last = first;
    if (position < text.size() && text[position] == '-') {
      ++position;
      last = parseBound();
    }
    range.parts_.push_back(Part{first, last});
    if (position == text.size()) {
      break;
    }
    if (text[position] != ',') {
      invalidSyntax(text, position, "expected \",\" or the end of the range");
    }
    ++position;
  }
  return range;
}

std::vector<std::uint32_t> PageRange::resolve(std::uint32_t page_count) const {
  // Only called for bounds that checkInBounds accepted.
  auto toPage = [&](const Bound& bound) -> std::uint32_t {
    return bound.from_end ? page_count - bound.number + 1 : bound.number;
  };
  auto checkInBounds = [&](const Bound& bound) {
    if (bound.number > page_count) {
      throw Error(
          ErrorKind::OperationFailed,
          std::string("page is out of bounds. page=") + (bound.from_end ? "r" : "") +
              std::to_string(bound.number) + ", pageCount=" + std::to_string(page_count));
    }
  };

  std::vector<std::uint32_t> pages;
  for (const Part& part : parts_) {
    checkInBounds(part.first);
    checkInBounds(part.last);
    std::uint32_t from = toPage(part.first);
    std::uint32_t to = toPage(part.last);
    if (from <= to) {
      for (std::uint32_t page = from; page <= to; ++page) {
        pages.push_back(page);
      }
    } else {
      for (std::uint32_t page = from; page >= to; --page) {
        pages.push_back(page);
      }
    }
  }
  return pages;
}

}  // namespace qpdf_node
