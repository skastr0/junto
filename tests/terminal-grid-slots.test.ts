import { afterEach, describe, expect, it } from "vitest";
import type { CanvasNode } from "../src/shared/canvas";
import { dock$, terminalSurfaceId } from "../src/renderer/lib/dock-state";
import { initialWorkbenchState } from "../src/renderer/lib/surface-registry";
import {
  closeAllTerminalSurfaces,
  closeGridTerminalSurfaces,
  openGridTerminalSurface,
  openTerminalSurface,
  registerGridTerminalSlot,
  registerTerminalSlot,
  setGridTerminalCell,
  terminal$,
  terminalSlotElement,
} from "../src/renderer/lib/terminal-state";

const node = (id: string): CanvasNode =>
  ({
    id,
    type: "text",
    text: id,
    x: 0,
    y: 0,
    width: 220,
    height: 84,
    ether: {
      entity: { kind: "terminal" },
      host: "local",
      terminal: { bindingId: `bind-${id}`, launch: { kind: "command", argv: ["zsh"] } },
    },
  }) satisfies CanvasNode;

const el = (name: string) => ({ name }) as unknown as HTMLElement;

afterEach(() => {
  for (const id of ["a", "b"]) {
    registerGridTerminalSlot(id, null);
    registerTerminalSlot(id, null);
  }
  closeGridTerminalSurfaces();
  closeAllTerminalSurfaces();
  dock$.registry.set(initialWorkbenchState());
});

describe("grid focus terminal slots", () => {
  it("borrows a pinned terminal and hands it back to its pane", () => {
    openTerminalSurface(node("a"), "pinned");
    const pinnedPane = el("pinned");
    registerTerminalSlot("a", pinnedPane);

    openGridTerminalSurface(node("a"));
    const cell = el("cell");
    registerGridTerminalSlot("a", cell);
    expect(terminalSlotElement("a")).toBe(cell);
    expect(terminal$.gridOwnedByNodeId.a.peek()).toBeUndefined();

    registerGridTerminalSlot("a", null);
    closeGridTerminalSurfaces();
    expect(terminalSlotElement("a")).toBe(pinnedPane);
    expect(terminal$.openByNodeId.a.peek()).toBeDefined();
    expect(dock$.registry.peek().surfaces).toEqual([
      { id: terminalSurfaceId("a"), kind: "terminal", zone: "pinned" },
    ]);
  });

  it("keeps grid-opened views out of the dock and closes them with the grid", () => {
    openGridTerminalSurface(node("b"));
    expect(terminal$.openByNodeId.b.peek()).toBeDefined();
    expect(dock$.registry.peek().surfaces).toEqual([]);

    closeGridTerminalSurfaces();
    expect(terminal$.openByNodeId.b.peek()).toBeUndefined();
    expect(terminal$.gridOwnedByNodeId.b.peek()).toBeUndefined();
  });

  it("drops every grid-only view option on close", () => {
    openGridTerminalSurface(node("b"));
    setGridTerminalCell("b", { fontSize: 10 });
    expect(terminal$.gridCellByNodeId.b.peek()).toEqual({ fontSize: 10 });
    closeGridTerminalSurfaces();
    expect(terminal$.gridCellByNodeId.b.peek()).toBeUndefined();
  });

  it("adopts a grid-owned view into the dock when opened normally", () => {
    openGridTerminalSurface(node("b"));
    openTerminalSurface(node("b"), "pinned");
    closeGridTerminalSurfaces();
    expect(terminal$.openByNodeId.b.peek()).toBeDefined();
    expect(dock$.registry.peek().surfaces.map((s) => s.id)).toEqual([terminalSurfaceId("b")]);
  });
});
