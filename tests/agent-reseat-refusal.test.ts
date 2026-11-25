// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { asCanvasName } from "../src/shared/model";
import { reseatSeats } from "../src/window/lib/agent-reseat";
import { state$ } from "../src/window/lib/state";
import { newSeat } from "../src/window/lib/model-factories";
import { modelStore } from "../src/window/lib/use-model";

/**
 * A re-seat stops each old process, so it learns first whether the canvas
 * takes edits. A canvas that refuses leaves every picked seat running on its
 * old harness: nothing is stopped.
 */
describe("reseatSeats: a canvas that takes no edits stops no seat", () => {
  const terminalKill = vi.fn(async () => undefined);
  const terminalGet = vi.fn(async () => undefined);

  beforeEach(() => {
    terminalKill.mockClear();
    terminalGet.mockClear();
    (window as unknown as { junto: unknown }).junto = { terminalKill, terminalGet };
  });

  afterEach(() => {
    delete (window as unknown as { junto?: unknown }).junto;
  });

  it("leaves every picked seat's process alone and reports each as refused", async () => {
    const a = newSeat({ x: 0, y: 0, z: 1 }, { harness: "claude", host: "studio", cwd: "/p/a", label: "a" });
    const b = newSeat({ x: 0, y: 0, z: 2 }, { harness: "codex", host: "studio", cwd: "/p/b", label: "b" });
    // The store holds "factory", but the window has another canvas open: "factory" takes no edit.
    state$.canvasName.set("elsewhere");
    const release = modelStore.adopt({ canvas: asCanvasName("factory"), seq: 0, nodes: [a, b], wires: [] });
    try {
      const outcome = await reseatSeats("factory", [a.id, b.id], { harness: "grok" });
      expect(terminalKill).not.toHaveBeenCalled();
      expect(outcome).toEqual({
        moved: [],
        unchanged: [],
        failed: [
          { id: a.id, message: "the canvas is not open for edits" },
          { id: b.id, message: "the canvas is not open for edits" },
        ],
      });
      const nodes = modelStore.canvasOf("factory").nodes;
      expect(nodes.get(a.id)).toMatchObject({ harness: "claude", bindingId: a.bindingId });
      expect(nodes.get(b.id)).toMatchObject({ harness: "codex", bindingId: b.bindingId });
    } finally {
      release();
    }
  });
});
