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
const actor = {
  seatId: Schema.decodeUnknownSync(ActorSeatId)(
    `seat_${"a".repeat(64)}`,
  ),
  canvasName: "factory",
  nodeId: "builder",
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
  it("commits typed task facts on one full route with strict predecessors", async () => {
    const sink = { canvasName: "factory", nodeId: "tasks-local" };
    const created = await runtime.runPromise(
      repository.createTask({
        sink,
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
        taskId: created.value.id,
        actor,
        originAt: observedAt,
        receivedAt: observedAt,
      }),
    );
    const completed = await runtime.runPromise(
      repository.transitionTask({
        sink,
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

  it("persists a remote claim attempt without assigning or starting the source task", async () => {
    const sink = { canvasName: "factory", nodeId: "tasks-remote" };
    const created = await runtime.runPromise(
      repository.createTask({
        sink,
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
        message: message("mail-1", "agent", "hello", "mail-context-task"),
        originAt: observedAt,
        receivedAt: observedAt,
      }),
    );
    const artifact = await runtime.runPromise(
      repository.publishArtifact({
        sink: artifacts,
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
    await runtime.runPromise(
      repository.acceptDelivery({
        sink: artifacts,
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
      (
        await runtime.runPromise(
          repository.readSnapshot(artifacts.canvasName, artifacts.nodeId),
        )
      ).artifacts.items,
    ).toEqual([artifact.value]);
  });

  it("derives fact authority from the database singleton, never caller input", async () => {
    const sink = { canvasName: "factory", nodeId: "tasks-authority" };
    const attemptedOverride = {
      localInstallationId: remote,
      sink,
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
