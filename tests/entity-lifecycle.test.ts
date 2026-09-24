import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import {
  activeEntitiesFromNodeIds,
  asActiveEntity,
  entityKeyOf,
  isActorToolVisible,
  isExecutionVisible,
  isHistoricSearchable,
} from "../src/shared/entity";
import {
  CanvasEntityRepository,
  CanvasEntityRepositoryLive,
} from "../src/main/junto/entities/repository";
import { CanvasesLive, CanvasesService } from "../src/main/junto/canvases";
import {
  makeStateEngineLive,
  StateEngine,
} from "../src/main/junto/state/engine";
import {
  CURRENT_STATE_SCHEMA_VERSION,
} from "../src/main/junto/state/migrations";
import { WorkRepositoryLive } from "../src/main/junto/work/repository";
import { SettingsLive } from "../src/main/junto/settings/service";
import { StationRepositoryLive } from "../src/main/junto/station/repository";
import { managedAgentEther } from "./helpers/managed-agent-ether";

const roots: string[] = [];
const runtimes: Array<{ dispose: () => Promise<void> }> = [];

afterEach(async () => {
  while (runtimes.length > 0) {
    await runtimes.pop()!.dispose();
  }
  while (roots.length > 0) {
    await rm(roots.pop()!, { recursive: true, force: true });
  }
});

const openEngine = (path: string) => {
  const repositories = Layer.provideMerge(
    Layer.mergeAll(
      WorkRepositoryLive,
      CanvasEntityRepositoryLive,
      SettingsLive,
      StationRepositoryLive,
    ),
    makeStateEngineLive(path),
  );
  const runtime = ManagedRuntime.make(
    Layer.provideMerge(CanvasesLive, repositories),
  );
  runtimes.push(runtime);
  return runtime;
};

describe("entity identity laws", () => {
  it("makes off-canvas active unrepresentable", () => {
    const onCanvas = new Set(["n1"]);
    expect(asActiveEntity("board", "n1", onCanvas)?.key).toEqual(
      entityKeyOf("board", "n1"),
    );
    expect(asActiveEntity("board", "n2", onCanvas)).toBeUndefined();
  });

  it("scopes EntityKey to one canvas (no free-floating EntityId)", () => {
    const a = entityKeyOf("alpha", "node-1");
    const b = entityKeyOf("beta", "node-1");
    expect(a.entityId).toBe(b.entityId);
    expect(a.canvasName).not.toBe(b.canvasName);
    expect(a).not.toEqual(b);
  });

  it("gates visibility by lifecycle", () => {
    expect(isExecutionVisible("active")).toBe(true);
    expect(isExecutionVisible("archived")).toBe(false);
    expect(isExecutionVisible("soft_deleted")).toBe(false);
    expect(isActorToolVisible("active")).toBe(true);
    expect(isActorToolVisible("archived")).toBe(false);
    expect(isHistoricSearchable("active")).toBe(true);
    expect(isHistoricSearchable("archived")).toBe(true);
    expect(isHistoricSearchable("soft_deleted")).toBe(false);
  });

  it("mints ActiveEntity only for membership sets", () => {
    const actives = activeEntitiesFromNodeIds("board", ["a", "b"]);
    expect(actives.map((e) => e.key.entityId)).toEqual(["a", "b"]);
    for (const entity of actives) {
      expect(entity.membership.canvasName).toBe("board");
      expect(entity.membership.entityId).toBe(entity.key.entityId);
    }
  });
});

describe("canvas entity registry", () => {
  it("opens a fresh database at the current schema", async () => {
    const root = await mkdtemp(join(tmpdir(), "junto-entity-fresh-"));
    roots.push(root);
    const stateDirectory = join(root, "state");
    const path = join(stateDirectory, "junto.db");
    await mkdir(stateDirectory);

    const runtime = await openEngine(path);
    const state = await runtime.runPromise(StateEngine);
    expect(state.info.schemaVersion).toBe(CURRENT_STATE_SCHEMA_VERSION);
  });

  it("archives on canvas membership loss and soft-deletes from archive only", async () => {
    const root = await mkdtemp(join(tmpdir(), "junto-entity-archive-"));
    roots.push(root);
    const stateDirectory = join(root, "state");
    const path = join(stateDirectory, "junto.db");
    await mkdir(stateDirectory);

    const runtime = await openEngine(path);
    const canvases = await runtime.runPromise(CanvasesService);
    const entities = await runtime.runPromise(CanvasEntityRepository);

    await runtime.runPromise(canvases.create("board"));
    const node = {
      id: "task-1",
      type: "text" as const,
      x: 0,
      y: 0,
      width: 120,
      height: 48,
      text: "tasks",
      ether: { entity: { kind: "task" as const, name: "tasks" } },
    };
    await runtime.runPromise(
      canvases.write("board", { nodes: [node], edges: [] }),
    );

    const active = await runtime.runPromise(
      entities.listByCanvas("board", { lifecycle: "active" }),
    );
    expect(active.map((e) => e.key.entityId)).toEqual(["task-1"]);

    await runtime.runPromise(canvases.write("board", { nodes: [], edges: [] }));

    const archived = await runtime.runPromise(
      entities.listByCanvas("board", { lifecycle: "archived" }),
    );
    expect(archived).toHaveLength(1);
    expect(archived[0]?.lifecycle).toBe("archived");
    expect(archived[0]?.archivedAt).toBeTruthy();

    const historic = await runtime.runPromise(entities.listHistoric("board"));
    expect(historic.map((e) => e.key.entityId)).toEqual(["task-1"]);

    const softDeleted = await runtime.runPromise(
      entities.softDelete("board", "task-1"),
    );
    expect(softDeleted.lifecycle).toBe("soft_deleted");
    expect(softDeleted.softDeletedAt).toBeTruthy();

    const historicAfter = await runtime.runPromise(
      entities.listHistoric("board"),
    );
    expect(historicAfter).toHaveLength(0);

    // Soft-delete is not hard-delete: row remains.
    const stillThere = await runtime.runPromise(
      entities.get("board", "task-1"),
    );
    expect(stillThere?.lifecycle).toBe("soft_deleted");
  });

  it("reactivates archived entity when node returns to the canvas", async () => {
    const root = await mkdtemp(join(tmpdir(), "junto-entity-reactivate-"));
    roots.push(root);
    const stateDirectory = join(root, "state");
    const path = join(stateDirectory, "junto.db");
    await mkdir(stateDirectory);

    const runtime = await openEngine(path);
    const canvases = await runtime.runPromise(CanvasesService);
    const entities = await runtime.runPromise(CanvasEntityRepository);

    await runtime.runPromise(canvases.create("board"));
    const node = {
      id: "n1",
      type: "text" as const,
      x: 0,
      y: 0,
      width: 80,
      height: 40,
      text: "note",
    };
    await runtime.runPromise(
      canvases.write("board", { nodes: [node], edges: [] }),
    );
    await runtime.runPromise(canvases.write("board", { nodes: [], edges: [] }));
    await runtime.runPromise(
      canvases.write("board", { nodes: [node], edges: [] }),
    );

    const row = await runtime.runPromise(entities.get("board", "n1"));
    expect(row?.lifecycle).toBe("active");
    expect(row?.archivedAt).toBeNull();
    expect(row?.softDeletedAt).toBeNull();
  });

  it("reassigns binding when prior holder is archived in the same write", async () => {
    const root = await mkdtemp(join(tmpdir(), "junto-entity-rebind-"));
    roots.push(root);
    const stateDirectory = join(root, "state");
    const path = join(stateDirectory, "junto.db");
    await mkdir(stateDirectory);

    const runtime = openEngine(path);
    const canvases = await runtime.runPromise(CanvasesService);
    const entities = await runtime.runPromise(CanvasEntityRepository);

    await runtime.runPromise(canvases.create("board"));
    const first = {
      id: "agent-old",
      type: "text" as const,
      x: 0,
      y: 0,
      width: 100,
      height: 40,
      text: "old",
      ether: managedAgentEther("local:old", { bindingId: "shared-bind" }),
    };
    const second = {
      id: "agent-new",
      type: "text" as const,
      x: 10,
      y: 10,
      width: 100,
      height: 40,
      text: "new",
      ether: managedAgentEther("local:new", { bindingId: "shared-bind" }),
    };
    await runtime.runPromise(
      canvases.write("board", { nodes: [first], edges: [] }),
    );
    await runtime.runPromise(
      canvases.write("board", { nodes: [second], edges: [] }),
    );

    const oldRow = await runtime.runPromise(
      entities.get("board", "agent-old"),
    );
    const newRow = await runtime.runPromise(
      entities.get("board", "agent-new"),
    );
    expect(oldRow?.lifecycle).toBe("archived");
    expect(oldRow?.bindingId).toBe("shared-bind");
    expect(newRow?.lifecycle).toBe("active");
    expect(newRow?.bindingId).toBe("shared-bind");
  });

  it("archives all active entities when a canvas is removed", async () => {
    const root = await mkdtemp(join(tmpdir(), "junto-entity-remove-canvas-"));
    roots.push(root);
    const stateDirectory = join(root, "state");
    const path = join(stateDirectory, "junto.db");
    await mkdir(stateDirectory);

    const runtime = openEngine(path);
    const canvases = await runtime.runPromise(CanvasesService);
    const entities = await runtime.runPromise(CanvasEntityRepository);

    await runtime.runPromise(canvases.create("board"));
    await runtime.runPromise(
      canvases.write("board", {
        nodes: [
          {
            id: "n1",
            type: "text",
            x: 0,
            y: 0,
            width: 40,
            height: 40,
            text: "x",
          },
        ],
        edges: [],
      }),
    );
    await runtime.runPromise(canvases.remove("board"));

    const row = await runtime.runPromise(entities.get("board", "n1"));
    expect(row?.lifecycle).toBe("archived");
  });

  it("refuses soft-delete of an active entity", async () => {
    const root = await mkdtemp(join(tmpdir(), "junto-entity-soft-active-"));
    roots.push(root);
    const stateDirectory = join(root, "state");
    const path = join(stateDirectory, "junto.db");
    await mkdir(stateDirectory);

    const runtime = await openEngine(path);
    const canvases = await runtime.runPromise(CanvasesService);
    const entities = await runtime.runPromise(CanvasEntityRepository);

    await runtime.runPromise(canvases.create("board"));
    await runtime.runPromise(
      canvases.write("board", {
        nodes: [
          {
            id: "n1",
            type: "text",
            x: 0,
            y: 0,
            width: 40,
            height: 40,
            text: "x",
          },
        ],
        edges: [],
      }),
    );

    const result = await runtime.runPromise(
      entities.softDelete("board", "n1").pipe(Effect.result),
    );
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure._tag).toBe("CanvasEntityNotArchivedError");
    }
  });

  it("reactivates soft_deleted entity when node returns to the canvas", async () => {
    const root = await mkdtemp(join(tmpdir(), "junto-entity-soft-reactivate-"));
    roots.push(root);
    const stateDirectory = join(root, "state");
    const path = join(stateDirectory, "junto.db");
    await mkdir(stateDirectory);

    const runtime = openEngine(path);
    const canvases = await runtime.runPromise(CanvasesService);
    const entities = await runtime.runPromise(CanvasEntityRepository);

    const node = {
      id: "n1",
      type: "text" as const,
      x: 0,
      y: 0,
      width: 40,
      height: 40,
      text: "x",
    };
    await runtime.runPromise(canvases.create("board"));
    await runtime.runPromise(
      canvases.write("board", { nodes: [node], edges: [] }),
    );
    await runtime.runPromise(canvases.write("board", { nodes: [], edges: [] }));
    await runtime.runPromise(entities.softDelete("board", "n1"));
    await runtime.runPromise(
      canvases.write("board", { nodes: [node], edges: [] }),
    );

    const row = await runtime.runPromise(entities.get("board", "n1"));
    expect(row?.lifecycle).toBe("active");
    expect(row?.softDeletedAt).toBeNull();
  });

  it("keeps same entity_id independent across canvases", async () => {
    const root = await mkdtemp(join(tmpdir(), "junto-entity-multi-canvas-"));
    roots.push(root);
    const stateDirectory = join(root, "state");
    const path = join(stateDirectory, "junto.db");
    await mkdir(stateDirectory);

    const runtime = openEngine(path);
    const canvases = await runtime.runPromise(CanvasesService);
    const entities = await runtime.runPromise(CanvasEntityRepository);

    const node = {
      id: "shared-id",
      type: "text" as const,
      x: 0,
      y: 0,
      width: 40,
      height: 40,
      text: "x",
    };
    await runtime.runPromise(canvases.create("alpha"));
    await runtime.runPromise(canvases.create("beta"));
    await runtime.runPromise(
      canvases.write("alpha", { nodes: [node], edges: [] }),
    );
    await runtime.runPromise(
      canvases.write("beta", { nodes: [node], edges: [] }),
    );
    await runtime.runPromise(canvases.write("alpha", { nodes: [], edges: [] }));

    const a = await runtime.runPromise(entities.get("alpha", "shared-id"));
    const b = await runtime.runPromise(entities.get("beta", "shared-id"));
    expect(a?.lifecycle).toBe("archived");
    expect(b?.lifecycle).toBe("active");
    expect(a?.key).not.toEqual(b?.key);
  });

  it("swaps bindings among co-active nodes in one write", async () => {
    const root = await mkdtemp(join(tmpdir(), "junto-entity-bind-swap-"));
    roots.push(root);
    const stateDirectory = join(root, "state");
    const path = join(stateDirectory, "junto.db");
    await mkdir(stateDirectory);

    const runtime = openEngine(path);
    const canvases = await runtime.runPromise(CanvasesService);
    const entities = await runtime.runPromise(CanvasEntityRepository);

    const a1 = {
      id: "a",
      type: "text" as const,
      x: 0,
      y: 0,
      width: 40,
      height: 40,
      text: "a",
      ether: managedAgentEther("local:a", { bindingId: "bind-1" }),
    };
    const b1 = {
      id: "b",
      type: "text" as const,
      x: 10,
      y: 0,
      width: 40,
      height: 40,
      text: "b",
      ether: managedAgentEther("local:b", { bindingId: "bind-2" }),
    };
    const a2 = {
      ...a1,
      ether: managedAgentEther("local:a", { bindingId: "bind-2" }),
    };
    const b2 = {
      ...b1,
      ether: managedAgentEther("local:b", { bindingId: "bind-1" }),
    };

    await runtime.runPromise(canvases.create("board"));
    await runtime.runPromise(
      canvases.write("board", { nodes: [a1, b1], edges: [] }),
    );
    await runtime.runPromise(
      canvases.write("board", { nodes: [a2, b2], edges: [] }),
    );

    const a = await runtime.runPromise(entities.get("board", "a"));
    const b = await runtime.runPromise(entities.get("board", "b"));
    expect(a?.lifecycle).toBe("active");
    expect(b?.lifecycle).toBe("active");
    expect(a?.bindingId).toBe("bind-2");
    expect(b?.bindingId).toBe("bind-1");
  });

  it("writes only the entity rows whose registry identity moved", async () => {
    const root = await mkdtemp(join(tmpdir(), "junto-entity-delta-"));
    roots.push(root);
    const stateDirectory = join(root, "state");
    const path = join(stateDirectory, "junto.db");
    await mkdir(stateDirectory);

    const runtime = await openEngine(path);
    const canvases = await runtime.runPromise(CanvasesService);
    const state = await runtime.runPromise(StateEngine);

    const node = (id: string, text: string) => ({
      id,
      type: "text" as const,
      x: 0,
      y: 0,
      width: 80,
      height: 40,
      text,
      ether: { entity: { kind: "note" as const, name: text } },
    });

    await runtime.runPromise(canvases.create("board"));
    await runtime.runPromise(
      canvases.write("board", {
        nodes: [node("a", "a"), node("b", "b"), node("c", "c")],
        edges: [],
      }),
    );

    const stamps = () =>
      runtime.runPromise(
        state.read("entity.delta", (reader) =>
          reader.all<{
            readonly entity_id: string;
            readonly updated_at: string;
          }>(
            `
              SELECT entity_id, updated_at
              FROM canvas_entities
              WHERE canvas_name = 'board'
              ORDER BY entity_id
            `,
          ),
        ),
      );

    expect((await stamps()).map((r) => r.entity_id)).toEqual(["a", "b", "c"]);

    // Stamp every row with a value no writer would ever produce, so "was this
    // row rewritten?" is answered by identity rather than by clock resolution.
    await runtime.runPromise(
      state.transaction("entity.delta.mark", (writer) => {
        writer.run(
          "UPDATE canvas_entities SET updated_at = 'untouched' WHERE canvas_name = 'board'",
        );
      }),
    );

    // Only node "b" changes registry identity (its kind moves note -> task).
    // A full-canvas upsert would restamp "a" and "c" too; the delta must not.
    await runtime.runPromise(
      canvases.write("board", {
        nodes: [
          node("a", "a"),
          {
            ...node("b", "b"),
            ether: { entity: { kind: "task" as const, name: "b" } },
          },
          node("c", "c"),
        ],
        edges: [],
      }),
    );

    const after = await stamps();
    const stampOf = (id: string) =>
      after.find((r) => r.entity_id === id)?.updated_at;
    expect(stampOf("a")).toBe("untouched");
    expect(stampOf("c")).toBe("untouched");
    expect(stampOf("b")).not.toBe("untouched");

    const kinds = await runtime.runPromise(
      state.read("entity.delta.kinds", (reader) =>
        reader.all<{ readonly entity_id: string; readonly kind: string | null }>(
          `
            SELECT entity_id, kind
            FROM canvas_entities
            WHERE canvas_name = 'board'
            ORDER BY entity_id
          `,
        ),
      ),
    );
    expect(kinds).toEqual([
      { entity_id: "a", kind: "note" },
      { entity_id: "b", kind: "task" },
      { entity_id: "c", kind: "note" },
    ]);
  });

  it("heals a registry row the table lost on the next write", async () => {
    const root = await mkdtemp(join(tmpdir(), "junto-entity-heal-gap-"));
    roots.push(root);
    const stateDirectory = join(root, "state");
    const path = join(stateDirectory, "junto.db");
    await mkdir(stateDirectory);

    const runtime = await openEngine(path);
    const canvases = await runtime.runPromise(CanvasesService);
    const entities = await runtime.runPromise(CanvasEntityRepository);
    const state = await runtime.runPromise(StateEngine);

    const node = (id: string, text: string) => ({
      id,
      type: "text" as const,
      x: 0,
      y: 0,
      width: 80,
      height: 40,
      text,
    });

    await runtime.runPromise(canvases.create("board"));
    await runtime.runPromise(
      canvases.write("board", {
        nodes: [node("kept", "kept"), node("lost", "lost")],
        edges: [],
      }),
    );

    // A gap the registry can lose to an interrupted backfill or a wiped row.
    // The document still carries the node, so the next write has to restore it
    // — a diff taken between two documents would call "lost" unchanged and
    // leave the canvas permanently missing an entity.
    await runtime.runPromise(
      state.transaction("entity.heal.wipe", (writer) => {
        writer.run(
          "DELETE FROM canvas_entities WHERE canvas_name = 'board' AND entity_id = 'lost'",
        );
      }),
    );
    expect(await runtime.runPromise(entities.get("board", "lost"))).toBeUndefined();

    await runtime.runPromise(
      canvases.write("board", {
        nodes: [node("kept", "kept moved"), node("lost", "lost")],
        edges: [],
      }),
    );

    const healed = await runtime.runPromise(entities.get("board", "lost"));
    expect(healed?.lifecycle).toBe("active");
  });

  it("heals a registry row whose kind drifted from the document", async () => {
    const root = await mkdtemp(join(tmpdir(), "junto-entity-heal-kind-"));
    roots.push(root);
    const stateDirectory = join(root, "state");
    const path = join(stateDirectory, "junto.db");
    await mkdir(stateDirectory);

    const runtime = await openEngine(path);
    const canvases = await runtime.runPromise(CanvasesService);
    const state = await runtime.runPromise(StateEngine);

    const node = (id: string, text: string) => ({
      id,
      type: "text" as const,
      x: 0,
      y: 0,
      width: 80,
      height: 40,
      text,
      ether: { entity: { kind: "task" as const, name: text } },
    });

    await runtime.runPromise(canvases.create("board"));
    await runtime.runPromise(
      canvases.write("board", {
        nodes: [node("drift", "drift"), node("other", "other")],
        edges: [],
      }),
    );

    await runtime.runPromise(
      state.transaction("entity.heal.drift", (writer) => {
        writer.run(
          "UPDATE canvas_entities SET kind = 'wrong' WHERE canvas_name = 'board' AND entity_id = 'drift'",
        );
      }),
    );

    await runtime.runPromise(
      canvases.write("board", {
        nodes: [node("drift", "drift"), node("other", "other moved")],
        edges: [],
      }),
    );

    const kind = await runtime.runPromise(
      state.read("entity.heal.drift.read", (reader) =>
        reader.get<{ readonly kind: string | null }>(
          "SELECT kind FROM canvas_entities WHERE canvas_name = 'board' AND entity_id = 'drift'",
        ),
      ),
    );
    expect(kind?.kind).toBe("task");
  });

  it("lists suppressed entity ids for portfolio merge", async () => {
    const root = await mkdtemp(join(tmpdir(), "junto-entity-suppress-"));
    roots.push(root);
    const stateDirectory = join(root, "state");
    const path = join(stateDirectory, "junto.db");
    await mkdir(stateDirectory);

    const runtime = openEngine(path);
    const canvases = await runtime.runPromise(CanvasesService);
    const entities = await runtime.runPromise(CanvasEntityRepository);

    await runtime.runPromise(canvases.create("board"));
    await runtime.runPromise(
      canvases.write("board", {
        nodes: [
          {
            id: "agent-local-worker",
            type: "text",
            x: 0,
            y: 0,
            width: 40,
            height: 40,
            text: "w",
          },
        ],
        edges: [],
      }),
    );
    await runtime.runPromise(
      canvases.write("board", { nodes: [], edges: [] }),
    );

    const suppressed = await runtime.runPromise(
      entities.listSuppressedEntityIds("board"),
    );
    expect([...suppressed]).toEqual(["agent-local-worker"]);
  });

  it("refuses soft-delete of missing entity", async () => {
    const root = await mkdtemp(join(tmpdir(), "junto-entity-soft-missing-"));
    roots.push(root);
    const stateDirectory = join(root, "state");
    const path = join(stateDirectory, "junto.db");
    await mkdir(stateDirectory);

    const runtime = openEngine(path);
    const entities = await runtime.runPromise(CanvasEntityRepository);
    const result = await runtime.runPromise(
      entities.softDelete("board", "nope").pipe(Effect.result),
    );
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure._tag).toBe("CanvasEntityMissingError");
    }
  });
});
