import type { NativeBinding } from "./native-binding";

/**
 * Loads the addon that `pnpm run build:native` (cmake-js) writes to
 * `build/Release`. This file sits one directory below the package root both in
 * `src/` and in `dist/`, so the same relative path works for both.
 */
function loadNativeBinding(): NativeBinding {
  try {
    return require("../build/Release/qpdf_node.node") as NativeBinding;
  } catch (error) {
    throw new Error(
      "qpdf-node native addon could not be loaded from build/Release/qpdf_node.node. " +
        "Build it with `pnpm run build:native` (needs CMake and a C++20 compiler).",
      { cause: error },
    );
  }
}

export const native: NativeBinding = loadNativeBinding();
