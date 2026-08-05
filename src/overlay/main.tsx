import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import "@/styles/overlay.css";

const container = document.getElementById("root");
if (!container) throw new Error("overlay root element is missing");

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
