/** The window's answers to the pointer machine: connect grammar and region riders. */

import { afterEach, describe, expect, it } from "vitest";
import { canvasHands } from "../src/window/canvas/shell/pointer-host";
import { modelStore } from "../src/window/lib/use-model";
import { state$ } from "../src/window/lib/state";
import { note, region, seat, taskBoard } from "./support/model-nodes";

let release: (() => void) | undefined;
afterEach(() => {
  release?.();
  release = undefined;
});

const open = (nodes: Parameters<typeof modelStore.adopt>[0]["nodes"]): void => {
  release?.();
  state$.canvasName.set("hands");
  release = modelStore.adopt({ canvas: "hands" as never, seq: 0, nodes, wires: [] });
};

describe("the pointer host", () => {
  it("answers the connect grammar for a pair", async () => {
    open([seat("a"), seat("b"), note("n")]);
    const hands = canvasHands();
    expect(hands.canConnect("a", "b")).toBe(true);
    expect(hands.canConnect("a", "n")).toBe(false);
    expect(hands.verbsFor("a", "b")).toEqual(["messages"]);
  });

  it("answers the task-path verbs for two boards", async () => {
    open([taskBoard("x"), taskBoard("y")]);
    expect(canvasHands().verbsFor("x", "y")).toEqual(["flows", "derives"]);
  });

  it("names what a holding region carries", async () => {
    open([
      region("r", { x: 0, y: 0, width: 600, height: 400 }, { hold: true }),
      note("inside", "inside", { x: 100, y: 100 }),
      note("outside", "outside", { x: 900, y: 100 }),
    ]);
    expect(canvasHands().riders("r")).toEqual(["inside"]);
  });

  it("a holding region nested in a holding region carries its own contents, never the region round it", async () => {
    open([
      region("outer", { x: 0, y: 0, width: 1000, height: 1000 }, { hold: true }),
      region("inner", { x: 300, y: 300, width: 400, height: 400 }, { hold: true }),
      note("inside", "inside", { x: 320, y: 320 }),
    ]);
    // The inner region covers the outer one's centre, and the outer one rode along.
    expect(canvasHands().riders("inner")).toEqual(["inside"]);
    expect([...canvasHands().riders("outer")].sort()).toEqual(["inner", "inside"]);
  });
});
