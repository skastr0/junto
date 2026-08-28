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
import { InstallOpsService } from "../src/main/vellum/install-ops/service";
import { WorkRepositoryLive } from "../src/main/vellum/work/repository";
import { StationRepositoryLive } from "../src/main/vellum/station/repository";
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
      Layer.mergeAll(
        makeStateEngineLive(statePath),
        makeInstallOpsLive(installOpsPath),
      ),
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

  const validHistorical = seedDoc("history", noteDoc("old", "history"));
  const validCurrent = seedDoc("current", noteDoc("head", "current"));
  const historicalSha = sha256(validHistorical.body);
  const historicalSemantic = canvasDocSemanticHash(noteDoc("old", "history"));

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
