import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Effect, Layer, ManagedRuntime } from "effect";
import {
  CanvasesLive,
  CanvasesService,
} from "../src/main/vellum/canvases";
import {
  runCanvasRelationalBackfill,
} from "../src/main/vellum/canvas/relational-backfill";
import {
  compareDecimalGenerations,
} from "../src/main/vellum/canvas/decimal-generation";
import { canvasDocSemanticHash } from "../src/main/vellum/canvas/relational-hash";
import { makeStateEngineLive } from "../src/main/vellum/state/engine";
import {
  StateEngine,
  type StateReader,
  type StateWriter,
} from "../src/main/vellum/state/service";
import {
  BACKFILL_CANVAS_RELATIONAL_V1,
  BACKFILL_CANVAS_RELATIONAL_V2,
  makeInstallOpsLive,
} from "../src/main/vellum/install-ops/engine";
import {
  InstallOpsService,
  type InstallOpsServiceShape,
} from "../src/main/vellum/install-ops/service";
import { WorkRepositoryLive } from "../src/main/vellum/work/repository";
import { StationRepositoryLive } from "../src/main/vellum/station/repository";
import { compileStationPortfolioBody } from "../src/main/vellum/station/portfolio";
import {
  StationFleetTargetRepositoryLive,
} from "../src/main/vellum/station/fleet-target-repository";
import {
  StationLivePeerRegistryLive,
} from "../src/main/vellum/station/session-registry";
import { WorkLive } from "../src/main/vellum/work/service";
import { SettingsLive } from "../src/main/vellum/settings/service";
import { makeContentServiceLive } from "../src/main/vellum/content/service";
import {
  applyMirrorLaw,
  serializeCanvas,
  type CanvasDoc,
} from "../src/shared/canvas";
import { intentSha256Of } from "../src/main/vellum/canvas-intent-identity";
import { DOCUMENT_REPLACE_V1 } from "../src/shared/canvas-authoring";

type StoredSeedDocument = {
  readonly name: string;
  readonly body: string;
  readonly storedSha256?: string;
};

type SeedGeneration = {
  readonly generation: string;
  readonly documents: ReadonlyArray<StoredSeedDocument>;
  readonly documentCount?: number;
};

type TestStateService = {
  readonly read: <A>(
    operation: string,
    body: (reader: StateReader) => A,
  ) => Effect.Effect<A, unknown>;
  readonly transaction: <A>(
    operation: string,
    body: (writer: StateWriter) => A,
  ) => Effect.Effect<A, unknown>;
};

const NOW = "2026-08-28T00:00:00.000Z";
const HUGE_1 = "9223372036854775808";
const HUGE_2 = "9223372036854775810";

const sha256 = (body: string): string =>
  createHash("sha256").update(body, "utf8").digest("hex");

const noteDoc = (id: string, text: string): CanvasDoc =>
  applyMirrorLaw({
    nodes: [
      {
        id,
        type: "text",
        text,
        x: 0,
        y: 0,
        width: 160,
        height: 80,
      },
    ],
    edges: [],
  });

const wiredDoc = (taskId: string): CanvasDoc =>
  applyMirrorLaw({
    nodes: [
      {
        id: taskId,
        type: "text",
        text: "queue",
        x: 0,
        y: 0,
        width: 160,
        height: 80,
        ether: { entity: { kind: "task" } },
      },
      {
        id: "target-task",
        type: "text",
        text: "target",
        x: 240,
        y: 0,
        width: 160,
        height: 80,
        ether: { entity: { kind: "task" } },
      },
    ],
    edges: [
      {
        id: "retained-edge",
        fromNode: taskId,
        toNode: "target-task",
        ether: { verb: "feeds" },
      },
    ],
  });

const seedBody = (
  name: string,
  body: string,
  storedSha256?: string,
): StoredSeedDocument => ({ name, body, storedSha256 });

const seedDoc = (name: string, doc: CanvasDoc): StoredSeedDocument =>
  seedBody(name, serializeCanvas(doc));

const generationMaterial = (generation: SeedGeneration) => {
  const documents = generation.documents.map((document) => ({
    ...document,
    sha256: document.storedSha256 ?? sha256(document.body),
  }));
  const intentSha256 = intentSha256Of(
    new Map(
      documents.map((document) => [
        document.name,
        { revisionSha256: document.sha256 },
      ]),
    ),
  );
  return { ...generation, documents, intentSha256 };
};

const appendHistoryGeneration = (
  writer: StateWriter,
  generation: SeedGeneration,
): void => {
  const material = generationMaterial(generation);
  writer.run(
    `
      INSERT INTO canvas_generations(
        generation, created_at, cause, intent_sha256, document_count
      ) VALUES (?, ?, 'seed', ?, ?)
    `,
    [
      material.generation,
      NOW,
      material.intentSha256,
      material.documentCount ?? material.documents.length,
    ],
  );
  for (const document of material.documents) {
    writer.run(
      `
        INSERT INTO canvas_generation_documents(
          generation, name, body, sha256, modified_at
        ) VALUES (?, ?, ?, ?, ?)
      `,
      [material.generation, document.name, document.body, document.sha256, NOW],
    );
  }
  writer.run("UPDATE canvas_head SET generation = ? WHERE singleton = 1", [
    material.generation,
  ]);
};

const seedHistory = async (
  state: TestStateService,
  generations: ReadonlyArray<SeedGeneration>,
  headGeneration: string,
): Promise<void> => {
  const material = generations.map(generationMaterial);
  await Effect.runPromise(
    state.transaction("test.seed.canvas-history", (writer) => {
      for (const generation of material) {
        writer.run(
          `
            INSERT INTO canvas_generations(
              generation, created_at, cause, intent_sha256, document_count
            ) VALUES (?, ?, 'seed', ?, ?)
          `,
          [
            generation.generation,
            NOW,
            generation.intentSha256,
            generation.documentCount ?? generation.documents.length,
          ],
        );
        for (const document of generation.documents) {
          writer.run(
            `
              INSERT INTO canvas_generation_documents(
                generation, name, body, sha256, modified_at
              ) VALUES (?, ?, ?, ?, ?)
            `,
            [
              generation.generation,
              document.name,
              document.body,
              document.sha256,
              NOW,
            ],
          );
        }
      }
      writer.run(
        "INSERT INTO canvas_head(singleton, generation) VALUES (1, ?)",
        [headGeneration],
      );
    }),
  );
};

const AUTHORIAL_CANVAS_TABLES = [
  "canvas_generations",
  "canvas_generation_documents",
  "canvas_head",
  "canvas_documents",
  "canvas_objects",
  "canvas_nodes",
  "canvas_edges",
  "canvas_checkpoints",
  "canvas_generation_manifests",
  "canvas_commit_envelopes",
] as const;

const stableJson = (value: unknown): string =>
  JSON.stringify(value, (_key, entry: unknown) =>
    typeof entry === "bigint" ? `bigint:${entry}` : entry,
  );

const snapshotCanvasAuthorityTables = (
  reader: StateReader,
): Readonly<Record<string, { readonly count: number; readonly bytes: string }>> =>
  Object.fromEntries(
    AUTHORIAL_CANVAS_TABLES.map((table) => {
      const rows = reader.all(
        `SELECT * FROM ${table} ORDER BY 1, 2`,
      );
      return [table, { count: rows.length, bytes: stableJson(rows) }] as const;
    }),
  );

const snapshotCanvasEntities = (
  reader: StateReader,
): { readonly count: number; readonly bytes: string } => {
  const rows = reader.all(
    "SELECT * FROM canvas_entities ORDER BY canvas_name, entity_id",
  );
  return { count: rows.length, bytes: stableJson(rows) };
};

const snapshotRelationalCurrentGraph = (
  reader: StateReader,
): Readonly<Record<string, { readonly count: number; readonly bytes: string }>> =>
  Object.fromEntries(
    ["canvas_documents", "canvas_objects", "canvas_nodes", "canvas_edges"].map(
      (table) => {
        const rows = reader.all(
          `SELECT * FROM ${table} ORDER BY 1, 2`,
        );
        return [table, { count: rows.length, bytes: stableJson(rows) }] as const;
      },
    ),
  );

const snapshotInstallOpsMarkers = (installOps: InstallOpsServiceShape) =>
  Effect.all([
    installOps.getBackfill(BACKFILL_CANVAS_RELATIONAL_V1),
    installOps.getBackfill(BACKFILL_CANVAS_RELATIONAL_V2),
  ]).pipe(
    Effect.map((markers) => ({
      count: markers.filter((marker) => marker !== undefined).length,
      bytes: stableJson(markers),
    })),
  );

const seedRemoteProjection = async (
  state: TestStateService,
  name: string,
  doc: CanvasDoc,
): Promise<{ readonly body: string; readonly contentSha256: string }> => {
  const body = compileStationPortfolioBody(
    new Map([[name, doc]]),
    new Map(),
  );
  const contentSha256 = sha256(body);
  await Effect.runPromise(
    state.transaction("test.seed.remote-projection", (writer) => {
      writer.run(
        `
          INSERT INTO station_known_installations(installation_id, registered_at)
          VALUES ('command-installation', ?)
        `,
        [NOW],
      );
      writer.run(
        `
          INSERT INTO station_configuration(
            singleton, role, host_id, agent_host_id,
            command_center_installation_id, supervised_preferred, configured_at
          ) VALUES (
            1, 'remote', 'remote-host', 'remote-host',
            'command-installation', 1, ?
          )
        `,
        [NOW],
      );
      writer.run(
        `
          INSERT INTO station_projection_versions(
            generation, content_sha256, source_canvas_generation,
            source_intent_sha256, body, created_at, received_at
          ) VALUES ('8', ?, '3', ?, ?, ?, ?)
        `,
        [contentSha256, sha256("remote source intent"), body, NOW, NOW],
      );
      writer.run(
        `
          INSERT INTO station_projection_head(singleton, generation, content_sha256)
          VALUES (1, '8', ?)
        `,
        [contentSha256],
      );
    }),
  );
  return { body, contentSha256 };
};

type SeedEntityRow = {
  readonly canvasName: string;
  readonly entityId: string;
  readonly lifecycle: "active" | "archived" | "soft_deleted";
  readonly kind?: string | null;
  readonly bindingId?: string | null;
  readonly updatedAt?: string;
};

const seedCanvasEntities = async (
  state: TestStateService,
  rows: ReadonlyArray<SeedEntityRow>,
): Promise<void> => {
  await Effect.runPromise(
    state.transaction("test.seed.canvas-entities", (writer) => {
      for (const row of rows) {
        const archivedAt = row.lifecycle === "active" ? null : "2026-01-01T00:00:00.000Z";
        const softDeletedAt =
          row.lifecycle === "soft_deleted" ? "2026-01-02T00:00:00.000Z" : null;
        writer.run(
          `
            INSERT INTO canvas_entities(
              canvas_name, entity_id, kind, binding_id, lifecycle,
              created_at, updated_at, archived_at, soft_deleted_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
          [
            row.canvasName,
            row.entityId,
            row.kind === undefined ? "text" : row.kind,
            row.bindingId ?? null,
            row.lifecycle,
            "2026-01-01T00:00:00.000Z",
            row.updatedAt ?? "2026-01-03T00:00:00.000Z",
            archivedAt,
            softDeletedAt,
          ],
        );
      }
    }),
  );
};

const seedStaleRelationalResidue = async (
  state: TestStateService,
): Promise<void> => {
  const doc = noteDoc("stale-node", "unverifiable relational residue");
  const body = serializeCanvas(doc);
  const checkpointSha = sha256(body);
  await Effect.runPromise(
    state.transaction("test.seed.relational-residue", (writer) => {
      writer.run(
        `
          INSERT INTO canvas_checkpoints(sha256, byte_length, body, created_at)
          VALUES (?, ?, ?, ?)
        `,
        [checkpointSha, Buffer.byteLength(body, "utf8"), body, NOW],
      );
      writer.run(
        `
          INSERT INTO canvas_documents(
            canvas_id, canvas_name, head_generation,
            head_checkpoint_sha256, head_semantic_sha256,
            created_at, updated_at
          ) VALUES ('canvas_stale', 'stale', '7', ?, ?, ?, ?)
        `,
        [checkpointSha, canvasDocSemanticHash(doc), NOW, NOW],
      );
      writer.run(
        `
          INSERT INTO canvas_objects(
            canvas_id, object_id, object_kind, first_seen_generation,
            deleted_generation, created_at
          ) VALUES ('canvas_stale', 'stale-node', 'node', '7', NULL, ?)
        `,
        [NOW],
      );
      writer.run(
        `
          INSERT INTO canvas_nodes(
            canvas_id, node_id, z_index, type, x, y, width, height,
            text_content, semantic_sha256, updated_at
          ) VALUES (
            'canvas_stale', 'stale-node', 0, 'text', 0, 0, 160, 80,
            'unverifiable relational residue', ?, ?
          )
        `,
        ["a".repeat(64), NOW],
      );
    }),
  );
};

const seedLegacyRelationalObject = async (
  state: TestStateService,
  input: {
    readonly canvasName: string;
    readonly headGeneration: string;
    readonly doc: CanvasDoc;
    readonly objectId: string;
    readonly objectKind: "node" | "edge";
    readonly firstSeenGeneration: string;
    readonly createdAt: string;
  },
): Promise<void> => {
  const body = serializeCanvas(input.doc);
  await Effect.runPromise(
    state.transaction("test.seed.legacy-relational-object", (writer) => {
      writer.run(
        `
          INSERT INTO canvas_documents(
            canvas_id, canvas_name, head_generation,
            head_checkpoint_sha256, head_semantic_sha256,
            created_at, updated_at
          ) VALUES (
            'canvas_legacy_object', ?, ?, ?, ?, ?, ?
          )
        `,
        [
          input.canvasName,
          input.headGeneration,
          sha256(body),
          canvasDocSemanticHash(input.doc),
          input.createdAt,
          input.createdAt,
        ],
      );
      writer.run(
        `
          INSERT INTO canvas_objects(
            canvas_id, object_id, object_kind, first_seen_generation,
            deleted_generation, created_at
          ) VALUES (
            'canvas_legacy_object', ?, ?, ?, NULL, ?
          )
        `,
        [
          input.objectId,
          input.objectKind,
          input.firstSeenGeneration,
          input.createdAt,
        ],
      );
    }),
  );
};

const seedPoisonedManifest = async (
  state: TestStateService,
  generation: string,
  name: string,
  doc: CanvasDoc,
): Promise<void> => {
  const body = serializeCanvas(doc);
  const checkpointSha = sha256(body);
  await Effect.runPromise(
    state.transaction("test.seed.poisoned-manifest", (writer) => {
      writer.run(
        `
          INSERT INTO canvas_checkpoints(sha256, byte_length, body, created_at)
          VALUES (?, ?, ?, ?)
        `,
        [checkpointSha, Buffer.byteLength(body, "utf8"), body, NOW],
      );
      writer.run(
        `
          INSERT INTO canvas_documents(
            canvas_id, canvas_name, head_generation,
            head_checkpoint_sha256, head_semantic_sha256,
            created_at, updated_at
          ) VALUES ('canvas_poison', ?, ?, ?, ?, ?, ?)
        `,
        [name, generation, checkpointSha, canvasDocSemanticHash(doc), NOW, NOW],
      );
      writer.run(
        `
          INSERT INTO canvas_generation_manifests(
            generation, canvas_id, checkpoint_sha256, semantic_sha256
          ) VALUES (?, 'canvas_poison', ?, ?)
        `,
        [generation, checkpointSha, canvasDocSemanticHash(doc)],
      );
    }),
  );
};

const seedImmutableWorkFact = async (
  state: TestStateService,
  basisGeneration: string,
): Promise<void> => {
  const basis = await Effect.runPromise(
    state.read("test.seed.work-fact.basis", (reader) =>
      reader.get<{ readonly intent_sha256: string }>(
        "SELECT intent_sha256 FROM canvas_generations WHERE generation = ?",
        [basisGeneration],
      ),
    ),
  );
  if (basis === undefined) throw new Error("missing fact basis generation");
  await Effect.runPromise(
    state.transaction("test.seed.work-fact", (writer) => {
      writer.run(
        `
          INSERT INTO station_known_installations(installation_id, registered_at)
          VALUES ('home1', ?)
        `,
        [NOW],
      );
      writer.run(
        `
          INSERT INTO work_event_sequences(event_home, entity_home, last_seq)
          VALUES ('home1', 'home1', '1')
        `,
      );
      writer.run(
        `
          INSERT INTO work_events(
            event_home, entity_home, seq, protocol, record_type,
            item_kind, item_id, item_canvas_name, item_node_id,
            operation, content_sha256, origin_at, received_at
          ) VALUES (
            'home1', 'home1', '1', 'vellum/work/v2', 'fact',
            'message', 'msg-1', 'alpha', 'agent',
            'message.append', ?, ?, ?
          )
        `,
        ["a".repeat(64), NOW, NOW],
      );
      writer.run(
        `
          INSERT INTO work_facts(
            event_home, entity_home, seq, result_json,
            basis_kind, basis_authorial_generation,
            basis_authorial_content_sha256
          ) VALUES (
            'home1', 'home1', '1', '{"kept":"byte-identical"}',
            'authorial-intent', ?, ?
          )
        `,
        [basisGeneration, basis.intent_sha256],
      );
    }),
  );
};

const readWorkLogWitness = (
  reader: StateReader,
): ReadonlyArray<Readonly<Record<string, unknown>>> => [
  ...reader.all("SELECT * FROM work_events ORDER BY event_home, entity_home, seq"),
  ...reader.all("SELECT * FROM work_facts ORDER BY event_home, entity_home, seq"),
];

const crashingWriter = (writer: StateWriter, after: number): StateWriter => {
  let writes = 0;
  return {
    get: (sql, bindings) => writer.get(sql, bindings),
    all: (sql, bindings) => writer.all(sql, bindings),
    run: (sql, bindings) => {
      writes += 1;
      if (writes >= after) throw new Error("injected relational crash");
      return writer.run(sql, bindings);
    },
  };
};

const errorChainText = (value: unknown): string => {
  const messages: string[] = [];
  let cursor: unknown = value;
  const seen = new Set<unknown>();
  while (cursor !== null && typeof cursor === "object" && !seen.has(cursor)) {
    seen.add(cursor);
    if (cursor instanceof Error) messages.push(cursor.message);
    cursor = (cursor as { readonly cause?: unknown }).cause;
  }
  if (messages.length === 0) messages.push(String(value));
  return messages.join(" <- ");
};

describe("canvas relational v2 installed-state safety", () => {
  const roots: string[] = [];
  let runtime: ManagedRuntime.ManagedRuntime<any, any> | undefined;

  const paths = async () => {
    const root = await mkdtemp(join(tmpdir(), "vellum-relational-v2-"));
    roots.push(root);
    return {
      root,
      statePath: join(root, "state", "vellum-command.db"),
      installOpsPath: join(root, "state", "install-ops.db"),
    };
  };

  const makeCoreRuntime = (statePath: string, installOpsPath: string) =>
    ManagedRuntime.make(
      Layer.mergeAll(
        makeStateEngineLive(statePath),
        makeInstallOpsLive(installOpsPath),
      ),
    );

  const makeCanvasRuntime = (
    statePath: string,
    installOpsPath: string,
    root: string,
    installOpsLayer = makeInstallOpsLive(installOpsPath),
  ) => {
    const repositories = Layer.provideMerge(
      Layer.mergeAll(
        WorkRepositoryLive,
        StationRepositoryLive,
        StationFleetTargetRepositoryLive,
        SettingsLive,
        makeContentServiceLive({
          root: join(root, "content"),
          skipInlineMediaMigration: true,
        }),
      ),
      Layer.mergeAll(makeStateEngineLive(statePath), installOpsLayer),
    );
    const canvases = Layer.provideMerge(CanvasesLive, repositories);
    return ManagedRuntime.make(
      Layer.provideMerge(
        WorkLive,
        Layer.mergeAll(canvases, StationLivePeerRegistryLive) as never,
      ),
    );
  };

  const dispose = async (): Promise<void> => {
    if (runtime !== undefined) {
      await runtime.dispose();
      runtime = undefined;
    }
  };

  afterEach(async () => {
    await dispose();
    vi.restoreAllMocks();
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  it("orders arbitrary-precision generations without SQLite casts", () => {
    expect(compareDecimalGenerations("9", HUGE_1)).toBe(-1);
    expect(compareDecimalGenerations(HUGE_2, HUGE_1)).toBe(1);
    expect(() => compareDecimalGenerations("09", "9")).toThrow(
      /canonical unsigned decimal generation/,
    );
  });

  it("rejects a stale existing head before startup can serve generation 9 over generation 11", async () => {
    const path = await paths();
    runtime = makeCoreRuntime(path.statePath, path.installOpsPath);
    const state = await runtime!.runPromise(StateEngine);
    await seedHistory(
      state,
      [
        { generation: "9", documents: [seedDoc("alpha", noteDoc("nine", "stale"))] },
        { generation: "11", documents: [seedDoc("alpha", noteDoc("eleven", "current"))] },
      ],
      "9",
    );
    await dispose();

    runtime = makeCanvasRuntime(
      path.statePath,
      path.installOpsPath,
      path.root,
    );
    const canvases = await runtime!.runPromise(CanvasesService);
    await expect(runtime!.runPromise(canvases.start())).rejects.toThrow(
      /canvas head 9 is stale; exact greatest source generation is 11/,
    );
    await expect(runtime!.runPromise(canvases.list)).rejects.toThrow(
      /canvas head 9 is stale/,
    );
    const liveState = await runtime!.runPromise(StateEngine);
    expect(
      await runtime!.runPromise(
        liveState.read("test.stale-head.preserved", (reader) =>
          reader.get<{ readonly generation: string }>(
            "SELECT generation FROM canvas_head WHERE singleton = 1",
          )?.generation,
        ),
      ),
    ).toBe("9");
  });

  it("rejects a stale same-length head above signed 64-bit range", async () => {
    const path = await paths();
    runtime = makeCoreRuntime(path.statePath, path.installOpsPath);
    const state = await runtime!.runPromise(StateEngine);
    await seedHistory(
      state,
      [
        {
          generation: HUGE_1,
          documents: [seedDoc("alpha", noteDoc("older", "huge older"))],
        },
        {
          generation: HUGE_2,
          documents: [seedDoc("alpha", noteDoc("newer", "huge newer"))],
        },
      ],
      HUGE_1,
    );
    await dispose();

    runtime = makeCanvasRuntime(
      path.statePath,
      path.installOpsPath,
      path.root,
    );
    const canvases = await runtime!.runPromise(CanvasesService);
    await expect(runtime!.runPromise(canvases.start())).rejects.toThrow(
      new RegExp(
        `canvas head ${HUGE_1} is stale; exact greatest source generation is ${HUGE_2}`,
      ),
    );
  });

  it("rejects orphan source generations when the head is absent", async () => {
    const path = await paths();
    runtime = makeCoreRuntime(path.statePath, path.installOpsPath);
    const state = await runtime!.runPromise(StateEngine);
    await seedHistory(
      state,
      [{ generation: "9", documents: [seedDoc("alpha", noteDoc("node", "orphan"))] }],
      "9",
    );
    await runtime!.runPromise(
      state.transaction("test.orphan-source.remove-head", (writer) => {
        writer.run("DELETE FROM canvas_head WHERE singleton = 1");
      }),
    );
    await dispose();

    runtime = makeCanvasRuntime(
      path.statePath,
      path.installOpsPath,
      path.root,
    );
    const canvases = await runtime!.runPromise(CanvasesService);
    await expect(runtime!.runPromise(canvases.start())).rejects.toThrow(
      /head is missing while generation rows exist; recovery required/,
    );
  });

  const currentHeadFailureCases: ReadonlyArray<{
    readonly name: string;
    readonly generation: SeedGeneration;
    readonly afterSeed?: (state: TestStateService) => Promise<void>;
    readonly error: RegExp;
  }> = [
    {
      name: "malformed body",
      generation: {
        generation: "9",
        documents: [seedBody("alpha", "{")],
      },
      error: /database is not valid JSON/,
    },
    {
      name: "body digest mismatch",
      generation: {
        generation: "9",
        documents: [
          seedBody(
            "alpha",
            serializeCanvas(noteDoc("node", "digest mismatch")),
            "f".repeat(64),
          ),
        ],
      },
      error: /database body hash mismatch/,
    },
    {
      name: "document count mismatch",
      generation: {
        generation: "9",
        documents: [seedDoc("alpha", noteDoc("node", "count mismatch"))],
        documentCount: 2,
      },
      error: /expected 2 documents but loaded 1/,
    },
    {
      name: "intent digest mismatch",
      generation: {
        generation: "9",
        documents: [seedDoc("alpha", noteDoc("node", "intent mismatch"))],
      },
      afterSeed: async (state) => {
        await Effect.runPromise(
          state.transaction("test.current-head.bad-intent", (writer) => {
            writer.run(
              "UPDATE canvas_generations SET intent_sha256 = ? WHERE generation = '9'",
              ["f".repeat(64)],
            );
          }),
        );
      },
      error: /intent hash mismatch/,
    },
  ];

  it.each(currentHeadFailureCases)(
    "rejects current-head $name during awaited bootstrap",
    async ({ generation, afterSeed, error }) => {
      const path = await paths();
      runtime = makeCoreRuntime(path.statePath, path.installOpsPath);
      const state = await runtime!.runPromise(StateEngine);
      await seedHistory(state, [generation], generation.generation);
      await afterSeed?.(state);
      const authorityBefore = await runtime!.runPromise(
        state.read("test.current-head.before", snapshotCanvasAuthorityTables),
      );
      await dispose();

      runtime = makeCanvasRuntime(
        path.statePath,
        path.installOpsPath,
        path.root,
      );
      const canvases = await runtime!.runPromise(CanvasesService);
      await expect(runtime!.runPromise(canvases.start())).rejects.toThrow(error);
      const liveState = await runtime!.runPromise(StateEngine);
      expect(
        await runtime!.runPromise(
          liveState.read("test.current-head.after", snapshotCanvasAuthorityTables),
        ),
      ).toEqual(authorityBefore);
    },
  );

  it("skips Remote startup before v2 marker or authorial relational mutation and keeps projection reads unchanged", async () => {
    const path = await paths();
    runtime = makeCoreRuntime(path.statePath, path.installOpsPath);
    const state = await runtime!.runPromise(StateEngine);
    const installOps = await runtime!.runPromise(InstallOpsService);
    await seedHistory(
      state,
      [
        {
          generation: "9",
          documents: [seedDoc("stale-authorial", noteDoc("stale", "stale authorial"))],
        },
      ],
      "9",
    );
    const projectedDoc = noteDoc("projected", "remote projection remains active");
    const projection = await seedRemoteProjection(
      state,
      "command-floor",
      projectedDoc,
    );
    await runtime!.runPromise(
      installOps.markComplete(BACKFILL_CANVAS_RELATIONAL_V1, 77),
    );
    const authorityBefore = await runtime!.runPromise(
      state.read("test.remote.authority.before", snapshotCanvasAuthorityTables),
    );
    const markersBefore = await runtime!.runPromise(
      snapshotInstallOpsMarkers(installOps),
    );
    expect(
      await runtime!.runPromise(
        installOps.getBackfill(BACKFILL_CANVAS_RELATIONAL_V2),
      ),
    ).toBeUndefined();
    await dispose();

    runtime = makeCanvasRuntime(
      path.statePath,
      path.installOpsPath,
      path.root,
    );
    const canvases = await runtime!.runPromise(CanvasesService);
    expect((await runtime!.runPromise(canvases.read("command-floor"))).doc).toEqual(
      projectedDoc,
    );
    expect(
      await runtime!.runPromise(
        canvases.readWithIntentWitness("command-floor"),
      ),
    ).toMatchObject({
      read: { doc: projectedDoc },
      intentWitness: {
        generation: "8",
        contentSha256: projection.contentSha256,
      },
    });

    const liveState = await runtime!.runPromise(StateEngine);
    const liveInstallOps = await runtime!.runPromise(InstallOpsService);
    expect(
      await runtime!.runPromise(
        liveState.read("test.remote.authority.after", snapshotCanvasAuthorityTables),
      ),
    ).toEqual(authorityBefore);
    expect(
      await runtime!.runPromise(snapshotInstallOpsMarkers(liveInstallOps)),
    ).toEqual(markersBefore);
    expect(
      await runtime!.runPromise(
        liveInstallOps.getBackfill(BACKFILL_CANVAS_RELATIONAL_V1),
      ),
    ).toMatchObject({ status: "complete", objectsIngested: 77 });
    expect(
      await runtime!.runPromise(
        liveInstallOps.getBackfill(BACKFILL_CANVAS_RELATIONAL_V2),
      ),
    ).toBeUndefined();
  });

  it("skips the direct Remote boundary and Remote no-head startup with relational residue byte-for-byte", async () => {
    const path = await paths();
    runtime = makeCoreRuntime(path.statePath, path.installOpsPath);
    const state = await runtime!.runPromise(StateEngine);
    const installOps = await runtime!.runPromise(InstallOpsService);
    await seedStaleRelationalResidue(state);
    await seedCanvasEntities(state, [
      { canvasName: "stale", entityId: "remote-active", lifecycle: "active" },
    ]);
    const projectedDoc = noteDoc("projected", "remote no-head projection");
    await seedRemoteProjection(state, "command-floor", projectedDoc);
    await runtime!.runPromise(
      installOps.markComplete(BACKFILL_CANVAS_RELATIONAL_V1, 11),
    );
    await runtime!.runPromise(
      installOps.markComplete(BACKFILL_CANVAS_RELATIONAL_V2, 22),
    );
    const authorityBefore = await runtime!.runPromise(
      state.read("test.remote-residue.before", snapshotCanvasAuthorityTables),
    );
    const entitiesBefore = await runtime!.runPromise(
      state.read("test.remote-residue.entities-before", snapshotCanvasEntities),
    );
    const markersBefore = await runtime!.runPromise(
      snapshotInstallOpsMarkers(installOps),
    );

    expect(
      await runtime!.runPromise(
        runCanvasRelationalBackfill({ state, installOps }),
      ),
    ).toEqual({
      status: "skipped-remote",
      reason: "authorial-relational-backfill-disabled-on-remote",
    });
    expect(
      await runtime!.runPromise(
        state.read("test.remote-residue.after-direct", snapshotCanvasAuthorityTables),
      ),
    ).toEqual(authorityBefore);
    expect(
      await runtime!.runPromise(
        state.read("test.remote-residue.entities-after-direct", snapshotCanvasEntities),
      ),
    ).toEqual(entitiesBefore);
    expect(
      await runtime!.runPromise(snapshotInstallOpsMarkers(installOps)),
    ).toEqual(markersBefore);
    await dispose();

    runtime = makeCanvasRuntime(
      path.statePath,
      path.installOpsPath,
      path.root,
    );
    const canvases = await runtime!.runPromise(CanvasesService);
    expect((await runtime!.runPromise(canvases.read("command-floor"))).doc).toEqual(
      projectedDoc,
    );
    const liveState = await runtime!.runPromise(StateEngine);
    const liveInstallOps = await runtime!.runPromise(InstallOpsService);
    expect(
      await runtime!.runPromise(
        liveState.read("test.remote-residue.after-startup", snapshotCanvasAuthorityTables),
      ),
    ).toEqual(authorityBefore);
    expect(
      await runtime!.runPromise(
        liveState.read("test.remote-residue.entities-after-startup", snapshotCanvasEntities),
      ),
    ).toEqual(entitiesBefore);
    expect(
      await runtime!.runPromise(snapshotInstallOpsMarkers(liveInstallOps)),
    ).toEqual(markersBefore);
  });

  it("reopens a preseeded complete v2 marker on empty non-Remote startup without changing the empty relational index", async () => {
    const path = await paths();
    runtime = makeCoreRuntime(path.statePath, path.installOpsPath);
    const state = await runtime!.runPromise(StateEngine);
    const seededInstallOps = await runtime!.runPromise(InstallOpsService);
    await runtime!.runPromise(
      seededInstallOps.markComplete(BACKFILL_CANVAS_RELATIONAL_V2, 41),
    );
    expect(
      await runtime!.runPromise(
        seededInstallOps.getBackfill(BACKFILL_CANVAS_RELATIONAL_V2),
      ),
    ).toMatchObject({ status: "complete", objectsIngested: 41 });
    const authorityBefore = await runtime!.runPromise(
      state.read("test.empty.before", snapshotCanvasAuthorityTables),
    );
    await dispose();

    runtime = makeCanvasRuntime(
      path.statePath,
      path.installOpsPath,
      path.root,
    );
    const canvases = await runtime!.runPromise(CanvasesService);
    expect(await runtime!.runPromise(canvases.list)).toEqual([]);
    const liveState = await runtime!.runPromise(StateEngine);
    const installOps = await runtime!.runPromise(InstallOpsService);
    expect(
      await runtime!.runPromise(
        liveState.read("test.empty.after", snapshotCanvasAuthorityTables),
      ),
    ).toEqual(authorityBefore);
    expect(
      await runtime!.runPromise(
        installOps.getBackfill(BACKFILL_CANVAS_RELATIONAL_V2),
      ),
    ).toMatchObject({ status: "pending", objectsIngested: 41 });
  });

  it("archives only active entity rows for an exact empty source and preserves archived history bytes", async () => {
    const path = await paths();
    runtime = makeCoreRuntime(path.statePath, path.installOpsPath);
    const state = await runtime!.runPromise(StateEngine);
    await seedCanvasEntities(state, [
      { canvasName: "orphan", entityId: "active", lifecycle: "active" },
      { canvasName: "orphan", entityId: "archived", lifecycle: "archived" },
      {
        canvasName: "orphan",
        entityId: "soft-deleted",
        lifecycle: "soft_deleted",
      },
    ]);
    const historicalBefore = await runtime!.runPromise(
      state.read("test.empty-entities.historical-before", (reader) =>
        stableJson(
          reader.all(
            `
              SELECT * FROM canvas_entities
              WHERE entity_id IN ('archived', 'soft-deleted')
              ORDER BY entity_id
            `,
          ),
        ),
      ),
    );
    await dispose();

    runtime = makeCanvasRuntime(
      path.statePath,
      path.installOpsPath,
      path.root,
    );
    const canvases = await runtime!.runPromise(CanvasesService);
    expect(await runtime!.runPromise(canvases.list)).toEqual([]);
    const liveState = await runtime!.runPromise(StateEngine);
    const entities = await runtime!.runPromise(
      liveState.read("test.empty-entities.after", (reader) =>
        reader.all<{
          readonly entity_id: string;
          readonly lifecycle: string;
          readonly archived_at: string | null;
          readonly soft_deleted_at: string | null;
        }>(
          `
            SELECT entity_id, lifecycle, archived_at, soft_deleted_at
            FROM canvas_entities
            ORDER BY entity_id
          `,
        ),
      ),
    );
    expect(entities).toMatchObject([
      { entity_id: "active", lifecycle: "archived" },
      { entity_id: "archived", lifecycle: "archived" },
      { entity_id: "soft-deleted", lifecycle: "soft_deleted" },
    ]);
    expect(entities[0]?.archived_at).not.toBeNull();
    expect(
      await runtime!.runPromise(
        liveState.read("test.empty-entities.historical-after", (reader) =>
          stableJson(
            reader.all(
              `
                SELECT * FROM canvas_entities
                WHERE entity_id IN ('archived', 'soft-deleted')
                ORDER BY entity_id
              `,
            ),
          ),
        ),
      ),
    ).toBe(historicalBefore);
    const installOps = await runtime!.runPromise(InstallOpsService);
    expect(
      await runtime!.runPromise(
        installOps.getBackfill(BACKFILL_CANVAS_RELATIONAL_V2),
      ),
    ).toMatchObject({ status: "pending" });
  });

  it("archives stale active entities for a valid zero-document head", async () => {
    const path = await paths();
    runtime = makeCoreRuntime(path.statePath, path.installOpsPath);
    const state = await runtime!.runPromise(StateEngine);
    await seedHistory(state, [{ generation: "9", documents: [] }], "9");
    await seedCanvasEntities(state, [
      { canvasName: "removed", entityId: "stale-active", lifecycle: "active" },
    ]);
    await dispose();

    runtime = makeCanvasRuntime(
      path.statePath,
      path.installOpsPath,
      path.root,
    );
    const canvases = await runtime!.runPromise(CanvasesService);
    await runtime!.runPromise(canvases.start());
    expect(await runtime!.runPromise(canvases.list)).toEqual([]);
    const liveState = await runtime!.runPromise(StateEngine);
    expect(
      await runtime!.runPromise(
        liveState.read("test.zero-doc-entities", (reader) =>
          reader.get<{ readonly lifecycle: string }>(
            `
              SELECT lifecycle FROM canvas_entities
              WHERE canvas_name = 'removed' AND entity_id = 'stale-active'
            `,
          )?.lifecycle,
        ),
      ),
    ).toBe("archived");
  });

  it("reconciles present entity membership and archives active names absent from a valid head", async () => {
    const path = await paths();
    runtime = makeCoreRuntime(path.statePath, path.installOpsPath);
    const state = await runtime!.runPromise(StateEngine);
    const presentDoc = applyMirrorLaw({
      nodes: [
        {
          id: "kept",
          type: "text",
          text: "present canvas",
          x: 0,
          y: 0,
          width: 160,
          height: 80,
          ether: {
            entity: { kind: "terminal" },
            terminal: { bindingId: "binding-new" },
          },
        },
        {
          id: "aligned",
          type: "text",
          text: "already aligned",
          x: 200,
          y: 0,
          width: 160,
          height: 80,
        },
      ],
      edges: [],
    });
    await seedHistory(
      state,
      [{ generation: "9", documents: [seedDoc("present", presentDoc)] }],
      "9",
    );
    await seedCanvasEntities(state, [
      {
        canvasName: "present",
        entityId: "kept",
        lifecycle: "active",
        kind: "agent",
        bindingId: "binding-old",
      },
      {
        canvasName: "present",
        entityId: "aligned",
        lifecycle: "active",
        updatedAt: "2025-01-01T00:00:00.000Z",
      },
      { canvasName: "present", entityId: "extra", lifecycle: "active" },
      { canvasName: "absent", entityId: "stale", lifecycle: "active" },
      { canvasName: "absent", entityId: "history", lifecycle: "archived" },
    ]);
    const archivedBefore = await runtime!.runPromise(
      state.read("test.mixed-entities.archived-before", (reader) =>
        stableJson(
          reader.get(
            `
              SELECT * FROM canvas_entities
              WHERE canvas_name = 'absent' AND entity_id = 'history'
            `,
          ),
        ),
      ),
    );
    await dispose();

    runtime = makeCanvasRuntime(
      path.statePath,
      path.installOpsPath,
      path.root,
    );
    const canvases = await runtime!.runPromise(CanvasesService);
    expect((await runtime!.runPromise(canvases.read("present"))).doc).toEqual(
      presentDoc,
    );
    const liveState = await runtime!.runPromise(StateEngine);
    expect(
      await runtime!.runPromise(
        liveState.read("test.mixed-entities.after", (reader) =>
          reader.all<{ readonly canvas_name: string; readonly entity_id: string; readonly lifecycle: string }>(
            `
              SELECT canvas_name, entity_id, lifecycle
              FROM canvas_entities
              ORDER BY canvas_name, entity_id
            `,
          ),
        ),
      ),
    ).toEqual([
      { canvas_name: "absent", entity_id: "history", lifecycle: "archived" },
      { canvas_name: "absent", entity_id: "stale", lifecycle: "archived" },
      { canvas_name: "present", entity_id: "aligned", lifecycle: "active" },
      { canvas_name: "present", entity_id: "extra", lifecycle: "archived" },
      { canvas_name: "present", entity_id: "kept", lifecycle: "active" },
    ]);
    expect(
      await runtime!.runPromise(
        liveState.read("test.mixed-entities.drift-repaired", (reader) => ({
          drifted: reader.get<{
            readonly kind: string | null;
            readonly binding_id: string | null;
          }>(
            `
              SELECT kind, binding_id FROM canvas_entities
              WHERE canvas_name = 'present' AND entity_id = 'kept'
            `,
          ),
          alignedUpdatedAt: reader.get<{ readonly updated_at: string }>(
            `
              SELECT updated_at FROM canvas_entities
              WHERE canvas_name = 'present' AND entity_id = 'aligned'
            `,
          )?.updated_at,
        })),
      ),
    ).toEqual({
      drifted: { kind: "terminal", binding_id: "binding-new" },
      alignedUpdatedAt: "2025-01-01T00:00:00.000Z",
    });
    expect(
      await runtime!.runPromise(
        liveState.read("test.mixed-entities.archived-after", (reader) =>
          stableJson(
            reader.get(
              `
                SELECT * FROM canvas_entities
                WHERE canvas_name = 'absent' AND entity_id = 'history'
              `,
            ),
          ),
        ),
      ),
    ).toBe(archivedBefore);
  });

  it("defers empty-source relational residue, preserves it exactly, and keeps non-Remote startup open", async () => {
    const path = await paths();
    runtime = makeCoreRuntime(path.statePath, path.installOpsPath);
    const state = await runtime!.runPromise(StateEngine);
    await seedStaleRelationalResidue(state);
    const authorityBefore = await runtime!.runPromise(
      state.read("test.residue.before", snapshotCanvasAuthorityTables),
    );
    await dispose();

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    runtime = makeCanvasRuntime(
      path.statePath,
      path.installOpsPath,
      path.root,
    );
    const canvases = await runtime!.runPromise(CanvasesService);
    expect(await runtime!.runPromise(canvases.list)).toEqual([]);
    expect(
      errorSpy.mock.calls.some((call) =>
        /unverifiable relational residue/.test(errorChainText(call[1])),
      ),
    ).toBe(true);
    const liveState = await runtime!.runPromise(StateEngine);
    const installOps = await runtime!.runPromise(InstallOpsService);
    expect(
      await runtime!.runPromise(
        liveState.read("test.residue.after", snapshotCanvasAuthorityTables),
      ),
    ).toEqual(authorityBefore);
    expect(
      await runtime!.runPromise(
        installOps.getBackfill(BACKFILL_CANVAS_RELATIONAL_V2),
      ),
    ).toMatchObject({ status: "pending", objectsIngested: 0 });
  });

  it("keeps legacy generation bytes authoritative when a matching-count relational manifest is poisoned", async () => {
    const path = await paths();
    runtime = makeCoreRuntime(path.statePath, path.installOpsPath);
    const state = await runtime!.runPromise(StateEngine);
    const authoritative = noteDoc("authority", "legacy authority wins");
    const poisoned = noteDoc("poison", "derived checkpoint must not win");
    const source = generationMaterial({
      generation: "9",
      documents: [seedDoc("alpha", authoritative)],
    });
    await seedHistory(
      state,
      [{ generation: "9", documents: [seedDoc("alpha", authoritative)] }],
      "9",
    );
    await seedPoisonedManifest(state, "9", "alpha", poisoned);
    await dispose();

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    runtime = makeCanvasRuntime(
      path.statePath,
      path.installOpsPath,
      path.root,
    );
    const canvases = await runtime!.runPromise(CanvasesService);
    expect((await runtime!.runPromise(canvases.read("alpha"))).doc).toEqual(
      authoritative,
    );
    const material = await runtime!.runPromise(
      canvases.authorityMaterialSnapshot(),
    );
    expect(material.documents.get("alpha")).toEqual(authoritative);
    expect(material.storedDocuments.get("alpha")).toMatchObject({
      document: authoritative,
      rawBody: serializeCanvas(authoritative),
      revisionSha256: sha256(serializeCanvas(authoritative)),
    });
    expect(material.intentSha256).toBe(source.intentSha256);
    expect(
      await runtime!.runPromise(canvases.readWithIntentWitness("alpha")),
    ).toMatchObject({
      read: { doc: authoritative },
      intentWitness: {
        generation: "9",
        contentSha256: source.intentSha256,
      },
    });
    expect(await runtime!.runPromise(canvases.activeIntentWitness())).toEqual({
      generation: "9",
      contentSha256: source.intentSha256,
    });
    expect(
      errorSpy.mock.calls.some((call) =>
        /manifest|checkpoint/.test(errorChainText(call[1])),
      ),
    ).toBe(true);
  });

  it("walks a nonempty >2^63 gapped history, rewires before delete, retires removals, preserves logs, and restarts idempotently", async () => {
    const path = await paths();
    runtime = makeCoreRuntime(path.statePath, path.installOpsPath);
    const state = await runtime!.runPromise(StateEngine);
    const installOps = await runtime!.runPromise(InstallOpsService);
    await seedHistory(
      state,
      [
        {
          generation: "9",
          documents: [
            seedDoc("alpha", wiredDoc("old-task")),
            seedDoc("removed", noteDoc("gone", "historical")),
          ],
        },
        {
          generation: HUGE_1,
          documents: [
            seedDoc("alpha", wiredDoc("old-task")),
            seedDoc("removed", noteDoc("gone", "historical")),
          ],
        },
        {
          generation: HUGE_2,
          documents: [seedDoc("alpha", wiredDoc("new-task"))],
        },
      ],
      HUGE_2,
    );
    await seedImmutableWorkFact(state, "9");
    const beforeLogs = await runtime!.runPromise(
      state.read("test.logs.before", readWorkLogWitness),
    );
    await runtime!.runPromise(
      installOps.markComplete(BACKFILL_CANVAS_RELATIONAL_V1, 999),
    );
    await runtime!.runPromise(
      installOps.markComplete(BACKFILL_CANVAS_RELATIONAL_V2, 999),
    );
    await dispose();

    runtime = makeCanvasRuntime(
      path.statePath,
      path.installOpsPath,
      path.root,
    );
    const canvases = await runtime!.runPromise(CanvasesService);
    expect((await runtime!.runPromise(canvases.read("alpha"))).doc).toEqual(
      wiredDoc("new-task"),
    );
    const liveState = await runtime!.runPromise(StateEngine);
    const liveInstallOps = await runtime!.runPromise(InstallOpsService);
    const witness = await runtime!.runPromise(
      liveState.read("test.relational.witness", (reader) => {
        const alpha = reader.get<{ readonly canvas_id: string }>(
          "SELECT canvas_id FROM canvas_documents WHERE canvas_name = 'alpha'",
        );
        const removed = reader.get<{ readonly canvas_id: string }>(
          "SELECT canvas_id FROM canvas_documents WHERE canvas_name = 'removed'",
        );
        if (alpha === undefined || removed === undefined) {
          throw new Error("missing relational canvas identities");
        }
        return {
          parents: reader.all<{
            readonly generation: string;
            readonly parent_generation: string | null;
          }>(
            "SELECT generation, parent_generation FROM canvas_commit_envelopes",
          ),
          edge: reader.get<{
            readonly from_node_id: string;
            readonly to_node_id: string;
          }>(
            "SELECT from_node_id, to_node_id FROM canvas_edges WHERE canvas_id = ? AND edge_id = 'retained-edge'",
            [alpha.canvas_id],
          ),
          oldObject: reader.get<{
            readonly deleted_generation: string | null;
          }>(
            "SELECT deleted_generation FROM canvas_objects WHERE canvas_id = ? AND object_id = 'old-task'",
            [alpha.canvas_id],
          ),
          oldNode: reader.get<{ readonly count: number | bigint }>(
            "SELECT count(*) AS count FROM canvas_nodes WHERE canvas_id = ? AND node_id = 'old-task'",
            [alpha.canvas_id],
          ),
          removedLive: reader.get<{ readonly count: number | bigint }>(
            `
              SELECT
                (SELECT count(*) FROM canvas_nodes WHERE canvas_id = ?) +
                (SELECT count(*) FROM canvas_edges WHERE canvas_id = ?) +
                (SELECT count(*) FROM canvas_objects WHERE canvas_id = ? AND deleted_generation IS NULL) AS count
            `,
            [removed.canvas_id, removed.canvas_id, removed.canvas_id],
          ),
          manifests: reader.get<{ readonly count: number | bigint }>(
            "SELECT count(*) AS count FROM canvas_generation_manifests",
          ),
          logs: readWorkLogWitness(reader),
        };
      }),
    );
    const parents = new Map(
      witness.parents.map((row) => [row.generation, row.parent_generation]),
    );
    expect(parents.get("9")).toBeNull();
    expect(parents.get(HUGE_1)).toBe("9");
    expect(parents.get(HUGE_2)).toBe(HUGE_1);
    expect(witness.edge).toEqual({
      from_node_id: "new-task",
      to_node_id: "target-task",
    });
    expect(witness.oldObject?.deleted_generation).toBe(HUGE_2);
    expect(Number(witness.oldNode?.count)).toBe(0);
    expect(Number(witness.removedLive?.count)).toBe(0);
    expect(Number(witness.manifests?.count)).toBe(5);
    expect(witness.logs).toEqual(beforeLogs);
    expect(
      await runtime!.runPromise(
        liveInstallOps.getBackfill(BACKFILL_CANVAS_RELATIONAL_V1),
      ),
    ).toMatchObject({ status: "complete", objectsIngested: 999 });
    expect(
      await runtime!.runPromise(
        liveInstallOps.getBackfill(BACKFILL_CANVAS_RELATIONAL_V2),
      ),
    ).toMatchObject({ status: "pending" });

    const countsBeforeRestart = await runtime!.runPromise(
      liveState.read("test.counts.before-restart", (reader) => ({
        checkpoints: reader.get<{ readonly count: number | bigint }>(
          "SELECT count(*) AS count FROM canvas_checkpoints",
        )?.count,
        manifests: reader.get<{ readonly count: number | bigint }>(
          "SELECT count(*) AS count FROM canvas_generation_manifests",
        )?.count,
        envelopes: reader.get<{ readonly count: number | bigint }>(
          "SELECT count(*) AS count FROM canvas_commit_envelopes",
        )?.count,
        objects: reader.get<{ readonly count: number | bigint }>(
          "SELECT count(*) AS count FROM canvas_objects",
        )?.count,
      })),
    );
    await dispose();

    runtime = makeCanvasRuntime(
      path.statePath,
      path.installOpsPath,
      path.root,
    );
    const restartedCanvases = await runtime!.runPromise(CanvasesService);
    await runtime!.runPromise(restartedCanvases.read("alpha"));
    const restartedState = await runtime!.runPromise(StateEngine);
    expect(
      await runtime!.runPromise(
        restartedState.read("test.counts.after-restart", (reader) => ({
          checkpoints: reader.get<{ readonly count: number | bigint }>(
            "SELECT count(*) AS count FROM canvas_checkpoints",
          )?.count,
          manifests: reader.get<{ readonly count: number | bigint }>(
            "SELECT count(*) AS count FROM canvas_generation_manifests",
          )?.count,
          envelopes: reader.get<{ readonly count: number | bigint }>(
            "SELECT count(*) AS count FROM canvas_commit_envelopes",
          )?.count,
          objects: reader.get<{ readonly count: number | bigint }>(
            "SELECT count(*) AS count FROM canvas_objects",
          )?.count,
        })),
      ),
    ).toEqual(countsBeforeRestart);
  });

  it("preserves the first final absence generation and reproduces explicit resurrection semantics", async () => {
    const path = await paths();
    runtime = makeCoreRuntime(path.statePath, path.installOpsPath);
    const state = await runtime!.runPromise(StateEngine);
    const installOps = await runtime!.runPromise(InstallOpsService);
    const empty: CanvasDoc = applyMirrorLaw({ nodes: [], edges: [] });
    await seedHistory(
      state,
      [
        {
          generation: "9",
          documents: [
            seedDoc("retired", noteDoc("retired-node", "present at nine")),
            seedDoc("resurrected", noteDoc("returning-node", "first life")),
          ],
        },
        {
          generation: "11",
          documents: [
            seedDoc("retired", empty),
            seedDoc("resurrected", empty),
          ],
        },
        {
          generation: "12",
          documents: [
            seedDoc("retired", empty),
            seedDoc(
              "resurrected",
              noteDoc("returning-node", "resurrected at head"),
            ),
          ],
        },
      ],
      "12",
    );

    expect(
      await runtime!.runPromise(
        runCanvasRelationalBackfill({ state, installOps }),
      ),
    ).toMatchObject({ status: "verified-pending-witness", headGeneration: "12" });
    expect(
      await runtime!.runPromise(
        state.read("test.lifecycle-provenance", (reader) =>
          reader.all<{
            readonly canvas_name: string;
            readonly object_id: string;
            readonly first_seen_generation: string;
            readonly deleted_generation: string | null;
            readonly created_at: string;
          }>(
            `
              SELECT document.canvas_name, object.object_id,
                     object.first_seen_generation, object.deleted_generation,
                     object.created_at
              FROM canvas_objects AS object
              JOIN canvas_documents AS document
                ON document.canvas_id = object.canvas_id
              WHERE object.object_id IN ('retired-node', 'returning-node')
              ORDER BY document.canvas_name
            `,
          ),
        ),
      ),
    ).toEqual([
      {
        canvas_name: "resurrected",
        object_id: "returning-node",
        first_seen_generation: "9",
        deleted_generation: null,
        created_at: NOW,
      },
      {
        canvas_name: "retired",
        object_id: "retired-node",
        first_seen_generation: "9",
        deleted_generation: "11",
        created_at: NOW,
      },
    ]);
  });

  it("repairs legacy arbitrary-precision first-seen drift while preserving v1 created_at metadata", async () => {
    const path = await paths();
    runtime = makeCoreRuntime(path.statePath, path.installOpsPath);
    const state = await runtime!.runPromise(StateEngine);
    const installOps = await runtime!.runPromise(InstallOpsService);
    const empty: CanvasDoc = applyMirrorLaw({ nodes: [], edges: [] });
    const live = noteDoc("late-node", "appears beyond signed 64-bit");
    await seedHistory(
      state,
      [
        { generation: "9", documents: [seedDoc("alpha", empty)] },
        { generation: HUGE_1, documents: [seedDoc("alpha", live)] },
        { generation: HUGE_2, documents: [seedDoc("alpha", live)] },
      ],
      HUGE_2,
    );
    const legacyCreatedAt = "2025-12-31T23:59:59.000Z";
    await seedLegacyRelationalObject(state, {
      canvasName: "alpha",
      headGeneration: HUGE_2,
      doc: live,
      objectId: "late-node",
      objectKind: "node",
      firstSeenGeneration: HUGE_2,
      createdAt: legacyCreatedAt,
    });
    await runtime!.runPromise(
      installOps.markComplete(BACKFILL_CANVAS_RELATIONAL_V1, 1),
    );

    expect(
      await runtime!.runPromise(
        runCanvasRelationalBackfill({ state, installOps }),
      ),
    ).toMatchObject({ status: "verified-pending-witness" });
    expect(
      await runtime!.runPromise(
        state.read("test.legacy-object-provenance", (reader) =>
          reader.get<{
            readonly first_seen_generation: string;
            readonly created_at: string;
          }>(
            `
              SELECT first_seen_generation, created_at
              FROM canvas_objects
              WHERE canvas_id = 'canvas_legacy_object'
                AND object_id = 'late-node'
            `,
          ),
        ),
      ),
    ).toEqual({
      first_seen_generation: HUGE_1,
      created_at: legacyCreatedAt,
    });
  });

  it("defers existing object-kind drift and preserves the hostile row", async () => {
    const path = await paths();
    runtime = makeCoreRuntime(path.statePath, path.installOpsPath);
    const state = await runtime!.runPromise(StateEngine);
    const installOps = await runtime!.runPromise(InstallOpsService);
    const sourceDoc = noteDoc("stable-node", "source node");
    await seedHistory(
      state,
      [{ generation: "9", documents: [seedDoc("alpha", sourceDoc)] }],
      "9",
    );
    await seedLegacyRelationalObject(state, {
      canvasName: "alpha",
      headGeneration: "9",
      doc: sourceDoc,
      objectId: "stable-node",
      objectKind: "edge",
      firstSeenGeneration: "9",
      createdAt: "2025-01-01T00:00:00.000Z",
    });
    const before = await runtime!.runPromise(
      state.read("test.object-kind-drift.before", snapshotRelationalCurrentGraph),
    );

    let driftError: unknown;
    try {
      await runtime!.runPromise(
        runCanvasRelationalBackfill({ state, installOps }),
      );
    } catch (error) {
      driftError = error;
    }
    expect(errorChainText(driftError)).toMatch(/cross-kind identity/);
    expect(
      await runtime!.runPromise(
        state.read("test.object-kind-drift.row", (reader) =>
          reader.get<{
            readonly object_kind: string;
            readonly created_at: string;
          }>(
            `
              SELECT object_kind, created_at
              FROM canvas_objects
              WHERE canvas_id = 'canvas_legacy_object'
                AND object_id = 'stable-node'
            `,
          ),
        ),
      ),
    ).toEqual({
      object_kind: "edge",
      created_at: "2025-01-01T00:00:00.000Z",
    });
    const after = await runtime!.runPromise(
      state.read("test.object-kind-drift.after", snapshotRelationalCurrentGraph),
    );
    expect(after.canvas_objects).toEqual(before.canvas_objects);
    expect(
      await runtime!.runPromise(
        installOps.getBackfill(BACKFILL_CANVAS_RELATIONAL_V2),
      ),
    ).toMatchObject({ status: "pending" });
  });

  it("rechecks the captured source prefix inside current-head mutation and refuses a stale graph", async () => {
    const path = await paths();
    runtime = makeCoreRuntime(path.statePath, path.installOpsPath);
    const state = await runtime!.runPromise(StateEngine);
    const installOps = await runtime!.runPromise(InstallOpsService);
    await seedHistory(
      state,
      [{ generation: "9", documents: [seedDoc("alpha", noteDoc("node", "nine"))] }],
      "9",
    );
    await runtime!.runPromise(
      runCanvasRelationalBackfill({ state, installOps }),
    );
    const graphBefore = await runtime!.runPromise(
      state.read("test.source-race.graph-before", snapshotRelationalCurrentGraph),
    );

    let advanced = false;
    const advancingState: TestStateService = {
      read: state.read,
      transaction: <A>(
        operation: string,
        body: (writer: StateWriter) => A,
      ): Effect.Effect<A, unknown> =>
        operation === "canvas.relational.v2.current-head" && !advanced
          ? Effect.gen(function* () {
              advanced = true;
              yield* state.transaction("test.source-race.advance", (writer) =>
                appendHistoryGeneration(writer, {
                  generation: "11",
                  documents: [seedDoc("alpha", noteDoc("node", "eleven"))],
                }),
              );
              return yield* state.transaction(operation, body);
            })
          : state.transaction(operation, body),
    };

    let advanceError: unknown;
    try {
      await runtime!.runPromise(
        runCanvasRelationalBackfill({ state: advancingState, installOps }),
      );
    } catch (error) {
      advanceError = error;
    }
    expect(errorChainText(advanceError)).toMatch(
      /source prefix changed before relational current-head mutation/,
    );
    expect(advanced).toBe(true);
    expect(
      await runtime!.runPromise(
        state.read("test.source-race.graph-after", snapshotRelationalCurrentGraph),
      ),
    ).toEqual(graphBefore);
    expect(
      await runtime!.runPromise(
        state.read("test.source-race.head", (reader) =>
          reader.get<{ readonly generation: string }>(
            "SELECT generation FROM canvas_head WHERE singleton = 1",
          )?.generation,
        ),
      ),
    ).toBe("11");
    expect(
      await runtime!.runPromise(
        installOps.getBackfill(BACKFILL_CANVAS_RELATIONAL_V2),
      ),
    ).toMatchObject({ status: "pending" });
  });

  it("rechecks canonical role in every write transaction and commits nothing after a CC to Remote flip", async () => {
    const path = await paths();
    runtime = makeCoreRuntime(path.statePath, path.installOpsPath);
    const state = await runtime!.runPromise(StateEngine);
    const installOps = await runtime!.runPromise(InstallOpsService);
    await seedHistory(
      state,
      [
        { generation: "9", documents: [seedDoc("alpha", noteDoc("node", "nine"))] },
        { generation: "11", documents: [seedDoc("alpha", noteDoc("node", "eleven"))] },
      ],
      "11",
    );

    let flipped = false;
    let authorityAtFlip:
      | Readonly<Record<string, { readonly count: number; readonly bytes: string }>>
      | undefined;
    const flippingState: TestStateService = {
      read: state.read,
      transaction: <A>(
        operation: string,
        body: (writer: StateWriter) => A,
      ): Effect.Effect<A, unknown> =>
        operation === "canvas.relational.v2.evidence.11" && !flipped
          ? Effect.gen(function* () {
              yield* state.transaction("test.role-race.flip", (writer) => {
                writer.run(
                  `
                    INSERT INTO station_known_installations(
                      installation_id, registered_at
                    ) VALUES ('command-installation', ?)
                  `,
                  [NOW],
                );
                writer.run(
                  `
                    INSERT INTO station_configuration(
                      singleton, role, host_id, agent_host_id,
                      command_center_installation_id,
                      supervised_preferred, configured_at
                    ) VALUES (
                      1, 'remote', 'remote-host', 'remote-host',
                      'command-installation', 1, ?
                    )
                  `,
                  [NOW],
                );
                authorityAtFlip = snapshotCanvasAuthorityTables(writer);
              });
              flipped = true;
              return yield* state.transaction(operation, body);
            })
          : state.transaction(operation, body),
    };

    let roleRaceError: unknown;
    try {
      await runtime!.runPromise(
        runCanvasRelationalBackfill({ state: flippingState, installOps }),
      );
    } catch (error) {
      roleRaceError = error;
    }
    expect(errorChainText(roleRaceError)).toMatch(
      /Remote role forbids authorial relational backfill mutation/,
    );
    expect(flipped).toBe(true);
    expect(authorityAtFlip).toBeDefined();
    expect(
      await runtime!.runPromise(
        state.read("test.role-race.after", snapshotCanvasAuthorityTables),
      ),
    ).toEqual(authorityAtFlip);
    expect(
      await runtime!.runPromise(
        state.read("test.role-race.current-counts", (reader) => ({
          objects: Number(
            reader.get<{ readonly count: number | bigint }>(
              "SELECT count(*) AS count FROM canvas_objects",
            )?.count ?? -1,
          ),
          nodes: Number(
            reader.get<{ readonly count: number | bigint }>(
              "SELECT count(*) AS count FROM canvas_nodes",
            )?.count ?? -1,
          ),
          edges: Number(
            reader.get<{ readonly count: number | bigint }>(
              "SELECT count(*) AS count FROM canvas_edges",
            )?.count ?? -1,
          ),
        })),
      ),
    ).toEqual({ objects: 0, nodes: 0, edges: 0 });
    expect(
      await runtime!.runPromise(
        installOps.getBackfill(BACKFILL_CANVAS_RELATIONAL_V2),
      ),
    ).toMatchObject({ status: "pending" });
  });

  it("holds real CanvasesLive authoring behind bootstrap and commits it after relational readiness", async () => {
    const path = await paths();
    runtime = makeCoreRuntime(path.statePath, path.installOpsPath);
    const state = await runtime!.runPromise(StateEngine);
    await seedHistory(
      state,
      [{ generation: "9", documents: [seedDoc("alpha", noteDoc("node", "before"))] }],
      "9",
    );
    await dispose();

    let releaseBackfill!: () => void;
    const backfillGate = new Promise<void>((resolve) => {
      releaseBackfill = resolve;
    });
    let announceBackfillEntered!: () => void;
    const backfillEntered = new Promise<void>((resolve) => {
      announceBackfillEntered = resolve;
    });
    let paused = false;
    const markers = new Map<string, {
      readonly id: string;
      readonly status: "pending" | "complete";
      readonly objectsIngested: number;
      readonly completedAt: string | undefined;
    }>();
    const pausedInstallOps = InstallOpsService.of({
      path: path.installOpsPath,
      availability: { status: "available" },
      getBackfill: (id) => {
        const read = () => Effect.succeed(markers.get(id));
        if (id !== BACKFILL_CANVAS_RELATIONAL_V2 || paused) return read();
        paused = true;
        announceBackfillEntered();
        return Effect.promise(() => backfillGate).pipe(Effect.flatMap(read));
      },
      ensurePending: (id) =>
        Effect.sync(() => {
          if (!markers.has(id)) {
            markers.set(id, {
              id,
              status: "pending",
              objectsIngested: 0,
              completedAt: undefined,
            });
          }
        }),
      reopenPending: (id) =>
        Effect.sync(() => {
          const marker = markers.get(id);
          markers.set(id, {
            id,
            status: "pending",
            objectsIngested: marker?.objectsIngested ?? 0,
            completedAt: undefined,
          });
        }),
      markComplete: (id, objectsIngested) =>
        Effect.sync(() => {
          markers.set(id, {
            id,
            status: "complete",
            objectsIngested,
            completedAt: NOW,
          });
        }),
    });
    runtime = makeCanvasRuntime(
      path.statePath,
      path.installOpsPath,
      path.root,
      Layer.succeed(InstallOpsService, pausedInstallOps),
    );
    const canvases = await runtime!.runPromise(CanvasesService);
    const liveState = await runtime!.runPromise(StateEngine);
    const startup = runtime!.runPromise(canvases.start());
    await backfillEntered;

    let writeSettled = false;
    const writePromise = runtime!
      .runPromise(
        canvases.applyAuthoringCommand({
          kind: DOCUMENT_REPLACE_V1,
          changeId: "chg_readiness_race",
          canvasName: "alpha",
          doc: noteDoc("node", "after readiness"),
        }),
      )
      .finally(() => {
        writeSettled = true;
      });
    await Promise.resolve();
    await Promise.resolve();
    expect(writeSettled).toBe(false);
    expect(
      await runtime!.runPromise(
        liveState.read("test.readiness.head-before-release", (reader) =>
          reader.get<{ readonly generation: string }>(
            "SELECT generation FROM canvas_head WHERE singleton = 1",
          )?.generation,
        ),
      ),
    ).toBe("9");

    releaseBackfill();
    await startup;
    await writePromise;
    expect(writeSettled).toBe(true);
    expect(
      await runtime!.runPromise(
        liveState.read("test.readiness.after", (reader) => ({
          sourceHead: reader.get<{ readonly generation: string }>(
            "SELECT generation FROM canvas_head WHERE singleton = 1",
          )?.generation,
          relationalHead: reader.get<{ readonly head_generation: string }>(
            "SELECT head_generation FROM canvas_documents WHERE canvas_name = 'alpha'",
          )?.head_generation,
          relationalText: reader.get<{ readonly text_content: string | null }>(
            `
              SELECT node.text_content
              FROM canvas_nodes AS node
              JOIN canvas_documents AS document
                ON document.canvas_id = node.canvas_id
              WHERE document.canvas_name = 'alpha' AND node.node_id = 'node'
            `,
          )?.text_content,
        })),
      ),
    ).toEqual({
      sourceHead: "10",
      relationalHead: "10",
      relationalText: "after readiness",
    });
    expect(markers.get(BACKFILL_CANVAS_RELATIONAL_V2)).toMatchObject({
      status: "pending",
    });
  });

  it("leaves v2 pending across an injected crash and completes the idempotent walk on restart", async () => {
    const path = await paths();
    runtime = makeCoreRuntime(path.statePath, path.installOpsPath);
    const state = await runtime!.runPromise(StateEngine);
    const installOps = await runtime!.runPromise(InstallOpsService);
    await seedHistory(
      state,
      [
        { generation: "9", documents: [seedDoc("alpha", wiredDoc("old-task"))] },
        { generation: "11", documents: [seedDoc("alpha", wiredDoc("new-task"))] },
      ],
      "11",
    );

    const crashingState = {
      read: state.read,
      transaction: <A>(
        operation: string,
        body: (writer: StateWriter) => A,
      ): Effect.Effect<A, unknown> =>
        state.transaction(operation, (writer) =>
          operation === "canvas.relational.v2.current-head"
            ? body(crashingWriter(writer, 3))
            : body(writer),
        ),
    };
    await expect(
      runtime!.runPromise(
        runCanvasRelationalBackfill({ state: crashingState, installOps }),
      ),
    ).rejects.toThrow(/deferred|injected relational crash/);
    expect(
      await runtime!.runPromise(
        installOps.getBackfill(BACKFILL_CANVAS_RELATIONAL_V2),
      ),
    ).toMatchObject({ status: "pending" });
    await dispose();

    runtime = makeCanvasRuntime(
      path.statePath,
      path.installOpsPath,
      path.root,
    );
    const canvases = await runtime!.runPromise(CanvasesService);
    expect((await runtime!.runPromise(canvases.read("alpha"))).doc).toEqual(
      wiredDoc("new-task"),
    );
    const restartedState = await runtime!.runPromise(StateEngine);
    expect(
      await runtime!.runPromise(
        restartedState.read("test.crash.restart", (reader) =>
          reader.get<{ readonly from_node_id: string }>(
            "SELECT from_node_id FROM canvas_edges WHERE edge_id = 'retained-edge'",
          ),
        ),
      ),
    ).toEqual({ from_node_id: "new-task" });
  });

  type FailureCase = {
    readonly name: string;
    readonly historical: StoredSeedDocument;
    readonly documentCount?: number;
    readonly afterSeed?: (state: TestStateService) => Promise<void>;
    readonly error: RegExp;
  };

  const validHistoricalDoc = noteDoc("old", "history");
  const validHistorical = seedDoc("history", validHistoricalDoc);
  const validCurrent = seedDoc("current", noteDoc("head", "current"));
  const historicalSha = sha256(validHistorical.body);
  const historicalSemantic = canvasDocSemanticHash(validHistoricalDoc);

  const failureCases: ReadonlyArray<FailureCase> = [
    {
      name: "malformed JSON",
      historical: seedBody("history", "{"),
      error: /malformed JSON/,
    },
    {
      name: "CanvasDoc decode failure",
      historical: seedBody(
        "history",
        JSON.stringify({
          nodes: [{ id: "bad", type: "text", x: 0, y: 0, width: 10, height: 10 }],
          edges: [],
        }),
      ),
      error: /failed CanvasDoc decode/,
    },
    {
      name: "protected Work projection",
      historical: seedBody(
        "history",
        JSON.stringify({
          nodes: [
            {
              id: "sink",
              type: "text",
              text: "tasks",
              x: 0,
              y: 0,
              width: 10,
              height: 10,
              ether: {
                entity: { kind: "task" },
                tasks: { items: [{ id: "work-1", state: "submitted", history: [] }] },
              },
            },
          ],
          edges: [],
        }),
      ),
      error: /protected runtime Work projection/,
    },
    {
      name: "stored body hash mismatch",
      historical: seedBody("history", validHistorical.body, "0".repeat(64)),
      error: /body sha256 mismatch/,
    },
    {
      name: "document_count mismatch",
      historical: validHistorical,
      documentCount: 2,
      error: /document_count mismatch/,
    },
    {
      name: "dangling edge",
      historical: seedBody(
        "history",
        JSON.stringify({
          nodes: [
            {
              id: "agent",
              type: "text",
              text: "agent",
              x: 0,
              y: 0,
              width: 10,
              height: 10,
              ether: { entity: { kind: "agent", name: "local:agent" } },
            },
          ],
          edges: [
            {
              id: "dangling",
              fromNode: "missing",
              toNode: "agent",
              ether: { verb: "messages" },
            },
          ],
        }),
      ),
      error: /is dangling/,
    },
    {
      name: "duplicate node id",
      historical: seedBody(
        "history",
        JSON.stringify({
          nodes: [
            {
              id: "same",
              type: "text",
              text: "one",
              x: 0,
              y: 0,
              width: 10,
              height: 10,
            },
            {
              id: "same",
              type: "text",
              text: "two",
              x: 20,
              y: 0,
              width: 10,
              height: 10,
            },
          ],
          edges: [],
        }),
      ),
      error: /duplicate node id/,
    },
    {
      name: "duplicate cross-kind id",
      historical: seedBody(
        "history",
        JSON.stringify({
          nodes: [
            {
              id: "same",
              type: "text",
              text: "agent",
              x: 0,
              y: 0,
              width: 10,
              height: 10,
              ether: { entity: { kind: "agent", name: "local:agent" } },
            },
          ],
          edges: [
            {
              id: "same",
              fromNode: "same",
              toNode: "same",
              ether: { verb: "messages" },
            },
          ],
        }),
      ),
      error: /duplicate or cross-kind object id/,
    },
    {
      name: "checkpoint byte-length mismatch",
      historical: validHistorical,
      afterSeed: async (state) => {
        await Effect.runPromise(
          state.transaction("test.seed.bad-checkpoint", (writer) => {
            writer.run(
              `
                INSERT INTO canvas_checkpoints(sha256, byte_length, body, created_at)
                VALUES (?, ?, ?, ?)
              `,
              [
                historicalSha,
                Buffer.byteLength(validHistorical.body, "utf8") + 1,
                validHistorical.body,
                NOW,
              ],
            );
          }),
        );
      },
      error: /body digest or byte-length mismatch/,
    },
    {
      name: "manifest digest mismatch",
      historical: validHistorical,
      afterSeed: async (state) => {
        await Effect.runPromise(
          state.transaction("test.seed.bad-manifest", (writer) => {
            writer.run(
              `
                INSERT INTO canvas_checkpoints(sha256, byte_length, body, created_at)
                VALUES (?, ?, ?, ?)
              `,
              [
                historicalSha,
                Buffer.byteLength(validHistorical.body, "utf8"),
                validHistorical.body,
                NOW,
              ],
            );
            writer.run(
              `
                INSERT INTO canvas_documents(
                  canvas_id, canvas_name, head_generation,
                  head_checkpoint_sha256, head_semantic_sha256,
                  created_at, updated_at
                ) VALUES ('canvas_bad_manifest', 'history', '9', ?, ?, ?, ?)
              `,
              [historicalSha, historicalSemantic, NOW, NOW],
            );
            writer.run(
              `
                INSERT INTO canvas_generation_manifests(
                  generation, canvas_id, checkpoint_sha256, semantic_sha256
                ) VALUES ('9', 'canvas_bad_manifest', ?, ?)
              `,
              [historicalSha, "f".repeat(64)],
            );
          }),
        );
      },
      error: /manifest digest mismatch/,
    },
    {
      name: "false ancestry",
      historical: validHistorical,
      afterSeed: async (state) => {
        const intent = intentSha256Of(
          new Map([["history", { revisionSha256: historicalSha }]]),
        );
        await Effect.runPromise(
          state.transaction("test.seed.false-ancestry", (writer) => {
            writer.run(
              `
                INSERT INTO canvas_commit_envelopes(
                  generation, parent_generation, cause, intent_sha256,
                  created_at
                ) VALUES ('9', '8', 'seed', ?, ?)
              `,
              [intent, NOW],
            );
          }),
        );
      },
      error: /false relational ancestry/,
    },
  ];

  it.each(failureCases)(
    "defers $name, keeps v2 pending, and leaves startup open on the valid current head",
    async ({ historical, documentCount, afterSeed, error }) => {
      const path = await paths();
      runtime = makeCoreRuntime(path.statePath, path.installOpsPath);
      const state = await runtime!.runPromise(StateEngine);
      await seedHistory(
        state,
        [
          {
            generation: "9",
            documents: [historical],
            ...(documentCount === undefined ? {} : { documentCount }),
          },
          { generation: "11", documents: [validCurrent] },
        ],
        "11",
      );
      await afterSeed?.(state);
      await dispose();

      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      runtime = makeCanvasRuntime(
        path.statePath,
        path.installOpsPath,
        path.root,
      );
      const canvases = await runtime!.runPromise(CanvasesService);
      await runtime!.runPromise(canvases.start());
      expect((await runtime!.runPromise(canvases.read("current"))).doc).toEqual(
        noteDoc("head", "current"),
      );
      expect(
        errorSpy.mock.calls.some((call) => error.test(errorChainText(call[1]))),
      ).toBe(true);
      const installOps = await runtime!.runPromise(InstallOpsService);
      expect(
        await runtime!.runPromise(
          installOps.getBackfill(BACKFILL_CANVAS_RELATIONAL_V2),
        ),
      ).toMatchObject({ status: "pending" });
      const liveState = await runtime!.runPromise(StateEngine);
      expect(
        await runtime!.runPromise(
          liveState.read("test.failure.source-preserved", (reader) => ({
            generations: reader.get<{ readonly count: number | bigint }>(
              "SELECT count(*) AS count FROM canvas_generations",
            )?.count,
            documents: reader.get<{ readonly count: number | bigint }>(
              "SELECT count(*) AS count FROM canvas_generation_documents",
            )?.count,
            head: reader.get<{ readonly generation: string }>(
              "SELECT generation FROM canvas_head WHERE singleton = 1",
            )?.generation,
          })),
        ),
      ).toEqual({ generations: 2, documents: 2, head: "11" });
    },
  );
});
