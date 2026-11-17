add_library(pdf_core STATIC
  page_range.cc
  document.cc
  file_operations.cc)
target_include_directories(pdf_core PUBLIC ${CMAKE_CURRENT_SOURCE_DIR})
target_link_libraries(pdf_core PUBLIC libqpdf)
