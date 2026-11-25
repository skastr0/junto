import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime, Result, Schema } from "effect";
import { ulid } from "ulid";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { NodeOf } from "../src/shared/model";
import { readMailExtension } from "../src/shared/crew";
import { signalThreadFault } from "../src/shared/signal-thread";
import { MsgReplyArgs, MsgSendArgs } from "../src/shared/work-control";
import { OPERATOR_SEAT_ID } from "../src/shared/work-reference";
import type { ActorRef } from "../src/shared/work-protocol";
import { makeUserMessage } from "../src/shared/task";
import { region, seat } from "./support/model-nodes";
import { grantOverseer as grantSeat, ModelStoresLive, seedCanvas } from "./support/seed-canvas";
import { ModelActorRefs } from "../src/core/model/actor-refs";
import { overseerWorkAdmin } from "../src/core/work/authz";
import { CrewRepositoryLive } from "../src/core/work/crew-repository";
import { WorkLive, WorkService } from "../src/core/work/service";
import { WorkRepositoryLive } from "../src/core/work/repository";
import { makeStateEngineLive } from "../src/core/state/engine";
import { MachineRepositoryLive } from "../src/core/machines/repository";
import { SettingsLive } from "../src/core/settings/service";
import { makeContentServiceLive } from "../src/core/content/service";
import { makeInstallOpsLive } from "../src/core/install-ops/engine";
import { threadRow } from "../src/core/work-control/signal-raise";
import { executeOverseerWork } from "../src/core/overseer/work";
import { executeOverseerThreads } from "../src/core/overseer/threads";
import { messageDelivery } from "../src/core/work/message-delivery";
import { makeMessageDeliveryStore } from "../src/core/work/message-delivery-store";
import { THIS_MACHINE } from "./support/machines";
import { nameThisMachine } from "./support/name-this-machine";
import { makeThisMachine } from "../src/shared/remote-hosts";
import { hostsSnapshot, setHostsSnapshot } from "../src/core/hosts/snapshot";

const mockHome = join(tmpdir(), `junto-overseer-broadcast-${randomUUID()}`);

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => mockHome };
});

type Seat = NodeOf<"agent">;

const seatAt = (id: string, canvas: string, x: number): Seat =>
  seat(id, {
    x,
    y: 120,
    width: 200,
    height: 100,
    host: THIS_MACHINE,
    agentKey: `${THIS_MACHINE}:${canvas}-${id}`,
    bindingId: `binding-${canvas}-${id}` as Seat["bindingId"],
    launch: { kind: "harness", argv: ["claude"] },
  });

// A region "Floor" holds the overseer boss and three seats; no wires at all.
const floor = (canvas: string) => [
  region("floor", { x: 0, y: 0, width: 2000, height: 600 }, { label: "Floor" }),
  seatAt("boss", canvas, 0),
  seatAt("a", canvas, 300),
  seatAt("b", canvas, 600),
  seatAt("c", canvas, 900),
];

const runtime = (() => {
  const databasePath = join(mockHome, "state", "junto.db");
  const installRoot = join(databasePath, "..");
  const repositoriesLive = Layer.provideMerge(
    Layer.mergeAll(
      WorkRepositoryLive,
      CrewRepositoryLive,
      MachineRepositoryLive,
      SettingsLive,
      makeContentServiceLive({ root: join(installRoot, "content"), skipInlineMediaMigration: true }),
    ),
    Layer.mergeAll(makeStateEngineLive(databasePath), makeInstallOpsLive(join(installRoot, "install-ops.db"))),
  );
  return ManagedRuntime.make(Layer.provideMerge(WorkLive, Layer.provideMerge(ModelStoresLive, repositoriesLive)));
})();
const run = <A, E, R>(effect: Effect.Effect<A, E, R>) => runtime.runPromise(effect as Effect.Effect<A, E, never>);

const heldHosts = hostsSnapshot();

beforeAll(async () => {
  await runtime.runPromise(nameThisMachine);
  // The core knows its own machine from the hosts it loads at boot.
  setHostsSnapshot([makeThisMachine(THIS_MACHINE)]);
});

afterAll(async () => {
  setHostsSnapshot(heldHosts);
  await runtime.dispose();
  await rm(mockHome, { recursive: true, force: true });
});

/** A canvas with the region, boss granted overseer, and boss's actor. */
const ready = async (canvas: string): Promise<ActorRef> => {
  await run(seedCanvas(canvas, floor(canvas)));
  await run(grantSeat(canvas, "boss", true));
  const refs = await run(Effect.flatMap(ModelActorRefs, (actors) => actors.read(canvas))) as ReadonlyArray<ActorRef>;
  const actor = refs.find((candidate) => candidate.nodeId === "boss");
  if (actor === undefined) throw new Error("missing actor boss");
  return actor;
};

const mailbox = (canvas: string, nodeId: string) =>
  run(Effect.flatMap(WorkService, (work) => work.readMailbox(canvas, nodeId)));

const broadcast = (canvas: string, actor: ActorRef, args: Record<string, unknown>) =>
  run(
    executeOverseerWork(
      { canvasName: canvas, nodeId: "boss" },
      { operation: "msg.broadcast", args: { region: ["Floor"], text: "stop and commit", ...args } },
      overseerWorkAdmin(actor),
    ).pipe(Effect.result),
  );

type Sent = {
  readonly count: number;
  readonly set: string;
  readonly seats: ReadonlyArray<{ readonly nodeId: string; readonly threadId: string; readonly messageId: string; readonly delivery: string }>;
};

describe("msg.broadcast", () => {
  it("names the set it would reach without sending", async () => {
    const actor = await ready("bc-audience");
    const read = await run(
      executeOverseerWork(
        { canvasName: "bc-audience", nodeId: "boss" },
        { operation: "msg.audience", args: { region: ["Floor"] } },
        overseerWorkAdmin(actor),
      ),
    ) as { readonly count: number; readonly seats: ReadonlyArray<{ readonly nodeId: string }> };
    expect(read.count).toBe(3);
    expect(read.seats.map((one) => one.nodeId)).toEqual(["a", "b", "c"]);
    for (const nodeId of ["a", "b", "c"]) expect(await mailbox("bc-audience", nodeId)).toHaveLength(0);
  });

  it("writes one notice per seat, each a new thread, the overseer's own and marked one way", async () => {
    const actor = await ready("bc-send");
    const answer = await broadcast("bc-send", actor, { expect: 3 });
    expect(Result.isSuccess(answer)).toBe(true);
    if (!Result.isSuccess(answer)) return;
    const sent = answer.success as Sent;
    expect(sent.count).toBe(3);
    expect(sent.seats.map((one) => one.nodeId)).toEqual(["a", "b", "c"]);
    for (const one of sent.seats) {
      expect(one.threadId).toBe(one.messageId);
      expect(typeof one.delivery).toBe("string");
      const rows = await mailbox("bc-send", one.nodeId);
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      expect(row.messageId).toBe(one.messageId);
      expect(row.metadata?.fromSeat).toBe(actor.seatId);
      expect(row.metadata?.fromSeat).not.toBe(OPERATOR_SEAT_ID);
      expect(readMailExtension(row.metadata)).toMatchObject({
        mailKind: "notice",
        broadcast: true,
        noWake: true,
        senderNodeId: "boss",
      });
    }
    // The overseer's own seat is never in the set.
    expect(await mailbox("bc-send", "boss")).toHaveLength(0);
  });

  it("is a thread no seat may raise a signal in, and not one the seat has with the operator", async () => {
    const actor = await ready("bc-thread");
    const answer = await broadcast("bc-thread", actor, { expect: 3 });
    if (!Result.isSuccess(answer)) throw new Error("the broadcast did not send");
    const one = (answer.success as Sent).seats[0]!;
    const rows = await mailbox("bc-thread", one.nodeId);
    expect(signalThreadFault(one.threadId, rows.map(threadRow))).toBe("no_operator_row");
    const withYou = await run(
      executeOverseerThreads({ canvasName: "bc-thread", nodeId: "boss" }, "thread.list", { seat: one.nodeId, group: "with-you" }),
    ) as { readonly threads: ReadonlyArray<{ readonly threadId: string }> };
    expect(withYou.threads.map((thread) => thread.threadId)).not.toContain(one.threadId);
  });

  it("leaves a single overseer msg.send unmarked", async () => {
    const actor = await ready("bc-single");
    await run(
      executeOverseerWork(
        { canvasName: "bc-single", nodeId: "boss" },
        { operation: "msg.send", args: { target: "a", text: "one note" } },
        overseerWorkAdmin(actor),
      ),
    );
    const [row] = await mailbox("bc-single", "a");
    expect(row?.metadata?.broadcast).toBeUndefined();
    expect(row?.metadata?.noWake).toBeUndefined();
  });

  it("refuses a set that differs from the one named, whole, and sends nothing", async () => {
    const actor = await ready("bc-stale");
    const count = await broadcast("bc-stale", actor, { expect: 2 });
    expect(Result.isFailure(count) && count.failure.type).toBe("Stale");
    const digest = await broadcast("bc-stale", actor, { expect: 3, set: "0000000000000000" });
    expect(Result.isFailure(digest) && digest.failure.details?.reason).toBe("set_changed");
    for (const nodeId of ["a", "b", "c"]) expect(await mailbox("bc-stale", nodeId)).toHaveLength(0);
  });

  it("never starts a seat that is not live, by the row's own noWake mark", async () => {
    const actor = await ready("bc-asleep");
    const wakes: string[] = [];
    const writes: string[] = [];
    messageDelivery.configure({
      store: await run(makeMessageDeliveryStore()),
      transport: {
        seatLive: () => false,
        wakeSeat: async (bindingId) => {
          wakes.push(bindingId);
          return true;
        },
        writeMail: async (bindingId) => {
          writes.push(bindingId);
          return "written";
        },
      },
    });
    try {
      const answer = await broadcast("bc-asleep", actor, { expect: 3 });
      if (!Result.isSuccess(answer)) throw new Error("the broadcast did not send");
      expect((answer.success as Sent).seats.map((one) => one.delivery)).toEqual(["waiting", "waiting", "waiting"]);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(wakes).toEqual([]);
      expect(writes).toEqual([]);
    } finally {
      messageDelivery.suspend();
    }
  });

  it("refuses a revoked overseer and sends nothing", async () => {
    const actor = await ready("bc-revoked");
    await run(grantSeat("bc-revoked", "boss", false));
    const answer = await broadcast("bc-revoked", actor, { expect: 3 });
    expect(Result.isFailure(answer) && answer.failure.type).toBe("AuthError");
    for (const nodeId of ["a", "b", "c"]) expect(await mailbox("bc-revoked", nodeId)).toHaveLength(0);
  });
});

describe("workMessageAppendAll", () => {
  const note = (canvas: string, text: string) =>
    makeUserMessage({ messageId: ulid(), text, contextId: canvas });

  it("writes every row in one transaction: a failure at a later seat leaves no row at all", async () => {
    const actor = await ready("bc-whole");
    const written = await run(
      Effect.flatMap(WorkService, (work) =>
        work.workMessageAppendAll(
          "bc-whole",
          () => Effect.succeed([
            { nodeId: "a", message: note("bc-whole", "first") },
            { nodeId: "b", message: note("bc-whole", "second") },
            { nodeId: "nowhere", message: note("bc-whole", "third") },
          ]),
          actor,
          overseerWorkAdmin(actor),
        )).pipe(Effect.result),
    );
    expect(Result.isFailure(written)).toBe(true);
    expect(await mailbox("bc-whole", "a")).toHaveLength(0);
    expect(await mailbox("bc-whole", "b")).toHaveLength(0);
  });

  it("refuses a revoked overseer before any row", async () => {
    const actor = await ready("bc-whole-revoked");
    await run(grantSeat("bc-whole-revoked", "boss", false));
    const written = await run(
      Effect.flatMap(WorkService, (work) =>
        work.workMessageAppendAll(
          "bc-whole-revoked",
          () => Effect.succeed([{ nodeId: "a", message: note("bc-whole-revoked", "first") }]),
          actor,
          overseerWorkAdmin(actor),
        )).pipe(Effect.result),
    );
    expect(Result.isFailure(written)).toBe(true);
    expect(await mailbox("bc-whole-revoked", "a")).toHaveLength(0);
  });
});

describe("the broadcast mark", () => {
  it("is never taken from what a seat supplies to its own msg send or reply", () => {
    const strict = { onExcessProperty: "error" } as const;
    expect(Result.isSuccess(Schema.decodeUnknownResult(MsgSendArgs, strict)({ target: "a", text: "hi" }))).toBe(true);
    expect(Result.isSuccess(Schema.decodeUnknownResult(MsgReplyArgs, strict)({ target: "a", text: "hi", inReplyTo: "x" }))).toBe(true);
    expect(Result.isFailure(Schema.decodeUnknownResult(MsgSendArgs, strict)({ target: "a", text: "hi", broadcast: true }))).toBe(true);
    expect(Result.isFailure(Schema.decodeUnknownResult(MsgReplyArgs, strict)({ target: "a", text: "hi", inReplyTo: "x", broadcast: true }))).toBe(true);
  });

  it("is read through the mail extension, a literal true or absent", () => {
    const stamp = { mailKind: "notice", fromSeat: `seat_${"a".repeat(64)}`, senderGeneration: "g", senderHarness: "claude" };
    expect(readMailExtension({ ...stamp, broadcast: true })?.broadcast).toBe(true);
    expect(readMailExtension(stamp)?.broadcast).toBeUndefined();
    expect(readMailExtension({ ...stamp, broadcast: false })).toBeUndefined();
  });
});
