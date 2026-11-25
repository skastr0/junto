// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Schema } from "effect";
import { Node } from "@shared/model";
import { batch } from "@legendapp/state";
import { modelStore } from "../src/window/lib/use-model";

// jsdom has no ResizeObserver; a module the bar imports builds one at load.
vi.hoisted(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
});

import { ReseatConfirmDialog } from "../src/window/components/rts/ReseatConfirmDialog";
import { RtsBottomBar } from "../src/window/components/rts/RtsBottomBar";
import { newSeat } from "../src/window/lib/model-factories";
import { state$ } from "../src/window/lib/state";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const canvasName = "reseat-copy";

describe("the re-seat copy the operator reads", () => {
  let host: HTMLDivElement;
  let root: Root;
  let canvasContext: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    canvasContext = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    canvasContext.mockRestore();
    batch(() => {
      state$.canvasName.set("");
      state$.selectedNodeId.set("");
      state$.selectedNodeIds.set([]);
      modelStore.canvas$(canvasName).nodes.set({});
      modelStore.canvas$(canvasName).nodeIds.set([]);
    });
  });

  const dialog = (count?: number) => {
    act(() =>
      root.render(
        <ReseatConfirmDialog toLabel="Codex" fromLabel="Claude Code" count={count} onConfirm={() => undefined} onCancel={() => undefined} />,
      ),
    );
    return document.body.textContent ?? "";
  };

  it("the confirm of several seats names what it stops: agents", () => {
    expect(dialog(3)).toContain("Stop and re-seat 3 agents");
  });

  it("the confirm of one seat says the new process starts in this seat, never on a fresh one", () => {
    const text = dialog();
    expect(text).toContain("starts a new one in this seat");
    expect(text).not.toContain("fresh seat");
  });

  it("a mixed selection that holds seats is not headed shared settings only, and its status region is always mounted", () => {
    const note = Schema.decodeUnknownSync(Node)({ kind: "note", id: "n", x: 0, y: 0, width: 200, height: 80, z: 0, text: "n" });
    const seat = newSeat({ x: 300, y: 0, z: 1 }, { harness: "claude", host: "studio", cwd: "/p/a", label: "a" });
    act(() => {
      batch(() => {
        state$.canvasName.set(canvasName);
        modelStore.canvas$(canvasName).nodes.set({ n: note, [seat.id]: seat });
        modelStore.canvas$(canvasName).nodeIds.set(["n", seat.id]);
        state$.selectedNodeId.set("");
        state$.selectedNodeIds.set(["n", seat.id]);
      });
      root.render(<RtsBottomBar minimap={null} />);
    });
    const title = host.querySelector(".rts-cmd__title")?.textContent;
    expect(title).toBe("shared settings and agents");
    const status = host.querySelector(".rts-cmd__reseat-line");
    expect(status?.getAttribute("role")).toBe("status");
    expect(status?.textContent).toBe("");
  });
});
