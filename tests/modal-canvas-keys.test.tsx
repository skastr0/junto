// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canvasDeleteKeyCode } from "../src/renderer/lib/canvas-keys";
import { dispatchKey, keySituation } from "../src/renderer/lib/key-dispatcher";
import { pushModal, resetModalStack, useAnyModalOpen } from "../src/renderer/lib/modal-stack";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const openModal = () =>
  pushModal({
    layer: "working",
    container: () => null,
    trap: false,
    onEscape: () => false,
    onClose: () => undefined,
  });

const press = (over: Partial<KeyboardEvent> & { key: string }) =>
  ({
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    repeat: false,
    isComposing: false,
    target: document.body,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    ...over,
  }) as unknown as KeyboardEvent;

const Probe = () => <span data-modal={useAnyModalOpen() ? "open" : "closed"} />;

describe("canvas keys stand down under a modal", () => {
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
    resetModalStack();
  });

  it("turns React Flow's document delete chord off while a modal is open", () => {
    expect(canvasDeleteKeyCode(false, false)).toEqual(["Backspace", "Delete"]);
    expect(canvasDeleteKeyCode(true, false)).toBeNull();
    expect(canvasDeleteKeyCode(false, true)).toBeNull();
    expect(canvasDeleteKeyCode(true, true)).toBeNull();
  });

  it("follows the stack live, so the canvas re-renders when a modal opens or closes", () => {
    act(() => root.render(<Probe />));
    const shown = () => host.querySelector("[data-modal]")?.getAttribute("data-modal");
    expect(shown()).toBe("closed");

    let leave: (() => void) | undefined;
    act(() => {
      leave = openModal().leave;
    });
    expect(shown()).toBe("open");

    act(() => leave?.());
    expect(shown()).toBe("closed");
  });

  it("keeps the canvas's own shortcuts from running while a modal is up", () => {
    const recall = vi.fn();
    const save = vi.fn();
    const leave = openModal().leave;
    try {
      const situation = keySituation(document.body);
      expect(dispatchKey(press({ key: "2" }), { "groups.recall": recall }, situation)).toBeNull();
      expect(recall).not.toHaveBeenCalled();
      // A shortcut the modal's layer allows still runs: the stack is not a blanket stop.
      const saveKey = situation.mac ? { metaKey: true } : { ctrlKey: true };
      expect(dispatchKey(press({ key: "s", ...saveKey }), { "files.save": save }, situation)).toBe("files.save");
      expect(save).toHaveBeenCalledTimes(1);
    } finally {
      leave();
    }
  });
});
