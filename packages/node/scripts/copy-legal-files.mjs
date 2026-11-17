// Copies the repository-level license files next to package.json so that
// `npm pack` / `npm publish` ships them. Runs as the `prepack` script.

import { copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageDirectory = join(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = join(packageDirectory, "..", "..");

for (const fileName of ["LICENSE", "THIRD_PARTY_NOTICES.md", "README.md"]) {
  copyFileSync(join(repositoryRoot, fileName), join(packageDirectory, fileName));
}
