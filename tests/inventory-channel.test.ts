import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeError } from "../src/main/junto/failure-encode";
import { HostsService } from "../src/main/junto/hosts/service";
import { makeInventoryChannel } from "../src/main/junto/inventory/channel";
import { makePeerInventoryClient } from "../src/main/junto/inventory/client";
import { makePeerInventoryCache } from "../src/main/junto/inventory/peer-cache";
import {
  decodeLinkInventorySnapshot,
  InventoryLinkFailure,
  InventoryNoSeatHere,
  InventoryNotFromItsMachine,
  wireSnapshot,
} from "../src/main/junto/inventory/wire";
import { LinkUnavailable, MachineLink } from "../src/main/junto/link/service";
import { type LinkChannelContext, LinkRequestFailed } from "../src/main/junto/link/types";
import { MachineRepository, makeMachineRepositoryLive } from "../src/main/junto/machines/repository";
import { ModelService } from "../src/main/junto/model/service";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { closeMachineLog, installMachineLog, ObservabilityLoggerLive } from "../src/main/junto/observability/logger";
import { machineLogDir } from "../src/main/junto/observability/log-file";
import { HarnessInventory } from "../src/main/junto/term/templates/harness-inventory";
import { WorkRepositoryLive } from "../src/main/junto/work/repository";
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
  const runtime = ManagedRuntime.make(Layer.mergeAll(inventoryLayer, Layer.provideMerge(ModelStoresLive, repositories)));
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

const context: LinkChannelContext = {
  peer: { build: "same-build", installationId: editor, machineName: "macbook" },
  keyBound: false,
  sessionId: "admitted-link",
  operationId: "op-inventory-1",
  signal: new AbortController().signal,
  sendEvent: () => Effect.void,
  close: () => Effect.void,
  request: () => Effect.die("the inventory answer sends no requests"),
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

describe("inventory channel answer", () => {
  const here = seat("mini-seat", { host: THIS_MACHINE, agentKey: `${THIS_MACHINE}:mini-seat` });

  it("answers the canvas editor from the cache, with this machine's name", async () => {
    const f = await runtimeWith([here], "editor");
    const channel = await f.runtime.runPromise(makeInventoryChannel());
    const answer = await f.runtime.runPromise(channel.handleRequest!(context, { canvas }));
    const snapshot = decodeLinkInventorySnapshot(answer);
    expect(snapshot.machine).toBe(THIS_MACHINE);
    expect(snapshot.harnesses.map((row) => row.harness)).toEqual(["claude", "codex"]);
    expect(f.scans).toHaveBeenCalledTimes(1);
  });

  it("names the canvas only: any other key is refused before admission", async () => {
    const f = await runtimeWith([here], "editor");
    const channel = await f.runtime.runPromise(makeInventoryChannel());
    expect(() => channel.decodeRequest({ canvas, harness: "claude" })).toThrow();
    expect(() => channel.decodeRequest({ canvas, command: ["claude", "--version"] })).toThrow();
    expect(() => channel.decodeEvent({})).toThrow();
    expect(channel.decodeResponse({ anything: true })).toEqual({ anything: true });
  });

  it("refuses an unpinned peer, another canvas editor, and a canvas with no seat here, as typed failures", async () => {
    const run = async (nodes: ReadonlyArray<Node>, editorOf: "editor" | "self", caller = context) => {
      const f = await runtimeWith(nodes, editorOf);
      const channel = await f.runtime.runPromise(makeInventoryChannel());
      const exit = await f.runtime.runPromise(Effect.flip(channel.handleRequest!(caller, { canvas })));
      // Every failure crosses under the channel's closed failure schema.
      expect(Schema.decodeUnknownSync(InventoryLinkFailure)(Schema.encodeSync(InventoryLinkFailure)(exit as never))).toBeTruthy();
      expect(f.scans).not.toHaveBeenCalled();
      return exit as { readonly _tag: string; readonly operationId?: string };
    };
    const stranger = { ...context, peer: { ...context.peer, installationId: installation("stranger-installation") } };
    expect(await run([here], "editor", stranger)).toMatchObject({ _tag: "InventoryPeerNotPinned", operationId: "op-inventory-1" });
    expect(await run([here], "self")).toMatchObject({ _tag: "InventoryCanvasEditorMismatch" });
    expect(await run([seat("elsewhere", { host: "macbook", agentKey: "macbook:elsewhere" })], "editor"))
      .toMatchObject({ _tag: "InventoryNoSeatHere" });
    const closed = new AbortController();
    closed.abort();
    expect(await run([here], "editor", { ...context, signal: closed.signal }))
      .toMatchObject({ _tag: "InventoryLinkClosed", operationId: "op-inventory-1" });
  });
});

describe("inventory channel request", () => {
  const remote = seat("on-mini", { host: PEER, agentKey: `${PEER}:on-mini` });

  const client = async (respond: (payload: unknown, operationId: string | undefined) => Effect.Effect<unknown, unknown>) => {
    const f = await runtimeWith([remote], "self");
    const dir = join(f.root, "peer-inventory");
    const host = Schema.decodeUnknownSync(RemoteHost)({
      id: PEER, label: "Mini", isThisMachine: false, sshEndpoint: "mini", capabilities: ["terminal"],
    });
    const request = vi.fn((_machine: string, _channel: string, payload: unknown, options?: { readonly operationId?: string }) =>
      respond(payload, options?.operationId));
    const unused = Effect.die("unused machine operation");
    const links = MachineLink.of({
      setChannels: () => unused, listen: () => unused,
      connect: () => Effect.succeed({ machineName: PEER, installationId: editor, boundAt: "2026-10-17" }),
      connectSetup: () => unused, disconnect: () => unused, peerBuild: () => unused,
      sendEvent: () => unused, request: request as never,
    });
    const hosts = HostsService.of({
      get: () => Effect.succeed(host), list: unused, doctor: unused, doctorSnapshot: unused,
      upsert: () => unused, remove: () => unused, test: () => unused,
    } as never);
    const peer = makePeerInventoryClient(makePeerInventoryCache(dir));
    const ask = (operationId: string) => f.runtime.runPromise(peer.inventoryOf(PEER, operationId).pipe(
      Effect.provideService(HostsService, hosts), Effect.provideService(MachineLink, links),
      Effect.provide(ObservabilityLoggerLive),
    ));
    return { ask, request, dir };
  };

  it("sends the canvas and the operation id, keeps the snapshot 0600 in a 0700 directory", async () => {
    const good = wireSnapshot(local(PEER), 1_792_000_100_000).snapshot;
    const c = await client(() => Effect.succeed(JSON.parse(JSON.stringify(good))));
    const answer = await c.ask("op-ask-1");
    expect(c.request).toHaveBeenCalledWith(PEER, "inventory", { canvas }, { operationId: "op-ask-1" });
    expect(answer.ok && answer.inventory.harnesses[0]!.models.map((model) => model.id))
      .toEqual(["opus[1m]", "openrouter/~anthropic/claude-opus-latest", "grok-4.7"]);
    expect((await stat(c.dir)).mode & 0o777).toBe(0o700);
    expect((await stat(join(c.dir, `${PEER}.json`))).mode & 0o777).toBe(0o600);
  });

  it("refuses a bad snapshot or one from another machine as one typed failure, and shows the last good one", async () => {
    const good = wireSnapshot(local(PEER), 1_792_000_100_000).snapshot;
    let next: unknown = good;
    const c = await client(() => Effect.succeed(next));
    expect((await c.ask("op-good")).ok).toBe(true);

    next = { ...good, harnesses: [{ ...good.harnesses[0]!, executable: "/bin/claude" }] };
    const refused = await c.ask("op-bad");
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error).toMatchObject({ failure: "InventorySnapshotRefused", reason: "failed", operationId: "op-bad" });
    expect(refused.error.last?.inventory.machine).toBe(PEER);

    next = { ...good, machine: "studio" };
    const foreign = await c.ask("op-foreign");
    expect(!foreign.ok && foreign.error).toMatchObject({ failure: "InventoryNotFromItsMachine", operationId: "op-foreign" });
  });

  it("shows the last snapshot, its age and the typed link failure when the machine cannot be reached", async () => {
    const good = wireSnapshot(local(PEER), 1_792_000_100_000).snapshot;
    let reachable = true;
    const c = await client(() => reachable
      ? Effect.succeed(good)
      : Effect.fail(new LinkUnavailable({ machine: PEER, reason: "not-linked", message: "mini is asleep" })));
    await c.ask("op-1");
    reachable = false;
    const answer = await c.ask("op-2");
    expect(answer.ok).toBe(false);
    if (answer.ok) return;
    expect(answer.error).toMatchObject({ reason: "unreachable", failure: "LinkUnavailable", operationId: "op-2" });
    expect(answer.error.last?.receivedAt).toBeGreaterThan(0);
  });

  it("carries the answering machine's typed refusal through the link", async () => {
    const c = await client((_payload, operationId) => {
      const cause = new InventoryNoSeatHere({ machine: PEER, message: "This canvas has no seat on this machine." });
      return Effect.fail(new LinkRequestFailed({
        machine: PEER, channel: "inventory", operationId: operationId ?? "minted",
        failure: encodeError(cause, { machine: PEER, operationId: operationId ?? "minted" }), detail: cause, message: cause.message,
      }));
    });
    const answer = await c.ask("op-refused");
    expect(!answer.ok && answer.error).toMatchObject({ failure: "InventoryNoSeatHere", reason: "failed" });
  });

  it("never shows a stored file that fails the closed decode", async () => {
    const c = await client(() => Effect.fail(new LinkUnavailable({ machine: PEER, reason: "not-linked", message: "down" })));
    await mkdir(c.dir, { recursive: true });
    await writeFile(join(c.dir, `${PEER}.json`), JSON.stringify({ version: 1, receivedAt: 1, snapshot: { machine: PEER, takenAt: 1, harnesses: [], extra: "<script>" } }));
    const answer = await c.ask("op-1");
    expect(!answer.ok && answer.error.last).toBeUndefined();
    expect(await readFile(join(c.dir, `${PEER}.json`), "utf8")).toContain("<script>");
  });

  it("logs and answers a decode failure as its path, never the value it saw, at both ends", async () => {
    const home = await mkdtemp(join(tmpdir(), "junto-inventory-log-"));
    cleanups.push(async () => { closeMachineLog(); await rm(home, { recursive: true, force: true }); });
    installMachineLog({ home, process: "core", echo: false });
    const secret = "SECRETVALUE7f3k2";

    const f = await runtimeWith([seat("here", { host: THIS_MACHINE, agentKey: `${THIS_MACHINE}:here` })], "editor");
    const channel = await f.runtime.runPromise(makeInventoryChannel());
    await f.runtime.runPromise(Effect.flip(channel.handleRequest!(context, { canvas: `<${secret}>` })).pipe(Effect.provide(ObservabilityLoggerLive)));

    const good = wireSnapshot(local(PEER), 2).snapshot;
    const bad = { ...good, harnesses: [{ ...good.harnesses[0]!, models: [{ id: "opus", label: `<${secret}>` }] }] };
    const c = await client(() => Effect.succeed(bad));
    const answer = await c.ask("op-secret");
    expect(!answer.ok && answer.error.message).toContain("label");
    expect(JSON.stringify(answer)).not.toContain(secret);

    const log = readFileSync(join(machineLogDir(home), "core.jsonl"), "utf8");
    expect(log).toContain("inventory failed");
    expect(log).toContain("peer inventory failed");
    expect(log).toContain("canvas");
    expect(log).not.toContain(secret);
  });

  it("refuses an event frame with a tagged refusal", async () => {
    const f = await runtimeWith([], "editor");
    const channel = await f.runtime.runPromise(makeInventoryChannel());
    expect(() => channel.decodeEvent({})).toThrow(expect.objectContaining({ _tag: "InventoryEventRefused" }));
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
