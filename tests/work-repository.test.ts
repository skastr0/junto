import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Context,
  Effect,
  Result,
  Layer,
  ManagedRuntime,
  Schema,
} from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ActorSeatId } from "../src/shared/actor-seat";
import { serializeCanvas, type CanvasDoc } from "../src/shared/canvas";
import { ContentRef } from "../src/shared/content";
import {
  InstallationId,
  type InstallationId as InstallationIdValue,
} from "../src/shared/installation-id";
import {
  workRecordContentSha256,
  WorkAuthorityError,
  WorkRepository,
  WorkRepositoryLive,
} from "../src/main/junto/work/repository";
import { subjectHashOf } from "../src/main/junto/work/review-subject-hash";
import {
  makeStateEngineLive,
  StateEngine,
} from "../src/main/junto/state/engine";
import {
  IntentFactBasis,
  type IntentFactBasis as IntentFactBasisValue,
} from "../src/shared/work-protocol";
import {
  authorialMaterialForTest,
  authorialTaskTopologyCapabilityForTest,
} from "./helpers/task-topology-authority";
import { seedCanvasAuthority } from "./helpers/canvas-authority-material";

const root = join(tmpdir(), `junto-work-v2-${randomUUID()}`);
const runtime = ManagedRuntime.make(
  Layer.provideMerge(
    WorkRepositoryLive,
    makeStateEngineLive(join(root, "junto.db")),
  ),
);

let repository: Context.Service.Shape<typeof WorkRepository>;
let state: Context.Service.Shape<typeof StateEngine>;

const observedAt = "2026-07-27T18:00:00.000Z";
const cc = Schema.decodeUnknownSync(InstallationId)("cc-repository");
const remote = Schema.decodeUnknownSync(InstallationId)("remote-repository");
const fixtureTaskSinkNodeIds: ReadonlyArray<string> = [
  "content-task-sink",
  "unconfigured-tasks",
  "basis-rejections",
  "tasks-local",
  "tasks-release",
  "tasks-qa-rejection",
  "basis-roundtrip",
  "tasks-remote",
  "tasks-pending",
  "artifact-source-tasks",
  "thread-tasks",
  "tasks-authority",
  "tasks-archive",
];
const fixtureTaskNode = (
  id: string,
  index: number,
): CanvasDoc["nodes"][number] => ({
  id,
  type: "text",
  x: 0,
  y: index * 120,
  width: 240,
  height: 100,
  text: id,
  ether: { entity: { kind: "task" } },
});
const fixtureTopology: CanvasDoc = {
  nodes: fixtureTaskSinkNodeIds.map(fixtureTaskNode),
  edges: [],
};
const fixtureTopologyBody = serializeCanvas(fixtureTopology);
const currentIntentSha256 = authorialMaterialForTest({
  generation: "1",
  documents: new Map([
    ["factory", { document: fixtureTopology, rawBody: fixtureTopologyBody }],
  ]),
}).intentSha256;
const staleIntentSha256 = currentIntentSha256;
const wrongIntentSha256 = "f".repeat(64);
const decodeIntentFactBasis = Schema.decodeUnknownSync(IntentFactBasis, {
  onExcessProperty: "error",
});
const authorialBasis = decodeIntentFactBasis({
  kind: "authorial-intent",
  generation: "1",
  contentSha256: currentIntentSha256,
});
const staleAuthorialBasis = decodeIntentFactBasis({
  kind: "authorial-intent",
  generation: "0",
  contentSha256: staleIntentSha256,
});
const wrongAuthorialBasis = decodeIntentFactBasis({
  kind: "authorial-intent",
  generation: "1",
  contentSha256: wrongIntentSha256,
});
const projectedBasis = decodeIntentFactBasis({
  kind: "projected-intent",
  generation: "1",
  contentSha256: currentIntentSha256,
});
const dependencyScope = (
  sink: { readonly canvasName: string; readonly nodeId: string },
  basis: IntentFactBasisValue = authorialBasis,
) =>
  authorialTaskTopologyCapabilityForTest({
    basis,
    sink,
    document: fixtureTopology,
    rawBody: fixtureTopologyBody,
  });

const actor = {
  seatId: Schema.decodeUnknownSync(ActorSeatId)(
    `seat_${"a".repeat(64)}`,
  ),
  canvasName: "factory",
  nodeId: "builder",
};

const artifactClaimant = {
  seatId: Schema.decodeUnknownSync(ActorSeatId)(
    `seat_${"b".repeat(64)}`,
  ),
  canvasName: "factory",
  nodeId: "artifact-task-worker",
};

const artifactPublisher = {
  seatId: Schema.decodeUnknownSync(ActorSeatId)(
    `seat_${"c".repeat(64)}`,
  ),
  canvasName: "factory",
  nodeId: "artifact-publisher",
};

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
  contextId: "factory",
});

const seedInstallations = (
  installations: ReadonlyArray<InstallationIdValue>,
  local: InstallationIdValue,
  engine: Context.Service.Shape<typeof StateEngine> = state,
) =>
  engine.transaction("test.seed-installations", (writer) => {
    for (const installation of installations) {
      writer.run(
        `
          INSERT INTO station_known_installations(
            installation_id,
            registered_at
          ) VALUES (?, ?)
        `,
        [installation, observedAt],
      );
    }
    writer.run(
      `
        INSERT INTO station_installation(
          singleton,
          installation_id,
          created_at
        ) VALUES (1, ?, ?)
      `,
      [local, observedAt],
    );
    writer.run(
      `
        INSERT INTO station_configuration(
          singleton,
          role,
          host_id,
          agent_host_id,
          command_center_installation_id,
          supervised_preferred,
          configured_at
        ) VALUES (1, 'command-center', 'local', NULL, NULL, 1, ?)
      `,
      [observedAt],
    );
    // Head-only relational authority: only the current generation "1" exists.
    // The stale generation "0" survives solely as literal basis values whose
    // rejection ("causal-conflict") is asserted below — a stale basis is
    // unresolvable by construction in the head-only world.
    seedCanvasAuthority(writer, {
      generation: "1",
      documents: new Map([["factory", fixtureTopology]]),
      at: observedAt,
    });
  });

beforeAll(async () => {
  repository = await runtime.runPromise(WorkRepository);
  state = await runtime.runPromise(StateEngine);
  await runtime.runPromise(seedInstallations([cc, remote], cc));
});

afterAll(async () => {
  await runtime.dispose();
  await rm(root, { recursive: true, force: true });
});

describe("WorkRepository v2 local authority", () => {
  it("persists ContentRef parts on new work writes", async () => {
    const isolatedRoot = join(tmpdir(), `junto-content-contract-${randomUUID()}`);
    const isolatedRuntime = ManagedRuntime.make(
      Layer.provideMerge(
        WorkRepositoryLive,
        makeStateEngineLive(join(isolatedRoot, "junto.db")),
      ),
    );
    try {
      const isolatedRepository = await isolatedRuntime.runPromise(WorkRepository);
      const isolatedState = await isolatedRuntime.runPromise(StateEngine);
      const isolatedInstallation = Schema.decodeUnknownSync(InstallationId)(
        "content-contract-cc",
      );
      await isolatedRuntime.runPromise(
        seedInstallations([isolatedInstallation], isolatedInstallation, isolatedState),
      );
      const contentRef = Schema.decodeUnknownSync(ContentRef)({
        sha256: "1".repeat(64),
        byteLength: 12_345,
        mediaType: "video/mp4",
        displayName: "clip.mp4",
      });
      const taskSink = { canvasName: "factory", nodeId: "content-task-sink" };
      const task = {
        id: "content-task-1",
        state: "submitted" as const,
        history: [
          {
            messageId: "content-task-brief",
            role: "user" as const,
            taskId: "content-task-1",
            contextId: "factory",
            parts: [
              { kind: "text" as const, text: "Review the clip" },
              { kind: "content" as const, ref: contentRef },
            ],
          },
        ],
      };
      await isolatedRuntime.runPromise(
        isolatedRepository.createTask({
          sink: taskSink,
          basis: authorialBasis,
          dependencyScope: dependencyScope(taskSink),
          task,
          originAt: observedAt,
          receivedAt: observedAt,
        }),
      );
      const snapshot = await isolatedRuntime.runPromise(
        isolatedRepository.readSnapshot(taskSink.canvasName, taskSink.nodeId),
      );
      expect(snapshot.tasks.items[0]?.history[0]?.parts).toEqual(task.history[0].parts);
      const storedTaskParts = await isolatedRuntime.runPromise(
        isolatedState.read("test.read-content-task-parts", (reader) =>
          reader.get<{ readonly parts_json: string }>(
            `SELECT parts_json FROM work_task_messages
             WHERE canvas_name = ? AND node_id = ? AND item_id = ?`,
            [taskSink.canvasName, taskSink.nodeId, task.id],
          )?.parts_json,
        ),
      );
      expect(storedTaskParts).toContain('"kind":"content"');
      expect(storedTaskParts).not.toContain("bytesBase64");
      const storedTaskFact = await isolatedRuntime.runPromise(
        isolatedState.read("test.read-content-task-fact", (reader) =>
          reader.get<{ readonly result_json: string }>(
            `SELECT facts.result_json
             FROM work_facts AS facts
             JOIN work_events AS events
               ON events.event_home = facts.event_home
              AND events.entity_home = facts.entity_home
              AND events.seq = facts.seq
             WHERE events.operation = 'task.create'
               AND events.item_id = ?`,
            [task.id],
          )?.result_json,
        ),
      );
      expect(storedTaskFact).toContain('"kind":"content"');
      expect(storedTaskFact).not.toContain("bytesBase64");

      const mailbox = { canvasName: "factory", nodeId: "content-mailbox" };
      const contentMessage = {
        messageId: "content-message-1",
        role: "agent" as const,
        parts: [{ kind: "content" as const, ref: contentRef }],
        contextId: "factory",
      };
      await isolatedRuntime.runPromise(
        isolatedRepository.appendMessage({
          sink: mailbox,
          basis: authorialBasis,
          message: contentMessage,
          sentBy: actor,
          destination: { kind: "mailbox" },
          originAt: observedAt,
          receivedAt: observedAt,
        }),
      );
      const storedMessageParts = await isolatedRuntime.runPromise(
        isolatedState.read("test.read-content-message-parts", (reader) =>
          reader.get<{ readonly parts_json: string }>(
            `SELECT parts_json FROM work_messages
             WHERE canvas_name = ? AND node_id = ? AND message_id = ?`,
            [mailbox.canvasName, mailbox.nodeId, contentMessage.messageId],
          )?.parts_json,
        ),
      );
      expect(storedMessageParts).toContain('"kind":"content"');
      expect(storedMessageParts).not.toContain("bytesBase64");

      const artifactSink = { canvasName: "factory", nodeId: "content-artifacts" };
      const artifact = {
        artifactId: "content-artifact-1",
        parts: [{ kind: "content" as const, ref: contentRef }],
      };
      await isolatedRuntime.runPromise(
        isolatedRepository.publishArtifact({
          sink: artifactSink,
          basis: authorialBasis,
          artifact,
          publishedBy: actor,
          originAt: observedAt,
          receivedAt: observedAt,
        }),
      );
      const storedArtifactParts = await isolatedRuntime.runPromise(
        isolatedState.read("test.read-content-artifact-parts", (reader) =>
          reader.get<{ readonly parts_json: string }>(
            `SELECT parts_json FROM work_artifacts
             WHERE canvas_name = ? AND node_id = ? AND artifact_id = ?`,
            [artifactSink.canvasName, artifactSink.nodeId, artifact.artifactId],
          )?.parts_json,
        ),
      );
      expect(storedArtifactParts).toContain('"kind":"content"');
      expect(storedArtifactParts).not.toContain("bytesBase64");
    } finally {
      await isolatedRuntime.dispose();
      await rm(isolatedRoot, { recursive: true, force: true });
    }
  });

  it("rejects unconfigured local mutation without writing any Work row", async () => {
    const unconfiguredRoot = join(
      tmpdir(),
      `junto-work-v2-unconfigured-${randomUUID()}`,
    );
    const unconfiguredRuntime = ManagedRuntime.make(
      Layer.provideMerge(
        WorkRepositoryLive,
        makeStateEngineLive(join(unconfiguredRoot, "junto.db")),
      ),
    );
    try {
      const unconfiguredRepository =
        await unconfiguredRuntime.runPromise(WorkRepository);
      const unconfiguredState =
        await unconfiguredRuntime.runPromise(StateEngine);
      const unconfiguredInstallation = Schema.decodeUnknownSync(
        InstallationId,
      )("unconfigured-repository");
      await unconfiguredRuntime.runPromise(
        unconfiguredState.transaction(
          "test.seed-unconfigured-installation",
          (writer) => {
            writer.run(
              `
                INSERT INTO station_known_installations(
                  installation_id,
                  registered_at
                ) VALUES (?, ?)
              `,
              [unconfiguredInstallation, observedAt],
            );
            writer.run(
              `
                INSERT INTO station_installation(
                  singleton,
                  installation_id,
                  created_at
                ) VALUES (1, ?, ?)
              `,
              [unconfiguredInstallation, observedAt],
            );
          },
        ),
      );

      const result = await unconfiguredRuntime.runPromise(
        unconfiguredRepository
          .createTask({
            sink: {
              canvasName: "factory",
              nodeId: "unconfigured-tasks",
            },
            basis: authorialBasis,
            dependencyScope: dependencyScope({
              canvasName: "factory",
              nodeId: "unconfigured-tasks",
            }),
            task: {
              id: "must-not-exist",
              state: "submitted",
              history: [
                message(
                  "must-not-exist-brief",
                  "user",
                  "deny before configuration",
                  "must-not-exist",
                ),
              ],
            },
            originAt: observedAt,
            receivedAt: observedAt,
          })
          .pipe(Effect.result),
      );
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure).toBeInstanceOf(WorkAuthorityError);
        expect(result.failure).toMatchObject({
          reason: "authority-mismatch",
        });
      }
      expect(
        await unconfiguredRuntime.runPromise(
          unconfiguredState.read(
            "test.read-unconfigured-work-counts",
            (reader) => ({
              sequences: reader.get<{ readonly count: number }>(
                "SELECT count(*) AS count FROM work_event_sequences",
              )!.count,
              records: reader.get<{ readonly count: number }>(
                "SELECT count(*) AS count FROM work_events",
              )!.count,
              tasks: reader.get<{ readonly count: number }>(
                "SELECT count(*) AS count FROM work_tasks",
              )!.count,
            }),
          ),
        ),
      ).toEqual({ sequences: 0, records: 0, tasks: 0 });
    } finally {
      await unconfiguredRuntime.dispose();
      await rm(unconfiguredRoot, { recursive: true, force: true });
    }
  });

  it("rejects stale, mismatched, and role-wrong intent bases transactionally", async () => {
    const sink = { canvasName: "factory", nodeId: "basis-rejections" };
    const persistedState = () =>
      state.read("test.read-rejected-basis-state", (reader) => ({
        lastSequence:
          reader.get<{ readonly last_seq: string }>(
            `
              SELECT last_seq
              FROM work_event_sequences
              WHERE event_home = ? AND entity_home = ?
            `,
            [cc, cc],
          )?.last_seq ?? null,
        events: reader.get<{ readonly count: number }>(
          `
            SELECT count(*) AS count
            FROM work_events
            WHERE item_canvas_name = ? AND item_node_id = ?
          `,
          [sink.canvasName, sink.nodeId],
        )!.count,
        facts: reader.get<{ readonly count: number }>(
          `
            SELECT count(*) AS count
            FROM work_facts AS fact
            JOIN work_events AS event
              ON event.event_home = fact.event_home
              AND event.entity_home = fact.entity_home
              AND event.seq = fact.seq
            WHERE event.item_canvas_name = ? AND event.item_node_id = ?
          `,
          [sink.canvasName, sink.nodeId],
        )!.count,
        tasks: reader.get<{ readonly count: number }>(
          `
            SELECT count(*) AS count
            FROM work_tasks
            WHERE canvas_name = ? AND node_id = ?
          `,
          [sink.canvasName, sink.nodeId],
        )!.count,
      }));
    const before = await runtime.runPromise(persistedState());

    for (const [taskId, basis, reason] of [
      ["stale-basis-task", staleAuthorialBasis, "causal-conflict"],
      ["wrong-hash-task", wrongAuthorialBasis, "causal-conflict"],
      ["wrong-role-task", projectedBasis, "authority-mismatch"],
    ] as const) {
      const result = await runtime.runPromise(
        repository
          .createTask({
            sink,
            basis,
            dependencyScope: dependencyScope(sink),
            task: {
              id: taskId,
              state: "submitted",
              history: [
                message(
                  `${taskId}-brief`,
                  "user",
                  "must not commit",
                  taskId,
                ),
              ],
            },
            originAt: observedAt,
            receivedAt: observedAt,
          })
          .pipe(Effect.result),
      );
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: {
          _tag: "WorkAuthorityError",
          reason,
        },
      });
    }

    expect(await runtime.runPromise(persistedState())).toEqual(before);
  });

  it("commits typed task facts on one full route with strict predecessors", async () => {
    const sink = { canvasName: "factory", nodeId: "tasks-local" };
    const created = await runtime.runPromise(
      repository.createTask({
        sink,
        basis: authorialBasis,
        dependencyScope: dependencyScope(sink),
        task: {
          id: "task-local",
          state: "submitted",
          history: [
            message("brief-local", "user", "ship SQLite", "task-local"),
          ],
        },
        originAt: observedAt,
        receivedAt: observedAt,
      }),
    );
    const claimed = await runtime.runPromise(
      repository.claimLocalTask({
        sink,
        basis: authorialBasis,
        dependencyScope: dependencyScope(sink),
        taskId: created.value.id,
        actor,
        originAt: observedAt,
        receivedAt: observedAt,
      }),
    );
    const completed = await runtime.runPromise(
      repository.transitionTask({
        sink,
        basis: authorialBasis,
        taskId: created.value.id,
        state: "completed",
        message: message(
          "done-local",
          "agent",
          "done",
          created.value.id,
        ),
        originAt: observedAt,
        receivedAt: observedAt,
      }),
    );

    expect(created.record.id.route).toEqual({
      eventHome: cc,
      entityHome: cc,
    });
    expect(created.record.id.seq).toBe("1");
    expect(created.record.predecessor).toBeNull();
    expect(claimed.record.id.seq).toBe("2");
    expect(claimed.record.predecessor).toEqual(created.record.id);
    expect(completed.record.id.seq).toBe("3");
    expect(completed.record.predecessor).toEqual(claimed.record.id);
    expect(claimed.value).toMatchObject({
      state: "working",
      claimedBy: actor.seatId,
    });

    const records = await runtime.runPromise(
      repository.recordsAfter({
        route: { eventHome: cc, entityHome: cc },
      }),
    );
    expect(records.map((record) => record.id.seq)).toEqual(["1", "2", "3"]);
    for (const record of records) {
      const {
        contentSha256: _contentSha256,
        originAt: _originAt,
        ...semantic
      } = record;
      expect(record.contentSha256).toBe(
        workRecordContentSha256(semantic),
      );
    }

    const snapshot = await runtime.runPromise(
      repository.readSnapshot(sink.canvasName, sink.nodeId),
    );
    expect(snapshot.tasks.items).toHaveLength(1);
    const { subjectHash, verdicts, ...persisted } = snapshot.tasks.items[0]!;
    expect(persisted).toEqual(completed.value);
    expect(verdicts).toEqual([]);
    expect(subjectHash).toBe(subjectHashOf({
      kind: "task",
      installationId: cc,
      ...sink,
      taskId: completed.value.id,
      epoch: completed.value.epoch ?? 0,
    }));
    expect(
      await runtime.runPromise(
        repository.itemHome("task", sink.canvasName, sink.nodeId, "task-local"),
      ),
    ).toBe(cc);
  });

  it("refuses task creation on an unknown dependency and persists nothing", async () => {
    const sink = { canvasName: "factory", nodeId: "tasks-local" };
    const before = await runtime.runPromise(
      repository.readSnapshot(sink.canvasName, sink.nodeId),
    );

    const refused = await runtime.runPromise(
      repository
        .createTask({
          sink,
          basis: authorialBasis,
          dependencyScope: dependencyScope(sink),
          task: {
            id: "task-unknown-dep",
            state: "submitted",
            dependsOn: ["task-not-authored-anywhere"],
            history: [
              message("brief-unknown-dep", "user", "never claimable", "task-unknown-dep"),
            ],
          },
          originAt: observedAt,
          receivedAt: observedAt,
        })
        .pipe(Effect.result),
    );
    expect(refused).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "WorkAuthorityError", reason: "invalid-transition" },
    });

    // Nothing persisted: the snapshot is byte-identical and no fact row exists.
    expect(await runtime.runPromise(repository.readSnapshot(sink.canvasName, sink.nodeId)))
      .toEqual(before);
    const facts = await runtime.runPromise(
      state.read("test.read-unknown-dep-facts", (reader) =>
        reader.get<{ readonly n: number }>(
          `SELECT COUNT(*) AS n FROM work_events WHERE item_id = ?`,
          ["task-unknown-dep"],
        ),
      ),
    );
    expect(facts?.n).toBe(0);
  });

  it("atomically clears the claimant when active work returns to Queue", async () => {
    const sink = { canvasName: "factory", nodeId: "tasks-release" };
    const created = await runtime.runPromise(
      repository.createTask({
        sink,
        basis: authorialBasis,
        dependencyScope: dependencyScope(sink),
        task: {
          id: "task-release",
          state: "submitted",
          history: [
            message("brief-release", "user", "release this task", "task-release"),
          ],
        },
        originAt: observedAt,
        receivedAt: observedAt,
      }),
    );
    await runtime.runPromise(
      repository.claimLocalTask({
        sink,
        basis: authorialBasis,
        dependencyScope: dependencyScope(sink),
        taskId: created.value.id,
        actor,
        originAt: observedAt,
        receivedAt: observedAt,
      }),
    );

    const released = await runtime.runPromise(
      repository.transitionTask({
        sink,
        basis: authorialBasis,
        taskId: created.value.id,
        state: "submitted",
        originAt: observedAt,
        receivedAt: observedAt,
      }),
    );

    expect(released.value.state).toBe("submitted");
    expect(released.value.claimedBy).toBeUndefined();
    const snapshot = await runtime.runPromise(
      repository.readSnapshot(sink.canvasName, sink.nodeId),
    );
    expect(snapshot.tasks.items[0]).toMatchObject({
      id: created.value.id,
      state: "submitted",
    });
    expect(snapshot.tasks.items[0]?.claimedBy).toBeUndefined();
  });

  it("requires a QA comment when completed work returns to Queue and persists the count", async () => {
    const sink = { canvasName: "factory", nodeId: "tasks-qa-rejection" };
    const created = await runtime.runPromise(
      repository.createTask({
        sink,
        basis: authorialBasis,
        dependencyScope: dependencyScope(sink),
        task: {
          id: "task-qa-rejection",
          state: "submitted",
          history: [
            message("brief-qa-rejection", "user", "verify the release", "task-qa-rejection"),
          ],
        },
        originAt: observedAt,
        receivedAt: observedAt,
      }),
    );
    await runtime.runPromise(
      repository.claimLocalTask({
        sink,
        basis: authorialBasis,
        dependencyScope: dependencyScope(sink),
        taskId: created.value.id,
        actor,
        originAt: observedAt,
        receivedAt: observedAt,
      }),
    );
    await runtime.runPromise(
      repository.transitionTask({
        sink,
        basis: authorialBasis,
        taskId: created.value.id,
        state: "completed",
        message: message("done-qa-rejection", "agent", "done", created.value.id),
        completionEvidence: {
          artifacts: [
            { artifactId: "qa-rejection-artifact", nodeId: "qa-rejection-sink" },
          ],
        },
        originAt: observedAt,
        receivedAt: observedAt,
      }),
    );

    // Durable evidence exists at this point — that is what the rejection below
    // must clear, and what a merge-keep would silently resurrect.
    const whileCompleted = await runtime.runPromise(
      repository.readSnapshot(sink.canvasName, sink.nodeId),
    );
    expect(
      whileCompleted.tasks.items.find((c) => c.id === created.value.id)
        ?.completionEvidence,
    ).toMatchObject({
      artifacts: [{ artifactId: "qa-rejection-artifact" }],
    });

    const missingComment = await runtime.runPromise(
      repository
        .transitionTask({
          sink,
          basis: authorialBasis,
          taskId: created.value.id,
          state: "submitted",
          originAt: observedAt,
          receivedAt: observedAt,
        })
        .pipe(Effect.result),
    );
    expect(missingComment).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "WorkAuthorityError", reason: "invalid-transition" },
    });

    const rejected = await runtime.runPromise(
      repository.transitionTask({
        sink,
        basis: authorialBasis,
        taskId: created.value.id,
        state: "submitted",
        message: message(
          "qa-rejection",
          "user",
          "The release receipt is missing.",
          created.value.id,
        ),
        originAt: observedAt,
        receivedAt: observedAt,
      }),
    );
    expect(rejected.value).toMatchObject({
      state: "submitted",
      metadata: { rejectedTimes: 1 },
    });
    expect(rejected.value.claimedBy).toBeUndefined();
    expect(rejected.value.completionEvidence).toBeUndefined();
    expect(rejected.value.history.at(-1)).toMatchObject({
      parts: [{ kind: "text", text: "The release receipt is missing." }],
    });

    // The returned value is not the whole story. transitionTask strips evidence,
    // but the durable row is written by writeTaskFinish, which cannot tell a
    // deliberate clear from an omitted field. If it merge-keeps, taskFromRow
    // re-attaches the stale evidence and the projection ships a task violating
    // work-model.ts:218 (evidence only on completed tasks). The read path no
    // longer strict-decodes, so that corruption would be silent.
    const readBack = await runtime.runPromise(
      repository.readSnapshot(sink.canvasName, sink.nodeId),
    );
    const projected = readBack.tasks.items.find(
      (candidate) => candidate.id === created.value.id,
    );
    expect(projected?.state).toBe("submitted");
    expect(projected?.completionEvidence).toBeUndefined();
  });

  it("roundtrips the exact immutable intent basis on an emitted fact", async () => {
    const sink = { canvasName: "factory", nodeId: "basis-roundtrip" };
    const created = await runtime.runPromise(
      repository.createTask({
        sink,
        basis: authorialBasis,
        dependencyScope: dependencyScope(sink),
        task: {
          id: "basis-roundtrip-task",
          state: "submitted",
          history: [
            message(
              "basis-roundtrip-brief",
              "user",
              "retain the admitting intent",
              "basis-roundtrip-task",
            ),
          ],
        },
        originAt: observedAt,
        receivedAt: observedAt,
      }),
    );

    expect(created.record.basis).toEqual(authorialBasis);
    const stored = (
      await runtime.runPromise(
        repository.recordsAfter({
          route: created.record.id.route,
        }),
      )
    ).find(
      (record) =>
        record.id.seq === created.record.id.seq &&
        record.contentSha256 === created.record.contentSha256,
    );
    expect(stored).toEqual(created.record);
    expect(stored?.recordType).toBe("fact");
    if (stored?.recordType === "fact") {
      expect(stored.basis).toEqual(authorialBasis);
    }
  });

  it("persists a remote claim attempt without assigning or starting the source task", async () => {
    const sink = { canvasName: "factory", nodeId: "tasks-remote" };
    const created = await runtime.runPromise(
      repository.createTask({
        sink,
        basis: authorialBasis,
        dependencyScope: dependencyScope(sink),
        task: {
          id: "task-remote",
          state: "submitted",
          history: [
            message("brief-remote", "user", "run remotely", "task-remote"),
          ],
        },
        originAt: observedAt,
        receivedAt: observedAt,
      }),
    );
    const command = await runtime.runPromise(
      repository.reserveRemoteTaskClaim({
        targetInstallationId: remote,
        sink,
        basis: authorialBasis,
        dependencyScope: dependencyScope(sink),
        taskId: created.value.id,
        actor,
        originAt: observedAt,
        receivedAt: observedAt,
      }),
    );

    expect(command).toMatchObject({
      recordType: "command",
      operation: "task.claim",
      predecessor: null,
      id: {
        route: {
          eventHome: cc,
          entityHome: remote,
        },
        seq: "1",
      },
      body: {
        sourceQueueHome: cc,
        sourcePredecessor: created.record.id,
        sourceTask: { state: "submitted" },
        targetHome: remote,
        actor,
      },
    });
    const source = (
      await runtime.runPromise(
        repository.readSnapshot(sink.canvasName, sink.nodeId),
      )
    ).tasks.items[0]!;
    expect(source.state).toBe("submitted");
    expect(source.claimedBy).toBeUndefined();
    const pending = await runtime.runPromise(repository.pendingCommands);
    expect(
      pending.find((entry) => entry.command.contentSha256 === command.contentSha256),
    ).toMatchObject({ resolution: undefined });
  });

  it("reserves an ActorSeatId once across pending and active work", async () => {
    const pendingSink = { canvasName: "factory", nodeId: "tasks-pending" };
    await runtime.runPromise(
      repository.createTask({
        sink: pendingSink,
        basis: authorialBasis,
        dependencyScope: dependencyScope(pendingSink),
        task: {
          id: "task-pending-actor",
          state: "submitted",
          history: [
            message(
              "brief-pending-actor",
              "user",
              "wait",
              "task-pending-actor",
            ),
          ],
        },
        originAt: observedAt,
        receivedAt: observedAt,
      }),
    );
    const contention = await runtime.runPromise(
      repository
        .claimLocalTask({
          sink: pendingSink,
          basis: authorialBasis,
          dependencyScope: dependencyScope(pendingSink),
          taskId: "task-pending-actor",
          actor,
          originAt: observedAt,
          receivedAt: observedAt,
        })
        .pipe(Effect.result),
    );
    expect(Result.isFailure(contention)).toBe(true);
    if (Result.isFailure(contention)) {
      expect(contention.failure).toBeInstanceOf(WorkAuthorityError);
      expect(contention.failure).toMatchObject({
        reason: "claim-contention",
      });
    }
  });

  it("normalizes requests, inbox messages, artifacts, and delivery receipts", async () => {
    const requestSink = { canvasName: "factory", nodeId: "requests" };
    const inbox = { canvasName: "factory", nodeId: "inbox" };
    const artifacts = { canvasName: "factory", nodeId: "artifacts" };
    const request = await runtime.runPromise(
      repository.createRequest({
        sink: requestSink,
        basis: authorialBasis,
        raisedBy: actor,
        request: {
          id: "request-1",
          state: "input-required",
          claimedBy: actor.seatId,
          history: [
            message("request-brief", "agent", "Need input", "request-1"),
          ],
        },
        originAt: observedAt,
        receivedAt: observedAt,
      }),
    );
    await runtime.runPromise(
      repository.resolveRequest({
        sink: requestSink,
        basis: authorialBasis,
        requestId: request.value.id,
        response: "Approved",
        disposition: "completed",
        message: message("request-answer", "user", "Approved", "request-1"),
        originAt: observedAt,
        receivedAt: observedAt,
      }),
    );
    await runtime.runPromise(
      repository.appendMessage({
        sink: inbox,
        basis: authorialBasis,
        message: message("mail-1", "agent", "hello", "mail-context-task"),
        sentBy: actor,
        destination: { kind: "mailbox" },
        originAt: observedAt,
        receivedAt: observedAt,
      }),
    );
    const artifact = await runtime.runPromise(
      repository.publishArtifact({
        sink: artifacts,
        basis: authorialBasis,
        publishedBy: actor,
        artifact: {
          artifactId: "artifact-1",
          name: "proof",
          parts: [{ kind: "text", text: "receipt" }],
        },
        originAt: observedAt,
        receivedAt: observedAt,
      }),
    );
    expect(
      await runtime.runPromise(
        repository.hasAcceptedDelivery(artifacts, "delivery-1"),
      ),
    ).toBe(false);
    await runtime.runPromise(
      repository.acceptDelivery({
        sink: artifacts,
        basis: authorialBasis,
        receipt: {
          deliveryId: "delivery-1",
          deliveredItem: {
            kind: "artifact",
            itemId: artifact.value.artifactId,
            sink: artifacts,
          },
          actor,
          acceptedAt: observedAt,
        },
        originAt: observedAt,
        receivedAt: observedAt,
      }),
    );
    expect(
      await runtime.runPromise(
        repository.hasAcceptedDelivery(artifacts, "delivery-1"),
      ),
    ).toBe(true);

    expect(
      (
        await runtime.runPromise(
          repository.readSnapshot(requestSink.canvasName, requestSink.nodeId),
        )
      ).requests.items[0],
    ).toMatchObject({ state: "completed", response: "Approved" });
    expect(
      (
        await runtime.runPromise(
          repository.readSnapshot(inbox.canvasName, inbox.nodeId),
        )
      ).messages.items,
    ).toEqual([
      message("mail-1", "agent", "hello", "mail-context-task"),
    ]);
    expect(
      await runtime.runPromise(
        state.read(
          "test.read-message-sender",
          (reader) =>
            reader.get<{ readonly actor_seat_id: string }>(
              `
                SELECT actor_seat_id
                FROM work_messages
                WHERE canvas_name = ? AND node_id = ? AND message_id = ?
              `,
              [inbox.canvasName, inbox.nodeId, "mail-1"],
            )?.actor_seat_id,
        ),
      ),
    ).toBe(actor.seatId);
    expect(
      (
        await runtime.runPromise(
          repository.readSnapshot(artifacts.canvasName, artifacts.nodeId),
        )
      ).artifacts.items,
    ).toEqual([
      // Projection-only publisher stamp (mirrors mailbox deliveredAt/readAt).
      {
        ...artifact.value,
        metadata: { publishedBySeatId: actor.seatId },
      },
    ]);
  });

  it("lists artifacts newest first by publication timestamp", async () => {
    const sink = { canvasName: "factory", nodeId: "artifacts-latest-first" };
    await runtime.runPromise(
      repository.publishArtifact({
        sink,
        basis: authorialBasis,
        publishedBy: actor,
        artifact: {
          artifactId: "artifact-older",
          name: "older",
          parts: [{ kind: "text", text: "older" }],
        },
        originAt: "2026-07-27T18:00:00.000Z",
        receivedAt: "2026-07-27T18:00:01.000Z",
      }),
    );
    await runtime.runPromise(
      repository.publishArtifact({
        sink,
        basis: authorialBasis,
        publishedBy: actor,
        artifact: {
          artifactId: "artifact-newer",
          name: "newer",
          parts: [{ kind: "text", text: "newer" }],
        },
        originAt: "2026-07-27T19:00:00.000Z",
        receivedAt: "2026-07-27T19:00:01.000Z",
      }),
    );

    const snapshot = await runtime.runPromise(
      repository.readSnapshot(sink.canvasName, sink.nodeId),
    );
    expect(snapshot.artifacts.items.map((item) => item.artifactId)).toEqual([
      "artifact-newer",
      "artifact-older",
    ]);
  });

  it("links artifact provenance to one exact claimed same-home task", async () => {
    const taskSink = {
      canvasName: "factory",
      nodeId: "artifact-source-tasks",
    };
    const artifactSink = {
      canvasName: "factory",
      nodeId: "artifact-task-links",
    };
    const created = await runtime.runPromise(
      repository.createTask({
        sink: taskSink,
        basis: authorialBasis,
        dependencyScope: dependencyScope(taskSink),
        task: {
          id: "artifact-source-task",
          state: "submitted",
          history: [
            message(
              "artifact-source-brief",
              "user",
              "produce proof",
              "artifact-source-task",
            ),
          ],
        },
        originAt: observedAt,
        receivedAt: observedAt,
      }),
    );
    const task = {
      kind: "task" as const,
      itemId: created.value.id,
      sink: taskSink,
    };

    const beforeClaim = await runtime.runPromise(
      repository
        .publishArtifact({
          sink: artifactSink,
          basis: authorialBasis,
          publishedBy: artifactPublisher,
          artifact: {
            artifactId: "artifact-before-claim",
            parts: [{ kind: "text", text: "too early" }],
            task,
          },
          originAt: observedAt,
          receivedAt: observedAt,
        })
        .pipe(Effect.result),
    );
    expect(Result.isFailure(beforeClaim)).toBe(true);
    if (Result.isFailure(beforeClaim)) {
      expect(beforeClaim.failure).toMatchObject({
        reason: "invalid-transition",
      });
    }

    await runtime.runPromise(
      repository.claimLocalTask({
        sink: taskSink,
        basis: authorialBasis,
        dependencyScope: dependencyScope(taskSink),
        taskId: created.value.id,
        actor: artifactClaimant,
        originAt: observedAt,
        receivedAt: observedAt,
      }),
    );
    const published = await runtime.runPromise(
      repository.publishArtifact({
        sink: artifactSink,
        basis: authorialBasis,
        publishedBy: artifactPublisher,
        artifact: {
          artifactId: "artifact-with-task",
          name: "proof",
          parts: [{ kind: "text", text: "done" }],
          task,
        },
        originAt: observedAt,
        receivedAt: observedAt,
      }),
    );
    expect(published.value.task).toEqual(task);
    expect(
      (
        await runtime.runPromise(
          repository.readSnapshot(
            artifactSink.canvasName,
            artifactSink.nodeId,
          ),
        )
      ).artifacts.items,
    ).toEqual([
      // Projection-only publisher stamp (mirrors mailbox deliveredAt/readAt).
      {
        ...published.value,
        metadata: { publishedBySeatId: artifactPublisher.seatId },
      },
    ]);
    expect(
      await runtime.runPromise(
        state.read("test.read-artifact-task-reference", (reader) =>
          reader.get<{
            readonly actor_seat_id: string;
            readonly task_canvas_name: string;
            readonly task_node_id: string;
            readonly task_id: string;
            readonly task_entity_home: string;
          }>(
            `
              SELECT
                actor_seat_id,
                task_canvas_name,
                task_node_id,
                task_id,
                task_entity_home
              FROM work_artifacts
              WHERE canvas_name = ?
                AND node_id = ?
                AND artifact_id = ?
            `,
            [
              artifactSink.canvasName,
              artifactSink.nodeId,
              published.value.artifactId,
            ],
          ),
        ),
      ),
    ).toEqual({
      actor_seat_id: artifactPublisher.seatId,
      task_canvas_name: taskSink.canvasName,
      task_node_id: taskSink.nodeId,
      task_id: created.value.id,
      task_entity_home: cc,
    });

    for (const [artifactId, invalidTask, reason] of [
      [
        "artifact-missing-task",
        { ...task, itemId: "missing-task" },
        "missing-entity",
      ],
      [
        "artifact-cross-canvas",
        {
          ...task,
          sink: { ...task.sink, canvasName: "other-canvas" },
        },
        "target-mismatch",
      ],
    ] as const) {
      const invalid = await runtime.runPromise(
        repository
          .publishArtifact({
            sink: artifactSink,
            basis: authorialBasis,
            publishedBy: artifactPublisher,
            artifact: {
              artifactId,
              parts: [{ kind: "text", text: "invalid" }],
              task: invalidTask,
            },
            originAt: observedAt,
            receivedAt: observedAt,
          })
          .pipe(Effect.result),
      );
      expect(Result.isFailure(invalid)).toBe(true);
      if (Result.isFailure(invalid)) {
        expect(invalid.failure).toMatchObject({ reason });
      }
    }

    expect(
      await runtime.runPromise(
        state.read(
          "test.count-artifacts-after-invalid-links",
          (reader) =>
            reader.get<{ readonly count: number }>(
              `
                SELECT count(*) AS count
                FROM work_artifacts
                WHERE canvas_name = ? AND node_id = ?
              `,
              [artifactSink.canvasName, artifactSink.nodeId],
            )!.count,
        ),
      ),
    ).toBe(1);
  });

  it("materializes task and request appends only in their exact same-home threads", async () => {
    const taskSink = { canvasName: "factory", nodeId: "thread-tasks" };
    const requestSink = {
      canvasName: "factory",
      nodeId: "thread-requests",
    };
    await runtime.runPromise(
      repository.createTask({
        sink: taskSink,
        basis: authorialBasis,
        dependencyScope: dependencyScope(taskSink),
        task: {
          id: "thread-task-1",
          state: "submitted",
          history: [
            message(
              "thread-task-brief",
              "user",
              "Task brief",
              "thread-task-1",
            ),
          ],
        },
        originAt: observedAt,
        receivedAt: observedAt,
      }),
    );
    await runtime.runPromise(
      repository.createRequest({
        sink: requestSink,
        basis: authorialBasis,
        raisedBy: actor,
        request: {
          id: "thread-request-1",
          state: "input-required",
          claimedBy: actor.seatId,
          history: [
            message(
              "thread-request-brief",
              "agent",
              "Request brief",
              "thread-request-1",
            ),
          ],
        },
        originAt: observedAt,
        receivedAt: observedAt,
      }),
    );

    await runtime.runPromise(
      repository.appendMessage({
        sink: taskSink,
        basis: authorialBasis,
        message: message(
          "thread-task-note",
          "agent",
          "Task note",
          "thread-task-1",
        ),
        sentBy: actor,
        destination: { kind: "task", itemId: "thread-task-1" },
        originAt: observedAt,
        receivedAt: observedAt,
      }),
    );
    await runtime.runPromise(
      repository.appendMessage({
        sink: requestSink,
        basis: authorialBasis,
        message: message(
          "thread-request-note",
          "agent",
          "Request note",
          "thread-request-1",
        ),
        sentBy: actor,
        destination: {
          kind: "request",
          itemId: "thread-request-1",
        },
        originAt: observedAt,
        receivedAt: observedAt,
      }),
    );

    const taskSnapshot = await runtime.runPromise(
      repository.readSnapshot(taskSink.canvasName, taskSink.nodeId),
    );
    const requestSnapshot = await runtime.runPromise(
      repository.readSnapshot(requestSink.canvasName, requestSink.nodeId),
    );
    expect(
      taskSnapshot.tasks.items[0]?.history.map(({ messageId }) => messageId),
    ).toEqual(["thread-task-brief", "thread-task-note"]);
    expect(
      requestSnapshot.requests.items[0]?.history.map(
        ({ messageId }) => messageId,
      ),
    ).toEqual(["thread-request-brief", "thread-request-note"]);
    expect(taskSnapshot.messages.items).toEqual([]);
    expect(requestSnapshot.messages.items).toEqual([]);
    expect(
      await runtime.runPromise(
        state.read(
          "test.read-thread-message-lanes",
          (reader) => ({
            threads: reader.get<{ readonly count: number }>(
              `
                SELECT count(*) AS count
                FROM work_task_messages
                WHERE message_id IN (?, ?)
              `,
              ["thread-task-note", "thread-request-note"],
            )?.count,
            inboxes: reader.get<{ readonly count: number }>(
              `
                SELECT count(*) AS count
                FROM work_messages
                WHERE message_id IN (?, ?)
              `,
              ["thread-task-note", "thread-request-note"],
            )?.count,
          }),
        ),
      ),
    ).toEqual({ threads: 2, inboxes: 0 });

    const missingParent = await runtime.runPromise(
      repository
        .appendMessage({
          sink: taskSink,
          basis: authorialBasis,
          message: message(
            "missing-thread-note",
            "agent",
            "No parent",
            "missing-task",
          ),
          sentBy: actor,
          destination: { kind: "task", itemId: "missing-task" },
          originAt: observedAt,
          receivedAt: observedAt,
        })
        .pipe(Effect.result),
    );
    expect(missingParent).toMatchObject({
      _tag: "Failure",
      failure: {
        _tag: "WorkAuthorityError",
        reason: "missing-entity",
      },
    });
  });

  it("derives fact authority from the database singleton, never caller input", async () => {
    const sink = { canvasName: "factory", nodeId: "tasks-authority" };
    const attemptedOverride = {
      localInstallationId: remote,
      sink,
      basis: authorialBasis,
      dependencyScope: dependencyScope(sink),
      task: {
        id: "task-authority",
        state: "submitted" as const,
        history: [
          message(
            "brief-authority",
            "user",
            "use canonical authority",
            "task-authority",
          ),
        ],
      },
      originAt: observedAt,
      receivedAt: observedAt,
    };
    const created = await runtime.runPromise(
      repository.createTask(attemptedOverride),
    );

    expect(created.record.id.route).toEqual({
      eventHome: cc,
      entityHome: cc,
    });
    expect(
      await runtime.runPromise(
        repository.itemHome(
          "task",
          sink.canvasName,
          sink.nodeId,
          created.value.id,
        ),
      ),
    ).toBe(cc);
  });
});

describe("WorkRepository board CC-homed facts", () => {
  const boardSink = { canvasName: "factory", nodeId: "board-1" };
  const operator = { kind: "operator" as const, label: "operator" };

  it("createBoardTopic commits work_events and materializes topics", async () => {
    const topic = {
      topicId: "topic-board-1",
      title: "Fleet bulletin",
      state: "open" as const,
      openedBy: operator,
      openedAt: observedAt,
      postCount: 0,
      lastActivityAt: observedAt,
    };
    const created = await runtime.runPromise(
      repository.createBoardTopic({
        sink: boardSink,
        basis: authorialBasis,
        topic,
        createdBy: operator,
        originAt: observedAt,
        receivedAt: observedAt,
      }),
    );
    expect(created.value.topicId).toBe("topic-board-1");
    expect(created.record.operation).toBe("board.topic.create");
    expect(created.record.item.kind).toBe("topic");
    expect(created.record.id.route).toEqual({
      eventHome: cc,
      entityHome: cc,
    });
    const snap = await runtime.runPromise(
      repository.readSnapshot(boardSink.canvasName, boardSink.nodeId),
    );
    expect(snap.board.topics.map((t) => t.topicId)).toContain("topic-board-1");
  });

  it("appendBoardPost commits work_events and increments post_count", async () => {
    const post = {
      postId: "post-board-1",
      topicId: "topic-board-1",
      author: operator,
      parts: [{ kind: "text" as const, text: "hello fleet" }],
      position: 0,
      createdAt: observedAt,
    };
    const appended = await runtime.runPromise(
      repository.appendBoardPost({
        sink: boardSink,
        basis: authorialBasis,
        post,
        createdBy: operator,
        originAt: observedAt,
        receivedAt: observedAt,
      }),
    );
    expect(appended.value.postId).toBe("post-board-1");
    expect(appended.record.operation).toBe("board.post.append");
    expect(appended.record.item.kind).toBe("post");
    const snap = await runtime.runPromise(
      repository.readSnapshot(boardSink.canvasName, boardSink.nodeId),
    );
    const topic = snap.board.topics.find((t) => t.topicId === "topic-board-1");
    expect(topic?.postCount).toBe(1);
    expect(topic?.posts?.some((p) => p.postId === "post-board-1")).toBe(true);
  });

  it("assigns position authority and does not double-count rematerialize", async () => {
    const topicId = "topic-position";
    await runtime.runPromise(
      repository.createBoardTopic({
        sink: boardSink,
        basis: authorialBasis,
        topic: {
          topicId,
          title: "positions",
          state: "open",
          openedBy: operator,
          openedAt: observedAt,
          postCount: 0,
          lastActivityAt: observedAt,
        },
        createdBy: operator,
        originAt: observedAt,
        receivedAt: observedAt,
      }),
    );
    const first = await runtime.runPromise(
      repository.appendBoardPost({
        sink: boardSink,
        basis: authorialBasis,
        post: {
          postId: "post-pos-0",
          topicId,
          author: operator,
          parts: [{ kind: "text", text: "first" }],
          position: 99,
          createdAt: observedAt,
        },
        createdBy: operator,
        originAt: observedAt,
        receivedAt: observedAt,
      }),
    );
    expect(first.value.position).toBe(0);
    expect(first.record.body).toMatchObject({
      operation: "board.post.append",
      post: { position: 0 },
    });
    const second = await runtime.runPromise(
      repository.appendBoardPost({
        sink: boardSink,
        basis: authorialBasis,
        post: {
          postId: "post-pos-1",
          topicId,
          author: operator,
          parts: [{ kind: "text", text: "second" }],
          position: 0,
          createdAt: observedAt,
        },
        createdBy: operator,
        originAt: observedAt,
        receivedAt: observedAt,
      }),
    );
    expect(second.value.position).toBe(1);

    // Rematerialize same fact body must not inflate post_count.
    const before = await runtime.runPromise(
      repository.readSnapshot(boardSink.canvasName, boardSink.nodeId),
    );
    const topicBefore = before.board.topics.find((t) => t.topicId === topicId);
    expect(topicBefore?.postCount).toBe(2);

    await runtime.runPromise(
      state.transaction("test.rematerialize-board-post", (writer) => {
        // Re-run materialize path via second insert attempt is internal;
        // prove identity-conflict on append of existing post_id instead.
        return undefined;
      }),
    );
    const duplicate = await runtime.runPromise(
      repository
        .appendBoardPost({
          sink: boardSink,
          basis: authorialBasis,
          post: {
            postId: "post-pos-0",
            topicId,
            author: operator,
            parts: [{ kind: "text", text: "first" }],
            position: 0,
            createdAt: observedAt,
          },
          createdBy: operator,
          originAt: observedAt,
          receivedAt: observedAt,
        })
        .pipe(Effect.result),
    );
    expect(duplicate).toMatchObject({
      _tag: "Failure",
      failure: {
        _tag: "WorkAuthorityError",
        reason: "identity-conflict",
      },
    });
    const after = await runtime.runPromise(
      repository.readSnapshot(boardSink.canvasName, boardSink.nodeId),
    );
    expect(
      after.board.topics.find((t) => t.topicId === topicId)?.postCount,
    ).toBe(2);
  });

  it("binds seed post authors to createdBy", async () => {
    const forged = {
      kind: "operator" as const,
      label: "forged-operator",
    };
    const created = await runtime.runPromise(
      repository.createBoardTopic({
        sink: boardSink,
        basis: authorialBasis,
        topic: {
          topicId: "topic-bound-author",
          title: "bound",
          state: "open",
          openedBy: forged,
          openedAt: observedAt,
          postCount: 1,
          lastActivityAt: observedAt,
          posts: [
            {
              postId: "seed-1",
              topicId: "topic-bound-author",
              author: forged,
              parts: [{ kind: "text", text: "seed" }],
              position: 0,
              createdAt: observedAt,
            },
          ],
        },
        createdBy: operator,
        originAt: observedAt,
        receivedAt: observedAt,
      }),
    );
    expect(created.value.openedBy).toEqual(operator);
    expect(created.value.posts?.[0]?.author).toEqual(operator);
    const snap = await runtime.runPromise(
      repository.readSnapshot(boardSink.canvasName, boardSink.nodeId),
    );
    const topic = snap.board.topics.find(
      (t) => t.topicId === "topic-bound-author",
    );
    expect(topic?.openedBy).toMatchObject({ kind: "operator", label: "operator" });
    expect(topic?.posts?.[0]?.author).toMatchObject({
      kind: "operator",
      label: "operator",
    });
  });

  it("counts unread as non-operator posts past the operator cursor; mark-read clamps", async () => {
    const topicId = "topic-unread";
    const actor = { kind: "actor" as const, label: "scout" };
    await runtime.runPromise(
      repository.createBoardTopic({
        sink: boardSink,
        basis: authorialBasis,
        topic: {
          topicId,
          title: "unread lane",
          state: "open",
          openedBy: operator,
          openedAt: observedAt,
          postCount: 0,
          lastActivityAt: observedAt,
        },
        createdBy: operator,
        originAt: observedAt,
        receivedAt: observedAt,
      }),
    );
    const append = (post: {
      postId: string;
      author: typeof operator | typeof actor;
      position: number;
    }) =>
      runtime.runPromise(
        repository.appendBoardPost({
          sink: boardSink,
          basis: authorialBasis,
          post: {
            ...post,
            topicId,
            parts: [{ kind: "text" as const, text: post.postId }],
            createdAt: observedAt,
          },
          createdBy: post.author,
          originAt: observedAt,
          receivedAt: observedAt,
        }),
      );
    await append({ postId: "u-op-0", author: operator, position: 0 });
    await append({ postId: "u-agent-1", author: actor, position: 1 });
    await append({ postId: "u-agent-2", author: actor, position: 2 });

    const snap = await runtime.runPromise(
      repository.readSnapshot(boardSink.canvasName, boardSink.nodeId),
    );
    const topic = snap.board.topics.find((t) => t.topicId === topicId);
    // Own (operator) posts never count; both agent posts are unread.
    expect(topic?.unreadPostCount).toBe(2);

    // Reading up to 0 (the operator's own opening post) leaves both agent
    // posts unread.
    await runtime.runPromise(
      repository.markBoardRead({
        sink: boardSink,
        topicId,
        principalKey: "operator",
        lastReadPosition: 0,
      }),
    );
    const afterFirst = await runtime.runPromise(
      repository.readSnapshot(boardSink.canvasName, boardSink.nodeId),
    );
    expect(
      afterFirst.board.topics.find((t) => t.topicId === topicId)
        ?.unreadPostCount,
    ).toBe(2);

    await runtime.runPromise(
      repository.markBoardRead({
        sink: boardSink,
        topicId,
        principalKey: "operator",
        lastReadPosition: 1,
      }),
    );
    const afterSecond = await runtime.runPromise(
      repository.readSnapshot(boardSink.canvasName, boardSink.nodeId),
    );
    expect(
      afterSecond.board.topics.find((t) => t.topicId === topicId)
        ?.unreadPostCount,
    ).toBe(1);

    // An oversized cursor clamps to the topic's real max inside the write
    // transaction, so a post appended later is still unread.
    await runtime.runPromise(
      repository.markBoardRead({
        sink: boardSink,
        topicId,
        principalKey: "operator",
        lastReadPosition: 1e9,
      }),
    );
    await append({ postId: "u-agent-3", author: actor, position: 3 });
    const afterClamp = await runtime.runPromise(
      repository.readSnapshot(boardSink.canvasName, boardSink.nodeId),
    );
    expect(
      afterClamp.board.topics.find((t) => t.topicId === topicId)
        ?.unreadPostCount,
    ).toBe(1);

    // Acknowledging everything (within the real max) clears the lane.
    await runtime.runPromise(
      repository.markBoardRead({
        sink: boardSink,
        topicId,
        principalKey: "operator",
        lastReadPosition: 3,
      }),
    );
    const afterClear = await runtime.runPromise(
      repository.readSnapshot(boardSink.canvasName, boardSink.nodeId),
    );
    expect(
      afterClear.board.topics.find((t) => t.topicId === topicId)
        ?.unreadPostCount,
    ).toBe(0);
  });

  it("rejects board writes when local authority is Remote", async () => {
    const remoteRoot = join(
      tmpdir(),
      `junto-work-board-remote-${randomUUID()}`,
    );
    const remoteRuntime = ManagedRuntime.make(
      Layer.provideMerge(
        WorkRepositoryLive,
        makeStateEngineLive(join(remoteRoot, "junto.db")),
      ),
    );
    try {
      const remoteRepository =
        await remoteRuntime.runPromise(WorkRepository);
      const remoteState = await remoteRuntime.runPromise(StateEngine);
      await remoteRuntime.runPromise(
        remoteState.transaction("test.seed-remote", (writer) => {
          for (const installation of [cc, remote]) {
            writer.run(
              `
                INSERT INTO station_known_installations(
                  installation_id, registered_at
                ) VALUES (?, ?)
              `,
              [installation, observedAt],
            );
          }
          writer.run(
            `
              INSERT INTO station_installation(
                singleton, installation_id, created_at
              ) VALUES (1, ?, ?)
            `,
            [remote, observedAt],
          );
          writer.run(
            `
              INSERT INTO station_configuration(
                singleton, role, host_id, agent_host_id,
                command_center_installation_id, supervised_preferred,
                configured_at
              ) VALUES (1, 'remote', 'remote-host', 'remote-agent-host', ?, 1, ?)
            `,
            [cc, observedAt],
          );
          // The old blob seed parked junk canvas rows here so the denial is
          // attributable to the remote role, not to absent canvas data. Keep
          // the relational analog: a minimal seeded head.
          seedCanvasAuthority(writer, {
            generation: "1",
            documents: new Map([["factory", { nodes: [], edges: [] }]]),
            at: observedAt,
          });
        }),
      );
      const denied = await remoteRuntime.runPromise(
        remoteRepository
          .createBoardTopic({
            sink: boardSink,
            basis: projectedBasis,
            topic: {
              topicId: "remote-denied",
              title: "nope",
              state: "open",
              openedBy: operator,
              openedAt: observedAt,
              postCount: 0,
              lastActivityAt: observedAt,
            },
            createdBy: operator,
            originAt: observedAt,
            receivedAt: observedAt,
          })
          .pipe(Effect.result),
      );
      expect(denied).toMatchObject({
        _tag: "Failure",
        failure: {
          _tag: "WorkAuthorityError",
          reason: "authority-mismatch",
        },
      });
    } finally {
      await remoteRuntime.dispose();
      await rm(remoteRoot, { recursive: true, force: true });
    }
  });
});

  it("archives a task off the board projection (soft-delete)", async () => {
    const sink = { canvasName: "factory", nodeId: "tasks-archive" };
    // Dedicated seat — shared `actor` may already hold a pending remote claim
    // from earlier cases in this suite.
    const archiveActor = {
      seatId: Schema.decodeUnknownSync(ActorSeatId)(
        `seat_${"d".repeat(64)}`,
      ),
      canvasName: "factory",
      nodeId: "archive-worker",
    };
    const created = await runtime.runPromise(
      repository.createTask({
        sink,
        basis: authorialBasis,
        dependencyScope: dependencyScope(sink),
        task: {
          id: "task-archive-me",
          state: "submitted",
          history: [
            message("brief-archive", "user", "delete me", "task-archive-me"),
          ],
        },
        originAt: observedAt,
        receivedAt: observedAt,
      }),
    );
    const claimed = await runtime.runPromise(
      repository.claimLocalTask({
        sink,
        basis: authorialBasis,
        dependencyScope: dependencyScope(sink),
        taskId: created.value.id,
        actor: archiveActor,
        originAt: observedAt,
        receivedAt: observedAt,
      }),
    );
    expect(claimed.value.state).toBe("working");

    const archived = await runtime.runPromise(
      repository.transitionTask({
        sink,
        basis: authorialBasis,
        taskId: created.value.id,
        state: "archived",
        originAt: observedAt,
        receivedAt: observedAt,
      }),
    );
    expect(archived.value.state).toBe("archived");

    const snapshot = await runtime.runPromise(
      repository.readSnapshot(sink.canvasName, sink.nodeId),
    );
    expect(snapshot.tasks.items.find((t) => t.id === "task-archive-me")).toBeUndefined();
  });
