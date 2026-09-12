import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearAbandonedCanvas,
  prepareCanvasRemoval,
  scheduleSave,
} from "../src/renderer/lib/mutations";
import { state$ } from "../src/renderer/lib/state";
import type { CanvasDoc } from "../src/shared/canvas";

const writeCanvas = vi.fn(async (_name: string, _doc: CanvasDoc) => ({ revision: "next" }));

const runtimeWindow = {
  vellumCommand: { writeCanvas },
  setTimeout: globalThis.setTimeout.bind(globalThis),
  clearTimeout: globalThis.clearTimeout.bind(globalThis),
  confirm: () => true,
};
(globalThis as unknown as { window: typeof runtimeWindow }).window = runtimeWindow;

const emptyDoc: CanvasDoc = { nodes: [], edges: [] };

describe("prepareCanvasRemoval vs pending save", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    writeCanvas.mockClear();
    writeCanvas.mockImplementation(async () => ({ revision: "next" }));
    state$.canvasName.set("doomed");
    state$.doc.set(emptyDoc);
    state$.error.set("");
    state$.saveState.set("saved");
    clearAbandonedCanvas("doomed");
  });

  afterEach(async () => {
    await prepareCanvasRemoval("doomed");
    clearAbandonedCanvas("doomed");
    vi.useRealTimers();
  });

  it("cancels a debounced save so delete is not resurrected by writeCanvas", async () => {
    scheduleSave();
    expect(state$.saveState.peek()).toBe("saving");

    await prepareCanvasRemoval("doomed");
    expect(state$.saveState.peek()).toBe("saved");

    await vi.advanceTimersByTimeAsync(600);
    expect(writeCanvas).not.toHaveBeenCalled();
  });

  it("awaits an in-flight write then leaves the name abandoned for further flushes", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    writeCanvas.mockImplementation(async () => {
      await gate;
      return { revision: "next" };
    });

    scheduleSave();
    await vi.advanceTimersByTimeAsync(520);
    expect(writeCanvas).toHaveBeenCalledTimes(1);

    const removal = prepareCanvasRemoval("doomed");
    release();
    await removal;

    scheduleSave();
    await vi.advanceTimersByTimeAsync(520);
    expect(writeCanvas).toHaveBeenCalledTimes(1);

    clearAbandonedCanvas("doomed");
    scheduleSave();
    await vi.advanceTimersByTimeAsync(520);
    expect(writeCanvas).toHaveBeenCalledTimes(2);
  });
});
