import { describe, expect, it } from "vitest";
import { placeBesideRect } from "../src/renderer/lib/menu-placement";

describe("placeBesideRect", () => {
  const viewport = { width: 1000, height: 800 };
  const menu = { width: 320, height: 180 };
  // A small toolbar button in the middle of the screen.
  const button = { left: 480, top: 400, right: 510, bottom: 430 };

  it("hugs the rect's far end by default", () => {
    expect(placeBesideRect(button, menu, viewport, ["above"])).toEqual({ x: 190, y: 212 });
  });

  it("centres on the rect when asked", () => {
    expect(placeBesideRect(button, menu, viewport, ["above"], "center")).toEqual({ x: 335, y: 212 });
    expect(placeBesideRect(button, menu, viewport, ["right"], "center")).toEqual({ x: 518, y: 325 });
  });

  it("keeps a centred panel inside the viewport", () => {
    const nearEdge = { left: 10, top: 400, right: 40, bottom: 430 };
    expect(placeBesideRect(nearEdge, menu, viewport, ["above"], "center")).toEqual({ x: 8, y: 212 });
  });
});
