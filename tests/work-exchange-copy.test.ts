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
import { makeContentServiceLive } from "../src/main/junto/content/service";
import { makeInstallOpsLive } from "../src/main/junto/install-ops/engine";
import { ModelActorRefs } from "../src/main/junto/model/actor-refs";
import { ModelRecords } from "../src/main/junto/model/records";
import { ModelService } from "../src/main/junto/model/service";
import { PausePlane, PausePlaneLive } from "../src/main/junto/pause-plane";
import { FactoryPauseRepository, FactoryPauseRepositoryLive } from "../src/main/junto/pause/repository";
import { ReferencesRepository, ReferencesRepositoryLive } from "../src/main/junto/references/repository";
import { onboardReferenceFields } from "../src/main/junto/references/seat-reads";
import { SeatGuidanceRepository, SeatGuidanceRepositoryLive } from "../src/main/junto/seat-guidance/repository";
import { AgentSignalRepository, AgentSignalRepositoryLive } from "../src/main/junto/signals/repository";
import { makeSettingsLive } from "../src/main/junto/settings/service";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { CrewRepositoryLive } from "../src/main/junto/work/crew-repository";
import { WorkLive, WorkService } from "../src/main/junto/work/service";
import { makeRowsChannel, type RowsChannelContext } from "../src/main/junto/work/exchange/channel";
import { followLocalCommits, makeLiveRowExchange } from "../src/main/junto/work/exchange/live";
import type { RowExchange } from "../src/main/junto/work/exchange/session";
import { MessageDeliveryService } from "../src/main/junto/work/message-delivery";
import { makeMessageDeliveryStore } from "../src/main/junto/work/message-delivery-store";
import { unjournaledWorkMutationEffect } from "../src/main/junto/work/mutation-seam";
import { WorkRepository, WorkRepositoryLive } from "../src/main/junto/work/repository";
import { InstallationId } from "../src/shared/installation-id";
import type { CanvasCopy } from "../src/shared/canvas-copy";
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
    Layer.provideMerge(WorkLive, Layer.provideMerge(
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
    )),
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
  open.clear();
  for (const machine of booted.splice(0)) {
    // A link's worker stops with its link, never left sending past its test.
    for (const link of machine.exchange.status()) machine.exchange.closed(link.peer);
    await machine.runtime.dispose();
    await rm(machine.root, { recursive: true, force: true });
  }
  queue.length = 0;
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
      yield* machines.configureName(name);
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
  sessionId: `${from.name}-${to.name}`,
  sendEvent: (_channel, payload) =>
    Effect.sync(() => {
      queue.push({ from, to, payload: JSON.parse(JSON.stringify(payload)) });
    }),
});

const link = async (left: Machine, right: Machine): Promise<void> => {
  open.add(`${left.name}>${right.name}`).add(`${right.name}>${left.name}`);
  await left.runtime.runPromise(left.channel.opened(contextOf(left, right)));
  await right.runtime.runPromise(right.channel.opened(contextOf(right, left)));
  await quiet();
};

/** Deliver queued frames, each through the channel's decode, until none is left. */
const quiet = async (): Promise<void> => {
  for (const machine of booted) await machine.runtime.runPromise(machine.exchange.quiet);
};

const settle = async (): Promise<void> => {
  for (await quiet(); queue.length > 0; await quiet()) {
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
  await quiet();
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
    expect(await macbook.runtime.runPromise(macbook.exchange.routed("factory", "peer"))).toBe(false);
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
    await quiet();
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
    expect(() => channel.decodeEvent({ kind: "copy", copy: { ...honest.copy, notes: ["not a note"] } })).toThrow();
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
    await quiet();
    expect(macbook.exchange.linked(MINI)).toBe(true);

    up = false;
    await mail(macbook, { id: "lead", bindingId: "binding-lead" }, "peer", "never-leaves");
    expect(failed).toEqual([MINI]);
    expect(macbook.exchange.linked(MINI)).toBe(false);
    // The mail is still in the log, for the next link.
    expect(await inbox(macbook, "peer")).toEqual(["never-leaves"]);
  });
});

/** `junto msg send` as the work service runs it: the seat's own identity, the canvas as its machine holds it. */
const send = (on: Machine, from: string, to: string, messageId: string) =>
  on.runtime.runPromise(
    Effect.gen(function* () {
      const work = yield* WorkService;
      const sender = (yield* (yield* ModelActorRefs).read("factory")).find((actor) => actor.nodeId === from);
      if (sender === undefined) throw new Error(`no seat at ${from}`);
      return yield* work.workMessageAppend(
        "factory",
        to,
        null,
        { messageId, role: "user", parts: [{ kind: "text", text: `from ${from}` }] },
        sender,
      );
    }),
  );

describe("mail a seat sends from the machine it lives on", () => {
  it("goes to a peer from a copy, and comes back the other way", async () => {
    const { macbook, mini } = await pair();
    const stop = [
      await macbook.runtime.runPromise(followLocalCommits(macbook.exchange)),
      await mini.runtime.runPromise(followLocalCommits(mini.exchange)),
    ];
    try {
      await link(macbook, mini);
      await settle();

      // Each end has an open link its mail for the other leaves on; mail for its own seat leaves on none.
      const routed = (on: Machine, nodeId: string) => on.runtime.runPromise(on.exchange.routed("factory", nodeId));
      expect([await routed(mini, "lead"), await routed(macbook, "peer")]).toEqual([true, true]);
      expect([await routed(mini, "peer"), await routed(macbook, "lead")]).toEqual([false, false]);

      // The seat on the mini mails the macbook's seat, a peer on the mini's copy.
      expect(await send(mini, "peer", "lead", "from-the-mini")).toMatchObject({ ok: true });
      await pushed();
      await settle();
      expect(await inbox(macbook, "lead")).toEqual(["from-the-mini"]);
      expect(macbook.arrived).toEqual(["lead from-the-mini"]);

      expect(await send(macbook, "lead", "peer", "from-the-macbook")).toMatchObject({ ok: true });
      await pushed();
      await settle();
      expect(await inbox(mini, "peer")).toEqual(["from-the-macbook"]);
      expect(mini.arrived).toEqual(["peer from-the-macbook"]);
    } finally {
      for (const off of stop) off();
    }
  });
});

describe("delivery on a machine with no window", () => {
  it("types arriving mail into its seat with a receipt, and tells its own seat its mail was handed on", async () => {
    const { macbook, mini } = await pair();
    await link(macbook, mini);
    await settle();
    const typed: string[] = [];
    const delivery = new MessageDeliveryService(() => "mini");
    delivery.configure({
      store: await mini.runtime.runPromise(makeMessageDeliveryStore),
      transport: {
        seatLive: (bindingId) => bindingId === "binding-peer",
        wakeSeat: async () => true,
        writeMail: async (bindingId, text) => {
          typed.push(`${bindingId}: ${text}`);
          return "written";
        },
      },
    });
    delivery.followLinks((canvas, nodeId) => mini.runtime.runPromise(mini.exchange.routed(canvas, nodeId)));
    try {
      await send(macbook, "lead", "peer", "typed-on-the-mini");
      await macbook.runtime.runPromise(macbook.exchange.committed("factory"));
      await settle();
      expect(await delivery.deliver("factory", "peer", "typed-on-the-mini")).toBe("delivered");
      expect(typed).toHaveLength(1);
      expect(typed[0]).toContain("binding-peer: ");
      const stamped = await mini.runtime.runPromise(
        Effect.flatMap(WorkRepository, (repository) => repository.mailMessage("factory", "peer", "typed-on-the-mini")),
      );
      expect(stamped?.metadata?.deliveredAt).toBeDefined();

      await send(mini, "peer", "lead", "handed-on");
      expect(await delivery.deliver("factory", "lead", "handed-on")).toBe("handed");
      open.clear();
      mini.exchange.closed(MACBOOK);
      await send(mini, "peer", "lead", "held-here");
      expect(await delivery.deliver("factory", "lead", "held-here")).toBe("held");
    } finally {
      delivery.suspend();
    }
  });
});

describe("a seat's signal to the operator", () => {
  const signals = <A>(on: Machine, use: (store: AgentSignalRepository["Service"]) => Effect.Effect<A, unknown>) =>
    on.runtime.runPromise(Effect.flatMap(AgentSignalRepository, use));
  /** The operator's feed for the canvas, as the window lists it. */
  const feed = async (on: Machine) =>
    (await signals(on, (store) => store.listCanvas("factory"))).map(
      (signal) => `${signal.nodeId} ${signal.kind} ${signal.state} ${signal.text}${signal.response === undefined ? "" : ` > ${signal.response.text}`}`,
    );
  const following = async (machines: ReadonlyArray<Machine>) => {
    const stops = await Promise.all(machines.map((machine) => machine.runtime.runPromise(followLocalCommits(machine.exchange))));
    return () => stops.forEach((stop) => stop());
  };

  it("raised with no link open reaches the editing machine when one opens, and the answer comes back", async () => {
    const { macbook, mini } = await pair();
    const stop = await following([macbook, mini]);
    try {
      // The mini holds the canvas, then the macbook goes away.
      await link(macbook, mini);
      await settle();
      open.clear();
      macbook.exchange.closed(MINI);
      mini.exchange.closed(MACBOOK);

      const raised = await signals(mini, (store) =>
        store.raise({ canvasName: "factory", nodeId: "peer", kind: "blocked", text: "Need a key.", detail: "Which one?" }),
      );
      await pushed();
      await settle();
      expect(await feed(macbook)).toEqual([]);

      await link(macbook, mini);
      await settle();
      expect(await feed(macbook)).toEqual(["peer blocked open Need a key."]);
      expect((await signals(macbook, (store) => store.get(raised.signalId))).detail).toBe("Which one?");

      await signals(macbook, (store) => store.answer(raised.signalId, "Use the staging key."));
      await pushed();
      await settle();
      expect(await feed(mini)).toEqual(["peer blocked answered Need a key. > Use the staging key."]);
      // Stated twice changes nothing.
      await link(macbook, mini);
      await settle();
      expect(await feed(macbook)).toEqual(["peer blocked answered Need a key. > Use the staging key."]);
      expect(await feed(mini)).toEqual(["peer blocked answered Need a key. > Use the staging key."]);
    } finally {
      stop();
    }
  });

  it("is pushed while a link is open: a raise, its withdrawal, and a dismissal", async () => {
    const { macbook, mini } = await pair();
    const stop = await following([macbook, mini]);
    try {
      await link(macbook, mini);
      await settle();
      const first = await signals(mini, (store) => store.raise({ canvasName: "factory", nodeId: "peer", kind: "feedback", text: "Ready." }));
      await pushed();
      await settle();
      expect(await feed(macbook)).toEqual(["peer feedback open Ready."]);

      await signals(mini, (store) => store.withdraw({ canvasName: "factory", nodeId: "peer" }, first.signalId));
      await pushed();
      await settle();
      expect(await feed(macbook)).toEqual(["peer feedback withdrawn Ready."]);

      const second = await signals(mini, (store) => store.raise({ canvasName: "factory", nodeId: "peer", kind: "escalate", text: "Look." }));
      await pushed();
      await settle();
      await signals(macbook, (store) => store.dismiss(second.signalId));
      await pushed();
      await settle();
      expect((await feed(mini)).sort()).toEqual(["peer escalate dismissed Look.", "peer feedback withdrawn Ready."]);
      // The editing machine's own seat's signal goes nowhere.
      await signals(macbook, (store) => store.raise({ canvasName: "factory", nodeId: "lead", kind: "feedback", text: "Mine." }));
      await pushed();
      await settle();
      expect((await feed(mini)).some((line) => line.startsWith("lead"))).toBe(false);
    } finally {
      stop();
    }
  });

  it("closes the link when stated by a machine that may not: a raise for another machine's seat, an answer from the seat's machine", async () => {
    const signal = { signalId: "forged", nodeId: "lead", kind: "blocked", text: "Not mine to raise.", createdAt: 1 };
    {
      const { macbook, mini } = await pair();
      await link(macbook, mini);
      await settle();
      const sent = (await header(macbook))!;
      const frame = { kind: "signals", canvasName: "factory", canvasId: sent.canvas_id, signals: [signal] };
      await expect(
        macbook.runtime.runPromise(macbook.channel.handleEvent(contextOf(macbook, mini), macbook.channel.decodeEvent(frame))),
      ).rejects.toThrow();
      expect(await feed(macbook)).toEqual([]);
    }
    {
      const { macbook, mini } = await pair();
      await link(macbook, mini);
      await settle();
      const sent = (await header(macbook))!;
      const answered = {
        ...signal,
        nodeId: "peer",
        closing: { state: "answered", closedAt: 2, response: { text: "I answer myself.", at: 2 } },
      };
      const frame = { kind: "signals", canvasName: "factory", canvasId: sent.canvas_id, signals: [answered] };
      await expect(
        macbook.runtime.runPromise(macbook.channel.handleEvent(contextOf(macbook, mini), macbook.channel.decodeEvent(frame))),
      ).rejects.toThrow();
      expect(await feed(macbook)).toEqual([]);
    }
  });
});

describe("what a seat needs to onboard", () => {
  const remote = { kind: "region" as const, canvasName: "factory", regionId: "remote" };
  const app = { kind: "app" as const };

  /** What the seat's own machine would answer it at onboard. */
  const onboard = (on: Machine, nodeId: string) =>
    on.runtime.runPromise(
      Effect.gen(function* () {
        const guidance = yield* SeatGuidanceRepository;
        const pause = yield* PausePlane;
        return {
          guidance: yield* guidance.get(nodeId),
          ...(yield* onboardReferenceFields({ canvasName: "factory", nodeId })),
          playing: pause.stateFor("factory").playing,
        };
      }),
    );
  const texts = <A>(on: Machine, use: (store: ReferencesRepository["Service"]) => Effect.Effect<A, unknown>) =>
    on.runtime.runPromise(Effect.flatMap(ReferencesRepository, use));
  const guide = (on: Machine, nodeId: string, guidance: unknown) =>
    on.runtime.runPromise(Effect.flatMap(SeatGuidanceRepository, (store) => store.set(nodeId, guidance)));
  const play = (on: Machine, playing: boolean) =>
    on.runtime.runPromise(Effect.flatMap(PausePlane, (pause) => pause.setPlaying("factory", playing)));

  it("rides the copy: its guidance, the briefing, the references in its scope, and play", async () => {
    const { macbook, mini } = await pair();
    await guide(macbook, "peer", { soul: "Careful.", instructions: "Run the suite first." });
    await guide(macbook, "lead", { instructions: "Only the macbook's seat reads this." });
    await texts(macbook, (store) => store.briefingWrite("One canvas, many machines.", "operator"));
    await texts(macbook, (store) => store.write(app, { name: "glossary", description: "Words", body: "A seat." }, "operator"));
    await texts(macbook, (store) => store.write(remote, { name: "contract", body: "docs/machines.md" }, "operator"));
    await play(macbook, true);
    await link(macbook, mini);
    await settle();

    expect(await onboard(mini, "peer")).toEqual({
      guidance: { soul: "Careful.", instructions: "Run the suite first." },
      briefing: "One canvas, many machines.",
      references: [
        expect.objectContaining({ name: "glossary", scope: "app", description: "Words" }),
        expect.objectContaining({ name: "contract", scope: "region" }),
      ],
      playing: true,
    });
    // The other machine's seat is a peer there: none of its guidance came along.
    expect((await onboard(mini, "lead")).guidance).toBeNull();
  });

  it("follows the editing machine without the canvas changing: pause, guidance, a reference taken away", async () => {
    const { macbook, mini } = await pair();
    await guide(macbook, "peer", { instructions: "First." });
    await texts(macbook, (store) => store.write(remote, { name: "contract", body: "old" }, "operator"));
    await play(macbook, true);
    const stop = await macbook.runtime.runPromise(followLocalCommits(macbook.exchange));
    try {
      await link(macbook, mini);
      await settle();
      const count = (await header(mini))!.seq;
      expect((await onboard(mini, "peer")).playing).toBe(true);

      await play(macbook, false);
      await guide(macbook, "peer", { instructions: "Second." });
      await texts(macbook, (store) => store.remove(remote, "contract"));
      await texts(macbook, (store) => store.write(remote, { name: "plan", body: "new" }, "operator"));
      await pushed();
      await settle();

      expect((await header(mini))!.seq).toBe(count);
      const now = await onboard(mini, "peer");
      expect(now.playing).toBe(false);
      expect(now.guidance).toEqual({ instructions: "Second." });
      expect(now.references?.map((reference) => reference.name)).toEqual(["plan"]);

      await guide(macbook, "peer", null);
      await pushed();
      await settle();
      expect((await onboard(mini, "peer")).guidance).toBeNull();
    } finally {
      stop();
    }
  });

  it("is known as a copy to the machine that took it, so a restart there keeps the play state it was sent", async () => {
    const { macbook, mini } = await pair();
    await link(macbook, mini);
    await settle();
    const copies = (on: Machine) =>
      on.runtime.runPromise(Effect.flatMap(FactoryPauseRepository, (repository) => repository.copies));
    expect([...(await copies(mini))]).toEqual(["factory"]);
    expect([...(await copies(macbook))]).toEqual([]);
  });

  it("does not send the same copy twice, and leaves this machine's own briefing when the copy has none", async () => {
    const { macbook, mini } = await pair();
    await texts(mini, (store) => store.briefingWrite("The mini's own.", "operator"));
    await texts(mini, (store) => store.write(app, { name: "local", body: "kept" }, "operator"));
    await link(macbook, mini);
    await settle();
    await macbook.runtime.runPromise(macbook.exchange.committed("factory"));
    expect(queue.filter((frame) => (frame.payload as { kind?: string }).kind === "copy")).toEqual([]);
    const held = await onboard(mini, "peer");
    expect(held.briefing).toBe("The mini's own.");
    expect(held.references?.map((reference) => reference.name)).toEqual(["local"]);
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

describe("mail held for a seat that moves to another machine", () => {
  const helper = seat("helper", { ...place, x: 0, y: 200, host: "macbook" as never, agentKey: "macbook:claude", bindingId: "binding-helper" as never });

  /** The macbook's `lead` mails its own `helper` while the mini is linked: none of it is the mini's. */
  const held = async () => {
    const macbook = await boot("macbook", MACBOOK, [["mini", MINI]]);
    const mini = await boot("mini", MINI, [["macbook", MACBOOK]]);
    await macbook.runtime.runPromise(seedCanvas("factory", [lead, peer, helper]));
    await link(macbook, mini);
    await settle();
    // More than one frame of it, so the mini is told through past a whole page.
    const sent = Array.from({ length: 70 }, (_, index) => `held-${index}`);
    for (const messageId of sent) {
      await mail(macbook, { id: "lead", bindingId: "binding-lead" }, "helper", messageId);
      await settle();
    }
    expect(await inbox(mini, "helper")).toEqual([]);
    return { macbook, mini, sent };
  };

  const moveHelper = (macbook: Machine) =>
    macbook.runtime.runPromise(
      Effect.flatMap(ModelService, (model) =>
        model.command(command({ _tag: "Edit", canvas: "factory", id: "helper", change: { kind: "agent", host: "mini" } }), "operator"),
      ),
    );

  it("reaches the seat's new machine when it moves while the link is open", async () => {
    const { macbook, mini, sent } = await held();
    await moveHelper(macbook);
    await macbook.runtime.runPromise(macbook.exchange.committed("factory"));
    await settle();
    expect((await inbox(mini, "helper")).sort()).toEqual([...sent].sort());
  });

  it("reaches the seat's new machine when it moves while no link is open", async () => {
    const { macbook, mini, sent } = await held();
    open.clear();
    macbook.exchange.closed(MINI);
    mini.exchange.closed(MACBOOK);
    await moveHelper(macbook);
    await link(macbook, mini);
    await settle();
    expect((await inbox(mini, "helper")).sort()).toEqual([...sent].sort());
  });
});

describe("a seat that moves while its copy is cut", () => {
  const helper = seat("helper", { ...place, x: 0, y: 200, host: "macbook" as never, agentKey: "macbook:claude", bindingId: "binding-helper" as never });

  it("is sent where it stood at the count the copy states, never where the move put it", async () => {
    const mini = await boot("mini", MINI, [["macbook", MACBOOK]]);
    // The macbook's exchange reads its nodes through a hook that starts the move mid-cut, outside the cut's fiber.
    const root = join(tmpdir(), `junto-exchange-copy-macbook-${randomUUID()}`);
    const runtime = makeRuntime(root, "macbook", MACBOOK);
    let move: Promise<unknown> | undefined;
    let armed = false;
    const moveHelper = Effect.flatMap(ModelService, (model) =>
      model.command(command({ _tag: "Edit", canvas: "factory", id: "helper", change: { kind: "agent", host: "mini" } }), "operator"),
    );
    const exchange = await runtime.runPromise(
      Effect.gen(function* () {
        const machines = yield* MachineRepository;
        yield* machines.configureName("macbook");
        yield* machines.pinPeer({ machineName: "mini", installationId: MINI });
        const records = yield* ModelRecords;
        const hooked = {
          ...records,
          listNodes: (canvas: string) =>
            Effect.gen(function* () {
              if (move === undefined && armed) {
                move = runtime.runPromise(moveHelper);
                // Room for the move to commit, were nothing holding it back.
                yield* Effect.sleep("40 millis");
              }
              return yield* records.listNodes(canvas);
            }),
        } as typeof records;
        return yield* makeLiveRowExchange({ mailArrived: () => {} }).pipe(Effect.provideService(ModelRecords, hooked));
      }),
    );
    const macbook: Machine = { name: "macbook", self: MACBOOK, root, runtime, exchange, channel: makeRowsChannel(exchange), arrived: [] };
    booted.push(macbook);
    await runtime.runPromise(seedCanvas("factory", [lead, peer, helper]));
    const before = (await header(macbook))!.seq;
    armed = true;
    await link(macbook, mini);
    expect(move).toBeDefined();
    await move;
    armed = false;
    await macbook.runtime.runPromise(macbook.exchange.committed("factory"));
    await settle();

    const placed = await macbook.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return yield* sql.unsafe("SELECT machine, from_seq, until_seq FROM canvas_placements WHERE node_id = 'helper' ORDER BY from_seq");
      }),
    );
    const after = (await header(macbook))!.seq;
    expect(after).toBeGreaterThan(before);
    // On the macbook at the count first sent, on the mini from the count the move made.
    expect(placed).toEqual([
      { machine: MACBOOK, from_seq: before, until_seq: after },
      { machine: MINI, from_seq: after, until_seq: null },
    ]);
  });
});

describe("a canvas kept whole on a listed machine", () => {
  const helper = seat("helper", { ...place, x: 0, y: 200, host: "macbook" as never, agentKey: "macbook:claude", bindingId: "binding-helper" as never });
  const keptNote = { kind: "note", id: "kept-note", x: 700, y: 100, width: 100, height: 60, z: 0, text: "only a keeper holds this" } as Node;

  /** Replace a canvas's committed authority list on one machine (0.11/06 F3). */
  const authorities = (on: Machine, members: ReadonlyArray<InstallationId>) =>
    on.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT OR IGNORE INTO canvas_consensus (canvas_name, current_term, commit_index, applied_index) VALUES ('factory', 1, 0, 0)`;
        yield* sql`DELETE FROM canvas_authorities WHERE canvas_name = 'factory'`;
        for (const [position, member] of members.entries()) {
          yield* sql`INSERT INTO canvas_authorities (canvas_name, position, installation_id) VALUES ('factory', ${position}, ${member})`;
        }
      }),
    );

  /** Move the count so the next exchange pass sends a fresh copy. */
  const bump = (macbook: Machine) =>
    macbook.runtime
      .runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`UPDATE canvases SET seq = seq + 1 WHERE canvas_name = 'factory'`;
        }),
      )
      .then(() => macbook.runtime.runPromise(macbook.exchange.committed("factory")));

  const cursors = (on: Machine) =>
    on.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return yield* sql.unsafe("SELECT writer, through FROM work_exchange_cursors WHERE canvas_name = 'factory'");
      }),
    );

  it("installs whole once the admitted copy's list names it, keeps the canvas's cursors, and prunes foreign mail after a delist", async () => {
    const macbook = await boot("macbook", MACBOOK, [["mini", MINI]]);
    const mini = await boot("mini", MINI, [["macbook", MACBOOK]]);
    await macbook.runtime.runPromise(
      seedCanvas("factory", [region, lead, peer, helper, keptNote], [wire("lead-to-peer", "lead", "peer", "messages")]),
    );
    await link(macbook, mini);
    await settle();
    // Unlisted on both sides the copy is a cut one: mini's seat whole, the
    // macbook's seats as peers, and the note stays behind.
    expect(await nodesOn(mini)).toEqual(["agent peer", "peer helper", "peer lead", "region remote"]);

    // The macbook lists mini: the next copy is a keeper's, and it installs
    // whole — the sender was a voter, so the list it carries is trusted and
    // names this machine (0.11/06 F3: the copy is how the list reaches it).
    await authorities(macbook, [MACBOOK, MINI]);
    await bump(macbook);
    await settle();
    const whole = await nodesOn(mini);
    expect(whole).toEqual(["agent helper", "agent lead", "agent peer", "note kept-note", "region remote"]);
    await authorities(mini, [MACBOOK, MINI]);

    // A keeper copy carrying foreign seats does not forget the canvas's
    // cursors: only a seat that lives here can do that.
    await mini.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.withTransaction(
          unjournaledWorkMutationEffect(
            "test.fixture-seed",
            sql.unsafe(
              "INSERT INTO work_exchange_cursors (canvas_name, writer, through, last_basis_seq, updated_at) VALUES ('factory', 'mini-installation', '7', 0, 'now')",
            ),
          ),
        );
      }),
    );
    await mail(mini, { id: "peer", bindingId: "binding-peer" }, "helper", "held-for-helper");
    await mail(mini, { id: "peer", bindingId: "binding-peer" }, "peer", "held-for-peer");
    await bump(macbook);
    await settle();
    expect(await cursors(mini)).toEqual([{ writer: "mini-installation", through: "7" }]);

    // Delisted on both sides the next copy is a cut one again: the note is
    // gone, and mail held for a seat on another machine is pruned while
    // mini's own is kept.
    await authorities(macbook, [MACBOOK]);
    await authorities(mini, [MACBOOK]);
    await bump(macbook);
    await settle();
    expect(await nodesOn(mini)).toEqual(["agent peer", "peer helper", "peer lead", "region remote"]);
    expect(await inbox(mini, "helper")).toEqual([]);
    expect(await inbox(mini, "peer")).toEqual(["held-for-peer"]);
  });
});

describe("a copy carrying the authority list", () => {
  const ROGUE = id("rogue-installation");

  /** Replace a canvas's committed authority list on one machine. */
  const authorities = (on: Machine, members: ReadonlyArray<InstallationId>) =>
    on.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`DELETE FROM canvas_authorities WHERE canvas_name = 'factory'`;
        for (const [position, member] of members.entries()) {
          yield* sql`INSERT INTO canvas_authorities (canvas_name, position, installation_id) VALUES ('factory', ${position}, ${member})`;
        }
      }),
    );

  /** Pin a peer as the operator's machine link does: bound by the link key. */
  const pinKey = (on: Machine, machineName: string, installationId: InstallationId) =>
    on.runtime.runPromise(
      Effect.flatMap(MachineRepository, (machines) => machines.pinPeer({ machineName, installationId }, { binding: "key" })),
    );

  /** The newest installed copy's list, position and sender, as remote-core reads them. */
  const copyList = (on: Machine) =>
    on.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql.unsafe<{ term: number; log_index: number; sender: string }>(
          "SELECT term, log_index, sender FROM canvas_copy_list WHERE canvas_name = 'factory'",
        );
        if (rows[0] === undefined) return undefined;
        const members = yield* sql.unsafe<{ installation_id: string }>(
          "SELECT installation_id FROM canvas_copy_list_members WHERE canvas_name = 'factory' ORDER BY position",
        );
        return { term: rows[0].term, index: rows[0].log_index, sender: rows[0].sender, members: members.map((member) => member.installation_id) };
      }),
    );

  /** The copy the macbook owes the mini now, taken from the queue before it crosses. */
  const copyFor = async (macbook: Machine, mini: Machine) => {
    queue.length = 0;
    if (!macbook.exchange.linked(mini.self)) {
      open.add(`${macbook.name}>${mini.name}`);
      await macbook.runtime.runPromise(macbook.channel.opened(contextOf(macbook, mini)));
    } else {
      await macbook.runtime.runPromise(macbook.exchange.committed("factory"));
    }
    await quiet();
    const frame = queue.find((queued) => (queued.payload as { kind: string }).kind === "copy");
    queue.length = 0;
    return (frame!.payload as { copy: CanvasCopy }).copy;
  };

  /** Deliver queued frames in order, recording the kinds the named machine takes in. */
  const deliveredTo = async (mini: Machine): Promise<string[]> => {
    const kinds: string[] = [];
    for (await quiet(); queue.length > 0; await quiet()) {
      const next = queue.shift()!;
      if (!open.has(`${next.from.name}>${next.to.name}`)) continue;
      const frame = next.to.channel.decodeEvent(next.payload);
      if (next.to === mini) kinds.push((frame as { kind: string }).kind);
      await next.to.runtime.runPromise(next.to.channel.handleEvent(contextOf(next.to, next.from), frame));
    }
    return kinds;
  };

  it("refuses a keeper copy from an unlisted peer whose list names itself, and the trust set does not move", async () => {
    const { macbook, mini } = await pair();
    await link(macbook, mini);
    await settle();
    // Even pinned by the operator's key, a peer that holds no voter seat
    // cannot certify itself through the list inside its own copy (G1).
    await pinKey(mini, "rogue", ROGUE);
    await authorities(macbook, [MACBOOK, MINI]);
    const honest = await copyFor(macbook, mini);
    const forged: CanvasCopy = {
      ...honest,
      editor: ROGUE,
      notes: [],
      authorities: { members: [ROGUE], term: 1, index: 9 },
    };
    const outcome = await mini.runtime.runPromise(mini.exchange.installCopy(forged));
    expect(outcome).toMatchObject({ installed: false });
    // The honest copy's own list persisted at its install; the forged one moved nothing.
    expect(await copyList(mini)).toMatchObject({ term: 0, index: 0, sender: MACBOOK });
    expect(await mini.runtime.runPromise(Effect.flatMap(ModelRecords, (records) => records.canvasAuthorities("factory")))).not.toContain(ROGUE);
    // The canvas the honest copy described is the one still held.
    expect((await header(mini))!.editor).toBe(MACBOOK);
  });

  it("refuses a copy whose list is older than the one it holds", async () => {
    const { macbook, mini } = await pair();
    await link(macbook, mini);
    await settle();
    await authorities(macbook, [MACBOOK, MINI]);
    const honest = await copyFor(macbook, mini);
    // A keeper copy from a voter at list position 9 installs and persists it.
    const newer: CanvasCopy = { ...honest, notes: [], authorities: { members: [MACBOOK, MINI], term: 1, index: 9 } };
    const first = await mini.runtime.runPromise(mini.exchange.installCopy(newer));
    expect(first).not.toMatchObject({ refused: expect.anything() });
    expect(await copyList(mini)).toMatchObject({ term: 1, index: 9, sender: MACBOOK, members: [MACBOOK, MINI] });
    // A copy carrying the list as it stood at 7 never unwinds it (G3).
    const stale: CanvasCopy = { ...honest, notes: [], authorities: { members: [MACBOOK, MINI, ROGUE], term: 1, index: 7 } };
    const second = await mini.runtime.runPromise(mini.exchange.installCopy(stale));
    expect(second).toMatchObject({ installed: false });
    expect(await copyList(mini)).toMatchObject({ term: 1, index: 9, sender: MACBOOK, members: [MACBOOK, MINI] });
  });

  it("admits a newcomer's first copy only from the key-bound peer, never another pinned machine", async () => {
    const macbook = await boot("macbook", MACBOOK, [["mini", MINI]]);
    const mini = await boot("mini", MINI, [["macbook", MACBOOK], ["rogue", ROGUE]]);
    await factoryOn(macbook);
    await pinKey(mini, "macbook", MACBOOK);
    await authorities(macbook, [MACBOOK, MINI]);
    const honest = await copyFor(macbook, mini);
    expect(honest.notes).toBeDefined();
    // The rogue's keeper copy arrives first: pinned, but never key-bound,
    // and nothing else admits it to a machine that holds nothing (G2).
    const rogueCopy: CanvasCopy = { ...honest, editor: ROGUE };
    expect(await mini.runtime.runPromise(mini.exchange.installCopy(rogueCopy))).toMatchObject({ installed: false });
    expect(await header(mini)).toBeUndefined();
    // The operator's key-bound peer's copy is the one that lands, whole.
    expect(await mini.runtime.runPromise(mini.exchange.installCopy(honest))).toMatchObject({ installed: true });
    expect(await nodesOn(mini)).toContain("note a-note");
    expect(await copyList(mini)).toMatchObject({ term: 0, index: 0, sender: MACBOOK, members: [MACBOOK, MINI] });
  });

  it("hands the newcomer its copy ahead of the first rows once the list commits", async () => {
    const macbook = await boot("macbook", MACBOOK, [["mini", MINI]]);
    const mini = await boot("mini", MINI, [["macbook", MACBOOK]]);
    await factoryOn(macbook);
    await pinKey(mini, "macbook", MACBOOK);
    await authorities(macbook, [MACBOOK, MINI]);
    await mail(macbook, { id: "lead", bindingId: "binding-lead" }, "peer", "owed-before-the-copy");
    queue.length = 0;
    await link(macbook, mini);
    const kinds = await deliveredTo(mini);
    // The keeper copy crosses before the first rows frame: a machine takes
    // the list, and only then what its authority appends.
    const copyAt = kinds.indexOf("copy");
    const rowsAt = kinds.indexOf("rows");
    expect(copyAt).toBeGreaterThanOrEqual(0);
    expect(rowsAt === -1 || copyAt < rowsAt).toBe(true);
    expect(await nodesOn(mini)).toContain("note a-note");
    expect(await copyList(mini)).toMatchObject({ sender: MACBOOK, members: [MACBOOK, MINI] });
    expect(await inbox(mini, "peer")).toEqual(["owed-before-the-copy"]);
  });
});
