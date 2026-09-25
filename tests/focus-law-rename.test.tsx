// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeCanvasExternalReloadCoordinator } from "../src/renderer/lib/canvas-external-reload";
import { flushCanvasEdits } from "../src/renderer/lib/canvas-editor-flush";
import { FirstLineRenameInput } from "../src/renderer/components/nodes/FirstLineRenameInput";
import type { CanvasDoc } from "@shared/canvas";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const typeInto = (input: HTMLInputElement, value: string): void => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
};

describe("focus law: agent rename survives live canvas traffic", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("keeps focus, caret, and draft when agent activity broadcasts canvasChanged", async () => {
    const onCommit = vi.fn();
    const onDone = vi.fn();
    act(() => {
      root.render(
        <FirstLineRenameInput
          initial="builder"
          ariaLabel="Rename agent node"
          onCommit={onCommit}
          onDone={onDone}
        />,
      );
    });
    const input = host.querySelector("input")!;
    expect(document.activeElement).toBe(input);

    act(() => typeInto(input, "builder-two"));
    input.setSelectionRange(7, 7);

    // Work-fact commits (agent activity) and save echoes both arrive as
    // canvasChanged; App wires that notification to this coordinator with
    // flushCanvasEdits as its editor boundary.
    const doc = { nodes: [], edges: [] } as unknown as CanvasDoc;
    const reload = makeCanvasExternalReloadCoordinator({
      flushLocalEdits: () => flushCanvasEdits("background"),
      readCanvas: async (name) => ({ name, doc, revision: "r2", workRevision: "w2" }) as never,
      currentCanvasName: () => "main",
      currentDoc: () => doc,
      currentDocEpoch: () => 1,
      currentRevision: () => "r1",
      hasPendingChanges: () => false,
      acceptRevision: () => undefined,
      apply: () => undefined,
      onFailure: (error) => {
        throw error;
      },
    });
    for (let tick = 0; tick < 5; tick++) {
      await act(async () => {
        await reload.changed("main");
      });
    }

    expect(document.activeElement).toBe(input);
    expect(input.value).toBe("builder-two");
    expect(input.selectionStart).toBe(7);
    expect(onCommit).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
  });

  it("still lands the draft when the canvas is navigated away", async () => {
    const onCommit = vi.fn();
    const onDone = vi.fn();
    act(() => {
      root.render(
        <FirstLineRenameInput
          initial="builder"
          ariaLabel="Rename agent node"
          onCommit={onCommit}
          onDone={onDone}
        />,
      );
    });
    const input = host.querySelector("input")!;
    act(() => typeInto(input, "builder-two"));

    await act(async () => {
      await flushCanvasEdits("navigation");
    });

    expect(onCommit).toHaveBeenCalledWith("builder-two");
    expect(onDone).toHaveBeenCalledOnce();
  });
});
