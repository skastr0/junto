/**
 * Canvas-document migration: the retired `escalates` verb.
 *
 * Proven on a real pre-retirement database (`fixtures/state-v3/escalates-v3.db`,
 * authored while the verb was legal): the stored escalates edges are dropped,
 * a surviving mask loses the retired port, the untouched edge and every
 * non-canvas table come through byte for byte, the commit is a verified
 * authority generation, and a second boot is a no-op. The shipped v1
 * fixture (no escalates) is left exactly as it was.
 */
import { createHash } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { CanvasesLive, CanvasesService } from "../src/main/junto/canvases";
import {
  retireEscalatesFromRawDoc,
  retirementTouches,
} from "../src/main/junto/canvas/retire-escalates";
import { makeInstallOpsLive } from "../src/main/junto/install-ops/engine";
import { BACKFILL_CANVAS_RETIRE_ESCALATES_V1 } from "../src/main/junto/install-ops/schema";
import { InstallOpsService } from "../src/main/junto/install-ops/service";
import { SettingsLive } from "../src/main/junto/settings/service";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { StationFleetTargetRepositoryLive } from "../src/main/junto/station/fleet-target-repository";
import { StationRepositoryLive } from "../src/main/junto/station/repository";
import { WorkRepositoryLive } from "../src/main/junto/work/repository";
import type { CanvasEdge, CanvasNode } from "../src/shared/canvas";

const fixture = (name: string) =>
  fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

const ESCALATES_FIXTURE_SHA256 =
  "04910fb8ddf6390250a4c0c1b858696310ad8e680e1a8f66bdd701517b1698a6";

const dirs: string[] = [];
afterEach(async () => {
  while (dirs.length > 0) await rm(dirs.pop()!, { recursive: true, force: true });
});

const copyFixture = async (name: string): Promise<{ db: string; ops: string }> => {
  const dir = await mkdtemp(join(tmpdir(), "junto-retire-escalates-"));
  dirs.push(dir);
  const db = join(dir, "junto.db");
  await copyFile(fixture(name), db);
  return { db, ops: join(dir, "install-ops.db") };
};

const boot = (paths: { db: string; ops?: string }) =>
  ManagedRuntime.make(
    Layer.provideMerge(
      CanvasesLive,
      Layer.provideMerge(
        Layer.mergeAll(
          WorkRepositoryLive,
          StationRepositoryLive,
          StationFleetTargetRepositoryLive,
          SettingsLive,
        ),
        Layer.mergeAll(
          makeStateEngineLive(paths.db),
          ...(paths.ops === undefined ? [] : [makeInstallOpsLive(paths.ops)]),
        ),
      ),
    ),
  );

const readFactory = async (paths: { db: string; ops?: string }) => {
  const runtime = boot(paths);
  try {
    return await runtime.runPromise(
      Effect.gen(function* () {
        const canvases = yield* CanvasesService;
        const read = yield* canvases.read("factory");
        const marker = paths.ops === undefined
          ? undefined
          : yield* Effect.flatMap(InstallOpsService, (ops) =>
            ops.getBackfill(BACKFILL_CANVAS_RETIRE_ESCALATES_V1));
        return { doc: read.doc, marker };
      }) as unknown as Effect.Effect<
        { doc: { edges: ReadonlyArray<CanvasEdge> }; marker: { status: string } | undefined },
        unknown,
        never
      >,
    );
  } finally {
    await runtime.dispose();
  }
};

const openRaw = (path: string) =>
  new DatabaseSync(path, { open: true, readOnly: false, enableForeignKeyConstraints: true });

const rows = (db: DatabaseSync, sql: string) =>
  db.prepare(sql).all() as unknown as ReadonlyArray<Record<string, SQLOutputValue>>;

/**
 * Every table's rows except canvas authority, which the migration owns, and
 * the schema identity, whose verified_at every boot restamps.
 */
const nonCanvasWitness = (path: string) => {
  const db = openRaw(path);
  try {
    const tables = rows(
      db,
      `SELECT name FROM sqlite_schema WHERE type = 'table'
        AND name NOT GLOB 'sqlite_*' AND name NOT GLOB 'canvas_*'
        AND name <> 'state_schema_identity'
        ORDER BY name`,
    ).map((row) => String(row.name));
    return Object.fromEntries(
      tables.map((table) => [table, rows(db, `SELECT * FROM "${table}" ORDER BY 1`)]),
    );
  } finally {
    db.close();
  }
};

const head = (path: string) => {
  const db = openRaw(path);
  try {
    return rows(db, "SELECT generation, intent_sha256 FROM canvas_portfolio_head")[0];
  } finally {
    db.close();
  }
};

const edge = (id: string, ether: unknown): CanvasEdge =>
  ({ id, fromNode: "a", toNode: "b", ether }) as CanvasEdge;

describe("retireEscalatesFromRawDoc", () => {
  const nodes: ReadonlyArray<CanvasNode> = [];

  it("drops escalates edges and narrows masks naming the retired port", () => {
    const plan = retireEscalatesFromRawDoc({
      nodes,
      edges: [
        edge("keep", { verb: "works" }),
        edge("raise", { verb: "escalates", mask: ["request.escalate"] }),
        edge("mail", { verb: "messages", mask: ["msg.send", "request.escalate"] }),
      ],
    });
    expect(plan.removedEdgeIds).toEqual(["raise"]);
    expect(plan.narrowedEdgeIds).toEqual(["mail"]);
    expect(plan.doc.edges).toEqual([
      edge("keep", { verb: "works" }),
      edge("mail", { verb: "messages", mask: ["msg.send"] }),
    ]);
  });

  it("returns the same document when nothing is retired", () => {
    const raw = { nodes, edges: [edge("keep", { verb: "works", mask: ["tasks.claim"] })] };
    const plan = retireEscalatesFromRawDoc(raw);
    expect(retirementTouches(plan)).toBe(false);
    expect(plan.doc).toBe(raw);
  });
});

describe("canvas migration: retire escalates", () => {
  it("pins the pre-retirement fixture bytes", async () => {
    const bytes = await readFile(fixture("state-v3/escalates-v3.db"));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(ESCALATES_FIXTURE_SHA256);
  });

  it("drops the edges, narrows the mask, keeps everything else, and commits a new generation", async () => {
    const paths = await copyFixture("state-v3/escalates-v3.db");
    const before = nonCanvasWitness(paths.db);
    expect(head(paths.db)?.generation).toBe("2");

    const { doc, marker } = await readFactory(paths);
    expect(doc.edges.map((e) => e.id)).toEqual(["claim-edge", "mail"]);
    expect(doc.edges.find((e) => e.id === "claim-edge")?.ether).toEqual({ verb: "works" });
    expect(doc.edges.find((e) => e.id === "mail")?.ether).toEqual({
      verb: "messages",
      mask: ["msg.send"],
    });
    expect(marker?.status).toBe("complete");

    const after = head(paths.db);
    expect(after?.generation).toBe("3");
    // Every table that existed before keeps its rows; a later schema step on
    // the same boot may add empty tables beside them.
    const witnessed = nonCanvasWitness(paths.db);
    expect(Object.fromEntries(Object.keys(before).map((table) => [table, witnessed[table]])))
      .toEqual(before);
    const db = openRaw(paths.db);
    try {
      expect(
        rows(db, "SELECT count(*) AS n FROM canvas_edges WHERE ether_json LIKE '%escalate%'")[0]?.n,
      ).toBe(0);
    } finally {
      db.close();
    }

    // Second boot: the marker is complete and the portfolio is clean.
    await readFactory(paths);
    expect(head(paths.db)).toEqual(after);
  });

  it("still migrates when the install-ops ledger is absent", async () => {
    const paths = await copyFixture("state-v3/escalates-v3.db");
    const { doc } = await readFactory({ db: paths.db });
    expect(doc.edges.map((e) => e.id)).toEqual(["claim-edge", "mail"]);
  });

  it("refuses rows that do not reproduce their stored hash and leaves them untouched", async () => {
    const paths = await copyFixture("state-v3/escalates-v3.db");
    const db = openRaw(paths.db);
    db.prepare("UPDATE canvas_edges SET label = 'tampered' WHERE edge_id = 'claim-edge'").run();
    db.close();
    const beforeHead = head(paths.db);
    // The walk refuses the tampered document, and the authority read that
    // follows fails closed on it too.
    await expect(readFactory(paths)).rejects.toThrow(
      /hash mismatch|revision hash|relational reconstruction/,
    );
    expect(head(paths.db)).toEqual(beforeHead);
    const check = openRaw(paths.db);
    try {
      expect(
        rows(check, "SELECT count(*) AS n FROM canvas_edges WHERE ether_json LIKE '%escalates%'")[0]?.n,
      ).toBe(2);
    } finally {
      check.close();
    }
  });

  it("leaves the shipped v1 fixture exactly as it was", async () => {
    const paths = await copyFixture("state-v1/command-center-v1.db");
    const { doc, marker } = await readFactory(paths);
    expect(doc.edges.map((e) => e.id)).toEqual(["claim-edge"]);
    expect(marker?.status).toBe("complete");
    // The step chain moves v1 to the current schema, but the canvas
    // generation stays where the fixture left it.
    const db = new DatabaseSync(fixture("state-v1/command-center-v1.db"), { readOnly: true });
    const original = rows(db, "SELECT generation, intent_sha256 FROM canvas_portfolio_head")[0];
    db.close();
    expect(head(paths.db)).toEqual(original);
  });
});
