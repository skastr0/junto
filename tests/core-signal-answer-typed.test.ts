/**
 * Answering a signal types the answer into its seat. The mail is appended by
 * the core's signal op and delivery is configured only in the core
 * (core-runtime.ts), so the op must deliver; main's copy of messageDelivery
 * has no transport and its call returned "waiting", leaving an answered seat
 * sitting idle until a boot scan or a live event.
 */
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

const SIGNAL = { signalId: "s1", canvasName: "factory", nodeId: "seat-a" };
const MESSAGE = "01M5EVKRB1X4P80GXRGDK8V5AS";

vi.mock("../src/main/junto/signals/operator", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/main/junto/signals/operator")>();
  const answered = () => Effect.succeed({ ok: true as const, signal: SIGNAL as never, messageId: MESSAGE });
  return { ...actual, answerAgentSignal: answered, replyAgentSignal: answered, dismissAgentSignal: answered };
});

vi.mock("../src/main/junto/vault/secret-put", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/main/junto/vault/secret-put")>();
  return {
    ...actual,
    putSignalSecret: () => Effect.succeed({ ok: true as const, item: "TOKEN", signal: SIGNAL as never, messageId: MESSAGE }),
  };
});

import { inProcessCore, type CoreRunner } from "./support/in-process-core";
import "../src/main/core-process/ops/ipc-signals";
import { messageDelivery } from "../src/main/junto/work/message-delivery";
import { WorkService } from "../src/main/junto/work/service";

const runtimes: Array<ManagedRuntime.ManagedRuntime<never, never>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const runtime of runtimes.splice(0)) await Effect.runPromise(Effect.promise(() => runtime.dispose()));
});

describe("an answered signal", () => {
  it("is typed into its seat by the core op that answers it", async () => {
    const runtime = ManagedRuntime.make(Layer.empty);
    runtimes.push(runtime);
    const runner: CoreRunner = { runPromiseExit: (effect) => runtime.runPromiseExit(effect as never) };
    const core = inProcessCore(runner);
    const deliver = vi.spyOn(messageDelivery, "deliver").mockResolvedValue("delivered");
    await core.call("ipc.signals.answer", { signalId: "s1", text: "go ahead", silent: false, attachments: [] });
    expect(deliver).toHaveBeenCalledWith("factory", "seat-a", MESSAGE);
  });

  it("types a reply handed back by the seat into it as well", async () => {
    const runtime = ManagedRuntime.make(Layer.succeed(WorkService, {} as never));
    runtimes.push(runtime as unknown as ManagedRuntime.ManagedRuntime<never, never>);
    const runner: CoreRunner = { runPromiseExit: (effect) => runtime.runPromiseExit(effect as never) };
    const core = inProcessCore(runner);
    const deliver = vi.spyOn(messageDelivery, "deliver").mockResolvedValue("delivered");
    await core.call("ipc.signals.reply", { signalId: "s1", reply: {} } as never);
    expect(deliver).toHaveBeenCalledWith("factory", "seat-a", MESSAGE);
  });

  it("types a secret answer's mail into its seat too", async () => {
    const runtime = ManagedRuntime.make(Layer.empty);
    runtimes.push(runtime);
    const runner: CoreRunner = { runPromiseExit: (effect) => runtime.runPromiseExit(effect as never) };
    const core = inProcessCore(runner);
    const deliver = vi.spyOn(messageDelivery, "deliver").mockResolvedValue("delivered");
    await core.call("ipc.signals.secretPut", { request: { canvasName: "factory", nodeId: "seat-a", item: "TOKEN", value: "x", signalId: "s1" } } as never);
    expect(deliver).toHaveBeenCalledWith("factory", "seat-a", MESSAGE);
  });
});
