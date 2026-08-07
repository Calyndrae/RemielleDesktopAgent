// `defineConfig` comes from vitest so the `test` block is typed; it re-exports
// Vite's own config type unchanged.
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const rootDir = dirname(fileURLToPath(import.meta.url));

// Tauri drives this dev server; the fixed port and host come from tauri.conf.json.
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react()],

  // Mirrors the `@/*` path mapping in tsconfig.json.
  resolve: {
    alias: { "@": resolve(rootDir, "src") },
  },

  // Tauri's CLI owns the terminal output — don't wipe its messages.
  clearScreen: false,

  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    // Spread rather than assign `undefined`: `exactOptionalPropertyTypes` draws
    // a distinction between "absent" and "explicitly undefined".
    ...(host ? { hmr: { protocol: "ws", host, port: 1421 } } : {}),
    watch: { ignored: ["**/src-tauri/**"] },
  },

  // Expose TAURI_ENV_* to the frontend so we can branch on target platform.
  envPrefix: ["VITE_", "TAURI_ENV_"],

  build: {
    // Windows ships WebView2 (Chromium); this is the floor we target.
    target: "chrome105",
    // Vite 8 minifies with oxc; esbuild is no longer bundled.
    minify: process.env.TAURI_ENV_DEBUG ? false : "oxc",
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
    rollupOptions: {
      input: {
        overlay: resolve(rootDir, "index.html"),
        settings: resolve(rootDir, "settings.html"),
        // Dev-only layout harness; kept out of the shipped bundle.
        ...(process.env.BUILD_HARNESS === "1"
          ? { harness: resolve(rootDir, "harness.html") }
          : {}),
        // Browser demo of the real components; also excluded from the app bundle.
        ...(process.env.BUILD_DEMO === "1"
          ? { demo: resolve(rootDir, "demo.html") }
          : {}),
      },
    },
  },

  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
