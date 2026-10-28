/**
 * Artifact labels (0.11, 03, T1): the word's canonical form, the ruler's op,
 * the fact that crosses machines, and the store rows behind them. Proven on
 * the real state engine, the production DDL and the same fold the ruler and a
 * replica run, twice, so a receiving machine normalises nothing.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decodeArtifact, type ArtifactOp, type ArtifactVersion } from "../src/shared/artifact";
import { artifactLabelsMatch, artifactLabelOf, artifactLabelsOf, type ArtifactLabel } from "../src/shared/artifact-labels";
import { artifactDomain, ArtifactFact } from "../src/shared/artifact-domain";
import type { InstallationId } from "../src/shared/installation-id";
import { asNodeId } from "../src/shared/model";
import {
  mintItemId,
  mintOpId,
  type ItemId,
  type ResourceActor,
  type ResourceCommand,
  type RulingContext,
} from "../src/shared/resource-command";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { makeInstallOpsLive } from "../src/main/junto/install-ops/engine";
import { ContentService, makeContentServiceLive } from "../src/main/junto/content/service";
import { ArtifactRepository, ArtifactRepositoryLive, projectArtifactFacts } from "../src/main/junto/work/artifact-repository";
import { RulingRecorder } from "../src/main/junto/work/ruling-recorder";
import { writeRuling } from "../src/main/junto/work/resource-rulings";

const label = (raw: string): ArtifactLabel => {
  const folded = artifactLabelOf(raw);
  if (folded === undefined) throw new Error(`refused: ${raw}`);
  return folded;
};

describe("a label's canonical form", () => {
  it("folds case and trims, and reads a level with its slash", () => {
    expect(label("  Release  ")).toBe("release");
    expect(label("Project/Junto/Release")).toBe("project/junto/release");
    expect(label("a-b_c 1")).toBe("a-b_c 1");
  });

  it("refuses a leading or trailing slash, a double slash, an empty label and over 40 characters", () => {
    for (const bad of ["/a", "a/", "a//b", "", " ", "a".repeat(41)]) {
      expect(artifactLabelOf(bad), bad).toBeUndefined();
    }
    expect(artifactLabelOf("a".repeat(40))).toBe("a".repeat(40));
    // A space at either end is folded away, not kept: it never reaches a row.
    expect(artifactLabelOf(" a b ")).toBe("a b");
  });

  it("folds a whole set: unique, sorted, and no more than 20", () => {
    expect(artifactLabelsOf(["B", "a", "A"])).toEqual(["a", "b"]);
    expect(artifactLabelsOf([])).toEqual([]);
    const many = Array.from({ length: 21 }, (_, index) => `l${String(index)}`);
    expect(artifactLabelsOf(many)).toBeUndefined();
    expect(artifactLabelsOf(many.slice(0, 20))).toHaveLength(20);
    expect(artifactLabelsOf(["a", "/b"])).toBeUndefined();
  });

  it("matches a filter with AND, and a wanted label also matches the levels under it", () => {
    const held = artifactLabelsOf(["project/junto/release", "docs"])!;
    expect(artifactLabelsMatch(held, [])).toBe(true);
    expect(artifactLabelsMatch(held, [label("docs")])).toBe(true);
    expect(artifactLabelsMatch(held, [label("project")])).toBe(true);
    expect(artifactLabelsMatch(held, [label("project/junto")])).toBe(true);
    expect(artifactLabelsMatch(held, [label("docs"), label("project/junto")])).toBe(true);
    expect(artifactLabelsMatch(held, [label("docs"), label("release")])).toBe(false);
    expect(artifactLabelsMatch(held, [label("proj")])).toBe(false);
  });
});

describe("the ruler's labels op", () => {
  const domain = artifactDomain({ now: () => 7, bodyRef: () => ({ sha256: "0".repeat(64), byteLength: 1, mediaType: "text/markdown" }) as never });
  const operator: ResourceActor = { kind: "operator" };
  const command = (itemId: ItemId, op: ArtifactOp): ResourceCommand<ArtifactOp> => ({
    opId: mintOpId(),
    canvasName: "factory",
    actor: operator,
    target: { kind: "artifact", nodeId: asNodeId("artifacts-shelf"), itemId },
    basis: null,
    after: [],
    op,
  });

  it("folds the set a create carries, and refuses a label it cannot read", async () => {
    const id = mintItemId();
    const created = domain.rule(new Map(), command(id, { op: "create", title: "Plan", body: { type: "document", markdown: "x" }, labels: ["Plan/Q3", "plan/Q3", "Docs"] }));
    expect(created.kind).toBe("apply");
    const fact = created.kind === "apply" ? created.facts[0] : undefined;
    expect(fact?.fact === "artifact.created" && fact.artifact.labels).toEqual(["docs", "plan/q3"]);

    const refused = domain.rule(new Map(), command(mintItemId(), { op: "create", title: "Plan", body: { type: "document", markdown: "x" }, labels: ["/bad"] }));
    expect(refused).toMatchObject({ kind: "refuse", refusal: { reason: "invalid_input" } });
  });

  it("replaces the whole set without moving the version, and reads back as written", () => {
    const id = mintItemId();
    const created = domain.rule(new Map(), command(id, { op: "create", title: "Plan", body: { type: "document", markdown: "x" } }));
    let state = created.kind === "apply" ? domain.apply(new Map(), created.facts[0]!) : new Map();
    expect(state.get(id)!.artifact.labels).toEqual([]);

    const labelled = domain.rule(state, command(id, { op: "labels", labels: ["Release", "docs"] }));
    expect(labelled.kind).toBe("apply");
    const fact = labelled.kind === "apply" ? labelled.facts[0] : undefined;
    expect(fact).toMatchObject({ fact: "artifact.labelled", labels: ["docs", "release"] });
    state = labelled.kind === "apply" ? domain.apply(state, labelled.facts[0]!) : state;
    expect(state.get(id)!.artifact).toMatchObject({ version: 1, labels: ["docs", "release"] });

    const cleared = domain.rule(state, command(id, { op: "labels", labels: [] }));
    state = cleared.kind === "apply" ? domain.apply(state, cleared.facts[0]!) : state;
    expect(state.get(id)!.artifact.labels).toEqual([]);

    const bad = domain.rule(state, command(id, { op: "labels", labels: ["a//b"] }));
    expect(bad).toMatchObject({ kind: "refuse", refusal: { reason: "invalid_input" } });
  });

  it("applying the same fact twice changes nothing", () => {
    const id = mintItemId();
    const created = domain.rule(new Map(), command(id, { op: "create", title: "Plan", body: { type: "document", markdown: "x" }, labels: ["a", "b"] }));
    const once = created.kind === "apply" ? domain.apply(new Map(), created.facts[0]!) : new Map();
    const twice = created.kind === "apply" ? domain.apply(once, created.facts[0]!) : once;
    expect(twice.get(id)!.artifact).toEqual(once.get(id)!.artifact);
  });

  it("reads a head written before labels as none", () => {
    const decoded = decodeArtifact({
      artifactId: mintItemId(),
      nodeId: asNodeId("artifacts-shelf"),
      type: "document",
      title: "Old",
      version: 1,
      createdBy: operator,
      updatedAt: 1,
      archived: false,
      taskIds: [],
    });
    expect(decoded._tag === "Success" && decoded.success.labels).toEqual([]);
  });
});

describe("the labels in the store", () => {
  let root: string;
  let runtime: ReturnType<typeof machineAt>;
  const canvas = "factory";
  const node = asNodeId("artifacts-shelf");
  const mini = "mini" as InstallationId;
  const other = "studio" as InstallationId;
  const operator: ResourceActor = { kind: "operator" };
  const everywhere: RulingContext = { inReach: () => true };
  const v = (n: number) => n as ArtifactVersion;

  const recorder = Layer.effect(
    RulingRecorder,
    Effect.map(SqlClient.SqlClient, (sql) =>
      RulingRecorder.of({
        record: (input) =>
          writeRuling(sql, { canvas: input.canvasName, writer: input.writer, command: input.command, record: input.record }).pipe(
            Effect.asVoid,
            Effect.orDie,
          ),
      }),
    ),
  );

  /** One machine's store: the same layers at another directory. */
  const machineAt = (dir: string) =>
    ManagedRuntime.make(
      Layer.provideMerge(Layer.provide(ArtifactRepositoryLive, recorder), makeContentServiceLive({ root: join(dir, "content"), skipInlineMediaMigration: true })).pipe(
        Layer.provideMerge(Layer.mergeAll(makeStateEngineLive(join(dir, "junto.db")), makeInstallOpsLive(join(dir, "install-ops.db")))),
      ),
    );

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "junto-artifact-labels-"));
    runtime = machineAt(root);
  });

  afterEach(async () => {
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  });

  const run = <A, E>(effect: Effect.Effect<A, E, ArtifactRepository | SqlClient.SqlClient>) => runtime.runPromise(effect as never) as Promise<A>;

  const submit = (op: ArtifactOp, id: ItemId, writer = mini) =>
    run(
      Effect.flatMap(ArtifactRepository, (repo) =>
        repo.submit(writer, {
          opId: mintOpId(),
          canvasName: canvas,
          actor: operator,
          target: { kind: "artifact", nodeId: node, itemId: id },
          basis: null,
          after: [],
          op,
        }, everywhere),
      ),
    );

  it("keeps a head's labels through an edit, and filters a list by them before the limit", async () => {
    const plan = mintItemId();
    const notes = mintItemId();
    const other = mintItemId();
    expect(await submit({ op: "create", title: "Plan", body: { type: "document", markdown: "x" }, labels: ["Project/Junto", "docs"] }, plan)).toMatchObject({ kind: "applied" });
    expect(await submit({ op: "create", title: "Notes", body: { type: "document", markdown: "y" }, labels: ["docs"] }, notes)).toMatchObject({ kind: "applied" });
    expect(await submit({ op: "create", title: "Other", body: { type: "document", markdown: "z" }, labels: ["project/junto/release"] }, other)).toMatchObject({ kind: "applied" });

    const listed = await run(Effect.flatMap(ArtifactRepository, (repo) => repo.list(canvas, { nodeIds: [node], archived: false, limit: 10 })));
    expect(listed.artifacts.find((artifact) => artifact.artifactId === plan)?.labels).toEqual(["docs", "project/junto"]);

    const filtered = await run(
      Effect.flatMap(ArtifactRepository, (repo) => repo.list(canvas, { nodeIds: [node], labels: [label("project/junto")], archived: false, limit: 1 })),
    );
    // The prefix filter matches two, and the limit cuts one: filtering happened in SQL.
    expect(filtered.more).toBe(true);
    expect(filtered.artifacts).toHaveLength(1);

    // An edit leaves the labels alone; a labels op replaces the set.
    expect(await submit({ op: "edit", edit: { kind: "replace", baseVersion: v(1), body: { type: "document", markdown: "edited" } } }, plan)).toMatchObject({ kind: "applied", version: 2 });
    const head = await run(Effect.flatMap(ArtifactRepository, (repo) => repo.head(canvas, plan)));
    expect(head._tag === "Some" && head.value.artifact.labels).toEqual(["docs", "project/junto"]);
    expect(await submit({ op: "labels", labels: ["Release"] }, plan)).toMatchObject({ kind: "applied" });
    const relabelled = await run(Effect.flatMap(ArtifactRepository, (repo) => repo.head(canvas, plan)));
    expect(relabelled._tag === "Some" && relabelled.value.artifact).toMatchObject({ version: 2, labels: ["release"] });
  });

  it("folds a ruled set on a second machine, twice, and reads the same labels", async () => {
    const id = mintItemId();
    const outcome = await submit({ op: "create", title: "Plan", body: { type: "document", markdown: "x" }, labels: ["Docs", "Project"] }, id);
    expect(outcome.kind).toBe("applied");
    const facts = outcome.kind === "applied" ? outcome.facts : [];
    const labelled = await submit({ op: "labels", labels: ["Release"] }, id);
    const later = labelled.kind === "applied" ? labelled.facts : [];

    // Another machine's store: the same projection the ruler wrote with, fed
    // the facts as they crossed, with the labels fact folded twice.
    const mirror = machineAt(join(root, "mirror"));
    try {
      await mirror.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          // The exchange owns the transaction a received ruling folds in.
          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* projectArtifactFacts(sql, canvas, mintOpId(), facts, () => undefined);
              yield* projectArtifactFacts(sql, canvas, mintOpId(), later, () => undefined);
              yield* projectArtifactFacts(sql, canvas, mintOpId(), later, () => undefined);
            }),
          );
        }) as never,
      );
      const head = await mirror.runPromise(
        Effect.flatMap(ArtifactRepository, (repo) => repo.head(canvas, id)) as never,
      ) as { _tag: string; value?: { artifact: { labels: ReadonlyArray<string> } } };
      expect(head._tag === "Some" && head.value?.artifact.labels).toEqual(["release"]);
    } finally {
      await mirror.dispose();
    }
    // Every fact carries canonical labels: nothing on the wire needed folding.
    for (const fact of [...facts, ...later]) {
      if (fact.fact === "artifact.created") expect(fact.artifact.labels).toEqual(["docs", "project"]);
      if (fact.fact === "artifact.labelled") expect(fact.labels).toEqual(["release"]);
      expect(Object.keys(fact)).not.toContain("label");
    }
    expect(ArtifactFact).toBeDefined();
    void other;
  });
});
