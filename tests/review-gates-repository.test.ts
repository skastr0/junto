/**
 * The repository's review gates, each read in the writer's own transaction:
 * a task verdict admits a seat on the task's reviewer list, and a commit
 * verdict admits a seat its receipt on this canvas reached. No edge grants
 * review.
 */
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { afterEach, describe, expect, it } from "vitest";
import { ReviewVerdict } from "../src/shared/crew";
import { InstallationId } from "../src/shared/installation-id";
import { CanvasFactBasis } from "../src/shared/work-protocol";
import type { ActorSeatId } from "../src/shared/actor-seat";
import type { ActorRef } from "../src/shared/work-protocol";
import { deriveActorSeatId } from "../src/main/junto/actor-seat-id";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { CrewRepository, CrewRepositoryLive } from "../src/main/junto/work/crew-repository";
import {
  createCanvasTaskDependencyScopeCapability,
  WorkRepository,
  WorkRepositoryLive,
} from "../src/main/junto/work/repository";
import { reviewSubjectProjection } from "../src/main/junto/work/reviews";
import { seedCanvasRows } from "./support/seed-canvas";
import { canvasOf, seat, taskBoard } from "./support/model-nodes";
import { THIS_MACHINE } from "./support/machines";

const canvasName = "factory";
const otherCanvasName = "other-factory";
const taskId = "01JZ00000000000000000000R1";
const local = Schema.decodeUnknownSync(InstallationId)("cc-review-gates");
const seatOf = (id: string): ActorSeatId => deriveActorSeatId(local, `binding-${id}`);
const author = seatOf("author");
const listed = seatOf("listed");
const other = seatOf("other");

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
    Layer.mergeAll(WorkRepositoryLive, CrewRepositoryLive).pipe(
      Layer.provideMerge(makeStateEngineLive(join(root, "junto.db"))),
    ),
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

const postTaskVerdict = ({ runtime, basis }: Opened, reviewer: ActorSeatId, verdictId: string) =>
  runtime.runPromise(Effect.gen(function* () {
    const repository = yield* WorkRepository;
    const task = yield* repository.taskItem({ canvasName, nodeId: "board", itemId: taskId, kind: "task" });
    const projection = reviewSubjectProjection({ installationId: local, canvasName, nodeId: "board", task: task! });
    const verdict = Schema.decodeUnknownSync(ReviewVerdict)({
      verdictId, kind: "green", reviewerSeatId: reviewer, authorSeatId: author,
      subject: {
        kind: "task", installationId: local, canvasName, nodeId: "board", taskId,
        epoch: projection.epoch, subjectHash: projection.subjectHash,
      },
      subjectHash: projection.subjectHash, epoch: projection.epoch, findings: [], refs: [], postedAtMs: 1,
    });
    return yield* repository.postReviewVerdict(verdict, { basis, canvasName });
  }));

const sha = "c".repeat(40);
const receiptOn = ({ runtime }: Opened, canvas: string, reviewer: ActorSeatId) =>
  runtime.runPromise(Effect.gen(function* () {
    const crew = yield* CrewRepository;
    yield* crew.recordReviewReceipt({
      canvasName: canvas, sourceKind: "checkout", sourceId: `checkout-${canvas}`, refSha: sha,
      reviewerSeatId: reviewer, authorSeatId: author, createdAt: at,
    });
  }));

const postCommitVerdict = ({ runtime, basis }: Opened, reviewer: ActorSeatId, verdictId: string) =>
  runtime.runPromise(Effect.gen(function* () {
    const repository = yield* WorkRepository;
    const verdict = Schema.decodeUnknownSync(ReviewVerdict)({
      verdictId, kind: "green", reviewerSeatId: reviewer, authorSeatId: author,
      subject: { kind: "commit", sha, subjectHash: "d".repeat(64) },
      subjectHash: "d".repeat(64), epoch: 0, findings: [], refs: [], postedAtMs: 1,
    });
    return yield* repository.postReviewVerdict(verdict, { basis, canvasName });
  }));

describe("task verdict gate", () => {
  it("admits a seat on the task's reviewer list", async () => {
    const rig = await open();
    await seedTask(rig, ["listed"]);
    expect(await postTaskVerdict(rig, listed, "v-listed")).toMatchObject({ created: true });
  });

  it("refuses a seat that is not on the list", async () => {
    const rig = await open();
    await seedTask(rig, ["listed"]);
    expect(await postTaskVerdict(rig, other, "v-other")).toEqual({ rejected: "not-a-reviewer" });
  });

  it("refuses a reviewer taken off the list before the verdict lands", async () => {
    const rig = await open();
    await seedTask(rig, ["listed"]);
    await rig.runtime.runPromise(setReviewers([]));
    expect(await postTaskVerdict(rig, listed, "v-removed")).toEqual({ rejected: "not-a-reviewer" });
  });
});

describe("commit verdict gate", () => {
  it("refuses a seat no receipt for the sha reached", async () => {
    const rig = await open();
    expect(await postCommitVerdict(rig, listed, "c-none")).toEqual({ rejected: "not-a-reviewer" });
  });

  it("refuses a seat whose receipt for the sha is on another canvas", async () => {
    const rig = await open();
    await receiptOn(rig, otherCanvasName, listed);
    expect(await postCommitVerdict(rig, listed, "c-elsewhere")).toEqual({ rejected: "not-a-reviewer" });
  });

  it("admits a seat its receipt on this canvas reached", async () => {
    const rig = await open();
    await receiptOn(rig, canvasName, listed);
    expect(await postCommitVerdict(rig, listed, "c-here")).toMatchObject({ created: true });
  });
});
