import { describe, expect, it } from "vitest";
import { canConnect } from "../src/renderer/lib/edge-mutations";
import { note, region, seat, taskBoard } from "./support/model-nodes";

// Whether a wire could be drawn between two nodes at all, asked of the nodes
// the store holds: what the canvas shows as a valid drop while a wire is drawn.

describe("canConnect", () => {
  it("admits a pair the verb grammar gives a verb", () => {
    expect(canConnect(seat("a"), seat("b"))).toBe(true);
    expect(canConnect(seat("a"), taskBoard("t"))).toBe(true);
    expect(canConnect(taskBoard("t"), taskBoard("u"))).toBe(true);
  });

  it("refuses a missing end, a region, and a card that only sits there", () => {
    expect(canConnect(seat("a"), undefined)).toBe(false);
    expect(canConnect(undefined, seat("b"))).toBe(false);
    expect(canConnect(seat("a"), region("r", { x: 0, y: 0, width: 400, height: 300 }))).toBe(false);
    expect(canConnect(note("n"), seat("b"))).toBe(false);
  });
});
