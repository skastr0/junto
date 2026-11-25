import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Deferred, Effect, Layer, ManagedRuntime, Schema } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeError } from "../src/node/failure-encode";
import { HostsService } from "../src/core/hosts/service";
import { InventoryLink, makeInventoryChannel } from "../src/core/inventory/channel";
import { makePeerInventory } from "../src/core/inventory/client";
import { makePeerInventoryCache } from "../src/core/inventory/peer-cache";
import {
  decodeLinkInventorySnapshot,
  InventoryLinkFailure,
  InventoryNoSeatHere,
  InventoryNotFromItsMachine,
  InventoryPeerNotPinned,
  wireSnapshot,
} from "../src/core/inventory/wire";
import { bindLinkChannel, linkClient, type LinkContractChannel } from "../src/core/link/contract";
import type { LinkFrame } from "../src/core/link/protocol";
import { MachineLink } from "../src/core/link/service";
import type { LinkChannelContext, LinkHello, LinkSession } from "../src/core/link/types";
import { MachineRepository, makeMachineRepositoryLive } from "../src/core/machines/repository";
import { makeStateEngineLive } from "../src/core/state/engine";
import { facingRaw as linkFacingRaw, hello, machineLinkOver, makeSessions, pair as linkPair, type Run } from "./support/link-pair";
import { makeTestLog } from "./support/test-log";

const testLog = makeTestLog();
import { machineLogDir } from "../src/node/observability/log-file";
import { HarnessInventory } from "../src/core/term/templates/harness-inventory";
import { WorkRepositoryLive } from "../src/core/work/repository";
import type { MachineInventory } from "../src/shared/harness-domain/inventory";
import { InstallationId } from "../src/shared/installation-id";
import { asCanvasName, type Node } from "../src/shared/model";
import { RemoteHost } from "../src/shared/remote-hosts";
import { THIS_MACHINE } from "./support/machines";
import { seat } from "./support/model-nodes";
import { ModelStoresLive, seedCanvas } from "./support/seed-canvas";
import { clearMachines, seedThisMachine } from "./support/seed-this-machine";

const installation = Schema.decodeUnknownSync(InstallationId);
const editor = installation("editor-installation");
const canvas = asCanvasName("inventory-canvas");
const PEER = "mini";

/** What this machine's scan holds, with the fields that must stay home. */
const local = (machine: string): MachineInventory => ({
  machine,
  harnesses: [
    {
      harness: "claude",
      machine,
      installed: true,
      executable: "/Users/someone/.local/bin/claude",
      version: "2.1.302",
      models: [
        { id: "opus[1m]", label: "Opus (1M context)", description: "secret description" },
        { id: "openrouter/~anthropic/claude-opus-latest", label: "~anthropic/claude-opus-latest" },
        { id: "bad id; rm -rf", label: "Bad" },
        { id: "grok-4.7", label: "Grok 4.7​", efforts: ["low", "high", "BAD EFFORT"] },
      ],
      efforts: ["low", "medium", "high"],
      scannedAt: 1_792_000_000_000,
      refreshing: false,
      lastFailure: { reason: "failed", message: "stderr: token sk-123 at /Users/someone", at: 1_791_000_000_000 },
      verification: { verdict: "verified", from: "2.1.272", through: "2.1.302" },
    },
    { harness: "codex", machine, installed: false, models: [], efforts: [], refreshing: false },
  ],
});

const cleanups: Array<() => Promise<void>> = [];
beforeEach(() => seedThisMachine());
afterEach(async () => {
  await sessions.closeAll();
  for (const close of cleanups.splice(0).reverse()) await close();
  clearMachines();
});

const runtimeWith = async (nodes: ReadonlyArray<Node>, inventory?: MachineInventory, gate?: Deferred.Deferred<void>) => {
  const root = await mkdtemp(join(tmpdir(), "junto-inventory-link-"));
  const scans = vi.fn();
  const inventoryLayer = Layer.succeed(HarnessInventory, HarnessInventory.of({
    harnesses: () => Effect.die("the channel reads the machine snapshot only"),
    models: () => Effect.die("the channel never scans"),
    machine: Effect.gen(function* () {
      scans();
      if (gate !== undefined) yield* Deferred.await(gate);
      return inventory ?? local(THIS_MACHINE);
    }),
  }));
  const repositories = Layer.provideMerge(Layer.mergeAll(
    WorkRepositoryLive,
    makeMachineRepositoryLive({ defaultName: () => THIS_MACHINE }),
  ), makeStateEngineLive(join(root, "junto.db")));
  const runtime = ManagedRuntime.make(Layer.mergeAll(inventoryLayer, Layer.provideMerge(ModelStoresLive, repositories), testLog.log.loggerLayer));
  cleanups.push(async () => {
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  });
  await runtime.runPromise(Effect.gen(function* () {
    const machines = yield* MachineRepository;
    yield* machines.pinPeer({ machineName: "macbook", installationId: editor });
    yield* machines.pinPeer({ machineName: PEER, installationId: installation("mini-installation") });
    yield* seedCanvas(canvas, nodes);
  }));
  return { root, runtime, scans };
};

// ── Two ends of one link, over a pair of streams ──────────────────────────

const sessions = makeSessions();
const helloOf = (machineName: string, installationId: string): LinkHello => hello(machineName, installationId);
const EDITOR_HELLO = helloOf("macbook", "editor-installation");
const PEER_HELLO = helloOf(PEER, "mini-installation");

/** The asking end binds the contract too: it encodes what it sends and decodes what it gets with it. */
const asking = (): LinkContractChannel => bindLinkChannel(InventoryLink, { requests: { Snapshot: () => Effect.die("the asking end answers nothing") } });

/** A real session at each end, on the inventory channel. */
const pair = (options: {
  readonly left: LinkHello; readonly right: LinkHello;
  readonly leftChannel: LinkContractChannel; readonly rightChannel: LinkContractChannel;
  readonly run: Run;
}) => {
  const { a: left, b: right } = linkPair(
    { self: options.left, channels: { inventory: options.leftChannel }, run: options.run },
    { self: options.right, channels: { inventory: options.rightChannel }, run: options.run },
  );
  sessions.keep(left, right);
  return { left, right };
};

/** A real session facing an end written by hand, on the inventory channel. */
const facingRaw = (options: {
  readonly self: LinkHello; readonly peer: LinkHello; readonly channel: LinkContractChannel; readonly run: Run;
  readonly reply?: (frame: LinkFrame) => unknown;
}) => {
  const raw = linkFacingRaw(options.self, options.peer, { inventory: options.channel }, options.reply, options.run);
  sessions.keep(raw.session);
  return raw;
};

/** This core's link, with one peer reached over `session`; a connect reaches that peer. */
const linkOver = (session: () => LinkSession | undefined) => machineLinkOver(session, {
  connect: () => Effect.succeed({ machineName: PEER, installationId: editor, boundAt: "2026-10-17" }),
});

describe("inventory wire", () => {
  it("builds the snapshot field by field: no path, failure text or description, bad models left out", () => {
    const { snapshot, omittedModels } = wireSnapshot(local(PEER), 1_792_000_100_000);
    expect(omittedModels).toBe(1);
    const text = JSON.stringify(snapshot);
    for (const home of ["/Users/someone", "sk-123", "secret description", "executable", "message", "rm -rf"]) {
      expect(text).not.toContain(home);
    }
    const claude = snapshot.harnesses[0]!;
    expect(claude.models).toEqual([
      { id: "opus[1m]", label: "Opus (1M context)" },
      { id: "openrouter/~anthropic/claude-opus-latest", label: "~anthropic/claude-opus-latest" },
      // A zero-width label is shown as its id; a bad effort is left out.
      { id: "grok-4.7", label: "grok-4.7", efforts: ["low", "high"] },
    ]);
    expect(claude.failure).toEqual({ reason: "failed", at: 1_791_000_000_000 });
    expect(claude.verification).toEqual({ verdict: "verified", from: "2.1.272", through: "2.1.302" });
    expect(decodeLinkInventorySnapshot(JSON.parse(text))).toEqual(snapshot);
  });

  it("never sends unreachable, the editing machine's own word", () => {
    const row = { ...local(PEER).harnesses[0]!, lastFailure: { reason: "unreachable" as const, at: 1 } };
    expect(wireSnapshot({ machine: PEER, harnesses: [row] }, 2).snapshot.harnesses[0]).not.toHaveProperty("failure");
  });

  it("decodes closed: excess keys, bad shapes, unbounded lists and repeated harnesses are refused", () => {
    const good = wireSnapshot(local(PEER), 2).snapshot;
    const claude = good.harnesses[0]!;
    const bad: unknown[] = [
      { ...good, extra: 1 },
      { ...good, harnesses: [{ ...claude, executable: "/bin/claude" }] },
      { ...good, harnesses: [{ ...claude, models: [{ id: "x", label: "<b>x</b>" }] }] },
      { ...good, harnesses: [{ ...claude, models: [{ id: "a‮b", label: "x" }] }] },
      { ...good, harnesses: [{ ...claude, version: "2.1.302 (Claude Code)\n" }] },
      { ...good, harnesses: [{ ...claude, failure: { reason: "unreachable", at: 1 } }] },
      { ...good, harnesses: [{ ...claude, models: Array.from({ length: 201 }, (_, i) => ({ id: `m${i}`, label: `m${i}` })) }] },
      { ...good, harnesses: [claude, claude] },
      { ...good, machine: "../etc" },
    ];
    for (const payload of bad) expect(() => decodeLinkInventorySnapshot(payload), JSON.stringify(payload).slice(0, 120)).toThrow();
  });
});

describe("inventory channel answer, over a real session pair", () => {
  const here = seat("mini-seat", { host: THIS_MACHINE, agentKey: `${THIS_MACHINE}:mini-seat` });

  /** A pinned peer asks this machine's real channel with the typed client. */
  const answering = async (nodes: ReadonlyArray<Node>, asker: LinkHello = EDITOR_HELLO) => {
    const f = await runtimeWith(nodes);
    const channel = await f.runtime.runPromise(makeInventoryChannel());
    const run: Run = (effect) => f.runtime.runPromise(effect);
    const { left } = pair({ left: asker, right: helloOf(THIS_MACHINE, "studio-installation"), leftChannel: asking(), rightChannel: channel, run });
    await left.ready;
    const snapshot = (operationId: string) => Effect.flatMap(linkClient(InventoryLink), (client) =>
      client.Snapshot(THIS_MACHINE, {}, { operationId })).pipe(Effect.provideService(MachineLink, linkOver(() => left)));
    const ask = (operationId: string) => f.runtime.runPromise(snapshot(operationId));
    const refused = (operationId: string) => f.runtime.runPromise(Effect.flip(snapshot(operationId)));
    return { ...f, ask, refused, left };
  };

  it("answers a pinned peer on an open link from the cache, naming nothing", async () => {
    const f = await answering([here]);
    const snapshot = await f.ask("op-inventory-1");
    expect(snapshot.machine).toBe(THIS_MACHINE);
    expect(snapshot.harnesses.map((row) => row.harness)).toEqual(["claude", "codex"]);
    expect(f.scans).toHaveBeenCalledTimes(1);
  });

  it("answers a pinned peer when no canvas has a seat on this machine", async () => {
    const f = await answering([]);
    expect((await f.ask("op-no-seat")).machine).toBe(THIS_MACHINE);
    expect(f.scans).toHaveBeenCalledTimes(1);
  });

  // One runtime (a state database and a session pair) per case, each in its own test and time budget.
  const refusal = async (asker: LinkHello) => {
    const f = await answering([here], asker);
    const failure = await f.refused("op-inventory-1");
    expect(f.scans).not.toHaveBeenCalled();
    // The refusal arrives as the channel's own typed failure, decoded by the contract.
    expect(Schema.is(InventoryLinkFailure)(failure)).toBe(true);
    return failure;
  };

  it("refuses an unpinned peer as a typed failure", async () => {
    expect(await refusal(helloOf("macbook", "stranger-installation")))
      .toMatchObject({ _tag: "InventoryPeerNotPinned", operationId: "op-inventory-1" });
  });

  it("refuses a retired peer as unpinned, before any scan", async () => {
    const f = await answering([here], PEER_HELLO);
    await f.runtime.runPromise(Effect.flatMap(MachineRepository, (machines) => machines.retirePeer(PEER)));
    expect(await f.refused("op-retired")).toMatchObject({ _tag: "InventoryPeerNotPinned" });
    expect(f.scans).not.toHaveBeenCalled();
  });

  it("coalesces asks from two pinned peers into one scan", async () => {
    const gate = Deferred.makeUnsafe<void>();
    const f = await runtimeWith([here], undefined, gate);
    const channel = await f.runtime.runPromise(makeInventoryChannel());
    const run: Run = (effect) => f.runtime.runPromise(effect);
    const entered = vi.fn();
    const counted: LinkContractChannel = {
      ...channel,
      handleRequest: (tag, context, payload) => {
        entered();
        return channel.handleRequest(tag, context, payload);
      },
    };
    const one = pair({ left: EDITOR_HELLO, right: helloOf(THIS_MACHINE, "studio-installation"), leftChannel: asking(), rightChannel: counted, run });
    const two = pair({ left: PEER_HELLO, right: helloOf(THIS_MACHINE, "studio-installation"), leftChannel: asking(), rightChannel: counted, run });
    await Promise.all([one.left.ready, two.left.ready]);
    const askOver = (left: LinkSession, operationId: string) => f.runtime.runPromise(
      Effect.flatMap(linkClient(InventoryLink), (client) => client.Snapshot(THIS_MACHINE, {}, { operationId }))
        .pipe(Effect.provideService(MachineLink, linkOver(() => left))),
    );
    const first = askOver(one.left, "op-both-1");
    const second = askOver(two.left, "op-both-2");
    // Both requests are in the handler, waiting on the one snapshot, before it is allowed to finish.
    await vi.waitFor(() => expect(entered).toHaveBeenCalledTimes(2));
    expect(f.scans).toHaveBeenCalledTimes(1);
    await f.runtime.runPromise(Deferred.succeed(gate, undefined));
    expect((await Promise.all([first, second])).map((answer) => answer.machine)).toEqual([THIS_MACHINE, THIS_MACHINE]);
    expect(f.scans).toHaveBeenCalledTimes(1);
  });

  it("names nothing: a request that still names a canvas closes the link before admission", async () => {
    for (const payload of [{ canvas }, { canvas, harness: "claude" }, { harness: "claude" }]) {
      const f = await runtimeWith([here]);
      const channel = await f.runtime.runPromise(makeInventoryChannel());
      const raw = facingRaw({ self: helloOf(THIS_MACHINE, "studio-installation"), peer: EDITOR_HELLO, channel, run: (effect) => f.runtime.runPromise(effect) });
      await raw.session.ready;
      raw.send({ type: "request", id: "r1", op: "op-1", channel: "inventory", tag: "Snapshot", payload });
      expect(await raw.session.closed).toMatchObject({ by: "this-end", reason: "frame-invalid" });
      expect(f.scans).not.toHaveBeenCalled();
    }
  });

  it("refuses an event frame: the channel carries none", async () => {
    const f = await runtimeWith([]);
    const channel = await f.runtime.runPromise(makeInventoryChannel());
    const raw = facingRaw({ self: helloOf(THIS_MACHINE, "studio-installation"), peer: EDITOR_HELLO, channel, run: (effect) => f.runtime.runPromise(effect) });
    await raw.session.ready;
    raw.send({ type: "event", channel: "inventory", payload: {} });
    const closed = await raw.session.closed;
    expect(closed).toMatchObject({ reason: "frame-invalid" });
    expect(closed.message).toContain("does not accept events");
  });
});

describe("inventory channel request, over a real session pair", () => {
  /** This machine asks `mini` over a pin and an open link; the end is a real session or one written by hand. */
  const client = async () => {
    const f = await runtimeWith([]);
    const dir = join(f.root, "peer-inventory");
    const host = Schema.decodeUnknownSync(RemoteHost)({
      id: PEER, label: "Mini", isThisMachine: false, sshEndpoint: "mini", capabilities: ["terminal"],
    });
    const hosts = HostsService.of({
      get: () => Effect.succeed(host), list: Effect.die("unused"), doctor: Effect.die("unused"), doctorSnapshot: Effect.die("unused"),
      upsert: () => Effect.die("unused"), remove: () => Effect.die("unused"), test: () => Effect.die("unused"),
    } as never);
    const run: Run = (effect) => f.runtime.runPromise(effect);
    const self = helloOf(THIS_MACHINE, "studio-installation");
    let session: LinkSession | undefined;
    /** `mini` answers with the real session typed by the contract. */
    const typedPeer = (respond: (request: Record<string, never>, context: LinkChannelContext) => ReturnType<NonNullable<LinkContractChannel["handleRequest"]>>) => {
      const seen: Array<{ readonly payload: unknown; readonly operationId?: string }> = [];
      const peer = bindLinkChannel(InventoryLink, { requests: { Snapshot: (request, context) => {
        seen.push({ payload: request, ...(context.operationId === undefined ? {} : { operationId: context.operationId }) });
        return respond(request, context) as never;
      } } });
      session = pair({ left: self, right: PEER_HELLO, leftChannel: asking(), rightChannel: peer, run }).left;
      return seen;
    };
    /** `mini` writes its answer by hand, as bytes no typed handler could send. */
    const rawPeer = (payload: () => unknown) => {
      session = facingRaw({ self, peer: PEER_HELLO, channel: asking(), run, reply: (frame) => frame.type !== "request" ? undefined
        : { type: "response", id: frame.id, op: frame.op, channel: frame.channel, ok: true, payload: payload() } }).session;
    };
    const unlink = () => { session = undefined; };
    const ask = (operationId: string) => f.runtime.runPromise(Effect.flatMap(makePeerInventory(makePeerInventoryCache(dir)), (peer) => peer.inventoryOf(PEER, operationId)).pipe(
      Effect.provideService(HostsService, hosts), Effect.provideService(MachineLink, linkOver(() => session)),
      Effect.provide(testLog.log.loggerLayer),
    ));
    return { ask, dir, typedPeer, rawPeer, unlink };
  };

  it("sends an empty request and the operation id, and keeps the snapshot 0600 in a 0700 directory", async () => {
    const good = wireSnapshot(local(PEER), 1_792_000_100_000).snapshot;
    const c = await client();
    const seen = c.typedPeer(() => Effect.succeed(good));
    const answer = await c.ask("op-ask-1");
    expect(seen).toEqual([{ payload: {}, operationId: "op-ask-1" }]);
    expect(answer.ok && answer.inventory.harnesses[0]!.models.map((model) => model.id))
      .toEqual(["opus[1m]", "openrouter/~anthropic/claude-opus-latest", "grok-4.7"]);
    expect((await stat(c.dir)).mode & 0o777).toBe(0o700);
    expect((await stat(join(c.dir, `${PEER}.json`))).mode & 0o777).toBe(0o600);
  });

  it("refuses a bad snapshot or one from another machine as one typed failure, with the link open, and shows the last good one", async () => {
    const good = wireSnapshot(local(PEER), 1_792_000_100_000).snapshot;
    let next: unknown = good;
    const c = await client();
    c.rawPeer(() => next);
    expect((await c.ask("op-good")).ok).toBe(true);

    next = { ...good, harnesses: [{ ...good.harnesses[0]!, executable: "/bin/claude" }] };
    const refused = await c.ask("op-bad");
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error).toMatchObject({ failure: "InventorySnapshotRefused", reason: "failed", operationId: "op-bad" });
    expect(refused.error.last?.inventory.machine).toBe(PEER);

    // A harness named twice is refused by the contract's own schema.
    next = { ...good, harnesses: [good.harnesses[0]!, good.harnesses[0]!] };
    expect(await c.ask("op-twice")).toMatchObject({ ok: false, error: { failure: "InventorySnapshotRefused" } });

    // The same link still answers: a refused answer fails only its request.
    next = { ...good, machine: "studio" };
    const foreign = await c.ask("op-foreign");
    expect(!foreign.ok && foreign.error).toMatchObject({ failure: "InventoryNotFromItsMachine", operationId: "op-foreign" });
  });

  it("shows the last snapshot, its age and the typed link failure when the machine cannot be reached", async () => {
    const good = wireSnapshot(local(PEER), 1_792_000_100_000).snapshot;
    const c = await client();
    c.typedPeer(() => Effect.succeed(good));
    await c.ask("op-1");
    c.unlink();
    const answer = await c.ask("op-2");
    expect(answer.ok).toBe(false);
    if (answer.ok) return;
    expect(answer.error).toMatchObject({ reason: "unreachable", failure: "LinkUnavailable", operationId: "op-2" });
    expect(answer.error.last?.receivedAt).toBeGreaterThan(0);
  });

  it("carries the answering machine's typed refusal through the link", async () => {
    const c = await client();
    c.typedPeer(() => Effect.fail(new InventoryPeerNotPinned({ machine: PEER, message: "The asking machine is no longer pinned." })));
    const answer = await c.ask("op-refused");
    expect(!answer.ok && answer.error).toMatchObject({ failure: "InventoryPeerNotPinned", reason: "failed" });
  });

  it("never shows a stored file that fails the closed decode", async () => {
    const c = await client();
    await mkdir(c.dir, { recursive: true });
    await writeFile(join(c.dir, `${PEER}.json`), JSON.stringify({ version: 1, receivedAt: 1, snapshot: { machine: PEER, takenAt: 1, harnesses: [], extra: "<script>" } }));
    const answer = await c.ask("op-1");
    expect(!answer.ok && answer.error.last).toBeUndefined();
    expect(await readFile(join(c.dir, `${PEER}.json`), "utf8")).toContain("<script>");
  });

  it("logs and answers a decode failure as its path, never the value it saw, at both ends", async () => {
    const home = await mkdtemp(join(tmpdir(), "junto-inventory-log-"));
    cleanups.push(async () => { testLog.log.closeFile(); await rm(home, { recursive: true, force: true }); });
    testLog.log.openFile({ home });
    const secret = "SECRETVALUE7f3k2";

    // The answering end refuses a request it cannot decode, and closes.
    const f = await runtimeWith([seat("here", { host: THIS_MACHINE, agentKey: `${THIS_MACHINE}:here` })]);
    const channel = await f.runtime.runPromise(makeInventoryChannel());
    const raw = facingRaw({ self: helloOf(THIS_MACHINE, "studio-installation"), peer: EDITOR_HELLO, channel, run: (effect) => f.runtime.runPromise(effect) });
    await raw.session.ready;
    raw.send({ type: "request", id: "r1", op: "op-1", channel: "inventory", tag: "Snapshot", payload: { canvas: `<${secret}>` } });
    await raw.session.closed;

    // The asking end refuses an answer it cannot decode, and stays open.
    const good = wireSnapshot(local(PEER), 2).snapshot;
    const bad = { ...good, harnesses: [{ ...good.harnesses[0]!, models: [{ id: "opus", label: `<${secret}>` }] }] };
    const c = await client();
    c.rawPeer(() => bad);
    const answer = await c.ask("op-secret");
    expect(!answer.ok && answer.error.message).toContain("label");
    expect(JSON.stringify(answer)).not.toContain(secret);

    const log = readFileSync(join(machineLogDir(home), "core.jsonl"), "utf8");
    expect(log).toContain("link closed");
    expect(log).toContain("link response refused");
    expect(log).toContain("peer inventory failed");
    expect(log).toContain("inventory request does not match its schema");
    expect(log).not.toContain(secret);
  });

  it("bounds every failure field that crosses as detail", () => {
    const where = { machine: PEER, operationId: "op-1", message: "fine" };
    expect(() => new InventoryNoSeatHere(where)).not.toThrow();
    expect(() => new InventoryNoSeatHere({ ...where, machine: "../etc" })).toThrow();
    expect(() => new InventoryNoSeatHere({ ...where, operationId: "op 1; x" })).toThrow();
    expect(() => new InventoryNoSeatHere({ ...where, message: "x".repeat(1025) })).toThrow();
    expect(() => new InventoryNotFromItsMachine({ ...where, claimed: "x".repeat(65) })).toThrow();
  });

  it("builds no path from a name that is not a machine name", async () => {
    const cache = makePeerInventoryCache(join(tmpdir(), "never-made"));
    const refused = await Effect.runPromise(Effect.flip(cache.read("../../etc/passwd")));
    expect(refused).toMatchObject({ _tag: "PeerInventoryNameRefused" });
  });
});
