/**
 * The work repository projects when each task and request entered its
 * current state: the origin time of the fact that changed the state. A fact
 * that leaves the state alone does not move it, and the time survives a
 * reopen because it is stored with the row.
 */
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { afterEach, describe, expect, it } from "vitest";
import { ActorSeatId } from "../src/shared/actor-seat";
import {
  InstallationId,
  type InstallationId as InstallationIdValue,
} from "../src/shared/installation-id";
import {
  CanvasFactBasis,
  type ActorRef,
} from "../src/shared/work-protocol";
import {
  createCanvasTaskDependencyScopeCapability,
  WorkRepository,
  WorkRepositoryLive,
} from "../src/main/junto/work/repository";
import {
  makeStateEngineLive,
  StateEngine,
} from "../src/main/junto/state/engine";
import { unjournaledWorkMutationEffect } from "../src/main/junto/work/mutation-seam";
import { seedCanvasRows } from "./support/seed-canvas";
import { canvasOf, requests, seat as seatNode, taskBoard } from "./support/model-nodes";

const canvasName = "factory";
const otherCanvasName = "other-factory";
const opened: Array<{
  readonly root: string;
  readonly dispose: () => Promise<void>;
}> = [];

afterEach(async () => {
  const closing = opened.splice(0);
  await Promise.all(closing.map(({ dispose }) => dispose()));
  await Promise.all(
    closing.map(({ root }) => rm(root, { recursive: true, force: true })),
  );
});

const installation = (value: string): InstallationIdValue =>
  Schema.decodeUnknownSync(InstallationId)(value);

const actor = (digit: string, nodeId = `actor-${digit}`): ActorRef => ({
  seatId: Schema.decodeUnknownSync(ActorSeatId)(
    `seat_${digit.repeat(64)}`,
  ),
  canvasName,
  nodeId,
});

const atMinute = (minute: number): string =>
  new Date(Date.UTC(2026, 7, 12, 12, minute)).toISOString();

const factoryNodes = [
  seatNode("recipient", { width: 240, height: 100, label: "Recipient" }),
  taskBoard("board", { x: 300, y: 0, width: 240, height: 120 }),
  requests("asks", { x: 600, y: 0, width: 240, height: 120 }),
];
/** The canvas as its rows hold it, at the sequence the rig seeds. */
const factoryCanvas = { ...canvasOf(factoryNodes, [], canvasName), seq: 1 };

const openRepository = async (
  local: InstallationIdValue,
  peers: ReadonlyArray<InstallationIdValue> = [],
  role: "command-center" | "remote" = "command-center",
) => {
  const root = join(
    tmpdir(),
    `junto-state-since-${local}-${randomUUID()}`,
  );
  const runtime = ManagedRuntime.make(
    Layer.provideMerge(
      WorkRepositoryLive,
      makeStateEngineLive(join(root, "junto.db")),
    ),
  );
  opened.push({ root, dispose: () => runtime.dispose() });
  const repository = await runtime.runPromise(WorkRepository);
  const sql = await runtime.runPromise(SqlClient.SqlClient);
  await runtime.runPromise(
    sql.withTransaction(
      Effect.gen(function* () {
        for (const known of new Set([local, ...peers])) {
          yield* sql.unsafe(
            `
            INSERT INTO station_known_installations(
              installation_id,
              registered_at
            ) VALUES (?, ?)
          `,
            [known, atMinute(0)],
          );
        }
        yield* sql.unsafe(
          `
          INSERT INTO station_installation(
            singleton,
            installation_id,
            created_at
          ) VALUES (1, ?, ?)
        `,
          [local, atMinute(0)],
        );
        yield* sql.unsafe(
          `
          INSERT INTO station_configuration(
            singleton,
            role,
            host_id,
            agent_host_id,
            command_center_installation_id,
            supervised_preferred,
            configured_at
          ) VALUES (1, ?, ?, ?, ?, 1, ?)
        `,
          role === "command-center"
            ? [role, "local", null, null, atMinute(0)]
            : [role, "remote", "remote", peers[0], atMinute(0)],
        );
        yield* seedCanvasRows({
          seq: 1,
          canvases: new Map([
            [canvasName, { nodes: factoryNodes }],
            [otherCanvasName, { nodes: [] }],
          ]),
        });
      }),
    ),
  );
  const basis = Schema.decodeUnknownSync(CanvasFactBasis)({
    kind: "canvas", canvasName: "factory", seq: 1,
  });
  return { runtime, repository, basis, root };
};


const board = { canvasName, nodeId: "board" };
const asks = { canvasName, nodeId: "asks" };
const note = (messageId: string, text: string) => ({
  messageId,
  role: "user" as const,
  parts: [{ kind: "text" as const, text }],
});

describe("WorkRepository stateSince projection", () => {
  it("hydrates only selected policy rows and keeps the explicit full-lane reader separate", async () => {
    const { runtime, repository, basis } = await openRepository(installation("cc-selected-policy"));
    const dependencyScope = createCanvasTaskDependencyScopeCapability({
      canvas: factoryCanvas, authoringSink: board,
    });
    for (const id of ["selected", "unrelated"]) await runtime.runPromise(repository.createTask({
      sink: board, basis, dependencyScope,
      task: { id, state: "submitted", history: [note(`brief-${id}`, id)] },
      originAt: atMinute(1), receivedAt: atMinute(1),
    }));
    expect(await runtime.runPromise(repository.taskLane(canvasName, "board", "task"))).toHaveLength(2);
    await runtime.runPromise(Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      // Disposable fixture corruption proves unrelated histories are not decoded.
      yield* sql`PRAGMA ignore_check_constraints=ON`;
      yield* sql.withTransaction(unjournaledWorkMutationEffect("test.fixture-seed",
        sql`UPDATE work_task_messages SET parts_json='invalid unrelated JSON'
          WHERE canvas_name=${canvasName} AND node_id='board' AND item_id='unrelated'`,
      )).pipe(Effect.ensuring(sql`PRAGMA ignore_check_constraints=OFF`.pipe(Effect.asVoid, Effect.orDie)));
    }));
    const rows = await runtime.runPromise(repository.taskRowsByIds(canvasName, ["selected", "selected"]));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ nodeId: "board", item: { id: "selected", history: [{ parts: [{ kind: "text", text: "selected" }] }] } });
    expect(await runtime.runPromise(repository.taskRowsByIds(canvasName, []))).toEqual([]);
    expect(await runtime.runPromise(repository.taskRowsByIds(otherCanvasName, ["selected"]))).toEqual([]);
    await expect(runtime.runPromise(repository.taskLane(canvasName, "board", "task"))).rejects.toThrow();
    // A commit must not hydrate that same unrelated history as a result snapshot.
    const changed = await runtime.runPromise(repository.describeTask({
      sink: board, basis, taskId: "selected", message: note("changed-brief", "Changed selected task."),
    }));
    expect(changed).not.toHaveProperty("snapshot");
    const selected = await runtime.runPromise(repository.taskItem({ canvasName, nodeId: "board", itemId: "selected", kind: "task" }));
    expect(selected?.history.some((message) => message.messageId === "changed-brief")).toBe(true);
  });

  it("stamps the fact time of each state change and keeps it through facts that change nothing", async () => {
    const { runtime, repository, basis } = await openRepository(installation("cc-state-since"));
    const seat = actor("1", "recipient");
    const dependencyScope = createCanvasTaskDependencyScopeCapability({
      canvas: factoryCanvas,
      authoringSink: board,
    });
    const taskSince = async (): Promise<string | undefined> =>
      (await runtime.runPromise(repository.taskItem({ canvasName, nodeId: "board", itemId: "t1", kind: "task" })))?.stateSince;

    await runtime.runPromise(
      repository.createTask({
        sink: board,
        basis,
        dependencyScope,
        task: { id: "t1", state: "submitted", history: [note("m1", "Run the migration.")] },
        originAt: atMinute(1),
        receivedAt: atMinute(1),
      }),
    );
    expect(await taskSince()).toBe(atMinute(1));

    await runtime.runPromise(
      repository.claimLocalTask({ sink: board, basis, dependencyScope, taskId: "t1", actor: seat, originAt: atMinute(5), receivedAt: atMinute(5) }),
    );
    expect(await taskSince()).toBe(atMinute(5));

    const transition = await runtime.runPromise(
      repository.transitionTask({ sink: board, basis, taskId: "t1", state: "input-required", originAt: atMinute(9), receivedAt: atMinute(9) }),
    );
    expect(await taskSince()).toBe(atMinute(9));
    // The guard: Task's schema accepts stateSince from any caller, so the
    // journal must be shown to stay free of it. The transition read the task
    // back from a row that already carried a stamp (the claim's); neither the
    // fact it wrote nor the value it returned may contain one.
    expect(JSON.stringify(transition.record)).not.toContain("stateSince");
    expect(transition.value).not.toHaveProperty("stateSince");
    // Reader-local stamps are obtained by the explicit item query.
    expect((await runtime.runPromise(repository.taskItem({ canvasName, nodeId: "board", itemId: "t1", kind: "task" })))?.stateSince).toBe(atMinute(9));

    // A note on the waiting task is a fact that leaves the state alone.
    await runtime.runPromise(
      repository.describeTask({ sink: board, basis, taskId: "t1", message: note("m2", "Still waiting."), originAt: atMinute(30), receivedAt: atMinute(30) }),
    );
    const task = await runtime.runPromise(repository.taskItem({ canvasName, nodeId: "board", itemId: "t1", kind: "task" }));
    expect(task).toMatchObject({ state: "input-required", stateSince: atMinute(9) });
    // Row bookkeeping only: it is not task metadata.
    expect(task?.metadata).toBeUndefined();
  });

  it("stamps a request with the time it was raised", async () => {
    const { runtime, repository, basis } = await openRepository(installation("cc-state-since-req"));
    const seat = actor("1", "recipient");
    await runtime.runPromise(
      repository.createRequest({
        sink: asks,
        basis,
        raisedBy: seat,
        request: { id: "r1", state: "input-required", claimedBy: seat.seatId, history: [note("m1", "Which region?")] },
        originAt: atMinute(3),
        receivedAt: atMinute(3),
      }),
    );
    const request = await runtime.runPromise(repository.taskItem({ canvasName, nodeId: "asks", itemId: "r1", kind: "requests" }));
    expect(request).toMatchObject({ id: "r1", stateSince: atMinute(3) });
  });

  it("keeps the time through a full close and reopen of the database", async () => {
    const { runtime, repository, basis, root } = await openRepository(installation("cc-state-since-reopen"));
    const seat = actor("1", "recipient");
    await runtime.runPromise(
      repository.createRequest({
        sink: asks,
        basis,
        raisedBy: seat,
        request: { id: "r1", state: "input-required", claimedBy: seat.seatId, history: [note("m1", "Which region?")] },
        originAt: atMinute(3),
        receivedAt: atMinute(3),
      }),
    );
    await runtime.dispose();

    // A new process: nothing in memory, only the file.
    const reopened = ManagedRuntime.make(
      Layer.provideMerge(WorkRepositoryLive, makeStateEngineLive(join(root, "junto.db"))),
    );
    opened.push({ root, dispose: () => reopened.dispose() });
    const again = await reopened.runPromise(WorkRepository);
    const request = await reopened.runPromise(again.taskItem({ canvasName, nodeId: "asks", itemId: "r1", kind: "requests" }));
    expect(request).toMatchObject({ id: "r1", stateSince: atMinute(3) });
  });

  it("reads a row written before the stamp existed as since its last fact", async () => {
    const { runtime, repository, basis } = await openRepository(installation("cc-state-since-old"));
    const seat = actor("1", "recipient");
    await runtime.runPromise(
      repository.createRequest({
        sink: asks,
        basis,
        raisedBy: seat,
        request: { id: "r1", state: "input-required", claimedBy: seat.seatId, history: [note("m1", "Which region?")] },
        originAt: atMinute(3),
        receivedAt: atMinute(3),
      }),
    );
    const sql = await runtime.runPromise(SqlClient.SqlClient);
    await runtime.runPromise(
      sql.withTransaction(
        unjournaledWorkMutationEffect(
          "test.fixture-seed",
          sql.unsafe("UPDATE work_requests SET metadata_json = NULL WHERE request_id = ?", ["r1"]),
        ),
      ),
    );
    const request = await runtime.runPromise(repository.taskItem({ canvasName, nodeId: "asks", itemId: "r1", kind: "requests" }));
    expect(request?.stateSince).toBe(atMinute(3));
  });
});
