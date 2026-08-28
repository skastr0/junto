/**
 * The in-memory factory world, tested as a differential against SQLite.
 *
 * The world exists to stop a canvas read rebuilding every sink whenever one
 * sink changes. That is only worth having if what it serves is EXACTLY what
 * the SQLite read path would have returned — a fast stale world is a worse
 * defect than a slow correct one, because a stale work plane is the factory's
 * source of truth silently disagreeing with its journal.
 *
 * So every test here is the same shape: mutate through the real write path,
 * then read the world and read SQLite through the SAME reader in the SAME
 * snapshot, and require them to be equal. The mutations below walk every lane
 * a snapshot projects (tasks, requests, mailbox, artifacts, board, pad,
 * proposals, delivery receipts, read cursors) plus the two operator paths that
 * deliberately mint no journal record.
 *
 * Two assertions keep this from being a tautology:
 *
 * - the revision must MOVE on every mutation, so "equal" is never "equal
 *   because nothing happened";
 * - the world must take its INCREMENTAL path, re-reading only the sinks the
 *   mutation seam announced. Without that, a world that quietly rebuilt
 *   everything from SQLite on every read would pass every equality check here
 *   while delivering none of the point of the change.
 */
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context, Effect, Layer, ManagedRuntime, Schema } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ActorSeatId } from "../src/shared/actor-seat";
import { PadPatch } from "../src/shared/pad";
import {
  InstallationId,
  type InstallationId as InstallationIdValue,
} from "../src/shared/installation-id";
import {
  createAuthorialTaskDependencyScopeCapability,
  readCanvasWorkProjection,
  readCanvasWorkRevision,
  WorkRepository,
  WorkRepositoryLive,
} from "../src/main/vellum/work/repository";
import {
  makeStateEngineLive,
  StateEngine,
} from "../src/main/vellum/state/engine";
import { unjournaledWorkMutation } from "../src/main/vellum/work/mutation-seam";
import { makeWorkWorld, type WorkWorld } from "../src/main/vellum/work/world";
import { IntentFactBasis } from "../src/shared/work-protocol";
import { serializeCanvas, type CanvasDoc } from "../src/shared/canvas";
import { authorialMaterialForTest } from "./helpers/task-topology-authority";
import { seedCanvasAuthority } from "./helpers/canvas-authority-material";

const CANVAS = "factory";
const TASKS = "tasks-sink";
const REQUESTS = "requests-sink";
const ARTIFACTS = "artifacts-sink";
const BOARD = "board-sink";
const PAD = "pad-sink";
const INBOX = "agent-inbox";

const root = join(tmpdir(), `vellum-command-work-world-${randomUUID()}`);
const runtime = ManagedRuntime.make(
  Layer.provideMerge(
    WorkRepositoryLive,
    makeStateEngineLive(join(root, "vellum-command.db")),
  ),
);

let repository: Context.Service.Shape<typeof WorkRepository>;
let state: Context.Service.Shape<typeof StateEngine>;
let world: WorkWorld;

const observedAt = "2026-08-18T09:00:00.000Z";
const cc = Schema.decodeUnknownSync(InstallationId)("cc-world");
const taskDocument = (nodeIds: ReadonlyArray<string>): CanvasDoc => ({
  nodes: nodeIds.map((id, index) => ({
    id,
    type: "text" as const,
    x: index * 220,
    y: 0,
    width: 180,
    height: 80,
    text: id,
    ether: { entity: { kind: "task" } },
  })),
  edges: [],
});
const fixtureDocuments = new Map<string, CanvasDoc>([
  [CANVAS, taskDocument([TASKS, "archived-sink", "aaa-sink"])],
  ...Array.from(
    { length: 20 },
    (_, index) => [`bound-${index}`, taskDocument(["tasks"])] as const,
  ),
]);
const fixtureAuthority = authorialMaterialForTest({
  generation: "1",
  documents: new Map(
    [...fixtureDocuments].map(([name, document]) => [
      name,
      { document, rawBody: serializeCanvas(document) },
    ]),
  ),
});
const intentSha256 = fixtureAuthority.intentSha256;
const basis = Schema.decodeUnknownSync(IntentFactBasis, {
  onExcessProperty: "error",
})({
  kind: "authorial-intent",
  generation: "1",
  contentSha256: intentSha256,
});
const dependencyScope = (sink: { canvasName: string; nodeId: string }) =>
  createAuthorialTaskDependencyScopeCapability({
    authority: fixtureAuthority,
    authoringSink: sink,
  });

const seatOf = (digit: string, nodeId: string) => ({
  seatId: Schema.decodeUnknownSync(ActorSeatId)(`seat_${digit.repeat(64)}`),
  canvasName: CANVAS,
  nodeId,
});

const actor = seatOf("a", "builder");
const operator = { kind: "operator" as const, label: "operator" };

const message = (
  messageId: string,
  role: "user" | "agent",
  text: string,
  taskId?: string,
) => ({
  messageId,
  role,
  parts: [{ kind: "text" as const, text }],
  ...(taskId === undefined ? {} : { taskId }),
  contextId: CANVAS,
});

const seedInstallation = (installations: ReadonlyArray<InstallationIdValue>) =>
  state.transaction("test.seed-installations", (writer) => {
    for (const installation of installations) {
      writer.run(
        `INSERT INTO station_known_installations(installation_id, registered_at)
         VALUES (?, ?)`,
        [installation, observedAt],
      );
    }
    writer.run(
      `INSERT INTO station_installation(singleton, installation_id, created_at)
       VALUES (1, ?, ?)`,
      [cc, observedAt],
    );
    writer.run(
      `INSERT INTO station_configuration(
         singleton, role, host_id, agent_host_id,
         command_center_installation_id, supervised_preferred, configured_at
       ) VALUES (1, 'command-center', 'local', NULL, NULL, 1, ?)`,
      [observedAt],
    );
    // Twenty extra canvases (bound-N) so the residency-bound test has more
    // canvases than the world may hold. Each needs a document row in the head
    // portfolio: local work refuses a basis whose canvas is not in it.
    seedCanvasAuthority(writer, {
      generation: "1",
      documents: fixtureDocuments,
      at: observedAt,
    });
  });

/**
 * One `state.read`, two answers: what the world serves and what the SQLite
 * read path builds, off the SAME reader in the SAME snapshot. Reading them
 * apart would compare two different moments and prove nothing.
 */
const readBoth = () =>
  runtime.runPromise(
    state.read("test.world-differential", (reader) => {
      const workRevision = readCanvasWorkRevision(reader, CANVAS);
      const memory = world.projection(reader, CANVAS, workRevision);
      const sqlite = readCanvasWorkProjection(reader, CANVAS);
      return { workRevision, memory, sqlite };
    }),
  );

let lastRevision = "0";

/** Mutate, then require the world and SQLite to still agree. */
const differential = async (label: string, mutation: Promise<unknown>) => {
  await mutation;
  const { workRevision, memory, sqlite } = await readBoth();
  expect(
    { label, revisionMoved: workRevision !== lastRevision },
    `${label} must move the canvas work revision`,
  ).toEqual({ label, revisionMoved: true });
  expect(memory.workRevision, `${label} revision`).toBe(sqlite.workRevision);
  expect(memory.snapshots, `${label} snapshots`).toEqual(sqlite.snapshots);
  lastRevision = workRevision;
  return memory;
};

beforeAll(async () => {
  repository = await runtime.runPromise(WorkRepository);
  state = await runtime.runPromise(StateEngine);
  world = makeWorkWorld();
  await runtime.runPromise(seedInstallation([cc]));
});

afterAll(async () => {
  world.close();
  await runtime.dispose();
  await rm(root, { recursive: true, force: true });
});

describe("the in-memory factory world", () => {
  it("serves exactly what SQLite would have returned, after every lane", async () => {
    // Boot hydration: the world has never seen this canvas.
    const first = await readBoth();
    expect(first.memory.snapshots).toEqual(first.sqlite.snapshots);
    expect(world.stats().hydrate).toBe(1);

    await differential(
      "task.create",
      runtime.runPromise(
        repository.createTask({
          sink: { canvasName: CANVAS, nodeId: TASKS },
          basis,
          dependencyScope: dependencyScope({ canvasName: CANVAS, nodeId: TASKS }),
          task: {
            id: "task-1",
            state: "submitted",
            history: [message("brief-1", "user", "ship it", "task-1")],
          },
          originAt: observedAt,
          receivedAt: observedAt,
        }),
      ),
    );

    await differential(
      "task.transition",
      runtime.runPromise(
        repository.transitionTask({
          sink: { canvasName: CANVAS, nodeId: TASKS },
          basis,
          taskId: "task-1",
          state: "completed",
          originAt: observedAt,
          receivedAt: observedAt,
        }),
      ),
    );

    await differential(
      "request.create",
      runtime.runPromise(
        repository.createRequest({
          sink: { canvasName: CANVAS, nodeId: REQUESTS },
          basis,
          request: {
            id: "request-1",
            state: "input-required",
            claimedBy: actor.seatId,
            history: [message("ask-1", "agent", "which region?", "request-1")],
          },
          raisedBy: actor,
          originAt: observedAt,
          receivedAt: observedAt,
        }),
      ),
    );

    await differential(
      "request.resolve",
      runtime.runPromise(
        repository.resolveRequest({
          sink: { canvasName: CANVAS, nodeId: REQUESTS },
          basis,
          requestId: "request-1",
          response: "north",
          disposition: "completed",
          originAt: observedAt,
          receivedAt: observedAt,
        }),
      ),
    );

    await differential(
      "message.append",
      runtime.runPromise(
        repository.appendMessage({
          sink: { canvasName: CANVAS, nodeId: INBOX },
          basis,
          message: message("mail-1", "agent", "hello"),
          sentBy: actor,
          destination: { kind: "mailbox" },
          originAt: observedAt,
          receivedAt: observedAt,
        }),
      ),
    );

    await differential(
      "artifact.publish",
      runtime.runPromise(
        repository.publishArtifact({
          sink: { canvasName: CANVAS, nodeId: ARTIFACTS },
          basis,
          publishedBy: actor,
          artifact: {
            artifactId: "artifact-1",
            name: "proof",
            parts: [{ kind: "text", text: "receipt" }],
          },
          originAt: observedAt,
          receivedAt: observedAt,
        }),
      ),
    );

    await differential(
      "delivery.accept",
      runtime.runPromise(
        repository.acceptDelivery({
          sink: { canvasName: CANVAS, nodeId: ARTIFACTS },
          basis,
          receipt: {
            deliveryId: "delivery-1",
            deliveredItem: {
              kind: "artifact",
              itemId: "artifact-1",
              sink: { canvasName: CANVAS, nodeId: ARTIFACTS },
            },
            actor,
            acceptedAt: observedAt,
          },
          originAt: observedAt,
          receivedAt: observedAt,
        }),
      ),
    );

    await differential(
      "board.topic.create",
      runtime.runPromise(
        repository.createBoardTopic({
          sink: { canvasName: CANVAS, nodeId: BOARD },
          basis,
          topic: {
            topicId: "topic-1",
            title: "positions",
            state: "open",
            openedBy: operator,
            parts: [{ kind: "text", text: "opening" }],
            postCount: 0,
            openedAt: observedAt,
            lastActivityAt: observedAt,
          },
          createdBy: operator,
          originAt: observedAt,
          receivedAt: observedAt,
        }),
      ),
    );

    await differential(
      "board.post.append",
      runtime.runPromise(
        repository.appendBoardPost({
          sink: { canvasName: CANVAS, nodeId: BOARD },
          basis,
          post: {
            topicId: "topic-1",
            postId: "post-1",
            position: 1,
            author: operator,
            parts: [{ kind: "text", text: "a position" }],
            createdAt: observedAt,
          },
          createdBy: operator,
          originAt: observedAt,
          receivedAt: observedAt,
        }),
      ),
    );

    await differential(
      "pad.patch",
      runtime.runPromise(
        repository.applyPadPatch({
          sink: { canvasName: CANVAS, nodeId: PAD },
          basis,
          patchId: "patch-1",
          patches: [
            Schema.decodeUnknownSync(PadPatch)({
              op: "upsert",
              layer: "shape",
              shape: {
                id: "shape-1",
                type: "box",
                x: 0,
                y: 0,
                w: 10,
                h: 10,
                z: 1,
              },
            }),
          ],
          author: operator,
          originAt: observedAt,
          receivedAt: observedAt,
        }),
      ),
    );

    // Every one of those took the incremental path: only the announced sink
    // was re-read, never the canvas.
    const stats = world.stats();
    expect(stats.hydrate).toBe(1);
    expect(stats.coarse).toBe(0);
    expect(stats.incremental).toBeGreaterThanOrEqual(10);
  });

  it("re-reads only the sink a mutation touched", async () => {
    const before = world.stats();
    await runtime.runPromise(
      repository.appendMessage({
        sink: { canvasName: CANVAS, nodeId: INBOX },
        basis,
        message: message("mail-2", "agent", "second"),
        sentBy: actor,
        destination: { kind: "mailbox" },
        originAt: observedAt,
        receivedAt: observedAt,
      }),
    );
    const { memory, sqlite } = await readBoth();
    expect(memory.snapshots).toEqual(sqlite.snapshots);
    const after = world.stats();
    // Six sinks are resident; one message moved one of them.
    expect(after.sinks).toBeGreaterThanOrEqual(6);
    expect(after.sinksReloaded - before.sinksReloaded).toBe(1);
    expect(after.hydrate).toBe(before.hydrate);
  });

  it("serves the resident world when nothing changed", async () => {
    const before = world.stats();
    await readBoth();
    await readBoth();
    const after = world.stats();
    expect(after.resident - before.resident).toBe(2);
    expect(after.sinksReloaded).toBe(before.sinksReloaded);
  });

  it("keeps the operator paths that mint no journal record in step", async () => {
    await differential(
      "artifact.archive",
      runtime.runPromise(
        repository.setArtifactArchived({
          sink: { canvasName: CANVAS, nodeId: ARTIFACTS },
          artifactId: "artifact-1",
          archived: true,
        }),
      ),
    );
    await differential(
      "artifact.restore",
      runtime.runPromise(
        repository.setArtifactArchived({
          sink: { canvasName: CANVAS, nodeId: ARTIFACTS },
          artifactId: "artifact-1",
          archived: false,
        }),
      ),
    );
  });

  it("keeps a sink whose only task is archived, with an empty lane", async () => {
    // The membership subtlety the world has to get exactly right: an archived
    // task leaves `tasks.items` empty but keeps the `work_tasks` row, so the
    // node is STILL a sink. Dropping it would strip the authorial lanes off
    // that node in `projectWorkSnapshots` — a different document, not a
    // smaller one.
    const sink = { canvasName: CANVAS, nodeId: "archived-sink" };
    await differential(
      "task.create on the archive sink",
      runtime.runPromise(
        repository.createTask({
          sink,
          basis,
          dependencyScope: dependencyScope(sink),
          task: {
            id: "task-archived",
            state: "submitted",
            history: [message("brief-3", "user", "drop it", "task-archived")],
          },
          originAt: observedAt,
          receivedAt: observedAt,
        }),
      ),
    );
    const projection = await differential(
      "task.archive",
      runtime.runPromise(
        repository.transitionTask({
          sink,
          basis,
          taskId: "task-archived",
          state: "archived",
          originAt: observedAt,
          receivedAt: observedAt,
        }),
      ),
    );
    const archived = projection.snapshots.find(
      (snapshot) => snapshot.nodeId === "archived-sink",
    );
    expect(archived).toBeDefined();
    expect(archived?.tasks.items).toEqual([]);
  });

  it("drops a sink whose last projected row is deleted", async () => {
    const before = await readBoth();
    expect(
      before.memory.snapshots.some((snapshot) => snapshot.nodeId === ARTIFACTS),
    ).toBe(true);
    await runtime.runPromise(
      repository.deleteArtifact({
        sink: { canvasName: CANVAS, nodeId: ARTIFACTS },
        artifactId: "artifact-1",
      }),
    );
    const after = await readBoth();
    expect(after.memory.snapshots).toEqual(after.sqlite.snapshots);
    // The artifacts node still holds a delivery receipt, which is not a
    // membership table, so what matters is only that memory tracked SQLite.
    expect(
      after.memory.snapshots.map((snapshot) => snapshot.nodeId),
    ).toEqual(after.sqlite.snapshots.map((snapshot) => snapshot.nodeId));
  });

  it("admits a brand new sink in node_id order", async () => {
    // "aaa-sink" sorts before every sink seeded above, so a wrong insertion
    // order shows up as a different projection, not merely a different map.
    await differential(
      "task.create on a new sink",
      runtime.runPromise(
        repository.createTask({
          sink: { canvasName: CANVAS, nodeId: "aaa-sink" },
          basis,
          dependencyScope: dependencyScope({ canvasName: CANVAS, nodeId: "aaa-sink" }),
          task: {
            id: "task-2",
            state: "submitted",
            history: [message("brief-2", "user", "later", "task-2")],
          },
          originAt: observedAt,
          receivedAt: observedAt,
        }),
      ),
    );
    const { memory, sqlite } = await readBoth();
    expect(memory.snapshots.map((snapshot) => snapshot.nodeId)).toEqual(
      sqlite.snapshots.map((snapshot) => snapshot.nodeId),
    );
    expect(memory.snapshots[0]?.nodeId).toBe("aaa-sink");
  });

  it("is unmoved by a transaction that rolls back", async () => {
    const before = world.stats();
    const beforeRead = await readBoth();
    // A work row written and then abandoned. The revision trigger fired
    // inside the transaction and was rolled back with it, so the counter is
    // unchanged and the residency is still exact — the world must NOT
    // re-read on the strength of an announcement that describes nothing.
    await expect(
      runtime.runPromise(
        state.transaction("test.rolled-back", (writer) =>
          unjournaledWorkMutation("test.fixture-seed", () => {
            writer.run(
              `INSERT INTO work_messages(
                 canvas_name, node_id, message_id, position, entity_home,
                 actor_seat_id, fact_event_home, fact_entity_home, fact_seq,
                 role, parts_json, task_id, context_id,
                 reference_task_ids_json, metadata_json, origin_at, received_at
               ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?)`,
              [
                CANVAS,
                INBOX,
                "rolled-back-message",
                9_000_000,
                cc,
                cc,
                cc,
                "999999",
                "agent",
                JSON.stringify([{ kind: "text", text: "never" }]),
                observedAt,
                observedAt,
              ],
            );
            throw new Error("abandon this transaction");
          }),
        ),
      ),
    ).rejects.toThrow();
    const afterRead = await readBoth();
    expect(afterRead.workRevision).toBe(beforeRead.workRevision);
    expect(afterRead.memory.snapshots).toEqual(afterRead.sqlite.snapshots);
    const after = world.stats();
    expect(after.sinksReloaded).toBe(before.sinksReloaded);
    expect(after.hydrate).toBe(before.hydrate);
  });

  it("falls back to a full rebuild when a mutation names no sink", async () => {
    const before = world.stats();
    // A statement on a revision-trigger table whose sink cannot be read out
    // of it. The seam must announce "somewhere, unknown" rather than stay
    // silent, and the world must answer by rebuilding rather than trusting
    // a residency it can no longer repair sink by sink.
    await runtime.runPromise(
      state.transaction("test.unattributable", (writer) =>
        unjournaledWorkMutation("test.fixture-seed", () => {
          writer.run(
            `DELETE FROM work_messages WHERE message_id = 'no-such-message'`,
          );
        }),
      ),
    );
    const after = world.stats();
    expect(after.coarse - before.coarse).toBe(1);
    const read = await readBoth();
    expect(read.memory.snapshots).toEqual(read.sqlite.snapshots);
    expect(world.stats().hydrate).toBe(before.hydrate + 1);
  });

  it("rebuilds from SQLite when it is reset mid-session", async () => {
    world.reset();
    const { memory, sqlite } = await readBoth();
    expect(memory.snapshots).toEqual(sqlite.snapshots);
  });
});

describe("the world's residency bound", () => {
  it("holds a bounded set of canvases and rebuilds an evicted one correctly", async () => {
    const bounded = makeWorkWorld();
    try {
      // One task on each of many canvases, then read them all. The bound is
      // 16; twenty canvases must not leave twenty resident.
      const names = Array.from({ length: 20 }, (_, index) => `bound-${index}`);
      for (const canvasName of names) {
        await runtime.runPromise(
          repository.createTask({
            sink: { canvasName, nodeId: "tasks" },
            basis,
            dependencyScope: dependencyScope({ canvasName, nodeId: "tasks" }),
            task: {
              id: `task-${canvasName}`,
              state: "submitted",
              history: [message(`brief-${canvasName}`, "user", "x", `task-${canvasName}`)],
            },
            originAt: observedAt,
            receivedAt: observedAt,
          }),
        );
        await runtime.runPromise(
          state.read("test.bounded", (reader) => {
            const workRevision = readCanvasWorkRevision(reader, canvasName);
            const memory = bounded.projection(reader, canvasName, workRevision);
            const sqlite = readCanvasWorkProjection(reader, canvasName);
            expect(memory.snapshots).toEqual(sqlite.snapshots);
            return undefined;
          }),
        );
      }
      const stats = bounded.stats();
      expect(stats.canvases).toBeLessThanOrEqual(16);
      expect(stats.evicted).toBeGreaterThan(0);

      // The first canvas was evicted; reading it again must rebuild it from
      // SQLite and still match, with no stale residency left behind.
      const again = await runtime.runPromise(
        state.read("test.bounded-again", (reader) => {
          const workRevision = readCanvasWorkRevision(reader, names[0]);
          return {
            memory: bounded.projection(reader, names[0], workRevision),
            sqlite: readCanvasWorkProjection(reader, names[0]),
          };
        }),
      );
      expect(again.memory.snapshots).toEqual(again.sqlite.snapshots);
    } finally {
      bounded.close();
    }
  });
});
