// The read path builds already-typed values instead of decoding them.
//
// `loadSnapshot` used to end in `Schema.decodeUnknownSync(WorkSnapshot)`, so
// the schema was re-decided on every read of the world — 24 MB/s of Effect
// Schema decode on the operator's live factory. Validation now lives at
// ingress (every mutation decodes before it commits) and in the SQLite CHECK
// domains, and the read path constructs.
//
// That trade is only honest if the constructed value still satisfies the
// schema exactly. This test is where that is decided now: seed one sink
// through the real write path with every lane populated, read it back, and
// require the projection to decode against `WorkSnapshot` with
// `onExcessProperty: "error"`. A construction that drifts from the schema —
// a missing field, a stray key, a wrong literal — fails here instead of
// reaching the renderer.
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context, Layer, ManagedRuntime, Schema } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ActorSeatId } from "../src/shared/actor-seat";
import { InstallationId } from "../src/shared/installation-id";
import {
  readCanvasWorkProjection,
  WorkRepository,
  WorkRepositoryLive,
} from "../src/main/vellum/work/repository";
import {
  makeStateEngineLive,
  StateEngine,
} from "../src/main/vellum/state/engine";
import { IntentFactBasis } from "../src/shared/work-protocol";
import { WorkSnapshot } from "../src/shared/work-model";
import { ContentRef } from "../src/shared/content";
import { serializeCanvas, type CanvasDoc } from "../src/shared/canvas";
import { seedCanvasAuthority } from "./helpers/canvas-authority-material";
import {
  authorialMaterialForTest,
  authorialTaskTopologyCapabilityForTest,
} from "./helpers/task-topology-authority";

const root = join(tmpdir(), `vellum-command-projection-shape-${randomUUID()}`);
const runtime = ManagedRuntime.make(
  Layer.provideMerge(
    WorkRepositoryLive,
    makeStateEngineLive(join(root, "vellum-command.db")),
  ),
);

let repository: Context.Service.Shape<typeof WorkRepository>;
let state: Context.Service.Shape<typeof StateEngine>;

const observedAt = "2026-08-18T09:00:00.000Z";
const cc = Schema.decodeUnknownSync(InstallationId)("cc-projection-shape");
const authorityTopology: CanvasDoc = {
  nodes: [{
    id: "tasks-1",
    type: "text",
    x: 0,
    y: 0,
    width: 180,
    height: 80,
    text: "Tasks",
    ether: { entity: { kind: "task" } },
  }],
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
const seatId = Schema.decodeUnknownSync(ActorSeatId)(`seat_${"a".repeat(64)}`);
const actor = { seatId, canvasName: "factory", nodeId: "agent-1" };
const strict = { onExcessProperty: "error" } as const;

const contentRef = (sha: string, byteLength: number) =>
  Schema.decodeUnknownSync(ContentRef, strict)({
    sha256: sha,
    byteLength,
    mediaType: "image/png",
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

describe("work projection shape", () => {
  it("constructs a snapshot that satisfies WorkSnapshot exactly", async () => {
    const taskSink = { canvasName: "factory", nodeId: "tasks-1" };

    await runtime.runPromise(
      repository.createTask({
        sink: taskSink,
        basis,
        dependencyScope: authorialTaskTopologyCapabilityForTest({
          basis,
          sink: taskSink,
          document: authorityTopology,
          rawBody: authorityRawBody,
        }),
        task: {
          id: "task-1",
          state: "submitted",
          history: [
            {
              messageId: "m-brief",
              role: "user",
              // A ContentPart is the shape whose durable JSON key order
              // differs from the schema's declaration order.
              parts: [
                { kind: "text", text: "ship it" },
                { kind: "content", ref: contentRef("b".repeat(64), 12) },
              ],
            },
          ],
          finishCriteria: { description: "prove it" },
          metadata: { origin: "test" },
          reason: "because",
        },
        originAt: observedAt,
        receivedAt: observedAt,
      }),
    );

    await runtime.runPromise(
      repository.createProposal({
        sink: taskSink,
        basis,
        proposal: {
          id: "proposal-1",
          state: "pending",
          brief: {
            messageId: "m-proposal",
            role: "agent",
            parts: [{ kind: "text", text: "consider this" }],
            contextId: "projection-shape",
          },
          proposedBy: actor,
          finishCriteria: { description: "definition of done" },
          reason: "worth doing",
        },
        originAt: observedAt,
        receivedAt: observedAt,
      }),
    );

    const requestSink = { canvasName: "factory", nodeId: "requests-1" };
    await runtime.runPromise(
      repository.createRequest({
        sink: requestSink,
        basis,
        raisedBy: actor,
        request: {
          // Requests are auto-claimed by their raiser; the repository refuses
          // any other shape.
          id: "request-1",
          state: "input-required",
          claimedBy: seatId,
          history: [
            {
              messageId: "m-request",
              role: "agent",
              parts: [{ kind: "text", text: "need a decision" }],
            },
          ],
        },
        originAt: observedAt,
        receivedAt: observedAt,
      }),
    );

    const mailbox = { canvasName: "factory", nodeId: "agent-1" };
    await runtime.runPromise(
      repository.appendMessage({
        sink: mailbox,
        basis,
        sentBy: actor,
        destination: { kind: "mailbox" },
        message: {
          messageId: "m-inbox",
          role: "user",
          parts: [
            { kind: "content", ref: contentRef("c".repeat(64), 34) },
          ],
          metadata: { fromSeat: "agent-1" },
        },
        originAt: observedAt,
        receivedAt: observedAt,
      }),
    );

    const artifactSink = { canvasName: "factory", nodeId: "artifacts-1" };
    await runtime.runPromise(
      repository.publishArtifact({
        sink: artifactSink,
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
    );

    const boardSink = { canvasName: "factory", nodeId: "board-1" };
    await runtime.runPromise(
      repository.createBoardTopic({
        sink: boardSink,
        basis,
        createdBy: { kind: "operator" },
        topic: {
          topicId: "topic-1",
          title: "first topic",
          state: "open",
          openedBy: { kind: "operator" },
          openedAt: observedAt,
          postCount: 0,
          lastActivityAt: observedAt,
          parts: [{ kind: "text", text: "opening" }],
        },
        originAt: observedAt,
        receivedAt: observedAt,
      }),
    );
    await runtime.runPromise(
      repository.appendBoardPost({
        sink: boardSink,
        basis,
        createdBy: { kind: "actor", seatId, nodeId: "agent-1" },
        post: {
          postId: "post-1",
          topicId: "topic-1",
          author: { kind: "actor", seatId, nodeId: "agent-1" },
          parts: [{ kind: "text", text: "replying" }],
          position: 1,
          createdAt: observedAt,
        },
        originAt: observedAt,
        receivedAt: observedAt,
      }),
    );

    const projection = await runtime.runPromise(
      state.read("test.read-projection", (reader) =>
        readCanvasWorkProjection(reader, "factory"),
      ),
    );

    const seen = projection.snapshots.map((snapshot) => snapshot.nodeId).sort();
    expect(seen).toEqual([
      "agent-1",
      "artifacts-1",
      "board-1",
      "requests-1",
      "tasks-1",
    ]);

    // The gate. Every constructed snapshot must satisfy the schema the read
    // path no longer decodes against.
    for (const snapshot of projection.snapshots) {
      expect(() =>
        Schema.decodeUnknownSync(WorkSnapshot, strict)(snapshot),
      ).not.toThrow();
    }

    // Content refs are carried by value, whatever key order the durable JSON
    // column happens to use.
    const inbox = projection.snapshots.find(
      (snapshot) => snapshot.nodeId === "agent-1",
    );
    const part = inbox?.messages.items[0]?.parts[0];
    expect(part).toEqual({
      kind: "content",
      ref: contentRef("c".repeat(64), 34),
    });
  });

  it("moves the work revision on every mutation and never backwards", async () => {
    const read = () =>
      runtime.runPromise(
        state.read("test.read-revision", (reader) =>
          readCanvasWorkProjection(reader, "factory"),
        ),
      );

    const before = BigInt((await read()).workRevision);
    expect(before).toBeGreaterThan(0n);

    await runtime.runPromise(
      repository.publishArtifact({
        sink: { canvasName: "factory", nodeId: "artifacts-1" },
        basis,
        publishedBy: actor,
        artifact: {
          artifactId: "artifact-2",
          parts: [{ kind: "text", text: "second" }],
        },
        originAt: observedAt,
        receivedAt: observedAt,
      }),
    );

    const after = BigInt((await read()).workRevision);
    expect(after).toBeGreaterThan(before);

    // A pure read never moves it.
    expect(BigInt((await read()).workRevision)).toBe(after);
  });
});
