import { Profiler, StrictMode, useEffect } from "react";
import { createRoot as createStandardRoot } from "react-dom/client";
import "@xyflow/react/dist/style.css";
import { App } from "./App";
import { RendererErrorBoundary } from "./components/RendererErrorBoundary";
import { LicenseGate } from "./components/license";
import { canvasPerformance } from "./lib/performance/canvas-performance";
import { PERF_ENABLED } from "./lib/performance/perf-flag";
import {
  startCanvasPerformanceHarness,
  type ReactProfilerBuild,
} from "./lib/performance/perf-harness";
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

type CreateRoot = typeof createStandardRoot;

/**
 * React's production build compiles `Profiler.onRender` out — the callback is
 * not merely skipped, the call site does not exist in
 * react-dom-client.production.js. A packaged build therefore reports zero
 * React commits forever unless the tree is mounted by react-dom's profiling
 * build, which is the same production reconciler plus the profiler timers.
 *
 * Loaded only when VELLUM_PERF is on, so it code-splits away from the boot
 * chunk and the shipped default path is byte-for-byte the standard client.
 */
const loadProfilingCreateRoot = async (): Promise<CreateRoot | undefined> => {
  try {
    const module = (await import("react-dom/profiling")) as unknown as {
      readonly createRoot?: CreateRoot;
      readonly default?: { readonly createRoot?: CreateRoot };
    };
    return module.createRoot ?? module.default?.createRoot;
  } catch {
    return undefined;
  }
};

const mount = (createRoot: CreateRoot, reactBuild: ReactProfilerBuild): void => {
  startCanvasPerformanceHarness({ reactBuild });
  const tree = (
    <StrictMode>
      <LicensedRoot />
    </StrictMode>
  );
  createRoot(root).render(
    PERF_ENABLED ? (
      <Profiler
        id="root"
        onRender={(_id, _phase, actualDuration) => {
          canvasPerformance.recordReactCommit("root", actualDuration);
        }}
      >
        {tree}
      </Profiler>
    ) : (
      tree
    ),
  );
};

if (PERF_ENABLED) {
  void loadProfilingCreateRoot().then((profilingCreateRoot) => {
    mount(profilingCreateRoot ?? createStandardRoot, profilingCreateRoot ? "profiling" : "standard");
  });
} else {
  mount(createStandardRoot, "standard");
}
