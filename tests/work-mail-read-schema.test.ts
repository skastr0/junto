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
  readCanvasWorkRevision,
  WorkRepository,
  WorkRepositoryLive,
} from "../src/main/junto/work/repository";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { IntentFactBasis } from "../src/shared/work-protocol";
import { Message } from "../src/shared/work-model";
import { ContentRef } from "../src/shared/content";
import { serializeCanvas, type CanvasDoc } from "../src/shared/canvas";
import { seedCanvasAuthority } from "./helpers/canvas-authority-material";
import { authorialMaterialForTest } from "./helpers/authorial-material";

const root = join(tmpdir(), `junto-mail-read-schema-${randomUUID()}`);
const runtime = ManagedRuntime.make(
  Layer.provideMerge(
    WorkRepositoryLive,
    makeStateEngineLive(join(root, "junto.db")),
  ),
);

let repository: Context.Service.Shape<typeof WorkRepository>;
let sql: SqlClient.SqlClient;

const observedAt = "2026-08-18T09:00:00.000Z";
const cc = Schema.decodeUnknownSync(InstallationId)("cc-mail-read-schema");
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
  kind: "canvas", canvasName: "factory", seq: 1,
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

describe("work mail read schema", () => {
  it("reads schema-valid mail values and content references", async () => {
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

    // Content refs are carried by value, whatever key order the durable JSON
    // column happens to use.
    const inbox = await runtime.runPromise(repository.mailPage({ canvasName: "factory", nodeId: "agent-1" }));
    for (const item of inbox.items) expect(() => Schema.decodeUnknownSync(Message, strict)(item.message)).not.toThrow();
    const part = inbox.items[0]?.message.parts[1];
    expect(part).toEqual({
      kind: "content",
      ref: contentRef("c".repeat(64), 34),
    });
  });

  it("moves the work revision on every mutation and never backwards", async () => {
    const read = () =>
      runtime.runPromise(
        withSqlRead(sql, readCanvasWorkRevision(sql, "factory")),
      );

    const before = BigInt(await read());
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

    const after = BigInt(await read());
    expect(after).toBeGreaterThan(before);

    // A pure read never moves it.
    expect(BigInt(await read())).toBe(after);
  });
});
