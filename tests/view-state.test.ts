/**
 * View state (0.11, 04, V1): the tables, the sparse snapshot, one write per
 * row, and the rows a node or canvas delete takes with it. Proven on the real
 * state engine and the production DDL.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ViewStateWrite } from "../src/shared/view-state";
import { artifactLabelOf, type ArtifactLabel } from "../src/shared/artifact-labels";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { ViewStateRepository, ViewStateRepositoryLive } from "../src/main/junto/view-state/repository";

let dir: string;
let runtime: ReturnType<typeof machineAt>;
const canvas = "main";

const machineAt = (root: string) =>
  ManagedRuntime.make(Layer.provideMerge(ViewStateRepositoryLive, makeStateEngineLive(join(root, "junto.db"))));

const label = (raw: string): ArtifactLabel => {
  const folded = artifactLabelOf(raw);
  if (folded === undefined) throw new Error(`refused: ${raw}`);
  return folded;
};

const run = <A, E>(effect: Effect.Effect<A, E, ViewStateRepository | SqlClient.SqlClient>) =>
  runtime.runPromise(effect as never) as Promise<A>;
const write = (change: ViewStateWrite) => run(Effect.flatMap(ViewStateRepository, (store) => store.write(change)));
const snapshot = () => run(Effect.flatMap(ViewStateRepository, (store) => store.snapshot()));
const removeNodes = (ids: ReadonlyArray<string>) =>
  run(Effect.flatMap(ViewStateRepository, (store) => store.removeNodes(canvas, ids)));

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "junto-view-state-"));
  runtime = machineAt(dir);
  await run(
    Effect.flatMap(SqlClient.SqlClient, (sql) =>
      Effect.gen(function* () {
        yield* sql`INSERT INTO canvases (canvas_name, canvas_id, created_at, updated_at)
          VALUES (${canvas}, 'canvas-1', 'now', 'now')`;
        // Every node a view row may name: the store keeps a node-scoped row
        // only while its node is one of the canvas's.
        for (const id of ["artifacts-1", "tasks-1", "a", "b", "c"]) {
          yield* sql`INSERT INTO artifact_boards
            (canvas_name, id, x, y, width, height, z_index, color, created_at, updated_at, label)
            VALUES (${canvas}, ${id}, 0, 0, 10, 10, 0, NULL, 'now', 'now', 'Shelf')`;
        }
      }),
    ),
  );
});

afterEach(async () => {
  await runtime.dispose();
  await rm(dir, { recursive: true, force: true });
});

describe("the view-state store", () => {
  it("reads an untouched machine as empty, and writes nothing for a node the canvas does not hold", async () => {
    expect(await snapshot()).toEqual({ commandGroups: {}, nodes: {}, focusSizes: {}, sections: {} });
    expect(await write({ area: "sidebar", canvasName: canvas, nodeId: "ghost", collapsed: true })).toBe(false);
    expect((await snapshot()).nodes[canvas]).toBeUndefined();
  });

  it("keeps nine slots, a group's members in order, and the groups past nine", async () => {
    await write({ area: "command-slot", canvasName: canvas, slot: 0, value: { kind: "fixed", nodeId: "agent-a" } });
    await write({ area: "command-slot", canvasName: canvas, slot: 2, value: { kind: "group", nodeIds: ["agent-a", "agent-b"] } });
    await write({ area: "command-extras", canvasName: canvas, value: [["agent-a", "agent-b"], ["agent-c"]] });

    let read = await snapshot();
    const board = read.commandGroups[canvas]!;
    expect(board.slots).toHaveLength(9);
    expect(board.slots[0]).toEqual({ kind: "fixed", nodeId: "agent-a" });
    expect(board.slots[1]).toEqual({ kind: "empty" });
    expect(board.slots[2]).toEqual({ kind: "group", nodeIds: ["agent-a", "agent-b"] });
    expect(board.extras).toEqual([["agent-a", "agent-b"], ["agent-c"]]);

    await write({ area: "command-slot", canvasName: canvas, slot: 0, value: { kind: "empty" } });
    await write({ area: "command-extras", canvasName: canvas, value: [] });
    read = await snapshot();
    expect(read.commandGroups[canvas]!.slots[0]).toEqual({ kind: "empty" });
    expect(read.commandGroups[canvas]!.extras).toEqual([]);
  });

  it("keeps each node's rows sparse and deletes a row returned to its default", async () => {
    const node = "artifacts-1";
    await write({
      area: "artifacts-filter",
      canvasName: canvas,
      nodeId: node,
      value: { type: "document", archived: true, labels: [label("b"), label("a")] },
    });
    await write({ area: "tasks-filter", canvasName: canvas, nodeId: node, value: "open" });
    await write({ area: "open-item", canvasName: canvas, nodeId: node, value: { kind: "artifact", id: "artifact-1" } });
    await write({ area: "expanded-folders", canvasName: canvas, nodeId: node, value: ["src", "docs"] });
    await write({ area: "sidebar", canvasName: canvas, nodeId: node, collapsed: true });

    let held = (await snapshot()).nodes[canvas]![node]!;
    expect(held.artifactsFilter).toEqual({ type: "document", archived: true, labels: [label("b"), label("a")] });
    expect(held.tasksFilter).toBe("open");
    expect(held.openItem).toEqual({ kind: "artifact", id: "artifact-1" });
    expect(held.expandedFolders).toEqual(["src", "docs"]);
    expect(held.sidebarCollapsed).toBe(true);

    await write({
      area: "artifacts-filter",
      canvasName: canvas,
      nodeId: node,
      value: { type: "all", archived: false, labels: [] },
    });
    await write({ area: "tasks-filter", canvasName: canvas, nodeId: node, value: "all" });
    await write({ area: "open-item", canvasName: canvas, nodeId: node, value: null });
    await write({ area: "expanded-folders", canvasName: canvas, nodeId: node, value: [] });
    await write({ area: "sidebar", canvasName: canvas, nodeId: node, collapsed: false });

    held = (await snapshot()).nodes[canvas]?.[node] ?? {};
    expect(held).toEqual({});
  });

  it("holds one open item per node, of the kind last written", async () => {
    const node = "tasks-1";
    await write({ area: "open-item", canvasName: canvas, nodeId: node, value: { kind: "task", id: "task-1" } });
    await write({ area: "open-item", canvasName: canvas, nodeId: node, value: { kind: "automation", id: "auto-1" } });
    expect((await snapshot()).nodes[canvas]![node]!.openItem).toEqual({ kind: "automation", id: "auto-1" });
    await write({ area: "open-item", canvasName: canvas, nodeId: node, value: { kind: "file", path: "src/index.ts" } });
    expect((await snapshot()).nodes[canvas]![node]!.openItem).toEqual({ kind: "file", path: "src/index.ts" });
  });

  it("keeps a surface size and a section's flag machine-wide, last write wins", async () => {
    await write({ area: "focus-size", surface: "Tasks", value: { width: 800, height: 600 } });
    await write({ area: "focus-size", surface: "Tasks", value: { width: 900, height: 700 } });
    await write({ area: "section", section: "artifact-comments", open: true });
    await write({ area: "section", section: "seat-rail", open: false });

    const read = await snapshot();
    expect(read.focusSizes).toEqual({ Tasks: { width: 900, height: 700 } });
    expect(read.sections).toEqual({ "artifact-comments": true, "seat-rail": false });

    await write({ area: "focus-size", surface: "Tasks", value: null });
    expect((await snapshot()).focusSizes).toEqual({});
  });
});

describe("a node or canvas delete takes its view rows", () => {
  beforeEach(async () => {
    await write({ area: "command-slot", canvasName: canvas, slot: 0, value: { kind: "fixed", nodeId: "a" } });
    await write({ area: "command-slot", canvasName: canvas, slot: 1, value: { kind: "fixed", nodeId: "b" } });
    await write({ area: "command-slot", canvasName: canvas, slot: 2, value: { kind: "group", nodeIds: ["a", "b"] } });
    await write({ area: "command-slot", canvasName: canvas, slot: 3, value: { kind: "group", nodeIds: ["a", "c"] } });
    await write({ area: "command-extras", canvasName: canvas, value: [["a", "b"], ["c"]] });
    for (const node of ["a", "b", "c"]) {
      await write({
        area: "artifacts-filter",
        canvasName: canvas,
        nodeId: node,
        value: { type: "document", archived: false, labels: [] },
      });
      await write({ area: "sidebar", canvasName: canvas, nodeId: node, collapsed: true });
    }
    await write({ area: "focus-size", surface: "Tasks", value: { width: 1, height: 2 } });
    await write({ area: "section", section: "artifact-comments", open: true });
  });

  it("removes a node's rows and leaves it out of every group", async () => {
    await removeNodes(["a"]);
    const read = await snapshot();
    const board = read.commandGroups[canvas]!;
    expect(board.slots[0]).toEqual({ kind: "empty" });
    expect(board.slots[1]).toEqual({ kind: "fixed", nodeId: "b" });
    expect(board.slots[2]).toEqual({ kind: "group", nodeIds: ["b"] });
    expect(board.slots[3]).toEqual({ kind: "group", nodeIds: ["c"] });
    expect(board.extras).toEqual([["b"], ["c"]]);
    expect(read.nodes[canvas]?.a).toBeUndefined();
    expect(read.nodes[canvas]?.b).toBeDefined();

    await removeNodes(["b", "c"]);
    const after = await snapshot();
    // The last held row went, so the canvas has no board at all.
    expect(after.commandGroups[canvas]).toBeUndefined();
    expect(after.nodes[canvas]).toBeUndefined();
    // Machine-wide rows are not a node's.
    expect(after.focusSizes).toEqual({ Tasks: { width: 1, height: 2 } });
    expect(after.sections).toEqual({ "artifact-comments": true });
  });

  it("cascades a canvas delete from the canvases table", async () => {
    await run(
      Effect.flatMap(SqlClient.SqlClient, (sql) =>
        Effect.gen(function* () {
          // The model removes its kind rows before the canvas; the FK here
          // has no ON DELETE action, so the test does the same.
          yield* sql`DELETE FROM artifact_boards WHERE canvas_name = ${canvas}`;
          yield* sql`DELETE FROM canvases WHERE canvas_name = ${canvas}`;
        }),
      ),
    );
    const read = await snapshot();
    expect(read.commandGroups).toEqual({});
    expect(read.nodes).toEqual({});
    expect(read.focusSizes).toEqual({ Tasks: { width: 1, height: 2 } });
    expect(read.sections).toEqual({ "artifact-comments": true });
  });
});
