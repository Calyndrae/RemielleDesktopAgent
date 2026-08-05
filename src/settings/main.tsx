import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

/**
 * Settings window placeholder.
 *
 * The window entry point exists from the start so the multi-page Vite build and
 * the Tauri capability list are wired correctly; the real settings UI lands in
 * M6.
 */
function SettingsApp() {
  return (
    <main style={{ padding: 24, fontFamily: "system-ui, sans-serif" }}>
      <h1 style={{ fontSize: 18, margin: "0 0 8px" }}>设置 / Settings</h1>
      <p style={{ color: "#666", margin: 0 }}>Coming in M6.</p>
    </main>
  );
}

const container = document.getElementById("root");
if (!container) throw new Error("settings root element is missing");

createRoot(container).render(
  <StrictMode>
    <SettingsApp />
  </StrictMode>,
);
