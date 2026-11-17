import { native } from "./native";

/** The qpdf library version compiled into the addon, e.g. `"12.4.2"`. */
export function qpdfVersion(): string {
  return native.qpdfVersion();
}
