/**
 * The Observability panel's group: main's handlers over the core's real
 * observability handlers, whose pushes reach main's bus as the port delivers
 * them, and the window's client on main's handlers. The live stream is the
 * panel's watch: it opens the core's slot, sends the ring's counts first,
 * then each row and each clear, and closes the slot when it ends. A query the
 * group's schema does not read is refused, not answered unfiltered.
 */
import { Context, Effect, Exit, Fiber, Layer, Schema, Scope, Stream } from "effect";
import { Rpc, RpcClient, RpcGroup, RpcServer, RpcTest } from "effect/rpc";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OBSERVABILITY_LOG } from "../src/contract/core/channels";
import { ObservabilityCore, ObservabilityRpcs } from "../src/contract/core/observability";
import type { ObservabilityWindowHandlers as Handlers } from "../src/app/observability/ipc";
import type { ObservabilityLiveEvent, ObservabilityWindowRpcs as WindowGroup } from "../src/contract/window/observability";
import { ObservabilityHandlers } from "../src/core/ops/observability";
import { observabilityRing } from "../src/core/observability/ring";
import { CorePushes } from "../src/core/push";
import { clientProtocol, heldForServer, serverProtocol, type PortMessage, type RpcPort } from "../src/shared/rpc-port";

vi.mock("electron", () => ({ MessageChannelMain: class {}, app: { once: () => undefined } }));
vi.mock("../src/app/runtime", () => ({ AppRuntime: {} }));

const { deliverPush, subscribe } = await import("../src/app/core-process/main-side/core-pushes");
const { ObservabilityWindowHandlers } = await import("../src/app/observability/ipc");
const { ObservabilityWindowRpcs } = await import("../src/contract/window/observability");

let scope: Scope.Closeable;
let asks: Array<string>;
let page: RpcClient.FromGroup<typeof WindowGroup>;
let main: Context.Context<Layer.Success<typeof Handlers>>;

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
  scope = await Effect.runPromise(Scope.make());
  asks = [];
  // The core's handlers, each push handed to main's bus as the port does.
  const core = await Effect.runPromise(
    Layer.buildWithScope(
      ObservabilityHandlers.pipe(
        Layer.provide(Layer.succeed(CorePushes, { publish: (channel, payload) => Effect.sync(() => deliverPush(channel, payload)) })),
      ),
      scope,
    ),
  );
  const client = await Effect.runPromise(
    RpcTest.makeClient(ObservabilityRpcs).pipe(Effect.provideContext(core), Effect.provideService(Scope.Scope, scope)),
  );
  // Main's client of the core, counting what reaches it.
  const counted = new Proxy(client, {
    get: (target, tag: string) => (payload: unknown) =>
      Effect.suspend(() => {
        asks.push(tag);
        return (target as unknown as Record<string, (payload: unknown) => Effect.Effect<unknown, unknown>>)[tag]!(payload);
      }),
  });
  main = await Effect.runPromise(
    Layer.buildWithScope(ObservabilityWindowHandlers.pipe(Layer.provide(Layer.succeed(ObservabilityCore, counted as never))), scope),
  );
  page = await Effect.runPromise(
    RpcTest.makeClient(ObservabilityWindowRpcs).pipe(Effect.provideContext(main), Effect.provideService(Scope.Scope, scope)),
  );
});

afterEach(async () => {
  await Effect.runPromise(Scope.close(scope, Exit.void));
});

const until = async (ok: () => boolean): Promise<void> => {
  for (let tries = 0; tries < 200 && !ok(); tries += 1) await new Promise((resolve) => setTimeout(resolve, 5));
};

const append = (message: string) =>
  observabilityRing.append({ level: "info", source: "main", message });

describe("the observability group over a window's link", () => {
  it("watches while the stream runs: the counts first, then each row and each clear, and the slot closes with it", async () => {
    const seen: Array<ObservabilityLiveEvent> = [];
    const live = Effect.runFork(Stream.runForEach(page.ObservabilityLive(), (event) => Effect.sync(() => seen.push(event))));
    await until(() => seen.length === 1);
    expect(seen[0]?._tag).toBe("Opened");
    expect(asks).toEqual(["ObservabilityWatch"]);

    append("watched row");
    await until(() => seen.length === 2);
    expect(seen[1]).toMatchObject({ _tag: "Row", entry: { message: "watched row" } });

    await Effect.runPromise(page.ObservabilityClear());
    await until(() => seen.length === 3);
    expect(seen[2]?._tag).toBe("Cleared");

    await Effect.runPromise(Fiber.interrupt(live));
    await until(() => asks.includes("ObservabilityUnwatch"));
    expect(asks).toEqual(["ObservabilityWatch", "ObservabilityClear", "ObservabilityUnwatch"]);

    // The slot is closed: the core pushes no row, and main's bus hears none.
    const heard: Array<unknown> = [];
    const off = subscribe(OBSERVABILITY_LOG, (entry) => heard.push(entry));
    append("after the panel closed");
    await new Promise((resolve) => setTimeout(resolve, 20));
    off();
    expect(heard).toEqual([]);
  });

  it("forwards a query to the core as it is", async () => {
    append("findable");
    const found = await Effect.runPromise(page.ObservabilityQuery({ query: { q: "findable", limit: 5 } }));
    expect(found.entries.map((entry) => entry.message)).toContain("findable");
  });

  it("refuses at main's edge a query its schema does not read, before the core is asked", async () => {
    // Main's server of this group on a port, as a window's link serves it.
    const { port1, port2 } = new MessageChannel();
    const server = Effect.runFork(
      Layer.launch(
        RpcServer.layer(ObservabilityWindowRpcs).pipe(
          Layer.provide(Layer.succeedContext(main)),
          Layer.provide(Layer.effect(RpcServer.Protocol, serverProtocol(heldForServer(linkOf(port1))))),
        ),
      ),
    );
    // A client of a drifted contract: the same tag, with a key main's schema never named.
    const Drifted = RpcGroup.make(
      Rpc.make("ObservabilityQuery", {
        payload: { query: Schema.Struct({ limit: Schema.Number, nope: Schema.Boolean }) },
        success: Schema.Unknown,
      }),
    );
    try {
      const exit = await Effect.runPromiseExit(
        Effect.scoped(
          RpcClient.make(Drifted).pipe(
            Effect.provideServiceEffect(RpcClient.Protocol, clientProtocol(linkOf(port2))),
            Effect.flatMap((client) => client.ObservabilityQuery({ query: { limit: 5, nope: true } })),
          ),
        ),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(asks).not.toContain("ObservabilityQuery");
    } finally {
      await Effect.runPromise(Fiber.interrupt(server));
      port1.close();
      port2.close();
    }
  });

  it("is not where main's own rows go: the window group has no append", () => {
    expect([...ObservabilityWindowRpcs.requests.keys()].sort()).toEqual(["ObservabilityClear", "ObservabilityLive", "ObservabilityQuery"]);
  });
});
