import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CanvasDoc } from "../src/shared/canvas";
import {
  commitDoc,
  clearAbandonedCanvas,
  flushPendingCanvasSave,
  loadDoc,
  prepareCanvasRemoval,
} from "../src/renderer/lib/mutations";
import {
  flushCanvasEdits,
  registerCanvasDraftCommit,
} from "../src/renderer/lib/canvas-editor-flush";
import { state$ } from "../src/renderer/lib/state";

const revisions = new Map<string, number>();
const writeCanvas = vi.fn(
  async (name: string, _doc: CanvasDoc, expectedRevision?: string) => {
    const next = (revisions.get(name) ?? 0) + 1;
    revisions.set(name, next);
    return { revision: `${expectedRevision ?? "new"}->${next}` };
  },
);
const createCanvas = vi.fn(async (name: string) => ({
  name,
  path: `/canvases/${name}.canvas`,
  doc: { nodes: [], edges: [] } satisfies CanvasDoc,
  revision: `${name}-created`,
}));
const listCanvases = vi.fn(async () => createCanvas.mock.calls.map(([name]) => ({
  name,
  path: `/canvases/${name}.canvas`,
  modifiedAt: "2026-07-18T00:00:00.000Z",
})));

const runtimeWindow = {
  vellum: { createCanvas, listCanvases, writeCanvas },
  setTimeout: globalThis.setTimeout.bind(globalThis),
  clearTimeout: globalThis.clearTimeout.bind(globalThis),
  confirm: () => true,
};
(globalThis as unknown as { window: typeof runtimeWindow }).window = runtimeWindow;

const doc = (text: string): CanvasDoc => ({
  nodes: [{ id: "note", type: "text", text, x: 0, y: 0, width: 120, height: 60 }],
  edges: [],
});

describe("renderer canvas save durability", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    writeCanvas.mockClear();
    createCanvas.mockClear();
    listCanvases.mockClear();
    revisions.clear();
    state$.canvasName.set("alpha");
    state$.error.set("");
    state$.saveState.set("saved");
    state$.canvases.set([]);
    clearAbandonedCanvas("alpha");
    clearAbandonedCanvas("beta");
    loadDoc(doc("alpha-base"), "alpha-r1", "alpha");
  });

  afterEach(async () => {
    await prepareCanvasRemoval("alpha");
    await prepareCanvasRemoval("beta");
    clearAbandonedCanvas("alpha");
    clearAbandonedCanvas("beta");
    vi.useRealTimers();
  });

  it("keeps a delayed save bound to the canvas, document, and revision that scheduled it", async () => {
    commitDoc(doc("alpha-edited"));

    // Reproduce the former switch race: renderer state changes before the
    // debounce fires. The pending write must still describe alpha.
    state$.canvasName.set("beta");
    state$.doc.set(doc("beta"));
    loadDoc(doc("beta"), "beta-r1", "beta");

    await vi.advanceTimersByTimeAsync(500);
    await flushPendingCanvasSave();

    expect(writeCanvas).toHaveBeenCalledOnce();
    expect(writeCanvas).toHaveBeenCalledWith("alpha", doc("alpha-edited"), "alpha-r1");
  });

  it("flushes a pending edit immediately for the quit boundary", async () => {
    commitDoc(doc("before-quit"));
    expect(writeCanvas).not.toHaveBeenCalled();

    await flushPendingCanvasSave();

    expect(writeCanvas).toHaveBeenCalledOnce();
    expect(writeCanvas).toHaveBeenCalledWith("alpha", doc("before-quit"), "alpha-r1");
  });

  it("commits an editor-local draft before acknowledging the quit boundary", async () => {
    const unregister = registerCanvasDraftCommit(() => commitDoc(doc("live-modal-draft")));
    try {
      expect(writeCanvas).not.toHaveBeenCalled();

      await flushCanvasEdits();

      expect(writeCanvas).toHaveBeenCalledOnce();
      expect(writeCanvas).toHaveBeenCalledWith("alpha", doc("live-modal-draft"), "alpha-r1");
    } finally {
      unregister();
    }
  });

  it("preserves both versions by moving the local edit to a recovery canvas after a disk conflict", async () => {
    writeCanvas.mockRejectedValueOnce(new Error("alpha.canvas changed on disk; reload before saving"));
    commitDoc(doc("local-unsaved"));

    await flushPendingCanvasSave();

    expect(createCanvas).toHaveBeenCalledOnce();
    const recoveryName = createCanvas.mock.calls[0]![0];
    expect(recoveryName).toMatch(/^recovery-[a-z0-9]+-[a-z0-9]+$/);
    expect(writeCanvas).toHaveBeenNthCalledWith(1, "alpha", doc("local-unsaved"), "alpha-r1");
    expect(writeCanvas).toHaveBeenNthCalledWith(
      2,
      recoveryName,
      doc("local-unsaved"),
      `${recoveryName}-created`,
    );
    expect(state$.doc.peek()).toEqual(doc("local-unsaved"));
    expect(state$.canvasName.peek()).toBe(recoveryName);
    expect(state$.canvases.peek().map(({ name }) => name)).toContain(recoveryName);
    expect(state$.saveState.peek()).toBe("saved");
    expect(state$.error.peek()).toContain(`saved as ${recoveryName}.canvas`);
  });

  it("keeps the flush boundary pending until the recovery copy is durable", async () => {
    let finishRecovery!: (result: { revision: string }) => void;
    const recoveryWrite = new Promise<{ revision: string }>((resolve) => {
      finishRecovery = resolve;
    });
    writeCanvas.mockRejectedValueOnce(new Error("alpha.canvas changed on disk; reload before saving"));
    writeCanvas.mockImplementationOnce(async () => recoveryWrite);
    commitDoc(doc("durability-gate"));

    let flushed = false;
    const flush = flushPendingCanvasSave().then(() => {
      flushed = true;
    });
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();

    expect(writeCanvas).toHaveBeenCalledTimes(2);
    expect(flushed).toBe(false);

    finishRecovery({ revision: "recovery-durable" });
    await flush;
    expect(flushed).toBe(true);
    expect(state$.saveState.peek()).toBe("saved");
  });

  it("does not create a recovery canvas for an ordinary write failure", async () => {
    writeCanvas.mockRejectedValueOnce(new Error("disk full"));
    commitDoc(doc("still-local"));

    await expect(flushPendingCanvasSave()).rejects.toThrow("disk full");

    expect(createCanvas).not.toHaveBeenCalled();
    expect(state$.canvasName.peek()).toBe("alpha");
    expect(state$.doc.peek()).toEqual(doc("still-local"));
    expect(state$.saveState.peek()).toBe("error");
  });
});
