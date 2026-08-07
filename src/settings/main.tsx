import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { SettingsApp } from "./App";
import { applyTheme } from "@/lib/theme";
import "@/assets/fonts/noto-serif-sc.css";
import "@/styles/settings.css";

/*
 * Before the first paint, not in an effect.
 *
 * The stylesheet's base palette is light, so an unstamped root paints light for
 * as long as it takes React to mount — on a dark setup, a white window flashing
 * open. Resolving `auto` reads `matchMedia` synchronously with nothing async in
 * the way, so this costs one read and removes the flash. The stored preference
 * arrives a moment later in SettingsApp and corrects this if the user chose
 * something other than `auto`.
 */
applyTheme("auto");

const container = document.getElementById("root");
if (!container) throw new Error("settings root element is missing");

createRoot(container).render(
  <StrictMode>
    <SettingsApp />
  </StrictMode>,
);
