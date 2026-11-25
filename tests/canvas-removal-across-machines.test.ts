/**
 * A canvas removed on the machine that edits it, end to end between real
 * machines (0.12.1, remote-security terms 1 to 5): every machine that was
 * sent a copy is owed the removal until it takes it, and drops the copy whole,
 * Files root included, and stops the seats it placed through the delete
 * path. Only the recorded editor removes a copy; a removed canvas id never
 * comes back; a hold an earlier build left behind a removed canvas settles.
 */
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AutomationRunnerLive, AutomationRunnerService } from "../src/core/automation/live";
import { noBoatWakeLayer } from "./support/no-boat";
import { AutomationRepository, makeAutomationRepositoryLive } from "../src/core/automation/repository";
import { submitAutomationCommand } from "../src/core/automation/ruler";
import { makeContentServiceLive } from "../src/core/content/service";
import { makeInstallOpsLive } from "../src/core/install-ops/engine";
import { MachineRepository, makeMachineRepositoryLive } from "../src/core/machines/repository";
import { PausePlaneLive } from "../src/core/pause-plane-live";
import { FactoryPauseRepositoryLive } from "../src/core/pause/repository";
import { ReferencesRepositoryLive } from "../src/core/references/repository";
import { SeatGuidanceRepositoryLive } from "../src/core/seat-guidance/repository";
import { AgentSignalRepositoryLive } from "../src/core/signals/repository";
import { makeSettingsLive } from "../src/core/settings/service";
import { makeStateEngineLive } from "../src/core/state/engine";
import { CrewRepositoryLive } from "../src/core/work/crew-repository";
import type { RowsChannelContext } from "../src/core/work/exchange/channel";
import { rowsChannel, rowsWire } from "./support/rows-channel";
import { makeLiveRowExchange } from "../src/core/work/exchange/live";
import type { RowExchange } from "../src/core/work/exchange/session";
import { WorkRepository, WorkRepositoryLive } from "../src/core/work/repository";
import { makeResourceSubmitLayer } from "../src/core/work/resource-submit";
import { RulingRecorderLive } from "../src/core/work/ruling-recorder";
import { TaskRepository, TaskRepositoryLive } from "../src/core/work/task-repository";
import { ArtifactRepositoryLive } from "../src/core/work/artifact-repository";
import { ResourceRuler, ResourceRulerLive } from "../src/core/work/resource-ruler";
import { ModelService } from "../src/core/model/service";
import { WorkLive, WorkService } from "../src/core/work/service";
import type { AutomationEnv } from "../src/shared/automation-domain";
import { InstallationId } from "../src/shared/installation-id";
import { Command } from "../src/shared/model";
import { asNodeId } from "../src/shared/physics/schema";
import type { ResourceCommand } from "../src/shared/resource-command";
import { files, seat } from "./support/model-nodes";
import { ModelStoresLive, seedCanvas } from "./support/seed-canvas";
import { termPlane } from "../src/core/term/plane";
import { makeMemoryTerminalNodeDeleteStore } from "../src/core/term/node-delete-store";
import type { CanvasCopy } from "../src/shared/canvas-copy";
import { CANVAS_REMOVED_EARLIER_FILL_SQL } from "../src/core/work/exchange/state-schema";
import { makeMachineExchangeQuery } from "../src/core/work/exchange/queries";
import { COPY_REFUSED_REMOVED_WORDS } from "../src/shared/work-exchange";
import { SqlClient as Sql } from "effect/sql";
import { makeTestLog } from "./support/test-log";

const testLog = makeTestLog();

const id = Schema.decodeUnknownSync(InstallationId);
const MACBOOK = id("macbook-installation");
const MINI = id("mini-installation");
const STUDIO = id("studio-installation");
const command = Schema.decodeUnknownSync(Command);

const makeRuntime = (root: string, name: string, installation: InstallationId) => {
  const stores = Layer.provideMerge(
    Layer.mergeAll(WorkLive, makeAutomationRepositoryLive(), RulingRecorderLive),
    Layer.provideMerge(
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
    ),
  );
  // The runner over the task ruler and the submit path that queues a write off the editing machine,
  // and the ruler of queued commands, as the editing machine runs it.
  const rulers = Layer.provideMerge(Layer.mergeAll(TaskRepositoryLive, ArtifactRepositoryLive, makeResourceSubmitLayer(() => true)), stores);
  return ManagedRuntime.make(Layer.mergeAll(Layer.provideMerge(Layer.provideMerge(Layer.mergeAll(AutomationRunnerLive, ResourceRulerLive), noBoatWakeLayer), rulers), testLog.log.loggerLayer));
};

type Machine = {
  readonly name: string;
  readonly self: InstallationId;
  readonly root: string;
  readonly runtime: ReturnType<typeof makeRuntime>;
  readonly exchange: RowExchange;
  readonly channel: ReturnType<typeof rowsChannel>;
};

const queue: Array<{ readonly from: Machine; readonly to: Machine; readonly payload: unknown }> = [];
/** Every copy any machine sent, as it was sent. */
const copiesSent: Array<CanvasCopy> = [];
/** Every frame any machine sent, by sender, receiver and kind. */
const framesSent: Array<{ readonly from: string; readonly to: string; readonly kind: string }> = [];
const booted: Machine[] = [];

afterEach(async () => {
  for (const machine of booted.splice(0)) {
    for (const link of machine.exchange.status()) machine.exchange.closed(link.peer);
    await machine.runtime.dispose();
    await rm(machine.root, { recursive: true, force: true });
  }
  queue.length = 0;
  copiesSent.length = 0;
  framesSent.length = 0;
  vi.restoreAllMocks();
});

const boot = async (name: string, self: InstallationId, ...pins: ReadonlyArray<readonly [string, InstallationId]>): Promise<Machine> => {
  const root = join(tmpdir(), `junto-canvas-removal-${name}-${randomUUID()}`);
  const runtime = makeRuntime(root, name, self);
  const exchange = await runtime.runPromise(
    Effect.gen(function* () {
      const machines = yield* MachineRepository;
      yield* machines.configureName(name);
      for (const pin of pins) yield* machines.pinPeer({ machineName: pin[0], installationId: pin[1] });
      return yield* makeLiveRowExchange({ mailArrived: () => {} });
    }),
  );
  const machine: Machine = { name, self, root, runtime, exchange, channel: rowsChannel(exchange) };
  booted.push(machine);
  return machine;
};

/** The machine's core restarts on the same state: everything it held in memory is gone. */
const restart = async (machine: Machine, pin: readonly [string, InstallationId]): Promise<Machine> => {
  for (const link of machine.exchange.status()) machine.exchange.closed(link.peer);
  for (const other of booted) if (other !== machine) other.exchange.closed(machine.self);
  await machine.runtime.dispose();
  booted.splice(booted.indexOf(machine), 1);
  const runtime = makeRuntime(machine.root, machine.name, machine.self);
  const exchange = await runtime.runPromise(
    Effect.gen(function* () {
      const machines = yield* MachineRepository;
      yield* machines.configureName(machine.name);
      yield* machines.pinPeer({ machineName: pin[0], installationId: pin[1] });
      return yield* makeLiveRowExchange({ mailArrived: () => {} });
    }),
  );
  const next: Machine = { ...machine, runtime, exchange, channel: rowsChannel(exchange) };
  booted.push(next);
  return next;
};

const contextOf = (from: Machine, to: Machine): RowsChannelContext => ({
  peer: { installationId: to.self },
  sessionId: `${from.name}-${to.name}`,
  sendEvent: (_channel, payload) =>
    Effect.sync(() => {
      if (payload.kind === "copy") copiesSent.push(payload.copy);
      framesSent.push({ from: from.name, to: to.name, kind: payload.kind });
      queue.push({ from, to, payload: rowsWire(payload) });
    }),
});

const quiet = async (): Promise<void> => {
  for (const machine of booted) await machine.runtime.runPromise(machine.exchange.quiet);
};

/** Deliver frames until none is left; a refused frame is kept as the error it was refused with. */
const settle = async (): Promise<unknown> => {
  let refusal: unknown;
  for (await quiet(); queue.length > 0; await quiet()) {
    const next = queue.shift()!;
    if (!next.to.exchange.linked(next.from.self)) continue;
    const frame = next.to.channel.decodeEvent(next.payload);
    await next.to.runtime
      .runPromise(next.to.channel.handleEvent(contextOf(next.to, next.from), frame))
      .catch((error: unknown) => {
        refusal = error;
      });
  }
  return refusal;
};

const link = async (left: Machine, right: Machine): Promise<unknown> => {
  await left.runtime.runPromise(left.channel.opened(contextOf(left, right)));
  await right.runtime.runPromise(right.channel.opened(contextOf(right, left)));
  return settle();
};


const flags = vi.hoisted(() => ({ remote: true }));
vi.mock("@shared/features", async (original) => {
  const real = await original<typeof import("../src/shared/features")>();
  return {
    ...real,
    get FILES_REMOTE_ENABLED() { return flags.remote; },
    productNodeKindEnabled: (kind: string) => kind === "files" || real.productNodeKindEnabled(kind as never),
  };
});


const ROOT = "/Users/mini/Projects/secret-folder";
const operator = (on: Machine, raw: unknown) =>
  on.runtime.runPromise(Effect.flatMap(ModelService, (model) => model.command(command(raw), "operator")));
const canvasesOn = (on: Machine) => on.runtime.runPromise(Effect.flatMap(ModelService, (model) => model.listCanvases()));
const rows = (on: Machine, query: string) =>
  on.runtime.runPromise(Effect.flatMap(Sql.SqlClient, (sql) => sql.unsafe<Record<string, unknown>>(query)));
/** The editor removes the canvas, as the window or an overseer does, and its links are told. */
const remove = async (on: Machine) => {
  await operator(on, { _tag: "RemoveCanvas", canvas: "factory" });
  await on.runtime.runPromise(on.exchange.removed("factory"));
  return settle();
};
const unlink = (left: Machine, right: Machine) => {
  left.exchange.closed(right.self);
  right.exchange.closed(left.self);
  queue.length = 0;
};

/** Every binding torn down on this process, in order; each answers clean unless told otherwise. */
const teardowns = (answers: Array<"clean" | "unproven"> = []) => {
  const torn: string[] = [];
  vi.spyOn(termPlane.router, "deleteBinding").mockImplementation(async (bindingId: string) => {
    torn.push(bindingId);
    const answer = answers.shift() ?? "clean";
    return (answer === "clean" ? { kind: "clean" } : { kind: "unproven", reason: "unreachable" }) as never;
  });
  return torn;
};

const heldOn = (machine: string) => termPlane.nodeDelete.allHeldDeletes().filter((held) => held.hostId === machine);
const releaseAllHolds = async () => {
  for (const held of termPlane.nodeDelete.allHeldDeletes()) await termPlane.nodeDelete.releaseHeldDelete(held.key);
};
afterEach(releaseAllHolds);
beforeEach(() => termPlane.nodeDelete.useStoreForTest(makeMemoryTerminalNodeDeleteStore()));

/** The macbook edits a canvas whose folder is on the mini; the mini has a seat there too when `seated`. */
const stage = async (seated: boolean) => {
  const macbook = await boot("macbook", MACBOOK, ["mini", MINI]);
  const mini = await boot("mini", MINI, ["macbook", MACBOOK], ["studio", STUDIO]);
  const lead = seat("lead", { x: 0, y: 0, width: 200, height: 100, host: "macbook" as never, agentKey: "macbook:claude", bindingId: "binding-lead" as never });
  const peer = seat("peer", { x: 0, y: 300, width: 200, height: 100, host: "mini" as never, agentKey: "mini:claude", bindingId: "binding-peer" as never });
  await macbook.runtime.runPromise(seedCanvas("factory", [lead, ...(seated ? [peer] : []), files("folder", { x: 400, y: 0, host: "mini" as never, root: ROOT })]));
  await link(macbook, mini);
  expect(await canvasesOn(mini)).toEqual(["factory"]);
  return { macbook, mini };
};

describe("a canvas removed on its editor reaches every machine that held a copy (0.12.1)", () => {
  it("a seated machine drops the copy whole and its seat goes through the delete path", async () => {
    const torn = teardowns();
    const { macbook, mini } = await stage(true);
    const [{ canvas_id: canvasId }] = await rows(macbook, "SELECT canvas_id FROM canvases WHERE canvas_name = 'factory'") as Array<{ canvas_id: string }>;
    expect(await remove(macbook)).toBeUndefined();
    expect(await canvasesOn(mini)).toEqual([]);
    expect(torn).toEqual(["binding-peer"]);
    expect(heldOn("mini")).toEqual([]);
    expect(await rows(mini, "SELECT canvas_name, canvas_id, editor FROM canvas_removed")).toEqual([
      { canvas_name: "factory", canvas_id: canvasId, editor: MACBOOK },
    ]);
    // Taken, so owed no more; and no history of the canvas is left on the editor.
    expect(await rows(macbook, "SELECT * FROM canvas_removals_owed")).toEqual([]);
    for (const table of ["canvas_copies_sent", "canvas_placements", "canvas_files_carried"]) {
      expect(await rows(macbook, `SELECT * FROM ${table} WHERE canvas_name = 'factory'`)).toEqual([]);
    }
  });

  it("a machine with only a Files node there drops the copy and the root with it", async () => {
    teardowns();
    const { macbook, mini } = await stage(false);
    expect(await rows(macbook, "SELECT target FROM canvas_files_carried")).toEqual([{ target: MINI }]);
    await remove(macbook);
    expect(await canvasesOn(mini)).toEqual([]);
    expect(JSON.stringify(await rows(mini, "SELECT * FROM file_trees"))).not.toContain(ROOT);
    expect(await rows(macbook, "SELECT * FROM canvas_removals_owed")).toEqual([]);
  });

  it("is owed while the link is down, through an editor restart, and finishes on the next link", async () => {
    const torn = teardowns();
    const staged = await stage(true);
    unlink(staged.macbook, staged.mini);
    await operator(staged.macbook, { _tag: "RemoveCanvas", canvas: "factory" });
    expect(await rows(staged.macbook, "SELECT target FROM canvas_removals_owed")).toEqual([{ target: MINI }]);
    const macbook = await restart(staged.macbook, ["mini", MINI]);
    expect(await canvasesOn(staged.mini)).toEqual(["factory"]);
    await link(macbook, staged.mini);
    expect(await canvasesOn(staged.mini)).toEqual([]);
    expect(torn).toEqual(["binding-peer"]);
    expect(await rows(macbook, "SELECT * FROM canvas_removals_owed")).toEqual([]);
  });

  it("refuses a removal from a machine that is not the canvas's editor, and keeps the copy and the link", async () => {
    const torn = teardowns();
    const { mini } = await stage(true);
    const studio = await boot("studio", STUDIO, ["mini", MINI]);
    await link(studio, mini);
    const [{ canvas_id: canvasId }] = await rows(mini, "SELECT canvas_id FROM canvases WHERE canvas_name = 'factory'") as Array<{ canvas_id: string }>;
    const forged = mini.channel.decodeEvent(rowsWire({ kind: "canvas-removed", canvasName: "factory" as never, canvasId }));
    await mini.runtime.runPromise(mini.channel.handleEvent(contextOf(mini, studio), forged));
    await settle();
    expect(await canvasesOn(mini)).toEqual(["factory"]);
    expect(torn).toEqual([]);
    expect(heldOn("mini")).toEqual([]);
    expect(await rows(mini, "SELECT * FROM canvas_removed")).toEqual([]);
    expect(mini.exchange.linked(STUDIO)).toBe(true);
  });

  it("never takes back the removed canvas from an old copy, and takes a new canvas made under the name", async () => {
    teardowns();
    const { macbook, mini } = await stage(true);
    const old = copiesSent.find((copy) => copy.target === MINI)!;
    await remove(macbook);
    expect(await mini.runtime.runPromise(mini.exchange.installCopy(old))).toEqual({ refused: "removed" });
    expect(await canvasesOn(mini)).toEqual([]);
    const peer = seat("peer", { x: 0, y: 300, width: 200, height: 100, host: "mini" as never, agentKey: "mini:claude", bindingId: "binding-peer-2" as never });
    await macbook.runtime.runPromise(seedCanvas("factory", [peer]));
    await macbook.runtime.runPromise(macbook.exchange.committed("factory"));
    await settle();
    expect(await canvasesOn(mini)).toEqual(["factory"]);
    const [{ canvas_id: now }] = await rows(mini, "SELECT canvas_id FROM canvases WHERE canvas_name = 'factory'") as Array<{ canvas_id: string }>;
    expect(now).not.toBe(old.canvasId);
  });

  it("takes a canvas of the removed one's name from another editor: the removal is that editor's own", async () => {
    teardowns();
    const { macbook, mini } = await stage(true);
    const [{ canvas_id: removedId }] = await rows(macbook, "SELECT canvas_id FROM canvases WHERE canvas_name = 'factory'") as Array<{ canvas_id: string }>;
    await remove(macbook);
    const studio = await boot("studio", STUDIO, ["mini", MINI]);
    await studio.runtime.runPromise(seedCanvas("factory", [files("folder", { x: 400, y: 0, host: "mini" as never, root: ROOT })]));
    // Its id sorts older than the removed one's: only the macbook's own ids are judged against that removal.
    const older = `0${removedId.slice(1, 25)}0`;
    await rows(studio, `UPDATE canvases SET canvas_id = '${older}' WHERE canvas_name = 'factory'`);
    await link(studio, mini);
    await studio.runtime.runPromise(studio.exchange.committed("factory"));
    await settle();
    expect(await canvasesOn(mini)).toEqual(["factory"]);
    expect(await rows(mini, "SELECT editor_installation_id AS editor FROM canvases WHERE canvas_name = 'factory'")).toEqual([{ editor: STUDIO }]);
    expect(await rows(mini, "SELECT editor FROM canvas_removed")).toEqual([{ editor: MACBOOK }]);
  });

  it("finishes the hold an earlier build left after an overseer removed the canvas", async () => {
    const torn = teardowns();
    const { macbook, mini } = await stage(true);
    // The earlier build: the overseer's delete stopped the mini's seat and left a hold there,
    // the removal kept the copy history by name and owed nobody anything.
    await termPlane.nodeDelete.holdDelete("binding-peer", "mini", { canvas: "factory", seatId: "peer", editorInstallationId: MACBOOK, editorCanvasSeq: 1 });
    const history = await rows(macbook, "SELECT canvas_name, target, seq, sent_at FROM canvas_copies_sent") as Array<{ canvas_name: string; target: string; seq: number; sent_at: string }>;
    unlink(macbook, mini);
    await operator(macbook, { _tag: "RemoveCanvas", canvas: "factory" });
    await rows(macbook, "DELETE FROM canvas_removals_owed");
    for (const row of history) {
      await rows(macbook, `INSERT INTO canvas_copies_sent(canvas_name, target, seq, sent_at) VALUES ('${row.canvas_name}', '${row.target}', ${row.seq}, '${row.sent_at}')`);
    }
    // Then state step 83 records once what that build left, as it does on upgrade.
    await rows(macbook, CANVAS_REMOVED_EARLIER_FILL_SQL);
    expect(await rows(macbook, "SELECT canvas_name, target FROM canvas_removed_earlier")).toEqual([{ canvas_name: "factory", target: MINI }]);
    expect(heldOn("mini")).toHaveLength(1);
    await link(macbook, mini);
    expect(await canvasesOn(mini)).toEqual([]);
    expect(torn).toEqual(["binding-peer"]);
    expect(heldOn("mini")).toEqual([]);
    expect(await rows(macbook, "SELECT * FROM canvas_removed_earlier")).toEqual([]);
  });

  it("sends no removal from the copy history alone, as after an editor handoff (remote-security LOW 1)", async () => {
    const torn = teardowns();
    const { macbook, mini } = await stage(true);
    // The macbook sent the mini a copy, then holds the canvas no more, with no
    // removal of its own on record: as when another machine took over the
    // editing and the macbook let its copy go. The mini's copy may be live
    // under the new editor, so the history alone sends it nothing.
    const history = await rows(macbook, "SELECT canvas_name, target, seq, sent_at FROM canvas_copies_sent") as Array<{ canvas_name: string; target: string; seq: number; sent_at: string }>;
    unlink(macbook, mini);
    await operator(macbook, { _tag: "RemoveCanvas", canvas: "factory" });
    await rows(macbook, "DELETE FROM canvas_removals_owed");
    for (const row of history) {
      await rows(macbook, `INSERT INTO canvas_copies_sent(canvas_name, target, seq, sent_at) VALUES ('${row.canvas_name}', '${row.target}', ${row.seq}, '${row.sent_at}')`);
    }
    await link(macbook, mini);
    expect(framesSent.filter((frame) => frame.kind === "canvas-removed")).toEqual([]);
    expect(await canvasesOn(mini)).toEqual(["factory"]);
    expect(torn).toEqual([]);
  });

  it("answers a removal it refuses, so the sender owes it no more and sends it on no later have (remote-security LOW 2)", async () => {
    teardowns();
    const { mini } = await stage(true);
    const studio = await boot("studio", STUDIO, ["mini", MINI]);
    const [{ canvas_id: canvasId }] = await rows(mini, "SELECT canvas_id FROM canvases WHERE canvas_name = 'factory'") as Array<{ canvas_id: string }>;
    // The studio believes it owes the mini this removal, and that an earlier build removed it too.
    await rows(studio, `INSERT INTO canvas_removals_owed (canvas_name, canvas_id, target, removed_at) VALUES ('factory', '${canvasId}', '${MINI}', '2026-11-25T00:00:00.000Z')`);
    await rows(studio, `INSERT INTO canvas_removed_earlier (canvas_name, target) VALUES ('factory', '${MINI}')`);
    await link(studio, mini);
    expect(framesSent.filter((frame) => frame.kind === "canvas-removal-refused")).toEqual([{ from: "mini", to: "studio", kind: "canvas-removal-refused" }]);
    expect(await rows(studio, "SELECT * FROM canvas_removals_owed")).toEqual([]);
    expect(await rows(studio, "SELECT * FROM canvas_removed_earlier")).toEqual([]);
    const sent = framesSent.filter((frame) => frame.kind === "canvas-removed").length;
    // Another have on this link, and a new link: nothing is sent again.
    await mini.runtime.runPromise(mini.exchange.committed("factory"));
    await settle();
    unlink(studio, mini);
    await link(studio, mini);
    expect(framesSent.filter((frame) => frame.kind === "canvas-removed")).toHaveLength(sent);
    expect(await canvasesOn(mini)).toEqual(["factory"]);
    expect(studio.exchange.linked(MINI)).toBe(true);
  });

  it("puts the operator's words on a copy that machine refuses as removed", async () => {
    teardowns();
    const { macbook, mini } = await stage(true);
    const [{ canvas_id: oldId }] = await rows(macbook, "SELECT canvas_id FROM canvases WHERE canvas_name = 'factory'") as Array<{ canvas_id: string }>;
    await remove(macbook);
    // A canvas made later under the name, carrying an id the mini counts as older, as after a clock that went back.
    await macbook.runtime.runPromise(seedCanvas("factory", [files("folder", { x: 400, y: 0, host: "mini" as never, root: ROOT })]));
    const older = `0${oldId.slice(1, 25)}0`;
    expect(older < oldId).toBe(true);
    await rows(macbook, `UPDATE canvases SET canvas_id = '${older}' WHERE canvas_name = 'factory'`);
    await macbook.runtime.runPromise(macbook.exchange.committed("factory"));
    await settle();
    expect(await canvasesOn(mini)).toEqual([]);
    const query = await macbook.runtime.runPromise(makeMachineExchangeQuery(macbook.exchange));
    const data = await macbook.runtime.runPromise(query({ canvas: "factory" as never }));
    expect(data.canvases[0]!.links.find((row) => row.installationId === MINI)?.refused).toEqual({
      reason: "removed", message: COPY_REFUSED_REMOVED_WORDS, ownWords: true,
    });
  });

  it("keeps a hold whose teardown is not proven, and finishes it on the next link", async () => {
    const torn = teardowns(["unproven"]);
    const { macbook, mini } = await stage(true);
    await remove(macbook);
    expect(await canvasesOn(mini)).toEqual([]);
    expect(heldOn("mini")).toHaveLength(1);
    unlink(macbook, mini);
    await link(macbook, mini);
    await mini.runtime.runPromise(mini.exchange.quiet);
    await vi.waitFor(() => expect(heldOn("mini")).toEqual([]));
    expect(torn).toEqual(["binding-peer", "binding-peer"]);
  });
});
