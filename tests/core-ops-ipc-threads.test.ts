import { Effect, Layer, ManagedRuntime } from "effect";
import { expect, it, vi } from "vitest";
import { inProcessCore, type CoreRunner } from "./support/in-process-core";
import { MAIL_WAITING, SEAT_THREAD_READ_CHANGED } from "../src/main/core-process/channels";
import { subscribe } from "../src/main/core-process/push";
import { ModelService } from "../src/main/junto/model/service";
import { messageDelivery } from "../src/main/junto/work/message-delivery";

const readListeners = vi.hoisted(() => [] as Array<(change: unknown) => void>);
vi.mock("../src/main/junto/work/mail-reads", async (original) => ({
  ...(await original<typeof import("../src/main/junto/work/mail-reads")>()),
  onReadChanged: (listener: (change: unknown) => void) => (readListeners.push(listener), () => undefined),
}));

await import("../src/main/core-process/ops/ipc-threads");

// The window's threads ask the core by name; renderer input is decoded there, and
// read points and waiting mail come back as pushes, subscribed once.
it("answers thread asks in the core, refuses what does not decode, and pushes read points and waiting mail", async () => {
  const runtime = ManagedRuntime.make(Layer.succeed(ModelService, {
    canvas: () => Effect.fail(new Error("no such canvas")),
  } as never));
  const core = inProcessCore(runtime as unknown as CoreRunner);
  const waiting: Array<(fact: unknown) => void> = [];
  const spy = vi.spyOn(messageDelivery, "subscribeMailWaiting").mockImplementation((listener) => (waiting.push(listener as never), () => undefined));
  const seen: Array<[string, unknown]> = [];
  const offs = [SEAT_THREAD_READ_CHANGED, MAIL_WAITING].map((channel) => subscribe(channel, (payload) => seen.push([channel, payload])));
  try {
    expect(await core.call("ipc.threads.markRead", { input: { canvasName: "factory" } })).toBeUndefined();
    expect(await core.call("ipc.threads.write", { input: { text: "hi" } })).toEqual({ ok: false, reason: "invalid", message: "That mail could not be read." });
    await expect(core.call("ipc.threads.list", { input: { nope: true } })).rejects.toThrow();
    expect(await core.call("ipc.threads.collaborationAsk", {
      draft: { canvas: "factory", sourceNodeId: "a", targetNodeId: "b" } as never,
    })).toEqual({ ok: false, error: "canvas \"factory\" could not be read" });

    await core.call("ipc.threads.watch", {});
    await core.call("ipc.threads.watch", {});
    expect([readListeners.length, waiting.length]).toEqual([1, 1]);
    readListeners[0]!({ canvasName: "factory", threadId: "t1" });
    waiting[0]!({ canvasName: "factory", nodeId: "n1" });
    expect(seen).toEqual([
      [SEAT_THREAD_READ_CHANGED, { canvasName: "factory", threadId: "t1" }],
      [MAIL_WAITING, { canvasName: "factory", nodeId: "n1" }],
    ]);
  } finally {
    for (const off of offs) off();
    spy.mockRestore();
    await runtime.dispose();
  }
});
