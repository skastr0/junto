import { describe, expect, expectTypeOf, it } from "vitest";
import type { ActorSeatId } from "../src/shared/actor-seat";
import { type ArtifactEdit, type ArtifactOp, type ArtifactVersion, emptyBody } from "../src/shared/artifact";
import {
  ARTIFACT_FACT_INLINE_MAX_BYTES,
  ARTIFACT_REBASE_WINDOW,
  artifactDomain,
  type ArtifactState,
  artifactsOnNode,
  emptyArtifactState,
  type ArtifactFact,
} from "../src/shared/artifact-domain";
import type { InstallationId } from "../src/shared/installation-id";
import { localBodyRef } from "../src/renderer/lib/artifacts-source";
import { asNodeId } from "../src/shared/physics/schema";
import {
  emptyRuled,
  type ItemId,
  mintItemId,
  mintOpId,
  type ResourceActor,
  type ResourceCommand,
  type ResourceDomain,
  type ResourceRuling,
  rule,
  type Ruled,
  type RulingContext,
} from "../src/shared/resource-command";

const domain = artifactDomain({ now: () => 1_000, bodyRef: localBodyRef });
const mini = "mini" as InstallationId;
const everywhere: RulingContext = { inReach: () => true };
const operator: ResourceActor = { kind: "operator" };
const seat: ResourceActor = { kind: "seat", seatId: `seat_${"a".padEnd(64, "0")}` as ActorSeatId, nodeId: asNodeId("writer") };
const node = asNodeId("artifacts");
const v = (n: number) => n as ArtifactVersion;

const command = (op: ArtifactOp, itemId: ItemId, actor: ResourceActor = operator): ResourceCommand<ArtifactOp> => ({
  opId: mintOpId(),
  canvasName: "factory",
  actor,
  target: { kind: "artifact", nodeId: node, itemId },
  basis: null,
  after: [],
  op,
});

type R = Ruled<ArtifactState, ArtifactFact>;

const run = (ruled: R, op: ArtifactOp, itemId: ItemId, actor?: ResourceActor) =>
  rule(domain, ruled, mini, command(op, itemId, actor), everywhere);

const reasonOf = (ruling: ResourceRuling<ArtifactFact>): string =>
  ruling.kind === "applied" ? "applied" : String(ruling.error.details?.reason);

const sheetCell = (base: number, rowId: string, columnId: string, value: string): ArtifactEdit => ({
  kind: "patch",
  type: "sheet",
  baseVersion: v(base),
  patches: [{ op: "cell", rowId, columnId, value }],
});

const created = (type: "sheet" | "document" = "sheet") => {
  const id = mintItemId();
  const { ruled } = run(emptyRuled(emptyArtifactState()), { op: "create", title: "Budget", body: emptyBody(type) }, id, seat);
  return { id, ruled };
};

describe("artifact domain", () => {
  it("is the ruler's artifact domain", () => {
    expectTypeOf(domain).toEqualTypeOf<ResourceDomain<ArtifactState, ArtifactOp, ArtifactFact>>();
    expect(domain.kind).toBe("artifact");
  });

  it("creates at version 1 with the command's actor and item id", () => {
    const { id, ruled } = created();
    const entry = ruled.state.get(id);
    expect(entry?.artifact).toMatchObject({ artifactId: id, nodeId: node, type: "sheet", version: 1, archived: false, taskIds: [] });
    expect(entry?.artifact.createdBy).toEqual(seat);
  });

  it("refuses a second create of the same id", () => {
    const { id, ruled } = created();
    expect(reasonOf(run(ruled, { op: "create", title: "Again", body: emptyBody("sheet") }, id).ruling)).toBe("invalid_input");
  });

  it("refuses an unknown artifact, or one on another node", () => {
    const { id, ruled } = created();
    expect(reasonOf(run(ruled, { op: "retitle", title: "x" }, mintItemId()).ruling)).toBe("unknown_target");
    const elsewhere = rule(domain, ruled, mini, { ...command({ op: "retitle", title: "x" }, id), target: { kind: "artifact", nodeId: asNodeId("other"), itemId: id } }, everywhere);
    expect(reasonOf(elsewhere.ruling)).toBe("unknown_target");
  });

  it("moves the head one version per edit and keeps the edit log", () => {
    const { id, ruled } = created();
    const one = run(ruled, { op: "edit", edit: sheetCell(1, "r1", "c1", "a") }, id);
    const two = run(one.ruled, { op: "edit", edit: sheetCell(2, "r1", "c2", "b") }, id);
    const entry = two.ruled.state.get(id)!;
    expect(entry.artifact.version).toBe(3);
    expect(entry.edits).toHaveLength(2);
    expect(entry.editsFrom).toBe(2);
    expect(entry.body?.type === "sheet" && entry.body.grid.rows[0]?.cells).toEqual({ c1: "a", c2: "b" });
  });

  it("rebases a sheet patch on an old base when the cells differ, from the log", () => {
    const { id, ruled } = created();
    const theirs = run(ruled, { op: "edit", edit: sheetCell(1, "r1", "c1", "theirs") }, id);
    const mine = run(theirs.ruled, { op: "edit", edit: sheetCell(1, "r1", "c2", "mine") }, id);
    expect(reasonOf(mine.ruling)).toBe("applied");
    expect(mine.ruled.state.get(id)?.artifact.version).toBe(3);
  });

  it("maps a same-cell rebase to rebase_conflict and an old document base to stale, with the head", () => {
    const { id, ruled } = created();
    const theirs = run(ruled, { op: "edit", edit: sheetCell(1, "r1", "c1", "theirs") }, id);
    const mine = run(theirs.ruled, { op: "edit", edit: sheetCell(1, "r1", "c1", "mine") }, id);
    expect(mine.ruling.kind === "refused" && mine.ruling.error.details).toMatchObject({ reason: "rebase_conflict", expected: 2, retryable: true });

    const doc = created("document");
    const first = run(doc.ruled, { op: "edit", edit: { kind: "replace", baseVersion: v(1), body: { type: "document", markdown: "a" } } }, doc.id);
    const late = run(first.ruled, { op: "edit", edit: { kind: "replace", baseVersion: v(1), body: { type: "document", markdown: "b" } } }, doc.id);
    expect(late.ruling.kind === "refused" && late.ruling.error.details).toMatchObject({ reason: "stale", expected: 2 });
  });

  it("maps a wrong type and a future base to invalid_input", () => {
    const { id, ruled } = created();
    const wrong = run(ruled, { op: "edit", edit: { kind: "replace", baseVersion: v(1), body: { type: "document", markdown: "" } } }, id);
    expect(reasonOf(wrong.ruling)).toBe("invalid_input");
    expect(reasonOf(run(ruled, { op: "edit", edit: sheetCell(5, "r1", "c1", "x") }, id).ruling)).toBe("invalid_input");
  });

  it("archives once, restores once", () => {
    const { id, ruled } = created();
    const archived = run(ruled, { op: "archive" }, id);
    expect(archived.ruled.state.get(id)?.artifact.archived).toBe(true);
    expect(reasonOf(run(archived.ruled, { op: "archive" }, id).ruling)).toBe("invalid_transition");
    const restored = run(archived.ruled, { op: "restore" }, id);
    expect(restored.ruled.state.get(id)?.artifact.archived).toBe(false);
    expect(reasonOf(run(restored.ruled, { op: "restore" }, id).ruling)).toBe("invalid_transition");
  });

  it("refuses edit, retitle and tasks on an archived artifact until it is restored", () => {
    const { id, ruled } = created();
    const archived = run(ruled, { op: "archive" }, id).ruled;
    for (const op of [
      { op: "edit", edit: sheetCell(1, "r1", "c1", "x") },
      { op: "retitle", title: "x" },
      { op: "tasks", taskIds: [] },
    ] satisfies ArtifactOp[]) {
      const refused = run(archived, op, id).ruling;
      expect(refused.kind === "refused" && refused.error.details).toMatchObject({
        reason: "invalid_transition",
        next_step: "Restore it first with junto artifact restore",
      });
    }
    const restored = run(archived, { op: "restore" }, id).ruled;
    expect(reasonOf(run(restored, { op: "retitle", title: "x" }, id).ruling)).toBe("applied");
  });

  it("keeps a bounded edit log; a base older than it is stale, a recent one rebases", () => {
    let { id, ruled } = created();
    const total = ARTIFACT_REBASE_WINDOW + 6;
    for (let n = 1; n <= total; n += 1) {
      ruled = run(ruled, { op: "edit", edit: sheetCell(n, "r1", "c1", String(n)) }, id).ruled;
    }
    const entry = ruled.state.get(id)!;
    expect(entry.artifact.version).toBe(total + 1);
    expect(entry.edits).toHaveLength(ARTIFACT_REBASE_WINDOW);
    expect(entry.editsFrom).toBe(total + 2 - ARTIFACT_REBASE_WINDOW);
    expect(reasonOf(run(ruled, { op: "edit", edit: sheetCell(2, "r1", "c2", "old") }, id).ruling)).toBe("stale");
    expect(reasonOf(run(ruled, { op: "edit", edit: sheetCell(total, "r1", "c2", "recent") }, id).ruling)).toBe("applied");
  });

  it("names every version by ref and keeps a big body out of the fact, loaded by ref", () => {
    const { id, ruled } = created("document");
    const big = "x".repeat(60 * 1024);
    const replaced = run(ruled, { op: "edit", edit: { kind: "replace", baseVersion: v(1), body: { type: "document", markdown: big } } }, id);
    const fact = replaced.ruling.kind === "applied" ? replaced.ruling.facts[0] : undefined;
    expect(fact?.fact).toBe("artifact.edited");
    expect(fact && "edit" in fact).toBe(false);
    expect(new TextEncoder().encode(JSON.stringify(fact)).byteLength).toBeLessThan(ARTIFACT_FACT_INLINE_MAX_BYTES);
    const entry = replaced.ruled.state.get(id)!;
    expect(entry.body).toBeNull();
    expect(entry.bodyRef).toEqual(localBodyRef({ type: "document", markdown: big }));
    const refused = run(replaced.ruled, { op: "edit", edit: { kind: "patch", type: "document", baseVersion: v(2), patches: [{ op: "splice", at: 0, remove: 0, insert: "y" }] } }, id).ruling;
    expect(reasonOf(refused)).toBe("not_available");
  });

  it("folds a small patch into the known body without carrying it", () => {
    const { id, ruled } = created();
    const one = run(ruled, { op: "edit", edit: sheetCell(1, "r1", "c1", "a") }, id);
    const fact = one.ruling.kind === "applied" ? one.ruling.facts[0] : undefined;
    expect(fact && "body" in fact).toBe(false);
    expect(fact && "edit" in fact).toBe(true);
    const entry = one.ruled.state.get(id)!;
    expect(entry.body?.type === "sheet" && entry.body.grid.rows[0]?.cells).toEqual({ c1: "a" });
  });

  it("retitles and names tasks without moving the version", () => {
    const { id, ruled } = created();
    const task = mintItemId();
    const titled = run(run(ruled, { op: "retitle", title: "Q4" }, id).ruled, { op: "tasks", taskIds: [task] }, id);
    expect(titled.ruled.state.get(id)?.artifact).toMatchObject({ title: "Q4", taskIds: [task], version: 1 });
  });

  it("lists a node's artifacts newest change first", () => {
    let ruled = emptyRuled<ArtifactState, ArtifactFact>(emptyArtifactState());
    let clock = 0;
    const timed = artifactDomain({ now: () => (clock += 1), bodyRef: localBodyRef });
    const a = mintItemId();
    const b = mintItemId();
    ruled = rule(timed, ruled, mini, command({ op: "create", title: "A", body: emptyBody("document") }, a), everywhere).ruled;
    ruled = rule(timed, ruled, mini, command({ op: "create", title: "B", body: emptyBody("document") }, b), everywhere).ruled;
    ruled = rule(timed, ruled, mini, command({ op: "retitle", title: "A2" }, a), everywhere).ruled;
    expect(artifactsOnNode(ruled.state, node).map((entry) => entry.artifact.title)).toEqual(["A2", "B"]);
  });

  it("addresses the artifact by target, never by a field in the op", () => {
    // @ts-expect-error an op carries no artifactId
    const op: ArtifactOp = { op: "archive", artifactId: mintItemId() };
    void op;
  });
});
