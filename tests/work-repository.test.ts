import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Context,
  Effect,
  Either,
  Layer,
  ManagedRuntime,
  Schema,
} from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ActorSeatId } from "../src/shared/actor-seat";
import {
  InstallationId,
  type InstallationId as InstallationIdValue,
} from "../src/shared/installation-id";
import {
  workRecordContentSha256,
  WorkAuthorityError,
  WorkRepository,
  WorkRepositoryLive,
} from "../src/main/vellum/work/repository";
import {
  makeStateEngineLive,
  StateEngine,
} from "../src/main/vellum/state/engine";
import { IntentFactBasis } from "../src/shared/work-protocol";

const root = join(tmpdir(), `vellum-work-v2-${randomUUID()}`);
const runtime = ManagedRuntime.make(
  Layer.provideMerge(
    WorkRepositoryLive,
    makeStateEngineLive(join(root, "vellum.db")),
  ),
);

let repository: Context.Tag.Service<typeof WorkRepository>;
let state: Context.Tag.Service<typeof StateEngine>;

const observedAt = "2026-07-27T18:00:00.000Z";
const cc = Schema.decodeUnknownSync(InstallationId)("cc-repository");
const remote = Schema.decodeUnknownSync(InstallationId)("remote-repository");
const currentIntentSha256 = "d".repeat(64);
const staleIntentSha256 = "e".repeat(64);
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
) =>
  state.transaction("test.seed-installations", (writer) => {
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
    for (const [generation, intentSha256] of [
      ["0", staleIntentSha256],
      ["1", currentIntentSha256],
    ] as const) {
      writer.run(
        `
          INSERT INTO canvas_generations(
            generation,
            created_at,
            cause,
            intent_sha256,
            document_count
          ) VALUES (?, ?, 'test intent', ?, 1)
        `,
        [generation, observedAt, intentSha256],
      );
      writer.run(
        `
          INSERT INTO canvas_generation_documents(
            generation,
            name,
            body,
            sha256,
            modified_at
          ) VALUES (?, 'factory', '{}', ?, ?)
        `,
        [generation, generation.repeat(64), observedAt],
      );
    }
    writer.run(
      `
        INSERT INTO canvas_head(singleton, generation)
        VALUES (1, '1')
      `,
    );
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
  it("rejects unconfigured local mutation without writing any Work row", async () => {
    const unconfiguredRoot = join(
      tmpdir(),
      `vellum-work-v2-unconfigured-${randomUUID()}`,
    );
    const unconfiguredRuntime = ManagedRuntime.make(
      Layer.provideMerge(
        WorkRepositoryLive,
        makeStateEngineLive(join(unconfiguredRoot, "vellum.db")),
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
          .pipe(Effect.either),
      );
      expect(Either.isLeft(result)).toBe(true);
      if (Either.isLeft(result)) {
        expect(result.left).toBeInstanceOf(WorkAuthorityError);
        expect(result.left).toMatchObject({
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
          .pipe(Effect.either),
      );
      expect(result).toMatchObject({
        _tag: "Left",
        left: {
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
    expect(snapshot.tasks.items).toEqual([completed.value]);
    expect(
      await runtime.runPromise(
        repository.itemHome("task", sink.canvasName, sink.nodeId, "task-local"),
      ),
    ).toBe(cc);
  });

  it("atomically clears the claimant when active work returns to Queue", async () => {
    const sink = { canvasName: "factory", nodeId: "tasks-release" };
    const created = await runtime.runPromise(
      repository.createTask({
        sink,
        basis: authorialBasis,
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

  it("roundtrips the exact immutable intent basis on an emitted fact", async () => {
    const sink = { canvasName: "factory", nodeId: "basis-roundtrip" };
    const created = await runtime.runPromise(
      repository.createTask({
        sink,
        basis: authorialBasis,
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
          taskId: "task-pending-actor",
          actor,
          originAt: observedAt,
          receivedAt: observedAt,
        })
        .pipe(Effect.either),
    );
    expect(Either.isLeft(contention)).toBe(true);
    if (Either.isLeft(contention)) {
      expect(contention.left).toBeInstanceOf(WorkAuthorityError);
      expect(contention.left).toMatchObject({
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
    ).toEqual([artifact.value]);
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
        .pipe(Effect.either),
    );
    expect(Either.isLeft(beforeClaim)).toBe(true);
    if (Either.isLeft(beforeClaim)) {
      expect(beforeClaim.left).toMatchObject({
        reason: "invalid-transition",
      });
    }

    await runtime.runPromise(
      repository.claimLocalTask({
        sink: taskSink,
        basis: authorialBasis,
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
    ).toEqual([published.value]);
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
          .pipe(Effect.either),
      );
      expect(Either.isLeft(invalid)).toBe(true);
      if (Either.isLeft(invalid)) {
        expect(invalid.left).toMatchObject({ reason });
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
        .pipe(Effect.either),
    );
    expect(missingParent).toMatchObject({
      _tag: "Left",
      left: {
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
