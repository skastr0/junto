import { lazy, Suspense, useEffect } from "react";
import { ReactFlowProvider } from "@xyflow/react";
import { identityHints } from "../shared/connections";
import type { CanvasDoc } from "@shared/canvas";
import { batch } from "@legendapp/state";
import { use$ } from "@legendapp/state/react";
import { impactModeActive$ } from "./lib/impact-mode";
import { state$ } from "./lib/state";
import {
  acceptCanvasRevision,
  canvasMutationsQuiesced,
  clearAbandonedCanvas,
  getCanvasRevision,
  hasPendingCanvasChanges,
  loadDoc,
  prepareCanvasRemoval,
  replaceActiveActorRefs,
  redo,
  retrySave,
  undo,
} from "./lib/mutations";
import {
  flushCanvasEdits,
  quiesceAndFlushCanvasEdits,
  runCanvasAuthoringOperation,
} from "./lib/canvas-editor-flush";
import { makeCanvasExternalReloadCoordinator } from "./lib/canvas-external-reload";
import { startKernelBridge } from "./lib/kernel-view";
import { startSettingsBridge, closeSettings } from "./lib/settings-state";
import { startUpdateBridge } from "./lib/update-state";
import { subscribeAgentSeatState } from "./lib/agent-seat-state";
import { reconcileDockFromLiveSessions } from "./lib/dock-state";
import { startSurfaceMotionGate } from "./lib/surface-motion";
import { noteWorkDocChange } from "./lib/edge-sparks";
import { clearPreambles, showPreamble } from "./lib/preamble-state";
import { Canvas } from "./components/Canvas";
import { TopBar } from "./components/TopBar";
import { CanvasChrome } from "./components/CanvasChrome";

import { SettingsPanel } from "./components/SettingsPanel";
// Fleet pulls three.js + GLBs. Keep it out of the main chunk until open.
const FleetOverlay = lazy(async () => {
  const mod = await import("./components/fleet/FleetOverlay");
  return { default: mod.FleetOverlay };
});
import { StationRoleGate } from "./components/StationRoleGate";
import { HerdrWizard } from "./components/herdr/HerdrWizard";
import { HerdrTerminalModal } from "./components/herdr/HerdrTerminalModal";
import { HerdrToast } from "./components/herdr/HerdrToast";
import { WorkSurfaceDock } from "./components/WorkSurfaceDock";
import { WorkFocusShell } from "./components/workbench";
import { TooltipLayer } from "./components/TooltipLayer";
import { DemoCameraBridge } from "./demo/camera-bridge";
import { DemoLayer } from "./demo/demo-layer";
import { SEED_CANVAS_NAME } from "@shared/seed";
import {
  makeNavigationClock,
  makeNodeRefNavigationCoordinator,
} from "./lib/node-ref-navigation";

const setError = (error: unknown) =>
  state$.error.set(error instanceof Error ? error.message : String(error));

const refreshList = async () => {
  if (!window.vellum) return;
  state$.canvases.set(await window.vellum.listCanvases());
};

const refreshSnapshotsSoft = async (doc: CanvasDoc) => {
  if (!window.vellum) return;
  try {
    const snapshots = await Promise.race([
      window.vellum.refreshSnapshots(identityHints([doc], state$.snapshots.peek())),
      new Promise<null>((resolve) => window.setTimeout(() => resolve(null), 1500)),
    ]);
    if (snapshots) state$.snapshots.set(snapshots);
  } catch (error) {
    setError(error);
  }
};

const resetCanvasView = (): void => {
  batch(() => {
    state$.searchQuery.set("");
    state$.edgeFilter.set("");
    state$.flagFilter.set("");
    state$.selectedNodeId.set("");
    state$.selectedNodeIds.set([]);
    state$.selectedEdgeId.set("");
    state$.connectionFocusNodeId.set("");
    state$.focusNodeId.set("");
    state$.regionSlotOrder.set([]);
    state$.regionSeverityByNodeId.set({});
    impactModeActive$.set(false);
  });
  clearPreambles();
};

const canvasNavigationClock = makeNavigationClock();

// Read a canvas, load it as the source of truth, and prime the adapter plane
// with just this document's bindings.
const openCanvas = async (name: string) => {
  await runCanvasAuthoringOperation(async () => {
    if (!window.vellum) return;
    let request: number | undefined;
    state$.canvasLoading.set(true);
    try {
      await flushCanvasEdits();
      if (canvasMutationsQuiesced()) return;
      request = canvasNavigationClock.begin();
      const result = await window.vellum.readCanvas(name);
      if (canvasMutationsQuiesced() || !canvasNavigationClock.isCurrent(request)) return;
      clearAbandonedCanvas(result.name);
      state$.canvasName.set(result.name);
      resetCanvasView();
      batch(() => {
        loadDoc(result.doc, result.revision, result.name);
        replaceActiveActorRefs(result.actorRefs);
      });
      externalCanvasReload.accept(result);
      state$.error.set("");
      await refreshSnapshotsSoft(result.doc);
    } catch (error) {
      if (request === undefined || canvasNavigationClock.isCurrent(request)) setError(error);
    } finally {
      if (request === undefined || canvasNavigationClock.isCurrent(request)) {
        state$.canvasLoading.set(false);
      }
    }
  });
};

const assertCanvasNavigationAdmitted = (): void => {
  if (canvasMutationsQuiesced()) {
    throw new Error("Canvas navigation is unavailable while Vellum Command is quitting.");
  }
};

const nodeRefNavigation = makeNodeRefNavigationCoordinator({
  clock: canvasNavigationClock,
  readCanvas: async (name) => {
    const vellum = window.vellum;
    if (!vellum) throw new Error("Electron preload bridge is not available.");
    return vellum.readCanvas(name);
  },
  assertCanApply: assertCanvasNavigationAdmitted,
  apply: (event, result) => {
    clearAbandonedCanvas(result.name);
    state$.canvasName.set(result.name);
    resetCanvasView();
    batch(() => {
      loadDoc(result.doc, result.revision, result.name);
      replaceActiveActorRefs(result.actorRefs);
    });
    externalCanvasReload.accept(result);
    state$.selectedNodeId.set(event.nodeId);
    state$.focusNodeId.set(event.nodeId);
    state$.canvasLoading.set(false);
    state$.error.set("");
    void refreshSnapshotsSoft(result.doc);
  },
  onFailure: (error) => {
    state$.canvasLoading.set(false);
    state$.error.set(`node reference / ${error.message}`);
  },
});

const externalCanvasReload = makeCanvasExternalReloadCoordinator({
  flushLocalEdits: flushCanvasEdits,
  readCanvas: async (name) => {
    const vellum = window.vellum;
    if (!vellum) throw new Error("Electron preload bridge is not available.");
    return vellum.readCanvas(name);
  },
  currentCanvasName: () => state$.canvasName.peek(),
  currentDoc: () => state$.doc.peek(),
  currentDocEpoch: () => state$.docEpoch.peek(),
  currentRevision: getCanvasRevision,
  hasPendingChanges: hasPendingCanvasChanges,
  acceptRevision: acceptCanvasRevision,
  apply: (result) =>
    batch(() => {
      const prevDoc = state$.doc.peek();
      loadDoc(result.doc, result.revision, result.name);
      replaceActiveActorRefs(result.actorRefs);
      // CLI / kernel work lands via canvasChanged → spark edges for the delta.
      noteWorkDocChange(prevDoc, result.doc, result.actorRefs);
    }),
  onFailure: setError,
});

const createCanvas = async (name: string) => {
  await runCanvasAuthoringOperation(async () => {
    if (!window.vellum) return;
    let request: number | undefined;
    state$.canvasLoading.set(true);
    try {
      await flushCanvasEdits();
      if (canvasMutationsQuiesced()) return;
      request = canvasNavigationClock.begin();
      const result = await window.vellum.createCanvas(name);
      if (canvasMutationsQuiesced()) return;
      clearAbandonedCanvas(result.name);
      await refreshList();
      if (canvasMutationsQuiesced() || !canvasNavigationClock.isCurrent(request)) return;
      state$.canvasName.set(result.name);
      resetCanvasView();
      batch(() => {
        loadDoc(result.doc, result.revision, result.name);
        replaceActiveActorRefs(result.actorRefs);
      });
      externalCanvasReload.accept(result);
      state$.error.set("");
      await refreshSnapshotsSoft(result.doc);
    } catch (error) {
      if (request === undefined || canvasNavigationClock.isCurrent(request)) setError(error);
    } finally {
      if (request === undefined || canvasNavigationClock.isCurrent(request)) {
        state$.canvasLoading.set(false);
      }
    }
  });
};

const deleteCanvas = async (name: string) => {
  await runCanvasAuthoringOperation(async () => {
    if (!window.vellum || !name) return;
    state$.canvasLoading.set(true);
    try {
      const wasOpen = state$.canvasName.peek() === name;
      await flushCanvasEdits();
      if (canvasMutationsQuiesced()) return;
      // Mark the name abandoned after its last pending edit is durable so the
      // delete wins over any already-returning watcher echo.
      await prepareCanvasRemoval(name);
      if (canvasMutationsQuiesced()) return;
      await window.vellum.deleteCanvas(name);
      if (canvasMutationsQuiesced()) return;
      await refreshList();
      if (canvasMutationsQuiesced()) return;
      const remaining = state$.canvases.peek();
      state$.error.set("");
      if (!wasOpen) return;
      if (remaining.length === 0) {
        await createCanvas(SEED_CANVAS_NAME);
        return;
      }
      await openCanvas(remaining[0]!.name);
    } catch (error) {
      setError(error);
    } finally {
      state$.canvasLoading.set(false);
    }
  });
};

const retryActionForError = (message: string): { readonly label: string; readonly run: () => Promise<void> } | undefined => {
  if (message.includes("write-canvas") || message.includes("cannot write")) return { label: "retry save", run: async () => retrySave() };
  return undefined;
};

// One-shot across the app lifetime, so StrictMode's mount/remount and any
// re-mount never re-run the boot sequence. Subscriptions, by contrast, are set
// up and torn down per effect run so they always stay balanced.
let didBoot = false;

export function App() {
  const error = use$(state$.error);
  const booting = use$(state$.booting);
  const canvasName = use$(state$.canvasName);
  const fleetOpen = use$(state$.fleetOpen);
  const errorAction = retryActionForError(error);

  useEffect(() => {
    if (!window.vellum) {
      state$.error.set("Electron preload bridge is not available.");
      state$.booting.set(false);
      return;
    }
    const vellum = window.vellum;
    // Subscribe before boot touches a default canvas. Preload can deliver a
    // buffered cold-start locator synchronously from this call; returning the
    // navigation promise delays its durable relay ACK until focus is applied.
    const offNodeRef = vellum.onNodeRefOpened(async (event) => {
      assertCanvasNavigationAdmitted();
      state$.canvasLoading.set(true);
      await runCanvasAuthoringOperation(async () => {
        try {
          await flushCanvasEdits();
          assertCanvasNavigationAdmitted();
          await nodeRefNavigation.navigate(event);
        } catch (error) {
          state$.canvasLoading.set(false);
          throw error;
        }
      });
    });

    // Usage: subscribe first so no push is lost. getUsage is instant (main
    // already holds last-good cache + kicks primary poll on start). Do NOT
    // await refreshUsage here — that was waiting 30–60s on codexbar and made
    // the HUD feel deferred. Main `usage.start()` polls immediately.
    const offUsage = vellum.onUsageChanged((state) => state$.usage.set(state));
    void vellum
      .getUsage()
      .then((usage) => state$.usage.set(usage))
      .catch(() => {
        // Fail open: keep empty until a push lands.
      });

    const boot = async () => {
      try {
        state$.snapshots.set(await vellum.getSnapshots());
        const list = await vellum.listCanvases();
        state$.canvases.set(list);
        if (!nodeRefNavigation.hasReceived()) {
          if (list.length === 0) {
            await createCanvas(SEED_CANVAS_NAME);
          } else {
            await openCanvas(list[0].name);
          }
        }
      } catch (error) {
        setError(error);
      } finally {
        state$.booting.set(false);
      }
    };
    if (!didBoot) {
      didBoot = true;
      void boot().catch(setError);
    }

    // A renderer-only reload (dev hot reload, crash-recovery reload) leaves
    // any already-attached WebContentsView orphaned unless the dock is
    // rebuilt from the main process's live session list on mount.
    void reconcileDockFromLiveSessions();

    const stopKernel = startKernelBridge();
    const stopSettings = startSettingsBridge();
    const stopUpdate = startUpdateBridge();
    // Managed-agent seat state (attention/working) — subscribe early so canvas
    // node chrome paints before any TerminalCard mounts.
    const stopAgentSeat = subscribeAgentSeatState();
    // Freeze continuous CSS when the page is hidden / reduced-motion so the
    // GPU helper can drop off the fan curve (fleet closed is not enough).
    const stopSurfaceMotion = startSurfaceMotionGate();

    const offSnapshots = vellum.onSnapshotsChanged((state) => state$.snapshots.set(state));
    const offCanvas = vellum.onCanvasChanged((name) => {
      if (name !== state$.canvasName.peek()) return;
      void externalCanvasReload.changed(name);
    });
    const offPreamble = vellum.onPreamble?.((event) => {
      if (event.canvasName !== state$.canvasName.peek()) return;
      showPreamble(event);
    });

    const offCanvasFlush = vellum.onCanvasFlushRequested(async () => {
      await flushCanvasEdits();
    });
    const offCanvasQuiesceAndFlush = vellum.onCanvasQuiesceAndFlushRequested(async (acknowledgeQuiesced) => {
      try {
        const flush = quiesceAndFlushCanvasEdits();
        // quiesceAndFlushCanvasEdits closes admission synchronously before its
        // first await. Publish that boundary separately from final durability
        // so main can classify timeout/crash recovery without guessing.
        if (canvasMutationsQuiesced()) acknowledgeQuiesced();
        await flush;
        return { ok: true, quiesced: true };
      } catch {
        return { ok: false, quiesced: canvasMutationsQuiesced() };
      }
    });

    return () => {
      offNodeRef();
      offSnapshots();
      offUsage();
      offCanvas();
      offPreamble?.();
      offCanvasFlush();
      offCanvasQuiesceAndFlush();
      stopKernel();
      stopSettings?.();
      stopUpdate?.();
      stopAgentSeat?.();
      stopSurfaceMotion();
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        const target = event.target as HTMLElement | null;
        if (target?.closest("input, textarea, [contenteditable='true']")) return;
        if (state$.settingsOpen.peek()) {
          event.preventDefault();
          closeSettings();
          return;
        }
        if (state$.selectedNodeId.peek() || state$.selectedEdgeId.peek() || state$.selectedNodeIds.peek().length > 0) {
          event.preventDefault();
          state$.selectedNodeId.set("");
          state$.selectedNodeIds.set([]);
          state$.selectedEdgeId.set("");
          return;
        }
        return;
      }
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "z") return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, [contenteditable='true']")) return;
      event.preventDefault();
      if (event.shiftKey) redo();
      else undo();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <div className="vellum-app flex h-screen w-screen flex-col overflow-hidden" style={{ background: "#0c0b0a" }}>
      <TopBar
        onOpen={(name) => void openCanvas(name)}
        onCreate={(name) => void createCanvas(name)}
        onDelete={(name) => void deleteCanvas(name)}
      />

      <div className="vellum-stage flex min-h-0 flex-1">
        {/* Canvas column shrinks when the dock opens; overlays anchor to it. */}
        <div className="vellum-stage-main relative min-w-0 flex-1">
        {error ? (
          <div
            role="alert"
            className="error-banner absolute left-1/2 top-3 z-50 -translate-x-1/2 rounded-md border px-3 py-1.5 text-[11px]"
            style={{ borderColor: "rgba(229,72,77,0.4)", background: "rgba(229,72,77,0.12)", color: "#EDE6DA" }}
          >
            <button type="button" className="error-banner__close" aria-label="Dismiss warning" onClick={() => state$.error.set("")}>×</button>
            <span className="error-banner__label">renderer / data warning</span>
            <span className="error-banner__message">{error}</span>
            {errorAction ? <button type="button" className="error-banner__retry" onClick={() => void errorAction.run()}>{errorAction.label}</button> : null}
          </div>
        ) : null}

        {booting && !canvasName ? (
          <div className="boot-indicator absolute left-1/2 top-5 z-40 -translate-x-1/2">
            <span className="boot-indicator__dot" />
            opening station
          </div>
        ) : null}

        <ReactFlowProvider>
          <Canvas />
          <DemoCameraBridge />
        </ReactFlowProvider>
        <CanvasChrome />
        {/* Selection fields live on the RTS kind surface (FocusSurface forms). */}

        <SettingsPanel />
        {/* Mount fleet only while open — unmount destroys every WebGL machine. */}
        {fleetOpen ? (
          <Suspense
            fallback={
              <div className="fleet-chunk-fallback" role="status" aria-live="polite">
                Opening Command Fleet…
              </div>
            }
          >
            <FleetOverlay />
          </Suspense>
        ) : null}
        <StationRoleGate />
        <HerdrWizard />
        {/* HerdrTerminalModal is fallback only — WorkFocusShell owns herdr when registered. */}
        <HerdrTerminalModal />
        <WorkFocusShell />
        <HerdrToast />
        <DemoLayer />
        </div>
        <WorkSurfaceDock />
      </div>
      <TooltipLayer />
    </div>
  );
}
