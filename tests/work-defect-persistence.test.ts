// Deep-defect persistence proof: a targeted defect (s3 rejecting back to s1,
// skipping s2) physically preserves the skipped station's receipts. Receipt
// liveness is DERIVED (claims.ts receiptLive shadows receipts at/after the
// defect target) — so the durable rows must never be re-stamped or erased.
// This walks a real three-station line through the real SQLite repository via
// the same path the work service drives: policy workTaskTransition computes
// the forward/defectBack outputs, repository.forwardTask/defectBackTask
// persist them (see service.ts workTaskTransition wiring).
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context, Layer, ManagedRuntime, Schema } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
import type { CanvasDoc, CanvasNode } from "../src/shared/canvas";
import type { Task, TasksSinkContract } from "../src/shared/work-model";
import { workTaskTransition } from "../src/shared/work";
import { buildTaskJourney } from "../src/renderer/components/work/task-journey";

const root = join(tmpdir(), `vellum-command-defect-persistence-${randomUUID()}`);
const runtime = ManagedRuntime.make(
  Layer.provideMerge(
    WorkRepositoryLive,
    makeStateEngineLive(join(root, "vellum-command.db")),
  ),
);

let repository: Context.Service.Shape<typeof WorkRepository>;
let state: Context.Service.Shape<typeof StateEngine>;

const observedAt = "2026-08-21T09:00:00.000Z";
const cc = Schema.decodeUnknownSync(InstallationId)("cc-defect-persistence");
const currentIntentSha256 = "e".repeat(64);
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

const canvasName = "factory";
const s1 = { canvasName, nodeId: "s1" };
const s2 = { canvasName, nodeId: "s2" };
const s3 = { canvasName, nodeId: "s3" };
const taskId = "task-deep-defect";

// Distinct wall-clock stamps for each move on the line.
const T0 = "2026-08-21T09:00:00.000Z"; // created at s1
const T1 = "2026-08-21T10:00:00.000Z"; // s1 → s2
const T2 = "2026-08-21T11:00:00.000Z"; // s2 → s3
const T3 = "2026-08-21T12:00:00.000Z"; // s3 defects back to s1
const T4 = "2026-08-21T13:00:00.000Z"; // repaired s1 → s2
const T5 = "2026-08-21T14:00:00.000Z"; // repaired s2 → s3
const T6 = "2026-08-21T15:00:00.000Z"; // repaired s3 closes

const ids = (() => {
  let n = 0;
  return {
    id: () => `id-${++n}`,
    messageId: () => `msg-${++n}`,
  };
})();

const sinkNode = (
  id: string,
  items: ReadonlyArray<Task>,
  contract?: TasksSinkContract,
): CanvasNode => ({
  id,
  type: "text",
  text: "tasks",
  x: 2000,
  y: 2000,
  width: 100,
  height: 60,
  ether: {
    entity: { kind: "task" },
    tasks: {
      items: [...items],
      stationName: `${id} station`,
      ...(contract !== undefined ? { contract } : {}),
    },
  },
});

const flowEdge = (id: string, source: string, destination: string) => ({
  id,
  fromNode: source,
  toNode: destination,
  ether: { verb: "feeds" as const },
});

/**
 * The canvas the policy runs against: three task sinks chained by flow edges,
 * each sink's task items re-read from the durable repository rows — the
 * policy input is grounded in what SQLite actually holds, exactly like the
 * service's readCanvas projection.
 */
const docFromRepository = async (): Promise<CanvasDoc> => {
  const [at1, at2, at3] = await Promise.all(
    [s1, s2, s3].map((sink) =>
      runtime.runPromise(repository.readSnapshot(sink.canvasName, sink.nodeId)),
    ),
  );
  return {
    nodes: [
      sinkNode("s1", at1!.tasks.items, {
        claims: [{ id: "c-s1", text: "base plate is square", severity: "hard" }],
      }),
      sinkNode("s2", at2!.tasks.items, {
        claims: [{ id: "c-s2", text: "wiring is continuous", severity: "hard" }],
      }),
      sinkNode("s3", at3!.tasks.items),
    ],
    edges: [flowEdge("e1", "s1", "s2"), flowEdge("e2", "s2", "s3")],
  };
};

const taskAt = async (
  sink: { canvasName: string; nodeId: string },
  id: string,
): Promise<Task | undefined> => {
  const snapshot = await runtime.runPromise(
    repository.readSnapshot(sink.canvasName, sink.nodeId),
  );
  return snapshot.tasks.items.find((item) => item.id === id);
};

const rawPipelineBag = async (sink: {
  canvasName: string;
  nodeId: string;
}): Promise<Record<string, unknown> | undefined> => {
  const row = await runtime.runPromise(
    state.read("test.raw-metadata", (reader) =>
      reader.get<{ readonly metadata_json: string }>(
        `SELECT metadata_json FROM work_tasks
         WHERE canvas_name = ? AND node_id = ? AND task_id = ?`,
        [sink.canvasName, sink.nodeId, taskId],
      ),
    ),
  );
  const parsed = JSON.parse(row!.metadata_json) as Record<string, unknown>;
  return parsed["vellum.pipeline"] as Record<string, unknown> | undefined;
};

/**
 * Complete at `from` and persist the forward exactly as the service does:
 * policy computes the closed journey and the submitted successor, then
 * repository.forwardTask writes both rows atomically.
 */
const forwardThroughService = async (
  from: { canvasName: string; nodeId: string },
  evidence: NonNullable<Task["completionEvidence"]>,
  nowIso: string,
) => {
  const doc = await docFromRepository();
  const policy = workTaskTransition(
    doc,
    canvasName,
    from.nodeId,
    taskId,
    "completed",
    undefined,
    ids,
    evidence,
    { nowMs: Date.parse(nowIso) },
  );
  expect(policy.forwarded).toBeDefined();
  return runtime.runPromise(
    repository.forwardTask({
      sink: from,
      basis,
      taskId,
      completionEvidence: evidence,
      journey: policy.task.journey ?? [],
      destination: { canvasName, nodeId: policy.forwarded!.nodeId },
      destinationTask: policy.forwarded!.task,
      originAt: nowIso,
      receivedAt: nowIso,
    }),
  );
};

const s1Evidence = {
  artifacts: [],
  responses: [{ claimId: "c-s1", response: "measured square at s1" }],
};
const s2Evidence = {
  artifacts: [],
  responses: [{ claimId: "c-s2", response: "continuity checked at s2" }],
};

// Closed passages as the defect leaves them on the rejected s3 row.
const s1Passage = {
  nodeId: "s1",
  enteredAt: T0,
  epoch: 0,
  exitedAt: T1,
  exit: "forwarded",
  next: "s2",
};
const s2Passage = {
  nodeId: "s2",
  enteredAt: T1,
  epoch: 0,
  exitedAt: T2,
  exit: "forwarded",
  next: "s3",
};
const s3RejectedPassage = {
  nodeId: "s3",
  enteredAt: T2,
  epoch: 0,
  exitedAt: T3,
  exit: "rejected-back",
  next: "s1",
};
const expectedDefects = [{ epoch: 1, target: "s1", at: T3 }];

let s2RowBeforeDefect: Task | undefined;

describe("deep defect persistence", () => {
  it("walks one task down the three-station line, leaving receipts at s1 and s2", async () => {
    await runtime.runPromise(
      repository.createTask({
        sink: s1,
        basis,
        task: {
          id: taskId,
          state: "submitted",
          history: [
            {
              messageId: "m-brief",
              role: "user",
              parts: [{ kind: "text", text: "build the base plate" }],
            },
          ],
          epoch: 0,
          journey: [{ nodeId: "s1", enteredAt: T0, epoch: 0 }],
        },
        originAt: T0,
        receivedAt: T0,
      }),
    );

    await forwardThroughService(s1, s1Evidence, T1);
    await forwardThroughService(s2, s2Evidence, T2);

    const at1 = await taskAt(s1, taskId);
    expect(at1?.state).toBe("completed");
    expect(at1?.completionEvidence?.responses).toEqual(s1Evidence.responses);
    expect(at1?.journey).toEqual([s1Passage]);

    s2RowBeforeDefect = await taskAt(s2, taskId);
    expect(s2RowBeforeDefect?.state).toBe("completed");
    expect(s2RowBeforeDefect?.completionEvidence?.responses).toEqual(
      s2Evidence.responses,
    );
    expect(s2RowBeforeDefect?.journey).toEqual([s1Passage, s2Passage]);

    const at3 = await taskAt(s3, taskId);
    expect(at3?.state).toBe("submitted");
    expect(at3?.epoch).toBe(0);
    expect(at3?.journey?.at(-1)).toEqual({
      nodeId: "s3",
      enteredAt: T2,
      epoch: 0,
    });
  });

  it("defects from s3 back to s1 and physically preserves the skipped station's receipts", async () => {
    // The same path the service drives on tasks.update state=rejected with a
    // defect payload: policy computes the rejected row + re-opened target,
    // repository.defectBackTask persists both.
    const doc = await docFromRepository();
    const policy = workTaskTransition(
      doc,
      canvasName,
      "s3",
      taskId,
      "rejected",
      undefined,
      ids,
      undefined,
      {
        defect: {
          summary: "base plate is warped — rework the foundation",
          target: "s1",
        },
        nowMs: Date.parse(T3),
      },
    );
    expect(policy.defectBack?.nodeId).toBe("s1");
    const defectNote = policy.task.history.at(-1)!;
    await runtime.runPromise(
      repository.defectBackTask({
        sink: s3,
        basis,
        taskId,
        message: defectNote,
        journey: policy.task.journey ?? [],
        ...(policy.task.defects !== undefined
          ? { defects: policy.task.defects }
          : {}),
        previous: s1,
        returnedTask: policy.defectBack!.task,
        originAt: T3,
        receivedAt: T3,
      }),
    );

    // s2 — the skipped station — is byte-for-byte untouched: its receipts
    // physically survive; only DERIVED liveness shadows them.
    const s2After = await taskAt(s2, taskId);
    expect(s2After).toEqual(s2RowBeforeDefect);
    expect(s2After?.state).toBe("completed");
    expect(s2After?.completionEvidence?.responses).toEqual(
      s2Evidence.responses,
    );
    expect(s2After?.defects).toBeUndefined();

    // s1 re-opened: submitted, epoch-bumped, no completion evidence carried.
    const s1After = await taskAt(s1, taskId);
    expect(s1After?.state).toBe("submitted");
    expect(s1After?.epoch).toBe(1);
    expect(s1After?.claimedBy).toBeUndefined();
    expect(s1After?.completionEvidence).toBeUndefined();
    expect(s1After?.defects).toEqual(expectedDefects);
    expect(s1After?.journey).toEqual([
      s1Passage,
      s2Passage,
      s3RejectedPassage,
      { nodeId: "s1", enteredAt: T3, epoch: 1 },
    ]);

    // s3 rejected: the defect is on record and the journey is an appended
    // snapshot — the s1/s2 passages stand in order, nothing was replaced.
    const s3After = await taskAt(s3, taskId);
    expect(s3After?.state).toBe("rejected");
    expect(s3After?.defects).toEqual(expectedDefects);
    expect(s3After?.journey).toEqual([
      s1Passage,
      s2Passage,
      s3RejectedPassage,
    ]);

    // The defects log rides the reserved metadata bag on BOTH rows and is
    // lifted back as task.defects — physical persistence, not projection.
    const s3Bag = await rawPipelineBag(s3);
    expect(s3Bag?.defects).toEqual(expectedDefects);
    const s1Bag = await rawPipelineBag(s1);
    expect(s1Bag?.defects).toEqual(expectedDefects);
    // And the untouched s2 bag carries no defect stamp at all.
    const s2Bag = await rawPipelineBag(s2);
    expect(s2Bag?.defects).toBeUndefined();
  });

  it("projects the real defect accounting, then re-runs the line to terminal close", async () => {
    const defectedDoc = await docFromRepository();
    const returned = await taskAt(s1, taskId);
    const defectedView = buildTaskJourney(defectedDoc, returned!, "s1");

    expect(defectedView.layers.map((layer) => [layer.nodeId, layer.needsRedo])).toEqual([
      ["s1", true],
      ["s2", true],
      ["s3", false],
      ["s1", false],
    ]);
    expect(defectedView.layers[1]!.receiptState).toBe("superseded");
    expect(defectedView.layers[2]!.defect?.targetStation).toBe("s1 station");
    expect(defectedView.layers[3]!.epochDefect?.targetStation).toBe("s1 station");

    await forwardThroughService(s1, s1Evidence, T4);
    await forwardThroughService(s2, s2Evidence, T5);

    const beforeClose = await docFromRepository();
    const closeEvidence = { artifacts: [] };
    const closePolicy = workTaskTransition(
      beforeClose,
      canvasName,
      "s3",
      taskId,
      "completed",
      "repair line verified",
      ids,
      closeEvidence,
      { nowMs: Date.parse(T6) },
    );
    expect(closePolicy.forwarded).toBeUndefined();
    expect(closePolicy.task.state).toBe("completed");
    expect(closePolicy.task.journey?.at(-1)?.exit).toBe("closed");

    await runtime.runPromise(
      repository.transitionTask({
        sink: s3,
        basis,
        taskId,
        state: "completed",
        completionEvidence: closeEvidence,
        pipeline: {
          journey: closePolicy.task.journey ?? [],
          defects: closePolicy.task.defects,
        },
        originAt: T6,
        receivedAt: T6,
      }),
    );

    const closed = await taskAt(s3, taskId);
    expect(closed?.state).toBe("completed");
    const closedView = buildTaskJourney(await docFromRepository(), closed!, "s3");
    const currentEpochLayers = closedView.layers.filter((layer) => layer.epoch === 1);
    expect(currentEpochLayers.map((layer) => [layer.nodeId, layer.receiptState])).toEqual([
      ["s1", "live"],
      ["s2", "live"],
      ["s3", undefined],
    ]);
  });
});
