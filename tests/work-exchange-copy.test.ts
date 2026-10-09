/**
 * A canvas and its mail between two real machines: each is its own state
 * engine, model, work log and machine list, wired as the app wires them, and
 * joined by an in-memory link behind the rows channel. Nothing is mocked but
 * the wire: frames cross as plain JSON through the channel's one decode.
 */
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { afterEach, describe, expect, it } from "vitest";
import { deriveActorSeatId } from "../src/main/junto/actor-seat-id";
import { MachineRepository, makeMachineRepositoryLive } from "../src/main/junto/machines/repository";
import { ModelRecords } from "../src/main/junto/model/records";
import { ModelService } from "../src/main/junto/model/service";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { makeRowsChannel, type RowsChannelContext } from "../src/main/junto/work/exchange/channel";
import { followLocalCommits, makeLiveRowExchange } from "../src/main/junto/work/exchange/live";
import type { RowExchange } from "../src/main/junto/work/exchange/session";
import { WorkRepository, WorkRepositoryLive } from "../src/main/junto/work/repository";
import { InstallationId } from "../src/shared/installation-id";
import { Command, asCanvasName, type Node } from "../src/shared/model";
import { seat, wire } from "./support/model-nodes";
import { ModelStoresLive, seedCanvas } from "./support/seed-canvas";

const id = Schema.decodeUnknownSync(InstallationId);
const MACBOOK = id("macbook-installation");
const MINI = id("mini-installation");
const at = "2026-10-09T12:00:00.000Z";
const command = Schema.decodeUnknownSync(Command);

const makeRuntime = (root: string, name: string, installation: InstallationId) =>
  ManagedRuntime.make(
    Layer.provideMerge(
      ModelStoresLive,
      Layer.provideMerge(
        Layer.mergeAll(
          WorkRepositoryLive,
          makeMachineRepositoryLive({ defaultName: () => name, makeInstallationId: () => installation }),
        ),
        makeStateEngineLive(join(root, "junto.db")),
      ),
    ),
  );

type Machine = {
  readonly name: string;
  readonly self: InstallationId;
  readonly root: string;
  readonly runtime: ReturnType<typeof makeRuntime>;
  readonly exchange: RowExchange;
  readonly channel: ReturnType<typeof makeRowsChannel>;
  readonly arrived: string[];
};

type Queued = { readonly to: Machine; readonly from: Machine; readonly payload: unknown };
const queue: Queued[] = [];
const booted: Machine[] = [];
const open = new Set<string>();

afterEach(async () => {
  queue.length = 0;
  open.clear();
  for (const machine of booted.splice(0)) {
    await machine.runtime.dispose();
    await rm(machine.root, { recursive: true, force: true });
  }
});

const boot = async (
  name: string,
  self: InstallationId,
  pins: ReadonlyArray<readonly [string, InstallationId]>,
  linkFailed?: (peer: InstallationId) => void,
): Promise<Machine> => {
  const root = join(tmpdir(), `junto-exchange-copy-${name}-${randomUUID()}`);
  const runtime = makeRuntime(root, name, self);
  const arrived: string[] = [];
  const exchange = await runtime.runPromise(
    Effect.gen(function* () {
      const machines = yield* MachineRepository;
      for (const [machineName, installationId] of pins) yield* machines.pinPeer({ machineName, installationId });
      return yield* makeLiveRowExchange({
        mailArrived: (_canvas, nodeId, message) => arrived.push(`${nodeId} ${message.messageId}`),
        ...(linkFailed === undefined ? {} : { linkFailed }),
      });
    }),
  );
  const machine: Machine = { name, self, root, runtime, exchange, channel: makeRowsChannel(exchange), arrived };
  booted.push(machine);
  return machine;
};

const contextOf = (from: Machine, to: Machine): RowsChannelContext => ({
  peer: { installationId: to.self },
  sendEvent: (_channel, payload) =>
    Effect.sync(() => {
      queue.push({ from, to, payload: JSON.parse(JSON.stringify(payload)) });
    }),
});

const link = async (left: Machine, right: Machine): Promise<void> => {
  open.add(`${left.name}>${right.name}`).add(`${right.name}>${left.name}`);
  await left.runtime.runPromise(left.channel.opened(contextOf(left, right)));
  await right.runtime.runPromise(right.channel.opened(contextOf(right, left)));
};

/** Deliver queued frames, each through the channel's decode, until none is left. */
const settle = async (): Promise<void> => {
  while (queue.length > 0) {
    const next = queue.shift()!;
    if (!open.has(`${next.from.name}>${next.to.name}`)) continue;
    const frame = next.to.channel.decodeEvent(next.payload);
    await next.to.runtime.runPromise(next.to.channel.handleEvent(contextOf(next.to, next.from), frame));
  }
};

/** Let the forked pushes of a local commit run. */
const pushed = async (): Promise<void> => {
  for (let turn = 0; turn < 20; turn += 1) await new Promise((resolve) => setTimeout(resolve, 2));
};

const place = { width: 200, height: 100 };
const region = { kind: "region", id: "remote", x: -50, y: -50, width: 900, height: 600, z: 0, hold: false, label: "Remote" } as Node;
const note = { kind: "note", id: "a-note", x: 600, y: 300, width: 100, height: 60, z: 0, text: "stays on the editing machine" } as Node;
const lead = seat("lead", { ...place, x: 0, y: 0, host: "macbook" as never, agentKey: "macbook:claude", bindingId: "binding-lead" as never });
const peer = seat("peer", { ...place, x: 300, y: 0, host: "mini" as never, agentKey: "mini:claude", bindingId: "binding-peer" as never });

/** The macbook edits `factory`: one seat of its own, one on the mini, a wire each way, a region and a note. */
const factoryOn = (macbook: Machine) =>
  macbook.runtime.runPromise(
    seedCanvas("factory", [region, lead, peer, note], [wire("lead-to-peer", "lead", "peer", "messages"), wire("peer-to-lead", "peer", "lead", "messages")]),
  );

const header = (on: Machine, canvas = "factory") =>
  on.runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql.unsafe<{ canvas_id: string; seq: number; editor: string | null }>(
        "SELECT canvas_id, seq, editor_installation_id AS editor FROM canvases WHERE canvas_name = ?",
        [canvas],
      );
      return rows[0];
    }),
  );

const nodesOn = async (on: Machine): Promise<string[]> =>
  (await on.runtime.runPromise(Effect.flatMap(ModelRecords, (records) => records.listNodes("factory")))).map((node) => `${node.kind} ${node.id}`).sort();

/** One seat mails another, on the machine the sender lives on, at the canvas count that machine holds. */
const mail = async (on: Machine, from: { id: string; bindingId: string }, to: string, messageId: string): Promise<void> => {
  const held = (await header(on))!;
  await on.runtime.runPromise(
    Effect.flatMap(WorkRepository, (repository) =>
      repository.appendMessage({
        sink: { canvasName: "factory", nodeId: to },
        basis: { kind: "canvas", canvasName: "factory", seq: held.seq },
        message: { messageId, role: "agent", parts: [{ kind: "text", text: `from ${from.id}` }] },
        sentBy: { seatId: deriveActorSeatId(on.self, from.bindingId), canvasName: "factory", nodeId: from.id },
        destination: { kind: "mailbox" },
        originAt: at,
        receivedAt: at,
      }),
    ),
  );
  await on.runtime.runPromise(on.exchange.committed("factory"));
};

const inbox = async (on: Machine, nodeId: string): Promise<string[]> =>
  (await on.runtime.runPromise(Effect.flatMap(WorkRepository, (repository) => repository.mailbox("factory", nodeId)))).map(
    (message) => message.messageId,
  );

const pair = async () => {
  const macbook = await boot("macbook", MACBOOK, [["mini", MINI]]);
  const mini = await boot("mini", MINI, [["macbook", MACBOOK]]);
  await factoryOn(macbook);
  return { macbook, mini };
};

describe("a canvas and its mail between two machines", () => {
  it("lands the copy on the other machine, then carries one row each way", async () => {
    const { macbook, mini } = await pair();
    expect(await header(mini)).toBeUndefined();
    await link(macbook, mini);
    await settle();

    // The mini holds the canvas: the same canvas, at the same count, edited on the macbook.
    const sent = (await header(macbook))!;
    expect(await header(mini)).toEqual({ canvas_id: sent.canvas_id, seq: sent.seq, editor: MACBOOK });
    // Its own seat whole, the macbook's seat as a peer, the region, and no note.
    expect(await nodesOn(mini)).toEqual(["agent peer", "peer lead", "region remote"]);
    expect(macbook.exchange.status()).toEqual([
      expect.objectContaining({ peer: MINI, copies: [{ canvasName: "factory", canvasId: sent.canvas_id, seq: sent.seq }], refused: [] }),
    ]);

    await mail(macbook, { id: "lead", bindingId: "binding-lead" }, "peer", "to-the-mini");
    await settle();
    expect(await inbox(mini, "peer")).toEqual(["to-the-mini"]);
    expect(mini.arrived).toEqual(["peer to-the-mini"]);

    await mail(mini, { id: "peer", bindingId: "binding-peer" }, "lead", "to-the-macbook");
    await settle();
    expect(await inbox(macbook, "lead")).toEqual(["to-the-macbook"]);
    expect(macbook.arrived).toEqual(["lead to-the-macbook"]);

    // Each end knows how far the other is caught up on the canvas.
    expect(macbook.exchange.status()[0]!.caughtUp.map((entry) => entry.canvasName)).toContain("factory");
    expect(mini.exchange.status()[0]!.caughtUp.map((entry) => entry.canvasName)).toContain("factory");
  });

  it("sends the canvas again when it changes, and the other machine holds the newer one", async () => {
    const { macbook, mini } = await pair();
    await link(macbook, mini);
    await settle();
    const first = (await header(mini))!.seq;

    await macbook.runtime.runPromise(
      Effect.flatMap(ModelService, (model) =>
        model.command(command({ _tag: "Move", canvas: "factory", moves: [{ id: "peer", x: 320, y: 40 }] }), "operator"),
      ),
    );
    await macbook.runtime.runPromise(macbook.exchange.committed("factory"));
    await settle();
    const now = (await header(macbook))!.seq;
    expect(now).toBeGreaterThan(first);
    expect((await header(mini))!.seq).toBe(now);

    // Mail the mini writes at the newer count is taken: the macbook sent it that count.
    await mail(mini, { id: "peer", bindingId: "binding-peer" }, "lead", "after-the-move");
    await settle();
    expect(await inbox(macbook, "lead")).toEqual(["after-the-move"]);
  });

  it("holds mail written while no link is open, and hands it over when one opens", async () => {
    const { macbook, mini } = await pair();
    await mail(macbook, { id: "lead", bindingId: "binding-lead" }, "peer", "written-before-the-link");
    expect(queue).toEqual([]);
    await link(macbook, mini);
    await settle();
    expect(await inbox(mini, "peer")).toEqual(["written-before-the-link"]);
  });
});

describe("a machine that already has a canvas of that name", () => {
  it("gives way when its own canvas never changed", async () => {
    const { macbook, mini } = await pair();
    await mini.runtime.runPromise(seedCanvas("factory", []));
    const own = (await header(mini))!;
    expect(own).toMatchObject({ seq: 0 });

    await link(macbook, mini);
    await settle();
    const sent = (await header(macbook))!;
    expect(await header(mini)).toEqual({ canvas_id: sent.canvas_id, seq: sent.seq, editor: MACBOOK });
    expect(macbook.exchange.status()[0]!.refused).toEqual([]);
  });

  it("keeps its own canvas once it changed, and the editing machine is told", async () => {
    const { macbook, mini } = await pair();
    const own = seat("mine", { ...place, x: 0, y: 0, host: "mini" as never, agentKey: "mini:claude", bindingId: "binding-mine" as never });
    await mini.runtime.runPromise(seedCanvas("factory", [own]));
    const before = await header(mini);

    await link(macbook, mini);
    await settle();
    expect(await header(mini)).toEqual(before);
    expect(await nodesOn(mini)).toEqual(["agent mine"]);
    const sent = (await header(macbook))!;
    expect(macbook.exchange.status()[0]!.refused).toEqual([
      { canvasName: "factory", canvasId: sent.canvas_id, seq: sent.seq, reason: "a-canvas-of-that-name" },
    ]);

    // Nothing of the macbook's canvas reaches the mini's own canvas of that name.
    await mail(macbook, { id: "lead", bindingId: "binding-lead" }, "peer", "for-a-canvas-the-mini-does-not-hold");
    await settle();
    expect(await inbox(mini, "peer")).toEqual([]);
    expect(await inbox(mini, "mine")).toEqual([]);
  });
});

describe("a copy no honest machine sends", () => {
  const cutFor = async (macbook: Machine) => {
    const context = contextOf(macbook, { self: MINI, name: "mini" } as Machine);
    open.add("macbook>mini");
    await macbook.runtime.runPromise(macbook.channel.opened(context));
    const copy = queue.find((queued) => (queued.payload as { kind: string }).kind === "copy")!.payload as { copy: Record<string, unknown> };
    queue.length = 0;
    return copy;
  };

  it("is refused from a machine that does not edit that canvas, and closes the exchange on that link", async () => {
    const { macbook, mini } = await pair();
    const honest = await cutFor(macbook);
    // The mini has a link to the macbook, and a third machine's copy arrives on it.
    await mini.runtime.runPromise(mini.channel.opened(contextOf(mini, macbook)));
    const forged = { kind: "copy", copy: { ...honest.copy, editor: "a-third-installation" } };
    await expect(
      mini.runtime.runPromise(mini.channel.handleEvent(contextOf(mini, macbook), mini.channel.decodeEvent(forged))),
    ).rejects.toThrow(/only the machine that edits a canvas sends its copy/u);
    expect(await header(mini)).toBeUndefined();
  });

  it("is refused when it was cut for another machine", async () => {
    const { macbook, mini } = await pair();
    const honest = await cutFor(macbook);
    await mini.runtime.runPromise(mini.channel.opened(contextOf(mini, macbook)));
    const misdirected = { kind: "copy", copy: { ...honest.copy, target: "a-third-installation" } };
    await expect(
      mini.runtime.runPromise(mini.channel.handleEvent(contextOf(mini, macbook), mini.channel.decodeEvent(misdirected))),
    ).rejects.toThrow(/a copy cut for another machine/u);
    expect(await header(mini)).toBeUndefined();
  });

  it("is refused at the channel's decode when it carries anything the copy does not have", async () => {
    const { macbook } = await pair();
    const honest = await cutFor(macbook);
    const channel = macbook.channel;
    expect(() => channel.decodeEvent({ kind: "copy", copy: { ...honest.copy, notes: [note] } })).toThrow();
    expect(() => channel.decodeEvent({ kind: "copy", copy: { ...honest.copy, seats: [{ id: "x" }] } })).toThrow();
    expect(() => channel.decodeEvent({ kind: "copy" })).toThrow();
    expect(() => channel.decodeEvent("rows")).toThrow();
    expect(() => channel.decodeRequest()).toThrow(/carries no requests/u);
    expect(() => channel.decodeResponse()).toThrow(/carries no requests/u);
  });

  it("refuses a refusal of a copy it never sent", async () => {
    const { macbook, mini } = await pair();
    await mini.runtime.runPromise(mini.channel.opened(contextOf(mini, macbook)));
    queue.length = 0;
    const unsolicited = { kind: "copy-refused", canvasName: "factory", canvasId: "any", seq: 1, reason: "a-canvas-of-that-name" };
    await expect(
      mini.runtime.runPromise(mini.channel.handleEvent(contextOf(mini, macbook), mini.channel.decodeEvent(unsolicited))),
    ).rejects.toThrow(/a copy this machine did not send/u);
  });
});

describe("a local commit", () => {
  it("is pushed without being asked: a change to the canvas, and a row written to the log", async () => {
    const { macbook, mini } = await pair();
    const stop = [
      await macbook.runtime.runPromise(followLocalCommits(macbook.exchange)),
      await mini.runtime.runPromise(followLocalCommits(mini.exchange)),
    ];
    try {
      await link(macbook, mini);
      await settle();
      const first = (await header(mini))!.seq;

      await macbook.runtime.runPromise(
        Effect.flatMap(ModelService, (model) =>
          model.command(command({ _tag: "Move", canvas: "factory", moves: [{ id: "peer", x: 340, y: 60 }] }), "operator"),
        ),
      );
      await pushed();
      await settle();
      expect((await header(mini))!.seq).toBeGreaterThan(first);

      const held = (await header(mini))!;
      await mini.runtime.runPromise(
        Effect.flatMap(WorkRepository, (repository) =>
          repository.appendMessage({
            sink: { canvasName: "factory", nodeId: "lead" },
            basis: { kind: "canvas", canvasName: "factory", seq: held.seq },
            message: { messageId: "pushed-on-commit", role: "agent", parts: [{ kind: "text", text: "from peer" }] },
            sentBy: { seatId: deriveActorSeatId(MINI, "binding-peer"), canvasName: "factory", nodeId: "peer" },
            destination: { kind: "mailbox" },
            originAt: at,
            receivedAt: at,
          }),
        ),
      );
      await pushed();
      await settle();
      expect(await inbox(macbook, "lead")).toEqual(["pushed-on-commit"]);
    } finally {
      for (const off of stop) off();
    }
  });

  it("drops a link the push fails on and says so", async () => {
    const failed: string[] = [];
    const macbook = await boot("macbook", MACBOOK, [["mini", MINI]], (peer) => failed.push(peer));
    await factoryOn(macbook);
    let up = true;
    await macbook.runtime.runPromise(
      macbook.exchange.opened({ peer: MINI, send: () => (up ? Effect.void : Effect.fail(new Error("the link is gone"))) }),
    );
    // The mini says it holds the canvas, so a commit has rows to push to it.
    const held = (await header(macbook))!;
    await macbook.runtime.runPromise(
      macbook.exchange.receive(MINI, { kind: "have", canvases: [{ canvasName: "factory", canvasId: held.canvas_id, writers: [] }] }),
    );
    expect(macbook.exchange.linked(MINI)).toBe(true);

    up = false;
    await mail(macbook, { id: "lead", bindingId: "binding-lead" }, "peer", "never-leaves");
    expect(failed).toEqual([MINI]);
    expect(macbook.exchange.linked(MINI)).toBe(false);
    // The mail is still in the log, for the next link.
    expect(await inbox(macbook, "peer")).toEqual(["never-leaves"]);
  });
});

describe("the copy and where its seats were", () => {
  it("is kept by the editing machine before it leaves, so the mini's mail is judged against it", async () => {
    const { macbook, mini } = await pair();
    await link(macbook, mini);
    const sent = (await header(macbook))!;
    const kept = await macbook.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return {
          copies: yield* sql.unsafe("SELECT canvas_name, target, seq FROM canvas_copies_sent"),
          placed: yield* sql.unsafe("SELECT node_id, machine, from_seq, until_seq FROM canvas_placements ORDER BY node_id"),
        };
      }),
    );
    // Kept although no frame has been delivered yet.
    expect(kept.copies).toEqual([{ canvas_name: "factory", target: MINI, seq: sent.seq }]);
    expect(kept.placed).toEqual([
      { node_id: "lead", machine: MACBOOK, from_seq: sent.seq, until_seq: null },
      { node_id: "peer", machine: MINI, from_seq: sent.seq, until_seq: null },
    ]);
    await settle();
    expect(asCanvasName("factory")).toBe("factory");
  });
});
