/**
 * Main's end of each window's link (src/contract/window/link.ts). A trusted
 * window asks for its link on `windowLinkOpen`; main makes a channel, serves
 * every window group on one end, and sends the other end to that window,
 * whose preload moves it to the page. A window that loads again asks again:
 * its earlier link is closed first. A link closes with its port or its window.
 *
 * Each window gets its own server, so the ids its clients number from zero
 * never meet another window's, or the ids of its own earlier load.
 */
import { MessageChannelMain, type IpcMain, type MessagePortMain } from "electron";
import { Effect, Fiber, Layer, Queue, Stream } from "effect";
import { RpcClientError, RpcServer, type Rpc, type RpcClient, type RpcGroup } from "effect/rpc";
import type { CorePushChannel, CorePushOf } from "../../contract/core/channels";
import { subscribe as onCorePush } from "../core-process/main-side/core-pushes";
import { IPC_CHANNELS } from "@shared/ipc";
import { heldForServer, serverProtocol, type PortMessage, type RpcPort } from "@shared/rpc-port";
import { WindowLink } from "../../contract/window/link";
import { WindowRpcs } from "../../contract/window/rpcs";

/** Every handler of every window group, each requirement already provided. */
export type WindowHandlers = Layer.Layer<Rpc.ToHandler<RpcGroup.Rpcs<typeof WindowRpcs>>>;

/** Main's server of every window group on one link. */
export const windowServer = (link: RpcPort, handlers: WindowHandlers) =>
  RpcServer.layer(WindowRpcs).pipe(
    Layer.provide(handlers),
    Layer.provide(Layer.effect(RpcServer.Protocol, Effect.flatMap(WindowLink, serverProtocol))),
    Layer.provide(Layer.succeed(WindowLink, link)),
  );

const linkOf = (port: MessagePortMain): RpcPort => ({
  post: (message) => port.postMessage(message),
  listen: (handler) => {
    const on = (event: Electron.MessageEvent) => handler(event.data as PortMessage);
    port.on("message", on);
    return () => {
      port.off("message", on);
    };
  },
});

/**
 * `ipc` is the trusted facade (trusted-main-webcontents.ts): an untrusted
 * sender is refused before it gets a port. Registered once, for the life of
 * main: the facade wraps each listener, so it cannot be removed again.
 */
export const registerWindowLink = (ipc: IpcMain, handlers: WindowHandlers): void => {
  const open = new Map<number, () => void>();
  ipc.on(IPC_CHANNELS.windowLinkOpen, (event: Electron.IpcMainEvent): void => {
    const sender = event.sender;
    open.get(sender.id)?.();
    const { port1, port2 } = new MessageChannelMain();
    // Held before the port starts, so no request is lost to the server's start.
    const fiber = Effect.runFork(Layer.launch(windowServer(heldForServer(linkOf(port1)), handlers)));
    port1.start();
    const close = (): void => {
      if (open.get(sender.id) === close) open.delete(sender.id);
      sender.off("destroyed", close);
      port1.off("close", close);
      Effect.runFork(Fiber.interrupt(fiber));
      port1.close();
    };
    port1.on("close", close);
    sender.on("destroyed", close);
    open.set(sender.id, close);
    sender.postMessage(IPC_CHANNELS.windowLink, null, [port2]);
  });
};

/**
 * A core call as a window handler answers it: a core that left before it
 * answered is a defect of this call, not one of the group's own errors, which
 * the window matches by tag.
 */
export const fromCore = <A, E, R>(call: Effect.Effect<A, E | RpcClientError.RpcClientError, R>): Effect.Effect<A, Exclude<E, RpcClientError.RpcClientError>, R> =>
  call.pipe(
    Effect.catchIf((error): error is RpcClientError.RpcClientError => error instanceof RpcClientError.RpcClientError, (error) => Effect.die(error)),
  ) as Effect.Effect<A, Exclude<E, RpcClientError.RpcClientError>, R>;

/**
 * Main's handlers for a core group the window calls as it is: each rpc goes
 * to main's client of that group, unchanged. The window's client and the
 * core's handlers share the group's rpc values, so a change to one fails the
 * other's compile, and main writes no code per call.
 */
export const forwardTo = <Rpcs extends Rpc.Any>(
  group: RpcGroup.RpcGroup<Rpcs>,
  client: RpcClient.RpcClient<Rpcs, RpcClientError.RpcClientError>,
): Forwarded<Rpcs> => {
  const calls = client as unknown as Record<string, (payload: unknown) => Effect.Effect<unknown, unknown>>;
  return Object.fromEntries(
    [...group.requests.keys()].map((tag) => [tag, (payload: unknown) => fromCore(calls[tag]!(payload))]),
  ) as unknown as Forwarded<Rpcs>;
};

/** A forward's handlers, each asking nothing of the server it runs in. */
type Forwarded<Rpcs extends Rpc.Any> = { readonly [Current in Rpcs as Current["_tag"]]: Rpc.ToHandlerFn<Current, never> };

/**
 * A follow stream: `read` now, then again after each push on `channel` that
 * `when` keeps. It subscribes before the first read, so no change is missed,
 * and a burst of pushes coalesces into one read, since each read is whole.
 */
export const following = <K extends CorePushChannel, A, E, R>(
  channel: K,
  read: Effect.Effect<A, E, R>,
  when: (push: CorePushOf<K>) => boolean = () => true,
): Stream.Stream<A, E, R> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const changed = yield* Queue.sliding<true>(1);
      const off = onCorePush(channel, (push) => {
        if (when(push)) Queue.offerUnsafe(changed, true);
      });
      yield* Effect.addFinalizer(() => Effect.sync(off));
      return Stream.make(true).pipe(Stream.concat(Stream.fromQueue(changed)), Stream.mapEffect(() => read));
    }),
  );
