import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CanvasDoc } from "../src/shared/canvas";
import {
  commitDoc,
  clearAbandonedCanvas,
  flushPendingCanvasSave,
  loadDoc,
  prepareCanvasRemoval,
} from "../src/renderer/lib/mutations";
import { state$ } from "../src/renderer/lib/state";

const revisions = new Map<string, number>();
const writeCanvas = vi.fn(
  async (name: string, _doc: CanvasDoc, expectedRevision?: string) => {
    const next = (revisions.get(name) ?? 0) + 1;
    revisions.set(name, next);
    return { revision: `${expectedRevision ?? "new"}->${next}` };
  },
);

const runtimeWindow = {
  vellum: { writeCanvas },
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
    revisions.clear();
    state$.canvasName.set("alpha");
    state$.error.set("");
    state$.saveState.set("saved");
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

  it("keeps local state and fails visibly when the disk revision changed", async () => {
    writeCanvas.mockRejectedValueOnce(new Error("alpha.canvas changed on disk; reload before saving"));
    commitDoc(doc("local-unsaved"));

    await expect(flushPendingCanvasSave()).rejects.toThrow("changed on disk");

    expect(state$.doc.peek()).toEqual(doc("local-unsaved"));
    expect(state$.saveState.peek()).toBe("error");
    expect(state$.error.peek()).toContain("changed on disk");
  });
});
