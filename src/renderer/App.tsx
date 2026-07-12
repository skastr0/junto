import { useEffect } from "react";
import { ReactFlowProvider } from "@xyflow/react";
import { use$ } from "@legendapp/state/react";
import { state$ } from "./lib/state";
import { bindingHints, getLastWriteAt, loadDoc } from "./lib/mutations";
import { Canvas } from "./components/Canvas";
import { TopBar } from "./components/TopBar";
import { DigestPanel } from "./components/DigestPanel";
import { SEED_CANVAS_NAME } from "@shared/seed";

const setError = (error: unknown) =>
  state$.error.set(error instanceof Error ? error.message : String(error));

const refreshList = async () => {
  if (!window.vellum) return;
  state$.canvases.set(await window.vellum.listCanvases());
};

// Read a canvas, load it as the source of truth, and prime the adapter plane
// with just this document's bindings.
const openCanvas = async (name: string) => {
  if (!window.vellum) return;
  try {
    const result = await window.vellum.readCanvas(name);
    state$.canvasName.set(result.name);
    loadDoc(result.doc);
    state$.error.set("");
    const state = await window.vellum.refreshSnapshots(bindingHints(result.doc));
    state$.snapshots.set(state);
  } catch (error) {
    setError(error);
  }
};

const createCanvas = async (name: string) => {
  if (!window.vellum) return;
  try {
    const result = await window.vellum.createCanvas(name);
    await refreshList();
    state$.canvasName.set(result.name);
    loadDoc(result.doc);
    const state = await window.vellum.refreshSnapshots(bindingHints(result.doc));
    state$.snapshots.set(state);
  } catch (error) {
    setError(error);
  }
};

const exportDigest = async () => {
  const name = state$.canvasName.peek();
  if (!window.vellum || !name) return;
  try {
    const result = await window.vellum.exportDigest(name);
    state$.digest.set(result);
    state$.digestOpen.set(true);
  } catch (error) {
    setError(error);
  }
};

const refreshSnapshots = async () => {
  if (!window.vellum) return;
  try {
    const state = await window.vellum.refreshSnapshots(bindingHints(state$.doc.peek()));
    state$.snapshots.set(state);
  } catch (error) {
    setError(error);
  }
};

// One-shot across the app lifetime, so StrictMode's mount/remount and any
// re-mount never re-run the boot sequence. Subscriptions, by contrast, are set
// up and torn down per effect run so they always stay balanced.
let didBoot = false;

export function App() {
  const error = use$(state$.error);
  const booting = use$(state$.booting);

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
      void boot();
    }

    const offSnapshots = vellum.onSnapshotsChanged((state) => state$.snapshots.set(state));
    const offCanvas = vellum.onCanvasChanged((name) => {
      // Ignore the echo of our own recent write; only reload true external edits.
      if (name !== state$.canvasName.peek()) return;
      if (Date.now() - getLastWriteAt() < 1500) return;
      void vellum
        .readCanvas(name)
        .then((result) => loadDoc(result.doc))
        .catch(setError);
    });

    return () => {
      offSnapshots();
      offCanvas();
    };
  }, []);

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden" style={{ background: "#0c0b0a" }}>
      <TopBar
        onOpen={(name) => void openCanvas(name)}
        onCreate={(name) => void createCanvas(name)}
        onExport={() => void exportDigest()}
        onRefresh={() => void refreshSnapshots()}
      />

      <div className="relative min-h-0 flex-1">
        {error ? (
          <div
            className="absolute left-1/2 top-3 z-50 -translate-x-1/2 rounded-md border px-3 py-1.5 text-[11px]"
            style={{ borderColor: "rgba(229,72,77,0.4)", background: "rgba(229,72,77,0.12)", color: "#EDE6DA" }}
          >
            {error}
          </div>
        ) : null}

        {booting ? (
          <div
            className="absolute inset-0 z-40 grid place-items-center text-[11px] uppercase tracking-[0.2em]"
            style={{ color: "#8a8378" }}
          >
            opening station…
          </div>
        ) : null}

        <ReactFlowProvider>
          <Canvas />
        </ReactFlowProvider>

        <DigestPanel />
      </div>
    </div>
  );
}
