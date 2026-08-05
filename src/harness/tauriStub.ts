/**
 * Minimal stand-in for the Tauri IPC bridge.
 *
 * Imported first by the layout harness so the panel's fire-and-forget calls
 * (`setHitRegions` and friends) resolve quietly in a plain browser. Without it
 * `invoke` throws on a missing bridge and the harness never mounts.
 */

declare global {
  interface Window {
    __TAURI_INTERNALS__?: Record<string, unknown>;
  }
}

window.__TAURI_INTERNALS__ ??= {
  invoke: async () => undefined,
  transformCallback: (callback: unknown) => callback,
  convertFileSrc: (path: string) => path,
  metadata: { currentWindow: { label: "harness" }, currentWebview: { label: "harness" } },
};

export {};
