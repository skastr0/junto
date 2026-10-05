import { describe, expect, it } from "vitest";
import { nextTabStop, topOf, type ModalLayer } from "../src/renderer/lib/modal-stack";

const entry = (layer: ModalLayer, seq: number) => ({ layer, seq });

describe("modal stack order", () => {
  it("has no top when nothing is open", () => {
    expect(topOf([])).toBeUndefined();
  });

  it("puts an operator modal above everything, whenever it opened", () => {
    const operator = entry("operator", 0);
    expect(topOf([operator, entry("working", 1), entry("working-dialog", 2)])).toBe(operator);
  });

  it("puts a dialog above the working modal it opened from", () => {
    const dialog = entry("working-dialog", 1);
    expect(topOf([entry("working", 0), dialog])).toBe(dialog);
    expect(topOf([dialog, entry("working", 2)])).toBe(dialog);
  });

  it("puts the latest opened on top within a layer", () => {
    const later = entry("working", 5);
    expect(topOf([entry("working", 1), later, entry("working", 3)])).toBe(later);
  });
});

describe("tab trap", () => {
  const stop = (name: string, visible = true) => ({ name, getClientRects: () => ({ length: visible ? 1 : 0 }) });
  const a = stop("a");
  const b = stop("b");
  const c = stop("c");

  it("lets the browser move between stops inside the modal", () => {
    expect(nextTabStop([a, b, c], a, false)).toBeNull();
    expect(nextTabStop([a, b, c], b, true)).toBeNull();
  });

  it("wraps at both ends", () => {
    expect(nextTabStop([a, b, c], c, false)).toBe(a);
    expect(nextTabStop([a, b, c], a, true)).toBe(c);
  });

  it("brings focus in when it sits on the frame or outside", () => {
    expect(nextTabStop([a, b, c], null, false)).toBe(a);
    expect(nextTabStop([a, b, c], stop("elsewhere"), true)).toBe(c);
  });

  it("skips stops that are not on screen", () => {
    const hidden = stop("hidden", false);
    expect(nextTabStop([a, b, hidden], b, false)).toBe(a);
  });

  it("does nothing in a modal with no stops", () => {
    expect(nextTabStop([], null, false)).toBeNull();
  });
});
