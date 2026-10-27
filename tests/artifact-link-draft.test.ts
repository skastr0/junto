import { describe, expect, it } from "vitest";
import type { NodeId } from "../src/shared/physics/schema";
import type { ItemId } from "../src/shared/work-ids";
import { artifactLinkCandidates, linkCandidateLabel, linkQueryAt, type LinkableArtifact } from "../src/renderer/lib/artifact-link-draft";

const artifact = (title: string, id: string): LinkableArtifact => ({
  ref: { kind: "artifact", nodeId: "artifacts-01M5ZC0000000000000000000A" as NodeId, artifactId: id as ItemId },
  title,
  type: "document",
});
const PLAN = artifact("Launch plan", "01M5ZC0000000000000000000B");
const NOTES = artifact("Notes on the launch", "01M5ZC0000000000000000000C");
const SHEET = artifact("Budget", "01M5ZC0000000000000000000D");

describe("the [[ query", () => {
  it("is what follows [[ up to the caret, spaces included", () => {
    expect(linkQueryAt("see [[Launch pl")).toEqual({ start: 4, query: "Launch pl" });
    expect(linkQueryAt("[[")).toEqual({ start: 0, query: "" });
  });

  it("ends at a bracket, and never starts at an escaped one", () => {
    expect(linkQueryAt("[[Launch]] then")).toBeUndefined();
    expect(linkQueryAt("[[a [b")).toBeUndefined();
    expect(linkQueryAt("\\[[Launch")).toBeUndefined();
    expect(linkQueryAt("[x](y)")).toBeUndefined();
  });
});

describe("the [[ rows", () => {
  it("lists titles that start with the query, then those that contain it, then the create row", () => {
    const rows = artifactLinkCandidates([NOTES, PLAN, SHEET], "launch");
    expect(rows.map(linkCandidateLabel)).toEqual(["Launch plan", "Notes on the launch", "Create document launch"]);
  });

  it("offers no create row for a title that exists, case aside, nor for nothing typed", () => {
    expect(artifactLinkCandidates([PLAN], "launch PLAN").map(linkCandidateLabel)).toEqual(["Launch plan"]);
    expect(artifactLinkCandidates([PLAN, SHEET], "  ").map(linkCandidateLabel)).toEqual(["Launch plan", "Budget"]);
  });

  it("creates by the typed title on one line, and never one too long to be a title", () => {
    expect(artifactLinkCandidates([], "  Q3   review ")).toEqual([{ kind: "create", title: "Q3 review" }]);
    expect(artifactLinkCandidates([], "x".repeat(201))).toEqual([]);
  });
});
