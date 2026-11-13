/**
 * The scene bridge's late-open regression (canvas-automation's 69c63f425):
 * the GPU canvas attached before the model's read landed, sent the empty
 * board as its one load, and never asked again. The bridge now waits for the
 * canvas to be open and subscribes to the rows first, so the one load it
 * sends carries the board.
 */
import { describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => {
  // A Legend-State observable is made inside the mock factory; this only
  // carries the shape out to the test.
  return { state: undefined as unknown };
});

vi.mock("../src/window/lib/use-model", async () => {
  const { observable } = await import("@legendapp/state");
  const canvas = observable({
    status: "opening" as "closed" | "opening" | "open" | "error",
    error: "",
    seq: 0,
    nodes: {} as Record<string, unknown>,
    wires: {} as Record<string, unknown>,
    nodeIds: [] as ReadonlyArray<string>,
    wireIds: [] as ReadonlyArray<string>,
  });
  fake.state = canvas;
  const modelStore = {
    open: () => () => undefined,
    canvas$: () => canvas,
    canvasOf: (name: string) => ({
      name,
      seq: canvas.seq.peek(),
      nodes: new Map(Object.entries(canvas.nodes.peek())),
      wires: new Map(Object.entries(canvas.wires.peek())),
    }),
  };
  return { modelStore };
});

vi.mock("../src/window/lib/state", async () => {
  const { observable } = await import("@legendapp/state");
  return {
    state$: observable({
      canvasName: "" as string,
      selectedNodeIds: [] as ReadonlyArray<string>,
      connectionFocusNodeId: "",
    }),
  };
});

const note = (id: string, x: number) => ({
  id,
  kind: "note" as const,
  x,
  y: 0,
  width: 200,
  height: 80,
  z: 0,
  text: id,
});

type Model = {
  status: { set: (value: string) => void };
  seq: { set: (value: number) => void };
  nodes: { set: (value: Record<string, unknown>) => void };
  nodeIds: { set: (value: ReadonlyArray<string>) => void };
  wireIds: { set: (value: ReadonlyArray<string>) => void };
  wires: { set: (value: Record<string, unknown>) => void };
};

const model = (): Model => fake.state as Model;

describe("the GPU canvas scene bridge", () => {
  it("sends no load before the canvas is open, and the one it sends carries the rows", async () => {
    const [{ startSceneBridge }, { state$ }, { modelStore }] = await Promise.all([
      import("../src/window/canvas/shell/scene-bridge"),
      import("../src/window/lib/state"),
      import("../src/window/lib/use-model"),
    ]);
    state$.canvasName.set("factory");
    const ops: Array<{ kind: string; cards?: ReadonlyArray<{ id: string }> }> = [];
    const stop = startSceneBridge({ apply: (batch) => { ops.push(...(batch as typeof ops)); } });
    // Attached while the read is in flight: nothing to load yet (the
    // selection fact is sent at once, as the shell's mirror needs it).
    expect(ops.some((op) => op.kind === "load")).toBe(false);
    model().nodes.set({ first: note("first", 40) });
    model().nodeIds.set(["first"]);
    model().seq.set(1);
    model().status.set("open");
    await Promise.resolve();
    const loads = ops.filter((op) => op.kind === "load");
    expect(loads).toHaveLength(1);
    expect(loads[0]!.cards?.map((card) => card.id)).toEqual(["first"]);
    expect(ops.filter((op) => op.kind === "card")).toEqual([]);
    stop();
    void modelStore;
  });
});
