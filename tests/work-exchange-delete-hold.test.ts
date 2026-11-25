/**
 * The copy janitor's delete-hold decisions, over two real machines wired as
 * the app wires them (work-exchange-copy's rig): the editor commits, the copy
 * machine installs, and the hold the delete Stop took there is decided by
 * what the copy carries. Locked here: a copy at or below the held seq decides
 * nothing; still-here past the seq keeps the hold inside the delete lease and
 * releases after it (the dead-editor timing rule); a drop past the seq tears
 * down and releases; and a drop with no hold at all — the machine that was
 * asleep or unreachable when the Stop crossed — still finishes the seat.
 */
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MachineRepository, makeMachineRepositoryLive } from "../src/core/machines/repository";
import { makeContentServiceLive } from "../src/core/content/service";
import { makeInstallOpsLive } from "../src/core/install-ops/engine";
import { ModelRecords } from "../src/core/model/records";
import { ModelService } from "../src/core/model/service";
import { PausePlaneLive } from "../src/core/pause-plane-live";
import { FactoryPauseRepositoryLive } from "../src/core/pause/repository";
import { ReferencesRepositoryLive } from "../src/core/references/repository";
import { SeatGuidanceRepositoryLive } from "../src/core/seat-guidance/repository";
import { AgentSignalRepositoryLive } from "../src/core/signals/repository";
import { makeSettingsLive } from "../src/core/settings/service";
import { makeStateEngineLive } from "../src/core/state/engine";
import { CrewRepositoryLive } from "../src/core/work/crew-repository";
import { WorkLive } from "../src/core/work/service";
import { type RowsChannelContext } from "../src/core/work/exchange/channel";
import { rowsChannel, rowsWire } from "./support/rows-channel";
import { makeLiveRowExchange } from "../src/core/work/exchange/live";
import type { RowExchange } from "../src/core/work/exchange/session";
import { WorkRepository, WorkRepositoryLive } from "../src/core/work/repository";
import { InstallationId } from "../src/shared/installation-id";
import { Command, type Node } from "@shared/model";
import { seat, wire } from "./support/model-nodes";
import { ModelStoresLive, seedCanvas } from "./support/seed-canvas";
import { makeTestLog } from "./support/test-log";
import { termPlane } from "../src/core/term/plane";
import { DELETE_LEASE_TTL_MS } from "../src/core/term/node-delete";
import { makeMemoryTerminalNodeDeleteStore } from "../src/core/term/node-delete-store";

const id = Schema.decodeUnknownSync(InstallationId);
const MACBOOK = id("macbook-installation");
const MINI = id("mini-installation");
const command = Schema.decodeUnknownSync(Command);

const { log: exchangeLog } = makeTestLog();
const makeRuntime = (root: string, name: string, installation: InstallationId) =>
  ManagedRuntime.make(
    Layer.mergeAll(exchangeLog.loggerLayer, Layer.provideMerge(WorkLive, Layer.provideMerge(
      ModelStoresLive,
      Layer.provideMerge(
        Layer.mergeAll(
          WorkRepositoryLive,
          CrewRepositoryLive,
          makeSettingsLive(),
          makeContentServiceLive({ root: join(root, "content"), skipInlineMediaMigration: true }),
          SeatGuidanceRepositoryLive,
          AgentSignalRepositoryLive,
          ReferencesRepositoryLive,
          Layer.provideMerge(PausePlaneLive, FactoryPauseRepositoryLive),
          makeMachineRepositoryLive({ defaultName: () => name, makeInstallationId: () => installation }),
        ),
        Layer.mergeAll(makeStateEngineLive(join(root, "junto.db")), makeInstallOpsLive(join(root, "install-ops.db"))),
      ),
    ))),
  );

type Machine = {
  readonly name: string;
  readonly self: InstallationId;
  readonly root: string;
  readonly runtime: ReturnType<typeof makeRuntime>;
  readonly exchange: RowExchange;
  readonly channel: ReturnType<typeof rowsChannel>;
};

type Queued = { readonly to: Machine; readonly from: Machine; readonly payload: unknown };
const queue: Queued[] = [];
const booted: Machine[] = [];
const open = new Set<string>();

afterEach(async () => {
  vi.restoreAllMocks();
  open.clear();
  for (const machine of booted.splice(0)) {
    for (const link of machine.exchange.status()) machine.exchange.closed(link.peer);
    await machine.runtime.dispose();
    await rm(machine.root, { recursive: true, force: true });
  }
  queue.length = 0;
  // The plane singleton is shared across the process: no hold outlives a test.
  for (const held of termPlane.nodeDelete.heldDeletesFor("factory")) {
    await termPlane.nodeDelete.releaseHeldDelete(held.key);
  }
});

const boot = async (
  name: string,
  self: InstallationId,
  pins: ReadonlyArray<readonly [string, InstallationId]>,
): Promise<Machine> => {
  const root = join(tmpdir(), `junto-exchange-hold-${name}-${randomUUID()}`);
  const runtime = makeRuntime(root, name, self);
  const exchange = await runtime.runPromise(
    Effect.gen(function* () {
      const machines = yield* MachineRepository;
      yield* machines.configureName(name);
      for (const [machineName, installationId] of pins) yield* machines.pinPeer({ machineName, installationId });
      return yield* makeLiveRowExchange({ mailArrived: () => undefined });
    }),
  );
  const machine: Machine = { name, self, root, runtime, exchange, channel: rowsChannel(exchange) };
  booted.push(machine);
  return machine;
};

const contextOf = (from: Machine, to: Machine): RowsChannelContext => ({
  peer: { installationId: to.self },
  sessionId: `${from.name}-${to.name}`,
  sendEvent: (_channel, payload) =>
    Effect.sync(() => {
      queue.push({ from, to, payload: rowsWire(payload) });
    }),
});

const link = async (left: Machine, right: Machine): Promise<void> => {
  open.add(`${left.name}>${right.name}`).add(`${right.name}>${left.name}`);
  await left.runtime.runPromise(left.channel.opened(contextOf(left, right)));
  await right.runtime.runPromise(right.channel.opened(contextOf(right, left)));
  await quiet();
};

const quiet = async (): Promise<void> => {
  for (const machine of booted) await machine.runtime.runPromise(machine.exchange.quiet);
};

const settle = async (): Promise<void> => {
  for (let round = 0; round < 200; round += 1) {
    await quiet();
    if (queue.length === 0) return;
    const next = queue.shift()!;
    if (!open.has(`${next.from.name}>${next.to.name}`)) continue;
    const frame = next.to.channel.decodeEvent(next.payload);
    await next.to.runtime.runPromise(next.to.channel.handleEvent(contextOf(next.to, next.from), frame));
  }
};

const place = { width: 200, height: 100 };
const region = { kind: "region", id: "remote", x: -50, y: -50, width: 900, height: 600, z: 0, hold: false, label: "Remote" } as Node;
const lead = seat("lead", { ...place, x: 0, y: 0, host: "macbook" as never, agentKey: "macbook:claude", bindingId: "binding-lead" as never });
const peer = seat("peer", { ...place, x: 300, y: 0, host: "mini" as never, agentKey: "mini:claude", bindingId: "binding-peer" as never });

const factoryOn = (macbook: Machine) =>
  macbook.runtime.runPromise(
    seedCanvas("factory", [region, lead, peer], [wire("lead-to-peer", "lead", "peer", "messages")]),
  );

const headerSeq = (on: Machine): Promise<number | undefined> =>
  on.runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql.unsafe<{ seq: number }>(
        "SELECT seq FROM canvases WHERE canvas_name = ?", ["factory"],
      );
      return rows[0]?.seq;
    }),
  );

const departing = (on: Machine): Promise<ReadonlySet<unknown>> =>
  on.runtime.runPromise(Effect.flatMap(WorkRepository, (repository) => repository.departingFrom("factory")));

const movePeer = (on: Machine, x: number, y: number): Promise<unknown> =>
  on.runtime.runPromise(
    Effect.flatMap(ModelService, (model) =>
      model.command(command({ _tag: "Move", canvas: "factory", moves: [{ id: "peer", x, y }] }), "operator")),
  );

const reseatPeer = (on: Machine, host: string): Promise<unknown> =>
  on.runtime.runPromise(
    Effect.flatMap(ModelService, (model) =>
      model.command(
        command({ _tag: "Edit", canvas: "factory", id: "peer", change: { kind: "agent", host } }),
        "operator",
      ),
    ),
  );

const removePeer = (on: Machine): Promise<unknown> =>
  on.runtime.runPromise(
    Effect.flatMap(ModelService, (model) =>
      model.command(command({ _tag: "Remove", canvas: "factory", nodes: ["peer"], wires: [] }), "operator")),
  );

const pair = async () => {
  const macbook = await boot("macbook", MACBOOK, [["mini", MINI]]);
  const mini = await boot("mini", MINI, [["macbook", MACBOOK]]);
  await factoryOn(macbook);
  await link(macbook, mini);
  await settle();
  return { macbook, mini };
};

/** A fresh memory store behind the plane's delete service, so no core SQL is needed here. */
const memoryStore = (): void => {
  termPlane.nodeDelete.useStoreForTest(makeMemoryTerminalNodeDeleteStore());
};

const holdPeer = (editorCanvasSeq: number) =>
  termPlane.nodeDelete.holdDelete("binding-peer", "mini", {
    canvas: "factory", seatId: "peer", editorInstallationId: MACBOOK, editorCanvasSeq,
  });

describe("the copy janitor decides a held delete", () => {
  it("a copy past the held seq that still has the seat keeps the hold inside the lease, and the age rule releases it", async () => {
    memoryStore();
    const { macbook } = await pair();
    const atBegin = (await headerSeq(macbook))!;
    await holdPeer(atBegin);
    expect(termPlane.nodeDelete.heldDeletesFor("factory")).toHaveLength(1);

    // The canvas moves on past the delete's begin without dropping the seat:
    // still here never releases on its own inside the lease.
    await movePeer(macbook, 320, 40);
    await macbook.runtime.runPromise(macbook.exchange.committed("factory"));
    await settle();
    expect((await headerSeq(macbook))!).toBeGreaterThan(atBegin);
    expect(termPlane.nodeDelete.heldDeletesFor("factory")).toHaveLength(1);

    // Past the delete lease the dead-editor timing rule releases it. Only
    // Date.now moves — the rig's own timers keep real time.
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + DELETE_LEASE_TTL_MS + 1_000);
    await movePeer(macbook, 340, 60);
    await macbook.runtime.runPromise(macbook.exchange.committed("factory"));
    await settle();
    expect(termPlane.nodeDelete.heldDeletesFor("factory")).toHaveLength(0);
  });

  it("a copy past the held seq that drops the seat tears it down and releases the hold", async () => {
    memoryStore();
    const teardown = vi.spyOn(termPlane.router, "deleteBinding").mockResolvedValue({ kind: "clean" });
    const { macbook, mini } = await pair();
    const atBegin = (await headerSeq(macbook))!;
    await holdPeer(atBegin);

    await removePeer(macbook);
    await macbook.runtime.runPromise(macbook.exchange.committed("factory"));
    await settle();

    expect(teardown).toHaveBeenCalledWith("binding-peer");
    expect(termPlane.nodeDelete.heldDeletesFor("factory")).toHaveLength(0);
    // The departure copy reached the machine that lost its only seat: it
    // stands at the delete's count, and its departing window is closed.
    expect(await headerSeq(mini)).toBe(await headerSeq(macbook));
    expect([...await departing(macbook)]).not.toContain(MINI);
  });

  it("a copy at the held seq decides nothing, even one that drops the seat", async () => {
    memoryStore();
    const teardown = vi.spyOn(termPlane.router, "deleteBinding").mockResolvedValue({ kind: "clean" });
    const { macbook } = await pair();

    // The editor commits the delete; the hold a retry took names the seq the
    // delete copy itself carries, so that copy decides nothing.
    await removePeer(macbook);
    const deleteCopySeq = (await headerSeq(macbook))!;
    await macbook.runtime.runPromise(macbook.exchange.committed("factory"));
    await holdPeer(deleteCopySeq);
    await settle();

    expect(teardown).not.toHaveBeenCalled();
    expect(termPlane.nodeDelete.heldDeletesFor("factory")).toHaveLength(1);
  });

  it("a copy that drops a seat whose binding lives here finishes it, hold or no hold", async () => {
    memoryStore();
    const teardown = vi.spyOn(termPlane.router, "deleteBinding").mockResolvedValue({ kind: "clean" });
    const { macbook, mini } = await pair();
    // No hold at all: the machine was asleep or unreachable when the Stop crossed.
    expect(termPlane.nodeDelete.heldDeletesFor("factory")).toHaveLength(0);

    await removePeer(macbook);
    await macbook.runtime.runPromise(macbook.exchange.committed("factory"));
    await settle();

    expect(teardown).toHaveBeenCalledWith("binding-peer");
    expect(await headerSeq(mini)).toBe(await headerSeq(macbook));
    expect([...await departing(macbook)]).not.toContain(MINI);
  });


  it("a copy that moves the seat away finishes it here exactly as a drop does", async () => {
    memoryStore();
    const teardown = vi.spyOn(termPlane.router, "deleteBinding").mockResolvedValue({ kind: "clean" });
    const { macbook, mini } = await pair();
    const atBegin = (await headerSeq(macbook))!;
    await holdPeer(atBegin);

    // The seat is not gone from the canvas: it moved to the editor. On mini
    // it is every bit as dropped, and the finish is the same one.
    await reseatPeer(macbook, "macbook");
    await macbook.runtime.runPromise(macbook.exchange.committed("factory"));
    await settle();

    expect(teardown).toHaveBeenCalledWith("binding-peer");
    expect(termPlane.nodeDelete.heldDeletesFor("factory")).toHaveLength(0);
    expect(await headerSeq(mini)).toBe(await headerSeq(macbook));
  });

  it("a finish whose teardown is not clean keeps the hold for the next copy", async () => {
    memoryStore();
    const teardown = vi.spyOn(termPlane.router, "deleteBinding").mockResolvedValue({ kind: "unproven", reason: "unreachable" });
    const { macbook, mini } = await pair();
    const atBegin = (await headerSeq(macbook))!;
    await holdPeer(atBegin);

    await removePeer(macbook);
    await macbook.runtime.runPromise(macbook.exchange.committed("factory"));
    await settle();

    // The teardown was tried and could not prove itself: nothing released,
    // the seat session stays open, and the copy still installed.
    expect(teardown).toHaveBeenCalledWith("binding-peer");
    expect(termPlane.nodeDelete.heldDeletesFor("factory")).toHaveLength(1);
    expect(await headerSeq(mini)).toBe(await headerSeq(macbook));
  });

  it("a finish that errors releases nothing, and the copy still installs", async () => {
    memoryStore();
    const teardown = vi.spyOn(termPlane.router, "deleteBinding").mockRejectedValue(new Error("router down"));
    const { macbook, mini } = await pair();
    const atBegin = (await headerSeq(macbook))!;
    await holdPeer(atBegin);

    await removePeer(macbook);
    await macbook.runtime.runPromise(macbook.exchange.committed("factory"));
    await settle();

    // The error is contained in the finish: the hold survives for the next
    // copy, and the copy itself was never refused — the machine stands at
    // the delete's count.
    expect(teardown).toHaveBeenCalledWith("binding-peer");
    expect(termPlane.nodeDelete.heldDeletesFor("factory")).toHaveLength(1);
    expect(await headerSeq(mini)).toBe(await headerSeq(macbook));
  });

  it("a machine that keeps one seat and loses another finishes only the lost one", async () => {
    memoryStore();
    const teardown = vi.spyOn(termPlane.router, "deleteBinding").mockResolvedValue({ kind: "clean" });
    const macbook = await boot("macbook", MACBOOK, [["mini", MINI]]);
    const mini = await boot("mini", MINI, [["macbook", MACBOOK]]);
    const peer2 = seat("peer2", { ...place, x: 300, y: 200, host: "mini" as never, agentKey: "mini:claude", bindingId: "binding-peer2" as never });
    await macbook.runtime.runPromise(
      seedCanvas("factory", [region, lead, peer, peer2], [wire("lead-to-peer", "lead", "peer", "messages")]),
    );
    await link(macbook, mini);
    await settle();
    expect(await headerSeq(mini)).toBe(await headerSeq(macbook));

    await removePeer(macbook);
    await macbook.runtime.runPromise(macbook.exchange.committed("factory"));
    await settle();

    // The copy is an ordinary cut one — peer2 still lives there — and the
    // janitor finishes only the dropped seat.
    expect(teardown).toHaveBeenCalledWith("binding-peer");
    expect(teardown).not.toHaveBeenCalledWith("binding-peer2");
    expect(teardown).toHaveBeenCalledTimes(1);
    expect(await headerSeq(mini)).toBe(await headerSeq(macbook));
    // Still seated, the machine got an ordinary contentful copy, not a
    // departure copy: the seat it keeps stands on it whole.
    const miniNodes = await mini.runtime.runPromise(Effect.flatMap(ModelRecords, (records) => records.listNodes("factory")));
    expect(miniNodes.some((node) => node.kind === "agent" && node.id === "peer2")).toBe(true);
    expect(miniNodes.some((node) => node.id === "peer")).toBe(false);
  });

  it("a have that outruns the departure copy closes nothing; the seat tears down once the copy goes", async () => {
    memoryStore();
    const teardown = vi.spyOn(termPlane.router, "deleteBinding").mockResolvedValue({ kind: "clean" });
    const { macbook, mini } = await pair();

    await removePeer(macbook);
    await macbook.runtime.runPromise(macbook.exchange.committed("factory"));

    // Pump only non-copy frames: the mini's have reaches the macbook first.
    // That have proves the mini holds rows, never that the copy went — so the
    // window must stay open and nothing tears down yet.
    for (let guard = 0; guard < 200; guard += 1) {
      await quiet();
      const index = queue.findIndex((queued) => {
        if (!open.has(`${queued.from.name}>${queued.to.name}`)) return false;
        const frame = queued.to.channel.decodeEvent(queued.payload) as { kind?: string };
        return frame.kind !== "copy";
      });
      if (index < 0) break;
      const next = queue.splice(index, 1)[0]!;
      const frame = next.to.channel.decodeEvent(next.payload);
      await next.to.runtime.runPromise(next.to.channel.handleEvent(contextOf(next.to, next.from), frame));
    }
    await quiet();
    expect(teardown).not.toHaveBeenCalled();
    expect([...await departing(macbook)]).toContain(MINI);

    // Now the departure copy goes: the seat is torn down, and the mini leaves
    // the departing set only after it.
    await settle();
    expect(teardown).toHaveBeenCalledWith("binding-peer");
    expect([...await departing(macbook)]).not.toContain(MINI);
  });

  it("two seats lost in two edits: haves after the first copy close nothing, and the second tears down before the window closes", async () => {
    memoryStore();
    const teardown = vi.spyOn(termPlane.router, "deleteBinding").mockResolvedValue({ kind: "clean" });
    const macbook = await boot("macbook", MACBOOK, [["mini", MINI]]);
    const mini = await boot("mini", MINI, [["macbook", MACBOOK]]);
    const peer2 = seat("peer2", { ...place, x: 300, y: 200, host: "mini" as never, agentKey: "mini:claude", bindingId: "binding-peer2" as never });
    await macbook.runtime.runPromise(
      seedCanvas("factory", [region, lead, peer, peer2], [wire("lead-to-peer", "lead", "peer", "messages")]),
    );
    await link(macbook, mini);
    await settle();

    // First edit: peer goes. Its departure copy goes out and the mark is set.
    await removePeer(macbook);
    await macbook.runtime.runPromise(macbook.exchange.committed("factory"));
    await settle();
    expect(teardown).toHaveBeenCalledWith("binding-peer");

    // Second edit: peer2 goes. Hold back every copy frame and deliver only
    // haves: the first copy's mark must not close the second seat's open row.
    await macbook.runtime.runPromise(
      Effect.flatMap(ModelService, (model) =>
        model.command(command({ _tag: "Remove", canvas: "factory", nodes: ["peer2"], wires: [] }), "operator")),
    );
    await macbook.runtime.runPromise(macbook.exchange.committed("factory"));
    for (let guard = 0; guard < 200; guard += 1) {
      await quiet();
      const index = queue.findIndex((queued) => {
        if (!open.has(`${queued.from.name}>${queued.to.name}`)) return false;
        const frame = queued.to.channel.decodeEvent(queued.payload) as { kind?: string };
        return frame.kind !== "copy";
      });
      if (index < 0) break;
      const next = queue.splice(index, 1)[0]!;
      const frame = next.to.channel.decodeEvent(next.payload);
      await next.to.runtime.runPromise(next.to.channel.handleEvent(contextOf(next.to, next.from), frame));
    }
    await quiet();
    expect(teardown).not.toHaveBeenCalledWith("binding-peer2");
    expect([...await departing(macbook)]).toContain(MINI);

    // The second copy goes: the second seat tears down, and only then does
    // the machine leave the departing set.
    await settle();
    expect(teardown).toHaveBeenCalledWith("binding-peer2");
    expect([...await departing(macbook)]).not.toContain(MINI);
  });
});

