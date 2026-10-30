import { Layer, ManagedRuntime } from "effect";
import { expect, it } from "vitest";
import { inProcessCore, type CoreRunner } from "./support/in-process-core";
import { bindOverseerLive } from "../src/main/core-process/ops/overseer-live";
import { coreOverseerLive } from "../src/main/core-process/main-side/overseer-live";

// The window's live controls reach the core's live overseer by name; snapshots come back as pushes.
it("answers the window's live controls from the core's live overseer, and pushes each snapshot", async () => {
  const runtime = ManagedRuntime.make(Layer.empty);
  const live = coreOverseerLive(inProcessCore(runtime as unknown as CoreRunner));
  try {
    await expect(live.liveSnapshot()).rejects.toThrow();
    const asked: unknown[] = [];
    const listeners: Array<(snapshot: never) => void> = [];
    const snapshot = { sessions: [] } as never;
    bindOverseerLive({
      liveStart: async (input) => (asked.push(["start", input]), { ok: true } as never),
      liveEnd: async () => snapshot,
      liveSnapshot: async () => snapshot,
      liveReady: async (sessionId, epoch) => void asked.push(["ready", sessionId, epoch]),
      liveProviderEvent: async () => undefined,
      liveAttention: async () => undefined,
      liveCancel: async () => snapshot,
      liveSteer: async (sessionId, requestId, text) => (asked.push(["steer", sessionId, requestId, text]), snapshot),
      liveStopActions: async () => snapshot,
      subscribe: (listener) => (listeners.push(listener as never), () => undefined),
    });
    expect(await live.liveSnapshot()).toEqual(snapshot);
    await live.liveReady("s1", 2);
    await live.liveSteer("s1", "r1", "go left", { canvasName: "factory" } as never);
    expect(asked).toEqual([["ready", "s1", 2], ["steer", "s1", "r1", "go left"]]);
    const seen: unknown[] = [];
    const stop = live.subscribe((next) => seen.push(next));
    live.subscribe(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(listeners).toHaveLength(1);
    listeners[0]!({ sessions: ["a"] } as never);
    stop();
    listeners[0]!({ sessions: ["b"] } as never);
    expect(seen).toEqual([{ sessions: ["a"] }]);
  } finally {
    bindOverseerLive(undefined);
    await runtime.dispose();
  }
});
