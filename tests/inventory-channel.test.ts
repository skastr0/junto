import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
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
  wireSnapshot,
} from "../src/core/inventory/wire";
import { bindLinkChannel, linkClient, type LinkContractChannel } from "../src/core/link/contract";
import { decodeLinkFrame, LinkHelloSchema, type LinkFrame } from "../src/core/link/protocol";
import { isMachineLinkError, LinkUnavailable, MachineLink } from "../src/core/link/service";
import { makeLinkSession } from "../src/core/link/session";
import { linkClosed, type LinkChannelContext, type LinkHello, type LinkSession } from "../src/core/link/types";
import { MachineRepository, makeMachineRepositoryLive } from "../src/core/machines/repository";
import { ModelService } from "../src/core/model/service";
import { makeStateEngineLive } from "../src/core/state/engine";
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
  await Promise.all(sessions.splice(0).map((session) => session.close()));
  for (const close of cleanups.splice(0).reverse()) await close();
  clearMachines();
});

const runtimeWith = async (nodes: ReadonlyArray<Node>, canvasEditor: "editor" | "self", inventory?: MachineInventory) => {
  const root = await mkdtemp(join(tmpdir(), "junto-inventory-link-"));
  const scans = vi.fn();
  const inventoryLayer = Layer.succeed(HarnessInventory, HarnessInventory.of({
    harnesses: () => Effect.die("the channel reads the machine snapshot only"),
    models: () => Effect.die("the channel never scans"),
    machine: Effect.sync(() => {
      scans();
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
    if (canvasEditor === "self") return yield* seedCanvas(canvas, nodes);
    yield* (yield* ModelService).installCopy({ canvas, canvasId: "copied-canvas", seq: 1, editor, nodes, wires: [] });
  }));
  return { root, runtime, scans };
};

// ── Two ends of one link, over a pair of streams ──────────────────────────

const sessions: LinkSession[] = [];
const BUILD = "a".repeat(64);
const helloOf = (machineName: string, installationId: string): LinkHello =>
  Schema.decodeUnknownSync(LinkHelloSchema)({ build: BUILD, installationId, machineName });
const EDITOR_HELLO = helloOf("macbook", "editor-installation");
const PEER_HELLO = helloOf(PEER, "mini-installation");

/** The asking end binds the contract too: it encodes what it sends and decodes what it gets with it. */
const asking = (): LinkContractChannel => bindLinkChannel(InventoryLink, { requests: { Snapshot: () => Effect.die("the asking end answers nothing") } });

type Run = <A, E>(effect: Effect.Effect<A, E>) => Promise<A>;

/** A real session at each end. */
const pair = (options: {
  readonly left: LinkHello; readonly right: LinkHello;
  readonly leftChannel: LinkContractChannel; readonly rightChannel: LinkContractChannel;
  readonly run: Run;
}) => {
  const ab = new PassThrough(); const ba = new PassThrough();
  const left = makeLinkSession({ readable: ba, writable: ab, self: options.left, admit: async () => {}, channels: { inventory: options.leftChannel }, run: options.run });
  const right = makeLinkSession({ readable: ab, writable: ba, self: options.right, admit: async () => {}, channels: { inventory: options.rightChannel }, run: options.run });
  sessions.push(left, right);
  return { left, right };
};

/** A real session facing an end written by hand, which says hello and writes what `reply` returns to each frame. */
const facingRaw = (options: {
  readonly self: LinkHello; readonly peer: LinkHello; readonly channel: LinkContractChannel; readonly run: Run;
  readonly reply?: (frame: LinkFrame) => unknown;
}) => {
  const toSession = new PassThrough(); const fromSession = new PassThrough();
  const frames: LinkFrame[] = [];
  const send = (frame: unknown) => toSession.write(`${JSON.stringify(frame)}\n`);
  let pending = "";
  fromSession.on("data", (bytes: Buffer) => {
    pending += bytes.toString();
    for (let newline = pending.indexOf("\n"); newline >= 0; newline = pending.indexOf("\n")) {
      const frame = decodeLinkFrame(JSON.parse(pending.slice(0, newline)));
      pending = pending.slice(newline + 1);
      frames.push(frame);
      if (frame.type === "hello") send({ type: "hello", ...options.peer });
      else if (options.reply !== undefined) { const answer = options.reply(frame); if (answer !== undefined) send(answer); }
    }
  });
  const session = makeLinkSession({ readable: toSession, writable: fromSession, self: options.self, admit: async () => {}, channels: { inventory: options.channel }, run: options.run });
  sessions.push(session);
  return { session, send, frames };
};

/** This core's link, with one peer reached over `session`, as `MachineLink` sees it. */
const linkOver = (session: () => LinkSession | undefined) => {
  const unused = Effect.die("unused machine operation");
  const toLink = (machine: string) => (cause: unknown) => isMachineLinkError(cause) ? cause : linkClosed({ machine, by: "this-end", reason: "failed", cause });
  return MachineLink.of({
    setChannels: () => unused, listen: () => unused, connectSetup: () => unused, disconnect: () => unused, peerBuild: () => unused,
    connect: () => Effect.succeed({ machineName: PEER, installationId: editor, boundAt: "2026-10-17" }),
    request: (machine, channel, payload, options) => {
      const held = session();
      if (held === undefined) return Effect.fail(new LinkUnavailable({ machine, reason: "not-linked", message: `${machine} is not linked` }));
      return Effect.tryPromise({ try: (signal) => held.request(channel, payload, options?.operationId, options?.tag, signal), catch: toLink(machine) });
    },
    sendEvent: (machine, channel, payload) => Effect.tryPromise({ try: () => session()!.sendEvent(channel, payload), catch: toLink(machine) }),
  });
};

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

  /** The editing machine asks this machine's real channel with the typed client. */
  const answering = async (nodes: ReadonlyArray<Node>, editorOf: "editor" | "self", asker: LinkHello = EDITOR_HELLO) => {
    const f = await runtimeWith(nodes, editorOf);
    const channel = await f.runtime.runPromise(makeInventoryChannel());
    const run: Run = (effect) => f.runtime.runPromise(effect);
    const { left } = pair({ left: asker, right: helloOf(THIS_MACHINE, "studio-installation"), leftChannel: asking(), rightChannel: channel, run });
    await left.ready;
    const snapshot = (operationId: string) => Effect.flatMap(linkClient(InventoryLink), (client) =>
      client.Snapshot(THIS_MACHINE, { canvas }, { operationId })).pipe(Effect.provideService(MachineLink, linkOver(() => left)));
    const ask = (operationId: string) => f.runtime.runPromise(snapshot(operationId));
    const refused = (operationId: string) => f.runtime.runPromise(Effect.flip(snapshot(operationId)));
    return { ...f, ask, refused, left };
  };

  it("answers the canvas editor from the cache, with this machine's name", async () => {
    const f = await answering([here], "editor");
    const snapshot = await f.ask("op-inventory-1");
    expect(snapshot.machine).toBe(THIS_MACHINE);
    expect(snapshot.harnesses.map((row) => row.harness)).toEqual(["claude", "codex"]);
    expect(f.scans).toHaveBeenCalledTimes(1);
  });

  it("refuses an unpinned peer, another canvas editor, and a canvas with no seat here, as typed failures", async () => {
    const refusal = async (nodes: ReadonlyArray<Node>, editorOf: "editor" | "self", asker?: LinkHello) => {
      const f = await answering(nodes, editorOf, asker);
      const failure = await f.refused("op-inventory-1");
      expect(f.scans).not.toHaveBeenCalled();
      // The refusal arrives as the channel's own typed failure, decoded by the contract.
      expect(Schema.is(InventoryLinkFailure)(failure)).toBe(true);
      return failure;
    };
    expect(await refusal([here], "editor", helloOf("macbook", "stranger-installation")))
      .toMatchObject({ _tag: "InventoryPeerNotPinned", operationId: "op-inventory-1" });
    expect(await refusal([here], "self")).toMatchObject({ _tag: "InventoryCanvasEditorMismatch" });
    expect(await refusal([seat("elsewhere", { host: "macbook", agentKey: "macbook:elsewhere" })], "editor"))
      .toMatchObject({ _tag: "InventoryNoSeatHere" });
  });

  it("names the canvas only: a request with any other key closes the link before admission", async () => {
    for (const payload of [{ canvas, harness: "claude" }, { canvas, command: ["claude", "--version"] }]) {
      const f = await runtimeWith([here], "editor");
      const channel = await f.runtime.runPromise(makeInventoryChannel());
      const raw = facingRaw({ self: helloOf(THIS_MACHINE, "studio-installation"), peer: EDITOR_HELLO, channel, run: (effect) => f.runtime.runPromise(effect) });
      await raw.session.ready;
      raw.send({ type: "request", id: "r1", op: "op-1", channel: "inventory", tag: "Snapshot", payload });
      expect(await raw.session.closed).toMatchObject({ by: "this-end", reason: "frame-invalid" });
      expect(f.scans).not.toHaveBeenCalled();
    }
  });

  it("refuses an event frame: the channel carries none", async () => {
    const f = await runtimeWith([], "editor");
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
  const remote = seat("on-mini", { host: PEER, agentKey: `${PEER}:on-mini` });

  /** This machine edits the canvas and asks `mini`, whose end is a real session or one written by hand. */
  const client = async () => {
    const f = await runtimeWith([remote], "self");
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
    const typedPeer = (respond: (request: { readonly canvas: string }, context: LinkChannelContext) => ReturnType<NonNullable<LinkContractChannel["handleRequest"]>>) => {
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

  it("sends the canvas and the operation id, keeps the snapshot 0600 in a 0700 directory", async () => {
    const good = wireSnapshot(local(PEER), 1_792_000_100_000).snapshot;
    const c = await client();
    const seen = c.typedPeer(() => Effect.succeed(good));
    const answer = await c.ask("op-ask-1");
    expect(seen).toEqual([{ payload: { canvas }, operationId: "op-ask-1" }]);
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
    c.typedPeer(() => Effect.fail(new InventoryNoSeatHere({ machine: PEER, message: "This canvas has no seat on this machine." })));
    const answer = await c.ask("op-refused");
    expect(!answer.ok && answer.error).toMatchObject({ failure: "InventoryNoSeatHere", reason: "failed" });
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
    const f = await runtimeWith([seat("here", { host: THIS_MACHINE, agentKey: `${THIS_MACHINE}:here` })], "editor");
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
    expect(log).toContain("canvas");
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
