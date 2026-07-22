import { Effect, Queue, Stream } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AcpClient,
  type AcpClientHandlers,
} from "../src/main/vellum/chat/acp-client";
import { buildAcpSpawnTarget } from "../src/main/vellum/chat/spawn";
import { EffectAcpChild } from "../src/main/vellum/hermes/plane";
import { parseHermesProfileName } from "../src/main/vellum/hermes/domain";
import { HermesTransport } from "../src/main/vellum/hermes/transport";
import type {
  ConfirmSshReady,
  SshLease,
  SshReady,
} from "../src/main/vellum/ssh";

afterEach(() => {
  vi.useRealTimers();
});

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

  it("returns the public bound while an Effect.never cleanup remains tracked", async () => {
    const stdout = await Effect.runPromise(Queue.unbounded<Uint8Array>());
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    let connected!: () => void;
    const connectedPromise = new Promise<void>((resolve) => { connected = resolve; });
    const lease: SshLease = {
      write: (bytes) => Effect.gen(function* () {
        const request = JSON.parse(decoder.decode(bytes).trim()) as {
          readonly id: string | number;
          readonly method: string;
        };
        if (request.method === "initialize") {
          yield* Queue.offer(
            stdout,
            encoder.encode(`${JSON.stringify({
              jsonrpc: "2.0",
              id: request.id,
              result: { protocolVersion: 1, agentCapabilities: {} },
            })}\n`),
          );
        }
      }),
      closeInput: Effect.void,
      stdout: Stream.fromQueue(stdout),
      stderr: Stream.empty,
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
        yield* Effect.addFinalizer(() => Effect.never);
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
    const handlers: AcpClientHandlers = {
      onNotification: vi.fn(),
      onAgentRequest: vi.fn(),
      onLifecycle: vi.fn(),
    };
    const client = new AcpClient(
      buildAcpSpawnTarget("studio:default")!,
      handlers,
      () => ({
        kind: "remote-scope",
        child,
        close: () => child.close(),
        isClean: () => child.clean,
      }),
    );
    let terminalObserved = false;
    child.on("error", () => undefined);
    child.on("close", () => { terminalObserved = true; });

    const start = client.start();
    await connectedPromise;
    await start;
    vi.useFakeTimers();

    const publicClose = client.close();
    const underlyingClose = child.close();
    let underlyingSettled = false;
    void underlyingClose.then(() => { underlyingSettled = true; });
    await vi.advanceTimersByTimeAsync(4_000);

    await expect(publicClose).resolves.toEqual([
      { kind: "bounded", termAttempted: false, killAttempted: false },
    ]);
    expect(underlyingSettled).toBe(false);
    expect(terminalObserved).toBe(false);
    expect(client.retainedGenerationCount).toBe(1);
  });
});
