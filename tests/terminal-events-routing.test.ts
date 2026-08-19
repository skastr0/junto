import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type TerminalBridge = {
  readonly onTerminalEvent: (listener: (event: unknown) => void) => () => void;
};

type Bridge = {
  readonly deliver: (event: unknown) => void;
  readonly subscribeIpc: ReturnType<typeof vi.fn>;
  readonly unsubscribeIpc: ReturnType<typeof vi.fn>;
};

const installBridge = (): Bridge => {
  let sink: ((event: unknown) => void) | undefined;
  const unsubscribeIpc = vi.fn(() => {
    sink = undefined;
  });
  const subscribeIpc = vi.fn((listener: (event: unknown) => void) => {
    sink = listener;
    return unsubscribeIpc;
  });
  (globalThis as unknown as { window: { vellumCommand: TerminalBridge } }).window = {
    vellumCommand: { onTerminalEvent: subscribeIpc },
  };
  return {
    deliver: (event: unknown) => sink?.(event),
    subscribeIpc,
    unsubscribeIpc,
  };
};

/**
 * The fan-out is renderer-wide module state. Reload it per test so one
 * assertion failure cannot leak listeners into the next case.
 */
const loadFanOut = async () => {
  vi.resetModules();
  return await import("../src/renderer/lib/terminal-events");
};

const output = (bindingId: string) => ({
  type: "output",
  bindingId,
  epoch: "e1",
  data: "x",
});

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe("onTerminalEvent binding routing", () => {
  it("delivers an addressed event only to that binding's listeners", async () => {
    const bridge = installBridge();
    const { onTerminalEvent } = await loadFanOut();
    const cardA = vi.fn();
    const cardB = vi.fn();
    const surface = vi.fn();
    onTerminalEvent(cardA, { bindingId: "binding-a" });
    onTerminalEvent(cardB, { bindingId: "binding-b" });
    onTerminalEvent(surface);

    bridge.deliver(output("binding-a"));
    expect(cardA).toHaveBeenCalledTimes(1);
    expect(cardB).toHaveBeenCalledTimes(0);
    expect(surface).toHaveBeenCalledTimes(1);

    bridge.deliver(output("binding-b"));
    expect(cardA).toHaveBeenCalledTimes(1);
    expect(cardB).toHaveBeenCalledTimes(1);
    expect(surface).toHaveBeenCalledTimes(2);
  });

  it("keeps one IPC subscription no matter how many bindings are indexed", async () => {
    const bridge = installBridge();
    const { onTerminalEvent } = await loadFanOut();
    const offs = Array.from({ length: 48 }, (_unused, index) =>
      onTerminalEvent(vi.fn(), { bindingId: `binding-${index}` }),
    );
    expect(bridge.subscribeIpc).toHaveBeenCalledTimes(1);
    for (const off of offs) off();
    expect(bridge.unsubscribeIpc).toHaveBeenCalledTimes(1);
  });

  it("broadcasts an event that carries no binding so no exit is lost", async () => {
    const bridge = installBridge();
    const { onTerminalEvent } = await loadFanOut();
    const cardA = vi.fn();
    const cardB = vi.fn();
    const surface = vi.fn();
    onTerminalEvent(cardA, { bindingId: "binding-a" });
    onTerminalEvent(cardB, { bindingId: "binding-b" });
    onTerminalEvent(surface);

    bridge.deliver({ type: "exit" });
    expect(cardA).toHaveBeenCalledTimes(1);
    expect(cardB).toHaveBeenCalledTimes(1);
    expect(surface).toHaveBeenCalledTimes(1);

    bridge.deliver({ type: "exit", bindingId: "" });
    expect(cardA).toHaveBeenCalledTimes(2);
    expect(cardB).toHaveBeenCalledTimes(2);
    expect(surface).toHaveBeenCalledTimes(2);

    bridge.deliver("not an object");
    expect(cardA).toHaveBeenCalledTimes(3);
    expect(cardB).toHaveBeenCalledTimes(3);
    expect(surface).toHaveBeenCalledTimes(3);
  });

  it("re-keys without dropping an event or leaking the old bucket", async () => {
    const bridge = installBridge();
    const { onTerminalEvent } = await loadFanOut();
    const card = vi.fn();
    // Stand in for the open xterm surface, so the re-key below happens with
    // the bridge live rather than at a zero-listener teardown.
    const surface = vi.fn();
    const offSurface = onTerminalEvent(surface);
    // What a React effect does when its bindingId dependency changes: tear
    // down, then resubscribe, inside the same synchronous commit.
    const offOld = onTerminalEvent(card, { bindingId: "binding-old" });
    bridge.deliver(output("binding-old"));
    expect(card).toHaveBeenCalledTimes(1);

    offOld();
    const offNew = onTerminalEvent(card, { bindingId: "binding-new" });
    // Nothing was dropped in the gap: the one bridge subscription never
    // churned across the re-key.
    expect(bridge.subscribeIpc).toHaveBeenCalledTimes(1);
    expect(bridge.unsubscribeIpc).not.toHaveBeenCalled();

    bridge.deliver(output("binding-old"));
    expect(card).toHaveBeenCalledTimes(1);
    bridge.deliver(output("binding-new"));
    expect(card).toHaveBeenCalledTimes(2);
    expect(surface).toHaveBeenCalledTimes(3);

    // Leak proof: had the release emptied the wrong bucket, the listener
    // count could never reach zero and the bridge would stay subscribed.
    offNew();
    offSurface();
    expect(bridge.unsubscribeIpc).toHaveBeenCalledTimes(1);
  });

  it("re-keys through a bucket the old listener had to itself", async () => {
    const bridge = installBridge();
    const { onTerminalEvent } = await loadFanOut();
    const surface = vi.fn();
    const card = vi.fn();
    onTerminalEvent(surface);
    const offOld = onTerminalEvent(card, { bindingId: "binding-old" });
    offOld();
    const offNew = onTerminalEvent(card, { bindingId: "binding-old" });

    bridge.deliver(output("binding-old"));
    expect(card).toHaveBeenCalledTimes(1);
    offNew();
    bridge.deliver(output("binding-old"));
    expect(card).toHaveBeenCalledTimes(1);
    expect(surface).toHaveBeenCalledTimes(2);
  });

  it("lets a throwing listener not interrupt delivery to its binding peers", async () => {
    const bridge = installBridge();
    const { onTerminalEvent } = await loadFanOut();
    const healthy = vi.fn();
    const surface = vi.fn();
    onTerminalEvent(
      () => {
        throw new Error("card gone");
      },
      { bindingId: "binding-a" },
    );
    onTerminalEvent(healthy, { bindingId: "binding-a" });
    onTerminalEvent(surface);

    expect(() => bridge.deliver(output("binding-a"))).not.toThrow();
    expect(healthy).toHaveBeenCalledTimes(1);
    expect(surface).toHaveBeenCalledTimes(1);
  });

  it("releases idempotently so a double unsubscribe cannot orphan the bridge", async () => {
    const bridge = installBridge();
    const { onTerminalEvent } = await loadFanOut();
    const first = vi.fn();
    const second = vi.fn();
    const offFirst = onTerminalEvent(first, { bindingId: "binding-a" });
    const offSecond = onTerminalEvent(second, { bindingId: "binding-a" });

    offFirst();
    offFirst();
    expect(bridge.unsubscribeIpc).not.toHaveBeenCalled();
    bridge.deliver(output("binding-a"));
    expect(first).toHaveBeenCalledTimes(0);
    expect(second).toHaveBeenCalledTimes(1);

    offSecond();
    expect(bridge.unsubscribeIpc).toHaveBeenCalledTimes(1);
  });
});
