import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import "@xyflow/react/dist/style.css";
import { App } from "./App";
import { RendererErrorBoundary } from "./components/RendererErrorBoundary";
import { LicenseGate } from "./components/license";
import { seedGateThemePreference, startThemeMode } from "./lib/theme-mode";
import "./styles.css";

// Dev-only render highlighter (https://github.com/aidenybai/react-scan).
// Import before createRoot so the scanner can instrument React.
// Off by default (heavy on React Flow canvases) — opt in per machine with:
//   localStorage.setItem("vellum-command:react-scan", "on")
if (import.meta.env.DEV && localStorage.getItem("vellum-command:react-scan") === "on") {
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
document.documentElement.dataset.vellumPlatform = window.vellumCommand?.platform ?? "unknown";

function LicensedRoot() {
  const api = window.vellumCommand;

  useEffect(() => {
    // Both the activation-only surface and the admitted product shell satisfy
    // main's renderer-readiness challenge.
    api?.rendererSurfaceReady();
    // The gate mounts before product admission (settings IPC still closed),
    // so its saved theme arrives through the license recovery plane. Both
    // starters are idempotent; App re-runs them post-admission.
    startThemeMode();
    void api
      ?.licenseGateThemeGet()
      .then(seedGateThemePreference)
      .catch(() => undefined);
  }, [api]);

  if (!api) {
    return (
      <main className="license-gate">
        <section className="license-gate__fallback" role="alert">
          Electron preload bridge is not available.
        </section>
      </main>
    );
  }

  return (
    <LicenseGate api={api}>
      <RendererErrorBoundary title="This window hit a render error">
        <App />
      </RendererErrorBoundary>
    </LicenseGate>
  );
}

createRoot(root).render(
  <StrictMode>
    <LicensedRoot />
  </StrictMode>,
);
