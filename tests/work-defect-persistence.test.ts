// Deep-defect persistence proof: a targeted defect (s3 sending back to s1,
// skipping s2) physically preserves the skipped board's receipts. Receipt
// liveness is DERIVED (rules.ts claimIsLive shadows receipts at/after the
// defect target) — so the durable rows must never be re-stamped or erased.
// This walks a real three-board path through the real SQLite repository via
// the same path the work service drives: policy workTaskTransition computes
// the sentOn/sentBack outputs, repository.sendTaskOn/sendTaskBack
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
} from "../src/main/junto/work/repository";
import {
  makeStateEngineLive,
  StateEngine,
} from "../src/main/junto/state/engine";
import { IntentFactBasis } from "../src/shared/work-protocol";
import {
  serializeCanvas,
  type CanvasDoc,
  type CanvasNode,
} from "../src/shared/canvas";
import type { Task, TasksContract } from "../src/shared/work-model";
import { workTaskTransition } from "../src/shared/work";
import { buildTaskVisits } from "../src/renderer/components/work/task-visits";
import {
  authorialMaterialForTest,
  authorialTaskTopologyCapabilityForTest,
} from "./helpers/task-topology-authority";
import { seedCanvasAuthority } from "./helpers/canvas-authority-material";

const root = join(tmpdir(), `junto-defect-persistence-${randomUUID()}`);
const runtime = ManagedRuntime.make(
  Layer.provideMerge(
    WorkRepositoryLive,
    makeStateEngineLive(join(root, "junto.db")),
  ),
);

let repository: Context.Service.Shape<typeof WorkRepository>;
let state: Context.Service.Shape<typeof StateEngine>;

const observedAt = "2026-08-21T09:00:00.000Z";
const cc = Schema.decodeUnknownSync(InstallationId)("cc-defect-persistence");
const authorityTopology: CanvasDoc = {
  nodes: ["s1", "s2", "s3"].map((id, index) => ({
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

const boardNode = (
  id: string,
  items: ReadonlyArray<Task>,
  contract?: TasksContract,
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
      name: id,
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
 * The canvas the policy runs against: three task boards chained by flow edges,
 * each board's task items re-read from the durable repository rows — the
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
      boardNode("s1", at1!.tasks.items, {
        rules: [{ id: "c-s1", text: "base plate is square" }],
      }),
      boardNode("s2", at2!.tasks.items, {
        rules: [{ id: "c-s2", text: "wiring is continuous" }],
      }),
      boardNode("s3", at3!.tasks.items),
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

const rawTaskBag = async (sink: {
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
  return parsed["junto.tasks"] as Record<string, unknown> | undefined;
};

/**
 * Complete at `from` and persist the send-on exactly as the service does:
 * policy computes the closed visits and the submitted successor, then
 * repository.sendTaskOn writes both rows atomically.
 */
const sendOnThroughService = async (
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
  expect(policy.sentOn).toBeDefined();
  return runtime.runPromise(
    repository.sendTaskOn({
      sink: from,
      basis,
      taskId,
      completionEvidence: evidence,
      visits: policy.task.visits ?? [],
      next: { canvasName, nodeId: policy.sentOn!.nodeId },
      nextTask: policy.sentOn!.task,
      originAt: nowIso,
      receivedAt: nowIso,
    }),
  );
};

const s1Evidence = {
  artifacts: [],
  claims: [{ ruleId: "c-s1", text: "measured square at s1" }],
};
const s2Evidence = {
  artifacts: [],
  claims: [{ ruleId: "c-s2", text: "continuity checked at s2" }],
};

// Closed visits as the defect leaves them on the rejected s3 row.
const s1Visit = {
  board: "s1",
  enteredAt: T0,
  epoch: 0,
  exitedAt: T1,
  exit: "sent-on",
  next: "s2",
};
const s2Visit = {
  board: "s2",
  enteredAt: T1,
  epoch: 0,
  exitedAt: T2,
  exit: "sent-on",
  next: "s3",
};
const s3RejectedVisit = {
  board: "s3",
  enteredAt: T2,
  epoch: 0,
  exitedAt: T3,
  exit: "sent-back",
  next: "s1",
};
const expectedDefects = [{ epoch: 1, target: "s1", at: T3 }];

let s2RowBeforeDefect: Task | undefined;

describe("deep defect persistence", () => {
  it("walks one task down the three-board line, leaving receipts at s1 and s2", async () => {
    await runtime.runPromise(
      repository.createTask({
        sink: s1,
        basis,
        dependencyScope: authorialTaskTopologyCapabilityForTest({
          basis,
          sink: s1,
          document: authorityTopology,
          rawBody: authorityRawBody,
        }),
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
          visits: [{ board: "s1", enteredAt: T0, epoch: 0 }],
        },
        originAt: T0,
        receivedAt: T0,
      }),
    );

    await sendOnThroughService(s1, s1Evidence, T1);
    await sendOnThroughService(s2, s2Evidence, T2);

    const at1 = await taskAt(s1, taskId);
    expect(at1?.state).toBe("completed");
    expect(at1?.completionEvidence?.claims).toEqual(s1Evidence.claims);
    expect(at1?.visits).toEqual([s1Visit]);

    s2RowBeforeDefect = await taskAt(s2, taskId);
    expect(s2RowBeforeDefect?.state).toBe("completed");
    expect(s2RowBeforeDefect?.completionEvidence?.claims).toEqual(
      s2Evidence.claims,
    );
    expect(s2RowBeforeDefect?.visits).toEqual([s1Visit, s2Visit]);

    const at3 = await taskAt(s3, taskId);
    expect(at3?.state).toBe("submitted");
    expect(at3?.epoch).toBe(0);
    expect(at3?.visits?.at(-1)).toEqual({
      board: "s3",
      enteredAt: T2,
      epoch: 0,
    });
  });

  it("defects from s3 back to s1 and physically preserves the skipped board's receipts", async () => {
    // The same path the service drives on tasks.update state=rejected with a
    // defect payload: policy computes the rejected row + re-opened target,
    // repository.sendTaskBack persists both.
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
    expect(policy.sentBack?.nodeId).toBe("s1");
    const defectNote = policy.task.history.at(-1)!;
    await runtime.runPromise(
      repository.sendTaskBack({
        sink: s3,
        basis,
        taskId,
        message: defectNote,
        visits: policy.task.visits ?? [],
        ...(policy.task.defects !== undefined
          ? { defects: policy.task.defects }
          : {}),
        target: s1,
        sentBackTask: policy.sentBack!.task,
        originAt: T3,
        receivedAt: T3,
      }),
    );

    // s2 — the skipped board — is byte-for-byte untouched: its receipts
    // physically survive; only DERIVED liveness shadows them.
    const s2After = await taskAt(s2, taskId);
    expect(s2After).toEqual(s2RowBeforeDefect);
    expect(s2After?.state).toBe("completed");
    expect(s2After?.completionEvidence?.claims).toEqual(
      s2Evidence.claims,
    );
    expect(s2After?.defects).toBeUndefined();

    // s1 re-opened: submitted, epoch-bumped, no completion evidence carried.
    const s1After = await taskAt(s1, taskId);
    expect(s1After?.state).toBe("submitted");
    expect(s1After?.epoch).toBe(1);
    expect(s1After?.claimedBy).toBeUndefined();
    expect(s1After?.completionEvidence).toBeUndefined();
    expect(s1After?.defects).toEqual(expectedDefects);
    expect(s1After?.visits).toEqual([
      s1Visit,
      s2Visit,
      s3RejectedVisit,
      { board: "s1", enteredAt: T3, epoch: 1 },
    ]);

    // s3 rejected: the defect is on record and the visit record is an appended
    // snapshot — the s1/s2 visits stand in order, nothing was replaced.
    const s3After = await taskAt(s3, taskId);
    expect(s3After?.state).toBe("rejected");
    expect(s3After?.defects).toEqual(expectedDefects);
    expect(s3After?.visits).toEqual([
      s1Visit,
      s2Visit,
      s3RejectedVisit,
    ]);

    // The defects log rides the reserved metadata bag on BOTH rows and is
    // lifted back as task.defects — physical persistence, not projection.
    const s3Bag = await rawTaskBag(s3);
    expect(s3Bag?.defects).toEqual(expectedDefects);
    const s1Bag = await rawTaskBag(s1);
    expect(s1Bag?.defects).toEqual(expectedDefects);
    // And the untouched s2 bag carries no defect stamp at all.
    const s2Bag = await rawTaskBag(s2);
    expect(s2Bag?.defects).toBeUndefined();
  });

  it("projects the real defect accounting, then re-runs the line to terminal close", async () => {
    const defectedDoc = await docFromRepository();
    const returned = await taskAt(s1, taskId);
    const defectedView = buildTaskVisits(defectedDoc, returned!, "s1");

    expect(defectedView.layers.map((layer) => [layer.boardId, layer.needsRedo])).toEqual([
      ["s1", true],
      ["s2", true],
      ["s3", false],
      ["s1", false],
    ]);
    expect(defectedView.layers[1]!.receiptState).toBe("superseded");
    expect(defectedView.layers[2]!.defect?.targetBoard).toBe("s1");
    expect(defectedView.layers[3]!.epochDefect?.targetBoard).toBe("s1");

    await sendOnThroughService(s1, s1Evidence, T4);
    await sendOnThroughService(s2, s2Evidence, T5);

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
    expect(closePolicy.sentOn).toBeUndefined();
    expect(closePolicy.task.state).toBe("completed");
    expect(closePolicy.task.visits?.at(-1)?.exit).toBe("completed");

    await runtime.runPromise(
      repository.transitionTask({
        sink: s3,
        basis,
        taskId,
        state: "completed",
        completionEvidence: closeEvidence,
        taskPatch: {
          visits: closePolicy.task.visits ?? [],
          defects: closePolicy.task.defects,
        },
        originAt: T6,
        receivedAt: T6,
      }),
    );

    const closed = await taskAt(s3, taskId);
    expect(closed?.state).toBe("completed");
    const closedView = buildTaskVisits(await docFromRepository(), closed!, "s3");
    const currentEpochLayers = closedView.layers.filter((layer) => layer.epoch === 1);
    expect(currentEpochLayers.map((layer) => [layer.boardId, layer.receiptState])).toEqual([
      ["s1", "live"],
      ["s2", "live"],
      ["s3", undefined],
    ]);
  });
});
