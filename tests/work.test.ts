import { CrewRepositoryLive } from "../src/main/vellum-command/work/crew-repository";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context, Effect, Layer, ManagedRuntime, Schema } from "effect";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  workArtifactPublish,
  workMessageAppend,
  workRequestCreate,
  workRequestResolve,
  workTaskClaim,
  workTaskCreate,
  workTaskRespond,
  workTaskTransition,
} from "../src/shared/work";
import { CHECK_OUTPUT_TAIL_MAX_BYTES } from "../src/shared/work-model";
import type { Artifact, CanvasDoc, Message } from "../src/shared/canvas";
import {
  IntentFactBasis,
  type IntentFactBasis as IntentFactBasisValue,
} from "../src/shared/work-protocol";
import { InstallationId } from "../src/shared/installation-id";
import { HostId } from "../src/shared/remote-hosts";
import {
  ConfigureRequest,
  LogicalSequence,
  PairRequest,
  ProjectRequest,
  STATION_API_PROTOCOL,
  StationHostId,
} from "../src/shared/station-api";

const installationId = Schema.decodeUnknownSync(InstallationId);
const remoteHostId = Schema.decodeUnknownSync(HostId);
const stationHostId = Schema.decodeUnknownSync(StationHostId);
const logicalSequence = Schema.decodeUnknownSync(LogicalSequence);

const emptyTaskNode = (id = "tasks"): CanvasDoc["nodes"][number] => ({
  id,
  type: "text",
  text: "tasks",
  x: 0,
  y: 0,
  width: 200,
  height: 100,
  ether: { entity: { kind: "task" } },
});

const emptyRequestsNode = (id = "req"): CanvasDoc["nodes"][number] => ({
  id,
  type: "text",
  text: "0 pending",
  x: 0,
  y: 0,
  width: 200,
  height: 100,
  ether: { entity: { kind: "requests" } },
});

const agentNode = (
  id = "agent",
  hostId = "local"
): CanvasDoc["nodes"][number] => ({
  id,
  type: "text",
  text: "profile-13",
  x: 0,
  y: 0,
  width: 200,
  height: 100,
  ether: {
    entity: { kind: "agent", name: `${hostId}:${id}` },
    terminal: {
      bindingId: `binding-${id}`,
      launch: { kind: "harness", argv: ["claude"] },
      harness: "claude",
    },
    host: hostId,
  },
});


const mockCanvasesHome = join(tmpdir(), `vellum-command-work-${randomUUID()}`);

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => mockCanvasesHome };
});

vi.mock("@shared/canvas", () => import("../src/shared/canvas"));
vi.mock("@shared/seed", () => import("../src/shared/seed"));

import {
  CanvasesLive,
  CanvasesService,
} from "../src/main/vellum-command/canvases";
import { WorkLive, WorkService } from "../src/main/vellum-command/work/service";
import { messageDelivery } from "../src/main/vellum-command/work/message-delivery";
import {
  createCurrentProjectedTaskDependencyScopeCapability,
  WorkRepository,
  WorkRepositoryLive,
} from "../src/main/vellum-command/work/repository";
import { makeStateEngineLive } from "../src/main/vellum-command/state/engine";
import {
  StationRepository,
  StationRepositoryLive,
  stationProjectionContentSha256,
} from "../src/main/vellum-command/station/repository";
import {
  StationFleetTargetRepository,
  StationFleetTargetRepositoryLive,
} from "../src/main/vellum-command/station/fleet-target-repository";
import {
  StationLivePeerRegistryLive,
} from "../src/main/vellum-command/station/session-registry";
import {
  makeSettingsLive,
  SettingsService,
} from "../src/main/vellum-command/settings/service";
import {
  compileStationPortfolioBody,
} from "../src/main/vellum-command/station/portfolio";
import {
  makeContentServiceLive,
} from "../src/main/vellum-command/content/service";
import { makeInstallOpsLive } from "../src/main/vellum-command/install-ops/engine";

const makeWorkRuntime = (databasePath: string) => {
  const installRoot = join(databasePath, "..");
  const stateLive = makeStateEngineLive(databasePath);
  const repositoriesLive = Layer.provideMerge(
    Layer.mergeAll(
      WorkRepositoryLive,
      CrewRepositoryLive,
      StationRepositoryLive,
      StationFleetTargetRepositoryLive,
      // Blank-slate station for Remote offline fixtures; tests configure role.
      makeSettingsLive({ ensureDefaultCommandCenter: false }),
      makeContentServiceLive({
        root: join(installRoot, "content"),
        skipInlineMediaMigration: true,
      }),
    ),
    Layer.mergeAll(
      stateLive,
      makeInstallOpsLive(join(installRoot, "install-ops.db")),
    ),
  );
  const canvasesLive = Layer.provideMerge(
    CanvasesLive,
    repositoriesLive
  );
  return ManagedRuntime.make(((
    Layer.provideMerge(
      WorkLive,
      Layer.mergeAll(canvasesLive, StationLivePeerRegistryLive) as never) as never)
    )
  );
};

const activeIntentBasis = async (
  runtime: ReturnType<typeof makeWorkRuntime>,
  kind: IntentFactBasisValue["kind"]
): Promise<IntentFactBasisValue> => {
  const canvases = await runtime.runPromise(CanvasesService);
  const witness = await runtime.runPromise(canvases.activeIntentWitness());
  return Schema.decodeUnknownSync(IntentFactBasis, {
    onExcessProperty: "error",
  })({
    kind,
    ...witness,
  });
};

const workRuntime = makeWorkRuntime(
  join(mockCanvasesHome, "state", "junto.db")
);
let work: Context.Service.Shape<typeof WorkService>;
let canvases: Context.Service.Shape<typeof CanvasesService>;
let repository: Context.Service.Shape<typeof WorkRepository>;

beforeAll(async () => {
  const settings = await workRuntime.runPromise(SettingsService);
  await workRuntime.runPromise(
    settings.setStationTopology({
      role: "command-center",
      hostId: "local",
      supervisedPreferred: true,
    })
  );
  work = await workRuntime.runPromise(WorkService);
  canvases = await workRuntime.runPromise(CanvasesService);
  repository = await workRuntime.runPromise(WorkRepository);
});

afterAll(async () => {
  await workRuntime.dispose();
  await rm(mockCanvasesHome, { recursive: true, force: true });
});

describe("WorkService — concurrent ops", () => {
  it("reads task home through the app-owned WorkService seam", async () => {
    const name = "work-task-home";
    await workRuntime.runPromise(
      canvases.write(name, {
        nodes: [emptyTaskNode()],
        edges: [],
      })
    );
    const created = await workRuntime.runPromise(
      work.workTaskCreate(name, "tasks", "prove the task home", { details: "prove the task home" })
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const station = await workRuntime.runPromise(StationRepository);
    const localInstallationId = await workRuntime.runPromise(
      station.installationId
    );
    await expect(
      workRuntime.runPromise(
        work.workTaskHome(name, "tasks", created.data.id)
      )
    ).resolves.toBe(localInstallationId);

    const missing = await workRuntime.runPromise(
      work.workTaskHome(name, "tasks", "missing-task").pipe(Effect.result)
    );
    expect(missing._tag).toBe("Failure");
    if (missing._tag === "Failure") {
      expect(missing.failure.code).toBe("task_not_found");
    }
  });

  it("serializes concurrent claims; second actor loses with claim_contention", async () => {
    const name = "work-race";
    await workRuntime.runPromise(
      canvases.write(name, {
        nodes: [
          {
            id: "tasks",
            type: "text",
            text: "tasks",
            x: 0,
            y: 0,
            width: 200,
            height: 100,
            ether: { entity: { kind: "task" } },
          },
          agentNode("actor-a"),
          agentNode("actor-b"),
          agentNode("actor-c"),
        ],
        edges: [
          { id: "edge-a", fromNode: "actor-a", toNode: "tasks" },
          { id: "edge-b", fromNode: "actor-b", toNode: "tasks" },
          { id: "edge-c", fromNode: "actor-c", toNode: "tasks" },
        ],
      })
    );
    const authorialBefore = await workRuntime.runPromise(canvases.read(name));
    const actors = ["actor-a", "actor-b", "actor-c"].map((nodeId) => {
      const actor = authorialBefore.actorRefs.find(
        (candidate) => candidate.nodeId === nodeId
      );
      if (actor === undefined) throw new Error(`missing actor ref for ${nodeId}`);
      return actor;
    });

    const created = await workRuntime.runPromise(
      work.workTaskCreate(name, "tasks", "race me", { details: "race me" })
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.disposition).toBe("applied");
    const taskId = created.data.id;

    // First claim must win; concurrent claims by different actors.
    const results = await Promise.all(
      actors.map((actor) =>
        workRuntime.runPromise(
          work.workTaskClaim(name, "tasks", taskId, actor)
        )
      )
    );

    const wins = results.filter((r) => r.ok);
    const losses = results.filter((r) => !r.ok);
    expect(wins).toHaveLength(1);
    expect(losses).toHaveLength(2);
    expect(
      losses.every((result) => !result.ok && result.code === "claim_contention")
    ).toBe(true);

    const snapshot = await workRuntime.runPromise(
      repository.readSnapshot(name, "tasks")
    );
    const task = snapshot.tasks.items.find((item) => item.id === taskId);
    expect(task?.state).toBe("working");
    expect(actors.map((actor) => actor.seatId)).toContain(task?.claimedBy);

    // Explicit second claim by different actor after settle
    const other = await workRuntime.runPromise(
      work.workTaskClaim(
        name,
        "tasks",
        taskId,
        actors.find((actor) => actor.seatId !== task?.claimedBy)!
      )
    );
    expect(other.ok).toBe(false);
    if (!other.ok) expect(other.code).toBe("claim_contention");

    const authorialAfter = await workRuntime.runPromise(canvases.read(name));
    expect(authorialAfter.revision).toBe(authorialBefore.revision);
    const authority = await workRuntime.runPromise(canvases.authoritySnapshot());
    expect(
      authority.documents.get(name)?.nodes[0]?.ether?.tasks
    ).toBeUndefined();
  });

  it("rejects bad canvas / node / illegal transition", async () => {
    const name = "work-errors";
    await workRuntime.runPromise(
      canvases.write(name, {
        nodes: [
          {
            id: "tasks",
            type: "text",
            text: "tasks",
            x: 0,
            y: 0,
            width: 100,
            height: 50,
            ether: { entity: { kind: "task" } },
          },
        ],
        edges: [],
      })
    );
    const missingNode = await workRuntime.runPromise(
      work.workTaskCreate(name, "nope", "x", { details: "x" })
    );
    expect(missingNode.ok).toBe(false);
    if (!missingNode.ok) expect(missingNode.code).toBe("node_not_found");

    const created = await workRuntime.runPromise(work.workTaskCreate(name, "tasks", "t", { details: "t" }));
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    await workRuntime.runPromise(
      work.workTaskTransition(name, "tasks", created.data.id, "completed")
    );
    const illegal = await workRuntime.runPromise(
      work.workTaskTransition(name, "tasks", created.data.id, "working")
    );
    expect(illegal.ok).toBe(false);
    if (!illegal.ok) expect(illegal.code).toBe("illegal_transition");
  });

  it("records a Command Center operator response with its transition in one task fact", async () => {
    const name = "work-operator-response";
    await workRuntime.runPromise(
      canvases.write(name, {
        nodes: [emptyTaskNode(), agentNode("operator-response-worker")],
        edges: [{ id: "worker-tasks", fromNode: "operator-response-worker", toNode: "tasks" }],
      })
    );
    const created = await workRuntime.runPromise(
      work.workTaskCreate(name, "tasks", "need a deployment decision", { details: "need a deployment decision" })
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const taskId = created.data.id;
    const actor = (await workRuntime.runPromise(canvases.read(name))).actorRefs.find(
      (candidate) => candidate.nodeId === "operator-response-worker"
    );
    if (actor === undefined) throw new Error("missing operator response worker");
    await workRuntime.runPromise(work.workTaskClaim(name, "tasks", taskId, actor));
    const basis = await activeIntentBasis(
      workRuntime,
      "authorial-intent"
    );
    await workRuntime.runPromise(
      repository.transitionTask({
        sink: { canvasName: name, nodeId: "tasks" },
        taskId,
        state: "input-required",
        basis,
      })
    );

    const result = await workRuntime.runPromise(
      work.workTaskRespond(
        name,
        "tasks",
        taskId,
        "Deploy to us-east-1.",
        "working"
      )
    );
    expect(result).toMatchObject({ ok: true, disposition: "applied" });
    const snapshot = await workRuntime.runPromise(repository.readSnapshot(name, "tasks"));
    const task = snapshot.tasks.items.find((candidate) => candidate.id === taskId);
    expect(task).toMatchObject({ state: "working" });
    expect(task?.history.at(-1)).toMatchObject({
      role: "user",
      parts: [{ kind: "text", text: "Deploy to us-east-1." }],
    });
    const historyLength = task?.history.length;

    const invalid = await workRuntime.runPromise(
      work.workTaskRespond(name, "tasks", taskId, "not accepted", "working")
    );
    expect(invalid).toMatchObject({ ok: false, code: "illegal_transition" });
    const afterInvalid = await workRuntime.runPromise(repository.readSnapshot(name, "tasks"));
    expect(afterInvalid.tasks.items.find((candidate) => candidate.id === taskId)?.history)
      .toHaveLength(historyLength ?? 0);
  });

  it("persists requests, inbox messages, and artifacts without authorial generations", async () => {
    const name = "work-lanes";
    await workRuntime.runPromise(
      canvases.write(name, {
        nodes: [
          emptyRequestsNode("requests"),
          agentNode("sender"),
          agentNode("recipient"),
          {
            id: "artifacts",
            type: "text",
            text: "artifacts",
            x: 420,
            y: 0,
            width: 200,
            height: 100,
            ether: {
              entity: { kind: "artifacts" },
            },
          },
        ],
        edges: [
          {
            id: "edge-request",
            fromNode: "sender",
            toNode: "requests",
            ether: { verb: "escalates" },
          },
          {
            id: "edge-message",
            fromNode: "sender",
            toNode: "recipient",
            ether: { verb: "messages" },
          },
          {
            id: "edge-artifact",
            fromNode: "sender",
            toNode: "artifacts",
            ether: { verb: "publishes" },
          },
        ],
      })
    );
    const authorialBefore = await workRuntime.runPromise(canvases.read(name));
    const actor = authorialBefore.actorRefs.find(
      (candidate) => candidate.nodeId === "sender"
    );
    if (actor === undefined) throw new Error("missing actor ref for sender");

    const request = await workRuntime.runPromise(
      work.workRequestCreate(
        name,
        "requests",
        "approve release",
        undefined,
        actor,
        "cannot ship without sign-off"
      )
    );
    expect(request.ok).toBe(true);
    if (!request.ok) return;
    const resolved = await workRuntime.runPromise(
      work.workRequestResolve(
        name,
        "requests",
        request.data.id,
        "approved",
        "completed"
      )
    );
    expect(resolved.ok).toBe(true);

    const inboxMessage: Message = {
      messageId: "inbox-lane-1",
      role: "user",
      parts: [{ kind: "text", text: "start" }],
    };
    const appended = await workRuntime.runPromise(
      work.workMessageAppend(
        name,
        "recipient",
        null,
        inboxMessage,
        actor
      )
    );
    if (!appended.ok) {
      throw new Error(`${appended.code}: ${appended.message}`);
    }
    expect(appended).toMatchObject({ ok: true });

    const artifact: Artifact = {
      artifactId: "artifact-lane-1",
      name: "release receipt",
      parts: [{ kind: "text", text: "sha256:abc" }],
    };
    const published = await workRuntime.runPromise(
      work.workArtifactPublish(name, "artifacts", artifact, actor)
    );
    expect(published.ok).toBe(true);

    const snapshots = await workRuntime.runPromise(
      repository.snapshotsForCanvas(name)
    );
    expect(
      snapshots.find((snapshot) => snapshot.nodeId === "requests")?.requests
        .items[0]
    ).toMatchObject({ state: "completed", response: "approved" });
    expect(
      snapshots.find((snapshot) => snapshot.nodeId === "recipient")?.messages
        .items
    ).toEqual([expect.objectContaining({ messageId: "inbox-lane-1" })]);
    expect(
      snapshots.find((snapshot) => snapshot.nodeId === "artifacts")?.artifacts
        .items
    ).toEqual([expect.objectContaining({ artifactId: "artifact-lane-1" })]);

    const authorialAfter = await workRuntime.runPromise(canvases.read(name));
    expect(authorialAfter.revision).toBe(authorialBefore.revision);
    const authority = await workRuntime.runPromise(canvases.authoritySnapshot());
    expect(
      authority.documents.get(name)?.nodes.find(
        (node) => node.id === "requests"
      )?.ether?.requests
    ).toBeUndefined();
  });

  it("appends one operator comment to the task thread and binds a mailbox ack", async () => {
    const name = "work-comment-react";
    await workRuntime.runPromise(
      canvases.write(name, {
        nodes: [
          emptyTaskNode("tasks"),
          agentNode("sender"),
          agentNode("owner"),
        ],
        edges: [
          {
            id: "edge-mail",
            fromNode: "sender",
            toNode: "owner",
            ether: { verb: "messages" },
          },
        ],
      })
    );
    const created = await workRuntime.runPromise(
      work.workTaskCreate(name, "tasks", "comment me", { details: "comment me" })
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const taskId = created.data.id;

    const comment: Message = {
      messageId: "operator-comment-1",
      role: "user",
      parts: [{ kind: "text", text: "Check the retry boundary." }],
    };
    const commented = await workRuntime.runPromise(
      work.workTaskComment(name, "tasks", taskId, comment)
    );
    expect(commented.ok).toBe(true);
    if (!commented.ok) return;

    const read = await workRuntime.runPromise(canvases.read(name));
    const task = read.doc.nodes
      .find((n) => n.id === "tasks")
      ?.ether?.tasks?.items.find((t) => t.id === taskId);
    // Exactly one appended message — brief + comment, with the author's own
    // id and role intact (the thread is the record, not a rewrite of it).
    expect(task?.history).toHaveLength(2);
    expect(task?.history.at(-1)).toMatchObject({
      messageId: "operator-comment-1",
      role: "user",
      taskId,
      parts: [{ kind: "text", text: "Check the retry boundary." }],
    });

    const sender = read.actorRefs.find((ref) => ref.nodeId === "sender");
    const owner = read.actorRefs.find((ref) => ref.nodeId === "owner");
    if (sender === undefined || owner === undefined) {
      throw new Error("missing actor refs");
    }
    const mail: Message = {
      messageId: "mailbox-note-1",
      role: "user",
      parts: [{ kind: "text", text: "ping" }],
    };
    const delivered = await workRuntime.runPromise(
      work.workMessageAppend(name, "owner", null, mail, sender)
    );
    expect(delivered.ok).toBe(true);

    const reacted = await workRuntime.runPromise(
      work.workMessageReact(name, "owner", "mailbox-note-1", "ack", owner)
    );
    expect(reacted.ok).toBe(true);
    if (!reacted.ok) return;
    expect(reacted.data.messageId).toBe("mailbox-note-1");
    expect(reacted.data.reaction).toBe("ack");
    // The receipt is durable: re-reacting reads the first one back.
    const again = await workRuntime.runPromise(
      work.workMessageReact(name, "owner", "mailbox-note-1", "ack", owner)
    );
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.data.reactedAt).toBe(reacted.data.reactedAt);
    // A reaction binds to a message that exists — nothing else.
    const missing = await workRuntime.runPromise(
      work.workMessageReact(name, "owner", "mailbox-note-2", "ack", owner)
    );
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.message).toContain("not found in mailbox");
  });

  it("returns task and request notes from normalized thread history", async () => {
    const name = "work-thread-messages";
    await workRuntime.runPromise(
      canvases.write(name, {
        nodes: [
          emptyTaskNode(),
          emptyRequestsNode("requests"),
          agentNode("sender"),
        ],
        edges: [
          {
            id: "task-note",
            fromNode: "sender",
            toNode: "tasks",
          },
          {
            id: "request-note",
            fromNode: "sender",
            toNode: "requests",
          },
        ],
      })
    );
    const read = await workRuntime.runPromise(canvases.read(name));
    const sender = read.actorRefs.find(
      (candidate) => candidate.nodeId === "sender"
    );
    if (sender === undefined) throw new Error("missing sender actor");
    const task = await workRuntime.runPromise(
      work.workTaskCreate(name, "tasks", "Thread task", { details: "Thread task" })
    );
    const request = await workRuntime.runPromise(
      work.workRequestCreate(
        name,
        "requests",
        "Thread request",
        undefined,
        sender,
        "need operator thread context"
      )
    );
    if (!task.ok || !request.ok) {
      throw new Error("failed to seed thread work");
    }

    const taskNote = await workRuntime.runPromise(
      work.workMessageAppend(
        name,
        "tasks",
        task.data.id,
        {
          messageId: "service-task-note",
          role: "agent",
          parts: [{ kind: "text", text: "Task progress" }],
          taskId: task.data.id,
        },
        sender
      )
    );
    const requestNote = await workRuntime.runPromise(
      work.workMessageAppend(
        name,
        "requests",
        request.data.id,
        {
          messageId: "service-request-note",
          role: "agent",
          parts: [{ kind: "text", text: "Request context" }],
          taskId: request.data.id,
        },
        sender
      )
    );
    expect(taskNote).toMatchObject({ ok: true, disposition: "applied" });
    expect(requestNote).toMatchObject({
      ok: true,
      disposition: "applied",
    });
    if (!taskNote.ok || !requestNote.ok) return;
    expect(
      taskNote.doc.nodes
        .find((node) => node.id === "tasks")
        ?.ether?.tasks?.items[0]?.history.map(({ messageId }) => messageId)
    ).toContain("service-task-note");
    expect(
      requestNote.doc.nodes
        .find((node) => node.id === "requests")
        ?.ether?.requests?.items[0]?.history.map(({ messageId }) => messageId)
    ).toContain("service-request-note");
    expect(
      taskNote.doc.nodes.find((node) => node.id === "tasks")?.ether?.messages
        ?.items ?? []
    ).toEqual([]);
    expect(
      requestNote.doc.nodes.find((node) => node.id === "requests")?.ether
        ?.messages?.items ?? []
    ).toEqual([]);
  });

  it("rejects actor-originated work when the compiled actor is homed on another installation", async () => {
    const name = "work-cross-home-actor";
    const remoteHost = remoteHostId("remote-actor");
    const remoteInstallation = installationId("remote-actor-installation");
    const fleetTargets = await workRuntime.runPromise(
      StationFleetTargetRepository
    );
    await workRuntime.runPromise(
      fleetTargets.bind(
        {
          hostId: remoteHost,
          stationInstallationId: remoteInstallation,
        },
        "2026-07-28T00:00:00.000Z"
      )
    );
    await workRuntime.runPromise(
      canvases.write(name, {
        nodes: [
          emptyRequestsNode("requests"),
          agentNode("remote-sender", remoteHost),
          agentNode("recipient"),
          {
            id: "artifacts",
            type: "text",
            text: "artifacts",
            x: 420,
            y: 0,
            width: 200,
            height: 100,
            ether: { entity: { kind: "artifacts" } },
          },
        ],
        edges: [
          {
            id: "request",
            fromNode: "remote-sender",
            toNode: "requests",
            ether: { verb: "escalates" },
          },
          {
            id: "message",
            fromNode: "remote-sender",
            toNode: "recipient",
            ether: { verb: "messages" },
          },
          {
            id: "artifact",
            fromNode: "remote-sender",
            toNode: "artifacts",
            ether: { verb: "publishes" },
          },
        ],
      })
    );
    const read = await workRuntime.runPromise(canvases.read(name));
    const remoteActor = read.actorRefs.find(
      (candidate) => candidate.nodeId === "remote-sender"
    );
    if (remoteActor === undefined) throw new Error("missing Remote actor ref");

    const results = await Promise.all([
      workRuntime.runPromise(
        work.workMessageAppend(
          name,
          "recipient",
          null,
          {
            messageId: "cross-home-message",
            role: "agent",
            parts: [{ kind: "text", text: "forged locally" }],
          },
          remoteActor
        )
      ),
      workRuntime.runPromise(
        work.workRequestCreate(
          name,
          "requests",
          "forged request",
          undefined,
          remoteActor,
          "forged body for locality test"
        )
      ),
      workRuntime.runPromise(
        work.workArtifactPublish(
          name,
          "artifacts",
          {
            artifactId: "cross-home-artifact",
            parts: [{ kind: "text", text: "forged locally" }],
          },
          remoteActor
        )
      ),
    ]);

    for (const result of results) {
      expect(result).toMatchObject({ ok: false, code: "wrong_home" });
      if (!result.ok) {
        expect(result.message).toContain(
          "must originate on the installation that owns actor"
        );
      }
    }
    const snapshots = await workRuntime.runPromise(
      repository.snapshotsForCanvas(name)
    );
    expect(
      snapshots.find((snapshot) => snapshot.nodeId === "recipient")?.messages
        .items ?? []
    ).toEqual([]);
    expect(
      snapshots.find((snapshot) => snapshot.nodeId === "requests")?.requests
        .items ?? []
    ).toEqual([]);
    expect(
      snapshots.find((snapshot) => snapshot.nodeId === "artifacts")?.artifacts
        .items ?? []
    ).toEqual([]);
  });

  it("lets a Remote-local actor queue mail and create requests and artifacts offline", async () => {
    const isolatedRoot = join(
      tmpdir(),
      `vellum-command-work-remote-mail-${randomUUID()}`
    );
    const runtime = makeWorkRuntime(
      join(isolatedRoot, "state", "junto.db")
    );
    const commandCenter = installationId("command-center-mail");
    const hostId = stationHostId("studio");

    try {
      const station = await runtime.runPromise(StationRepository);
      const local = await runtime.runPromise(station.installationId);
      await runtime.runPromise(
        station.pair(
          PairRequest.make({
            protocol: STATION_API_PROTOCOL,
            op: "pair",
            commandCenterInstallationId: commandCenter,
            stationInstallationId: local,
            stationLabel: "Studio",
            appVersion: "test",
          })
        )
      );
      await runtime.runPromise(
        station.configureRemote(
          ConfigureRequest.make({
            protocol: STATION_API_PROTOCOL,
            op: "configure",
            installationId: local,
            configuration: {
              role: "remote",
              hostId,
              agentHostId: hostId,
              commandCenterInstallationId: commandCenter,
              supervisedPreferred: true,
            },
            host: {
              id: hostId,
              label: "Studio",
              kind: "remote",
              capabilities: ["terminal"],
            },
          })
        )
      );

      const canvasName = "remote-mail";
      const body = compileStationPortfolioBody(
        new Map([
          [
            canvasName,
            {
              nodes: [
                agentNode("sender", hostId),
                agentNode("recipient", hostId),
                emptyTaskNode("tasks"),
                emptyRequestsNode("requests"),
                {
                  id: "artifacts",
                  type: "text",
                  text: "artifacts",
                  x: 420,
                  y: 0,
                  width: 200,
                  height: 100,
                  ether: { entity: { kind: "artifacts" } },
                },
              ],
              edges: [
                {
                  id: "mail",
                  fromNode: "sender",
                  toNode: "recipient",
                  ether: { verb: "messages" },
                },
                {
                  id: "request",
                  fromNode: "sender",
                  toNode: "requests",
                  ether: { verb: "escalates" },
                },
                {
                  id: "artifact",
                  fromNode: "sender",
                  toNode: "artifacts",
                  ether: { verb: "publishes" },
                },
              ],
            } satisfies CanvasDoc,
          ],
        ]),
        new Map([[hostId, local]])
      );
      await runtime.runPromise(
        station.installProjection(
          ProjectRequest.make({
            protocol: STATION_API_PROTOCOL,
            op: "project",
            stationInstallationId: local,
            projection: {
              scope: "full",
              generation: logicalSequence("1"),
              sourceCanvasGeneration: logicalSequence("1"),
              sourceIntentSha256:
                stationProjectionContentSha256("remote work source"),
              body,
              contentSha256: stationProjectionContentSha256(body),
              createdAt: "2026-07-27T12:00:00.000Z",
            },
          })
        )
      );

      const canvases = await runtime.runPromise(CanvasesService);
      const read = await runtime.runPromise(canvases.read(canvasName));
      const sender = read.actorRefs.find(
        (candidate) => candidate.nodeId === "sender"
      );
      if (sender === undefined) throw new Error("missing Remote sender actor");
      const remoteWork = await runtime.runPromise(WorkService);
      const remoteRepository = await runtime.runPromise(WorkRepository);
      const basis = await activeIntentBasis(
        runtime,
        "projected-intent"
      );
      const taskSink = { canvasName, nodeId: "tasks" };
      const stationRepository = await runtime.runPromise(StationRepository);
      const projection = await runtime.runPromise(stationRepository.projection);
      if (projection === undefined) throw new Error("missing Remote projection");
      const dependencyScope =
        createCurrentProjectedTaskDependencyScopeCapability({
          rawBody: projection.body,
          generation: projection.generation,
          contentSha256: projection.contentSha256,
          authoringSink: taskSink,
        });
      await runtime.runPromise(
        remoteRepository.createTask({
          sink: taskSink,
          task: {
            id: "remote-operator-response",
            state: "submitted",
            history: [
              {
                messageId: "remote-operator-response-brief",
                role: "agent",
                parts: [{ kind: "text", text: "need approval" }],
                taskId: "remote-operator-response",
                contextId: canvasName,
              },
            ],
          },
          basis,
          dependencyScope,
        })
      );
      await runtime.runPromise(
        remoteRepository.claimLocalTask({
          sink: taskSink,
          taskId: "remote-operator-response",
          actor: sender,
          basis,
          dependencyScope,
        })
      );
      await runtime.runPromise(
        remoteRepository.transitionTask({
          sink: { canvasName, nodeId: "tasks" },
          taskId: "remote-operator-response",
          state: "input-required",
          basis,
        })
      );
      const deniedResponse = await runtime.runPromise(
        remoteWork.workTaskRespond(
          canvasName,
          "tasks",
          "remote-operator-response",
          "approved",
          "working"
        )
      );
      expect(deniedResponse).toMatchObject({ ok: false, code: "invalid" });
      expect(
        (await runtime.runPromise(remoteRepository.readSnapshot(canvasName, "tasks")))
          .tasks.items[0]?.history
      ).toHaveLength(1);
      const appended = await runtime.runPromise(
        remoteWork.workMessageAppend(
          canvasName,
          "recipient",
          null,
          {
            messageId: "remote-mail-1",
            role: "user",
            parts: [{ kind: "text", text: "from the station" }],
          },
          sender
        )
      );
      expect(appended).toMatchObject({
        ok: true,
        disposition: "queued",
      });
      const request = await runtime.runPromise(
        remoteWork.workRequestCreate(
          canvasName,
          "requests",
          "need operator input",
          undefined,
          sender,
          "blocked without operator decision"
        )
      );
      expect(request).toMatchObject({
        ok: true,
        disposition: "applied",
      });
      const artifact = await runtime.runPromise(
        remoteWork.workArtifactPublish(
          canvasName,
          "artifacts",
          {
            artifactId: "remote-artifact-1",
            parts: [{ kind: "text", text: "created while offline" }],
          },
          sender
        )
      );
      expect(artifact).toMatchObject({
        ok: true,
        disposition: "applied",
      });

      const pending = await runtime.runPromise(
        remoteRepository.pendingCommands
      );
      expect(pending).toHaveLength(1);
      expect(pending[0]).toMatchObject({
        resolution: undefined,
        command: {
          operation: "message.append",
          id: {
            route: {
              eventHome: local,
              entityHome: commandCenter,
            },
          },
          item: {
            kind: "message",
            itemId: "remote-mail-1",
            sink: { canvasName, nodeId: "recipient" },
          },
          body: {
            operation: "message.append",
            sentBy: sender,
          },
        },
      });
      const snapshots = await runtime.runPromise(
        remoteRepository.snapshotsForCanvas(canvasName)
      );
      expect(
        snapshots.find((snapshot) => snapshot.nodeId === "requests")?.requests
          .items
      ).toEqual([
        expect.objectContaining({
          state: "input-required",
          claimedBy: sender.seatId,
        }),
      ]);
      expect(
        snapshots.find((snapshot) => snapshot.nodeId === "artifacts")?.artifacts
          .items
      ).toEqual([
        expect.objectContaining({ artifactId: "remote-artifact-1" }),
      ]);
    } finally {
      await runtime.dispose();
      await rm(isolatedRoot, { recursive: true, force: true });
    }
  });
});

describe("WorkService — task path", () => {
  it("sends a completed task on and re-homes it submitted", async () => {
    const name = "path-send-on";
    await workRuntime.runPromise(
      canvases.write(name, {
        nodes: [
          {
            id: "rule-region",
            type: "group",
            label: "Quality",
            x: -50,
            y: -50,
            width: 300,
            height: 200,
            ether: {
              region: {
                contract: {
                  rules: [{ id: "completion-rule", text: "prove the change" }],
                },
              },
            },
          },
          {
            id: "s1",
            type: "text",
            text: "tasks",
            x: 0,
            y: 0,
            width: 200,
            height: 100,
            ether: { entity: { kind: "task" } },
          },
          {
            id: "s2",
            type: "text",
            text: "tasks",
            x: 400,
            y: 0,
            width: 200,
            height: 100,
            ether: { entity: { kind: "task" } },
          },
        ],
        edges: [
          {
            id: "flow-1",
            fromNode: "s1",
            toNode: "s2",
            ether: { verb: "feeds" },
          },
        ],
      })
    );
    const created = await workRuntime.runPromise(
      work.workTaskCreate(name, "s1", "follow the path", { details: "follow the path" })
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const taskId = created.data.id;

    // Rules gate: an unanswered rule blocks the completion.
    const blocked = await workRuntime.runPromise(
      work.workTaskTransition(name, "s1", taskId, "completed", undefined, {
        artifacts: [],
      })
    );
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(blocked.message).toContain("has no claim");
    }

    const sentOn = await workRuntime.runPromise(
      work.workTaskTransition(
        name,
        "s1",
        taskId,
        "completed",
        "checked and packaged",
        {
          artifacts: [],
          claims: [{ ruleId: "completion-rule", text: "verified by rerun" }],
        }
      )
    );
    expect(sentOn.ok).toBe(true);
    if (!sentOn.ok) return;
    expect(sentOn.data.state).toBe("completed");
    expect(sentOn.data.visits?.at(-1)?.exit).toBe("sent-on");
    expect(sentOn.data.visits?.at(-1)?.next).toBe("s2");

    const read = await workRuntime.runPromise(canvases.read(name));
    const s1Item = read.doc.nodes
      .find((n) => n.id === "s1")
      ?.ether?.tasks?.items.find((t) => t.id === taskId);
    const s2Item = read.doc.nodes
      .find((n) => n.id === "s2")
      ?.ether?.tasks?.items.find((t) => t.id === taskId);
    expect(s1Item?.state).toBe("completed");
    expect(s1Item?.completionEvidence?.claims?.[0]?.ruleId).toBe("completion-rule");
    expect(s2Item?.state).toBe("submitted");
    expect(s2Item?.claimedBy).toBeUndefined();
    expect(s2Item?.visits?.at(-1)?.board).toBe("s2");

    // Send back: rejecting at s2 with a defect re-opens the s1 row, epoch 1.
    const defected = await workRuntime.runPromise(
      work.workTaskTransition(
        name,
        "s2",
        taskId,
        "rejected",
        undefined,
        undefined,
        { defect: { summary: "misses the acceptance case" } }
      )
    );
    expect(defected.ok).toBe(true);
    if (!defected.ok) return;
    expect(defected.data.state).toBe("rejected");

    const after = await workRuntime.runPromise(canvases.read(name));
    const returned = after.doc.nodes
      .find((n) => n.id === "s1")
      ?.ether?.tasks?.items.find((t) => t.id === taskId);
    const rejectedRow = after.doc.nodes
      .find((n) => n.id === "s2")
      ?.ether?.tasks?.items.find((t) => t.id === taskId);
    expect(returned?.state).toBe("submitted");
    expect(returned?.epoch).toBe(1);
    expect(returned?.completionEvidence).toBeUndefined();
    expect(rejectedRow?.state).toBe("rejected");
    expect(rejectedRow?.visits?.at(-1)?.exit).toBe("sent-back");
  });

  it("holds a sent-on task from seat claims until its waitUntil passes", async () => {
    const name = "path-hold";
    await workRuntime.runPromise(
      canvases.write(name, {
        nodes: [
          {
            id: "h1",
            type: "text",
            text: "tasks",
            x: 0,
            y: 0,
            width: 200,
            height: 100,
            ether: { entity: { kind: "task" } },
          },
          {
            id: "h2",
            type: "text",
            text: "tasks",
            x: 400,
            y: 0,
            width: 200,
            height: 100,
            ether: { entity: { kind: "task" } },
          },
          agentNode("worker-1"),
        ],
        edges: [
          {
            id: "flow-h",
            fromNode: "h1",
            toNode: "h2",
            ether: { verb: "feeds" },
          },
          { id: "e-w", fromNode: "worker-1", toNode: "h2" },
        ],
      })
    );
    const read = await workRuntime.runPromise(canvases.read(name));
    const actor = read.actorRefs.find((ref) => ref.nodeId === "worker-1");
    if (actor === undefined) throw new Error("missing actor ref");

    const created = await workRuntime.runPromise(
      work.workTaskCreate(name, "h1", "wait for me", { details: "wait for me" })
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const sentOn = await workRuntime.runPromise(
      work.workTaskTransition(
        name,
        "h1",
        created.data.id,
        "completed",
        undefined,
        { artifacts: [] },
        { waitForMs: 60 * 60_000 }
      )
    );
    expect(sentOn.ok).toBe(true);

    const refused = await workRuntime.runPromise(
      work.workTaskClaim(name, "h2", created.data.id, actor)
    );
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.message).toContain("not claimable before");
    }

    // Approval applies only to approval-admission tasks.
    const misPromoted = await workRuntime.runPromise(
      work.workTaskPromote(name, "h2", created.data.id)
    );
    expect(misPromoted.ok).toBe(false);
    if (!misPromoted.ok) {
      expect(misPromoted.message).toContain(
        "approval applies to approval-admission tasks",
      );
    }
  });

  it("records operator context before approving or rejecting a task", async () => {
    const name = "approval-decision-context";
    await workRuntime.runPromise(
      canvases.write(name, {
        nodes: [
          {
            id: "gate",
            type: "text",
            text: "tasks",
            x: 0,
            y: 0,
            width: 200,
            height: 100,
            ether: {
              entity: { kind: "task" },
              tasks: {
                items: [],
                contract: { incoming: { admission: "approval" } },
              },
            },
          },
          agentNode("claimant"),
        ],
        edges: [{ id: "claim-edge", fromNode: "claimant", toNode: "gate" }],
      }),
    );
    const read = await workRuntime.runPromise(canvases.read(name));
    const actor = read.actorRefs.find((ref) => ref.nodeId === "claimant");
    if (actor === undefined) throw new Error("missing claimant actor ref");

    const promotedSource = await workRuntime.runPromise(
      work.workTaskCreate(name, "gate", "approve me", { details: "approve me" }),
    );
    if (!promotedSource.ok) throw new Error(promotedSource.message);
    const promoted = await workRuntime.runPromise(
      work.workTaskPromote(
        name,
        "gate",
        promotedSource.data.id,
        "Check the retry boundary first.",
      ),
    );
    expect(promoted.ok).toBe(true);
    if (!promoted.ok) return;
    expect(promoted.data.history.at(-1)).toMatchObject({
      role: "user",
      parts: [{ kind: "text", text: "Check the retry boundary first." }],
    });
    const claimed = await workRuntime.runPromise(
      work.workTaskClaim(name, "gate", promotedSource.data.id, actor),
    );
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) return;
    expect(
      claimed.data.history.flatMap((message) =>
        message.parts.flatMap((part) =>
          part.kind === "text" ? [part.text] : [],
        ),
      ),
    ).toEqual([
      "approve me",
      "Check the retry boundary first.",
    ]);

    // Rejecting an unapproved task is the generic task reject transition.
    const rejectedSource = await workRuntime.runPromise(
      work.workTaskCreate(name, "gate", "reject me", { details: "reject me" }),
    );
    expect(rejectedSource.ok).toBe(true);
    if (!rejectedSource.ok) return;
    const rejected = await workRuntime.runPromise(
      work.workTaskTransition(
        name,
        "gate",
        rejectedSource.data.id,
        "rejected",
        "The acceptance case is missing.",
      ),
    );
    expect(rejected.ok).toBe(true);
    if (!rejected.ok) return;
    expect(rejected.data).toMatchObject({
      state: "rejected",
      history: [
        expect.any(Object),
        {
          role: "agent",
          parts: [{ kind: "text", text: "The acceptance case is missing." }],
        },
      ],
    });

    const fastSource = await workRuntime.runPromise(
      work.workTaskCreate(name, "gate", "fast approve", { details: "fast approve" }),
    );
    expect(fastSource.ok).toBe(true);
    if (!fastSource.ok) return;
    const fast = await workRuntime.runPromise(
      work.workTaskPromote(name, "gate", fastSource.data.id),
    );
    expect(fast.ok).toBe(true);
    if (fast.ok) expect(fast.data.history).toHaveLength(1);
  });

  it("records check results from the board contract, truncating oversized output", async () => {
    const name = "path-checks";
    await workRuntime.runPromise(
      canvases.write(name, {
        nodes: [
          {
            id: "b1",
            type: "text",
            text: "tasks",
            x: 0,
            y: 0,
            width: 200,
            height: 100,
            ether: {
              entity: { kind: "task" },
              tasks: {
                items: [],
                contract: {
                  outgoing: {
                    checks: [
                      {
                        id: "out-1",
                        label: "build the bundle",
                        command: "bun run build",
                      },
                    ],
                  },
                },
              },
            },
          },
          {
            id: "b2",
            type: "text",
            text: "tasks",
            x: 400,
            y: 0,
            width: 200,
            height: 100,
            ether: {
              entity: { kind: "task" },
              tasks: {
                items: [],
                contract: {
                  incoming: {
                    checks: [
                      {
                        id: "in-1",
                        label: "lint the change",
                        command: "bun run lint",
                      },
                    ],
                  },
                },
              },
            },
          },
        ],
        edges: [
          {
            id: "flow-b",
            fromNode: "b1",
            toNode: "b2",
            ether: { verb: "feeds" },
          },
        ],
      })
    );
    const created = await workRuntime.runPromise(
      work.workTaskCreate(name, "b1", "check me", { details: "check me" })
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const taskId = created.data.id;

    // The seat submits an exit code and its output; command is the contract's
    // word, and the tail is capped no matter how loud the run was.
    const oversized = `${"n".repeat(9_000)}the last green line`;
    const checked = await workRuntime.runPromise(
      work.workTaskCheck(name, "b1", taskId, [
        {
          checkId: "out-1",
          side: "outgoing",
          exitCode: 0,
          outputTail: oversized,
        },
        { checkId: "in-1", side: "incoming", exitCode: 0, outputTail: "lint ok" },
      ])
    );
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;

    const read = await workRuntime.runPromise(canvases.read(name));
    const stored = read.doc.nodes
      .find((n) => n.id === "b1")
      ?.ether?.tasks?.items.find((t) => t.id === taskId);
    const outgoing = stored?.checkResults?.find(
      (result) => result.checkId === "out-1"
    );
    expect(outgoing).toMatchObject({
      side: "outgoing",
      command: "bun run build",
      exitCode: 0,
      epoch: 0,
    });
    expect(outgoing?.outputTail).toHaveLength(CHECK_OUTPUT_TAIL_MAX_BYTES);
    expect(outgoing?.outputTail.endsWith("the last green line")).toBe(true);
    expect(
      stored?.checkResults?.find((result) => result.checkId === "in-1")
    ).toMatchObject({
      side: "incoming",
      command: "bun run lint",
      exitCode: 0,
      epoch: 0,
    });

    // Green current-epoch results against the authored commands open the gate.
    const sentOn = await workRuntime.runPromise(
      work.workTaskTransition(name, "b1", taskId, "completed", undefined, {
        artifacts: [],
      })
    );
    expect(sentOn.ok).toBe(true);
    if (sentOn.ok) {
      expect(sentOn.data.visits?.at(-1)?.next).toBe("b2");
    }
  });

  it("layers nested regions, the board, and a board-addressed task rule, and sheds a superseded receipt", async () => {
    const name = "path-layer-depth";
    await workRuntime.runPromise(
      canvases.write(name, {
        nodes: [
          {
            id: "outer",
            type: "group",
            label: "Factory",
            x: -200,
            y: -200,
            width: 1600,
            height: 900,
            ether: {
              region: {
                contract: {
                  rules: [{ id: "outer-rule", text: "verify the factory boundary" }],
                },
              },
            },
          },
          {
            id: "inner",
            type: "group",
            label: "Review Lane",
            x: -100,
            y: -100,
            width: 900,
            height: 500,
            ether: {
              region: {
                contract: {
                  rules: [{ id: "inner-rule", text: "verify the review lane" }],
                },
              },
            },
          },
          {
            id: "d1",
            type: "text",
            text: "tasks",
            x: 0,
            y: 0,
            width: 200,
            height: 100,
            ether: {
              entity: { kind: "task" },
              tasks: {
                items: [],
                contract: {
                  rules: [{ id: "board-rule", text: "verify the board result" }],
                },
              },
            },
          },
          {
            id: "d2",
            type: "text",
            text: "tasks",
            x: 400,
            y: 0,
            width: 200,
            height: 100,
            ether: { entity: { kind: "task" } },
          },
        ],
        edges: [
          {
            id: "flow-d",
            fromNode: "d1",
            toNode: "d2",
            ether: { verb: "feeds" },
          },
        ],
      })
    );
    const created = await workRuntime.runPromise(
      work.workTaskCreate(
        name,
        "d1",
        "deep onion",
        { details: "deep onion" },
        undefined,
        undefined,
        undefined,
        undefined,
        [
          {
            id: "task-rule",
            text: "answer this here",
            board: "d1",
          },
        ]
      )
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const taskId = created.data.id;

    const atD1 = await workRuntime.runPromise(
      work.workTaskShow(name, "d1", taskId, "seat")
    );
    // Rules in force arrive outer to inner, then the board's own, then the
    // task rule addressed to this board.
    expect(atD1.rules.map((entry) => entry.rule.id)).toEqual([
      "outer-rule",
      "inner-rule",
      "board-rule",
      "task-rule",
    ]);
    expect(atD1.rules.map((entry) => entry.provenance.kind)).toEqual([
      "region",
      "region",
      "board",
      "task",
    ]);
    expect(atD1.ambient.regions.map((region) => region.label)).toEqual([
      "Factory",
      "Review Lane",
    ]);

    const sentOn = await workRuntime.runPromise(
      work.workTaskTransition(name, "d1", taskId, "completed", "lane pass done", {
        artifacts: [],
        claims: [
          { ruleId: "outer-rule", text: "factory boundary verified" },
          { ruleId: "inner-rule", text: "review lane verified" },
          { ruleId: "board-rule", text: "board result verified" },
          {
            ruleId: "task-rule",
            text: "answered at d1",
            refs: ["docs/lane-receipt.md"],
          },
        ],
      })
    );
    expect(sentOn.ok).toBe(true);

    const atD2 = await workRuntime.runPromise(
      work.workTaskShow(name, "d2", taskId, "seat")
    );
    expect(atD2.visits.find((v) => v.boardId === "d1")?.refs).toEqual([
      "docs/lane-receipt.md",
    ]);

    const defected = await workRuntime.runPromise(
      work.workTaskTransition(name, "d2", taskId, "rejected", undefined, undefined, {
        defect: { summary: "the lane pass missed the acceptance case" },
      })
    );
    expect(defected.ok).toBe(true);

    const afterDefect = await workRuntime.runPromise(
      work.workTaskShow(name, "d1", taskId, "seat")
    );
    // The defect shadows d1's receipt: the re-homed row carries no evidence,
    // so the visits there stop citing refs the task no longer stands on.
    const d1Visits = afterDefect.visits.filter((v) => v.boardId === "d1");
    expect(d1Visits).toHaveLength(2);
    expect(d1Visits.map((v) => v.refs)).toEqual([[], []]);
    expect(afterDefect.task.epoch).toBe(1);
    // The rule addressed here is open again, and the layered stack is intact.
    const rulesAfter = await workRuntime.runPromise(
      work.workTaskRules(name, "d1", taskId)
    );
    expect(rulesAfter.rules.map((entry) => entry.rule.id)).toEqual([
      "outer-rule",
      "inner-rule",
      "board-rule",
      "task-rule",
    ]);
    expect(
      rulesAfter.readiness?.unanswered.map((entry) => entry.ruleId)
    ).toContain("task-rule");
  });

  it("serves show/rules/rulings views with onion-scoped visits", async () => {
    const name = "path-views";
    await workRuntime.runPromise(
      canvases.write(name, {
        nodes: [
          {
            id: "region-1",
            type: "group",
            label: "Quality",
            x: -50,
            y: -50,
            width: 800,
            height: 400,
            ether: {
              region: {
                contract: {
                  rules: [{ id: "region-rule", text: "cite the rerun" }],
                  rulings: [
                    {
                      id: "ruling-1",
                      text: "always cite the rerun",
                      pinnedAt: "2026-08-20T00:00:00.000Z",
                    },
                  ],
                },
              },
            },
          },
          {
            id: "v1",
            type: "text",
            text: "tasks",
            x: 0,
            y: 0,
            width: 200,
            height: 100,
            ether: { entity: { kind: "task" } },
          },
          {
            id: "v2",
            type: "text",
            text: "tasks",
            x: 400,
            y: 0,
            width: 200,
            height: 100,
            ether: { entity: { kind: "task" } },
          },
        ],
        edges: [
          {
            id: "flow-v",
            fromNode: "v1",
            toNode: "v2",
            ether: { verb: "feeds" },
          },
        ],
      })
    );
    const created = await workRuntime.runPromise(
      work.workTaskCreate(name, "v1", "onion test", { details: "onion test" })
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const taskId = created.data.id;
    const sentOn = await workRuntime.runPromise(
      work.workTaskTransition(
        name,
        "v1",
        taskId,
        "completed",
        "the handoff note",
        {
          artifacts: [],
          claims: [
            {
              ruleId: "region-rule",
              text: "region rule satisfied",
              refs: ["docs/receipt.md"],
            },
          ],
        },
        { handoffNote: "the handoff note" }
      )
    );
    expect(sentOn.ok).toBe(true);

    const seatView = await workRuntime.runPromise(
      work.workTaskShow(name, "v2", taskId, "seat")
    );
    const priorVisit = seatView.visits.find((v) => v.boardId === "v1");
    expect(seatView.board.name).toBe("Tasks v2");
    expect(priorVisit?.board).toBe("Tasks v1");
    expect(priorVisit?.nextBoard).toBe("Tasks v2");
    expect(priorVisit?.handoffNote).toBe("the handoff note");
    expect(priorVisit?.refs).toEqual(["docs/receipt.md"]);
    // Onion: seat view never carries prior interiors.
    expect(priorVisit?.evidence).toBeUndefined();
    // The seat's task thread is brief + sent-on note, not the prior interior.
    expect(seatView.task.history.some((m) =>
      m.parts.some((p) => p.kind === "text" && p.text.includes("region rule satisfied"))
    )).toBe(false);

    const operatorView = await workRuntime.runPromise(
      work.workTaskShow(name, "v2", taskId, "operator")
    );
    expect(
      operatorView.visits.find((v) => v.boardId === "v1")?.evidence?.claims?.[0]
        ?.text
    ).toBe("region rule satisfied");

    const rulesView = await workRuntime.runPromise(
      work.workTaskRules(name, "v2", taskId)
    );
    expect(rulesView.rules.map((entry) => entry.rule.id)).toEqual(["region-rule"]);
    expect(
      rulesView.readiness?.unanswered.map((entry) => entry.ruleId)
    ).toEqual([]);

    const rulings = await workRuntime.runPromise(
      work.workRulingsList(name, "v2")
    );
    expect(rulings.regions[0]?.rulings[0]?.id).toBe("ruling-1");
  });
});

describe("WorkService — request resolve nudge and duplicate settle", () => {
  const waitUntil = async (
    pred: () => boolean | Promise<boolean>,
    timeoutMs = 2_000,
  ): Promise<void> => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (await pred()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("waitUntil timed out");
  };

  // Structural reads only — the request-response routing path never pays for
  // the work projection.
  const deliveryStore = (canvasName: string) => ({
    listCanvasNames: async () => [canvasName],
    readDoc: async (name: string) =>
      name === canvasName
        ? (await workRuntime.runPromise(canvases.read(name))).doc
        : undefined,
    readNodeStructure: async (name: string, nodeId: string) => {
      if (name !== canvasName) return undefined;
      const { doc } = await workRuntime.runPromise(canvases.read(name));
      const node = doc.nodes.find((candidate) => candidate.id === nodeId);
      return node === undefined ? undefined : { node, structure: doc };
    },
    hasAcceptedMessageDelivery: async () => false,
    hasAcceptedMessageRead: async () => false,
    acceptMessageDelivery: async () => true,
    acceptMessageRead: async () => true,
  });

  const raiseFromSender = async (name: string) => {
    await workRuntime.runPromise(
      canvases.write(name, {
        nodes: [emptyRequestsNode("req"), agentNode("sender")],
        edges: [
          {
            id: "edge-raise",
            fromNode: "sender",
            toNode: "req",
            ether: { verb: "escalates" },
          },
        ],
      })
    );
    const authorial = await workRuntime.runPromise(canvases.read(name));
    const actor = authorial.actorRefs.find(
      (candidate) => candidate.nodeId === "sender"
    );
    if (actor === undefined) throw new Error("missing actor ref for sender");
    return actor;
  };

  afterEach(() => {
    messageDelivery.resetForTest();
  });

  it("nudges the raising actor seat when its request resolves", async () => {
    const name = "work-resolve-nudge";
    const actor = await raiseFromSender(name);

    const writes: Array<{ bindingId: string; text: string }> = [];
    messageDelivery.configure({
      transport: {
        sendManagedTerminalPrompt: async (bindingId, text) => {
          writes.push({ bindingId, text });
          return { status: "submitted", bindingGeneration: 0, writesBefore: 0, writesAfter: 1, pasteWrites: 1, wrotePhysicalBytes: true };
        },
      },
      store: deliveryStore(name),
    });

    const created = await workRuntime.runPromise(
      work.workRequestCreate(
        name,
        "req",
        "approve the lane",
        undefined,
        actor,
        "cannot ship without sign-off"
      )
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const resolved = await workRuntime.runPromise(
      work.workRequestResolve(name, "req", created.data.id, "approved", "completed")
    );
    expect(resolved.ok).toBe(true);

    await waitUntil(() => writes.length === 1);
    expect(writes).toEqual([
      {
        bindingId: "binding-sender",
        text: `[request resolved - ${created.data.id}] approved`,
      },
    ]);
  });

  it("logs loudly instead of silently dropping when no live actor ref matches the claiming seat", async () => {
    const name = "work-resolve-nudge-zero";
    const actor = await raiseFromSender(name);

    const writes: Array<{ bindingId: string; text: string }> = [];
    messageDelivery.configure({
      transport: {
        sendManagedTerminalPrompt: async (bindingId, text) => {
          writes.push({ bindingId, text });
          return { status: "submitted", bindingGeneration: 0, writesBefore: 0, writesAfter: 1, pasteWrites: 1, wrotePhysicalBytes: true };
        },
      },
      store: deliveryStore(name),
    });

    const created = await workRuntime.runPromise(
      work.workRequestCreate(
        name,
        "req",
        "approve the lane",
        undefined,
        actor,
        "cannot ship without sign-off"
      )
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    // The raising seat leaves the canvas before the answer lands: no live
    // actor ref matches claimedBy, so there is nobody to nudge — but the
    // resolve must still apply and say so, never drop in silence.
    await workRuntime.runPromise(
      canvases.write(name, {
        nodes: [emptyRequestsNode("req")],
        edges: [],
      })
    );

    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const resolved = await workRuntime.runPromise(
        work.workRequestResolve(name, "req", created.data.id, "approved", "completed")
      );
      expect(resolved.ok).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(writes).toHaveLength(0);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("no live actor ref")
      );
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(created.data.id));
    } finally {
      warn.mockRestore();
    }
  });

  it("absorbs a stale second resolve of an already-resolved request", async () => {
    const name = "work-resolve-twice";
    const actor = await raiseFromSender(name);

    const created = await workRuntime.runPromise(
      work.workRequestCreate(
        name,
        "req",
        "approve the lane",
        undefined,
        actor,
        "cannot ship without sign-off"
      )
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const first = await workRuntime.runPromise(
      work.workRequestResolve(name, "req", created.data.id, "approved", "completed")
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    // The second surface (RequestInbox overlay or actor ledger) still holds
    // the pre-resolve view: its duplicate resolve must settle with the
    // current doc (surfaces refresh via applyWorkCanvasWrite), not error.
    const second = await workRuntime.runPromise(
      work.workRequestResolve(name, "req", created.data.id, "rejected", "completed")
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.message).toContain("already resolved");
    expect(second.data.state).toBe("completed");

    // Genuine failures stay errors.
    const missing = await workRuntime.runPromise(
      work.workRequestResolve(name, "req", "no-such-request", "approved", "completed")
    );
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.code).toBe("task_not_found");
  });
});
