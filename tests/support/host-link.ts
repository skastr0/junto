/**
 * Main's host server and the core's host clients on the two ends of a
 * `MessageChannel`, as the core process and main meet over its port: main's
 * end joins a `peersLink`, as each forked core does (core-process/host.ts).
 */
import { MessageChannel, type MessagePort } from "node:worker_threads";
import { Context, Effect, Layer, type Scope } from "effect";
import { ClipboardHost } from "../../src/contract/host/clipboard";
import { HostLink } from "../../src/contract/host/link";
import { HostServerLive } from "../../src/app/core-process/host-server";
import { SystemClipboard, type SystemClipboardShape } from "../../src/app/core-process/main-side/clipboard";
import { HostClientsLive } from "../../src/core/host-clients";
import { heldForServer, peersLink, type LinkedPeer, type PortMessage, type RpcPort } from "../../src/shared/rpc-port";

/** One end of a channel as a port RPC rides. */
export const portLink = (port: MessagePort): RpcPort => ({
  post: (message) => port.postMessage(message),
  listen: (handler) => {
    const on = (message: PortMessage) => handler(message);
    port.on("message", on);
    return () => {
      port.off("message", on);
    };
  },
});

/** A main serving the host groups, and a way to join a core to it. */
export const servedHost = async (scope: Scope.Scope, clipboard: SystemClipboardShape) => {
  const peers = peersLink();
  await Effect.runPromise(
    Layer.buildWithScope(
      HostServerLive.pipe(Layer.provide([Layer.succeed(HostLink, heldForServer(peers.link)), Layer.succeed(SystemClipboard, clipboard)])),
      scope,
    ),
  );
  const ports: Array<MessagePort> = [];
  /** A core on its own channel to this main: its clipboard client, and its leaving. */
  const core = async (): Promise<{ readonly clipboard: Context.Service.Shape<typeof ClipboardHost>; readonly peer: LinkedPeer }> => {
    const { port1, port2 } = new MessageChannel();
    ports.push(port1, port2);
    const peer = peers.join((message) => port1.postMessage(message));
    port1.on("message", (message: PortMessage) => peer.deliver(message));
    const clients = await Effect.runPromise(
      Layer.buildWithScope(HostClientsLive.pipe(Layer.provide(Layer.succeed(HostLink, portLink(port2)))), scope),
    );
    return { clipboard: Context.get(clients, ClipboardHost), peer };
  };
  return { core, close: () => ports.forEach((port) => port.close()) };
};
