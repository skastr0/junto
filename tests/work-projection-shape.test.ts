// The read path builds already-typed values instead of decoding them.
//
// `loadSnapshot` used to end in `Schema.decodeUnknownSync(WorkSnapshot)`, so
// the schema was re-decided on every read of the world — 24 MB/s of Effect
// Schema decode on the operator's live factory. Validation now lives at
// ingress (every mutation decodes before it commits) and in the SQLite CHECK
// domains, and the read path constructs.
//
// That trade is only honest if the constructed value still satisfies the
// schema exactly. This test is where that is decided now: seed a seat's
// mailbox through the real write path, read it back, and
// require the projection to decode against `WorkSnapshot` with
// `onExcessProperty: "error"`. A construction that drifts from the schema —
// a missing field, a stray key, a wrong literal — fails here instead of
// reaching the renderer.
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context, Effect, Layer, ManagedRuntime, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { withSqlRead } from "../src/main/junto/state/sql-read";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ActorSeatId } from "../src/shared/actor-seat";
import { InstallationId } from "../src/shared/installation-id";
import {
  readCanvasWorkProjection,
  WorkRepository,
  WorkRepositoryLive,
} from "../src/main/junto/work/repository";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { IntentFactBasis } from "../src/shared/work-protocol";
import { WorkSnapshot } from "../src/shared/work-model";
import { ContentRef } from "../src/shared/content";
import { serializeCanvas, type CanvasDoc } from "../src/shared/canvas";
import { seedCanvasAuthority } from "./helpers/canvas-authority-material";
import { authorialMaterialForTest } from "./helpers/authorial-material";

const root = join(tmpdir(), `junto-projection-shape-${randomUUID()}`);
const runtime = ManagedRuntime.make(
  Layer.provideMerge(
    WorkRepositoryLive,
    makeStateEngineLive(join(root, "junto.db")),
  ),
);

let repository: Context.Service.Shape<typeof WorkRepository>;
let sql: SqlClient.SqlClient;

const observedAt = "2026-08-18T09:00:00.000Z";
const cc = Schema.decodeUnknownSync(InstallationId)("cc-projection-shape");
const authorityTopology: CanvasDoc = {
  nodes: [
    {
      id: "agent-1",
      type: "text",
      x: 0,
      y: 0,
      width: 180,
      height: 80,
      text: "Planner",
      ether: { entity: { kind: "agent", name: "local:planner" } },
    },
  ],
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
  Schema.decodeUnknownSync(
    ContentRef,
    strict,
  )({
    sha256: sha,
    byteLength,
    mediaType: "image/png",
  });

const seed = () =>
  sql.withTransaction(
    Effect.gen(function* () {
      yield* sql.unsafe(
        `INSERT INTO station_known_installations(installation_id, registered_at)
       VALUES (?, ?)`,
        [cc, observedAt],
      );
      yield* sql.unsafe(
        `INSERT INTO station_installation(singleton, installation_id, created_at)
       VALUES (1, ?, ?)`,
        [cc, observedAt],
      );
      yield* sql.unsafe(
        `INSERT INTO station_configuration(
         singleton, role, host_id, agent_host_id,
         command_center_installation_id, supervised_preferred, configured_at
       ) VALUES (1, 'command-center', 'local', NULL, NULL, 1, ?)`,
        [observedAt],
      );
      yield* seedCanvasAuthority({
        generation: "1",
        documents: new Map([["factory", authorityTopology]]),
        at: observedAt,
      });
    }),
  );

beforeAll(async () => {
  repository = await runtime.runPromise(WorkRepository);
  sql = await runtime.runPromise(SqlClient.SqlClient);
  await runtime.runPromise(seed());
});

afterAll(async () => {
  await runtime.dispose();
  await rm(root, { recursive: true, force: true });
});

describe("work projection shape", () => {
  it("constructs a snapshot that satisfies WorkSnapshot exactly", async () => {
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
          // A ContentPart is the shape whose durable JSON key order
          // differs from the schema's declaration order.
          parts: [
            { kind: "text", text: "ship it" },
            { kind: "content", ref: contentRef("c".repeat(64), 34) },
          ],
          metadata: { fromSeat: "agent-1" },
        },
        originAt: observedAt,
        receivedAt: observedAt,
      }),
    );

    const projection = await runtime.runPromise(
      withSqlRead(sql, readCanvasWorkProjection(sql, "factory")),
    );

    const seen = projection.snapshots.map((snapshot) => snapshot.nodeId).sort();
    expect(seen).toEqual(["agent-1"]);

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
    const part = inbox?.messages.items[0]?.parts[1];
    expect(part).toEqual({
      kind: "content",
      ref: contentRef("c".repeat(64), 34),
    });
  });

  it("moves the work revision on every mutation and never backwards", async () => {
    const read = () =>
      runtime.runPromise(
        withSqlRead(sql, readCanvasWorkProjection(sql, "factory")),
      );

    const before = BigInt((await read()).workRevision);
    expect(before).toBeGreaterThan(0n);

    await runtime.runPromise(
      repository.appendMessage({
        sink: { canvasName: "factory", nodeId: "agent-1" },
        basis,
        sentBy: actor,
        destination: { kind: "mailbox" },
        message: {
          messageId: "m-inbox-2",
          role: "user",
          parts: [{ kind: "text", text: "second" }],
          metadata: { fromSeat: "agent-1" },
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
