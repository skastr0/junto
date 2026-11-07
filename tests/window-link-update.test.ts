/**
 * The update group over a window's link (src/contract/window/link.ts): the
 * page's link and the window's runtime on one end of a MessageChannel, main's
 * server and its real update handlers on the other, the update service
 * faked. The template every window group follows: the stream opens with the
 * current status and follows each change, a refusal is an answer, a payload
 * the contract does not name is refused at main's edge, and a page with no
 * bridge fails at once.
 */
import { Context, Effect, Exit, Fiber, Layer, Option, Schema, Stream } from "effect";
import { Rpc, RpcClient, RpcGroup } from "effect/rpc";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../src/shared/ipc";
import { clientProtocol, heldForServer, type PortMessage, type RpcPort } from "../src/shared/rpc-port";
import { idleUpdateStatus, UpdateStatus } from "../src/shared/update";

vi.mock("electron", () => ({ MessageChannelMain: class {} }));
vi.mock("../src/app/runtime", () => ({ AppRuntime: {} }));

const { windowServer } = await import("../src/app/window/ipc");
const { updateWindowHandlers } = await import("../src/app/update/ipc");
const { UpdateService } = await import("../src/app/update/service");
const { UpdateError } = await import("../src/app/update/errors");
const { pageLink } = await import("../src/window/rpc/link");
const { makeWindowRuntime } = await import("../src/window/rpc/runtime");
const { UpdateWindow, UpdateWindowRpcs } = await import("../src/contract/window/update");
const { UpdateState } = await import("../src/window/lib/update-state");

const { ReferencesWindowRpcs } = await import("../src/contract/window/references");

/** The window's whole group: references answer nothing here, they are not under test. */
const withoutReferences = <E, R>(update: Layer.Layer<Rpc.ToHandler<RpcGroup.Rpcs<typeof UpdateWindowRpcs>>, E, R>) =>
  Layer.merge(
    update,
    ReferencesWindowRpcs.toLayer({
      ReferencesBriefingWrite: () => Effect.die("not under test"),
      ReferencesWrite: () => Effect.die("not under test"),
      ReferencesDelete: () => Effect.die("not under test"),
      ReferencesBriefingFollow: () => Stream.die("not under test"),
      ReferencesListFollow: () => Stream.die("not under test"),
      ReferencesReadFollow: () => Stream.die("not under test"),
    }),
  );

/** The window a link serves; nothing here keys on it. */
const A_WINDOW = { id: 1, webContents: {} as never };

const idle = idleUpdateStatus("1.0.0");
const checking: UpdateStatus = { ...idle, phase: "checking" };

/** The update service main's handlers read, with a change the test makes. */
const fakeUpdates = (check: Effect.Effect<UpdateStatus, InstanceType<typeof UpdateError>>) => {
  let current: UpdateStatus = idle;
  const listeners = new Set<(status: UpdateStatus) => void>();
  const checks = { count: 0 };
  return {
    checks,
    change: (status: UpdateStatus) => {
      current = status;
      for (const listener of listeners) listener(status);
    },
    layer: Layer.succeed(UpdateService, {
      getState: Effect.sync(() => current),
      check: Effect.suspend(() => {
        checks.count += 1;
        return check;
      }),
      prepareInstall: Effect.die("not under test"),
      restartAndInstall: () => Effect.die("not under test"),
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    }),
  };
};

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

/** A page whose preload hands it `port` when it asks for its link, as the real preload does. */
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

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** Main's server on one end and the window's runtime on the other. */
const linked = (updates: ReturnType<typeof fakeUpdates>) => {
  const { port1, port2 } = new MessageChannel();
  const server = Effect.runFork(
    Layer.launch(windowServer(heldForServer(mainLinkOf(port1)), withoutReferences(updateWindowHandlers("1.0.0", { host: {} as never, provider: {} as never }).pipe(Layer.provide(updates.layer))), A_WINDOW)),
  );
  const { page, bridge } = pageWith(port2);
  const runtime = makeWindowRuntime(pageLink(bridge, page));
  cleanups.push(async () => {
    await runtime.dispose();
    await Effect.runPromise(Fiber.interrupt(server));
    port1.close();
    port2.close();
  });
  return { runtime, port1 };
};

const until = async (ok: () => boolean): Promise<void> => {
  for (let tries = 0; tries < 100 && !ok(); tries += 1) await new Promise((resolve) => setTimeout(resolve, 5));
};

describe("every window rpc decodes closed", () => {
  it("carries onExcessProperty error on the rpc itself, where the server and client read it", async () => {
    const { WindowRpcs } = await import("../src/contract/window/rpcs");
    const open = [...WindowRpcs.requests.values()]
      .filter((rpc) => Context.getOption(rpc.annotations, Rpc.ParseOptions).pipe(Option.map((options) => options.onExcessProperty), Option.getOrUndefined) !== "error")
      .map((rpc) => rpc._tag);
    expect(open).toEqual([]);
  });
});

describe("the update group over a window's link", () => {
  it("opens with the current status, then follows each change", async () => {
    const updates = fakeUpdates(Effect.succeed(idle));
    const { runtime } = linked(updates);
    // Read on a first render: building the runtime waits on nothing.
    const { view$ } = runtime.runSync(UpdateState);
    expect(view$.status.currentVersion.peek()).toBe("0.0.0");

    await until(() => view$.status.currentVersion.peek() === "1.0.0");
    expect(view$.status.peek()).toEqual(idle);
    updates.change(checking);
    await until(() => view$.status.phase.peek() === "checking");
    expect(view$.busy.peek()).toBe(true);
  });

  it("answers a refused check as an error status, not a failure", async () => {
    const updates = fakeUpdates(Effect.fail(new UpdateError({ code: "not-packaged", message: "this build cannot update" })));
    const { runtime } = linked(updates);
    const update = runtime.runSync(UpdateState);
    const status = await runtime.runPromise(update.check);
    expect(status.phase).toBe("error");
    expect(update.view$.status.peek()).toEqual(status);
    expect(update.view$.busy.peek()).toBe(false);
    expect(status.error).toEqual({ code: "not-packaged", message: "this build cannot update" });
    expect(updates.checks.count).toBe(1);
  });

  it("refuses at main's edge a payload the contract does not name", async () => {
    const updates = fakeUpdates(Effect.succeed(idle));
    // A client of a drifted contract: the same tag, with an argument main never named.
    const Drifted = RpcGroup.make(Rpc.make("UpdateCheck", { payload: { force: Schema.Boolean }, success: UpdateStatus }));
    const { port1, port2 } = new MessageChannel();
    const server = Effect.runFork(
      Layer.launch(windowServer(heldForServer(mainLinkOf(port1)), withoutReferences(updateWindowHandlers("1.0.0", { host: {} as never, provider: {} as never }).pipe(Layer.provide(updates.layer))), A_WINDOW)),
    );
    cleanups.push(async () => {
      await Effect.runPromise(Fiber.interrupt(server));
      port1.close();
      port2.close();
    });
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        RpcClient.make(Drifted).pipe(
          Effect.provideServiceEffect(RpcClient.Protocol, clientProtocol(mainLinkOf(port2))),
          Effect.flatMap((client) => client.UpdateCheck({ force: true })),
        ),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(updates.checks.count).toBe(0);
  });

  it("fails at once on a page with no bridge, with the client's error", async () => {
    const runtime = makeWindowRuntime(pageLink(undefined, {} as Window));
    cleanups.push(() => runtime.dispose());
    const exit = await runtime.runPromiseExit(Effect.flatMap(UpdateWindow, (update) => update.UpdateCheck()));
    expect(Option.map(Exit.findErrorOption(exit), (error) => error._tag)).toEqual(Option.some("RpcClientError"));
  });
});
