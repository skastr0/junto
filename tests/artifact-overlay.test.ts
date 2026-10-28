/**
 * Read-your-writes for artifacts on a real database (plan 0.10, 02): this
 * machine's queued artifact commands over the ruled state it holds. On a
 * head whose body rode by content reference and is not pulled here, a
 * command waits base_not_pulled, with no preview on the stale state, and so
 * does what builds on it; on a held head it is previewed by the domain.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ArtifactOp, type ArtifactVersion, emptyBody } from "../src/shared/artifact";
import type { InstallationId } from "../src/shared/installation-id";
import { asNodeId } from "../src/shared/physics/schema";
import { mintItemId, mintOpId, type ItemId, type OpId, type ResourceActor, type ResourceCommand } from "../src/shared/resource-command";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { ContentService, makeContentServiceLive } from "../src/main/junto/content/service";
import { makeInstallOpsLive } from "../src/main/junto/install-ops/engine";
import { writeRuling } from "../src/main/junto/work/resource-rulings";
import { RulingRecorder } from "../src/main/junto/work/ruling-recorder";
import { ArtifactRepository, ArtifactRepositoryLive, artifactBodyRef, projectArtifactFacts } from "../src/main/junto/work/artifact-repository";

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
  root = await mkdtemp(join(tmpdir(), "junto-artifact-overlay-"));
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
const node = asNodeId("artifacts-1");
const mini = "mini" as InstallationId;
const operator: ResourceActor = { kind: "operator" };
const v = (n: number) => n as ArtifactVersion;
const body = emptyBody("document");

const command = (op: ArtifactOp, itemId: ItemId, after: ReadonlyArray<OpId> = []): ResourceCommand<ArtifactOp> => ({
  opId: mintOpId(),
  canvasName: canvas,
  actor: operator,
  target: { kind: "artifact", nodeId: node, itemId },
  basis: null,
  after,
  op,
});

const edit = (id: ItemId, base: number, after: ReadonlyArray<OpId> = []) =>
  command({ op: "edit", edit: { kind: "replace", baseVersion: v(base), body } }, id, after);

const overlayOf = (queued: ReadonlyArray<ResourceCommand<ArtifactOp>>) =>
  runtime.runPromise(Effect.gen(function* () {
    return yield* (yield* ArtifactRepository).overlay(canvas, mini, queued, { inReach: () => true });
  }));

/** An artifact as the editing machine ruled it: created, then edited to `version` with a body that rides by ref. */
const ruledHere = async (version: 1 | 2) => {
  const id = mintItemId();
  const created = {
    fact: "artifact.created" as const,
    bodyRef: artifactBodyRef(body),
    body,
    artifact: { artifactId: id, nodeId: node, type: "document" as const, title: "Remote", version: v(1), createdBy: operator, updatedAt: 1, archived: false, taskIds: [], labels: [] },
  };
  const edited = { fact: "artifact.edited" as const, artifactId: id, version: v(2), bodyRef: artifactBodyRef({ type: "document", markdown: "from afar" }), author: operator, at: 2 };
  await runtime.runPromise(Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // A ruling's facts fold in the ruling's transaction, as the exchange does.
    yield* sql.withTransaction(projectArtifactFacts(sql, canvas, mintOpId(), version === 1 ? [created] : [created, edited], () => undefined));
  }));
  return id;
};

describe("the artifact overlay", () => {
  it("previews a command on a head whose body is held here", async () => {
    const id = await ruledHere(1);
    const next = edit(id, 1);
    expect(await overlayOf([next])).toEqual([{ opId: next.opId, status: "pending" }]);
  });

  it("names the domain's refusal on a held head, as before", async () => {
    const id = await ruledHere(1);
    const stale = edit(id, 7);
    const [entry] = await overlayOf([stale]);
    expect(entry).toMatchObject({ opId: stale.opId, status: "at_risk", refusal: {} });
    expect(entry?.waiting).toBeUndefined();
  });

  it("waits on a head behind an edit whose body is not pulled, and so does what builds on it", async () => {
    const id = await ruledHere(2);
    const first = edit(id, 2);
    const builds = edit(id, 3, [first.opId]);
    const elsewhere = command({ op: "create", title: "Fresh", body }, mintItemId());
    expect(await overlayOf([first, builds, elsewhere])).toEqual([
      { opId: first.opId, status: "at_risk", waiting: "base_not_pulled", root: first.opId },
      { opId: builds.opId, status: "at_risk", waiting: "base_not_pulled", root: first.opId },
      { opId: elsewhere.opId, status: "pending" },
    ]);
  });
});
