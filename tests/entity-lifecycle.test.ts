import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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
} from "../src/main/vellum/entities/repository";
import { CanvasesLive, CanvasesService } from "../src/main/vellum/canvases";
import {
  makeStateEngineLive,
  StateEngine,
} from "../src/main/vellum/state/engine";
import {
  CURRENT_STATE_SCHEMA_VERSION,
  STATE_SCHEMA_V5_IDENTITY,
} from "../src/main/vellum/state/migrations";
import {
  STATE_SCHEMA_SQL,
  STATE_SCHEMA_V5_SQL,
} from "../src/main/vellum/state/schema";
import {
  expectedStateSchemaIdentity,
  verifyAndStampStateSchema,
} from "../src/main/vellum/state/schema-identity";
import { WorkRepositoryLive } from "../src/main/vellum/work/repository";

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
    Layer.mergeAll(WorkRepositoryLive, CanvasEntityRepositoryLive),
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
  it("freezes v5 identity and opens at schema version 6", async () => {
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V5_SQL)).toEqual(
      STATE_SCHEMA_V5_IDENTITY,
    );
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_SQL)).toEqual({
      actualSchemaSha256:
        "f097722579ffcaad121b0e5eb62076a8ab70cb9c5d66a78978d572612703be53",
      sourceSchemaSha256:
        "2468a976c922293edfb34ea8106f4817bd445368100cf13129466adf1532a3c2",
    });

    const root = await mkdtemp(join(tmpdir(), "vellum-entity-fresh-"));
    roots.push(root);
    const stateDirectory = join(root, "state");
    const path = join(stateDirectory, "vellum.db");
    await mkdir(stateDirectory);

    const runtime = await openEngine(path);
    const state = await runtime.runPromise(StateEngine);
    expect(state.info.schemaVersion).toBe(CURRENT_STATE_SCHEMA_VERSION);
    expect(CURRENT_STATE_SCHEMA_VERSION).toBe(6);
  });

  it("migrates v5 → v6 and backfills active entities from head", async () => {
    const root = await mkdtemp(join(tmpdir(), "vellum-entity-migrate-"));
    roots.push(root);
    const stateDirectory = join(root, "state");
    const path = join(stateDirectory, "vellum.db");
    await mkdir(stateDirectory);

    const body = JSON.stringify({
      nodes: [
        {
          id: "agent-1",
          type: "text",
          x: 0,
          y: 0,
          width: 100,
          height: 40,
          text: "worker",
          ether: {
            entity: { kind: "agent", name: "local:worker" },
            terminal: { bindingId: "bind-1" },
          },
        },
      ],
      edges: [],
    });
    const v5 = new DatabaseSync(path);
    try {
      v5.exec(STATE_SCHEMA_V5_SQL);
      v5.prepare(
        `
          INSERT INTO canvas_generations(
            generation, created_at, cause, intent_sha256, document_count
          ) VALUES (?, ?, ?, ?, ?)
        `,
      ).run("1", "2026-07-31T00:00:00.000Z", "seed", "a".repeat(64), 1);
      v5.prepare(
        `
          INSERT INTO canvas_generation_documents(
            generation, name, body, sha256, modified_at
          ) VALUES (?, ?, ?, ?, ?)
        `,
      ).run(
        "1",
        "main",
        body,
        "b".repeat(64),
        "2026-07-31T00:00:00.000Z",
      );
      v5.prepare(
        "INSERT INTO canvas_head(singleton, generation) VALUES (1, '1')",
      ).run();
      verifyAndStampStateSchema(v5, STATE_SCHEMA_V5_SQL);
      v5.exec("PRAGMA user_version = 5");
    } finally {
      v5.close();
    }

    const runtime = await openEngine(path);
    const state = await runtime.runPromise(StateEngine);
    expect(state.info.schemaVersion).toBe(6);

    const row = await runtime.runPromise(
      state.read("entity.backfill", (reader) =>
        reader.get<{
          readonly entity_id: string;
          readonly lifecycle: string;
          readonly kind: string | null;
          readonly binding_id: string | null;
        }>(
          `
            SELECT entity_id, lifecycle, kind, binding_id
            FROM canvas_entities
            WHERE canvas_name = 'main' AND entity_id = 'agent-1'
          `,
        ),
      ),
    );
    expect(row).toEqual({
      entity_id: "agent-1",
      lifecycle: "active",
      kind: "agent",
      binding_id: "bind-1",
    });
  });

  it("archives on canvas membership loss and soft-deletes from archive only", async () => {
    const root = await mkdtemp(join(tmpdir(), "vellum-entity-archive-"));
    roots.push(root);
    const stateDirectory = join(root, "state");
    const path = join(stateDirectory, "vellum.db");
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
    const root = await mkdtemp(join(tmpdir(), "vellum-entity-reactivate-"));
    roots.push(root);
    const stateDirectory = join(root, "state");
    const path = join(stateDirectory, "vellum.db");
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
    const root = await mkdtemp(join(tmpdir(), "vellum-entity-rebind-"));
    roots.push(root);
    const stateDirectory = join(root, "state");
    const path = join(stateDirectory, "vellum.db");
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
      ether: {
        entity: { kind: "agent" as const, name: "local:old" },
        terminal: { bindingId: "shared-bind" },
      },
    };
    const second = {
      id: "agent-new",
      type: "text" as const,
      x: 10,
      y: 10,
      width: 100,
      height: 40,
      text: "new",
      ether: {
        entity: { kind: "agent" as const, name: "local:new" },
        terminal: { bindingId: "shared-bind" },
      },
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
    const root = await mkdtemp(join(tmpdir(), "vellum-entity-remove-canvas-"));
    roots.push(root);
    const stateDirectory = join(root, "state");
    const path = join(stateDirectory, "vellum.db");
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
    const root = await mkdtemp(join(tmpdir(), "vellum-entity-soft-active-"));
    roots.push(root);
    const stateDirectory = join(root, "state");
    const path = join(stateDirectory, "vellum.db");
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
      entities.softDelete("board", "n1").pipe(Effect.either),
    );
    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left._tag).toBe("CanvasEntityNotArchivedError");
    }
  });
});
