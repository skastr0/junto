/**
 * Canvas-document migration: retired operator flags.
 *
 * Proven on a real pre-retirement database (`fixtures/state-v5/flags-v5.db`,
 * authored while flags were legal, with a task in the immutable work log):
 * node flags, the mirrored blocker color, `flagOnUnsatisfied`, `flags` edges
 * and pad `announces` leave the stored document; an authored red, the agent's
 * `announces` wire and every non-canvas table come through byte for byte; the
 * commit is a verified authority generation, and a second boot is a no-op.
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
  flagsRetirementTouches,
  retireFlagsFromRawDoc,
} from "../src/main/junto/canvas/retire-flags";
import { makeInstallOpsLive } from "../src/main/junto/install-ops/engine";
import { BACKFILL_CANVAS_RETIRE_FLAGS_V1 } from "../src/main/junto/install-ops/schema";
import { InstallOpsService } from "../src/main/junto/install-ops/service";
import { SettingsLive } from "../src/main/junto/settings/service";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { StationFleetTargetRepositoryLive } from "../src/main/junto/station/fleet-target-repository";
import { StationRepositoryLive } from "../src/main/junto/station/repository";
import { WorkRepositoryLive } from "../src/main/junto/work/repository";
import type { CanvasDoc, CanvasEdge, CanvasNode } from "../src/shared/canvas";

const fixture = (name: string) =>
  fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

const FLAGS_FIXTURE_SHA256 =
  "2e5b6280f732397fd0da4103383bdeeed8bfb18ca527cd82947db9f72738dc66";

const dirs: string[] = [];
afterEach(async () => {
  while (dirs.length > 0) await rm(dirs.pop()!, { recursive: true, force: true });
});

const copyFixture = async (): Promise<{ db: string; ops: string }> => {
  const dir = await mkdtemp(join(tmpdir(), "junto-retire-flags-"));
  dirs.push(dir);
  const db = join(dir, "junto.db");
  await copyFile(fixture("state-v5/flags-v5.db"), db);
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
            ops.getBackfill(BACKFILL_CANVAS_RETIRE_FLAGS_V1));
        return { doc: read.doc, marker };
      }) as unknown as Effect.Effect<
        { doc: CanvasDoc; marker: { status: string } | undefined },
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

const textNode = (id: string, extra: Record<string, unknown>): CanvasNode =>
  ({ id, type: "text", text: id, x: 0, y: 0, width: 100, height: 60, ...extra }) as CanvasNode;
const edge = (id: string, fromNode: string, toNode: string, verb: string): CanvasEdge =>
  ({ id, fromNode, toNode, ether: { verb } }) as CanvasEdge;

describe("retireFlagsFromRawDoc", () => {
  it("strips flags, the mirrored blocker red, flagOnUnsatisfied, and the edges only flags gave meaning", () => {
    const plan = retireFlagsFromRawDoc({
      nodes: [
        textNode("seat", { color: "1", ether: { entity: { kind: "agent" }, flags: ["blocker"] } }),
        textNode("tagged", { ether: { flags: ["parked"] } }),
        textNode("red", { color: "1" }),
        textNode("gauge", { ether: { entity: { kind: "watcher" }, watch: { kind: "stat_threshold", flagOnUnsatisfied: true } } }),
        textNode("pad", { ether: { entity: { kind: "pad" } } }),
        textNode("relay", { ether: { entity: { kind: "relay" } } }),
      ],
      edges: [
        edge("flags", "relay", "seat", "flags"),
        edge("pad-in", "pad", "relay", "announces"),
        edge("seat-in", "seat", "relay", "announces"),
      ],
    });
    expect(flagsRetirementTouches(plan)).toBe(true);
    expect(plan.strippedNodeIds).toEqual(["seat", "tagged"]);
    expect(plan.strippedWatchIds).toEqual(["gauge"]);
    expect(plan.removedEdgeIds).toEqual(["flags", "pad-in"]);
    const byId = new Map(plan.doc.nodes.map((node) => [node.id, node]));
    expect(byId.get("seat")).toEqual(textNode("seat", { ether: { entity: { kind: "agent" } } }));
    expect(byId.get("tagged")).toEqual(textNode("tagged", {}));
    expect(byId.get("red")).toEqual(textNode("red", { color: "1" }));
    expect(byId.get("gauge")?.ether).toEqual({ entity: { kind: "watcher" }, watch: { kind: "stat_threshold" } });
    expect(plan.doc.edges.map((e) => e.id)).toEqual(["seat-in"]);
  });

  it("returns the same document when nothing is retired", () => {
    const raw = { nodes: [textNode("red", { color: "1" })], edges: [edge("w", "a", "b", "works")] };
    const plan = retireFlagsFromRawDoc(raw);
    expect(flagsRetirementTouches(plan)).toBe(false);
    expect(plan.doc).toBe(raw);
  });
});

describe("canvas migration: retire operator flags", () => {
  it("pins the pre-retirement fixture bytes", async () => {
    const bytes = await readFile(fixture("state-v5/flags-v5.db"));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(FLAGS_FIXTURE_SHA256);
  });

  it("retires every flag shape, keeps everything else, and commits a new generation", async () => {
    const paths = await copyFixture();
    const before = nonCanvasWitness(paths.db);
    expect(Number(before.work_events?.length ?? 0)).toBeGreaterThan(0);
    expect(head(paths.db)?.generation).toBe("2");

    const { doc, marker } = await readFactory(paths);
    const byId = new Map(doc.nodes.map((node) => [node.id, node]));
    for (const node of doc.nodes) {
      expect((node.ether as Record<string, unknown> | undefined)?.flags).toBeUndefined();
    }
    expect(byId.get("agent")?.color).toBeUndefined();
    expect(byId.get("note")?.color).toBe("1");
    expect(byId.get("gauge")?.ether?.watch).toEqual({
      kind: "stat_threshold", source: "hermes", key: "local:agent", stat: "load", op: "gt", value: 3,
    });
    expect(doc.edges.map((e) => e.id).sort()).toEqual([
      "agent-announces", "claim-edge", "relay-wakes", "task-announces",
    ]);
    expect(marker?.status).toBe("complete");

    const after = head(paths.db);
    expect(after?.generation).toBe("3");
    // Every table that existed before keeps its rows, the work log included.
    const witnessed = nonCanvasWitness(paths.db);
    expect(Object.fromEntries(Object.keys(before).map((table) => [table, witnessed[table]])))
      .toEqual(before);
    const db = openRaw(paths.db);
    try {
      expect(
        rows(db, "SELECT count(*) AS n FROM canvas_nodes WHERE ether_json LIKE '%\"flags\"%' OR ether_json LIKE '%flagOnUnsatisfied%'")[0]?.n,
      ).toBe(0);
      expect(rows(db, "SELECT count(*) AS n FROM canvas_edges WHERE ether_json LIKE '%\"flags\"%'")[0]?.n).toBe(0);
    } finally {
      db.close();
    }

    // Second boot: the markers are complete and the portfolio is clean.
    await readFactory(paths);
    expect(head(paths.db)).toEqual(after);
  });

  it("still migrates when the install-ops ledger is absent", async () => {
    const paths = await copyFixture();
    const { doc } = await readFactory({ db: paths.db });
    expect(doc.edges.map((e) => e.id)).not.toContain("relay-flags");
    expect(head(paths.db)?.generation).toBe("3");
  });

  it("refuses rows that do not reproduce their stored hash and leaves them untouched", async () => {
    const paths = await copyFixture();
    const db = openRaw(paths.db);
    db.prepare("UPDATE canvas_edges SET label = 'tampered' WHERE edge_id = 'claim-edge'").run();
    db.close();
    const beforeHead = head(paths.db);
    await expect(readFactory(paths)).rejects.toThrow(
      /hash mismatch|revision hash|relational reconstruction|decode/,
    );
    expect(head(paths.db)).toEqual(beforeHead);
    const check = openRaw(paths.db);
    try {
      expect(rows(check, "SELECT count(*) AS n FROM canvas_edges WHERE ether_json LIKE '%\"flags\"%'")[0]?.n).toBe(2);
    } finally {
      check.close();
    }
  });
});
