/**
 * The scene bridge's late-open regression (canvas-automation's 69c63f425):
 * a canvas that opens after the shell attached must not load the empty board
 * as its one load. The shell now waits for the model's first read, then
 * retains the feed, so the feed's one load carries the rows.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  ready: undefined as unknown as Promise<void>,
  resolveReady: undefined as unknown as () => void,
  feeds: [] as string[],
}));

vi.mock("../src/window/lib/use-model", async () => {
  const { observable } = await import("@legendapp/state");
  const canvas = observable({ status: "opening", seq: 0, nodes: {}, wires: {}, nodeIds: [], wireIds: [] });
  return {
    modelStore: {
      open: () => () => undefined,
      ready: () => fake.ready,
      canvas$: () => canvas,
      canvasOf: (name: string) => ({ name, seq: 0, nodes: new Map(), wires: new Map() }),
    },
  };
});

vi.mock("../src/window/canvas/feed", () => ({
  retainCanvasFeed: (name: string, emit: (ops: ReadonlyArray<unknown>) => void) => {
    fake.feeds.push(name);
    emit([{ kind: "load", canvas: name, cards: [{ id: "first" }], wires: [] }]);
    return () => undefined;
  },
}));

vi.mock("../src/window/lib/state", async () => {
  const { observable } = await import("@legendapp/state");
  return { state$: observable({ canvasName: "", selectedNodeIds: [], connectionFocusNodeId: "" }) };
});

type Modules = [typeof import("../src/window/canvas/shell/scene-bridge"), typeof import("../src/window/lib/state")];
let modules: Modules;

// The bridge's import is cold and heavy: in a loaded whole-suite lane it ran
// past the test's own limit, so it happens here, with room, before the clock.
beforeAll(async () => {
  modules = await Promise.all([
    import("../src/window/canvas/shell/scene-bridge"),
    import("../src/window/lib/state"),
  ]);
}, 60_000);

describe("the GPU canvas scene bridge", () => {
  it("waits for the canvas read, then lets the feed send the one load with its rows", async () => {
    fake.ready = new Promise<void>((resolve) => {
      fake.resolveReady = resolve;
    });
    const [{ startSceneBridge }, { state$ }] = modules;
    state$.canvasName.set("factory");
    const ops: Array<{ kind: string; cards?: ReadonlyArray<{ id: string }> }> = [];
    const stop = startSceneBridge({ apply: (batch) => { for (const op of batch as unknown as typeof ops) ops.push(op); } });
    // Let the observer attach and ask for the read.
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Attached while the read is in flight: the feed is not retained and
    // nothing has been loaded.
    expect(fake.feeds).toEqual([]);
    expect(ops.some((op) => op.kind === "load")).toBe(false);

    fake.resolveReady!();
    // The feed is retained once the read lands; wait for that, not one tick.
    await vi.waitFor(() => expect(fake.feeds).toEqual(["factory"]));
    const loads = ops.filter((op) => op.kind === "load");
    expect(loads).toHaveLength(1);
    expect(loads[0]!.cards?.map((card) => card.id)).toEqual(["first"]);
    stop();
  });
});
