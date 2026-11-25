/**
 * The window hears that what `machine.list` answers may have changed
 * (docs/machines.md, The window): the core publishes `machinesChanged` on the
 * push bus, one push per turn of notes, and main relays it to the window,
 * which reads the list again. Before, only the phone companion heard it.
 */
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { afterEach, expect, it } from "vitest";
import { CORE_PUSHES } from "../src/contract/core/channels";
import { noteMachinesChanged, onMachinesChanged } from "../src/core/hosts/machine-changes";
import { coreControlSocketPath } from "../src/core/link/listener";
import { machineLinkLayer } from "../src/core/link/live";
import { LinkHelloSchema } from "../src/core/link/protocol";
import { MachineLink } from "../src/core/link/service";
import { makeLinkSession } from "../src/core/link/session";
import { MachineRepository, makeMachineRepositoryLive } from "../src/core/machines/repository";
import { SshTransport } from "../src/core/ssh/service";
import { makeStateEngineLive } from "../src/core/state/engine";
import { InstallationId } from "../src/shared/installation-id";
import { RemoteHost } from "../src/shared/remote-hosts";
import { allChannels } from "./support/link-channels";
import { noBoatRoutesLayer } from "./support/no-boat";
import { publishMachinesChanged } from "../src/core/hosts/machine-pushes";
import { IPC_CHANNELS } from "../src/shared/ipc";

const heard = () => {
  const pushes: Array<{ readonly channel: string; readonly payload: unknown }> = [];
  const turns: Array<() => void> = [];
  const stop = publishMachinesChanged({ publish: (channel, payload) => Effect.sync(() => { pushes.push({ channel, payload }); }) }, (run) => { turns.push(run); });
  const turn = () => { for (const run of turns.splice(0)) run(); };
  return { pushes, turn, stop };
};

it("a turn of machine changes is one push, with nothing in it", () => {
  const { pushes, turn, stop } = heard();
  noteMachinesChanged(); noteMachinesChanged(); noteMachinesChanged();
  expect(pushes).toEqual([]);
  turn();
  expect(pushes).toEqual([{ channel: "junto:machines-changed", payload: {} }]);
  noteMachinesChanged();
  turn();
  expect(pushes).toHaveLength(2);
  stop();
});

it("a stopped publisher sends nothing, not even a push already queued", () => {
  const { pushes, turn, stop } = heard();
  noteMachinesChanged();
  stop();
  turn();
  noteMachinesChanged();
  turn();
  expect(pushes).toEqual([]);
});

it("the channel is on the core bus, published by every core with a window, and relayed by main", () => {
  expect(IPC_CHANNELS.machinesChanged).toBe("junto:machines-changed");
  expect(Object.keys(CORE_PUSHES)).toContain(IPC_CHANNELS.machinesChanged);
  expect(readFileSync("src/core/core.ts", "utf8")).toContain("stopMachinePushes = publishMachinesChanged(pushes)");
  const relay = readFileSync("src/app/ipc.ts", "utf8");
  const relayed = relay.slice(relay.indexOf("for (const channel of ["), relay.indexOf("]) onCorePush(channel"));
  expect(relayed).toContain("IPC_CHANNELS.machinesChanged,");
});

const BUILD = "d".repeat(64);
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const settle = () => new Promise((resolve) => setTimeout(resolve, 150));
const eventually = async (check: () => void | Promise<void>, timeoutMs = 3_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { return await check(); } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
};

/**
 * The mini: a real MachineLink listening on its owner socket, with "book"
 * pinned. Its SSH double fails every dial before any link opens, as an
 * unreachable machine does.
 */
const mini = async () => {
  const home = await mkdtemp(join("/tmp", "junto-changes-mini-"));
  const ssh = SshTransport.of({
    run: () => Effect.die("no one-shot commands in this test"), transfer: () => Effect.die("no transfers in this test"),
    forward: () => Effect.die("no forwards in this test"), warm: () => Effect.void, teardown: () => Effect.void,
    connect: () => Effect.die(new Error("ssh: connect to host book.test: no route to host")),
  } as never);
  const runtime = ManagedRuntime.make(Layer.provideMerge(machineLinkLayer(BUILD), Layer.mergeAll(
    noBoatRoutesLayer, Layer.succeed(SshTransport, ssh),
    Layer.provide(makeMachineRepositoryLive({ defaultName: () => "mini" }), makeStateEngineLive(join(home, "junto.db"))),
  )));
  cleanups.push(async () => { await runtime.dispose(); await rm(home, { recursive: true, force: true }); });
  await runtime.runPromise(Effect.gen(function* () {
    yield* (yield* MachineRepository).pinPeer({ machineName: "book", installationId: Schema.decodeUnknownSync(InstallationId)("book-install") });
    const link = yield* MachineLink;
    yield* link.setChannels(allChannels());
    yield* link.listen(home);
  }));
  const book = Schema.decodeUnknownSync(RemoteHost)({
    id: "book", label: "book", isThisMachine: false, sshEndpoint: "book.test", capabilities: ["terminal"],
    juntoHome: join(home, "book"), installRoot: join(home, "book-install"),
  });
  return { home, runtime, book };
};

/** A far end that links into the mini's owner socket, saying it is `name`. */
const linkIn = async (home: string, name: string, build = BUILD) => {
  const socket = await new Promise<Socket>((resolve, reject) => {
    const opened = createConnection(coreControlSocketPath(home));
    opened.once("connect", () => resolve(opened));
    opened.once("error", reject);
  });
  const self = Schema.decodeUnknownSync(LinkHelloSchema)({ machineName: name, installationId: `${name}-install`, build });
  const far = makeLinkSession({ readable: socket, writable: socket, self, admit: async () => {}, channels: allChannels(), run: Effect.runPromise });
  cleanups.push(async () => { await far.close(); socket.destroy(); });
  return far;
};

const counted = () => {
  const notes = { count: 0 };
  cleanups.push(async () => stop());
  const stop = onMachinesChanged(() => { notes.count += 1; });
  return notes;
};

it("a link that had opened and then closes is one change, so a machine that went away shows at once", async () => {
  const { home, runtime } = await mini();
  const far = await linkIn(home, "book");
  await far.ready;
  // The mini admitted book and learned its build: that opening was noted.
  await eventually(async () => {
    expect(await runtime.runPromise(Effect.flatMap(MachineLink, (link) => link.peerBuild("book")))).toBe(BUILD);
  });
  await settle();
  const notes = counted();
  await far.close();
  await eventually(() => { expect(notes.count).toBe(1); });
  await settle();
  expect(notes.count).toBe(1);
});

it("a dial that fails before any link opens is no change, so the read that follows is silent", async () => {
  const { home, runtime, book } = await mini();
  const notes = counted();
  const dialed = await runtime.runPromise(Effect.flatMap(MachineLink, (link) => link.connect(book)).pipe(Effect.flip));
  expect(dialed._tag).toBe("LinkClosed");
  // A machine this one does not know links in and is refused at its hello.
  const stranger = await linkIn(home, "stranger");
  void stranger.ready.catch(() => undefined);
  await stranger.closed;
  await settle();
  expect(notes.count).toBe(0);
});

it("a refused hello that repeats a build already heard is no change, so redialing a mismatched peer cannot loop", async () => {
  const { home } = await mini();
  const notes = counted();
  const older = "e".repeat(64);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const far = await linkIn(home, "book", older);
    void far.ready.catch(() => undefined);
    await far.closed;
  }
  await settle();
  // The first hello taught the mini book's older build: one change, then none.
  expect(notes.count).toBe(1);
});
