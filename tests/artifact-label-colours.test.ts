/**
 * Label colours (0.11, 03 Colours, C1): the eight names, the op on the
 * Artifacts node, the fact that crosses machines, and the rows behind them.
 * Proven on the real state engine, the production DDL and the same fold the
 * ruler and a replica run, twice, so a receiving machine normalises nothing.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ArtifactOp, decodeArtifactOp } from "../src/shared/artifact";
import { ARTIFACT_LABEL_COLOURS, ArtifactLabelColour } from "../src/shared/artifact-labels";
import { artifactDomain, ArtifactFact, emptyArtifactState } from "../src/shared/artifact-domain";
import type { InstallationId } from "../src/shared/installation-id";
import { asNodeId } from "../src/shared/model";
import type { NodeId } from "../src/shared/physics/schema";
import {
  afterOf,
  emptyRuled,
  mintItemId,
  mintOpId,
  overlay,
  rule,
  type ItemId,
  type ResourceActor,
  type ResourceCommand,
  type RulingContext,
} from "../src/shared/resource-command";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { makeInstallOpsLive } from "../src/main/junto/install-ops/engine";
import { makeContentServiceLive } from "../src/main/junto/content/service";
import { ArtifactRepository, ArtifactRepositoryLive, projectArtifactFacts } from "../src/main/junto/work/artifact-repository";
import { RulingRecorder } from "../src/main/junto/work/ruling-recorder";
import { writeRuling } from "../src/main/junto/work/resource-rulings";

const node = asNodeId("artifacts-shelf");
const operator: ResourceActor = { kind: "operator" };

const command = (op: ArtifactOp, itemId?: ItemId, nodeId: NodeId = node): ResourceCommand<ArtifactOp> => ({
  opId: mintOpId(),
  canvasName: "factory",
  actor: operator,
  target: itemId === undefined ? { kind: "artifact", nodeId } : { kind: "artifact", nodeId, itemId },
  basis: null,
  after: [],
  op,
});

describe("the eight colours", () => {
  it("are names in a fixed order, and nothing else decodes", () => {
    expect(ARTIFACT_LABEL_COLOURS).toEqual(["red", "orange", "yellow", "green", "teal", "blue", "purple", "pink"]);
    for (const colour of ARTIFACT_LABEL_COLOURS) expect(Schema.is(ArtifactLabelColour)(colour)).toBe(true);
    for (const bad of ["Red", "#ff0000", "grey", ""]) expect(Schema.is(ArtifactLabelColour)(bad), bad).toBe(false);
  });

  it("ride the op as a name or null, never hex", () => {
    expect(decodeArtifactOp({ op: "labelColour", label: "docs", colour: "teal" })._tag).toBe("Success");
    expect(decodeArtifactOp({ op: "labelColour", label: "docs", colour: null })._tag).toBe("Success");
    expect(decodeArtifactOp({ op: "labelColour", label: "docs", colour: "#00ffff" })._tag).toBe("Failure");
  });
});

describe("the ruler's labelColour op", () => {
  const domain = artifactDomain({ now: () => 7, bodyRef: () => ({ sha256: "0".repeat(64), byteLength: 1, mediaType: "text/markdown" }) as never });

  it("folds the label and names the node, on a state with no artifacts at all", () => {
    const ruled = domain.rule(emptyArtifactState(), command({ op: "labelColour", label: "  Project/Junto ", colour: "blue" }));
    expect(ruled).toEqual({
      kind: "apply",
      facts: [{ fact: "artifact.label.coloured", nodeId: node, label: "project/junto", colour: "blue", at: 7 }],
    });
    const unset = domain.rule(emptyArtifactState(), command({ op: "labelColour", label: "docs", colour: null }));
    expect(unset).toMatchObject({ kind: "apply", facts: [{ label: "docs", colour: null }] });
  });

  it("refuses a label it cannot read, and a command that names an artifact, for good", () => {
    const bad = command({ op: "labelColour", label: "a//b", colour: "red" });
    const badVerdict = domain.rule(emptyArtifactState(), bad);
    expect(badVerdict).toMatchObject({ kind: "refuse", refusal: { reason: "invalid_input" } });
    expect(badVerdict.kind === "refuse" && domain.definite!(badVerdict.refusal, bad)).toBe(true);

    const onItem = command({ op: "labelColour", label: "docs", colour: "red" }, mintItemId());
    expect(domain.rule(emptyArtifactState(), onItem)).toMatchObject({ kind: "refuse", refusal: { reason: "invalid_input" } });
  });

  it("leaves the ruler's artifact state as it was: a colour is the node's", () => {
    const id = mintItemId();
    const created = domain.rule(emptyArtifactState(), command({ op: "create", title: "Plan", body: { type: "document", markdown: "x" }, labels: ["docs"] }, id));
    const state = created.kind === "apply" ? domain.apply(emptyArtifactState(), created.facts[0]!) : emptyArtifactState();
    const coloured = domain.rule(state, command({ op: "labelColour", label: "docs", colour: "green" }));
    expect(coloured.kind === "apply" && domain.apply(state, coloured.facts[0]!)).toBe(state);
  });
});

describe("a colour beside the node's item commands", () => {
  const domain = artifactDomain({ now: () => 7, bodyRef: () => ({ sha256: "0".repeat(64), byteLength: 1, mediaType: "text/markdown" }) as never });
  const writer = "seat-machine" as InstallationId;
  const everywhere: RulingContext = { inReach: () => true };
  const queue = (pending: ReadonlyArray<ResourceCommand<ArtifactOp>>, next: ResourceCommand<ArtifactOp>) => ({
    ...next,
    after: afterOf(pending, next.target),
  });
  const withA = () => {
    const a = mintItemId();
    const created = rule(domain, emptyRuled(emptyArtifactState()), writer, command({ op: "create", title: "A", body: { type: "document", markdown: "x" } }, a), everywhere);
    return { a, ruled: created.ruled };
  };

  it("applies a colour queued after an edit the ruler refuses, and no item command builds on a colour", () => {
    const { a, ruled } = withA();
    const stale = queue([], command({ op: "edit", edit: { kind: "replace", baseVersion: 9 as never, body: { type: "document", markdown: "y" } } }, a));
    const colour = queue([stale], command({ op: "labelColour", label: "docs", colour: "teal" }));
    expect(colour.after).toEqual([]);
    const second = queue([stale, colour], command({ op: "labelColour", label: "docs", colour: "red" }));
    expect(second.after).toEqual([colour.opId]);
    expect(queue([stale, colour], command({ op: "retitle", title: "B" }, a)).after).toEqual([stale.opId]);

    const edited = rule(domain, ruled, writer, stale, everywhere);
    // Refused (a base the head never reached): any refusal of A's edit would sink a colour that built on it.
    expect(edited.ruling).toMatchObject({ kind: "refused" });
    const coloured = rule(domain, edited.ruled, writer, colour, everywhere);
    expect(coloured.ruling).toMatchObject({ kind: "applied", facts: [{ fact: "artifact.label.coloured", label: "docs", colour: "teal" }] });
  });

  it("lists a colour pending while an edit on the node waits for its base", () => {
    const { a, ruled } = withA();
    const edit = queue([], command({ op: "edit", edit: { kind: "replace", baseVersion: 1 as never, body: { type: "document", markdown: "y" } } }, a));
    const colour = queue([edit], command({ op: "labelColour", label: "docs", colour: "teal" }));
    const read = overlay(domain, ruled, writer, [edit, colour], { ...everywhere, baseComplete: (target) => target.itemId !== a });
    expect(read.pending).toEqual([
      { opId: edit.opId, status: "at_risk", waiting: "base_not_pulled", root: edit.opId },
      { opId: colour.opId, status: "pending" },
    ]);
  });
});

describe("the colours in the store", () => {
  let root: string;
  let runtime: ReturnType<typeof machineAt>;
  const canvas = "factory";
  const mini = "mini" as InstallationId;
  const everywhere: RulingContext = { inReach: () => true };

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

  const machineAt = (dir: string) =>
    ManagedRuntime.make(
      Layer.provideMerge(Layer.provide(ArtifactRepositoryLive, recorder), makeContentServiceLive({ root: join(dir, "content"), skipInlineMediaMigration: true })).pipe(
        Layer.provideMerge(Layer.mergeAll(makeStateEngineLive(join(dir, "junto.db")), makeInstallOpsLive(join(dir, "install-ops.db")))),
      ),
    );

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "junto-artifact-label-colours-"));
    runtime = machineAt(root);
  });

  afterEach(async () => {
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  });

  const run = <A, E>(effect: Effect.Effect<A, E, ArtifactRepository | SqlClient.SqlClient>) => runtime.runPromise(effect as never) as Promise<A>;
  const submitNode = (written: ResourceCommand<ArtifactOp>) =>
    run(Effect.flatMap(ArtifactRepository, (repo) => repo.submitNode(mini, written, everywhere)));
  const colours = (nodeIds: ReadonlyArray<NodeId> = [node]) =>
    run(Effect.flatMap(ArtifactRepository, (repo) => repo.labelColours(canvas, nodeIds)));

  it("sets, changes and unsets a label's colour per node, with no artifact carrying it", async () => {
    const shelf2 = asNodeId("artifacts-other");
    expect(await submitNode(command({ op: "labelColour", label: "Docs", colour: "teal" }))).toMatchObject({ kind: "applied" });
    expect(await submitNode(command({ op: "labelColour", label: "project/junto", colour: "pink" }))).toMatchObject({ kind: "applied" });
    expect(await submitNode(command({ op: "labelColour", label: "docs", colour: "red" }, undefined, shelf2))).toMatchObject({ kind: "applied" });
    let read = await colours([node, shelf2, asNodeId("artifacts-empty")]);
    expect(read.get(node)).toEqual({ docs: "teal", "project/junto": "pink" });
    expect(read.get(shelf2)).toEqual({ docs: "red" });
    expect(read.get(asNodeId("artifacts-empty"))).toEqual({});

    expect(await submitNode(command({ op: "labelColour", label: "docs", colour: "blue" }))).toMatchObject({ kind: "applied" });
    expect(await submitNode(command({ op: "labelColour", label: "project/junto", colour: null }))).toMatchObject({ kind: "applied" });
    // Unsetting a label with no colour is no change, and is not refused.
    expect(await submitNode(command({ op: "labelColour", label: "never", colour: null }))).toMatchObject({ kind: "applied" });
    read = await colours();
    expect(read.get(node)).toEqual({ docs: "blue" });
  });

  it("keeps __proto__ and constructor as labels like any other", async () => {
    await submitNode(command({ op: "labelColour", label: "__proto__", colour: "red" }));
    await submitNode(command({ op: "labelColour", label: "constructor", colour: "blue" }));
    const read = (await colours()).get(node)!;
    expect(Object.keys(read).sort()).toEqual(["__proto__", "constructor"]);
    expect(Object.getPrototypeOf(read)).toBeNull();
    expect(read["__proto__" as never]).toBe("red");
    expect(JSON.parse(JSON.stringify(read))).toEqual(JSON.parse('{"__proto__":"red","constructor":"blue"}'));
  });

  it("answers a resend from the stored ruling, and stores a refusal the same way", async () => {
    const written = command({ op: "labelColour", label: "docs", colour: "green" });
    const first = await submitNode(written);
    expect(first).toMatchObject({ kind: "applied", facts: [{ fact: "artifact.label.coloured" }] });
    expect(await submitNode(written)).toEqual({ kind: "applied", opId: written.opId, facts: [] });

    const bad = command({ op: "labelColour", label: "/docs", colour: "green" });
    const refused = await submitNode(bad);
    expect(refused).toMatchObject({ kind: "refused", error: { details: { reason: "invalid_input" } } });
    expect(await submitNode(bad)).toMatchObject({ kind: "refused", root: bad.opId });
  });

  it("keeps a colour when the last artifact drops the label, so it comes back the same", async () => {
    const id = mintItemId();
    const submit = (op: ArtifactOp) => run(Effect.flatMap(ArtifactRepository, (repo) => repo.submit(mini, command(op, id), everywhere)));
    await submit({ op: "create", title: "Plan", body: { type: "document", markdown: "x" }, labels: ["docs"] });
    await submitNode(command({ op: "labelColour", label: "docs", colour: "purple" }));
    await submit({ op: "labels", labels: [] });
    expect((await colours()).get(node)).toEqual({ docs: "purple" });
  });

  it("folds the crossed facts on a second machine, twice, and reads the same colours", async () => {
    const set = await submitNode(command({ op: "labelColour", label: "Docs", colour: "yellow" }));
    const changed = await submitNode(command({ op: "labelColour", label: "docs", colour: "orange" }));
    const unset = await submitNode(command({ op: "labelColour", label: "spare", colour: null }));
    const crossed = [set, changed, unset].flatMap((outcome) => (outcome.kind === "applied" ? outcome.facts : []));
    expect(crossed).toHaveLength(3);
    // Each fact is canonical and decodes as the replica decodes it.
    const decode = Schema.decodeUnknownResult(Schema.Array(ArtifactFact), { onExcessProperty: "error" });
    expect(decode(JSON.parse(JSON.stringify(crossed)))._tag).toBe("Success");

    const mirror = machineAt(join(root, "mirror"));
    try {
      await mirror.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* projectArtifactFacts(sql, canvas, mintOpId(), crossed, () => undefined);
              yield* projectArtifactFacts(sql, canvas, mintOpId(), crossed, () => undefined);
            }),
          );
        }) as never,
      );
      const read = (await mirror.runPromise(
        Effect.flatMap(ArtifactRepository, (repo) => repo.labelColours(canvas, [node])) as never,
      )) as ReadonlyMap<NodeId, Readonly<Record<string, string>>>;
      expect(read.get(node)).toEqual({ docs: "orange" });
    } finally {
      await mirror.dispose();
    }
  });
});
