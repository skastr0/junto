// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { Schema } from "effect";
import { Node, asCanvasName, type Changed, type Opened } from "../src/shared/model";
import type { ChatChromeChanged } from "../src/renderer/lib/chat-chrome-store";
import { useRegionRollups } from "../src/renderer/lib/region-rollups";
import { modelStore } from "../src/renderer/lib/use-model";
import { state$ } from "../src/renderer/lib/state";

it("hydrates already-pending ACP permission without ChatView and reads no rollup after model commands", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  const oldApi = window.junto, oldName = state$.canvasName.peek();
  const bridge = window as unknown as { junto: typeof window.junto };
  const canvas = asCanvasName("local-rollup-hook");
  const decode = Schema.decodeUnknownSync(Node);
  const frame = { x: 10, y: 10, width: 40, height: 40, z: 0 };
  const seat = decode({ ...frame, kind: "agent", id: "seat", label: "Seat", agentKey: "local:hook-seat", bindingId: "hook-binding", host: "local", overseer: false, harness: "codex", onRemove: "detach" });
  let change!: (event: Changed) => void;
  let chrome!: (event: ChatChromeChanged) => void;
  const regionRollups = vi.fn(), readCanvas = vi.fn(), chatOpen = vi.fn();
  const chatChrome = vi.fn(async () => ({ revision: 5, states: [{ agentKey: "local:hook-seat", sessionLive: true, permissionPending: true }] }));
  const workAttention = vi.fn(async () => ({ glances: [], items: [] }));
  const offChat = vi.fn(), offWork = vi.fn();
  bridge.junto = {
    modelOpen: async () => ({ canvas, seq: 1, nodes: [decode({ ...frame, kind: "region", id: "r", x: 0, y: 0, width: 200, height: 200, label: "Region", hold: false }), seat], wires: [] }) as Opened,
    onModelChanged: (listener: typeof change) => { change = listener; return () => {}; },
    chatChrome, onChatChromeChanged: (listener: typeof chrome) => { chrome = listener; return offChat; },
    workAttention, onWorkSinkChanged: () => offWork,
    regionRollups, readCanvas, chatOpen,
  } as unknown as typeof window.junto;
  const releaseModel = modelStore.open(canvas);
  const flush = async () => { for (let i = 0; i < 30; ++i) await Promise.resolve(); };
  const View = () => { const rollups = useRegionRollups(); return <div>{rollups[0]?.severity}:{rollups[0]?.members[0]?.label}</div>; };
  try {
    await modelStore.ready(canvas);
    state$.canvasName.set(canvas);
    await act(async () => { root.render(<View />); await flush(); });
    expect(host.textContent).toBe("attention:Seat");
    expect(chatChrome).toHaveBeenCalledOnce();
    expect(workAttention).toHaveBeenCalledOnce();
    expect(chatOpen).not.toHaveBeenCalled();
    await act(async () => {
      change({ canvas, seq: 2, nodes: [{ ...seat, label: "Renamed" } as Node], wires: [], removedNodes: [], removedWires: [] });
      state$.docEpoch.set(state$.docEpoch.peek() + 1);
      await flush();
    });
    expect(host.textContent).toBe("attention:Renamed");
    await act(async () => { chrome({ revision: 6, state: { agentKey: "local:hook-seat", sessionLive: true, permissionPending: false } }); await flush(); });
    expect(host.textContent).toBe("idle:Renamed");
    // A former 300 ms poll would have fired by now, without another command.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 350)); });
    expect(regionRollups).not.toHaveBeenCalled(); expect(readCanvas).not.toHaveBeenCalled();
    expect(chatChrome).toHaveBeenCalledOnce(); expect(workAttention).toHaveBeenCalledOnce();
  } finally {
    await act(async () => root.unmount());
    releaseModel(); host.remove(); bridge.junto = oldApi; state$.canvasName.set(oldName);
    vi.unstubAllGlobals();
  }
  expect(offChat).toHaveBeenCalledOnce(); expect(offWork).toHaveBeenCalledOnce();
});
