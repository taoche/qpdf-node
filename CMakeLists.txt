cmake_minimum_required(VERSION 3.20)
project(qpdf_node VERSION 0.2.0 LANGUAGES C CXX)

# One shared C++ core (native/core) on top of qpdf, with two bindings:
#   QPDF_NODE_BUILD_ADDON  Node.js N-API addon (native/node), built by cmake-js.
#   QPDF_NODE_BUILD_WASM   Emscripten module (native/wasm); defaults to ON under emcmake.
# See README.md for the exact commands.

option(QPDF_NODE_BUILD_ADDON "Build the Node.js N-API addon" OFF)
option(QPDF_NODE_BUILD_WASM "Build the Emscripten WebAssembly module" ${EMSCRIPTEN})

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_C_VISIBILITY_PRESET hidden)
set(CMAKE_CXX_VISIBILITY_PRESET hidden)
set(CMAKE_VISIBILITY_INLINES_HIDDEN ON)
# The static archives below end up inside a shared library (the addon).
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

if(NOT CMAKE_BUILD_TYPE AND NOT CMAKE_CONFIGURATION_TYPES)
  set(CMAKE_BUILD_TYPE Release CACHE STRING "" FORCE)
endif()

if(EMSCRIPTEN)
  # qpdf reports errors with C++ exceptions.
  add_compile_options(-fwasm-exceptions)
  add_link_options(-fwasm-exceptions)
endif()

include(cmake/ThirdParty.cmake)

add_subdirectory(native/core)
if(QPDF_NODE_BUILD_ADDON)
  add_subdirectory(native/node)
endif()
if(QPDF_NODE_BUILD_WASM)
  add_subdirectory(native/wasm)
endif()
