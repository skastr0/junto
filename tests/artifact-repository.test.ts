import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime, Option } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ArtifactEdit, type ArtifactOp, type ArtifactVersion, emptyBody } from "../src/shared/artifact";
import type { InstallationId } from "../src/shared/installation-id";
import { asNodeId } from "../src/shared/physics/schema";
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
import {
  ArtifactRepository,
  ArtifactRepositoryLive,
  type ArtifactSubmitOutcome,
  artifactBodyRef,
  projectArtifactFacts,
} from "../src/main/junto/work/artifact-repository";

// The ruling's row as the recorder writes it; its fact row needs a canvas this machine edits (tests/ruling-recorder.test.ts).
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
let runtime: ManagedRuntime.ManagedRuntime<ArtifactRepository | ContentService | SqlClient.SqlClient, unknown>;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "junto-artifacts-"));
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

type Repo = ArtifactRepository["Service"];
const withRepo = <A, E>(use: (repo: Repo) => Effect.Effect<A, E>) =>
  runtime.runPromise(
    Effect.gen(function* () {
      return yield* use(yield* ArtifactRepository);
    }),
  );

const canvas = "factory";
const node = asNodeId("artifacts-1");
const mini = "mini" as InstallationId;
const operator: ResourceActor = { kind: "operator" };
const everywhere: RulingContext = { inReach: () => true };
const nowhere: RulingContext = { inReach: () => false };
const v = (n: number) => n as ArtifactVersion;

const command = (
  op: ArtifactOp,
  itemId: ItemId,
  extra: { opId?: OpId; after?: ReadonlyArray<OpId>; nodeId?: string } = {},
): ResourceCommand<ArtifactOp> => ({
  opId: extra.opId ?? mintOpId(),
  canvasName: canvas,
  actor: operator,
  target: { kind: "artifact", nodeId: extra.nodeId === undefined ? node : asNodeId(extra.nodeId), itemId },
  basis: null,
  after: extra.after ?? [],
  op,
});

const sql = (statement: (client: SqlClient.SqlClient) => Effect.Effect<unknown, unknown>) =>
  runtime.runPromise(
    Effect.gen(function* () {
      return yield* statement(yield* SqlClient.SqlClient);
    }),
  );

const failure = <A, E>(use: (repo: Repo) => Effect.Effect<A, E>) =>
  runtime.runPromise(
    Effect.gen(function* () {
      return yield* Effect.flip(use(yield* ArtifactRepository));
    }),
  );

const submit = (cmd: ResourceCommand<ArtifactOp>, context: RulingContext = everywhere) =>
  withRepo((repo) => repo.submit(mini, cmd, context));

const sheetCell = (base: number, columnId: string, value: string): ArtifactEdit => ({
  kind: "patch",
  type: "sheet",
  baseVersion: v(base),
  patches: [{ op: "cell", rowId: "r1", columnId, value }],
});

const reason = (outcome: ArtifactSubmitOutcome) =>
  outcome.kind === "applied" ? "applied" : String(outcome.error.details?.reason);

const createSheet = async (title = "Budget") => {
  const id = mintItemId();
  const outcome = await submit(command({ op: "create", title, body: emptyBody("sheet") }, id));
  expect(outcome).toMatchObject({ kind: "applied", artifactId: id, version: 1 });
  return id;
};

describe("ArtifactRepository", () => {
  it("creates at version 1 and reads the head back with its body", async () => {
    const id = await createSheet();
    const head = await withRepo((repo) => repo.head(canvas, id));
    expect(Option.isSome(head)).toBe(true);
    const read = Option.getOrThrow(head);
    expect(read.artifact).toMatchObject({ artifactId: id, nodeId: node, type: "sheet", version: 1, archived: false });
    expect(read.artifact.createdBy).toEqual(operator);
    expect(read.body).toEqual(emptyBody("sheet"));
  });

  it("writes one version per edit and keeps every past body", async () => {
    const id = await createSheet();
    expect(await submit(command({ op: "edit", edit: sheetCell(1, "c1", "a") }, id))).toMatchObject({ version: 2 });
    expect(await submit(command({ op: "edit", edit: sheetCell(2, "c1", "b") }, id))).toMatchObject({ version: 3 });
    const [past, history] = await withRepo((repo) =>
      Effect.all([repo.body(canvas, id, v(2)), repo.history(canvas, id, { limit: 10 })]),
    );
    const body = Option.getOrThrow(past);
    expect(body?.type === "sheet" && body.grid.rows[0]?.cells).toEqual({ c1: "a" });
    expect(history.versions.map((entry) => entry.version)).toEqual([3, 2, 1]);
    expect(history.versions[2]?.edit).toBeUndefined();
    expect(history.versions[0]?.edit).toEqual(sheetCell(2, "c1", "b"));
    expect(history.more).toBe(false);
  });

  it("pages history back with before", async () => {
    const id = await createSheet();
    await submit(command({ op: "edit", edit: sheetCell(1, "c1", "a") }, id));
    await submit(command({ op: "edit", edit: sheetCell(2, "c1", "b") }, id));
    const page = await withRepo((repo) => repo.history(canvas, id, { limit: 1, before: v(3) }));
    expect(page.versions.map((entry) => entry.version)).toEqual([2]);
    expect(page.more).toBe(true);
  });

  it("rebases a patch on an old base from the stored log, and refuses a same-cell one", async () => {
    const id = await createSheet();
    await submit(command({ op: "edit", edit: sheetCell(1, "c1", "theirs") }, id));
    expect(reason(await submit(command({ op: "edit", edit: sheetCell(1, "c2", "mine") }, id)))).toBe("applied");
    const clash = await submit(command({ op: "edit", edit: sheetCell(1, "c1", "mine") }, id));
    expect(clash.kind === "refused" && clash.error.details).toMatchObject({ reason: "rebase_conflict", expected: 3 });
  });

  it("answers a retried opId with its first ruling and writes nothing", async () => {
    const id = await createSheet();
    const opId = mintOpId();
    const first = await submit(command({ op: "edit", edit: sheetCell(1, "c1", "a") }, id, { opId }));
    const again = await submit(command({ op: "edit", edit: sheetCell(1, "c1", "a") }, id, { opId }));
    expect(first.kind === "applied" && first.facts.map((fact) => fact.fact)).toEqual(["artifact.edited"]);
    expect(again).toEqual({ ...first, facts: [] });
    const history = await withRepo((repo) => repo.history(canvas, id, { limit: 10 }));
    expect(history.versions).toHaveLength(2);
  });

  it("keeps a refusal for a retry too, and refuses what builds on it", async () => {
    const id = await createSheet();
    const opId = mintOpId();
    const refused = await submit(command({ op: "edit", edit: sheetCell(7, "c1", "x") }, id, { opId }));
    expect(refused.kind).toBe("refused");
    expect(await submit(command({ op: "edit", edit: sheetCell(7, "c1", "x") }, id, { opId }))).toEqual(refused);
    const dependent = await submit(command({ op: "retitle", title: "After" }, id, { after: [opId] }));
    expect(dependent.kind === "refused" && dependent.error.details).toMatchObject({ reason: "depends_on_refused", from: opId });
  });

  it("refuses out of reach before the domain", async () => {
    const outcome = await submit(command({ op: "create", title: "X", body: emptyBody("document") }, mintItemId()), nowhere);
    expect(reason(outcome)).toBe("not_in_reach");
  });

  it("lists a node's heads newest change first, archived apart, by type, with more", async () => {
    const a = await createSheet("A");
    const b = await createSheet("B");
    const doc = mintItemId();
    await submit(command({ op: "create", title: "Notes", body: emptyBody("document") }, doc));
    await submit(command({ op: "archive" }, b));
    await submit(command({ op: "create", title: "Elsewhere", body: emptyBody("document") }, mintItemId(), { nodeId: "artifacts-2" }));
    const list = (query: Parameters<Repo["list"]>[1]) =>
      withRepo((repo) => repo.list(canvas, query));
    const open = await list({ nodeIds: [node], archived: false, limit: 10 });
    expect(open.artifacts.map((artifact) => artifact.artifactId).sort()).toEqual([a, doc].sort());
    expect((await list({ nodeIds: [node], archived: true, limit: 10 })).artifacts.map((x) => x.artifactId)).toEqual([b]);
    expect((await list({ nodeIds: [node], archived: false, type: "document", limit: 10 })).artifacts.map((x) => x.title)).toEqual(["Notes"]);
    const cut = await list({ nodeIds: [node], archived: false, limit: 1 });
    expect(cut.artifacts).toHaveLength(1);
    expect(cut.more).toBe(true);
    expect((await list({ nodeIds: [], archived: false, limit: 10 })).artifacts).toEqual([]);
  });

  it("refuses an edit on an archived artifact until it is restored", async () => {
    const id = await createSheet();
    await submit(command({ op: "archive" }, id));
    expect(reason(await submit(command({ op: "edit", edit: sheetCell(1, "c1", "x") }, id)))).toBe("invalid_transition");
    expect(reason(await submit(command({ op: "restore" }, id)))).toBe("applied");
    expect(reason(await submit(command({ op: "edit", edit: sheetCell(1, "c1", "x") }, id)))).toBe("applied");
  });

  it("refuses a head that no longer decodes instead of reading it as absent", async () => {
    const id = await createSheet();
    await sql((client) => client`UPDATE artifact_heads SET created_by_json = '{"kind":"nobody"}' WHERE artifact_id = ${id}`);
    expect(await failure((repo) => repo.head(canvas, id))).toMatchObject({ _tag: "ArtifactPersistenceError" });
    const again = await failure((repo) =>
      repo.submit(mini, command({ op: "create", title: "Again", body: emptyBody("sheet") }, id), everywhere),
    );
    expect(again.message).toContain("does not decode");
  });

  it("refuses a stored ruling that no longer decodes instead of ruling the op again", async () => {
    const id = await createSheet();
    const opId = mintOpId();
    await sql((client) => client`
      INSERT INTO resource_rulings (canvas_name, writer, op_id, kind, ruling_json, actor_kind)
      VALUES (${canvas}, ${mini}, ${opId}, 'applied', '{}', 'operator')`);
    const again = await failure((repo) =>
      repo.submit(mini, command({ op: "edit", edit: sheetCell(1, "c1", "a") }, id, { opId }), everywhere),
    );
    expect(again.message).toContain("does not decode");
  });

  it("puts each version's canonical bytes in the content store, owned by that version", async () => {
    const id = await createSheet();
    await submit(command({ op: "edit", edit: sheetCell(1, "c1", "a") }, id));
    const refs = await runtime.runPromise(
      Effect.gen(function* () {
        const repo = yield* ArtifactRepository;
        const store = yield* ContentService;
        const head = Option.getOrThrow(yield* repo.head(canvas, id));
        return { head, rows: yield* store.listRefs(head.bodyRef.sha256) };
      }),
    );
    expect(refs.head.bodyRef).toEqual(artifactBodyRef(refs.head.body!));
    expect(refs.rows.map((row) => row.owner)).toContainEqual({ kind: "artifact", canvasName: canvas, nodeId: node, recordId: `${id}@2` });
  });

  it("folds a version whose bytes are not here as pending, and reads it once the store holds them", async () => {
    const id = mintItemId();
    const body = emptyBody("document");
    const bodyRef = artifactBodyRef({ type: "document", markdown: "from afar" });
    await sql((client) =>
      projectArtifactFacts(client, canvas, mintOpId(), [
        {
          fact: "artifact.created",
          bodyRef: artifactBodyRef(body),
          body,
          artifact: {
            artifactId: id,
            nodeId: node,
            type: "document",
            title: "Remote",
            version: v(1),
            createdBy: operator,
            updatedAt: 1,
            archived: false,
            taskIds: [],
          },
        },
        { fact: "artifact.edited", artifactId: id, version: v(2), bodyRef, author: operator, at: 2 },
      ], () => undefined),
    );
    const pending = await withRepo((repo) => repo.head(canvas, id));
    expect(Option.getOrThrow(pending).body).toBeNull();
    // An edit on a pending head is refused, never ruled on a guess.
    const refused = await submit(command({ op: "edit", edit: { kind: "replace", baseVersion: v(2), body } }, id));
    expect(refused).toMatchObject({ kind: "refused", error: { details: { reason: "not_available" } } });
    await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* ContentService;
        yield* store.put({ source: JSON.stringify({ markdown: "from afar", type: "document" }), mediaType: "application/json" });
      }),
    );
    const arrived = await withRepo((repo) => repo.body(canvas, id, v(2)));
    expect(Option.getOrThrow(arrived)).toEqual({ type: "document", markdown: "from afar" });
  });
});
