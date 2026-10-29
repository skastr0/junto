import { describe, expect, it } from "vitest";
import { emptyBody, type ArtifactOp } from "../src/shared/artifact";
import { artifactDomain, artifactsOnNode, emptyArtifactState, type ArtifactFact, type ArtifactState } from "../src/shared/artifact-domain";
import type { InstallationId } from "../src/shared/installation-id";
import { localBodyRef } from "../src/renderer/lib/artifacts-source";
import { asNodeId, type NodeId } from "../src/shared/physics/schema";
import {
  emptyRuled,
  type ItemId,
  mintItemId,
  mintOpId,
  type ResourceActor,
  type ResourceRuling,
  rule,
  type Ruled,
} from "../src/shared/resource-command";

const domain = artifactDomain({ now: () => 2_000, bodyRef: localBodyRef });
const mini = "mini" as InstallationId;
const operator: ResourceActor = { kind: "operator" };
const specs = asNodeId("artifacts-specs");
const release = asNodeId("artifacts-release");

type R = Ruled<ArtifactState, ArtifactFact>;

const run = (ruled: R, op: ArtifactOp, itemId: ItemId, nodeId: NodeId = specs) =>
  rule(domain, ruled, mini, { opId: mintOpId(), canvasName: "factory", actor: operator, target: { kind: "artifact", nodeId, itemId }, basis: null, after: [], op }, { inReach: () => true });

const reasonOf = (ruling: ResourceRuling<ArtifactFact>): string =>
  ruling.kind === "applied" ? "applied" : String(ruling.error.details?.reason);

const made = () => {
  const id = mintItemId();
  let { ruled } = run(emptyRuled(emptyArtifactState()), { op: "create", title: "Plan", body: emptyBody("document"), labels: ["spec"] }, id);
  ruled = run(ruled, { op: "edit", edit: { kind: "replace", baseVersion: 1 as never, body: { type: "document", markdown: "# Plan" } } }, id).ruled;
  return { id, ruled };
};

describe("moving an artifact", () => {
  it("changes its node and nothing else, and says from where, to where and by whom", () => {
    const { id, ruled } = made();
    const before = ruled.state.get(id)!;
    const moved = run(ruled, { op: "move", to: release }, id);
    expect(moved.ruling.kind).toBe("applied");
    if (moved.ruling.kind !== "applied") return;
    expect(moved.ruling.facts).toEqual([{ fact: "artifact.moved", artifactId: id, from: specs, to: release, by: operator, at: 2_000 }]);
    const after = moved.ruled.state.get(id)!;
    expect(after.artifact).toEqual({ ...before.artifact, nodeId: release });
    expect(after.body).toEqual(before.body);
    expect(after.edits).toEqual(before.edits);
    expect(artifactsOnNode(moved.ruled.state, specs)).toEqual([]);
    expect(artifactsOnNode(moved.ruled.state, release).map((entry) => entry.artifact.artifactId)).toEqual([id]);
  });

  it("is refused onto the node it is on, and from a node it is not on", () => {
    const { id, ruled } = made();
    expect(reasonOf(run(ruled, { op: "move", to: specs }, id).ruling)).toBe("invalid_transition");
    expect(reasonOf(run(ruled, { op: "move", to: specs }, id, release).ruling)).toBe("unknown_target");
  });

  it("moves an archived artifact, which stays archived", () => {
    const { id, ruled } = made();
    const archived = run(ruled, { op: "archive" }, id).ruled;
    const moved = run(archived, { op: "move", to: release }, id);
    expect(reasonOf(moved.ruling)).toBe("applied");
    expect(moved.ruled.state.get(id)!.artifact).toMatchObject({ nodeId: release, archived: true });
  });

  it("applied twice leaves it on the node it moved to", () => {
    const { id, ruled } = made();
    const fact: ArtifactFact = { fact: "artifact.moved", artifactId: id, from: specs, to: release, by: operator, at: 2_000 };
    const once = domain.apply(ruled.state, fact);
    expect(domain.apply(once, fact)).toEqual(once);
  });
});
