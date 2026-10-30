/**
 * Two machines that both open a link to each other end with one link, the
 * same one at both ends: the one dialed by the lower installation id
 * (docs/machines.md, Rule 7). Each end is a real MachineLink listening on its
 * own owner socket; the SSH transport is a double that relays a dial straight
 * into the other machine's socket, as `junto link` does.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime, Schema, Stream } from "effect";
import { afterEach, expect, it } from "vitest";
import { MachineLink } from "../src/main/junto/link/service";
import { machineLinkLayer } from "../src/main/junto/link/live";
import { coreControlSocketPath } from "../src/main/junto/link/listener";
import type { LinkChannelHandler } from "../src/main/junto/link/types";
import { MachineRepository, makeMachineRepositoryLive } from "../src/main/junto/machines/repository";
import { SshTransport, type SshLease, type SshTransportShape } from "../src/main/junto/ssh/service";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { makeRowsChannel } from "../src/main/junto/work/exchange/channel";
import { MachineCoreRows } from "../src/main/core-runtime";
import { startCore } from "../src/main/junto/core";
import { RemoteHost } from "../src/shared/remote-hosts";
import { InstallationId } from "../src/shared/installation-id";
import { allChannels } from "./support/link-channels";

const BUILD = "c".repeat(64);
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

/** Polls until the check passes. */
const eventually = async (check: () => void, timeoutMs = 3_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { return check(); } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
};

/** An SSH double whose every dial reaches the peer's owner socket; it keeps each lease's socket. */
const relayTransport = (peerHome: () => string, dialed: Socket[]): SshTransportShape => SshTransport.of({
  run: () => Effect.die("no one-shot commands in this test"),
  transfer: () => Effect.die("no transfers in this test"),
  forward: () => Effect.die("no forwards in this test"),
  warm: () => Effect.void,
  teardown: () => Effect.void,
  connect: ((_program: unknown, awaitReady: (lease: SshLease, confirm: <A>(value: A) => never) => Effect.Effect<{ value: unknown }>) => Effect.gen(function* () {
    const socket = yield* Effect.callback<Socket>((resume) => {
      const opened = createConnection(coreControlSocketPath(peerHome()));
      opened.once("connect", () => resume(Effect.succeed(opened)));
      opened.once("error", (cause) => resume(Effect.die(cause)));
    });
    dialed.push(socket);
    yield* Effect.addFinalizer(() => Effect.sync(() => socket.destroy()));
    const lease: SshLease = {
      write: (bytes) => Effect.callback<void>((resume) => { socket.write(bytes, () => resume(Effect.void)); }),
      writeSensitive: () => Effect.die("no secrets in this test"),
      closeInput: Effect.sync(() => { socket.end(); }),
      stdout: Stream.fromAsyncIterable(socket as AsyncIterable<Uint8Array>, (cause) => cause as never),
      stderr: Stream.empty,
      exitCode: Effect.never,
      close: Effect.sync(() => { socket.destroy(); }),
    };
    const ready = yield* awaitReady(lease, (<A>(value: A) => ({ value })) as never);
    return ready.value;
  })) as unknown as SshTransportShape["connect"],
});

/** Which links are open at one end, by the session id of that end. */
const openLinks = (open: Set<string>): LinkChannelHandler => {
  const decode = Schema.decodeUnknownSync(Schema.Struct({ value: Schema.String }), { onExcessProperty: "error" });
  return {
    decodeRequest: decode, decodeResponse: decode, decodeEvent: decode,
    handleRequest: (context) => Effect.succeed({ value: context.sessionId }),
    opened: (context) => Effect.sync(() => { open.add(context.sessionId); }),
    closed: (context) => Effect.sync(() => { open.delete(context.sessionId); }),
  };
};

const machine = async (name: string, peerHome: () => string) => {
  const home = await mkdtemp(join("/tmp", `junto-tie-${name}-`));
  const dialed: Socket[] = [];
  const open = new Set<string>();
  const runtime = ManagedRuntime.make(Layer.provideMerge(machineLinkLayer(BUILD), Layer.mergeAll(
    Layer.provide(makeMachineRepositoryLive({ defaultName: () => name }), makeStateEngineLive(join(home, "junto.db"))),
    Layer.succeed(SshTransport, relayTransport(peerHome, dialed)),
  )));
  cleanups.push(async () => { await runtime.dispose(); await rm(home, { recursive: true, force: true }); });
  const installationId = await runtime.runPromise(Effect.flatMap(MachineRepository, (machines) => machines.installationId));
  const host = Schema.decodeUnknownSync(RemoteHost)({
    id: name, label: name, isThisMachine: false, sshEndpoint: `${name}.test`, capabilities: ["terminal"],
    juntoHome: home, installRoot: join(home, "install"),
  });
  return { name, home, host, runtime, installationId, dialed, open };
};

/** Two pinned machines, each listening: `low` has the lower installation id. */
const pair = async () => {
  let homes: Record<string, string> = {};
  const book = await machine("book", () => homes.mini!);
  const mini = await machine("mini", () => homes.book!);
  homes = { book: book.home, mini: mini.home };
  for (const [at, peer] of [[book, mini], [mini, book]] as const) {
    await at.runtime.runPromise(Effect.gen(function* () {
      yield* (yield* MachineRepository).pinPeer({ machineName: peer.name, installationId: Schema.decodeUnknownSync(InstallationId)(peer.installationId) });
      const link = yield* MachineLink;
      yield* link.setChannels(allChannels({ status: openLinks(at.open) }));
      yield* link.listen(at.home);
    }));
  }
  const [low, high] = book.installationId < mini.installationId ? [book, mini] : [mini, book];
  const connect = (from: typeof book, to: typeof book) => from.runtime.runPromise(Effect.flatMap(MachineLink, (link) => link.connect(to.host)));
  return { low, high, connect };
};

/** Each end holds exactly one open link, and the one `dialer` opened is the one alive. */
const settledOn = async (low: Awaited<ReturnType<typeof machine>>, high: Awaited<ReturnType<typeof machine>>, dialer: Awaited<ReturnType<typeof machine>>) => {
  await eventually(() => {
    expect(low.open.size).toBe(1);
    expect(high.open.size).toBe(1);
    const other = dialer === low ? high : low;
    expect(dialer.dialed.filter((socket) => !socket.destroyed)).toHaveLength(1);
    expect(other.dialed.filter((socket) => !socket.destroyed)).toHaveLength(0);
  });
  // The kept link carries a request both ways.
  for (const [from, to] of [[low, high], [high, low]] as const) {
    const answer = await from.runtime.runPromise(Effect.flatMap(MachineLink, (link) => link.request(to.name, "status", { value: "ping" })));
    expect(answer).toEqual({ value: [...to.open][0] });
  }
};

it("settles a double open on the link the lower installation id dialed, at both ends", async () => {
  for (let round = 0; round < 5; round++) {
    const { low, high, connect } = await pair();
    const [fromLow, fromHigh] = await Promise.all([connect(low, high), connect(high, low)]);
    expect(fromLow.installationId).toBe(high.installationId);
    expect(fromHigh.installationId).toBe(low.installationId);
    // Both ends dialed: this was a double open, not one dial finding the other's link.
    expect(low.dialed).toHaveLength(1);
    expect(high.dialed).toHaveLength(1);
    await settledOn(low, high, low);
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  }
});

it("keeps a link already open when the other end dials it, whichever end opened it", async () => {
  for (const order of ["low first", "high first"] as const) {
    const { low, high, connect } = await pair();
    const [first, second] = order === "low first" ? [low, high] : [high, low];
    await connect(first, second);
    await eventually(() => { expect(low.open.size).toBe(1); expect(high.open.size).toBe(1); });
    const peer = await connect(second, first);
    expect(peer.installationId).toBe(first.installationId);
    await settledOn(low, high, first);
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  }
});

it("stops only the rows link that closed, never the one kept in its place", async () => {
  const home = await mkdtemp("/tmp/junto-tie-rows-");
  const core = await startCore({ home, build: BUILD, bundles: {} });
  cleanups.push(async () => { await core.close(); await rm(home, { recursive: true, force: true }); });
  const peer = Schema.decodeUnknownSync(InstallationId)("peer-installation");
  const rows = await core.runtime.runPromise(MachineCoreRows);
  const channel = makeRowsChannel(rows.exchange);
  const context = (sessionId: string) => ({ peer: { installationId: peer }, sessionId, sendEvent: () => Effect.never });
  // A send that never returns holds each link's worker where it is.
  await core.runtime.runPromise(channel.opened(context("superseded")));
  await core.runtime.runPromise(channel.opened(context("kept")));
  await core.runtime.runPromise(channel.closed(context("superseded")));
  expect(rows.exchange.linked(peer)).toBe(true);
  await core.runtime.runPromise(channel.closed(context("kept")));
  expect(rows.exchange.linked(peer)).toBe(false);
});
