# Pinned third-party sources, fetched at configure time. Every dependency is
# pinned to a full commit hash so that a moved or re-tagged ref cannot change
# the build. For an offline build of qpdf or zlib, pass
# -DFETCHCONTENT_SOURCE_DIR_QPDF=<dir> (or _ZLIB) pointing at a checkout of the
# pinned commit.
#
#   qpdf            v12.4.2   Apache-2.0
#   zlib            v1.3.1    zlib license
#   libjpeg-turbo   3.1.4.1   IJG / BSD-3-Clause / zlib
#
# qpdf needs zlib and libjpeg. They are built from the pinned sources below
# rather than taken from the system, so native and WebAssembly builds link the
# same versions. Crypto uses qpdf's built-in implementation (no OpenSSL/GnuTLS).

include(FetchContent)

set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)

FetchContent_Declare(zlib
  GIT_REPOSITORY https://github.com/madler/zlib.git
  GIT_TAG 51b7f2abdade71cd9bb0e7a373ef2610ec6f9daf # v1.3.1
  GIT_SHALLOW OFF
  EXCLUDE_FROM_ALL)
FetchContent_Declare(qpdf
  GIT_REPOSITORY https://github.com/qpdf/qpdf.git
  GIT_TAG 4eba95899886e851cc41d76886483b347612f2a8 # v12.4.2
  GIT_SHALLOW OFF
  EXCLUDE_FROM_ALL)

# --- zlib -------------------------------------------------------------------
set(ZLIB_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(SKIP_INSTALL_ALL ON CACHE BOOL "" FORCE)
FetchContent_MakeAvailable(zlib)
# zlib's build writes zconf.h next to its own binary dir.
set(QPDF_NODE_ZLIB_INCLUDE_DIRS "${zlib_SOURCE_DIR}" "${zlib_BINARY_DIR}")

# --- libjpeg-turbo ----------------------------------------------------------
# libjpeg-turbo's build system refuses to be added with add_subdirectory(), so
# it is built by a nested CMake run (ExternalProject) at build time and
# installed under the build directory. qpdf only needs the libjpeg API for its
# optional DCT filter; SIMD is off so no NASM is needed and every platform
# builds the same code.
include(ExternalProject)
set(QPDF_NODE_JPEG_PREFIX "${CMAKE_BINARY_DIR}/libjpeg-turbo-install")
if(MSVC)
  set(QPDF_NODE_JPEG_LIBRARY "${QPDF_NODE_JPEG_PREFIX}/lib/jpeg-static.lib")
else()
  set(QPDF_NODE_JPEG_LIBRARY "${QPDF_NODE_JPEG_PREFIX}/lib/libjpeg.a")
endif()
set(QPDF_NODE_JPEG_FORWARDED_ARGS)
foreach(variable
    CMAKE_TOOLCHAIN_FILE CMAKE_C_COMPILER CMAKE_OSX_ARCHITECTURES
    CMAKE_OSX_DEPLOYMENT_TARGET CMAKE_OSX_SYSROOT)
  if(DEFINED ${variable} AND NOT "${${variable}}" STREQUAL "")
    list(APPEND QPDF_NODE_JPEG_FORWARDED_ARGS "-D${variable}=${${variable}}")
  endif()
endforeach()
ExternalProject_Add(libjpeg_turbo_ep
  GIT_REPOSITORY https://github.com/libjpeg-turbo/libjpeg-turbo.git
  GIT_TAG 9217719d3a58633923b096af4c1d50d304768a64 # 3.1.4.1
  PREFIX "${CMAKE_BINARY_DIR}/libjpeg-turbo"
  INSTALL_DIR "${QPDF_NODE_JPEG_PREFIX}"
  CMAKE_ARGS
    -DCMAKE_BUILD_TYPE=${CMAKE_BUILD_TYPE}
    -DCMAKE_INSTALL_PREFIX=<INSTALL_DIR>
    -DCMAKE_INSTALL_LIBDIR=lib
    -DCMAKE_POSITION_INDEPENDENT_CODE=ON
    -DENABLE_SHARED=OFF
    -DENABLE_STATIC=ON
    -DWITH_SIMD=OFF
    -DWITH_TURBOJPEG=OFF
    -DWITH_TOOLS=OFF
    -DWITH_TESTS=OFF
    -DWITH_FUZZ=OFF
    -DWITH_JAVA=OFF
    ${QPDF_NODE_JPEG_FORWARDED_ARGS}
  BUILD_BYPRODUCTS "${QPDF_NODE_JPEG_LIBRARY}")

# --- qpdf -------------------------------------------------------------------
set(BUILD_STATIC_LIBS ON CACHE BOOL "" FORCE)
set(USE_IMPLICIT_CRYPTO OFF CACHE BOOL "" FORCE)
set(REQUIRE_CRYPTO_NATIVE ON CACHE BOOL "" FORCE)
set(GENERATE_AUTO_JOB OFF CACHE BOOL "" FORCE)
set(BUILD_DOC OFF CACHE BOOL "" FORCE)
set(INSTALL_EXAMPLES OFF CACHE BOOL "" FORCE)
set(INSTALL_PKGCONFIG OFF CACHE BOOL "" FORCE)
set(INSTALL_CMAKE_PACKAGE OFF CACHE BOOL "" FORCE)
set(WERROR OFF CACHE BOOL "" FORCE)
# qpdf locates zlib and libjpeg with pkg-config first, then find_path/find_library.
# Pointing the cache variables of the second route at the pinned targets makes
# it skip the search; an empty pkg-config search path stops the first route
# from finding a system copy.
file(MAKE_DIRECTORY "${CMAKE_BINARY_DIR}/empty-pkgconfig")
set(ENV{PKG_CONFIG_LIBDIR} "${CMAKE_BINARY_DIR}/empty-pkgconfig")
set(ENV{PKG_CONFIG_PATH} "")
set(ZLIB_H_PATH "${QPDF_NODE_ZLIB_INCLUDE_DIRS}" CACHE STRING "" FORCE)
set(ZLIB_LIB_PATH zlibstatic CACHE STRING "" FORCE)
set(LIBJPEG_H_PATH "${QPDF_NODE_JPEG_PREFIX}/include" CACHE STRING "" FORCE)
set(LIBJPEG_LIB_PATH "${QPDF_NODE_JPEG_LIBRARY}" CACHE STRING "" FORCE)
FetchContent_MakeAvailable(qpdf)
# qpdf builds its object library without PIC even for static archives.
set_target_properties(libqpdf_object PROPERTIES POSITION_INDEPENDENT_CODE ON)
add_dependencies(libqpdf_object libjpeg_turbo_ep)
