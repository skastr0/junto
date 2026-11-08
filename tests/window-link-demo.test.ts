/**
 * The demo group over a window's link: main serves it, inert outside demo
 * mode. A launch without --junto-demo answers inactive and refuses an EDL;
 * an EDL the group's schema does not read is refused at main's edge.
 */
import { Effect, Exit, Fiber, Layer, Schema, Scope } from "effect";
import { Rpc, RpcClient, RpcGroup, RpcServer, RpcTest } from "effect/rpc";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clientProtocol, heldForServer, serverProtocol, type PortMessage, type RpcPort } from "../src/shared/rpc-port";
import type { DemoWindowRpcs as WindowGroup } from "../src/contract/window/demo";

const written = vi.fn(async () => ({ ok: true, path: "/edl.json" }));
vi.mock("../src/app/demo/service", () => ({ writeDemoEdl: written }));

const { DemoWindowHandlers } = await import("../src/app/demo/ipc");
const { DemoWindowRpcs } = await import("../src/contract/window/demo");

const EDL = { scenarioId: "trailer-60", bpm: 120, startedAtEpochMs: 1, entries: [{ beat: 0, plannedMs: 0, actualMs: 2, op: "camera-fit" }] };

let scope: Scope.Closeable;
let page: RpcClient.FromGroup<typeof WindowGroup>;

/** One end of a DOM-style channel as a link. */
const linkOf = (port: MessagePort): RpcPort => ({
  post: (message) => port.postMessage(message),
  listen: (handler) => {
    const on = (event: MessageEvent) => handler(event.data as PortMessage);
    port.addEventListener("message", on);
    port.start();
    return () => port.removeEventListener("message", on);
  },
});

beforeEach(async () => {
  written.mockClear();
  scope = await Effect.runPromise(Scope.make());
  const context = await Effect.runPromise(Layer.buildWithScope(DemoWindowHandlers, scope));
  page = await Effect.runPromise(
    RpcTest.makeClient(DemoWindowRpcs).pipe(Effect.provideContext(context), Effect.provideService(Scope.Scope, scope)),
  );
});

afterEach(async () => {
  await Effect.runPromise(Scope.close(scope, Exit.void));
});

describe("the demo group over a window's link", () => {
  it("answers inactive and refuses an EDL outside demo mode, writing nothing", async () => {
    expect(await Effect.runPromise(page.DemoState())).toEqual({ active: false, autoroll: false });
    expect(await Effect.runPromise(page.DemoWriteEdl({ edl: EDL }))).toEqual({ ok: false, error: "demo mode off" });
    expect(written).not.toHaveBeenCalled();
  });

  it("refuses at main's edge an EDL its schema does not read", async () => {
    const { port1, port2 } = new MessageChannel();
    const server = Effect.runFork(
      Layer.launch(
        RpcServer.layer(DemoWindowRpcs).pipe(
          Layer.provide(DemoWindowHandlers),
          Layer.provide(Layer.effect(RpcServer.Protocol, serverProtocol(heldForServer(linkOf(port1))))),
        ),
      ),
    );
    // A client of a drifted contract: the same tag, with a bpm main's schema never reads.
    const Drifted = RpcGroup.make(
      Rpc.make("DemoWriteEdl", {
        payload: { edl: Schema.Struct({ scenarioId: Schema.String, bpm: Schema.String }) },
        success: Schema.Unknown,
      }),
    );
    try {
      const exit = await Effect.runPromiseExit(
        Effect.scoped(
          RpcClient.make(Drifted).pipe(
            Effect.provideServiceEffect(RpcClient.Protocol, clientProtocol(linkOf(port2))),
            Effect.flatMap((client) => client.DemoWriteEdl({ edl: { scenarioId: "trailer-60", bpm: "fast" } })),
          ),
        ),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(written).not.toHaveBeenCalled();
    } finally {
      await Effect.runPromise(Fiber.interrupt(server));
      port1.close();
      port2.close();
    }
  });

  it("holds exactly the demo calls", () => {
    expect([...DemoWindowRpcs.requests.keys()].sort()).toEqual(["DemoState", "DemoWriteEdl"]);
  });
});
