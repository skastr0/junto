import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { Effect, ManagedRuntime } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { makeStateEngineLive, StateEngine } from "../src/main/vellum/state/engine";
import {
  CURRENT_STATE_SCHEMA_VERSION,
} from "../src/main/vellum/state/migrations";
import { STATE_SCHEMA_V20_SQL } from "../src/main/vellum/state/schema";
import { verifyAndStampStateSchema } from "../src/main/vellum/state/schema-identity";
import { reconstructCanvasDoc } from "../src/main/vellum/canvas/records";

/**
 * The 20 -> 21 consolidation must admit bodies written by OLD builds: retired
 * node ether keys from removed integrations and legacy edge wire fields fail the strict
 * decoder, and the bridge is the one sanctioned conversion moment for both.
 * Caught live by the pty battery against a real dev home; this pins it.
 */

const sha256 = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

const LEGACY_BODY = JSON.stringify({
  nodes: [
    {
      id: "seat",
      type: "text",
      x: 0,
      y: 0,
      width: 220,
      height: 84,
      text: "seat",
      ether: {
        entity: { kind: "agent", name: "local:seat" },
        // Retired extension from a removed integration: strict decode refuses
        // it; the cutover must drop it, not brick the boot.
        retiredExtension: { profile: "legacy", attached: true },
      },
    },
    {
      id: "queue",
      type: "text",
      x: 320,
      y: 0,
      width: 220,
      height: 84,
      text: "queue",
      ether: { entity: { kind: "task" }, tasks: { items: [] } },
    },
  ],
  edges: [
    {
      id: "wire",
      fromNode: "seat",
      toNode: "queue",
      // Legacy wire fields: the one-shot edge conversion infers the verb.
      ether: { ports: ["tasks.claim"], wake: false },
    },
  ],
});

let root: string | undefined;
let runtime: ReturnType<typeof ManagedRuntime.make<StateEngine, unknown>> | undefined;

afterEach(async () => {
  await runtime?.dispose();
  runtime = undefined;
  if (root !== undefined) await rm(root, { recursive: true, force: true });
  root = undefined;
});

describe("canvas cutover with legacy bodies", () => {
  it("admits retired node ether keys and legacy edge fields, once", async () => {
    root = await mkdtemp(join(tmpdir(), "vellum-cutover-legacy-"));
    const path = join(root, "vellum-command.db");
    const v20 = new DatabaseSync(path);
    try {
      v20.exec(STATE_SCHEMA_V20_SQL);
      v20.prepare(
        `INSERT INTO canvas_generations(
           generation, created_at, cause, intent_sha256, document_count
         ) VALUES ('7', ?, 'seed', ?, 1)`,
      ).run("2026-08-01T00:00:00.000Z", "a".repeat(64));
      v20.prepare(
        `INSERT INTO canvas_generation_documents(
           generation, name, body, sha256, modified_at
         ) VALUES ('7', 'factory', ?, ?, ?)`,
      ).run(LEGACY_BODY, sha256(LEGACY_BODY), "2026-08-01T00:00:00.000Z");
      v20.prepare(
        "INSERT INTO canvas_head(singleton, generation) VALUES (1, '7')",
      ).run();
      verifyAndStampStateSchema(v20, STATE_SCHEMA_V20_SQL);
      v20.exec("PRAGMA user_version = 20");
    } finally {
      v20.close();
    }

    runtime = ManagedRuntime.make(makeStateEngineLive(path));
    const state = await runtime.runPromise(StateEngine);
    expect(state.info.schemaVersion).toBe(CURRENT_STATE_SCHEMA_VERSION);

    const migrated = await runtime.runPromise(
      state.read("cutover-legacy.verify", (reader) => {
        const document = reader.get<{
          readonly canvas_id: string;
          readonly canvas_name: string;
        }>("SELECT canvas_id, canvas_name FROM canvas_documents");
        if (document === undefined) throw new Error("no canvas_documents row");
        return {
          name: document.canvas_name,
          doc: reconstructCanvasDoc(reader, document.canvas_id),
          head: reader.get<{ readonly generation: string }>(
            "SELECT generation FROM canvas_portfolio_head WHERE singleton = 1",
          ),
        };
      }),
    );

    expect(migrated.name).toBe("factory");
    expect(migrated.head?.generation).toBe("7");
    expect(migrated.doc.nodes.map((node) => node.id)).toEqual(["seat", "queue"]);
    // The retired extension is gone; the durable rows never carry it again.
    expect(JSON.stringify(migrated.doc.nodes[0]?.ether)).not.toContain("retiredExtension");
    // The legacy wire converted to its verb (ports carried tasks.claim,
    // wake false — the access verb for a task sink is contributes).
    expect(migrated.doc.edges).toHaveLength(1);
    expect(migrated.doc.edges[0]?.ether).toEqual({ verb: "contributes" });
  });
});
