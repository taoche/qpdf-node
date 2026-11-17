import { loadNativeBindingForCurrentProcess } from "./native-loader";
import type { NativeBinding } from "./native-binding";

// `__dirname` is `src/` or `dist/`, both one level below the package root.
export const native: NativeBinding = loadNativeBindingForCurrentProcess(__dirname);
