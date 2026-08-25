// Pipeline persistence proof: the (canvas_name, node_id, task_id) key stays
// untouched across re-homing — forward inserts a successor row at the
// destination, defect-back re-opens the previous station's row — and the
// pipeline fields (claims/epoch/journey/holdUntil/boarding) round-trip
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
} from "../src/main/vellum/work/repository";
import {
  makeStateEngineLive,
  StateEngine,
} from "../src/main/vellum/state/engine";
import { IntentFactBasis } from "../src/shared/work-protocol";
import type { Task } from "../src/shared/work-model";

const root = join(tmpdir(), `vellum-command-pipeline-repo-${randomUUID()}`);
const runtime = ManagedRuntime.make(
  Layer.provideMerge(
    WorkRepositoryLive,
    makeStateEngineLive(join(root, "vellum-command.db")),
  ),
);

let repository: Context.Service.Shape<typeof WorkRepository>;
let state: Context.Service.Shape<typeof StateEngine>;

const observedAt = "2026-08-20T09:00:00.000Z";
const cc = Schema.decodeUnknownSync(InstallationId)("cc-pipeline-repo");
const currentIntentSha256 = "d".repeat(64);
const basis = Schema.decodeUnknownSync(IntentFactBasis, {
  onExcessProperty: "error",
})({
  kind: "authorial-intent",
  generation: "1",
  contentSha256: currentIntentSha256,
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
    writer.run(
      `INSERT INTO canvas_generations(
         generation, created_at, cause, intent_sha256, document_count
       ) VALUES ('1', ?, 'test intent', ?, 1)`,
      [observedAt, currentIntentSha256],
    );
    writer.run(
      `INSERT INTO canvas_generation_documents(
         generation, name, body, sha256, modified_at
       ) VALUES ('1', 'factory', '{}', ?, ?)`,
      ["1".repeat(64), observedAt],
    );
    writer.run(`INSERT INTO canvas_head(singleton, generation) VALUES (1, '1')`);
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

const s1 = { canvasName: "factory", nodeId: "stage-1" };
const s2 = { canvasName: "factory", nodeId: "stage-2" };

const taskAt = async (
  sink: { canvasName: string; nodeId: string },
  taskId: string,
): Promise<Task | undefined> => {
  const snapshot = await runtime.runPromise(
    repository.readSnapshot(sink.canvasName, sink.nodeId),
  );
  return snapshot.tasks.items.find((item) => item.id === taskId);
};

describe("pipeline persistence", () => {
  it("round-trips pipeline fields through the reserved metadata bag", async () => {
    await runtime.runPromise(
      repository.createTask({
        sink: s1,
        basis,
        task: {
          id: "task-bag",
          state: "submitted",
          history: [
            {
              messageId: "m-bag",
              role: "user",
              parts: [{ kind: "text", text: "carry the pipeline" }],
            },
          ],
          claims: [
            { id: "c-1", text: "prove the build", severity: "hard", station: "stage-2" },
          ],
          epoch: 0,
          journey: [{ nodeId: "stage-1", enteredAt: observedAt, epoch: 0 }],
          holdUntil: "2026-08-20T10:00:00.000Z",
          metadata: { origin: "test" },
        },
        originAt: observedAt,
        receivedAt: observedAt,
      }),
    );
    const task = await taskAt(s1, "task-bag");
    expect(task?.claims).toEqual([
      { id: "c-1", text: "prove the build", severity: "hard", station: "stage-2" },
    ]);
    expect(task?.epoch).toBe(0);
    expect(task?.journey).toEqual([
      { nodeId: "stage-1", enteredAt: observedAt, epoch: 0 },
    ]);
    expect(task?.holdUntil).toBe("2026-08-20T10:00:00.000Z");
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
    expect(parsed["vellum.pipeline"]).toBeDefined();
    expect(parsed.origin).toBe("test");
  });

  it("rejects authoring input that smuggles reserved pipeline metadata", async () => {
    await expect(
      runtime.runPromise(
        repository.createTask({
          sink: s1,
          basis,
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
            metadata: { "vellum.pipeline": { epoch: 9 } },
          },
          originAt: observedAt,
          receivedAt: observedAt,
        }),
      ),
    ).rejects.toThrow(/reserved for the work service/);
  });

  it("forwards: source row completes as the passage record, successor row appears at the destination", async () => {
    const journeyExit = [
      {
        nodeId: "stage-1",
        enteredAt: observedAt,
        epoch: 0,
        exitedAt: "2026-08-20T11:00:00.000Z",
        exit: "forwarded" as const,
        next: "stage-2",
        emissionNote: "packaged for review",
      },
    ];
    const destinationTask: Task = {
      id: "task-bag",
      state: "submitted",
      history: [
        {
          messageId: "m-bag-2",
          role: "user",
          parts: [{ kind: "text", text: "carry the pipeline" }],
        },
      ],
      claims: [
        { id: "c-1", text: "prove the build", severity: "hard", station: "stage-2" },
      ],
      epoch: 0,
      journey: [
        ...journeyExit,
        { nodeId: "stage-2", enteredAt: "2026-08-20T11:00:00.000Z", epoch: 0 },
      ],
      metadata: { origin: "test" },
    };
    const result = await runtime.runPromise(
      repository.forwardTask({
        sink: s1,
        basis,
        taskId: "task-bag",
        completionEvidence: {
          artifacts: [],
          responses: [{ claimId: "c-other", response: "checked upstream" }],
        },
        journey: journeyExit,
        destination: s2,
        destinationTask,
        originAt: "2026-08-20T11:00:00.000Z",
        receivedAt: "2026-08-20T11:00:00.000Z",
      }),
    );
    expect(result.value.source.state).toBe("completed");

    const source = await taskAt(s1, "task-bag");
    expect(source?.state).toBe("completed");
    expect(source?.journey).toEqual(journeyExit);
    // Claim receipts survive normalization into the passage record.
    expect(source?.completionEvidence?.responses?.[0]?.claimId).toBe("c-other");

    const successor = await taskAt(s2, "task-bag");
    expect(successor?.state).toBe("submitted");
    expect(successor?.claimedBy).toBeUndefined();
    expect(successor?.journey?.at(-1)?.nodeId).toBe("stage-2");
    expect(successor?.epoch).toBe(0);
  });

  it("defect-back: current row rejects, the previous station row re-opens epoch-bumped", async () => {
    const rejectedJourney = [
      {
        nodeId: "stage-1",
        enteredAt: observedAt,
        epoch: 0,
        exitedAt: "2026-08-20T11:00:00.000Z",
        exit: "forwarded" as const,
        next: "stage-2",
        emissionNote: "packaged for review",
      },
      {
        nodeId: "stage-2",
        enteredAt: "2026-08-20T11:00:00.000Z",
        epoch: 0,
        exitedAt: "2026-08-20T12:00:00.000Z",
        exit: "rejected-back" as const,
        next: "stage-1",
      },
    ];
    const returnedTask: Task = {
      id: "task-bag",
      state: "submitted",
      history: [
        {
          messageId: "m-bag-3",
          role: "user",
          parts: [{ kind: "text", text: "carry the pipeline" }],
        },
        {
          messageId: "m-defect",
          role: "agent",
          parts: [{ kind: "text", text: 'defect from "stage-2": misses the spec' }],
        },
      ],
      claims: [
        { id: "c-1", text: "prove the build", severity: "hard", station: "stage-2" },
      ],
      epoch: 1,
      journey: [
        ...rejectedJourney,
        { nodeId: "stage-1", enteredAt: "2026-08-20T12:00:00.000Z", epoch: 1 },
      ],
      metadata: { origin: "test" },
    };
    const result = await runtime.runPromise(
      repository.defectBackTask({
        sink: s2,
        basis,
        taskId: "task-bag",
        journey: rejectedJourney,
        previous: s1,
        returnedTask,
        originAt: "2026-08-20T12:00:00.000Z",
        receivedAt: "2026-08-20T12:00:00.000Z",
      }),
    );
    expect(result.value.rejected.state).toBe("rejected");

    const rejected = await taskAt(s2, "task-bag");
    expect(rejected?.state).toBe("rejected");
    expect(rejected?.journey?.at(-1)?.exit).toBe("rejected-back");

    const returned = await taskAt(s1, "task-bag");
    expect(returned?.state).toBe("submitted");
    expect(returned?.epoch).toBe(1);
    expect(returned?.claimedBy).toBeUndefined();
    expect(returned?.completionEvidence).toBeUndefined();
  });

  it("forwards again: re-opens the previously-rejected destination row as submitted", async () => {
    // Second visit to stage-2 after the defect-back cycle above: stage-2's
    // row is currently "rejected" (a closed passage record, not archived).
    // The generic transition matrix keeps rejected terminal for every other
    // caller, so this re-open must be authorized locally by forwardTask.
    const priorJourney = [
      {
        nodeId: "stage-1",
        enteredAt: observedAt,
        epoch: 0,
        exitedAt: "2026-08-20T11:00:00.000Z",
        exit: "forwarded" as const,
        next: "stage-2",
        emissionNote: "packaged for review",
      },
      {
        nodeId: "stage-2",
        enteredAt: "2026-08-20T11:00:00.000Z",
        epoch: 0,
        exitedAt: "2026-08-20T12:00:00.000Z",
        exit: "rejected-back" as const,
        next: "stage-1",
      },
    ];
    const journeyExit = [
      ...priorJourney,
      {
        nodeId: "stage-1",
        enteredAt: "2026-08-20T12:00:00.000Z",
        epoch: 1,
        exitedAt: "2026-08-20T13:00:00.000Z",
        exit: "forwarded" as const,
        next: "stage-2",
        emissionNote: "fixed the acceptance case",
      },
    ];
    const destinationTask: Task = {
      id: "task-bag",
      state: "submitted",
      history: [
        {
          messageId: "m-bag-4",
          role: "user",
          parts: [{ kind: "text", text: "carry the pipeline" }],
        },
      ],
      claims: [
        { id: "c-1", text: "prove the build", severity: "hard", station: "stage-2" },
      ],
      epoch: 2,
      journey: [
        ...journeyExit,
        { nodeId: "stage-2", enteredAt: "2026-08-20T13:00:00.000Z", epoch: 2 },
      ],
      metadata: { origin: "test" },
    };
    const result = await runtime.runPromise(
      repository.forwardTask({
        sink: s1,
        basis,
        taskId: "task-bag",
        completionEvidence: {
          artifacts: [],
          responses: [{ claimId: "c-other", response: "fixed and re-checked" }],
        },
        journey: journeyExit,
        destination: s2,
        destinationTask,
        originAt: "2026-08-20T13:00:00.000Z",
        receivedAt: "2026-08-20T13:00:00.000Z",
      }),
    );
    expect(result.value.source.state).toBe("completed");

    const reopened = await taskAt(s2, "task-bag");
    expect(reopened?.state).toBe("submitted");
    expect(reopened?.claimedBy).toBeUndefined();
    expect(reopened?.epoch).toBe(2);
  });

  it("promotes an operator-gated arrival with an epoch-scoped stamp", async () => {
    await runtime.runPromise(
      repository.createTask({
        sink: s2,
        basis,
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
    expect(promoted?.metadata?.["vellum.pipeline.admittedEpoch"]).toBe(0);
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
          admission: "operator-gated",
          raisedBy,
        },
        originAt: observedAt,
        receivedAt: observedAt,
      }),
    );
    const defects = [
      { epoch: 1, target: "stage-1", at: "2026-08-20T12:00:00.000Z" },
    ];
    await runtime.runPromise(
      repository.transitionTask({
        sink: s1,
        basis,
        taskId: "task-pass",
        state: "completed",
        pipeline: {
          journey: [
            {
              nodeId: "stage-1",
              enteredAt: observedAt,
              epoch: 0,
              exitedAt: "2026-08-20T12:00:00.000Z",
              exit: "closed",
            },
          ],
          defects,
        },
        originAt: "2026-08-20T12:00:00.000Z",
        receivedAt: "2026-08-20T12:00:00.000Z",
      }),
    );
    const after = await taskAt(s1, "task-pass");
    expect(after?.admission).toBe("operator-gated");
    expect(after?.raisedBy).toEqual(raisedBy);
    expect(after?.defects).toEqual(defects);
    expect(after?.state).toBe("completed");
  });
});
