// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { CanvasNode } from "../src/shared/canvas";
import { PAD_ENABLED } from "../src/shared/features";
import { asPadElementId, emptyPad } from "../src/shared/pad";
import type { WorkSinkChanged } from "../src/shared/work-sinks";
import { PadCard } from "../src/renderer/components/pad/PadCard";
import { state$ } from "../src/renderer/lib/state";

it.skipIf(!PAD_ENABLED)("reads pad counts and thumbnail revisions from scoped Work events without a node snapshot", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const previousApi = window.junto;
  const bridge = window as unknown as { junto: typeof window.junto };
  const previousCanvas = state$.canvasName.peek();
  let revision = 1;
  let notify!: (event: WorkSinkChanged) => void;
  const unsubscribe = vi.fn();
  const workSinkPage = vi.fn(async () => ({ kind: "pad" as const,
    glance: { revision, shapeCount: revision + 2, unreadPinCount: revision },
  }));
  const workPadRead = vi.fn(async () => ({ ok: true, data: { pad: {
    ...emptyPad(), revision,
    shapes: [{ id: asPadElementId("shape"), type: "box" as const, x: 0, y: 0, w: 100, h: 100, z: 0 }],
  } } }));
  const readCanvas = vi.fn();
  bridge.junto = { workSinkPage, workPadRead, readCanvas,
    onWorkSinkChanged: (listener: typeof notify) => { notify = listener; return unsubscribe; },
  } as unknown as typeof window.junto;
  state$.canvasName.set("pad-card-store");
  const node: CanvasNode = { id: "pad", type: "text", text: "Sketch", x: 0, y: 0, width: 200, height: 100 };
  const flush = async () => { for (let index = 0; index < 20; index += 1) await Promise.resolve(); };
  try {
    await act(async () => { root.render(<PadCard node={node} />); await flush(); });
    expect(workSinkPage).toHaveBeenCalledWith({ kind: "pad", canvasName: "pad-card-store", nodeId: "pad" });
    expect(host.querySelector('[data-testid="pad-glance"]')?.textContent).toBe("3 shapes - 1 new");
    expect(host.querySelector('[data-testid="pad-card-thumb"]')).not.toBeNull();
    expect(workPadRead).toHaveBeenCalledTimes(1);
    await act(async () => { notify({ canvasName: "pad-card-store", nodeId: "unrelated" }); await flush(); });
    expect(workSinkPage).toHaveBeenCalledTimes(1);
    revision = 2;
    await act(async () => { notify({ canvasName: "pad-card-store", nodeId: "pad" }); await flush(); });
    expect(host.querySelector('[data-testid="pad-glance"]')?.textContent).toBe("4 shapes - 2 new");
    expect(workPadRead).toHaveBeenCalledTimes(2);
    expect(readCanvas).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    expect(unsubscribe).toHaveBeenCalledOnce();
    host.remove();
    bridge.junto = previousApi;
    state$.canvasName.set(previousCanvas);
    vi.unstubAllGlobals();
  }
});
