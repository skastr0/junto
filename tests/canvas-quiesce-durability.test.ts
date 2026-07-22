import { afterEach, describe, expect, it, vi } from "vitest";
import type { CanvasDoc } from "../src/shared/canvas";
import {
  applyWorkCanvasWrite,
  canvasMutationsQuiesced,
  commitDoc,
  hasPendingCanvasChanges,
  loadDoc,
  scheduleSave,
  undo,
} from "../src/renderer/lib/mutations";
import {
  flushCanvasEdits,
  quiesceAndFlushCanvasEdits,
  registerCanvasDraftCommit,
  runCanvasAuthoringOperation,
} from "../src/renderer/lib/canvas-editor-flush";
import { state$ } from "../src/renderer/lib/state";

const note = (text: string): CanvasDoc => ({
  nodes: [{ id: "note", type: "text", text, x: 0, y: 0, width: 120, height: 60 }],
  edges: [],
});

const writeCanvas = vi.fn(
  async (_name: string, _doc: CanvasDoc, _expectedRevision?: string) => ({
    revision: "written",
  }),
);

const runtimeWindow = {
  vellum: {
    writeCanvas,
    readCanvas: async (name: string) => ({
      name,
      path: `/canvases/${name}.canvas`,
      doc: note("disk"),
      revision: "disk-r1",
    }),
    createCanvas: async (name: string) => ({
      name,
      path: `/canvases/${name}.canvas`,
      doc: note("created"),
      revision: "created-r1",
    }),
    listCanvases: async () => [],
  },
  setTimeout: globalThis.setTimeout.bind(globalThis),
  clearTimeout: globalThis.clearTimeout.bind(globalThis),
  confirm: () => true,
};
(globalThis as unknown as { window: typeof runtimeWindow }).window = runtimeWindow;

afterEach(() => {
  vi.useRealTimers();
});

describe("renderer canvas quiesce boundary", () => {
  it("closes mutation admission synchronously, drains the final draft, and rejects late async work", async () => {
    vi.useFakeTimers();
    writeCanvas.mockClear();
    writeCanvas.mockResolvedValue({ revision: "written" });
    state$.canvasName.set("alpha");
    state$.error.set("");
    state$.saveState.set("saved");
    loadDoc(note("base"), "alpha-r1", "alpha");

    // Ordinary navigation/window flush stays non-quiescing and permits later edits.
    commitDoc(note("normal-flush"));
    await flushCanvasEdits();
    expect(canvasMutationsQuiesced()).toBe(false);
    expect(writeCanvas).toHaveBeenCalledWith("alpha", note("normal-flush"), "alpha-r1");

    let finishFinalWrite!: (result: { readonly revision: string }) => void;
    const finalWrite = new Promise<{ readonly revision: string }>((resolve) => {
      finishFinalWrite = resolve;
    });
    writeCanvas.mockImplementationOnce(async () => finalWrite);
    commitDoc(note("queued-before-quiesce"));
    const unregister = registerCanvasDraftCommit(() => commitDoc(note("final-editor-draft")));
    let finishAuthoringOperation!: () => void;
    const authoringOperationGate = new Promise<void>((resolve) => {
      finishAuthoringOperation = resolve;
    });
    const activeAuthoringOperation = runCanvasAuthoringOperation(async () => {
      await authoringOperationGate;
      // Models a WorkService write admitted before quiescence whose renderer
      // projection returns only after the main-process write completes.
      applyWorkCanvasWrite("alpha", note("returning-work-write"), "work-r5");
      return "created-before-quiesce";
    });

    const quiesce = quiesceAndFlushCanvasEdits();
    unregister();

    // The async function has not crossed its first await yet: admission is
    // already closed and the registered draft is the final accepted revision.
    expect(canvasMutationsQuiesced()).toBe(true);
    expect(state$.doc.peek()).toEqual(note("final-editor-draft"));
    const committedVersion = state$.docVersion.peek();
    const committedEpoch = state$.docEpoch.peek();

    commitDoc(note("late-commit"));
    applyWorkCanvasWrite("alpha", note("late-work-write"), "work-r2");
    loadDoc(note("late-navigation"), "late-r3", "alpha");
    undo();
    scheduleSave();
    const lateAuthoringOperation = vi.fn(async () => "late-create");
    await expect(runCanvasAuthoringOperation(lateAuthoringOperation)).resolves.toBeUndefined();

    expect(state$.doc.peek()).toEqual(note("final-editor-draft"));
    expect(state$.docVersion.peek()).toBe(committedVersion);
    expect(state$.docEpoch.peek()).toBe(committedEpoch);
    expect(lateAuthoringOperation).not.toHaveBeenCalled();

    // Quiesce waits every direct authorial operation admitted before the latch.
    let quiesced = false;
    void quiesce.then(() => {
      quiesced = true;
    });
    await Promise.resolve();
    expect(quiesced).toBe(false);
    finishAuthoringOperation();
    await expect(activeAuthoringOperation).resolves.toBe("created-before-quiesce");
    expect(state$.doc.peek()).toEqual(note("final-editor-draft"));
    expect(state$.docVersion.peek()).toBe(committedVersion);
    expect(state$.docEpoch.peek()).toBe(committedEpoch);

    for (let turn = 0; turn < 8 && writeCanvas.mock.calls.length < 2; turn += 1) {
      await Promise.resolve();
    }
    expect(writeCanvas).toHaveBeenCalledTimes(2);
    expect(writeCanvas).toHaveBeenLastCalledWith(
      "alpha",
      note("final-editor-draft"),
      "written",
    );
    expect(hasPendingCanvasChanges("alpha")).toBe(true);

    finishFinalWrite({ revision: "final-r4" });
    await quiesce;
    expect(hasPendingCanvasChanges("alpha")).toBe(false);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(writeCanvas).toHaveBeenCalledTimes(2);
    expect(state$.doc.peek()).toEqual(note("final-editor-draft"));
    expect(state$.docVersion.peek()).toBe(committedVersion);
    expect(state$.docEpoch.peek()).toBe(committedEpoch);
  });
});
