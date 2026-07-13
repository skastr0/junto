import { useEffect } from "react";
import { ReactFlowProvider } from "@xyflow/react";
import { use$ } from "@legendapp/state/react";
import { state$ } from "./lib/state";
import { bindingHints, getLastWriteAt, loadDoc, redo, retrySave, undo } from "./lib/mutations";
import { startKernel } from "./lib/kernel-state";
import { Canvas } from "./components/Canvas";
import { TopBar } from "./components/TopBar";
import { DigestPanel } from "./components/DigestPanel";
import { PulseTray } from "./components/PulseTray";
import { CanvasChrome } from "./components/CanvasChrome";
import { InspectorPanel } from "./components/InspectorPanel";
import { SEED_CANVAS_NAME } from "@shared/seed";

const setError = (error: unknown) =>
  state$.error.set(error instanceof Error ? error.message : String(error));

const refreshList = async () => {
  if (!window.vellum) return;
  state$.canvases.set(await window.vellum.listCanvases());
};

const refreshSnapshotsSoft = async (doc: Parameters<typeof bindingHints>[0]) => {
  if (!window.vellum) return;
  try {
    const snapshots = await Promise.race([
      window.vellum.refreshSnapshots(bindingHints(doc)),
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
  state$.selectedEdgeId.set("");
  state$.focusNodeId.set("");
};

// Read a canvas, load it as the source of truth, and prime the adapter plane
// with just this document's bindings.
const openCanvas = async (name: string) => {
  if (!window.vellum) return;
  state$.canvasLoading.set(true);
  try {
    const result = await window.vellum.readCanvas(name);
    state$.canvasName.set(result.name);
    resetCanvasView();
    loadDoc(result.doc);
    state$.error.set("");
    await refreshSnapshotsSoft(result.doc);
  } catch (error) {
    setError(error);
  } finally {
    state$.canvasLoading.set(false);
  }
};

const createCanvas = async (name: string) => {
  if (!window.vellum) return;
  state$.canvasLoading.set(true);
  try {
    const result = await window.vellum.createCanvas(name);
    await refreshList();
    state$.canvasName.set(result.name);
    resetCanvasView();
    state$.digestOpen.set(false);
    loadDoc(result.doc);
    state$.error.set("");
    await refreshSnapshotsSoft(result.doc);
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
      window.vellum.refreshSnapshots(bindingHints(state$.doc.peek())),
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

    const boot = async () => {
      try {
        state$.snapshots.set(await vellum.getSnapshots());
        const list = await vellum.listCanvases();
        state$.canvases.set(list);
        if (list.length === 0) {
          await createCanvas(SEED_CANVAS_NAME);
        } else {
          await openCanvas(list[0].name);
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

    const stopKernel = startKernel();

    const offSnapshots = vellum.onSnapshotsChanged((state) => state$.snapshots.set(state));
    const offCanvas = vellum.onCanvasChanged((name) => {
      // Ignore the echo of our own recent write; only reload true external edits.
      if (name !== state$.canvasName.peek()) return;
      if (Date.now() - getLastWriteAt() < 1500) return;
      void vellum
        .readCanvas(name)
        .then((result) => {
          // The watcher is intentionally best-effort and can deliver our own
          // atomic write after the time guard. Preserve selection and inspector
          // state when the authoritative document is unchanged.
          if (JSON.stringify(result.doc) === JSON.stringify(state$.doc.peek())) return;
          loadDoc(result.doc);
        })
        .catch(setError);
    });

    return () => {
      offSnapshots();
      offCanvas();
      stopKernel();
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        const target = event.target as HTMLElement | null;
        if (target?.closest("input, textarea, [contenteditable='true']")) return;
        if (state$.digestOpen.peek()) {
          event.preventDefault();
          state$.digestOpen.set(false);
          return;
        }
        if (state$.selectedNodeId.peek() || state$.selectedEdgeId.peek()) {
          event.preventDefault();
          state$.selectedNodeId.set("");
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
        onUndo={undo}
        onRedo={redo}
        onExport={() => void exportDigest()}
        onRefresh={() => void refreshSnapshots()}
      />

      <div className="vellum-stage relative min-h-0 flex-1">
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
        </ReactFlowProvider>
        <CanvasChrome />
        <InspectorPanel />

        <DigestPanel />
        <PulseTray />
      </div>
    </div>
  );
}
