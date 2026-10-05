// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CanvasDoc } from "@shared/canvas";

// jsdom has no ResizeObserver; a module the bar imports builds one at load.
vi.hoisted(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
});

import { RtsBottomBar } from "../src/renderer/components/rts/RtsBottomBar";
import { state$ } from "../src/renderer/lib/state";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const note = (id: string) => ({ id, type: "text", x: 0, y: 0, width: 200, height: 80, text: id }) as const;
const doc = (...ids: string[]): CanvasDoc => ({ nodes: ids.map(note), edges: [] });

describe("RTS bottom bar keeps its hook order", () => {
  let host: HTMLDivElement;
  let root: Root;
  let errors: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    errors = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    errors.mockRestore();
    state$.doc.set({ nodes: [], edges: [] });
    state$.selectedNodeId.set("");
    state$.selectedNodeIds.set([]);
  });

  const hookErrors = (): string[] =>
    errors.mock.calls.map((call: unknown[]) => String(call[0])).filter((text: string) => /hook/i.test(text));

  it("survives the selected node being removed, selected again, and removed", () => {
    act(() => {
      state$.doc.set(doc("a", "b"));
      state$.selectedNodeId.set("a");
      state$.selectedNodeIds.set(["a"]);
      root.render(<RtsBottomBar minimap={null} />);
    });
    expect(host.querySelector(".rts-cmd__title")?.textContent).toBe("a");

    // The node goes while it is still the selection.
    expect(() => act(() => state$.doc.set(doc("b")))).not.toThrow();
    expect(host.textContent).toContain("No selection");

    // It comes back, then goes again, in the same mounted bar.
    expect(() => act(() => state$.doc.set(doc("a", "b")))).not.toThrow();
    expect(host.querySelector(".rts-cmd__title")?.textContent).toBe("a");
    expect(() => act(() => state$.doc.set(doc("b")))).not.toThrow();

    expect(hookErrors()).toEqual([]);
  });
});
