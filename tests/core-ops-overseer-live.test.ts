/**
 * The live overseer group (src/contract/core/overseer-live.ts) over a
 * MessageChannel: the window's live controls, through main's side
 * (core-process/main-side/overseer-live.ts), reach the core's live overseer;
 * the core listens to its snapshots once, from its server's start, and each
 * one leaves on the push.
 */
import { MessageChannel, type MessagePort } from "node:worker_threads";
import { Effect, Exit, Layer, ManagedRuntime, Scope } from "effect";
import { RpcServer } from "effect/rpc";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LiveSnapshot } from "../src/shared/overseer-live";
import { serverProtocol, type PortMessage, type RpcPort } from "../src/shared/rpc-port";
import { LIVE_CHANGED } from "../src/contract/core/channels";
import { CoreLink } from "../src/contract/core/link";
import { OverseerLiveCore, OverseerLiveRpcs } from "../src/contract/core/overseer-live";
import { OverseerLiveHandlers, RunningLiveOverseer, type LiveService } from "../src/core/ops/overseer-live";
import { CorePushes } from "../src/core/push";

vi.mock("../src/app/runtime", () => ({ AppRuntime: ManagedRuntime.make(Layer.empty) }));

const { coreOverseerLive } = await import("../src/app/core-process/main-side/overseer-live");
const { deliverPush } = await import("../src/app/core-process/main-side/core-pushes");

const linkOf = (port: MessagePort): RpcPort => ({
  post: (message) => port.postMessage(message),
  listen: (handler) => {
    const on = (message: PortMessage) => handler(message);
    port.on("message", on);
    return () => port.off("message", on);
  },
});

const snapshotOf = (sessionId: string | null): LiveSnapshot => ({
  sessionId,
  canvasName: sessionId === null ? null : "factory",
  nodeId: sessionId === null ? null : "seat-1",
  connectionEpoch: 1,
  connection: sessionId === null ? "closed" : "ready",
  authority: "active",
  controller: "idle",
  elapsedSeconds: 0,
  voiceCostUsd: 0,
  limitSeconds: 600,
  transcript: [],
  requests: [],
  actions: [],
});

let scope: Scope.Closeable;
let ports: Array<MessagePort>;
let pushes: Array<readonly [string, unknown]>;

beforeEach(async () => {
  scope = await Effect.runPromise(Scope.make());
  ports = [];
  pushes = [];
});

afterEach(async () => {
  await Effect.runPromise(Scope.close(scope, Exit.void));
  for (const port of ports) port.close();
});

/** A core whose live overseer is `service`, served on one end of a channel; main's live controls on the other. */
const liveOn = async (service: LiveService | undefined): Promise<LiveService> => {
  const { port1, port2 } = new MessageChannel();
  ports.push(port1, port2);
  await Effect.runPromise(
    Layer.buildWithScope(
      RpcServer.layer(OverseerLiveRpcs).pipe(
        Layer.provide(OverseerLiveHandlers),
        Layer.provide([
          RunningLiveOverseer.layerOf(service),
          Layer.succeed(CorePushes, { publish: (channel, payload) => Effect.sync(() => void pushes.push([channel, payload])) }),
          Layer.effect(RpcServer.Protocol, serverProtocol(linkOf(port2))),
        ]),
      ),
      scope,
    ),
  );
  const clients = await Effect.runPromise(
    Layer.buildWithScope(OverseerLiveCore.layer.pipe(Layer.provide(Layer.succeed(CoreLink, linkOf(port1)))), scope),
  );
  return coreOverseerLive(clients);
};

it("refuses the window's live controls where the core runs no live overseer", async () => {
  const live = await liveOn(undefined);
  await expect(live.liveSnapshot()).rejects.toThrow("the live overseer is not running in this core");
});

it("answers the window's live controls from the core's live overseer, and pushes each snapshot once", async () => {
  const asked: unknown[] = [];
  const listeners: Array<(snapshot: LiveSnapshot) => void> = [];
  const snapshot = snapshotOf("s1");
  const live = await liveOn({
    liveStart: async (input) => {
      asked.push(["start", input.nodeId]);
      return { sessionId: "s1", connectionEpoch: 1, answerSdp: "sdp", snapshot };
    },
    liveEnd: async () => snapshot,
    liveSnapshot: async () => snapshot,
    liveReady: async (sessionId, epoch) => void asked.push(["ready", sessionId, epoch]),
    liveProviderEvent: async () => undefined,
    liveAttention: async () => undefined,
    liveCancel: async () => snapshot,
    liveSteer: async (sessionId, requestId, text) => (asked.push(["steer", sessionId, requestId, text]), snapshot),
    liveStopActions: async () => snapshot,
    subscribe: (listener) => (listeners.push(listener), () => undefined),
  });
  expect(await live.liveSnapshot()).toEqual(snapshot);
  await live.liveReady("s1", 2);
  await live.liveSteer("s1", "r1", "go left", { canvasName: "factory", selectedNodeIds: [] });
  expect(asked).toEqual([["ready", "s1", 2], ["steer", "s1", "r1", "go left"]]);

  // The core listened once, at its start, however many windows listen in main.
  const seen: unknown[] = [];
  const stop = live.subscribe((next) => seen.push(next));
  live.subscribe(() => undefined);
  expect(listeners).toHaveLength(1);
  const next = snapshotOf(null);
  for (const listener of listeners) listener(next);
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(pushes).toEqual([[LIVE_CHANGED, next]]);

  // Main's bus hands each push to the listeners still there.
  deliverPush(LIVE_CHANGED, next);
  stop();
  deliverPush(LIVE_CHANGED, snapshot);
  expect(seen).toEqual([next]);
});
