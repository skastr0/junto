import { useEffect } from "react";
import { ReactFlowProvider } from "@xyflow/react";
import { identityHints } from "../shared/connections";
import type { CanvasDoc } from "@shared/canvas";
import { use$ } from "@legendapp/state/react";
import { state$ } from "./lib/state";
import {
  acceptCanvasRevision,
  clearAbandonedCanvas,
  flushPendingCanvasSave,
  getCanvasRevision,
  hasPendingCanvasChanges,
  loadDoc,
  prepareCanvasRemoval,
  redo,
  retrySave,
  undo,
} from "./lib/mutations";
import { startKernelBridge } from "./lib/kernel-view";
import { startSettingsBridge, closeSettings } from "./lib/settings-state";
import { reconcileDockFromLiveSessions } from "./lib/dock-state";
import { Canvas } from "./components/Canvas";
import { TopBar } from "./components/TopBar";
import { DigestPanel } from "./components/DigestPanel";
import { CanvasChrome } from "./components/CanvasChrome";
import { KernelStatus } from "./components/KernelStatus";
import { InspectorPanel } from "./components/InspectorPanel";
import { SettingsPanel } from "./components/SettingsPanel";
import { HerdrWizard } from "./components/herdr/HerdrWizard";
import { HerdrTerminalModal } from "./components/herdr/HerdrTerminalModal";
import { HerdrToast } from "./components/herdr/HerdrToast";
import { WorkSurfaceDock } from "./components/WorkSurfaceDock";
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
  state$.searchQuery.set("");
  state$.edgeFilter.set("");
  state$.flagFilter.set("");
  state$.digestOpen.set(false);
  state$.selectedNodeId.set("");
  state$.selectedNodeIds.set([]);
  state$.selectedEdgeId.set("");
  state$.focusNodeId.set("");
  state$.regionSlotOrder.set([]);
  state$.regionSeverityByNodeId.set({});
};

const canvasNavigationClock = makeNavigationClock();

// Read a canvas, load it as the source of truth, and prime the adapter plane
// with just this document's bindings.
const openCanvas = async (name: string) => {
  if (!window.vellum) return;
  let request: number | undefined;
  state$.canvasLoading.set(true);
  try {
    await flushPendingCanvasSave();
    request = canvasNavigationClock.begin();
    const result = await window.vellum.readCanvas(name);
    if (!canvasNavigationClock.isCurrent(request)) return;
    clearAbandonedCanvas(result.name);
    state$.canvasName.set(result.name);
    resetCanvasView();
    loadDoc(result.doc, result.revision, result.name);
    state$.error.set("");
    await refreshSnapshotsSoft(result.doc);
  } catch (error) {
    if (request === undefined || canvasNavigationClock.isCurrent(request)) setError(error);
  } finally {
    if (request === undefined || canvasNavigationClock.isCurrent(request)) {
      state$.canvasLoading.set(false);
    }
  }
};

const nodeRefNavigation = makeNodeRefNavigationCoordinator({
  clock: canvasNavigationClock,
  readCanvas: async (name) => {
    const vellum = window.vellum;
    if (!vellum) throw new Error("Electron preload bridge is not available.");
    return vellum.readCanvas(name);
  },
  apply: (event, result) => {
    clearAbandonedCanvas(result.name);
    state$.canvasName.set(result.name);
    resetCanvasView();
    loadDoc(result.doc, result.revision, result.name);
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

const createCanvas = async (name: string) => {
  if (!window.vellum) return;
  let request: number | undefined;
  state$.canvasLoading.set(true);
  try {
    await flushPendingCanvasSave();
    request = canvasNavigationClock.begin();
    const result = await window.vellum.createCanvas(name);
    clearAbandonedCanvas(result.name);
    await refreshList();
    if (!canvasNavigationClock.isCurrent(request)) return;
    state$.canvasName.set(result.name);
    resetCanvasView();
    state$.digestOpen.set(false);
    loadDoc(result.doc, result.revision, result.name);
    state$.error.set("");
    await refreshSnapshotsSoft(result.doc);
  } catch (error) {
    if (request === undefined || canvasNavigationClock.isCurrent(request)) setError(error);
  } finally {
    if (request === undefined || canvasNavigationClock.isCurrent(request)) {
      state$.canvasLoading.set(false);
    }
  }
};

const deleteCanvas = async (name: string) => {
  if (!window.vellum || !name) return;
  state$.canvasLoading.set(true);
  try {
    const wasOpen = state$.canvasName.peek() === name;
    await flushPendingCanvasSave();
    // Mark the name abandoned after its last pending edit is durable so the
    // delete wins over any already-returning watcher echo.
    await prepareCanvasRemoval(name);
    await window.vellum.deleteCanvas(name);
    await refreshList();
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
};

const exportDigest = async () => {
  const name = state$.canvasName.peek();
  if (!window.vellum || !name) return;
  state$.exporting.set(true);
  state$.error.set("");
  try {
    const result = await Promise.race([
      window.vellum.exportDigest(name),
      new Promise<null>((resolve) => window.setTimeout(() => resolve(null), 8000)),
    ]);
    if (!result) {
      state$.error.set("digest export timed out; no panel opened");
      return;
    }
    state$.digest.set(result);
    state$.digestOpen.set(true);
  } catch (error) {
    setError(error);
  } finally {
    state$.exporting.set(false);
  }
};

const refreshSnapshots = async () => {
  if (!window.vellum) return;
  state$.refreshing.set(true);
  state$.error.set("");
  try {
    const result = await Promise.race([
      window.vellum.refreshSnapshots(identityHints([state$.doc.peek()], state$.snapshots.peek())),
      new Promise<null>((resolve) => window.setTimeout(() => resolve(null), 4000)),
    ]);
    if (result) state$.snapshots.set(result);
    else state$.error.set("snapshot refresh timed out; existing snapshots kept");
  } catch (error) {
    setError(error);
  } finally {
    state$.refreshing.set(false);
  }
};

const retryActionForError = (message: string): { readonly label: string; readonly run: () => Promise<void> } | undefined => {
  if (message.includes("write-canvas") || message.includes("cannot write")) return { label: "retry save", run: async () => retrySave() };
  if (message.includes("snapshot refresh timed out")) return { label: "retry refresh", run: refreshSnapshots };
  if (message.includes("digest export timed out")) return { label: "retry digest", run: exportDigest };
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
      state$.canvasLoading.set(true);
      try {
        await flushPendingCanvasSave();
        return await nodeRefNavigation.navigate(event);
      } catch (error) {
        state$.canvasLoading.set(false);
        throw error;
      }
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

    const offSnapshots = vellum.onSnapshotsChanged((state) => state$.snapshots.set(state));
    const offCanvas = vellum.onCanvasChanged((name) => {
      if (name !== state$.canvasName.peek()) return;
      void (async () => {
        try {
          // A direct-file write racing a local edit is resolved by the main
          // process revision boundary. Failure leaves the local document in
          // memory, keeps the save retryable, and blocks navigation/quit.
          if (hasPendingCanvasChanges(name)) await flushPendingCanvasSave();
          const result = await vellum.readCanvas(name);
          // The user may edit while readCanvas is in flight. Never replace
          // that newer local state with the just-read disk snapshot.
          if (hasPendingCanvasChanges(name)) {
            await flushPendingCanvasSave();
            return;
          }
          if (result.revision === getCanvasRevision(name)) return;
          if (JSON.stringify(result.doc) === JSON.stringify(state$.doc.peek())) {
            acceptCanvasRevision(name, result.revision);
            return;
          }
          loadDoc(result.doc, result.revision, result.name);
        } catch (error) {
          setError(error);
        }
      })();
    });

    const offCanvasFlush = vellum.onCanvasFlushRequested(async () => {
      await flushPendingCanvasSave();
    });

    return () => {
      offNodeRef();
      offSnapshots();
      offUsage();
      offCanvas();
      offCanvasFlush();
      stopKernel();
      stopSettings?.();
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
        if (state$.digestOpen.peek()) {
          event.preventDefault();
          state$.digestOpen.set(false);
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
        onExport={() => void exportDigest()}
        onRefresh={() => void refreshSnapshots()}
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
        <KernelStatus />
        <InspectorPanel />

        <DigestPanel />
        <SettingsPanel />
        {/* PulseTray mounts inside RtsBottomBar (right third, above minimap). */}
        <HerdrWizard />
        <HerdrTerminalModal />
        <HerdrToast />
        <DemoLayer />
        </div>
        <WorkSurfaceDock />
      </div>
      <TooltipLayer />
    </div>
  );
}
