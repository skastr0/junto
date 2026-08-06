import { afterEach, describe, expect, it, vi } from "vitest";
import { onTerminalEvent } from "../src/renderer/lib/terminal-events";

type TerminalBridge = {
  readonly onTerminalEvent: (listener: (event: unknown) => void) => () => void;
};

const installBridge = (bridge: TerminalBridge): void => {
  (globalThis as unknown as { window: { vellumCommand: TerminalBridge } }).window = {
    vellumCommand: bridge,
  };
};

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe("onTerminalEvent", () => {
  it("fans every renderer consumer out from one IPC listener", () => {
    let deliver: ((event: unknown) => void) | undefined;
    const unsubscribeIpc = vi.fn();
    const subscribeIpc = vi.fn((listener: (event: unknown) => void) => {
      deliver = listener;
      return unsubscribeIpc;
    });
    installBridge({ onTerminalEvent: subscribeIpc });

    const first = vi.fn();
    const second = vi.fn();
    const offFirst = onTerminalEvent(first);
    const offSecond = onTerminalEvent(second);

    expect(subscribeIpc).toHaveBeenCalledTimes(1);
    deliver?.({ bindingId: "agent-1", type: "output" });
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);

    offFirst();
    deliver?.({ bindingId: "agent-2", type: "exit" });
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(2);
    expect(unsubscribeIpc).not.toHaveBeenCalled();

    offSecond();
    expect(unsubscribeIpc).toHaveBeenCalledTimes(1);
  });

  it("isolates a failing consumer and can subscribe again after the last leaves", () => {
    const deliveries: Array<(event: unknown) => void> = [];
    const unsubscribeIpc = vi.fn();
    const subscribeIpc = vi.fn((listener: (event: unknown) => void) => {
      deliveries.push(listener);
      return unsubscribeIpc;
    });
    installBridge({ onTerminalEvent: subscribeIpc });

    const offThrowing = onTerminalEvent(() => {
      throw new Error("card gone");
    });
    const healthy = vi.fn();
    const offHealthy = onTerminalEvent(healthy);
    expect(() => deliveries[0]?.({ type: "output" })).not.toThrow();
    expect(healthy).toHaveBeenCalledTimes(1);
    offThrowing();
    offHealthy();

    const offNext = onTerminalEvent(vi.fn());
    expect(subscribeIpc).toHaveBeenCalledTimes(2);
    offNext();
  });
});
