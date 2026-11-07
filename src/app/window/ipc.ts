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
import { MessageChannelMain, type IpcMain, type MessagePortMain, type WebContents } from "electron";
import { Context, Effect, Exit, Fiber, Layer, Queue, Stream } from "effect";
import { RpcClientError, RpcServer, type Rpc, type RpcClient, type RpcGroup, type RpcSchema } from "effect/rpc";
import type { CorePushChannel, CorePushOf } from "../../contract/core/channels";
import { mainAuthoringGate, type MainAuthoringLabel } from "../../node/main-authoring-gate";
import { subscribe as onCorePush } from "../core-process/main-side/core-pushes";
import { IPC_CHANNELS } from "@shared/ipc";
import { heldForServer, serverProtocol, type PortMessage, type RpcPort } from "@shared/rpc-port";
import { WindowLink } from "../../contract/window/link";
import { WindowRpcs } from "../../contract/window/rpcs";

/**
 * The window on the other end of this link. The handlers are built once per
 * link, so a handler that keys on the window reads it here, and what it holds
 * for that window goes in its layer's finalizer, which runs when the link
 * closes: on a reload, a closed port or a destroyed window.
 */
export class WindowSender extends Context.Service<
  WindowSender,
  { readonly id: number; readonly webContents: WebContents }
>()("@junto/app/WindowSender") {}

/** Every handler of every window group: what they need is provided, but the window they serve. */
export type WindowHandlers = Layer.Layer<Rpc.ToHandler<RpcGroup.Rpcs<typeof WindowRpcs>>, never, WindowSender>;

/** Main's server of every window group on one link, its handlers built for that link's window. */
export const windowServer = (link: RpcPort, handlers: WindowHandlers, sender: WindowSender["Service"]) =>
  RpcServer.layer(WindowRpcs).pipe(
    Layer.provide(handlers.pipe(Layer.provide(Layer.succeed(WindowSender, sender)))),
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
    const fiber = Effect.runFork(
      Layer.launch(windowServer(heldForServer(linkOf(port1)), handlers, { id: sender.id, webContents: sender })),
    );
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
  group: RpcGroup.RpcGroup<Rpcs> & AnswersOnce<Rpcs>,
  client: RpcClient.RpcClient<Rpcs, RpcClientError.RpcClientError>,
): Forwarded<Rpcs> => {
  const calls = client as unknown as Record<string, (payload: unknown) => Effect.Effect<unknown, unknown>>;
  return Object.fromEntries(
    [...group.requests.keys()].map((tag) => [tag, (payload: unknown) => fromCore(calls[tag]!(payload))]),
  ) as unknown as Forwarded<Rpcs>;
};

/**
 * A stream rpc's client answers with a Stream, which `fromCore` cannot wrap,
 * so a group with one does not compile here: omit it and serve it in main
 * (`following`, `pushes`).
 */
type Streams<Rpcs extends Rpc.Any> = Rpcs extends Rpc.Any ? (Rpc.SuccessSchema<Rpcs> extends RpcSchema.Stream<infer _A, infer _E> ? Rpcs : never) : never;
type AnswersOnce<Rpcs extends Rpc.Any> = [Streams<Rpcs>] extends [never]
  ? unknown
  : { readonly "forwardTo answers once; omit these stream rpcs": Streams<Rpcs>["_tag"] };

/** A forward's handlers, each asking nothing of the server it runs in. */
type Forwarded<Rpcs extends Rpc.Any> = { readonly [Current in Rpcs as Current["_tag"]]: Rpc.ToHandlerFn<Current, never> };

const isCoreGone = (error: unknown): error is RpcClientError.RpcClientError => error instanceof RpcClientError.RpcClientError;

/**
 * A follow stream: `read` now, then again after each push on `channel` that
 * `when` keeps, and after every core restart. It subscribes before the first
 * read, so no change is missed, and a burst of pushes coalesces into one read,
 * since each read is whole. A read the core could not answer because it left
 * sends nothing: the restart notice reads again, so a follow outlives the
 * core, and the window only ever sees the group's own errors.
 */
export const following = <K extends CorePushChannel, A, E, R>(
  channel: K,
  read: Effect.Effect<A, E, R>,
  when: (push: CorePushOf<K>) => boolean = () => true,
): Stream.Stream<A, Exclude<E, RpcClientError.RpcClientError>, R> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const changed = yield* Queue.sliding<true>(1);
      const notice = (): void => {
        Queue.offerUnsafe(changed, true);
      };
      const offs = [
        onCorePush(channel, (push) => {
          if (when(push)) notice();
        }),
        onCorePush(IPC_CHANNELS.coreRestarted, notice),
      ];
      yield* Effect.addFinalizer(() => Effect.sync(() => offs.forEach((off) => off())));
      const once = Stream.fromEffect(read).pipe(Stream.catchIf(isCoreGone, () => Stream.empty));
      return Stream.make(true).pipe(Stream.concat(Stream.fromQueue(changed)), Stream.flatMap(() => once));
    }),
  ) as Stream.Stream<A, Exclude<E, RpcClientError.RpcClientError>, R>;

/**
 * Every push on `channel`, from now on, for a window that applies each one
 * (an event, not a state: a state is `following`). None is dropped.
 */
export const pushes = <K extends CorePushChannel>(channel: K): Stream.Stream<CorePushOf<K>> =>
  Stream.callback<CorePushOf<K>>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => onCorePush(channel, (push) => Queue.offerUnsafe(queue, push))),
      (off) => Effect.sync(off),
    ),
  );

/**
 * A window write under main's authoring gate, as the hub's own writes are
 * (src/app/ipc.ts runMainAuthoring): once the gate closes for quit, the
 * write is refused, and the refusal is a defect of the call.
 */
export const authored = <A, E, R>(label: MainAuthoringLabel, write: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.flatMap(Effect.context<R>(), (context) =>
    Effect.flatMap(
      Effect.promise(() => mainAuthoringGate.run(label, () => Effect.runPromiseExit(Effect.provide(write, context)))),
      (exit: Exit.Exit<A, E>) => exit,
    ),
  );
