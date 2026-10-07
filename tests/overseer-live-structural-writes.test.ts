import { describe, expect, it } from "vitest";
import { LIVE_STRUCTURAL_WRITES } from "../src/main/junto/overseer/live/service";
import { OVERSEER_OPERATION_NAMES, isOverseerMutation } from "../src/shared/overseer-control";

// A voice request's receipt is committed with the canvas write only for the
// writes this list names. A canvas write left off it would be sent with no
// committed receipt, so the list is held to the catalog here.

/**
 * Not one canvas transaction: the two deletes tear sessions down outside it,
 * and a screenshot is taken by the window and changes no canvas. Each keeps
 * its dispatched receipt until it settles.
 */
const SETTLED_AFTERWARDS = ["canvas.delete", "node.delete", "canvas.screenshot"];

describe("the voice session's structural writes", () => {
  it("names every canvas, node and wire write the catalog holds, bar those settled afterwards", () => {
    const writes = OVERSEER_OPERATION_NAMES.filter(
      (operation) => /^(canvas|node|wire)\./u.test(operation) && isOverseerMutation(operation),
    ).filter((operation) => !SETTLED_AFTERWARDS.includes(operation));
    expect([...LIVE_STRUCTURAL_WRITES].sort()).toEqual([...writes].sort());
  });

  it("carries the wire names and the recolor, and no retired name", () => {
    for (const operation of ["wire.connect", "wire.configure", "wire.disconnect", "node.recolor"] as const) {
      expect(LIVE_STRUCTURAL_WRITES.has(operation)).toBe(true);
    }
    expect([...LIVE_STRUCTURAL_WRITES].some((operation) => operation.startsWith("edge."))).toBe(false);
  });
});
