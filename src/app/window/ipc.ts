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
import { Effect, Fiber, Layer } from "effect";
import { RpcServer, type Rpc, type RpcGroup } from "effect/rpc";
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
