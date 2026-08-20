// manifest.json and background.js never go through Rollup: the manifest is
// plain declarative JSON, and background.js has no imports from src/ and no
// React dependency - running it through the bundler would only add an HMR
// surface that behaves oddly inside a service worker, for no benefit.
import { copyFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outDir = path.join(root, "dist");

for (const file of ["manifest.json", "background.js"]) {
  await copyFile(path.join(root, file), path.join(outDir, file));
}
