import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { SettingsApp } from "./App";
import "@/assets/fonts/noto-serif-sc.css";
import "@/styles/settings.css";

const container = document.getElementById("root");
if (!container) throw new Error("settings root element is missing");

createRoot(container).render(
  <StrictMode>
    <SettingsApp />
  </StrictMode>,
);
