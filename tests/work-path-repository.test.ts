// Task path persistence proof: the (canvas_name, node_id, task_id) key stays
// untouched across re-homing — send-on inserts a successor row at the Next
// board, sent-back re-opens the previous board's row — and the
// path fields (rules/epoch/visits/waitUntil/checkResults) round-trip
// through the reserved metadata bag without any schema migration.
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context, Layer, ManagedRuntime, Schema } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ActorSeatId } from "../src/shared/actor-seat";
import { InstallationId } from "../src/shared/installation-id";
import {
  WorkRepository,
  WorkRepositoryLive,
} from "../src/main/vellum-command/work/repository";
import {
  makeStateEngineLive,
  StateEngine,
} from "../src/main/vellum-command/state/engine";
import { IntentFactBasis } from "../src/shared/work-protocol";
import { serializeCanvas, type CanvasDoc } from "../src/shared/canvas";
import type { Task } from "../src/shared/work-model";
import { seedCanvasAuthority } from "./helpers/canvas-authority-material";
import {
  authorialMaterialForTest,
  authorialTaskTopologyCapabilityForTest,
} from "./helpers/task-topology-authority";

const root = join(tmpdir(), `vellum-command-work-path-${randomUUID()}`);
const runtime = ManagedRuntime.make(
  Layer.provideMerge(
    WorkRepositoryLive,
    makeStateEngineLive(join(root, "junto.db")),
  ),
);

let repository: Context.Service.Shape<typeof WorkRepository>;
let state: Context.Service.Shape<typeof StateEngine>;

const observedAt = "2026-08-20T09:00:00.000Z";
const cc = Schema.decodeUnknownSync(InstallationId)("cc-work-path");
const authorityTopology: CanvasDoc = {
  nodes: ["build", "review"].map((id, index) => ({
    id,
    type: "text" as const,
    x: index * 240,
    y: 0,
    width: 180,
    height: 80,
    text: id,
    ether: { entity: { kind: "task" } },
  })),
  edges: [],
};
const authorityRawBody = serializeCanvas(authorityTopology);
const authorityMaterial = authorialMaterialForTest({
  generation: "1",
  documents: new Map([
    ["factory", { document: authorityTopology, rawBody: authorityRawBody }],
  ]),
});
const currentIntentSha256 = authorityMaterial.intentSha256;
const basis = Schema.decodeUnknownSync(IntentFactBasis, {
  onExcessProperty: "error",
})({
  kind: "authorial-intent",
  generation: "1",
  contentSha256: currentIntentSha256,
});
const dependencyScope = (sink: { canvasName: string; nodeId: string }) =>
  authorialTaskTopologyCapabilityForTest({
    basis,
    sink,
    document: authorityTopology,
    rawBody: authorityRawBody,
  });

const seed = () =>
  state.transaction("test.seed", (writer) => {
    writer.run(
      `INSERT INTO station_known_installations(installation_id, registered_at)
       VALUES (?, ?)`,
      [cc, observedAt],
    );
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
    seedCanvasAuthority(writer, {
      generation: "1",
      documents: new Map([["factory", authorityTopology]]),
      at: observedAt,
    });
  });

beforeAll(async () => {
  repository = await runtime.runPromise(WorkRepository);
  state = await runtime.runPromise(StateEngine);
  await runtime.runPromise(seed());
});

afterAll(async () => {
  await runtime.dispose();
  await rm(root, { recursive: true, force: true });
});

const s1 = { canvasName: "factory", nodeId: "build" };
const s2 = { canvasName: "factory", nodeId: "review" };

const taskAt = async (
  sink: { canvasName: string; nodeId: string },
  taskId: string,
): Promise<Task | undefined> => {
  const snapshot = await runtime.runPromise(
    repository.readSnapshot(sink.canvasName, sink.nodeId),
  );
  return snapshot.tasks.items.find((item) => item.id === taskId);
};

describe("task path persistence", () => {
  it("round-trips task fields through the reserved metadata bag", async () => {
    await runtime.runPromise(
      repository.createTask({
        sink: s1,
        basis,
        dependencyScope: dependencyScope(s1),
        task: {
          id: "task-bag",
          state: "submitted",
          history: [
            {
              messageId: "m-bag",
              role: "user",
              parts: [{ kind: "text", text: "carry the task path" }],
            },
          ],
          rules: [
            { id: "c-1", text: "prove the build", board: "review" },
          ],
          epoch: 0,
          visits: [{ board: "build", enteredAt: observedAt, epoch: 0 }],
          waitUntil: "2026-08-20T10:00:00.000Z",
          metadata: { origin: "test" },
        },
        originAt: observedAt,
        receivedAt: observedAt,
      }),
    );
    const task = await taskAt(s1, "task-bag");
    expect(task?.rules).toEqual([
      { id: "c-1", text: "prove the build", board: "review" },
    ]);
    expect(task?.epoch).toBe(0);
    expect(task?.visits).toEqual([
      { board: "build", enteredAt: observedAt, epoch: 0 },
    ]);
    expect(task?.waitUntil).toBe("2026-08-20T10:00:00.000Z");
    // The bag never leaks into the exposed metadata.
    expect(task?.metadata).toEqual({ origin: "test" });
    const row = await runtime.runPromise(
      state.read("test.raw-metadata", (reader) =>
        reader.get<{ readonly metadata_json: string }>(
          `SELECT metadata_json FROM work_tasks
           WHERE canvas_name = ? AND node_id = ? AND task_id = ?`,
          [s1.canvasName, s1.nodeId, "task-bag"],
        ),
      ),
    );
    const parsed = JSON.parse(row!.metadata_json) as Record<string, unknown>;
    expect(parsed["vellum.tasks"]).toBeDefined();
    expect(parsed.origin).toBe("test");
  });

  it("rejects authoring input that smuggles reserved task metadata", async () => {
    await expect(
      runtime.runPromise(
        repository.createTask({
          sink: s1,
          basis,
          dependencyScope: dependencyScope(s1),
          task: {
            id: "task-forged",
            state: "submitted",
            history: [
              {
                messageId: "m-forged",
                role: "user",
                parts: [{ kind: "text", text: "forged" }],
              },
            ],
            metadata: { "vellum.tasks": { epoch: 9 } },
          },
          originAt: observedAt,
          receivedAt: observedAt,
        }),
      ),
    ).rejects.toThrow(/reserved for the work service/);
  });

  it("sends on: the earlier row completes and a successor appears at the Next board", async () => {
    const visitsExit = [
      {
        board: "build",
        enteredAt: observedAt,
        epoch: 0,
        exitedAt: "2026-08-20T11:00:00.000Z",
        exit: "sent-on" as const,
        next: "review",
        handoffNote: "packaged for review",
      },
    ];
    const nextTask: Task = {
      id: "task-bag",
      state: "submitted",
      history: [
        {
          messageId: "m-bag-2",
          role: "user",
          parts: [{ kind: "text", text: "carry the task path" }],
        },
      ],
      rules: [
        { id: "c-1", text: "prove the build", board: "review" },
      ],
      epoch: 0,
      visits: [
        ...visitsExit,
        { board: "review", enteredAt: "2026-08-20T11:00:00.000Z", epoch: 0 },
      ],
      metadata: { origin: "test" },
    };
    const result = await runtime.runPromise(
      repository.sendTaskOn({
        sink: s1,
        basis,
        taskId: "task-bag",
        completionEvidence: {
          artifacts: [],
          claims: [{ ruleId: "c-other", text: "checked upstream" }],
        },
        visits: visitsExit,
        next: s2,
        nextTask,
        originAt: "2026-08-20T11:00:00.000Z",
        receivedAt: "2026-08-20T11:00:00.000Z",
      }),
    );
    expect(result.value.completed.state).toBe("completed");

    const completed = await taskAt(s1, "task-bag");
    expect(completed?.state).toBe("completed");
    expect(completed?.visits).toEqual(visitsExit);
    // Claims survive normalization into the completed visit record.
    expect(completed?.completionEvidence?.claims?.[0]?.ruleId).toBe("c-other");

    const atNext = await taskAt(s2, "task-bag");
    expect(atNext?.state).toBe("submitted");
    expect(atNext?.claimedBy).toBeUndefined();
    expect(atNext?.visits?.at(-1)?.board).toBe("review");
    expect(atNext?.epoch).toBe(0);
  });

  it("sends back: the current row rejects and the previous board re-opens", async () => {
    const rejectedVisits = [
      {
        board: "build",
        enteredAt: observedAt,
        epoch: 0,
        exitedAt: "2026-08-20T11:00:00.000Z",
        exit: "sent-on" as const,
        next: "review",
        handoffNote: "packaged for review",
      },
      {
        board: "review",
        enteredAt: "2026-08-20T11:00:00.000Z",
        epoch: 0,
        exitedAt: "2026-08-20T12:00:00.000Z",
        exit: "sent-back" as const,
        next: "build",
      },
    ];
    const sentBackTask: Task = {
      id: "task-bag",
      state: "submitted",
      history: [
        {
          messageId: "m-bag-3",
          role: "user",
          parts: [{ kind: "text", text: "carry the task path" }],
        },
        {
          messageId: "m-defect",
          role: "agent",
          parts: [{ kind: "text", text: 'defect from "review": misses the spec' }],
        },
      ],
      rules: [
        { id: "c-1", text: "prove the build", board: "review" },
      ],
      epoch: 1,
      visits: [
        ...rejectedVisits,
        { board: "build", enteredAt: "2026-08-20T12:00:00.000Z", epoch: 1 },
      ],
      metadata: { origin: "test" },
    };
    const result = await runtime.runPromise(
      repository.sendTaskBack({
        sink: s2,
        basis,
        taskId: "task-bag",
        visits: rejectedVisits,
        target: s1,
        sentBackTask,
        originAt: "2026-08-20T12:00:00.000Z",
        receivedAt: "2026-08-20T12:00:00.000Z",
      }),
    );
    expect(result.value.rejected.state).toBe("rejected");

    const rejected = await taskAt(s2, "task-bag");
    expect(rejected?.state).toBe("rejected");
    expect(rejected?.visits?.at(-1)?.exit).toBe("sent-back");

    const sentBack = await taskAt(s1, "task-bag");
    expect(sentBack?.state).toBe("submitted");
    expect(sentBack?.epoch).toBe(1);
    expect(sentBack?.claimedBy).toBeUndefined();
    expect(sentBack?.completionEvidence).toBeUndefined();
  });

  it("sends on again: re-opens the previously-rejected next board row as submitted", async () => {
    // Second visit to Review after the send-back cycle above: Review's
    // row is currently "rejected" (a closed visit record, not archived).
    // The generic transition matrix keeps rejected terminal for every other
    // caller, so this re-open must be authorized locally by sendTaskOn.
    const priorVisits = [
      {
        board: "build",
        enteredAt: observedAt,
        epoch: 0,
        exitedAt: "2026-08-20T11:00:00.000Z",
        exit: "sent-on" as const,
        next: "review",
        handoffNote: "packaged for review",
      },
      {
        board: "review",
        enteredAt: "2026-08-20T11:00:00.000Z",
        epoch: 0,
        exitedAt: "2026-08-20T12:00:00.000Z",
        exit: "sent-back" as const,
        next: "build",
      },
    ];
    const visitsExit = [
      ...priorVisits,
      {
        board: "build",
        enteredAt: "2026-08-20T12:00:00.000Z",
        epoch: 1,
        exitedAt: "2026-08-20T13:00:00.000Z",
        exit: "sent-on" as const,
        next: "review",
        handoffNote: "fixed the acceptance case",
      },
    ];
    const nextTask: Task = {
      id: "task-bag",
      state: "submitted",
      history: [
        {
          messageId: "m-bag-4",
          role: "user",
          parts: [{ kind: "text", text: "carry the task path" }],
        },
      ],
      rules: [
        { id: "c-1", text: "prove the build", board: "review" },
      ],
      epoch: 2,
      visits: [
        ...visitsExit,
        { board: "review", enteredAt: "2026-08-20T13:00:00.000Z", epoch: 2 },
      ],
      metadata: { origin: "test" },
    };
    const result = await runtime.runPromise(
      repository.sendTaskOn({
        sink: s1,
        basis,
        taskId: "task-bag",
        completionEvidence: {
          artifacts: [],
          claims: [{ ruleId: "c-other", text: "fixed and re-checked" }],
        },
        visits: visitsExit,
        next: s2,
        nextTask,
        originAt: "2026-08-20T13:00:00.000Z",
        receivedAt: "2026-08-20T13:00:00.000Z",
      }),
    );
    expect(result.value.completed.state).toBe("completed");

    const reopened = await taskAt(s2, "task-bag");
    expect(reopened?.state).toBe("submitted");
    expect(reopened?.claimedBy).toBeUndefined();
    expect(reopened?.epoch).toBe(2);
  });

  it("approves an approval-admission task with an epoch-scoped stamp", async () => {
    await runtime.runPromise(
      repository.createTask({
        sink: s2,
        basis,
        dependencyScope: dependencyScope(s2),
        task: {
          id: "task-gated",
          state: "submitted",
          history: [
            {
              messageId: "m-gated",
              role: "user",
              parts: [{ kind: "text", text: "await the operator" }],
            },
          ],
        },
        originAt: observedAt,
        receivedAt: observedAt,
      }),
    );
    await runtime.runPromise(
      repository.promoteTask({
        sink: s2,
        basis,
        taskId: "task-gated",
        originAt: observedAt,
        receivedAt: observedAt,
      }),
    );
    const promoted = await taskAt(s2, "task-gated");
    expect(promoted?.metadata?.["vellum.tasks.approvedEpoch"]).toBe(0);
    expect(promoted?.state).toBe("submitted");
  });

  it("passthrough admission and raisedBy; patches defects onto the durable row", async () => {
    const raisedBy = {
      seatId: Schema.decodeUnknownSync(ActorSeatId)(`seat_${"a".repeat(64)}`),
      canvasName: "factory",
      nodeId: "agent-1",
    };
    await runtime.runPromise(
      repository.createTask({
        sink: s1,
        basis,
        dependencyScope: dependencyScope(s1),
        task: {
          id: "task-pass",
          state: "submitted",
          history: [
            {
              messageId: "m-pass",
              role: "user",
              parts: [{ kind: "text", text: "keep overlay" }],
            },
          ],
          admission: "approval",
          raisedBy,
        },
        originAt: observedAt,
        receivedAt: observedAt,
      }),
    );
    const defects = [
      { epoch: 1, target: "build", at: "2026-08-20T12:00:00.000Z" },
    ];
    await runtime.runPromise(
      repository.transitionTask({
        sink: s1,
        basis,
        taskId: "task-pass",
        state: "completed",
        taskPatch: {
          visits: [
            {
              board: "build",
              enteredAt: observedAt,
              epoch: 0,
              exitedAt: "2026-08-20T12:00:00.000Z",
              exit: "completed",
            },
          ],
          defects,
        },
        originAt: "2026-08-20T12:00:00.000Z",
        receivedAt: "2026-08-20T12:00:00.000Z",
      }),
    );
    const after = await taskAt(s1, "task-pass");
    expect(after?.admission).toBe("approval");
    expect(after?.raisedBy).toEqual(raisedBy);
    expect(after?.defects).toEqual(defects);
    expect(after?.state).toBe("completed");
  });
});
