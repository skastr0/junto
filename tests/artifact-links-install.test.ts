/**
 * The release gate for body backlinks (0.11, 02): an install that predates the
 * step. A 0.10.3-shaped store — the shipped fixture brought to version 50 by
 * the real steps, holding a document, a pad and a sheet written by hand the way
 * 0.10.3 held them — steps through 51 and 52, the backfill walks it, and
 * "Linked from" reads every link without a single artifact being edited.
 */
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { Effect, Layer, ManagedRuntime } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { afterEach, describe, expect, it } from "vitest";
import { mentionHref } from "../src/shared/mention";
import { asNodeId, type Canvas, type Node } from "../src/shared/model";
import {
  STATE_SCHEMA_MIGRATION_PLAN,
  STATE_SCHEMA_MIGRATIONS,
  migrateStateSchema,
  type StateSchemaMigrationPlan,
} from "../src/main/junto/state/migrations";
import { STATE_SCHEMA_SQL } from "../src/main/junto/state/schema";
import { migrateMachineNames } from "../src/main/junto/state/migrate-machine-names";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { makeInstallOpsLive } from "../src/main/junto/install-ops/engine";
import { InstallOpsService } from "../src/main/junto/install-ops/service";
import { linkedFromBodies } from "../src/main/junto/work/body-links";
import { runArtifactLinksBackfill } from "../src/main/junto/work/artifact-links-backfill";
import { STATE_SCHEMA_V50_SQL } from "./fixtures/state-v13/schema";

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

const named = <T extends { readonly toVersion: number; readonly migrate: (database: DatabaseSync) => void }>(step: T): T =>
  step.toVersion === 21 ? { ...step, migrate: (database: DatabaseSync) => migrateMachineNames(database, "macbook") } : step;

const upTo = (version: number, currentSchemaSql: string): StateSchemaMigrationPlan => ({
  ...STATE_SCHEMA_MIGRATION_PLAN,
  currentVersion: version,
  currentSchemaSql,
  migrations: STATE_SCHEMA_MIGRATIONS.filter((step) => step.toVersion <= version).map(named),
});

const CANVAS = "factory";
const SHELF = "artifacts-shelf";
const BUDGET = "01M5EVKRB1X4P80GXRGDK8V5AS";
const PLAN = "01M5EVKRB1X4P80GXRGDK8V5AT";
const NOTES = "01M5EVKRB1X4P80GXRGDK8V5AV";
/** The shipped fixture's plan id, so the store is one a 0.10.3 install could hold. */
const REF = { sha256: "a".repeat(64), byteLength: 128, mediaType: "application/json" };

const link = (artifactId: string, label: string): string =>
  `[${label}](${mentionHref({ kind: "artifact", nodeId: asNodeId(SHELF), artifactId: artifactId as never }, CANVAS)})`;

/** A body as 0.10.3 stored it: canonical JSON inline on the version row. */
type Held = { readonly artifactId: string; readonly title: string; readonly type: "document" | "pad" | "sheet"; readonly body: unknown };

const HELD: ReadonlyArray<Held> = [
  { artifactId: BUDGET, title: "Budget", type: "document", body: { type: "document", markdown: "# Budget\nwhat the year costs" } },
  {
    artifactId: PLAN,
    title: "Plan",
    type: "document",
    body: {
      type: "document",
      markdown: `# Plan\n\nThe ${link(BUDGET, "Budget")} fixes what we may spend.\nNothing else.`,
    },
  },
  {
    artifactId: NOTES,
    title: "Notes",
    type: "pad",
    body: {
      type: "pad",
      pad: {
        revision: 0,
        images: [],
        edges: [],
        inks: [],
        shapes: [{ id: "s1", type: "box", x: 0, y: 0, w: 120, h: 60, z: 0, text: `Ship against the ${link(BUDGET, "Budget")}` }],
      },
    },
  },
];

/** A sheet artifact of its own, its cell holding the link. */
const SHEET = "01M5EVKRB1X4P80GXRGDK8V5AW";

const heldSheet: Held = {
  artifactId: SHEET,
  title: "Costs",
  type: "sheet",
  body: {
    type: "sheet",
    grid: {
      columns: [
        { id: "c1", name: "Item" },
        { id: "c2", name: "Note" },
      ],
      rows: [{ id: "r1", cells: { c1: "Year", c2: link(BUDGET, "Budget") } }],
    },
  },
};

const insertHeld = (database: DatabaseSync, canvas: string, held: Held, at = 1_760_000_000_000): void => {
  database
    .prepare(
      `INSERT INTO artifact_heads (canvas_name, artifact_id, node_id, type, title, version, created_by_json, updated_at, archived, task_ids_json)
       VALUES (?, ?, ?, ?, ?, 1, '{"kind":"operator"}', ?, 0, '[]')`,
    )
    .run(canvas, held.artifactId, SHELF, held.type, held.title, at);
  database
    .prepare(
      `INSERT INTO artifact_versions (canvas_name, artifact_id, version, op_id, author_json, at, edit_json, body_ref_json, inline_body_json)
       VALUES (?, ?, 1, ?, '{"kind":"operator"}', ?, NULL, ?, ?)`,
    )
    .run(canvas, held.artifactId, "01M5EVKRB1X4P80GXRGDK8V5AX", at, JSON.stringify(REF), JSON.stringify(held.body));
};

describe("an install that predates the body links", () => {
  it("shows every backlink after the step and the backfill, with nothing edited", async () => {
    dir = await mkdtemp(join(tmpdir(), "junto-links-install-"));
    const path = join(dir, "junto.db");
    await copyFile(fileURLToPath(new URL("./fixtures/state-v13/command-center-v13.db", import.meta.url)), path);

    // A 0.10.3 store: the shipped fixture stepped to 50, then artifacts as it held them.
    const database = new DatabaseSync(path, { open: true, readOnly: false, allowExtension: false, enableForeignKeyConstraints: true });
    let canvas: string;
    try {
      database.exec("PRAGMA foreign_keys = ON");
      migrateStateSchema(database, upTo(50, STATE_SCHEMA_V50_SQL));
      const found = database.prepare("SELECT canvas_name FROM canvases ORDER BY canvas_name LIMIT 1").get() as { canvas_name?: string } | undefined;
      canvas = found?.canvas_name === undefined ? CANVAS : String(found.canvas_name);
      if (found === undefined) {
        database
          .prepare("INSERT INTO canvases(canvas_name, canvas_id, created_at, updated_at, seq) VALUES (?, 'c', 't', 't', 0)")
          .run(canvas);
      }
      // The shelf on the canvas, so a source's node is an Artifacts node when read.
      database
        .prepare(
          `INSERT INTO artifact_boards (canvas_name, id, x, y, width, height, z_index, created_at, updated_at, label)
           VALUES (?, ?, 0, 0, 200, 160, 0, 't', 't', 'Shelf')`,
        )
        .run(canvas, SHELF);
      for (const held of [...HELD, heldSheet]) insertHeld(database, canvas, held);

      // The upgrade itself.
      migrateStateSchema(database, upTo(52, STATE_SCHEMA_SQL));
      const links = database.prepare("SELECT COUNT(*) AS n FROM work_artifact_links").get() as { n: number };
      expect(links.n).toBe(0);
    } finally {
      database.close();
    }

    // The backfill at boot, over the real engine.
    const runtime = ManagedRuntime.make(
      Layer.mergeAll(makeStateEngineLive(path), makeInstallOpsLive(join(dir, "install-ops.db"))),
    );
    try {
      const report = await runtime.runPromise(
        Effect.gen(function* () {
          return yield* runArtifactLinksBackfill({ sql: yield* SqlClient.SqlClient, installOps: yield* InstallOpsService });
        }),
      );
      expect(report).toMatchObject({ status: "complete", rows: 3 });

      const topology = {
        name: canvas,
        nodes: new Map([
          [asNodeId("artifacts-shelf"), { id: asNodeId("artifacts-shelf"), kind: "artifacts", label: "Shelf", x: 0, y: 0, width: 200, height: 160, z: 0 } as unknown as Node],
        ]),
        wires: new Map(),
      } as unknown as Canvas;
      const budget = await runtime.runPromise(
        Effect.gen(function* () {
          return yield* linkedFromBodies(yield* SqlClient.SqlClient, topology, canvas, { nodeId: asNodeId("artifacts-shelf"), artifactId: BUDGET as never });
        }),
      );
      // The document and the pad shape name it twice; the sheet cell once. The
      // plan's document holds it, the pad holds it, the sheet holds it — three
      // sources, one row each however often a body names it.
      expect(budget.map((row) => row.source.artifactId).sort()).toEqual([NOTES, PLAN, SHEET].sort());
      expect(budget.every((row) => row.title.length > 0)).toBe(true);
      expect(budget.some((row) => row.line.includes("Budget"))).toBe(true);
    } finally {
      await runtime.dispose();
    }
  }, 120_000);
});
