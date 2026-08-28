import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  CURRENT_STATE_SCHEMA_VERSION,
  migrateStateSchema,
  STATE_SCHEMA_V20_IDENTITY,
  STATE_SCHEMA_V21_IDENTITY,
  STATE_SCHEMA_V22_IDENTITY,
} from "../src/main/vellum/state/migrations";
import {
  STATE_SCHEMA_SQL,
  STATE_SCHEMA_V20_SQL,
  STATE_SCHEMA_V21_SQL,
} from "../src/main/vellum/state/schema";
import {
  expectedStateSchemaIdentity,
  verifyAndStampStateSchema,
} from "../src/main/vellum/state/schema-identity";
import {
  backfillGenerationToRelational,
  nodeSemanticHash,
  edgeSemanticHash,
  canvasDocSemanticHash,
} from "../src/main/vellum/canvas/relational-backfill";
import { serializeCanvas, type CanvasDoc } from "../src/shared/canvas";
import { intentSha256Of } from "../src/main/vellum/canvas-intent-identity";

describe("canvas relational authority schema migration 20 → 21", () => {
  it("freezes v20, v21, and current v22 identities", () => {
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V20_SQL)).toEqual(
      STATE_SCHEMA_V20_IDENTITY,
    );
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V21_SQL)).toEqual(
      STATE_SCHEMA_V21_IDENTITY,
    );
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_SQL)).toEqual(
      STATE_SCHEMA_V22_IDENTITY,
    );
    expect(CURRENT_STATE_SCHEMA_VERSION).toBe(22);
  });

  it("migrates v20 database to v22 and creates all relational authority tables", () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(STATE_SCHEMA_V20_SQL);
      verifyAndStampStateSchema(database, STATE_SCHEMA_V20_SQL);
      database.exec("PRAGMA user_version = 20");

      const result = migrateStateSchema(database);
      expect(result.schemaVersion).toBe(22);
      expect(result.previousVersion).toBe(20);
      expect(result.actualSchemaSha256).toBe(
        STATE_SCHEMA_V22_IDENTITY.actualSchemaSha256,
      );

      const expectedTables = [
        "canvas_documents",
        "canvas_objects",
        "canvas_nodes",
        "canvas_edges",
        "canvas_checkpoints",
        "canvas_commit_envelopes",
        "canvas_generation_manifests",
        "canvas_change_tail",
        "canvas_authoring_tail_state",
      ];

      for (const table of expectedTables) {
        const row = database
          .prepare(
            "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?",
          )
          .get(table) as { name: string } | undefined;
        expect(row?.name).toBe(table);
      }
    } finally {
      database.close();
    }
  });

  it("enforces immutability triggers on checkpoints, envelopes, and manifests", () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(STATE_SCHEMA_SQL);
      verifyAndStampStateSchema(database, STATE_SCHEMA_SQL);
      database.exec("PRAGMA user_version = 22");

      const sha = "a".repeat(64);
      database.exec(`
        INSERT INTO canvas_checkpoints (sha256, byte_length, body, created_at)
        VALUES ('${sha}', 10, '{"nodes":[]}', '2026-01-01T00:00:00.000Z');
      `);

      expect(() => {
        database.exec(`
          UPDATE canvas_checkpoints SET byte_length = 20 WHERE sha256 = '${sha}'
        `);
      }).toThrow(/immutable/);

      expect(() => {
        database.exec(`
          DELETE FROM canvas_checkpoints WHERE sha256 = '${sha}'
        `);
      }).toThrow(/immutable/);
    } finally {
      database.close();
    }
  });

  it("performs idempotent and verifiable backfill from whole-document generations", () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(STATE_SCHEMA_SQL);
      verifyAndStampStateSchema(database, STATE_SCHEMA_SQL);
      database.exec("PRAGMA user_version = 22");

      const doc: CanvasDoc = {
        nodes: [
          {
            id: "n1",
            type: "text",
            text: "Worker",
            x: 100,
            y: 200,
            width: 300,
            height: 150,
            ether: {
              entity: { kind: "agent", name: "local:worker" },
              flags: ["blocker"],
            },
          },
          {
            id: "n2",
            type: "text",
            text: "Task Queue",
            x: 500,
            y: 200,
            width: 300,
            height: 150,
            ether: {
              entity: { kind: "task" },
            },
          },
        ],
        edges: [
          {
            id: "e1",
            fromNode: "n2",
            toNode: "n1",
            ether: {
              verb: "works",
            },
          },
        ],
      };

      const body = serializeCanvas(doc);
      const docSha = createHash("sha256").update(body, "utf8").digest("hex");
      const intentSha = intentSha256Of(
        new Map([["factory", { revisionSha256: docSha }]]),
      );

      database.exec(`
        INSERT INTO canvas_generations (generation, created_at, cause, intent_sha256, document_count)
        VALUES ('1', '2026-01-01T00:00:00.000Z', 'seed', '${intentSha}', 1);

        INSERT INTO canvas_generation_documents (generation, name, body, sha256, modified_at)
        VALUES ('1', 'factory', '${body.replace(/'/g, "''")}', '${docSha}', '2026-01-01T00:00:00.000Z');

        INSERT INTO canvas_head (singleton, generation) VALUES (1, '1');
      `);

      // First backfill pass
      const writer: any = {
        get: (sql: string, params?: readonly any[]) => database.prepare(sql).get(...(params ?? [])) as any,
        all: (sql: string, params?: readonly any[]) => database.prepare(sql).all(...(params ?? [])) as any,
        run: (sql: string, params?: readonly any[]) => database.prepare(sql).run(...(params ?? [])) as any,
      };

      const pass1 = backfillGenerationToRelational(writer, "1");
      expect(pass1.canvases).toBe(1);
      expect(pass1.checkpoints).toBe(1);
      expect(pass1.nodes).toBe(2);
      expect(pass1.edges).toBe(1);

      // Verify records in relational tables
      const docRow = database.prepare("SELECT * FROM canvas_documents WHERE canvas_name = 'factory'").get() as any;
      expect(docRow.canvas_name).toBe("factory");
      expect(docRow.head_generation).toBe("1");

      const nodeRows = database.prepare("SELECT * FROM canvas_nodes WHERE canvas_id = ?").all(docRow.canvas_id) as any[];
      expect(nodeRows.length).toBe(2);
      expect(nodeRows.map((n) => n.node_id).sort()).toEqual(["n1", "n2"]);
      expect(nodeRows.find((n) => n.node_id === "n1").entity_kind).toBe("agent");

      const edgeRows = database.prepare("SELECT * FROM canvas_edges WHERE canvas_id = ?").all(docRow.canvas_id) as any[];
      expect(edgeRows.length).toBe(1);
      expect(edgeRows[0].edge_id).toBe("e1");
      expect(edgeRows[0].verb).toBe("works");

      // Idempotency check: run backfill again on same generation
      const pass2 = backfillGenerationToRelational(writer, "1");
      expect(pass2.canvases).toBe(0); // already exists
      expect(pass2.checkpoints).toBe(0); // already exists
      expect(pass2.nodes).toBe(2); // updated
      expect(pass2.edges).toBe(1); // updated

      // Re-verify counts haven't duplicated
      const nodeCount = database.prepare("SELECT count(*) as c FROM canvas_nodes").get() as any;
      expect(nodeCount.c).toBe(2);
    } finally {
      database.close();
    }
  });
});
