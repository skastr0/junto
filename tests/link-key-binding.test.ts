/**
 * A peer pinned with its link key links to this machine only through that
 * key (docs/machines.md, The link): `machine_peers.binding` holds it, a pin
 * never drops it, and only retiring the peer clears it. A hello from that
 * peer over any other route is refused before a channel opens.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { afterEach, expect, it } from "vitest";
import { machineLinkLayer } from "../src/main/junto/link/live";
import { coreControlSocketPath } from "../src/main/junto/link/listener";
import { LinkHelloSchema } from "../src/main/junto/link/protocol";
import { MachineLink } from "../src/main/junto/link/service";
import { makeLinkSession } from "../src/main/junto/link/session";
import { MachineRepository, makeMachineRepositoryLive } from "../src/main/junto/machines/repository";
import { SshTransport } from "../src/main/junto/ssh/service";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { InstallationId } from "../src/shared/installation-id";
import { allChannels } from "./support/link-channels";

const BUILD = "c".repeat(64);
const MINI = Schema.decodeUnknownSync(InstallationId)("mini-installation");
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const machine = async () => {
  const home = await mkdtemp("/tmp/junto-key-binding-");
  const runtime = ManagedRuntime.make(Layer.provideMerge(machineLinkLayer(BUILD, home), Layer.mergeAll(
    Layer.provide(makeMachineRepositoryLive({ defaultName: () => "vps" }), makeStateEngineLive(join(home, "junto.db"))),
    Layer.succeed(SshTransport, SshTransport.of({} as never)),
  )));
  cleanups.push(async () => { await runtime.dispose(); await rm(home, { recursive: true, force: true }); });
  const repository = await runtime.runPromise(MachineRepository);
  return { home, runtime, repository, run: <A, E>(effect: Effect.Effect<A, E, MachineRepository | MachineLink>) => runtime.runPromise(effect) };
};

it("keeps a key binding through every pin, and clears it only when the peer is retired", async () => {
  const { repository, run } = await machine();
  expect(await run(repository.pinPeer({ machineName: "mini", installationId: MINI }))).not.toHaveProperty("binding");
  expect(await run(repository.pinPeer({ machineName: "mini", installationId: MINI }, { binding: "key" }))).toMatchObject({ binding: "key" });
  // A setup or send pins again without a binding: the key stays.
  expect(await run(repository.pinPeer({ machineName: "mini", installationId: MINI }))).toMatchObject({ binding: "key" });
  expect(await run(repository.peer("mini"))).toMatchObject({ binding: "key" });
  expect((await run(repository.peers))[0]).toMatchObject({ binding: "key" });
  await run(repository.retirePeer("mini"));
  expect(await run(repository.pinPeer({ machineName: "mini", installationId: MINI }))).not.toHaveProperty("binding");
});

const eventually = async (check: () => Promise<void>, timeoutMs = 3_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { return await check(); } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
};

/** One connection to the listener as `mini`, optionally led by the opener line a link key's relay writes. */
const dial = async (home: string, opener?: string) => {
  const socket = await new Promise<Socket>((resolve, reject) => {
    const opened = createConnection(coreControlSocketPath(home));
    opened.once("connect", () => resolve(opened));
    opened.once("error", reject);
  });
  if (opener !== undefined) socket.write(`${JSON.stringify({ type: "opener", installationId: opener })}\n`);
  const session = makeLinkSession({
    readable: socket, writable: socket, run: Effect.runPromise, channels: {}, admit: async () => {},
    self: Schema.decodeUnknownSync(LinkHelloSchema)({ machineName: "mini", installationId: MINI, build: BUILD }),
  });
  cleanups.push(async () => { await session.close(); socket.destroy(); });
  return session;
};

it("refuses a key-bound peer that links without its key, and admits it through the key", async () => {
  const { home, repository, run } = await machine();
  await run(repository.pinPeer({ machineName: "mini", installationId: MINI }, { binding: "key" }));
  await run(Effect.gen(function* () {
    const link = yield* MachineLink;
    yield* link.setChannels(allChannels());
    yield* link.listen(home);
  }));

  // The listener tells an unadmitted far end nothing: its input just ends. Only an admitted peer has a build here.
  const admitted = () => run(Effect.flatMap(MachineLink, (link) => link.peerBuild("mini")));
  const unbound = await dial(home);
  expect(await unbound.closed).toMatchObject({ reason: "input-ended" });
  expect(await admitted()).toBeUndefined();

  const bound = await dial(home, MINI);
  await eventually(async () => expect(await admitted()).toBe(BUILD));
  await bound.close();

});

it("admits the same dial without the key from a peer that is not key-bound", async () => {
  const { home, repository, run } = await machine();
  await run(repository.pinPeer({ machineName: "mini", installationId: MINI }));
  await run(Effect.gen(function* () {
    const link = yield* MachineLink;
    yield* link.setChannels(allChannels());
    yield* link.listen(home);
  }));
  await dial(home);
  await eventually(async () => expect(await run(Effect.flatMap(MachineLink, (link) => link.peerBuild("mini")))).toBe(BUILD));
});
