import { describe, expect, it } from "vitest";
import {
  isCommandCenterAuthoring,
  nextCanvasBootAction,
} from "../src/renderer/lib/canvas-boot";

describe("nextCanvasBootAction", () => {
  it("opens the first projected or authored canvas", () => {
    expect(nextCanvasBootAction("remote", ["factory", "ops"])).toEqual({
      kind: "open",
      name: "factory",
    });
    expect(nextCanvasBootAction("command-center", ["ops"])).toEqual({
      kind: "open",
      name: "ops",
    });
  });

  it("seeds only a Command Center with an empty list", () => {
    expect(nextCanvasBootAction("command-center", [])).toEqual({ kind: "seed" });
  });

  it("waits for projection on Remote and unset role", () => {
    expect(nextCanvasBootAction("remote", [])).toEqual({
      kind: "wait-projection",
    });
    expect(nextCanvasBootAction("", [])).toEqual({ kind: "wait-projection" });
  });
});

describe("isCommandCenterAuthoring", () => {
  it("is only true for Command Center", () => {
    expect(isCommandCenterAuthoring("command-center")).toBe(true);
    expect(isCommandCenterAuthoring("remote")).toBe(false);
    expect(isCommandCenterAuthoring("")).toBe(false);
  });
});
