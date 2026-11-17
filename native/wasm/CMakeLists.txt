# Emscripten (WebAssembly) module over the same core as the Node addon.
# Configure with emcmake; see README.md ("WebAssembly build"). Path-based
# operations (merge, splitPages, pageCount on files) are not exposed: the module
# only works on bytes in memory.
if(NOT EMSCRIPTEN)
  message(FATAL_ERROR
    "QPDF_NODE_BUILD_WASM needs Emscripten. Configure with: emcmake cmake -S . -B build/wasm")
endif()

add_executable(qpdf_wasm wasm_bindings.cc)
target_link_libraries(qpdf_wasm PRIVATE pdf_core embind)
set_target_properties(qpdf_wasm PROPERTIES
  OUTPUT_NAME qpdf-core
  SUFFIX ".mjs"
  RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}")
target_link_options(qpdf_wasm PRIVATE
  -sMODULARIZE=1
  -sEXPORT_ES6=1
  -sEXPORT_NAME=createQpdfCore
  # Runs in a page, a Web Worker, or Node.js.
  -sENVIRONMENT=web,worker,node
  -sALLOW_MEMORY_GROWTH=1
  -sMAXIMUM_MEMORY=4GB
  # qpdf recurses while parsing; the default 64 KiB stack is too small.
  -sSTACK_SIZE=2MB)
