/**
 * One server over many peers (src/shared/rpc-port.ts `peersLink`): a peer
 * that restarts or reloads numbers its clients from zero again, so each
 * (peer, client) pair is renamed to an id of its own, a reply goes back only
 * to the peer that asked, and a peer that leaves takes its clients with it:
 * the server interrupts what they still wait on, and never answers them.
 */
import { MessageChannel, type MessagePort } from "node:worker_threads";
import { Deferred, Effect, Exit, Layer, Schema, Scope } from "effect";
import { Rpc, RpcClient, RpcGroup, RpcServer } from "effect/rpc";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clientProtocol, heldForServer, peersLink, serverProtocol, type PortMessage, type RpcPort, type RpcPortMessage } from "../src/shared/rpc-port";

/** One end of a channel as a port RPC rides. */
const portLink = (port: MessagePort): RpcPort => ({
  post: (message) => port.postMessage(message),
  listen: (handler) => {
    const on = (message: PortMessage) => handler(message);
    port.on("message", on);
    return () => {
      port.off("message", on);
    };
  },
});

describe("peersLink, at the message level", () => {
  it("renames two peers' same client, routes each reply to its asker, and drops a peer that left", () => {
    const peers = peersLink();
    const seen: Array<PortMessage> = [];
    peers.link.listen((message) => seen.push(message));
    const toA: Array<RpcPortMessage> = [];
    const toB: Array<RpcPortMessage> = [];
    const a = peers.join((message) => toA.push(message));
    const b = peers.join((message) => toB.push(message));

    a.deliver({ kind: "rpc", client: 0, data: "a asks" });
    b.deliver({ kind: "rpc", client: 0, data: "b asks" });
    const [fromA, fromB] = seen;
    expect(fromA?.client).not.toBe(fromB?.client);

    peers.link.post({ kind: "rpcReply", client: fromB?.client as number, data: "to b" });
    expect(toB).toEqual([{ kind: "rpcReply", client: 0, data: "to b" }]);
    expect(toA).toEqual([]);

    a.leave();
    expect(seen.at(-1)).toEqual({ kind: "clientGone", client: fromA?.client });
    peers.link.post({ kind: "rpcReply", client: fromA?.client as number, data: "late" });
    expect(toA).toEqual([]);
    a.deliver({ kind: "rpc", client: 0, data: "after leaving" });
    expect(seen.filter((message) => message.data === "after leaving")).toEqual([]);
  });
});

const Probe = RpcGroup.make(Rpc.make("ProbeWait", { payload: { id: Schema.String }, success: Schema.String }));

let scope: Scope.Closeable;
let ports: Array<MessagePort>;

beforeEach(async () => {
  scope = await Effect.runPromise(Scope.make());
  ports = [];
});

afterEach(async () => {
  await Effect.runPromise(Scope.close(scope, Exit.void));
  for (const port of ports) port.close();
});

describe("peersLink, under a server", () => {
  it("interrupts what a peer that left still waits on, and answers the peer that came next", async () => {
    const started = await Effect.runPromise(Deferred.make<void>());
    const release = await Effect.runPromise(Deferred.make<void>());
    const interrupted: Array<string> = [];
    const handlers = Probe.toLayer({
      ProbeWait: ({ id }) =>
        id === "held"
          ? Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.as(id),
              Effect.onInterrupt(() => Effect.sync(() => void interrupted.push(id))),
            )
          : Effect.succeed(id),
    });
    const peers = peersLink();
    await Effect.runPromise(
      Layer.buildWithScope(
        RpcServer.layer(Probe).pipe(
          Layer.provide(handlers),
          Layer.provide(Layer.effect(RpcServer.Protocol, serverProtocol(heldForServer(peers.link)))),
        ),
        scope,
      ),
    );
    const peerOn = async () => {
      const { port1, port2 } = new MessageChannel();
      ports.push(port1, port2);
      const peer = peers.join((message) => port1.postMessage(message));
      port1.on("message", (message: PortMessage) => peer.deliver(message));
      const client = await Effect.runPromise(
        RpcClient.make(Probe).pipe(Effect.provideServiceEffect(RpcClient.Protocol, clientProtocol(portLink(port2))), Scope.provide(scope)),
      );
      return { client, peer };
    };

    const first = await peerOn();
    void Effect.runPromiseExit(first.client.ProbeWait({ id: "held" }));
    await Effect.runPromise(Deferred.await(started));
    first.peer.leave();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(interrupted).toEqual(["held"]);

    const next = await peerOn();
    expect(await Effect.runPromise(next.client.ProbeWait({ id: "next" }))).toBe("next");
  });
});
