/**
 * The references group over a window's link, the template for a core-served
 * window group: the window's runtime on one end, main's server with its
 * forward and follow streams in the middle, and the core's real references
 * handlers over a store in a temp folder behind main's client. A write is the
 * core's answer unchanged, a follow opens with the current state and reads
 * again on the core's notice, and a payload the core's schema refuses is
 * refused at main's edge before the core is asked.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Exit, Fiber, Layer, ManagedRuntime, Schema, Scope, Stream } from "effect";
import { Rpc, RpcClient, RpcClientError, RpcGroup, RpcTest } from "effect/rpc";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../src/shared/ipc";
import { clientProtocol, heldForServer, type PortMessage, type RpcPort } from "../src/shared/rpc-port";
import { APP_REFERENCE_PLACE, type AppBriefing, type ReferenceSummary } from "../src/shared/references";

vi.mock("electron", () => ({ MessageChannelMain: class {} }));
vi.mock("../src/app/runtime", () => ({ AppRuntime: {} }));

const { forwardTo, windowServer } = await import("../src/app/window/ipc");
const { deliverPush } = await import("../src/app/core-process/main-side/core-pushes");
const { ReferencesWindowHandlers } = await import("../src/app/references/ipc");
const { ReferencesCore, ReferencesRpcs } = await import("../src/contract/core/references");
const { ReferencesForwarded, ReferencesWindowRpcs, ReferencesWindow } = await import("../src/contract/window/references");
const { UpdateWindowRpcs } = await import("../src/contract/window/update");
const { pageLink } = await import("../src/window/rpc/link");
const { follow, makeWindowRuntime } = await import("../src/window/rpc/runtime");
const { makeStateEngineLive } = await import("../src/core/state/engine");
const { ReferencesRepository, ReferencesRepositoryLive } = await import("../src/core/references/repository");
const { ReferencesHandlers } = await import("../src/core/ops/ipc-references");
const { CorePushes } = await import("../src/core/push");

/** One end of a DOM-style channel as main's link. */
const mainLinkOf = (port: MessagePort): RpcPort => ({
  post: (message) => port.postMessage(message),
  listen: (handler) => {
    const on = (event: MessageEvent) => handler(event.data as PortMessage);
    port.addEventListener("message", on);
    port.start();
    return () => port.removeEventListener("message", on);
  },
});

/** A page whose preload hands it `port` when it asks for its link. */
const pageWith = (port: MessagePort) => {
  const listeners = new Set<(event: MessageEvent) => void>();
  const page = {
    addEventListener: (_type: string, listener: (event: MessageEvent) => void) => listeners.add(listener),
    removeEventListener: (_type: string, listener: (event: MessageEvent) => void) => listeners.delete(listener),
  } as unknown as Window;
  const bridge = {
    openWindowLink: () => {
      const event = { source: page, data: { type: IPC_CHANNELS.windowLink }, ports: [port] } as unknown as MessageEvent;
      queueMicrotask(() => {
        for (const listener of [...listeners]) listener(event);
      });
    },
  };
  return { page, bridge };
};

let root: string;
let store: ManagedRuntime.ManagedRuntime<Layer.Success<typeof ReferencesRepositoryLive>, unknown>;
let scope: Scope.Closeable;
let asks: Array<string>;
const cleanups: Array<() => Promise<void>> = [];

/** Main's handlers for the window's whole group: update is not under test. */
const handlersOver = (core: RpcClient.FromGroup<typeof ReferencesRpcs, never>) =>
  UpdateWindowRpcs.toLayer({
    UpdateStates: () => Stream.die("not under test"),
    UpdateCheck: () => Effect.die("not under test"),
    UpdateRestartAndInstall: () => Effect.die("not under test"),
  }).pipe(Layer.merge(ReferencesWindowHandlers), Layer.provide(Layer.succeed(ReferencesCore, core as never)));

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "junto-window-references-"));
  store = ManagedRuntime.make(ReferencesRepositoryLive.pipe(Layer.provide(makeStateEngineLive(join(root, "junto.db")))));
  scope = await Effect.runPromise(Scope.make());
  asks = [];
  // The core's handlers publish each change; the one-process setup hands it to main's side, as the core link does.
  const handlers = await store.runPromise(Layer.buildWithScope(Layer.provide(ReferencesHandlers, CorePushes.live), scope));
  const core = await store.runPromise(
    RpcTest.makeClient(ReferencesRpcs).pipe(Effect.provide(handlers), Effect.provideService(Scope.Scope, scope)),
  );
  // Main's client of the core, counting what reaches it; while the core is down, each call fails as a lost link does.
  coreDown = false;
  const counted = new Proxy(core, {
    // Each call is an effect that asks when it runs, as a real client's is.
    get: (target, tag: string) => (payload: unknown) =>
      Effect.suspend(() => {
        asks.push(tag);
        if (coreDown) return Effect.fail(new RpcClientError.RpcClientError({ reason: new RpcClientError.RpcClientDefect({ message: "the core left", cause: null }) }));
        return (target as unknown as Record<string, (payload: unknown) => Effect.Effect<unknown, unknown>>)[tag]!(payload);
      }),
  });
  serve = (port) => {
    const server = Effect.runFork(
      Layer.launch(windowServer(heldForServer(mainLinkOf(port)), handlersOver(counted as never), { id: 1, webContents: {} as never })),
    );
    cleanups.push(async () => {
      await Effect.runPromise(Fiber.interrupt(server));
      port.close();
    });
  };
  const { port1, port2 } = new MessageChannel();
  serve(port1);
  const { page, bridge } = pageWith(port2);
  const runtime = makeWindowRuntime(pageLink(bridge, page));
  window_ = { runtime };
  cleanups.push(async () => {
    await runtime.dispose();
    port2.close();
  });
});

/** Whether main's client of the core answers as a lost link. */
let coreDown = false;

/** Main's server for the window's group on one more port. */
let serve: (port: MessagePort) => void;

let window_: { runtime: ReturnType<typeof makeWindowRuntime> };

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  await Effect.runPromise(Scope.close(scope, Exit.void));
  await store.dispose();
  await rm(root, { recursive: true, force: true });
});

const until = async (ok: () => boolean): Promise<void> => {
  for (let tries = 0; tries < 200 && !ok(); tries += 1) await new Promise((resolve) => setTimeout(resolve, 5));
};

const call = <A, E>(use: (references: RpcClient.FromGroup<typeof ReferencesWindowRpcs, unknown>) => Effect.Effect<A, E>) =>
  window_.runtime.runPromise(Effect.flatMap(ReferencesWindow, (references) => use(references as never)));

describe("the references group over a window's link", () => {
  it("follows the briefing: the current text, then each change, whoever wrote it", async () => {
    const seen: Array<AppBriefing | null> = [];
    const references = window_.runtime.runSync(ReferencesWindow);
    const stop = follow(window_.runtime, references.ReferencesBriefingFollow(), (item) => seen.push(item));
    cleanups.push(async () => stop());
    await until(() => seen.length === 1);
    expect(seen).toEqual([null]);

    const written = await call((references) => references.ReferencesBriefingWrite({ body: "How we work." }));
    expect(written).toMatchObject({ ok: true, briefing: { body: "How we work." } });
    await until(() => seen.length === 2);
    expect(seen[1]).toMatchObject({ body: "How we work." });

    // An overseer's write reaches the page the same way: through the core's notice.
    await store.runPromise(Effect.flatMap(ReferencesRepository, (repository) => repository.briefingWrite("Theirs.", "overseer:a")));
    await until(() => seen.length === 3);
    expect(seen[2]).toMatchObject({ body: "Theirs." });
  });

  it("follows one place's list and reads again only for a change there", async () => {
    const lists: Array<ReadonlyArray<ReferenceSummary>> = [];
    const references = window_.runtime.runSync(ReferencesWindow);
    const stop = follow(window_.runtime, references.ReferencesListFollow({ place: APP_REFERENCE_PLACE }), (item) => lists.push(item));
    cleanups.push(async () => stop());
    await until(() => lists.length === 1);
    expect(lists).toEqual([[]]);

    await call((references) => references.ReferencesWrite({ place: APP_REFERENCE_PLACE, name: "style", body: "Plain." }));
    await until(() => lists.length === 2);
    expect(lists[1]!.map((summary) => summary.name)).toEqual(["style"]);

    const region = { kind: "region" as const, canvasName: "factory", regionId: "region-cli" };
    const listsBefore = asks.filter((tag) => tag === "ReferencesList").length;
    await call((references) => references.ReferencesWrite({ place: region, name: "style", body: "CLI." }));
    await call((references) => references.ReferencesBriefingWrite({ body: "Elsewhere." }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(lists).toHaveLength(2);
    expect(asks.filter((tag) => tag === "ReferencesList").length).toBe(listsBefore);
  });

  it("outlives a core restart: a change made while the core was down shows once it is back, and the follow never ends", async () => {
    const lists: Array<ReadonlyArray<ReferenceSummary>> = [];
    let ended = false;
    const references = window_.runtime.runSync(ReferencesWindow);
    const stop = follow(
      window_.runtime,
      references.ReferencesListFollow({ place: APP_REFERENCE_PLACE }),
      (item) => lists.push(item),
      () => (ended = true),
    );
    cleanups.push(async () => stop());
    await until(() => lists.length === 1);

    coreDown = true;
    // Written while main cannot reach the core: the notice reads, the read fails as a lost link, nothing is sent.
    await store.runPromise(Effect.flatMap(ReferencesRepository, (repository) => repository.write(APP_REFERENCE_PLACE, { name: "style", body: "Plain." }, "operator")));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(lists).toHaveLength(1);
    expect(ended).toBe(false);

    coreDown = false;
    deliverPush(IPC_CHANNELS.coreRestarted, {});
    await until(() => lists.length === 2);
    expect(lists[1]!.map((summary) => summary.name)).toEqual(["style"]);
    expect(ended).toBe(false);
  });

  it("forwards only calls that answer once: a group with a stream rpc does not compile", () => {
    // @ts-expect-error a stream rpc answers with a Stream, which a forward cannot wrap
    forwardTo(ReferencesWindowRpcs, {} as never);
    expect(Object.keys(forwardTo(ReferencesForwarded, {} as never)).sort()).toEqual(["ReferencesBriefingWrite", "ReferencesDelete", "ReferencesWrite"]);
  });

  it("answers a refused write in words, the core's answer unchanged", async () => {
    const answer = await call((references) => references.ReferencesWrite({ place: APP_REFERENCE_PLACE, name: "two words", body: "b" }));
    expect(answer).toMatchObject({ ok: false, message: expect.stringContaining("not a usable name") });
  });

  it("refuses at main's edge a region with no canvas, before the core is asked", async () => {
    // A client of a drifted contract: the same tag, with a place main's schema refuses.
    const Drifted = RpcGroup.make(
      Rpc.make("ReferencesWrite", {
        payload: { place: Schema.Struct({ kind: Schema.Literal("region"), canvasName: Schema.String, regionId: Schema.String }), name: Schema.String, body: Schema.String },
        success: Schema.Unknown,
      }),
    );
    const { port1, port2 } = new MessageChannel();
    serve(port1);
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        RpcClient.make(Drifted).pipe(
          Effect.provideServiceEffect(RpcClient.Protocol, clientProtocol(mainLinkOf(port2))),
          Effect.flatMap((client) => client.ReferencesWrite({ place: { kind: "region", canvasName: "", regionId: "r" }, name: "style", body: "b" })),
        ),
      ),
    );
    port2.close();
    expect(Exit.isFailure(exit)).toBe(true);
    expect(asks).not.toContain("ReferencesWrite");
  });

  it("does not take the core's reads as window calls: the window follows them", () => {
    expect([...ReferencesWindowRpcs.requests.keys()].sort()).toEqual([
      "ReferencesBriefingFollow",
      "ReferencesBriefingWrite",
      "ReferencesDelete",
      "ReferencesListFollow",
      "ReferencesReadFollow",
      "ReferencesWrite",
    ]);
  });
});
