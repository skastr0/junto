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
 *
 * A server whose clients live in a peer that restarts or reloads (a core, a
 * window) serves them through `peersLink`: each peer numbers its clients from
 * its own start, so the link gives every (peer, client) pair an id of its own
 * and says `{ kind: "clientGone" }`, also local, for each client of a peer
 * that left. The server then interrupts what those clients still wait on, and
 * a late reply never reaches a peer that did not ask.
 */
import { Effect, Queue, Schema } from "effect";
import { RpcClient, RpcClientError, type RpcMessage, RpcServer } from "effect/rpc";

type FromClientEncoded = RpcMessage.FromClientEncoded;
type FromServerEncoded = RpcMessage.FromServerEncoded;

/** What RPC puts on a port, and the one local message a port gives its own side. */
export type RpcPortMessage =
  | { readonly kind: "rpc"; readonly client: number; readonly data: unknown }
  | { readonly kind: "rpcReply"; readonly client: number; readonly data: unknown }
  | { readonly kind: "down"; readonly reason: string }
  | { readonly kind: "clientGone"; readonly client: number };

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
    if (message.kind !== "rpc" && message.kind !== "clientGone") return;
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
      const disconnects = yield* Queue.unbounded<number>();
      const unlisten = port.listen((message) => {
        if (typeof message.client !== "number") return;
        if (message.kind === "clientGone") {
          if (clients.delete(message.client)) Queue.offerUnsafe(disconnects, message.client);
          return;
        }
        if (message.kind !== "rpc") return;
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
        disconnects,
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
 * leaves the rest to theirs. A `down` fails every request its clients still
 * wait on, including a client that has sent but whose receiving has not
 * started yet: Effect adds a client to `clients` only then, so a `down` heard
 * right after a request is never lost to that order.
 */
export const clientProtocol = (port: RpcPort) =>
  RpcClient.Protocol.make(
    Effect.fnUntraced(function* (writeResponse, clients) {
      const arrived = yield* Queue.unbounded<readonly [number, FromServerEncoded]>();
      const sent = new Set<number>();
      const unlisten = port.listen((message) => {
        if (message.kind === "rpcReply" && typeof message.client === "number" && (clients.has(message.client) || sent.has(message.client))) {
          Queue.offerUnsafe(arrived, [message.client, message.data as FromServerEncoded]);
        } else if (message.kind === "down") {
          const reason = String(message.reason);
          for (const client of new Set([...clients, ...sent])) {
            Queue.offerUnsafe(arrived, [client, { _tag: "ClientProtocolError", error: refused(reason, reason) }]);
          }
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
            try: () => {
              sent.add(client);
              port.post({ kind: "rpc", client, data: request });
            },
            catch: (cause) => refused("rpc port: the port refused a request", cause),
          }),
        supportsAck: true,
        supportsTransferables: false,
        codecFor: Schema.toCodecJson,
      };
    }),
  );

/** One peer on a `peersLink`: what it posts toward the server, and its leaving. */
export type LinkedPeer = {
  /** A message this peer sent; only its RPC requests go on to the server. */
  readonly deliver: (message: PortMessage) => void;
  /** The peer is gone: each of its clients is gone to the server, and no reply reaches it again. */
  readonly leave: () => void;
};

/**
 * One server's port over many peers, each joined with how to post to it. A
 * peer's clients are renamed to ids unique on this link, so two peers that
 * both number from zero never share one, and a reply goes back renamed to the
 * peer that asked, or nowhere once that peer left.
 */
export const peersLink = (): { readonly link: RpcPort; readonly join: (post: (message: RpcPortMessage) => void) => LinkedPeer } => {
  const handlers = new Set<(message: PortMessage) => void>();
  const asked = new Map<number, { readonly post: (message: RpcPortMessage) => void; readonly client: number }>();
  let next = 1;
  const tell = (message: PortMessage): void => {
    for (const handler of handlers) handler(message);
  };
  return {
    link: {
      post: (message) => {
        if (message.kind !== "rpcReply") return;
        const peer = asked.get(message.client);
        if (peer !== undefined) peer.post({ kind: "rpcReply", client: peer.client, data: message.data });
      },
      listen: (handler) => {
        handlers.add(handler);
        return () => handlers.delete(handler);
      },
    },
    join: (post) => {
      const mine = new Map<number, number>();
      let left = false;
      return {
        deliver: (message) => {
          if (left || message.kind !== "rpc" || typeof message.client !== "number") return;
          let id = mine.get(message.client);
          if (id === undefined) {
            id = next++;
            mine.set(message.client, id);
            asked.set(id, { post, client: message.client });
          }
          tell({ kind: "rpc", client: id, data: message.data });
        },
        leave: () => {
          if (left) return;
          left = true;
          for (const id of mine.values()) {
            asked.delete(id);
            tell({ kind: "clientGone", client: id });
          }
          mine.clear();
        },
      };
    },
  };
};
