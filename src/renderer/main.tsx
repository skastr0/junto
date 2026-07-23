import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@xyflow/react/dist/style.css";
import { App } from "./App";
import "./styles.css";

// Dev-only render highlighter (https://github.com/aidenybai/react-scan).
// Import before createRoot so the scanner can instrument React.
if (import.meta.env.DEV) {
  void import("react-scan").then(({ scan }) => {
    scan({ enabled: true, showToolbar: true, animationSpeed: "fast" });
  });
}

const root = document.getElementById("root");

if (!root) {
  throw new Error("Missing root element");
}

// Main owns platform-sensitive authority. This marker only selects renderer
// geometry and copy; it never grants an OS capability.
document.documentElement.dataset.vellumPlatform = window.vellum?.platform ?? "unknown";

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
