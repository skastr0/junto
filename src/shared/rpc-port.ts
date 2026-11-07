/**
 * Effect RPC over a message port: the transport every program uses where its
 * peer is a process or a window reached by `postMessage` (Electron's
 * `UtilityProcess` and `parentPort`, a `MessagePort`, a `MessageChannel` in
 * tests).
 *
 * A port joins two programs, and each side answers on it with one server:
 * the merge of every group it serves, so a group without a handler fails
 * that program's compile. Each client of a group posts its requests as
 * `{ kind: "rpc", client, data }`, where `client` is the id Effect gave that
 * client, unique in its process; the server answers it with
 * `{ kind: "rpcReply", client, data }`. Values cross by structured clone after
 * the group's schemas encode them to JSON-safe values, as Effect's own worker
 * protocol does (`Schema.toCodecJson`).
 *
 * The port says its far end is gone with a local `{ kind: "down" }` message,
 * never posted across. Every request still waiting then fails with an
 * `RpcClientError`, so no caller waits on a process that left. A request
 * carries all it needs and a server keeps nothing between requests, so a
 * request posted while the far end restarts is answered by the next one.
 */
import { Effect, Queue, Schema } from "effect";
import { RpcClient, RpcClientError, type RpcMessage, RpcServer } from "effect/rpc";

type FromClientEncoded = RpcMessage.FromClientEncoded;
type FromServerEncoded = RpcMessage.FromServerEncoded;

/** What RPC puts on a port, and the one local message a port gives its own side. */
export type RpcPortMessage =
  | { readonly kind: "rpc"; readonly client: number; readonly data: unknown }
  | { readonly kind: "rpcReply"; readonly client: number; readonly data: unknown }
  | { readonly kind: "down"; readonly reason: string };

/** A message as a port hands it over: RPC's, or another protocol's on the same port, which RPC leaves alone. */
export type PortMessage = { readonly kind: string; readonly client?: unknown; readonly data?: unknown; readonly reason?: unknown };

/** The least a port offers RPC: it posts RPC's messages, and hands every message it receives to each listener. */
export type RpcPort = {
  readonly post: (message: RpcPortMessage) => void;
  readonly listen: (handler: (message: PortMessage) => void) => () => void;
};

const refused = (message: string, cause: unknown): RpcClientError.RpcClientError =>
  new RpcClientError.RpcClientError({ reason: new RpcClientError.RpcClientDefect({ message, cause }) });

/**
 * A port for a server that starts listening after the port opened: requests
 * that arrive first wait for it, so none is lost to the order of boot. Open
 * it as early as the port, and give it to the server alone.
 */
export const heldForServer = (port: RpcPort): RpcPort => {
  const held: PortMessage[] = [];
  const handlers = new Set<(message: PortMessage) => void>();
  port.listen((message) => {
    if (message.kind !== "rpc") return;
    if (handlers.size === 0) held.push(message);
    else for (const handler of handlers) handler(message);
  });
  return {
    post: port.post,
    listen: (handler) => {
      handlers.add(handler);
      for (const message of held.splice(0)) handler(message);
      return () => handlers.delete(handler);
    },
  };
};

/**
 * This side's server on a port. Requests reach the server in the order they
 * arrived, one at a time, so an interrupt never overtakes the request it names.
 */
export const serverProtocol = (port: RpcPort) =>
  RpcServer.Protocol.make(
    Effect.fnUntraced(function* (writeRequest) {
      const clients = new Set<number>();
      const arrived = yield* Queue.unbounded<readonly [number, FromClientEncoded]>();
      const unlisten = port.listen((message) => {
        if (message.kind !== "rpc" || typeof message.client !== "number") return;
        clients.add(message.client);
        Queue.offerUnsafe(arrived, [message.client, message.data as FromClientEncoded]);
      });
      yield* Effect.addFinalizer(() => Effect.sync(unlisten));
      yield* Queue.take(arrived).pipe(
        Effect.flatMap(([client, data]) => writeRequest(client, data)),
        Effect.forever,
        Effect.forkScoped,
      );
      return {
        disconnects: yield* Queue.unbounded<number>(),
        send: (client: number, response: FromServerEncoded) =>
          Effect.try({ try: () => port.post({ kind: "rpcReply", client, data: response }), catch: (cause) => cause }).pipe(
            Effect.catch((cause) => Effect.logWarning("rpc port: a reply could not be posted", cause)),
          ),
        end: () => Effect.void,
        clientIds: Effect.sync(() => new Set(clients)),
        initialMessage: Effect.succeedNone,
        supportsAck: true,
        supportsTransferables: false,
        supportsSpanPropagation: true,
        supportsNotifications: true,
        codecFor: Schema.toCodecJson,
      };
    }),
  );

/**
 * One client's side of a port: it takes the replies to its own clients and
 * leaves the rest to theirs. A `down` fails every request its clients still wait on.
 */
export const clientProtocol = (port: RpcPort) =>
  RpcClient.Protocol.make(
    Effect.fnUntraced(function* (writeResponse, clients) {
      const arrived = yield* Queue.unbounded<readonly [number, FromServerEncoded]>();
      const unlisten = port.listen((message) => {
        if (message.kind === "rpcReply" && typeof message.client === "number" && clients.has(message.client)) {
          Queue.offerUnsafe(arrived, [message.client, message.data as FromServerEncoded]);
        } else if (message.kind === "down") {
          const reason = String(message.reason);
          for (const client of clients) Queue.offerUnsafe(arrived, [client, { _tag: "ClientProtocolError", error: refused(reason, reason) }]);
        }
      });
      yield* Effect.addFinalizer(() => Effect.sync(unlisten));
      yield* Queue.take(arrived).pipe(
        Effect.flatMap(([client, data]) => writeResponse(client, data)),
        Effect.forever,
        Effect.forkScoped,
      );
      return {
        send: (client: number, request: FromClientEncoded) =>
          Effect.try({
            try: () => port.post({ kind: "rpc", client, data: request }),
            catch: (cause) => refused("rpc port: the port refused a request", cause),
          }),
        supportsAck: true,
        supportsTransferables: false,
        codecFor: Schema.toCodecJson,
      };
    }),
  );
