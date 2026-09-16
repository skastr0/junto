/**
 * Scale-benchmark fixtures.
 *
 * Two fixture kinds:
 *  - `real`      — a copy of an operator database (never opened in place).
 *  - `synthetic` — generated through the REAL product write path
 *                  (CanvasesService.write + WorkRepository.createTask /
 *                  appendMessage / publishArtifact / acceptDelivery ...), so
 *                  every row is shaped exactly as the app shapes it. There is
 *                  no hand-written INSERT anywhere in this file.
 *
 * Generation is expensive, so a synthetic database is cached under
 * JUNTO_SCALE_BENCH_DIR (default: <tmpdir>/vellum-scale-bench) keyed by the
 * spec + state schema version, and reused until the key changes.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import type { CanvasDoc, CanvasNode } from "../../src/shared/canvas";
import { IntentFactBasis, type ActorRef } from "../../src/shared/work-protocol";
import { CanvasesLive, CanvasesService } from "../../src/main/vellum-command/canvases";
import { SettingsLive, SettingsService } from "../../src/main/vellum-command/settings/service";
import { StationFleetTargetRepositoryLive } from "../../src/main/vellum-command/station/fleet-target-repository";
import { StationRepository, StationRepositoryLive } from "../../src/main/vellum-command/station/repository";
import {
  createAuthorialTaskDependencyScopeCapability,
  WorkRepository,
  WorkRepositoryLive,
} from "../../src/main/vellum-command/work/repository";
import { makeContentServiceLive } from "../../src/main/vellum-command/content/service";
import { makeInstallOpsLive } from "../../src/main/vellum-command/install-ops/engine";
import { CURRENT_STATE_SCHEMA_VERSION } from "../../src/main/vellum-command/state/migrations";
import { StateEngine } from "../../src/main/vellum-command/state/service";
import {
  mailboxMessageDeliveryId,
  mailboxMessageReadId,
} from "../../src/main/vellum-command/work/mailbox-receipts";
import { SqlRecorder, makeInstrumentedStateEngineLive } from "./harness";

export const BENCH_CANVAS_NAME = "factory";

export type ScaleSpec = {
  readonly id: string;
  readonly label: string;
  /** Agent nodes (each one a mailbox sink). */
  readonly agents: number;
  readonly taskSinks: number;
  readonly requestSinks: number;
  readonly artifactSinks: number;
  readonly boardSinks: number;
  /** Non-sink furniture so the document is not all sinks. */
  readonly regions: number;
  readonly labels: number;
  readonly messagesPerAgent: number;
  /** Fraction of messages that also carry delivered + read receipts. */
  readonly receiptFraction: number;
  readonly tasksPerTaskSink: number;
  readonly requestsPerRequestSink: number;
  readonly artifactsPerArtifactSink: number;
  readonly topicsPerBoard: number;
  readonly postsPerTopic: number;
  /** Bytes of body text per message part (real canvas mean is ~1.2KB). */
  readonly messageBytes: number;
};

export const scaleNodeCount = (spec: ScaleSpec): number =>
  spec.agents +
  spec.taskSinks +
  spec.requestSinks +
  spec.artifactSinks +
  spec.boardSinks +
  spec.regions +
  spec.labels;

export type BenchRuntimeHandle = {
  readonly runtime: ManagedRuntime.ManagedRuntime<
    CanvasesService | WorkRepository | StationRepository | SettingsService | StateEngine,
    unknown
  >;
  readonly recorder: SqlRecorder;
  readonly dispose: () => Promise<void>;
};

/**
 * Real product service graph over one database file. Mirrors the layer wiring
 * used by tests/mailbox-message-read.test.ts.
 */
export const openBenchRuntime = (options: {
  readonly root: string;
  readonly databasePath: string;
  readonly recorder?: SqlRecorder;
}): BenchRuntimeHandle => {
  const recorder = options.recorder ?? new SqlRecorder();
  mkdirSync(join(options.root, "state"), { recursive: true });
  mkdirSync(join(options.root, "canvases"), { recursive: true });
  process.env.JUNTO_CANVASES_DIR = join(options.root, "canvases");
  const stateLive = makeInstrumentedStateEngineLive(options.databasePath, recorder);
  const repositoriesLive = Layer.provideMerge(
    Layer.mergeAll(
      WorkRepositoryLive,
      StationRepositoryLive,
      StationFleetTargetRepositoryLive,
      SettingsLive,
      makeContentServiceLive({
        root: join(options.root, "content"),
        skipInlineMediaMigration: true,
      }),
    ),
    Layer.mergeAll(
      stateLive,
      makeInstallOpsLive(join(options.root, "state", "install-ops.db")),
    ),
  );
  const canvasesLive = Layer.provideMerge(CanvasesLive, repositoriesLive);
  const runtime = ManagedRuntime.make(canvasesLive as never) as BenchRuntimeHandle["runtime"];
  return {
    runtime,
    recorder,
    dispose: () => runtime.dispose(),
  };
};

const textOf = (bytes: number, seed: string): string => {
  const unit = `${seed} the factory canvas carries work as rows and the main thread pays for every one of them. `;
  return unit.repeat(Math.max(1, Math.ceil(bytes / unit.length))).slice(0, bytes);
};

const padded = (index: number): string => index.toString().padStart(6, "0");

const agentNode = (index: number): CanvasNode => ({
  id: `agent-${padded(index)}`,
  type: "text",
  x: (index % 40) * 320,
  y: Math.floor(index / 40) * 220,
  width: 260,
  height: 110,
  text: `Claude - bench agent ${index}`,
  ether: {
    entity: { kind: "agent", name: "local:claude" },
    terminal: {
      bindingId: `bench-binding-${padded(index)}`,
      label: `bench agent ${index}`,
      harness: "claude",
      launch: { kind: "harness", argv: ["claude"] },
    },
    host: "local",
  },
});

const sinkNode = (
  kind: "task" | "requests" | "artifacts" | "board",
  index: number,
  row: number,
): CanvasNode => ({
  id: `${kind}-${padded(index)}`,
  type: "text",
  x: (index % 40) * 320,
  y: 4000 + row * 220,
  width: 240,
  height: 200,
  text: kind,
  ether: { entity: { kind }, ...(kind === "task" ? { host: "local" } : {}) },
});

export const buildSyntheticDoc = (spec: ScaleSpec): CanvasDoc => {
  const nodes: Array<CanvasNode> = [];
  for (let index = 0; index < spec.agents; index += 1) nodes.push(agentNode(index));
  let row = 0;
  for (let index = 0; index < spec.taskSinks; index += 1) {
    nodes.push(sinkNode("task", index, row + Math.floor(index / 40)));
  }
  row += Math.ceil(spec.taskSinks / 40);
  for (let index = 0; index < spec.requestSinks; index += 1) {
    nodes.push(sinkNode("requests", index, row + Math.floor(index / 40)));
  }
  row += Math.ceil(spec.requestSinks / 40);
  for (let index = 0; index < spec.artifactSinks; index += 1) {
    nodes.push(sinkNode("artifacts", index, row + Math.floor(index / 40)));
  }
  row += Math.ceil(spec.artifactSinks / 40);
  for (let index = 0; index < spec.boardSinks; index += 1) {
    nodes.push(sinkNode("board", index, row));
  }
  for (let index = 0; index < spec.labels; index += 1) {
    nodes.push({
      id: `label-${padded(index)}`,
      type: "text",
      x: (index % 40) * 320,
      y: -400,
      width: 171,
      height: 54,
      text: `lane ${index}`,
      ether: { entity: { kind: "label" } },
    });
  }
  for (let index = 0; index < spec.regions; index += 1) {
    nodes.push({
      id: `region-${padded(index)}`,
      type: "group",
      x: -200,
      y: index * 2400 - 600,
      width: 13000,
      height: 2200,
      label: `region ${index}`,
      ether: { region: { hold: true } },
    });
  }
  // One edge per agent to the first task sink: the operator's canvas runs
  // roughly one edge per node, and edges are what the kernel authorizes on.
  const edges = nodes
    .filter((node) => node.id.startsWith("agent-"))
    .map((node, index) => ({
      id: `edge-${padded(index)}`,
      fromNode: node.id,
      fromSide: "right" as const,
      toNode: `task-${padded(index % Math.max(1, spec.taskSinks))}`,
      toSide: "left" as const,
    }));
  return { nodes, edges } as CanvasDoc;
};

export type FixtureShape = {
  readonly nodes: number;
  readonly edges: number;
  readonly agents: number;
  readonly sinkNodes: number;
  readonly messages: number;
  readonly tasks: number;
  readonly requests: number;
  readonly artifacts: number;
  readonly boardTopics: number;
  readonly boardPosts: number;
  readonly deliveryReceipts: number;
  readonly facts: number;
  readonly canvasDocumentRows: number;
  readonly storedDocumentBytes: number;
  readonly databaseBytes: number;
};

const COUNT_QUERIES: ReadonlyArray<readonly [keyof FixtureShape, string]> = [
  ["messages", "SELECT count(*) AS n FROM work_messages WHERE canvas_name = ?"],
  ["tasks", "SELECT count(*) AS n FROM work_tasks WHERE canvas_name = ?"],
  ["requests", "SELECT count(*) AS n FROM work_requests WHERE canvas_name = ?"],
  ["artifacts", "SELECT count(*) AS n FROM work_artifacts WHERE canvas_name = ?"],
  ["boardTopics", "SELECT count(*) AS n FROM work_board_topics WHERE canvas_name = ?"],
  ["boardPosts", "SELECT count(*) AS n FROM work_board_posts WHERE canvas_name = ?"],
  [
    "deliveryReceipts",
    "SELECT count(*) AS n FROM work_delivery_receipts WHERE delivered_canvas_name = ?",
  ],
  ["facts", "SELECT count(*) AS n FROM work_facts"],
  ["canvasDocumentRows", "SELECT count(*) AS n FROM canvas_generation_documents"],
];

export const probeShape = async (
  handle: BenchRuntimeHandle,
  canvasName: string,
  databasePath: string,
): Promise<FixtureShape> => {
  const counts = await handle.runtime.runPromise(
    Effect.gen(function* () {
      const state = yield* StateEngine;
      return yield* state.read("bench.shape", (reader) => {
        const out: Record<string, number> = {};
        for (const [key, sql] of COUNT_QUERIES) {
          const row = reader.get<{ readonly n: number }>(
            sql,
            sql.includes("?") ? [canvasName] : [],
          );
          out[key] = Number(row?.n ?? 0);
        }
        const doc = reader.get<{ readonly n: number }>(
          `
            SELECT length(body) AS n
            FROM canvas_generation_documents
            WHERE name = ?
              AND generation = (SELECT generation FROM canvas_head)
          `,
          [canvasName],
        );
        out.storedDocumentBytes = Number(doc?.n ?? 0);
        const sinks = reader.get<{ readonly n: number }>(
          `
            SELECT count(*) AS n FROM (
              SELECT node_id FROM work_tasks WHERE canvas_name = ?1
              UNION SELECT node_id FROM work_requests WHERE canvas_name = ?1
              UNION SELECT node_id FROM work_messages WHERE canvas_name = ?1
              UNION SELECT node_id FROM work_artifacts WHERE canvas_name = ?1
              UNION SELECT node_id FROM work_board_topics WHERE canvas_name = ?1
              UNION SELECT node_id FROM work_pad_meta WHERE canvas_name = ?1
            )
          `,
          [canvasName],
        );
        out.sinkNodes = Number(sinks?.n ?? 0);
        return out;
      });
    }) as never,
  ) as Record<string, number>;
  const read = await handle.runtime.runPromise(
    Effect.gen(function* () {
      const canvases = yield* CanvasesService;
      return yield* canvases.read(canvasName);
    }) as never,
  ) as { readonly doc: CanvasDoc; readonly actorRefs: ReadonlyArray<ActorRef> };
  return {
    nodes: read.doc.nodes.length,
    edges: read.doc.edges.length,
    agents: read.actorRefs.length,
    sinkNodes: counts.sinkNodes ?? 0,
    messages: counts.messages ?? 0,
    tasks: counts.tasks ?? 0,
    requests: counts.requests ?? 0,
    artifacts: counts.artifacts ?? 0,
    boardTopics: counts.boardTopics ?? 0,
    boardPosts: counts.boardPosts ?? 0,
    deliveryReceipts: counts.deliveryReceipts ?? 0,
    facts: counts.facts ?? 0,
    canvasDocumentRows: counts.canvasDocumentRows ?? 0,
    storedDocumentBytes: counts.storedDocumentBytes ?? 0,
    databaseBytes: statSync(databasePath).size,
  };
};

const authorialBasis = (generation: string, contentSha256: string) =>
  Schema.decodeUnknownSync(IntentFactBasis, { onExcessProperty: "error" })({
    kind: "authorial-intent",
    generation,
    contentSha256,
  });

const specKey = (spec: ScaleSpec): string =>
  createHash("sha256")
    .update(JSON.stringify({ spec, schema: CURRENT_STATE_SCHEMA_VERSION, version: 3 }))
    .digest("hex")
    .slice(0, 16);

export const benchCacheRoot = (): string =>
  process.env.JUNTO_SCALE_BENCH_DIR ?? join(tmpdir(), "vellum-scale-bench");

/**
 * Generate (or reuse) the synthetic database for `spec`.
 * Returns the fixture root; the database is <root>/state/vellum-command.db.
 */
export const ensureSyntheticFixture = async (
  spec: ScaleSpec,
  options: { readonly regenerate?: boolean; readonly log?: (line: string) => void } = {},
): Promise<{ readonly root: string; readonly databasePath: string; readonly generatedMs: number }> => {
  const log = options.log ?? (() => {});
  const root = join(benchCacheRoot(), `${spec.id}-${specKey(spec)}`);
  const databasePath = join(root, "state", "vellum-command.db");
  const stampPath = join(root, "fixture.json");
  if (!options.regenerate && existsSync(stampPath) && existsSync(databasePath)) {
    const stamp = JSON.parse(readFileSync(stampPath, "utf8")) as {
      readonly generatedMs: number;
    };
    log(`[fixture] reuse ${root}`);
    return { root, databasePath, generatedMs: stamp.generatedMs };
  }
  rmSync(root, { recursive: true, force: true });
  mkdirSync(join(root, "state"), { recursive: true });
  const startedAt = performance.now();
  const handle = openBenchRuntime({ root, databasePath });
  try {
    await handle.runtime.runPromise(
      Effect.gen(function* () {
        const settings = yield* SettingsService;
        yield* settings.setStationTopology({
          role: "command-center",
          hostId: "local",
          supervisedPreferred: true,
        });
        const canvases = yield* CanvasesService;
        yield* canvases.write(BENCH_CANVAS_NAME, buildSyntheticDoc(spec));
        const witness = yield* canvases.activeIntentWitness();
        const basis = authorialBasis(witness.generation, witness.contentSha256);
        const authority = yield* canvases.authorityMaterialSnapshot();
        const read = yield* canvases.read(BENCH_CANVAS_NAME);
        const repository = yield* WorkRepository;
        const actors = read.actorRefs;
        if (actors.length === 0) throw new Error("synthetic doc compiled zero actors");
        const actorAt = (index: number): ActorRef => actors[index % actors.length] as ActorRef;

        // Mailboxes.
        let written = 0;
        for (let agentIndex = 0; agentIndex < spec.agents; agentIndex += 1) {
          const nodeId = `agent-${padded(agentIndex)}`;
          const sink = { canvasName: BENCH_CANVAS_NAME, nodeId };
          const sender = actorAt(agentIndex + 1);
          for (let index = 0; index < spec.messagesPerAgent; index += 1) {
            const messageId = `msg-${padded(agentIndex)}-${padded(index)}`;
            yield* repository.appendMessage({
              sink,
              basis,
              message: {
                messageId,
                role: index % 2 === 0 ? "user" : "agent",
                parts: [
                  {
                    kind: "text",
                    text: textOf(spec.messageBytes, `${nodeId}#${index}`),
                  },
                ],
              },
              sentBy: sender,
              destination: { kind: "mailbox" },
            });
            if (index / Math.max(1, spec.messagesPerAgent) < spec.receiptFraction) {
              const acceptedAt = new Date(1767225600000 + index * 1000).toISOString();
              yield* repository.acceptDelivery({
                sink,
                basis,
                receipt: {
                  deliveryId: mailboxMessageDeliveryId(BENCH_CANVAS_NAME, nodeId, messageId),
                  deliveredItem: { kind: "message", itemId: messageId, sink },
                  actor: actorAt(agentIndex),
                  acceptedAt,
                },
              });
              yield* repository.acceptDelivery({
                sink,
                basis,
                receipt: {
                  deliveryId: mailboxMessageReadId(BENCH_CANVAS_NAME, nodeId, messageId),
                  deliveredItem: { kind: "message", itemId: messageId, sink },
                  actor: actorAt(agentIndex),
                  acceptedAt,
                },
              });
            }
            written += 1;
            if (written % 5000 === 0) {
              log(`[fixture] ${spec.id}: ${written} messages`);
            }
          }
        }

        // Task sinks.
        for (let sinkIndex = 0; sinkIndex < spec.taskSinks; sinkIndex += 1) {
          const sink = {
            canvasName: BENCH_CANVAS_NAME,
            nodeId: `task-${padded(sinkIndex)}`,
          };
          const dependencyScope =
            createAuthorialTaskDependencyScopeCapability({
              authority,
              authoringSink: sink,
            });
          for (let index = 0; index < spec.tasksPerTaskSink; index += 1) {
            const taskId = `task-${padded(sinkIndex)}-${padded(index)}`;
            yield* repository.createTask({
              sink,
              basis,
              dependencyScope,
              task: {
                id: taskId,
                state: "submitted",
                history: [
                  {
                    messageId: `brief-${taskId}`,
                    role: "user",
                    parts: [
                      { kind: "text", text: textOf(spec.messageBytes, taskId) },
                    ],
                  },
                ],
              },
            });
          }
          log(`[fixture] ${spec.id}: task sink ${sinkIndex + 1}/${spec.taskSinks}`);
        }

        // Request sinks.
        for (let sinkIndex = 0; sinkIndex < spec.requestSinks; sinkIndex += 1) {
          const sink = {
            canvasName: BENCH_CANVAS_NAME,
            nodeId: `requests-${padded(sinkIndex)}`,
          };
          for (let index = 0; index < spec.requestsPerRequestSink; index += 1) {
            const raiser = actorAt(sinkIndex);
            const requestId = `req-${padded(sinkIndex)}-${padded(index)}`;
            yield* repository.createRequest({
              sink,
              basis,
              raisedBy: raiser,
              request: {
                id: requestId,
                state: "input-required",
                claimedBy: raiser.seatId,
                history: [
                  {
                    messageId: `brief-${requestId}`,
                    role: "agent",
                    parts: [
                      { kind: "text", text: textOf(spec.messageBytes, requestId) },
                    ],
                  },
                ],
              },
            });
          }
        }

        // Artifact sinks.
        for (let sinkIndex = 0; sinkIndex < spec.artifactSinks; sinkIndex += 1) {
          const sink = {
            canvasName: BENCH_CANVAS_NAME,
            nodeId: `artifacts-${padded(sinkIndex)}`,
          };
          for (let index = 0; index < spec.artifactsPerArtifactSink; index += 1) {
            const artifactId = `art-${padded(sinkIndex)}-${padded(index)}`;
            yield* repository.publishArtifact({
              sink,
              basis,
              publishedBy: actorAt(sinkIndex),
              artifact: {
                artifactId,
                name: `${artifactId}.md`,
                parts: [
                  { kind: "text", text: textOf(spec.messageBytes, artifactId) },
                ],
              },
            });
          }
        }

        // Board sinks.
        for (let sinkIndex = 0; sinkIndex < spec.boardSinks; sinkIndex += 1) {
          const sink = {
            canvasName: BENCH_CANVAS_NAME,
            nodeId: `board-${padded(sinkIndex)}`,
          };
          for (let index = 0; index < spec.topicsPerBoard; index += 1) {
            const topicId = `topic-${padded(sinkIndex)}-${padded(index)}`;
            const openedAt = new Date(1767225600000 + index * 60000).toISOString();
            const author = { kind: "operator" as const, label: "operator" };
            yield* repository.createBoardTopic({
              sink,
              basis,
              createdBy: author,
              topic: {
                topicId,
                title: `bench topic ${index}`,
                state: "open",
                openedBy: author,
                openedAt,
                postCount: 0,
                lastActivityAt: openedAt,
                parts: [{ kind: "text", text: textOf(spec.messageBytes, topicId) }],
              },
            });
            for (let postIndex = 0; postIndex < spec.postsPerTopic; postIndex += 1) {
              yield* repository.appendBoardPost({
                sink,
                basis,
                createdBy: author,
                post: {
                  postId: `post-${topicId}-${padded(postIndex)}`,
                  topicId,
                  author,
                  parts: [
                    {
                      kind: "text",
                      text: textOf(spec.messageBytes, `${topicId}#${postIndex}`),
                    },
                  ],
                  position: postIndex + 1,
                  createdAt: new Date(1767225600000 + postIndex * 1000).toISOString(),
                },
              });
            }
          }
        }
      }) as never,
    );
  } finally {
    await handle.dispose();
  }
  const generatedMs = Math.round(performance.now() - startedAt);
  writeFileSync(
    stampPath,
    `${JSON.stringify({ spec, schemaVersion: CURRENT_STATE_SCHEMA_VERSION, generatedMs }, null, 2)}\n`,
  );
  log(`[fixture] ${spec.id}: generated in ${(generatedMs / 1000).toFixed(1)}s`);
  return { root, databasePath, generatedMs };
};

/** Copy an operator database into a scratch root; the original is never opened. */
export const copyRealFixture = (
  sourcePath: string,
  root: string,
): { readonly root: string; readonly databasePath: string } => {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(join(root, "state"), { recursive: true });
  const databasePath = join(root, "state", "vellum-command.db");
  copyFileSync(sourcePath, databasePath);
  for (const suffix of ["-wal", "-shm"]) {
    if (existsSync(`${sourcePath}${suffix}`)) {
      copyFileSync(`${sourcePath}${suffix}`, `${databasePath}${suffix}`);
    }
  }
  return { root, databasePath };
};
