/**
 * Quit is closing one scope (#576). The children are acquired in the scope and
 * released by it in reverse order, so the core drains and leaves before the
 * terminal process its seats run on is signalled. A child that hangs fails as a
 * tagged error, is kept on the quit's receipt, and does not stop the other
 * child from being stopped.
 */
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

const order: string[] = [];

const terminals = {
  connect: () => {
    throw new Error("no port in this test");
  },
  onRestart: () => () => undefined,
  stop: () => Effect.sync(() => {
    order.push("terminals");
  }),
};

vi.mock("../src/main/terminal-process/host", () => ({
  startTerminalProcessForCore: () => {
    order.push("terminals acquired");
    return terminals;
  },
}));

const { openChildren, takeChildStopFailures } = await import("../src/main/core-process/children");
const { CoreDidNotStop } = await import("../src/main/core-process/host");

const core = (stop: () => Effect.Effect<void, InstanceType<typeof CoreDidNotStop>>) => ({
  client: { call: () => Promise.reject(new Error("no call in this test")), onPush: () => () => undefined, fail: () => undefined },
  stop,
});

describe("the children's scope", () => {
  it("acquires the terminals, then the core, and releases the core first", async () => {
    order.length = 0;
    const children = await Effect.runPromise(
      openChildren((givenTerminals) => {
        expect(givenTerminals).toBe(terminals);
        order.push("core acquired");
        return core(() =>
          Effect.sync(() => {
            order.push("core");
          }),
        ) as never;
      }),
    );
    expect(order).toEqual(["terminals acquired", "core acquired"]);

    await children.close();
    expect(order).toEqual(["terminals acquired", "core acquired", "core", "terminals"]);
    expect(takeChildStopFailures()).toEqual([]);
  });

  it("names a child that hung, and still stops the one after it", async () => {
    order.length = 0;
    const children = await Effect.runPromise(
      openChildren(() =>
        core(() =>
          Effect.fail(
            new CoreDidNotStop({ detail: "the core did not exit within 10 ms of its stop; killed" }),
          ),
        ) as never,
      ),
    );
    await children.close();
    // Release order holds even when the first release fails.
    expect(order).toEqual(["terminals acquired", "terminals"]);
    const failures = takeChildStopFailures();
    expect(failures).toHaveLength(1);
    expect(failures[0]?._tag).toBe("CoreDidNotStop");
    // The receipt is taken once: a second quit has nothing to report.
    expect(takeChildStopFailures()).toEqual([]);
  });
});
