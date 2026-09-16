// The canvas read memo: what may be reused, and what must never be.
//
// `canvases.read` now serves a memoized active portfolio and a memoized Work
// projection instead of rebuilding the whole factory from SQLite on every
// call. A memo that misses an invalidation serves a stale factory, which is a
// worse defect than the read cost it removes, so every test here is an
// invalidation test: mutate one thing, prove the next read sees it.
//
// The enumeration test below is the structural half of that argument. It reads
// the live schema rather than a hand-kept list, so a projected table added
// without a revision trigger fails here instead of silently becoming a stale
// lane.
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { CanvasesLive, CanvasesService } from "../src/main/junto/canvases";
import { CanvasEntityRepositoryLive } from "../src/main/junto/entities/repository";
import {
  makeStateEngineLive,
  StateEngine,
} from "../src/main/junto/state/engine";
import { STATE_SCHEMA_SQL } from "../src/main/junto/state/schema";
import {
  WorkRepository,
  WorkRepositoryLive,
} from "../src/main/junto/work/repository";
import { ActorSeatId } from "../src/shared/actor-seat";
import type { CanvasDoc } from "../src/shared/canvas";
import { IntentFactBasis } from "../src/shared/work-protocol";

/**
 * Every table `readCanvasWorkProjection` reads, traced through
 * `snapshotsForCanvas` -> `loadSnapshot` -> the lane loaders. A canvas read may
 * only reuse a memo while every one of these is unchanged, so each one must
 * carry the triggers that move `work_canvas_revisions`.
 */
const PROJECTED_TABLES = [
  ["work_tasks", "canvas_name"],
  ["work_requests", "canvas_name"],
  ["work_messages", "canvas_name"],
  ["work_task_messages", "canvas_name"],
  ["work_task_dependencies", "canvas_name"],
  ["work_task_finish", "canvas_name"],
  ["work_artifacts", "canvas_name"],
  ["work_delivery_receipts", "delivered_canvas_name"],
  ["work_board_topics", "canvas_name"],
  ["work_board_posts", "canvas_name"],
  ["work_pad_meta", "canvas_name"],
  ["work_pad_posts", "canvas_name"],
  ["work_pad_shapes", "canvas_name"],
  ["work_pad_read_cursors", "canvas_name"],
] as const;

const roots: string[] = [];
const runtimes: Array<{ dispose: () => Promise<unknown> }> = [];

afterEach(async () => {
  while (runtimes.length > 0) await runtimes.pop()!.dispose();
  while (roots.length > 0) {
    await rm(roots.pop()!, { recursive: true, force: true });
  }
});

const openRuntime = async () => {
  const root = await mkdtemp(join(tmpdir(), "vellum-projection-cache-"));
  roots.push(root);
  const stateDirectory = join(root, "state");
  await mkdir(stateDirectory);
  const runtime = ManagedRuntime.make(
    Layer.provideMerge(
      CanvasesLive,
      Layer.provideMerge(
        Layer.mergeAll(WorkRepositoryLive, CanvasEntityRepositoryLive),
        makeStateEngineLive(join(stateDirectory, "junto.db")),
      ),
    ),
  );
  runtimes.push(runtime);
  // Work mutations refuse to run on an installation with no canonical local
  // authority, so every runtime here is a configured Command Center.
  await runtime.runPromise(
    Effect.gen(function* () {
      const state = yield* StateEngine;
      return yield* state.transaction("test.seed-installation", (writer) => {
        writer.run(
          `INSERT INTO station_known_installations(installation_id, registered_at)
           VALUES (?, ?)`,
          [LOCAL_INSTALLATION, at],
        );
        writer.run(
          `INSERT INTO station_installation(singleton, installation_id, created_at)
           VALUES (1, ?, ?)`,
          [LOCAL_INSTALLATION, at],
        );
        writer.run(
          `INSERT INTO station_configuration(
             singleton, role, host_id, agent_host_id,
             command_center_installation_id, supervised_preferred, configured_at
           ) VALUES (1, 'command-center', 'local', NULL, NULL, 1, ?)`,
          [at],
        );
      });
    }),
  );
  return runtime;
};

const CANVAS = "factory";
const SINK = "artifacts-sink";
const LOCAL_INSTALLATION = "cc-projection-cache";
const at = "2026-08-18T00:00:00.000Z";

const AGENT = "agent-node";
const REMOTE_HOST = "remote1";

const docWith = (
  nodeText: string,
  options: { readonly withRemoteAgent?: boolean } = {},
): CanvasDoc =>
  ({
    nodes: [
      {
        id: SINK,
        type: "text",
        text: nodeText,
        x: 0,
        y: 0,
        width: 200,
        height: 80,
        ether: { entity: { kind: "artifacts" } },
      },
      ...(options.withRemoteAgent === true
        ? [
            {
              id: AGENT,
              type: "text",
              text: "worker",
              x: 400,
              y: 0,
              width: 200,
              height: 80,
              ether: {
                entity: { kind: "agent", name: "worker" },
                host: REMOTE_HOST,
                terminal: { bindingId: "bind-1", harness: "claude" },
              },
            },
          ]
        : []),
    ],
    edges: [],
  }) as unknown as CanvasDoc;

const basis = Schema.decodeUnknownSync(IntentFactBasis, {
  onExcessProperty: "error",
});

const publisher = {
  seatId: Schema.decodeUnknownSync(ActorSeatId)(`seat_${"a".repeat(64)}`),
  canvasName: CANVAS,
  nodeId: "publisher",
};

/** Seed a canvas holding one artifacts sink, and return its read result. */
const seedCanvas = (
  runtime: Awaited<ReturnType<typeof openRuntime>>,
  options: { readonly withRemoteAgent?: boolean } = {},
) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const canvases = yield* CanvasesService;
      yield* canvases.create(CANVAS);
      yield* canvases.write(CANVAS, docWith("artifacts", options));
      return yield* canvases.read(CANVAS);
    }),
  );

const artifactsOf = (doc: CanvasDoc) =>
  doc.nodes.find((node) => node.id === SINK)?.ether?.artifacts?.items ?? [];

const publishArtifact = (
  runtime: Awaited<ReturnType<typeof openRuntime>>,
  artifactId: string,
) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const canvases = yield* CanvasesService;
      const witness = yield* canvases.activeIntentWitness();
      const work = yield* WorkRepository;
      return yield* work.publishArtifact({
        sink: { canvasName: CANVAS, nodeId: SINK },
        basis: basis({
          kind: "authorial-intent",
          generation: witness.generation,
          contentSha256: witness.contentSha256,
        }),
        publishedBy: publisher,
        artifact: {
          artifactId,
          name: artifactId,
          parts: [{ kind: "text", text: "receipt" }],
        },
        originAt: at,
        receivedAt: at,
      });
    }),
  );

describe("canvas projection memo — the revision witness", () => {
  it("carries insert, update and delete triggers on every projected table", () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(STATE_SCHEMA_SQL);
      const triggers = database
        .prepare(
          `SELECT name, tbl_name, sql FROM sqlite_schema WHERE type = 'trigger'`,
        )
        .all() as unknown as ReadonlyArray<{
        readonly name: string;
        readonly tbl_name: string;
        readonly sql: string;
      }>;
      const bumping = triggers.filter((trigger) =>
        trigger.sql.includes("work_canvas_revisions"),
      );

      const missing: string[] = [];
      const misrouted: string[] = [];
      for (const [table, column] of PROJECTED_TABLES) {
        for (const [event, alias] of [
          ["INSERT", "NEW"],
          ["UPDATE", "OLD"], // an UPDATE trigger may key on either row
          ["DELETE", "OLD"],
        ] as const) {
          const covering = bumping.filter(
            (trigger) =>
              trigger.tbl_name === table &&
              new RegExp(`AFTER\\s+${event}\\s+ON\\s+${table}\\b`).test(
                trigger.sql,
              ),
          );
          if (covering.length === 0) {
            missing.push(`${table} ${event}`);
            continue;
          }
          const keyed = covering.some(
            (trigger) =>
              trigger.sql.includes(`NEW.${column}`) ||
              trigger.sql.includes(`OLD.${column}`),
          );
          if (!keyed) misrouted.push(`${table} ${event} (${alias}.${column})`);
        }
      }
      expect(missing).toEqual([]);
      expect(misrouted).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("moves the revision for a direct write to every projected table", () => {
    // The behavioural half: no repository call path involved, just the row.
    // Whatever future code writes these tables, the witness fires.
    //
    // Foreign keys are off for this probe on purpose: it asks whether the
    // trigger fires, not whether the row is referentially complete, and
    // building every FK chain would test the schema's other half instead.
    const database = new DatabaseSync(":memory:");
    try {
      database.exec("PRAGMA foreign_keys = OFF");
      database.exec(STATE_SCHEMA_SQL);
      // work_messages_require_cc_home refuses a mailbox row that is not homed
      // on the configured Command Center, so the probe configures one and
      // homes every synthetic row there.
      database.exec(`
        INSERT INTO station_known_installations(installation_id, registered_at)
        VALUES ('home', '${"2026-08-18T00:00:00.000Z"}');
        INSERT INTO station_installation(singleton, installation_id, created_at)
        VALUES (1, 'home', '${"2026-08-18T00:00:00.000Z"}');
        INSERT INTO station_configuration(
          singleton, role, host_id, agent_host_id,
          command_center_installation_id, supervised_preferred, configured_at
        ) VALUES (1, 'command-center', 'local', NULL, NULL, 1, '${"2026-08-18T00:00:00.000Z"}');
      `);
      const revision = (): number =>
        (
          database
            .prepare(
              `SELECT revision FROM work_canvas_revisions WHERE canvas_name = 'probe'`,
            )
            .get() as { revision: number } | undefined
        )?.revision ?? 0;

      const seat = `seat_${"a".repeat(64)}`;
      // Column values that satisfy a CHECK the generic filler cannot guess.
      const overrides: Record<string, Record<string, string>> = {
        work_tasks: { state: "'submitted'" },
        work_requests: {
          state: "'input-required'",
          actor_seat_id: `'${seat}'`,
        },
        work_messages: { role: "'user'", actor_seat_id: `'${seat}'` },
        work_task_messages: {
          parent_lane: "'task'",
          message_kind: "'brief'",
          role: "'user'",
          // work_task_messages_require_exact_parent: same canvas, node, home
          // and the parent task's id.
          item_id: "'task_id'",
        },
        work_artifacts: { actor_seat_id: `'${seat}'` },
        work_delivery_receipts: {
          delivered_item_kind: "'message'",
          actor_seat_id: `'${seat}'`,
        },
        work_board_topics: { state: "'open'", author_kind: "'operator'" },
        work_board_posts: { author_kind: "'operator'" },
        work_pad_posts: { author_kind: "'operator'" },
        work_pad_shapes: { type: "'box'", w: "1", h: "1" },
      };

      const rowFor = (table: string, column: string) => {
        const columns = database
          .prepare(`PRAGMA table_info(${table})`)
          .all() as unknown as ReadonlyArray<{
          readonly name: string;
          readonly type: string;
          readonly notnull: number;
          readonly dflt_value: string | null;
        }>;
        const required = columns.filter(
          (c) => c.notnull === 1 && c.dflt_value === null,
        );
        const values = required.map((c) => {
          const override = overrides[table]?.[c.name];
          if (override !== undefined) return override;
          if (c.name === column) return "'probe'";
          if (c.type === "INTEGER" || c.type === "REAL") return "0";
          if (c.name.endsWith("_json")) return "'[]'";
          // entity_home, fact_event_home and fact_entity_home carry a
          // cross-column CHECK that they are all the same installation.
          if (c.name.endsWith("_home")) return "'home'";
          return `'${c.name}'`;
        });
        return { columns: required.map((c) => c.name), values };
      };

      // Three phases, because several of these tables refuse a row without a
      // live parent (a task message needs its task, a pad post needs its pad).
      // Inserting in declaration order, then updating, then deleting in
      // reverse keeps every parent alive for as long as its children need it.
      for (const [table, column] of PROJECTED_TABLES) {
        const before = revision();
        const row = rowFor(table, column);
        database.exec(
          `INSERT INTO ${table}(${row.columns.join(", ")}) VALUES (${row.values.join(", ")})`,
        );
        expect(revision(), `${table} insert`).toBeGreaterThan(before);
      }
      for (const [table, column] of PROJECTED_TABLES) {
        const before = revision();
        database.exec(
          `UPDATE ${table} SET ${column} = ${column} WHERE ${column} = 'probe'`,
        );
        expect(revision(), `${table} update`).toBeGreaterThan(before);
      }
      for (const [table, column] of [...PROJECTED_TABLES].reverse()) {
        const before = revision();
        database.exec(`DELETE FROM ${table} WHERE ${column} = 'probe'`);
        expect(revision(), `${table} delete`).toBeGreaterThan(before);
      }
    } finally {
      database.close();
    }
  });
});

describe("canvas projection memo — what a read must still see", () => {
  it("serves an unchanged world from the memo, byte-for-byte", async () => {
    const runtime = await openRuntime();
    const first = await seedCanvas(runtime);
    const second = await runtime.runPromise(
      Effect.gen(function* () {
        const canvases = yield* CanvasesService;
        return yield* canvases.read(CANVAS);
      }),
    );
    expect(second.doc).toEqual(first.doc);
    expect(second.revision).toBe(first.revision);
    expect(second.workRevision).toBe(first.workRevision);
  });

  it("sees an artifact published through the work fact journal", async () => {
    const runtime = await openRuntime();
    const seeded = await seedCanvas(runtime);
    expect(artifactsOf(seeded.doc)).toEqual([]);

    await publishArtifact(runtime, "artifact-1");
    const after = await runtime.runPromise(
      Effect.gen(function* () {
        const canvases = yield* CanvasesService;
        return yield* canvases.read(CANVAS);
      }),
    );
    expect(artifactsOf(after.doc).map((a) => a.artifactId)).toEqual([
      "artifact-1",
    ]);
    expect(after.workRevision).not.toBe(seeded.workRevision);
  });

  it("sees an archive and a delete that mint no work fact at all", async () => {
    // The exact hole that made a workRevision memo unsafe before schema 20:
    // `setArtifactArchived` and `deleteArtifact` mutate work_artifacts in
    // their own transaction and append nothing to work_events, so a witness
    // built only from the event journal could not see either one.
    const runtime = await openRuntime();
    const seeded = await seedCanvas(runtime);
    await publishArtifact(runtime, "artifact-1");

    const published = await runtime.runPromise(
      Effect.gen(function* () {
        const canvases = yield* CanvasesService;
        return yield* canvases.read(CANVAS);
      }),
    );
    expect(artifactsOf(published.doc)[0]?.metadata?.archived).toBeUndefined();

    await runtime.runPromise(
      Effect.gen(function* () {
        const work = yield* WorkRepository;
        return yield* work.setArtifactArchived({
          sink: { canvasName: CANVAS, nodeId: SINK },
          artifactId: "artifact-1",
          archived: true,
        });
      }),
    );
    const archived = await runtime.runPromise(
      Effect.gen(function* () {
        const canvases = yield* CanvasesService;
        return yield* canvases.read(CANVAS);
      }),
    );
    expect(archived.workRevision).not.toBe(published.workRevision);
    expect(artifactsOf(archived.doc)[0]?.metadata?.archived).toBe(true);

    await runtime.runPromise(
      Effect.gen(function* () {
        const work = yield* WorkRepository;
        return yield* work.deleteArtifact({
          sink: { canvasName: CANVAS, nodeId: SINK },
          artifactId: "artifact-1",
        });
      }),
    );
    const deleted = await runtime.runPromise(
      Effect.gen(function* () {
        const canvases = yield* CanvasesService;
        return yield* canvases.read(CANVAS);
      }),
    );
    expect(deleted.workRevision).not.toBe(archived.workRevision);
    expect(artifactsOf(deleted.doc)).toEqual([]);
  });

  it("sees an authorial write even when no work row moved", async () => {
    const runtime = await openRuntime();
    const seeded = await seedCanvas(runtime);
    const updated = await runtime.runPromise(
      Effect.gen(function* () {
        const canvases = yield* CanvasesService;
        yield* canvases.write(CANVAS, docWith("renamed"));
        return yield* canvases.read(CANVAS);
      }),
    );
    expect(updated.revision).not.toBe(seeded.revision);
    expect(updated.workRevision).toBe(seeded.workRevision);
    const textOf = (doc: CanvasDoc): string | undefined => {
      const node = doc.nodes.find((candidate) => candidate.id === SINK);
      return node?.type === "text" ? node.text : undefined;
    };
    expect(textOf(updated.doc)).not.toEqual(textOf(seeded.doc));
  });

  it("sees a node added by a mutate, and a canvas removed", async () => {
    const runtime = await openRuntime();
    await seedCanvas(runtime);
    const grown = await runtime.runPromise(
      Effect.gen(function* () {
        const canvases = yield* CanvasesService;
        yield* canvases.mutate(CANVAS, (doc) => ({
          ...doc,
          nodes: [
            ...doc.nodes,
            {
              id: "second",
              type: "text",
              text: "added",
              x: 400,
              y: 0,
              width: 200,
              height: 80,
            },
          ],
        }));
        return yield* canvases.read(CANVAS);
      }),
    );
    expect(grown.doc.nodes.map((node) => node.id)).toContain("second");

    const listAfterRemove = await runtime.runPromise(
      Effect.gen(function* () {
        const canvases = yield* CanvasesService;
        yield* canvases.remove(CANVAS);
        return yield* canvases.list;
      }),
    );
    expect(listAfterRemove.map((entry) => entry.name)).not.toContain(CANVAS);
  });

  it("recompiles actor refs when the fleet topology changes under a fixed generation", async () => {
    // The portfolio memo covers documents AND the compiled actor-seat
    // registry. Fleet targets move without any canvas generation, so the
    // identity must carry them or a stale seat registry outlives a fleet edit.
    const runtime = await openRuntime();
    await runtime.runPromise(
      Effect.gen(function* () {
        const state = yield* StateEngine;
        return yield* state.transaction("test.fleet-bind", (writer) => {
          for (const installation of ["remote-a", "remote-b"]) {
            writer.run(
              `INSERT INTO station_known_installations(installation_id, registered_at)
               VALUES (?, ?)`,
              [installation, at],
            );
          }
          writer.run(
            `INSERT INTO station_fleet_targets(
               host_id, station_installation_id, bound_at, retired_at
             ) VALUES (?, ?, ?, NULL)`,
            [REMOTE_HOST, "remote-a", at],
          );
        });
      }),
    );
    await seedCanvas(runtime, { withRemoteAgent: true });

    const before = await runtime.runPromise(
      Effect.gen(function* () {
        const canvases = yield* CanvasesService;
        return yield* canvases.activeActorRefs();
      }),
    );
    expect(before.map((ref) => ref.nodeId)).toEqual([AGENT]);

    // Same documents, same generation. Only the fleet map moves.
    await runtime.runPromise(
      Effect.gen(function* () {
        const state = yield* StateEngine;
        return yield* state.transaction("test.fleet-rebind", (writer) => {
          writer.run(
            `UPDATE station_fleet_targets
             SET station_installation_id = ?
             WHERE host_id = ?`,
            ["remote-b", REMOTE_HOST],
          );
        });
      }),
    );

    const after = await runtime.runPromise(
      Effect.gen(function* () {
        const canvases = yield* CanvasesService;
        return yield* canvases.activeActorRefs();
      }),
    );
    // The seat id hashes the compiled descriptor, which carries the authority
    // installation the host resolves to — so a rebind must move it.
    expect(after.map((ref) => ref.nodeId)).toEqual([AGENT]);
    expect(after.map((ref) => ref.seatId)).not.toEqual(
      before.map((ref) => ref.seatId),
    );
  });
});

describe("node-scoped read — what the wake path may rely on", () => {
  // `kernel.wakeManagedSeat` resolves the seat surface, its compiled actor
  // reference, its containing region's pause state and the edges its spawn
  // intent compiles from, all off `readNodeStructure`. Every one of those is
  // authorial, so this pins the two reads to the same structural answer.
  it("answers every structural question exactly as the projected read does", async () => {
    const runtime = await openRuntime();
    // The agent seat is placed on a fleet host, so the host must resolve or
    // the actor-seat compiler fails the whole portfolio read.
    await runtime.runPromise(
      Effect.gen(function* () {
        const state = yield* StateEngine;
        return yield* state.transaction("test.fleet-bind", (writer) => {
          writer.run(
            `INSERT INTO station_known_installations(installation_id, registered_at)
             VALUES (?, ?)`,
            ["remote-a", at],
          );
          writer.run(
            `INSERT INTO station_fleet_targets(
               host_id, station_installation_id, bound_at, retired_at
             ) VALUES (?, ?, ?, NULL)`,
            [REMOTE_HOST, "remote-a", at],
          );
        });
      }),
    );
    await runtime.runPromise(
      Effect.gen(function* () {
        const canvases = yield* CanvasesService;
        yield* canvases.create(CANVAS);
        yield* canvases.write(CANVAS, {
          ...docWith("artifacts", { withRemoteAgent: true }),
          nodes: [
            ...docWith("artifacts", { withRemoteAgent: true }).nodes,
            {
              id: "region-1",
              type: "group",
              label: "Region",
              x: -50,
              y: -50,
              width: 900,
              height: 400,
              ether: { region: { instruction: "stay on the line" } },
            },
          ],
          edges: [
            {
              id: "edge-1",
              fromNode: AGENT,
              toNode: SINK,
            },
          ],
        } as unknown as CanvasDoc);
      }),
    );

    // A Work lane must actually exist on the projected read, or "the
    // structural read carries none" is vacuously true.
    await publishArtifact(runtime, "artifact-1");

    const projected = await runtime.runPromise(
      Effect.gen(function* () {
        const canvases = yield* CanvasesService;
        return yield* canvases.read(CANVAS);
      }),
    );
    expect(artifactsOf(projected.doc)).toHaveLength(1);

    for (const node of projected.doc.nodes) {
      const scoped = await runtime.runPromise(
        Effect.gen(function* () {
          const canvases = yield* CanvasesService;
          return yield* canvases.readNodeStructure(CANVAS, node.id);
        }),
      );
      expect(scoped, node.id).toBeDefined();
      expect(scoped!.node.id).toBe(node.id);
      expect(scoped!.node.ether?.entity).toEqual(node.ether?.entity);
      expect(scoped!.node.ether?.terminal).toEqual(node.ether?.terminal);
      expect(scoped!.node.ether?.host).toEqual(node.ether?.host);
      // Region membership and edge topology drive seatPaused and the spawn
      // intent; both must be the authorial geometry, unchanged.
      expect(scoped!.structure.edges).toEqual(projected.doc.edges);
      expect(scoped!.structure.nodes.map((n) => n.id)).toEqual(
        projected.doc.nodes.map((n) => n.id),
      );
      expect(scoped!.revision).toBe(projected.revision);
      // And it carries no Work lane at all — a routing caller that reached
      // for one would read undefined, never a stale value.
      for (const structural of scoped!.structure.nodes) {
        expect(structural.ether?.tasks).toBeUndefined();
        expect(structural.ether?.requests).toBeUndefined();
        expect(structural.ether?.messages).toBeUndefined();
        expect(structural.ether?.artifacts).toBeUndefined();
        expect(structural.ether?.board).toBeUndefined();
        expect(structural.ether?.pad).toBeUndefined();
      }
    }
  });

  it("returns undefined for a node that is not on the canvas", async () => {
    const runtime = await openRuntime();
    await seedCanvas(runtime);
    const missing = await runtime.runPromise(
      Effect.gen(function* () {
        const canvases = yield* CanvasesService;
        return yield* canvases.readNodeStructure(CANVAS, "not-a-node");
      }),
    );
    expect(missing).toBeUndefined();
  });
});
