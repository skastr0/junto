/**
 * The repository's review receipts, read in the writer's own transaction: a
 * commit the author's checkout shows is mailed to the seats on the task's
 * reviewer list, never to the author, and to nobody taken off the list. No
 * edge grants review.
 */
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { afterEach, describe, expect, it } from "vitest";
import { InstallationId } from "../src/shared/installation-id";
import { CanvasFactBasis } from "../src/shared/work-protocol";
import type { ActorSeatId } from "../src/shared/actor-seat";
import type { ActorRef } from "../src/shared/work-protocol";
import { deriveActorSeatId } from "../src/main/junto/actor-seat-id";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import {
  createCanvasTaskDependencyScopeCapability,
  WorkRepository,
  WorkRepositoryLive,
} from "../src/main/junto/work/repository";
import { seedCanvasRows } from "./support/seed-canvas";
import { canvasOf, seat, taskBoard } from "./support/model-nodes";
import { THIS_MACHINE } from "./support/machines";

const canvasName = "factory";
const otherCanvasName = "other-factory";
const taskId = "01JZ00000000000000000000R1";
const local = Schema.decodeUnknownSync(InstallationId)("cc-review-gates");
const seatOf = (id: string): ActorSeatId => deriveActorSeatId(local, `binding-${id}`);
const author = seatOf("author");

const nodes = [
  seat("author"),
  seat("listed", { x: 300 }),
  seat("other", { x: 600 }),
  taskBoard("board", { x: 0, y: 300, width: 240, height: 120 }),
];
const at = "2026-10-21T12:00:00.000Z";

const opened: Array<{ readonly root: string; readonly dispose: () => Promise<void> }> = [];
afterEach(async () => {
  const closing = opened.splice(0);
  await Promise.all(closing.map(({ dispose }) => dispose()));
  await Promise.all(closing.map(({ root }) => rm(root, { recursive: true, force: true })));
});

const open = async () => {
  const root = join(tmpdir(), `junto-review-gates-${randomUUID()}`);
  const runtime = ManagedRuntime.make(
    Layer.provideMerge(WorkRepositoryLive, makeStateEngineLive(join(root, "junto.db"))),
  );
  opened.push({ root, dispose: () => runtime.dispose() });
  await runtime.runPromise(Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql.withTransaction(Effect.gen(function* () {
      yield* sql.unsafe("INSERT INTO known_installations(installation_id, registered_at) VALUES (?, ?)", [local, at]);
      yield* sql.unsafe("INSERT INTO installation(singleton, installation_id, created_at) VALUES (1, ?, ?)", [local, at]);
      yield* sql.unsafe(
        "INSERT INTO machine_configuration(singleton, machine_name, supervised_preferred, configured_at) VALUES (1, ?, 1, ?)",
        [THIS_MACHINE, at],
      );
      yield* seedCanvasRows({
        seq: 1,
        canvases: new Map([[canvasName, { nodes }], [otherCanvasName, { nodes: [] }]]),
      });
    }));
  }));
  const basis = Schema.decodeUnknownSync(CanvasFactBasis)({ kind: "canvas", canvasName, seq: 1 });
  return { runtime, basis };
};

type Opened = Awaited<ReturnType<typeof open>>;

/** A working task the author holds, in the work store and as a task head listing `reviewers`. */
const seedTask = async ({ runtime, basis }: Opened, reviewers: ReadonlyArray<string>) => {
  await runtime.runPromise(Effect.gen(function* () {
    const repository = yield* WorkRepository;
    const sink = { canvasName, nodeId: "board" };
    const dependencyScope = createCanvasTaskDependencyScopeCapability({
      canvas: { ...canvasOf(nodes, [], canvasName), seq: 1 },
      authoringSink: sink,
    });
    yield* repository.createTask({
      sink, basis, dependencyScope,
      task: {
        id: taskId, state: "submitted",
        history: [{ messageId: "brief", role: "user", parts: [{ kind: "text", text: "Ship it" }] }],
      },
      originAt: at, receivedAt: at,
    });
    yield* repository.claimLocalTask({
      sink, basis, dependencyScope, taskId,
      actor: { seatId: author, canvasName, nodeId: "author" } as ActorRef,
      originAt: at, receivedAt: at,
    });
    yield* setReviewers(reviewers);
  }));
};

const setReviewers = (reviewers: ReadonlyArray<string>) => Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const json = JSON.stringify(reviewers.map((node) => ({ kind: "seat", seat: node })));
  // Later task-head columns with no default are seeded empty when present.
  const columns = yield* sql.unsafe<{ readonly name: string }>("PRAGMA table_info(task_heads)");
  const checks = columns.some((column) => column.name === "checks_json");
  yield* sql.unsafe(
    `INSERT INTO task_heads (canvas_name, task_id, number, node_id, title, state, assignee_node_id, epoch, stamps_required, reviewers_json, depends_on_json, created_at, updated_at, state_since${checks ? ", checks_json" : ""})
     VALUES (?, ?, 1, 'board', 'Ship it', 'working', 'author', 0, 1, ?, '[]', 1000, 1000, 1000${checks ? ", '[]'" : ""})
     ON CONFLICT (canvas_name, task_id) DO UPDATE SET reviewers_json = excluded.reviewers_json`,
    [canvasName, taskId, json],
  );
});

/** Publish one fresh commit from the author's checkout; the seats whose mailbox got a receipt. */
const receiptsFor = ({ runtime, basis }: Opened, sha: string) =>
  runtime.runPromise(Effect.gen(function* () {
    const repository = yield* WorkRepository;
    const records = yield* repository.publishCheckoutReceipts({
      basis, canvasName, nodeId: "board", taskId, checkoutKey: `checkout-${sha.slice(0, 4)}`,
      author: { fromSeat: author, senderGeneration: "g1", senderHarness: "claude" },
      shas: [sha],
    });
    return records.map((record) => record.nodeId).sort();
  }));

describe("review receipts", () => {
  it("mail the listed reviewers and never the author", async () => {
    const rig = await open();
    await seedTask(rig, ["listed", "author"]);
    expect(await receiptsFor(rig, "a".repeat(40))).toEqual(["listed"]);
  });

  it("mail nobody when the list is empty", async () => {
    const rig = await open();
    await seedTask(rig, []);
    expect(await receiptsFor(rig, "b".repeat(40))).toEqual([]);
  });

  it("stop for a reviewer taken off the list", async () => {
    const rig = await open();
    await seedTask(rig, ["listed", "other"]);
    expect(await receiptsFor(rig, "c".repeat(40))).toEqual(["listed", "other"]);
    await rig.runtime.runPromise(setReviewers(["other"]));
    expect(await receiptsFor(rig, "d".repeat(40))).toEqual(["other"]);
  });
});
