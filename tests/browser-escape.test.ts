// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { warmDetachOnEscape } from "../src/renderer/lib/browser-escape";

const shellHolding = (...surfaceIds: string[]) => {
  const shell = document.createElement("div");
  for (const id of surfaceIds) {
    const pane = document.createElement("div");
    pane.setAttribute("data-surface-id", id);
    shell.append(pane);
  }
  return { container: () => shell };
};

describe("warmDetachOnEscape", () => {
  it("leaves the browser attached when a dialog above it declines Escape", () => {
    const dialog = { container: () => document.createElement("div") };
    expect(warmDetachOnEscape("browser:one", dialog)).toBe(false);
  });

  it("detaches while the browser's own shell is the top modal", () => {
    expect(warmDetachOnEscape("browser:one", shellHolding("browser:one", "terminal:two"))).toBe(true);
  });

  it("detaches with no modal open, and never without a front browser", () => {
    expect(warmDetachOnEscape("browser:one", undefined)).toBe(true);
    expect(warmDetachOnEscape(undefined, undefined)).toBe(false);
    expect(warmDetachOnEscape(undefined, shellHolding("browser:one"))).toBe(false);
  });

  it("does not detach when the top modal holds a different surface", () => {
    expect(warmDetachOnEscape("browser:one", shellHolding("terminal:two"))).toBe(false);
  });
});
