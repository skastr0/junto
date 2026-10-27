/**
 * Body backlinks (0.11 L1): a link inside an artifact's body is projected as
 * it is written, in the ruling's own transaction, and read back from the head
 * bodies. Proven on the real state engine, the production DDL and the ruler
 * this machine runs.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime, Option } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ArtifactEdit, ArtifactOp, ArtifactVersion } from "../src/shared/artifact";
import type { InstallationId } from "../src/shared/installation-id";
import { asNodeId, type Canvas, type Node } from "../src/shared/model";
import { mentionHref } from "../src/shared/mention";
import {
  mintItemId,
  mintOpId,
  type ItemId,
  type OpId,
  type ResourceActor,
  type ResourceCommand,
  type RulingContext,
} from "../src/shared/resource-command";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { ContentService, makeContentServiceLive } from "../src/main/junto/content/service";
import { makeInstallOpsLive } from "../src/main/junto/install-ops/engine";
import { writeRuling } from "../src/main/junto/work/resource-rulings";
import { RulingRecorder } from "../src/main/junto/work/ruling-recorder";
import { ArtifactRepository, ArtifactRepositoryLive } from "../src/main/junto/work/artifact-repository";
import { linkedFromBodies, rebuildBodyLinks } from "../src/main/junto/work/body-links";
import { runArtifactLinksBackfill } from "../src/main/junto/work/artifact-links-backfill";
import { InstallOpsService } from "../src/main/junto/install-ops/service";
import { BACKFILL_ARTIFACT_LINKS_V1 } from "../src/main/junto/install-ops/engine";
import { seat } from "./support/model-nodes";

const recorder = Layer.effect(
  RulingRecorder,
  Effect.map(SqlClient.SqlClient, (sql) =>
    RulingRecorder.of({
      record: (input) =>
        writeRuling(sql, { canvas: input.canvasName, writer: input.writer, command: input.command, record: input.record }).pipe(
          Effect.asVoid,
          Effect.orDie,
        ),
    })),
);

let root: string;
let runtime: ManagedRuntime.ManagedRuntime<ArtifactRepository | ContentService | SqlClient.SqlClient | InstallOpsService, unknown>;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "junto-body-links-"));
  const content = makeContentServiceLive({ root: join(root, "content"), skipInlineMediaMigration: true });
  runtime = ManagedRuntime.make(
    Layer.provideMerge(Layer.provide(ArtifactRepositoryLive, recorder), content).pipe(
      Layer.provideMerge(Layer.mergeAll(makeStateEngineLive(join(root, "junto.db")), makeInstallOpsLive(join(root, "install-ops.db")))),
    ),
  );
});

afterEach(async () => {
  await runtime.dispose();
  await rm(root, { recursive: true, force: true });
});

const canvas = "factory";
const SHELF = asNodeId("artifacts-shelf");
const OTHER_SHELF = asNodeId("artifacts-other");
const BOARD = asNodeId("task-board");
const mini = "mini" as InstallationId;
const operator: ResourceActor = { kind: "operator" };
const everywhere: RulingContext = { inReach: () => true };
const v = (n: number) => n as ArtifactVersion;

/** The canvas the read joins titles and times from: two shelves, a board and a seat. */
const topology: Canvas = {
  name: canvas,
  nodes: new Map<ReturnType<typeof asNodeId>, Node>([
    [SHELF, { id: SHELF, kind: "artifacts", label: "Shelf", x: 0, y: 0, width: 200, height: 160, z: 0 } as unknown as Node],
    [OTHER_SHELF, { id: OTHER_SHELF, kind: "artifacts", label: "Other", x: 300, y: 0, width: 200, height: 160, z: 0 } as unknown as Node],
    [BOARD, { id: BOARD, kind: "task", label: "Board", x: 0, y: 300, width: 200, height: 160, z: 0 } as unknown as Node],
    [asNodeId("agent-a"), seat(asNodeId("agent-a"), { x: 600, y: 0 })],
  ]),
  wires: new Map(),
} as unknown as Canvas;

const command = (op: ArtifactOp, itemId: ItemId, nodeId = SHELF): ResourceCommand<ArtifactOp> => ({
  opId: mintOpId(),
  canvasName: canvas,
  actor: operator,
  target: { kind: "artifact", nodeId, itemId },
  basis: null,
  after: [],
  op,
});

const submit = (cmd: ResourceCommand<ArtifactOp>) =>
  runtime.runPromise(Effect.flatMap(ArtifactRepository, (repo) => repo.submit(mini, cmd, everywhere)));

const link = (nodeId: ReturnType<typeof asNodeId>, artifactId: ItemId, label: string): string =>
  `[${label}](${mentionHref({ kind: "artifact", nodeId, artifactId }, canvas)})`;

const createDocument = async (title: string, markdown: string, nodeId = SHELF): Promise<ItemId> => {
  const id = mintItemId();
  const outcome = await submit(command({ op: "create", title, body: { type: "document", markdown } }, id, nodeId));
  expect(outcome).toMatchObject({ kind: "applied", version: 1 });
  return id;
};

const editDocument = async (id: ItemId, base: number, markdown: string): Promise<void> => {
  const edit: ArtifactEdit = { kind: "replace", baseVersion: v(base), body: { type: "document", markdown } };
  expect(await submit(command({ op: "edit", edit }, id))).toMatchObject({ kind: "applied" });
};

const read = (target: { readonly nodeId: ReturnType<typeof asNodeId>; readonly artifactId: ItemId }) =>
  runtime.runPromise(
    Effect.gen(function* () {
      return yield* linkedFromBodies(yield* SqlClient.SqlClient, topology, canvas, target);
    }),
  );

describe("body backlinks", () => {
  it("lists the artifact whose body links one, with its title, type and the line", async () => {
    const budget = await createDocument("Budget", "# Budget\nspent");
    const plan = await createDocument("Plan", `# Plan\nThe ${link(SHELF, budget, "Budget")} is fixed.`);
    const found = await read({ nodeId: SHELF, artifactId: budget });
    expect(found).toEqual([
      expect.objectContaining({
        source: { nodeId: SHELF, artifactId: plan },
        title: "Plan",
        type: "document",
        line: `The ${link(SHELF, budget, "Budget")} is fixed.`,
      }),
    ]);
    expect(typeof found[0]?.at).toBe("number");
  });

  it("takes a link out when an edit takes it out of the body", async () => {
    const budget = await createDocument("Budget", "spent");
    const plan = await createDocument("Plan", `The ${link(SHELF, budget, "Budget")} is fixed.`);
    expect(await read({ nodeId: SHELF, artifactId: budget })).toHaveLength(1);
    await editDocument(plan, 1, "The budget is fixed.");
    expect(await read({ nodeId: SHELF, artifactId: budget })).toEqual([]);
  });

  it("counts no link to a task, and none from an archived artifact", async () => {
    const budget = await createDocument("Budget", "spent");
    const seatLink = `A seat ${link(asNodeId("agent-a"), mintItemId(), "agent-a")}, a task ${link(BOARD, mintItemId(), "#42")}.`;
    const doc = await createDocument("Notes", seatLink);
    expect(await read({ nodeId: SHELF, artifactId: budget })).toEqual([]);
    void doc;

    const plan = await createDocument("Plan", `The ${link(SHELF, budget, "Budget")} is fixed.`);
    expect(await read({ nodeId: SHELF, artifactId: budget })).toHaveLength(1);
    expect(await submit(command({ op: "archive" }, plan))).toMatchObject({ kind: "applied" });
    expect(await read({ nodeId: SHELF, artifactId: budget })).toEqual([]);
  });

  it("keeps a link to another shelf's artifact, read from that shelf", async () => {
    const other = await createDocument("Other one", "text", OTHER_SHELF);
    const plan = await createDocument("Plan", `See ${link(OTHER_SHELF, other, "Other one")}.`);
    const found = await read({ nodeId: OTHER_SHELF, artifactId: other });
    expect(found.map((row) => row.source.artifactId)).toEqual([plan]);
  });

  it("reads one row per target when a body names it twice", async () => {
    const budget = await createDocument("Budget", "spent");
    await createDocument("Plan", `The ${link(SHELF, budget, "Budget")} and again the ${link(SHELF, budget, "Budget")}.`);
    expect(await read({ nodeId: SHELF, artifactId: budget })).toHaveLength(1);
  });

  it("reads nothing for a target that is no artifact on the canvas", async () => {
    const ghost = mintItemId();
    expect(await read({ nodeId: asNodeId("agent-a"), artifactId: ghost })).toEqual([]);
    expect(await read({ nodeId: BOARD, artifactId: ghost })).toEqual([]);
  });

  it("rebuilds every row from the bodies, as a backfill does, and writes the same rows", async () => {
    const budget = await createDocument("Budget", "spent");
    const plan = await createDocument("Plan", `The ${link(SHELF, budget, "Budget")} is fixed.`);
    const before = await read({ nodeId: SHELF, artifactId: budget });
    expect(before).toHaveLength(1);
    // Something lost the rows, as an install that predates the projection did.
    await runtime.runPromise(
      Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe("DELETE FROM work_artifact_links", [])),
    );
    expect(await read({ nodeId: SHELF, artifactId: budget })).toEqual([]);
    const written = await runtime.runPromise(
      Effect.flatMap(SqlClient.SqlClient, (sql) => rebuildBodyLinks(sql, canvas)),
    );
    expect(written).toBe(1);
    expect(await read({ nodeId: SHELF, artifactId: budget })).toEqual(before);
    expect((await read({ nodeId: SHELF, artifactId: budget }))[0]?.source.artifactId).toBe(plan);
  });

  it("holds the head's body in the table at the version that wrote it", async () => {
    const budget = await createDocument("Budget", "spent");
    const plan = await createDocument("Plan", `The ${link(SHELF, budget, "Budget")} is fixed.`);
    await editDocument(plan, 1, `The ${link(SHELF, budget, "Budget")} is fixed, twice over.`);
    const rows = await runtime.runPromise(
      Effect.flatMap(SqlClient.SqlClient, (sql) =>
        sql.unsafe<{ source_version: number }>(
          "SELECT source_version FROM work_artifact_links WHERE canvas_name = ? AND source_artifact_id = ?",
          [canvas, plan],
        ),
      ),
    );
    expect(rows.map((row) => row.source_version)).toEqual([2]);
    expect(Option.isSome(await runtime.runPromise(Effect.flatMap(ArtifactRepository, (repo) => repo.head(canvas, budget))))).toBe(true);
  });
});

describe("the backfill over bodies written before the projection", () => {
  it("projects every held body once at boot, and says so in install-ops", async () => {
    const budget = await createDocument("Budget", "spent");
    await createDocument("Plan", `The ${link(SHELF, budget, "Budget")} is fixed.`);
    // An install from before the step: the bodies are here, the rows are not,
    // and the walk never ran (the layer's own run happened before these bodies
    // existed, so its marker is reopened as an install that lacked it would be).
    await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe("DELETE FROM work_artifact_links", [])));
    await runtime.runPromise(Effect.flatMap(InstallOpsService, (ops) => ops.reopenPending(BACKFILL_ARTIFACT_LINKS_V1)));
    expect(await read({ nodeId: SHELF, artifactId: budget })).toEqual([]);

    const first = await runtime.runPromise(
      Effect.gen(function* () {
        return yield* runArtifactLinksBackfill({ sql: yield* SqlClient.SqlClient, installOps: yield* InstallOpsService });
      }),
    );
    expect(first).toEqual({ status: "complete", rows: 1 });
    expect(await read({ nodeId: SHELF, artifactId: budget })).toHaveLength(1);

    // Its marker is complete, so a second boot writes nothing again.
    const second = await runtime.runPromise(
      Effect.gen(function* () {
        return yield* runArtifactLinksBackfill({ sql: yield* SqlClient.SqlClient, installOps: yield* InstallOpsService });
      }),
    );
    expect(second).toEqual({ status: "already-complete", rows: 1 });
    expect(await read({ nodeId: SHELF, artifactId: budget })).toHaveLength(1);
  });
});
