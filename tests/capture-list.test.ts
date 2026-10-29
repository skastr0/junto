import { describe, expect, it } from "vitest";
import type { ArtifactHead } from "@shared/resource-ipc";
import { asNodeId } from "@shared/physics/schema";
import type { ArtifactId } from "@shared/artifact";
import { captureRowsOf } from "../src/renderer/components/capture/capture-list";

const inbox = asNodeId("inbox");
const shelf = asNodeId("shelf");

const head = (
  artifactId: string,
  nodeId = shelf,
  over: {
    readonly title?: string;
    readonly labels?: ReadonlyArray<string>;
    readonly updatedAt?: number;
    readonly archived?: boolean;
    readonly markdown?: string;
  } = {},
): ArtifactHead => ({
  artifact: {
    artifactId: artifactId as ArtifactId,
    nodeId,
    type: "document",
    title: over.title ?? artifactId,
    version: 1 as ArtifactHead["artifact"]["version"],
    createdBy: { kind: "operator" },
    updatedAt: over.updatedAt ?? 0,
    archived: over.archived ?? false,
    taskIds: [],
    labels: (over.labels ?? []) as ArtifactHead["artifact"]["labels"],
  },
  body: { type: "document", markdown: over.markdown ?? "" },
  bodyRef: null as unknown as ArtifactHead["bodyRef"],
});

const ids = (heads: ReadonlyArray<ArtifactHead>, query = ""): ReadonlyArray<string> =>
  captureRowsOf(heads, inbox, query).map((row) => row.artifactId);

describe("quick capture's list", () => {
  it("puts the Inbox first by recency, then everything else by recency", () => {
    const heads = [
      head("old-inbox", inbox, { updatedAt: 10 }),
      head("new-inbox", inbox, { updatedAt: 30 }),
      head("old-shelf", shelf, { updatedAt: 20 }),
      head("new-shelf", shelf, { updatedAt: 40 }),
    ];
    expect(ids(heads)).toEqual(["new-inbox", "old-inbox", "new-shelf", "old-shelf"]);
  });

  it("keeps everything recent when no Inbox is set", () => {
    const heads = [head("a", shelf, { updatedAt: 1 }), head("b", shelf, { updatedAt: 2 })];
    expect(captureRowsOf(heads, undefined, "").map((row) => row.artifactId)).toEqual(["b", "a"]);
  });

  it("does not offer an archived artifact: a capture is written, not tidied", () => {
    expect(ids([head("gone", shelf, { archived: true }), head("live", shelf)])).toEqual(["live"]);
  });

  it("ranks a title that names the word above a label that carries it", () => {
    const heads = [
      head("labelled", shelf, { title: "Storytelling", labels: ["planning"], updatedAt: 9 }),
      head("named", shelf, { title: "Launch plan", updatedAt: 1 }),
    ];
    expect(ids(heads, "plan")).toEqual(["named", "labelled"]);
  });

  it("finds a document by its words, and the quieter line names type and labels", () => {
    const heads = [
      head("words", shelf, { title: "Notes", markdown: "the release checklist", updatedAt: 2 }),
      head("other", shelf, { title: "Something else", labels: ["release"], updatedAt: 1 }),
    ];
    expect(ids(heads, "checklist")).toEqual(["words"]);
    expect(captureRowsOf(heads, inbox, "")[1]?.detail).toBe("Document, release");
  });

  it("says nothing for a word no artifact holds", () => {
    expect(ids([head("a", shelf, { title: "Alpha" })], "zebra")).toEqual([]);
  });
});
