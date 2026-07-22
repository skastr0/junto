import { Effect, Stream } from "effect";
import { describe, expect, it, vi } from "vitest";
import { EffectAcpChild } from "../src/main/vellum/hermes/plane";
import { parseHermesProfileName } from "../src/main/vellum/hermes/domain";
import { HermesTransport } from "../src/main/vellum/hermes/transport";
import type {
  ConfirmSshReady,
  SshLease,
  SshReady,
} from "../src/main/vellum/ssh";

describe("EffectAcpChild scoped teardown", () => {
  it("contains a rejecting scope finalizer and emits terminal events only after cleanup", async () => {
    const order: string[] = [];
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    let connected!: () => void;
    const connectedPromise = new Promise<void>((resolve) => { connected = resolve; });
    const lease: SshLease = {
      write: () => Effect.void,
      closeInput: Effect.void,
      stdout: Stream.fromEffect(Effect.never),
      stderr: Stream.fromEffect(Effect.never),
      exitCode: Effect.never,
      close: Effect.void,
    };
    const transport = {
      connectAcp: (
        _host: string,
        _profile: string,
        awaitReady: (
          lease: SshLease,
          confirm: ConfirmSshReady,
        ) => Effect.Effect<SshReady<unknown>, unknown, unknown>,
      ) => Effect.gen(function* () {
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => { order.push("scope-finalizer"); }).pipe(
            Effect.andThen(Effect.die(new Error("scope close failed"))),
          ),
        );
        connected();
        const ready = yield* awaitReady(
          lease,
          ((value: unknown) => ({ value })) as ConfirmSshReady,
        );
        return ready.value;
      }),
    } as unknown as typeof HermesTransport.Service;
    const runPromise = <A, E>(effect: Effect.Effect<A, E>): Promise<A> =>
      Effect.runPromise(effect);
    const child = new EffectAcpChild(
      runPromise,
      transport,
      "studio",
      parseHermesProfileName("default")!,
    );
    child.on("error", () => {
      order.push("error");
      throw new Error("observer failed");
    });
    child.on("exit", () => { order.push("exit"); });
    child.on("close", () => { order.push("close"); });

    try {
      await connectedPromise;
      const first = child.close();
      const second = child.close();
      expect(second).toBe(first);
      await first;
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(child.clean).toBe(false);
      expect(order).toEqual(["scope-finalizer", "error", "exit", "close"]);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });
});
