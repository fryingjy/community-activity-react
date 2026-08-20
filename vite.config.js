import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

const __dirname = import.meta.dirname;

// Relative asset paths: the built page is served from chrome-extension://<id>/,
// not from a domain root, so root-absolute paths ("/assets/...") would still
// resolve correctly under that origin, but relative paths remove the
// ambiguity entirely.
export default defineConfig({
  base: "",
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        sidepanel: resolve(__dirname, "sidepanel.html"),
      },
    },
  },
});
