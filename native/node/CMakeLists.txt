# Node.js N-API addon. Built through cmake-js (see packages/node/package.json),
# which provides CMAKE_JS_INC / CMAKE_JS_SRC / CMAKE_JS_LIB.

# node-addon-api is an npm dependency of packages/node.
set(QPDF_NODE_PACKAGE_DIR "${CMAKE_SOURCE_DIR}/packages/node"
    CACHE PATH "Directory of the npm package that depends on node-addon-api")
execute_process(
  COMMAND node -p "require('node-addon-api').include_dir"
  WORKING_DIRECTORY "${QPDF_NODE_PACKAGE_DIR}"
  OUTPUT_VARIABLE NODE_ADDON_API_DIR
  OUTPUT_STRIP_TRAILING_WHITESPACE
  RESULT_VARIABLE node_addon_api_result)
if(NOT node_addon_api_result EQUAL 0 OR NOT NODE_ADDON_API_DIR)
  message(FATAL_ERROR
    "Cannot locate node-addon-api. Run `pnpm install` first. QPDF_NODE_PACKAGE_DIR=${QPDF_NODE_PACKAGE_DIR}")
endif()
string(REPLACE "\"" "" NODE_ADDON_API_DIR "${NODE_ADDON_API_DIR}")

add_library(qpdf_node SHARED addon.cc ${CMAKE_JS_SRC})
set_target_properties(qpdf_node PROPERTIES PREFIX "" SUFFIX ".node")
target_include_directories(qpdf_node PRIVATE ${CMAKE_JS_INC} ${NODE_ADDON_API_DIR})
target_compile_definitions(qpdf_node PRIVATE
  NAPI_VERSION=8
  # No C++ exception may cross the N-API boundary: errors are returned as
  # rejected promises.
  NAPI_DISABLE_CPP_EXCEPTIONS)
target_link_libraries(qpdf_node PRIVATE pdf_core ${CMAKE_JS_LIB})
