/**
 * The model delete seam and view state (0.11, 04, V1): a node removal takes
 * its node rows and leaves it out of every command group; a canvas removal
 * takes every canvas-scoped row. Driven through `ModelService` with the
 * product's combined dependents, over the real state engine.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { asCanvasName, asNodeId } from "../src/shared/model";
import type { Node } from "../src/shared/model";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { ModelLive } from "../src/main/junto/model/layer";
import { ModelService } from "../src/main/junto/model/service";
import { ProductModelDependentsLive } from "../src/main/junto/view-state/model-dependents";

const canvas = asCanvasName("main");
const shelf = asNodeId("shelf");
const node: Node = { kind: "artifacts", id: shelf, label: "Shelf", x: 0, y: 0, width: 280, height: 160, z: 0 };

let dir: string;
let runtime: ReturnType<typeof machineAt>;

const machineAt = (root: string) =>
  ManagedRuntime.make(
    Layer.provideMerge(
      ModelLive,
      Layer.provideMerge(ProductModelDependentsLive, makeStateEngineLive(join(root, "junto.db"))),
    ),
  );

const run = <A, E>(effect: Effect.Effect<A, E, never>) => runtime.runPromise(effect as never) as Promise<A>;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "junto-view-state-dependents-"));
  runtime = machineAt(dir);
  await run(
    Effect.gen(function* () {
      const model = yield* ModelService;
      yield* model.command({ _tag: "CreateCanvas", canvas }, "operator");
      yield* model.command({ _tag: "Add", canvas, nodes: [node], wires: [] }, "operator");
    }),
  );
});

afterEach(async () => {
  await runtime.dispose();
  await rm(dir, { recursive: true, force: true });
});

describe("the model delete seam", () => {
  it("takes a removed node's view rows and leaves it out of its groups", async () => {
    await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO view_artifacts_filters (canvas_name, node_id, type, archived) VALUES (${canvas}, ${shelf}, 'document', 0)`;
        yield* sql`INSERT INTO view_artifacts_filter_labels (canvas_name, node_id, label, position) VALUES (${canvas}, ${shelf}, 'docs', 0)`;
        yield* sql`INSERT INTO view_collapsed_sidebars (canvas_name, node_id) VALUES (${canvas}, ${shelf})`;
        yield* sql`INSERT INTO view_command_slots (canvas_name, slot, kind, node_id) VALUES (${canvas}, 0, 'fixed', ${shelf})`;
        yield* sql`INSERT INTO view_command_slots (canvas_name, slot, kind, node_id) VALUES (${canvas}, 1, 'group', NULL)`;
        yield* sql`INSERT INTO view_command_slot_members (canvas_name, slot, position, node_id) VALUES (${canvas}, 1, 0, ${shelf})`;
        yield* sql`INSERT INTO view_command_slot_members (canvas_name, slot, position, node_id) VALUES (${canvas}, 1, 1, 'ghost')`;
        yield* sql`INSERT INTO view_command_slots (canvas_name, slot, kind, node_id) VALUES (${canvas}, 2, 'group', NULL)`;
        yield* sql`INSERT INTO view_command_slot_members (canvas_name, slot, position, node_id) VALUES (${canvas}, 2, 0, ${shelf})`;
        const model = yield* ModelService;
        yield* model.command({ _tag: "Remove", canvas, nodes: [shelf], wires: [] }, "operator");
      }),
    );

    const read = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const filters = yield* sql<{ n: number }>`SELECT count(*) AS n FROM view_artifacts_filters WHERE canvas_name = ${canvas}`;
        const sidebars = yield* sql<{ n: number }>`SELECT count(*) AS n FROM view_collapsed_sidebars WHERE canvas_name = ${canvas}`;
        const slots = yield* sql<{ slot: number; kind: string; node_id: string | null }>`
          SELECT slot, kind, node_id FROM view_command_slots WHERE canvas_name = ${canvas} ORDER BY slot`;
        const members = yield* sql<{ slot: number; position: number; node_id: string }>`
          SELECT slot, position, node_id FROM view_command_slot_members WHERE canvas_name = ${canvas} ORDER BY slot, position`;
        return { filters, sidebars, slots, members };
      }),
    );
    expect(read.filters[0]!.n).toBe(0);
    expect(read.sidebars[0]!.n).toBe(0);
    expect(read.slots).toEqual([{ slot: 1, kind: "group", node_id: null }]);
    expect(read.members).toEqual([{ slot: 1, position: 1, node_id: "ghost" }]);
  });

  it("takes every canvas-scoped view row when the canvas goes, and leaves the machine-wide ones", async () => {
    await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO view_artifacts_filters (canvas_name, node_id, type, archived) VALUES (${canvas}, ${shelf}, 'document', 0)`;
        yield* sql`INSERT INTO view_command_slots (canvas_name, slot, kind, node_id) VALUES (${canvas}, 0, 'fixed', ${shelf})`;
        yield* sql`INSERT INTO view_focus_sizes (surface, width, height) VALUES ('Tasks', 900, 700)`;
        yield* sql`INSERT INTO view_sections (section, open) VALUES ('artifact-comments', 1)`;
        const model = yield* ModelService;
        yield* model.command({ _tag: "RemoveCanvas", canvas }, "operator");
      }),
    );

    const read = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const filters = yield* sql<{ n: number }>`SELECT count(*) AS n FROM view_artifacts_filters WHERE canvas_name = ${canvas}`;
        const slots = yield* sql<{ n: number }>`SELECT count(*) AS n FROM view_command_slots WHERE canvas_name = ${canvas}`;
        const sizes = yield* sql<{ n: number }>`SELECT count(*) AS n FROM view_focus_sizes`;
        const sections = yield* sql<{ n: number }>`SELECT count(*) AS n FROM view_sections`;
        return { filters, slots, sizes, sections };
      }),
    );
    expect(read.filters[0]!.n).toBe(0);
    expect(read.slots[0]!.n).toBe(0);
    expect(read.sizes[0]!.n).toBe(1);
    expect(read.sections[0]!.n).toBe(1);
  });
});
