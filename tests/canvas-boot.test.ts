import { describe, expect, it } from "vitest";
import { nextCanvasBootAction } from "../src/renderer/lib/canvas-boot";

describe("nextCanvasBootAction", () => {
  it("opens the first canvas this machine holds", () => {
    expect(nextCanvasBootAction(["factory", "ops"])).toEqual({
      kind: "open",
      name: "factory",
    });
  });

  it("starts an empty canvas when it holds none", () => {
    expect(nextCanvasBootAction([])).toEqual({ kind: "seed" });
  });
});
