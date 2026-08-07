import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const rootDir = dirname(fileURLToPath(import.meta.url));

/**
 * Dedicated build for the standalone browser demo.
 *
 * Separate from the app config for one reason: the inliner in
 * `scripts/build-demo.mjs` needs exactly one JS chunk and one CSS file to work
 * from. The app build splits React and the font stylesheet into shared chunks
 * that a single HTML file cannot reference once it is detached from `dist/`.
 */
export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@": resolve(rootDir, "src") } },
  build: {
    outDir: "dist-demo",
    emptyOutDir: true,
    target: "chrome105",
    minify: "oxc",
    cssCodeSplit: false,
    // Font subsets stay as separate files so the inliner can pick only the
    // ranges the page actually uses instead of embedding all 6 MB.
    assetsInlineLimit: 0,
    rollupOptions: {
      input: resolve(rootDir, "demo.html"),
      output: {
        inlineDynamicImports: true,
        entryFileNames: "assets/[name].js",
        assetFileNames: "assets/[name][extname]",
      },
    },
  },
});
