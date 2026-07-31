import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import "@xyflow/react/dist/style.css";
import { App } from "./App";
import { LicenseGate } from "./components/license";
import "./styles.css";

const root = document.getElementById("root");

if (!root) {
  throw new Error("Missing root element");
}

// Main owns platform-sensitive authority. This marker only selects renderer
// geometry and copy; it never grants an OS capability.
document.documentElement.dataset.vellumPlatform = window.vellum?.platform ?? "unknown";

function LicensedRoot() {
  const api = window.vellum;

  useEffect(() => {
    // Both the activation-only surface and the admitted product shell satisfy
    // main's renderer-readiness challenge.
    api?.rendererSurfaceReady();
  }, [api]);

  if (!api) {
    return (
      <main className="license-gate">
        <section className="license-gate__panel" role="alert">
          Electron preload bridge is not available.
        </section>
      </main>
    );
  }

  return (
    <LicenseGate api={api}>
      <App />
    </LicenseGate>
  );
}

createRoot(root).render(
  <StrictMode>
    <LicensedRoot />
  </StrictMode>,
);
