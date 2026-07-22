import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import type { ChatCloseAllResult } from "../src/main/vellum/chat/service";
import {
  finalizeHermesShutdown,
  makeHermesShutdownPort,
  type HermesShutdownPort,
} from "../src/main/vellum/hermes/plane";

const deferred = <Value>() => {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
};

describe("Hermes shutdown port", () => {
  it("publishes one reentrant flight before closing ChatService admission", async () => {
    const close = deferred<ChatCloseAllResult>();
    let shutdown!: HermesShutdownPort;
    let reentrant: Promise<unknown> | undefined;
    let admissionOpen = true;
    const closeAll = vi.fn(() => {
      admissionOpen = false;
      reentrant = shutdown.drainOnQuit();
      return close.promise;
    });
    shutdown = makeHermesShutdownPort({ closeAll });

    const first = shutdown.drainOnQuit();
    const concurrent = shutdown.drainOnQuit();

    expect(admissionOpen).toBe(false);
    expect(reentrant).toBe(first);
    expect(concurrent).toBe(first);
    expect(closeAll).toHaveBeenCalledTimes(1);

    const receipt = Object.freeze({
      clean: true,
      teardowns: Object.freeze([]),
    });
    close.resolve(receipt);
    await expect(first).resolves.toBe(receipt);
  });

  it("makes the Effect finalizer reuse an explicit in-flight shutdown", async () => {
    const close = deferred<ChatCloseAllResult>();
    const closeAll = vi.fn(() => close.promise);
    const shutdown = makeHermesShutdownPort({ closeAll });

    const explicit = shutdown.drainOnQuit();
    const finalizer = Effect.runPromise(finalizeHermesShutdown(shutdown));

    expect(closeAll).toHaveBeenCalledTimes(1);
    const receipt = Object.freeze({
      clean: true,
      teardowns: Object.freeze([
        Object.freeze({ kind: "terminal" as const, event: "close" as const, code: 0 }),
      ]),
    });
    close.resolve(receipt);

    await expect(explicit).resolves.toBe(receipt);
    await expect(finalizer).resolves.toBe(receipt);
    expect(closeAll).toHaveBeenCalledTimes(1);
  });

  it("preserves every unclean local and remote ACP teardown receipt", async () => {
    const receipt: ChatCloseAllResult = Object.freeze({
      clean: false,
      teardowns: Object.freeze([
        Object.freeze({
          kind: "bounded" as const,
          termAttempted: true,
          killAttempted: true,
        }),
        Object.freeze({
          kind: "unclean" as const,
          reason: "remote-scope-close-failed" as const,
        }),
      ]),
    });
    const closeAll = vi.fn(() => Promise.resolve(receipt));
    const shutdown = makeHermesShutdownPort({ closeAll });

    await expect(shutdown.drainOnQuit()).resolves.toBe(receipt);
    await expect(
      Effect.runPromise(finalizeHermesShutdown(shutdown)),
    ).rejects.toThrow("chat shutdown retained 2 unclean teardown(s)");
    expect(closeAll).toHaveBeenCalledTimes(1);
  });

  it("contains a rejected close sink as an explicit unclean receipt", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const closeAll = vi.fn(() => Promise.reject(new Error("close sink failed")));
      const shutdown = makeHermesShutdownPort({ closeAll });

      await expect(shutdown.drainOnQuit()).resolves.toEqual({
        clean: false,
        teardowns: [],
        failure: {
          kind: "chat-close-rejected",
          message: "close sink failed",
        },
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandled).not.toHaveBeenCalled();
      expect(closeAll).toHaveBeenCalledTimes(1);
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });
});
