import { describe, expect, it, vi } from "vitest";
import { parseFilePath, type FilesNodeRef, type FilesResult, type FilesSearchResult } from "../src/shared/files";
import { asNodeId } from "../src/shared/physics/schema";
import {
  fileQuickOpen,
  itemsQuickOpen,
  QUICK_OPEN_LIMIT,
  QUICK_OPEN_WORDS,
  type QuickOpenItem,
  type QuickOpenSource,
} from "../src/renderer/lib/quick-open";
import { registerQuickOpenHost, toggleQuickOpenFor } from "../src/renderer/lib/quick-open-host";
import { artifactQuickOpen, labelsOf } from "../src/renderer/components/artifacts/artifacts-pane-model";
import type { ArtifactHead } from "../src/shared/resource-ipc";

const node = asNodeId("shelf");
const ref: FilesNodeRef = { canvas: "canvas", node };
const path = (raw: string): NonNullable<ReturnType<typeof parseFilePath>> => parseFilePath(raw)!;

/** Artifacts as the palette sees them: a title, and the type as prose. */
const artifacts = [
  { id: "a1", title: "Launch brief", noun: "Document" },
  { id: "a2", title: "Sprint notes", noun: "Sheet" },
  { id: "a3", title: "Design references", noun: "Link" },
];
/** An item source answers synchronously: the palette alone handles a promise. */
const rowsOf = (source: QuickOpenSource, query: string): ReadonlyArray<QuickOpenItem> => {
  const answer = source.search(query);
  if (answer instanceof Promise) throw new Error("the items sources answer synchronously");
  return answer;
};

/** A file source's answer, whichever half of the contract it takes. */
const filesOf = async (source: QuickOpenSource, query: string): Promise<ReadonlyArray<QuickOpenItem>> =>
  await source.search(query);

const artifactSource = () =>
  itemsQuickOpen({
    kind: "artifact",
    items: artifacts,
    itemOf: ({ id, title, noun }) => ({
      row: { id, title, detail: noun },
      match: { identity: [title], metadata: [noun] },
    }),
  });

describe("items a node already holds", () => {
  it("opens on the list's own order, and says nothing matched only when asked", () => {
    const source = artifactSource();
    expect(rowsOf(source, "").map((row) => row.title)).toEqual(["Launch brief", "Sprint notes", "Design references"]);
    expect(rowsOf(source, "zzz")).toEqual([]);
  });

  it("ranks a name hit over prose, through the shared matcher", () => {
    const source = artifactSource();
    // "sheet" is a metadata hit on Sprint notes, and no title starts with it.
    expect(rowsOf(source, "sheet").map((row) => row.title)).toEqual(["Sprint notes"]);
    // A title prefix always leads.
    expect(rowsOf(source, "launch").map((row) => row.title)).toEqual(["Launch brief"]);
  });

  it("carries the kind and the quieter line each row shows", () => {
    const [row] = rowsOf(artifactSource(), "launch");
    expect(row).toEqual({ id: "a1", title: "Launch brief", detail: "Document", kind: "artifact" });
  });

  it("offers no more than the palette can hold", () => {
    const many = Array.from({ length: QUICK_OPEN_LIMIT + 12 }, (_, index) => ({ id: `t${String(index)}`, title: `Task ${String(index)}` }));
    const source = itemsQuickOpen({
      kind: "task",
      items: many,
      itemOf: ({ id, title }) => ({ row: { id, title }, match: { identity: [title] } }),
    });
    expect(rowsOf(source, "")).toHaveLength(QUICK_OPEN_LIMIT);
  });
});

describe("file names ranked by main", () => {
  const answerOf = (matches: ReadonlyArray<string>): FilesResult<FilesSearchResult> => ({
    ok: true,
    value: { kind: "results", query: "q", matches: matches.map((raw) => ({ path: path(raw), positions: [] })), total: matches.length },
  });

  it("leads each row with the name and names the folder under it", async () => {
    const search = vi.fn(async () => answerOf(["src/editor/big.ts", "README.md"]));
    const source = fileQuickOpen({ canvas: "canvas", node, search });
    await expect(filesOf(source, "big")).resolves.toEqual([
      { id: "src/editor/big.ts", title: "big.ts", detail: "src/editor", kind: "file" },
      // A file at the root has no folder to say.
      { id: "README.md", title: "README.md", kind: "file" },
    ]);
  });

  it("asks main for the node with a rising seq, and drops the answer a newer one replaced", async () => {
    const answers: Array<FilesResult<FilesSearchResult>> = [
      answerOf(["a.ts"]),
      { ok: true, value: { kind: "superseded", query: "ab" } },
      { ok: false, error: "root-missing" },
    ];
    const search = vi.fn(async (_ref: FilesNodeRef, _query: string, _seq: number) => answers.shift()!);
    const source = fileQuickOpen({ canvas: "canvas", node, search });
    expect((await filesOf(source, "a")).map((row) => row.id)).toEqual(["a.ts"]);
    expect(await filesOf(source, "ab")).toEqual([]);
    expect(await filesOf(source, "abc")).toEqual([]);
    expect(search.mock.calls.map(([, query, seq]) => [query, seq])).toEqual([
      ["a", 1],
      ["ab", 2],
      ["abc", 3],
    ]);
    for (const [target] of search.mock.calls) expect(target).toEqual(ref);
  });

  it("calls itself what the Files node's button says", () => {
    const source = fileQuickOpen({ canvas: "canvas", node, search: vi.fn(async () => answerOf([])) });
    expect(source.find).toBe(QUICK_OPEN_WORDS.file.find);
    expect(source.find).toBe("Find a file");
    expect(source.placeholder).toBe(QUICK_OPEN_WORDS.file.placeholder);
  });
});

describe("artifact labels in the palette", () => {
  /** The palette reads only these fields off a head: the rest is not its business. */
  const head = (title: string, type: "document" | "sheet", labels: ReadonlyArray<string> = []): ArtifactHead =>
    ({ artifact: { artifactId: title, title, type, labels } }) as unknown as ArtifactHead;

  it("finds an artifact by a label, and ranks a title hit above it", () => {
    const entries = [head("Sprint notes", "sheet", ["project/junto/release"]), head("Release plan", "document")];
    const source = artifactQuickOpen(entries);
    expect(rowsOf(source, "release").map((row) => row.title)).toEqual(["Release plan", "Sprint notes"]);
    // The label alone finds its artifact, with no title match at all.
    expect(rowsOf(source, "junto").map((row) => row.title)).toEqual(["Sprint notes"]);
  });

  it("reads a label as one whole word, never as letters scattered through it", () => {
    const source = artifactQuickOpen([head("Sprint notes", "sheet", ["project/junto/release"])]);
    expect(rowsOf(source, "pjr")).toEqual([]);
  });

  it("ties a title that merely contains the word, and the list's order decides", () => {
    // Both score 2000: "Explanations" holds the letters in one run, the label
    // is metadata. The row that was already first stays first.
    const entries = [head("Explanations", "document"), head("Sprint notes", "sheet", ["planning"])];
    expect(rowsOf(artifactQuickOpen(entries), "plan").map((row) => row.title)).toEqual(["Explanations", "Sprint notes"]);
  });

  it("beats a title that only has the letters in order", () => {
    // "pl an" is a 1000 subsequence; the label's 2000 wins, which is the one
    // boundary where a label leads.
    const entries = [head("pl an", "document"), head("Sprint notes", "sheet", ["planning"])];
    expect(rowsOf(artifactQuickOpen(entries), "plan").map((row) => row.title)).toEqual(["Sprint notes", "pl an"]);
  });

  it("reads no labels off a head that carries none", () => {
    // The record decodes every head to an array, old rows as [], so this is
    // the shape the palette sees and not an absence to guard against.
    const bare = head("Launch brief", "document");
    expect(labelsOf(bare.artifact)).toEqual([]);
    expect(rowsOf(artifactQuickOpen([bare]), "launch").map((row) => row.title)).toEqual(["Launch brief"]);
    expect(rowsOf(artifactQuickOpen([bare]), "release")).toEqual([]);
  });

  it("names the labels on the row's quieter line, so a label hit says why it is there", () => {
    const labelled = [head("Explanations", "document", ["planning", "project/junto"])];
    expect(rowsOf(artifactQuickOpen(labelled), "plan")[0]?.detail).toBe("Document, planning, project/junto");
    // With no labels the line is the type alone, as it has always read.
    expect(rowsOf(artifactQuickOpen([head("Launch brief", "sheet")]), "launch")[0]?.detail).toBe("Sheet");
  });
});

describe("the chord reaches the node in front", () => {
  const hostOf = (nodeId: string, over: Partial<Parameters<typeof registerQuickOpenHost>[0]> = {}) => {
    let open = false;
    const host = {
      nodeId,
      enabled: true,
      open: () => {
        open = true;
      },
      close: () => {
        open = false;
      },
      isOpen: () => open,
      ...over,
    };
    return { host, showing: () => open };
  };

  it("opens the node's palette, then closes it on the next press", () => {
    const { host, showing } = hostOf("shelf");
    const unregister = registerQuickOpenHost(host);
    expect(toggleQuickOpenFor("shelf")).toBe(true);
    expect(showing()).toBe(true);
    expect(toggleQuickOpenFor("shelf")).toBe(true);
    expect(showing()).toBe(false);
    unregister();
  });

  it("passes the key when the node is not showing, is gone, or has nothing to search", () => {
    expect(toggleQuickOpenFor("nobody")).toBe(false);
    const unregister = registerQuickOpenHost(hostOf("empty", { enabled: false }).host);
    expect(toggleQuickOpenFor("empty")).toBe(false);
    unregister();
    expect(toggleQuickOpenFor("empty")).toBe(false);
  });

  it("answers for the node in front even when the workbench names another, as a card overlay is not a dock surface", () => {
    const { host, showing } = hostOf("shelf");
    const unregister = registerQuickOpenHost(host);
    // The key's action names the front node the workbench knows: a terminal.
    expect(toggleQuickOpenFor("terminal-1")).toBe(true);
    expect(showing()).toBe(true);
    unregister();
    expect(toggleQuickOpenFor("terminal-1")).toBe(false);
  });

  it("keeps the newest registration for a node when an older one unmounts late", () => {
    const older = hostOf("shelf");
    const registerOlder = registerQuickOpenHost(older.host);
    const newer = hostOf("shelf");
    const registerNewer = registerQuickOpenHost(newer.host);
    registerOlder();
    expect(toggleQuickOpenFor("shelf")).toBe(true);
    expect(newer.showing()).toBe(true);
    expect(older.showing()).toBe(false);
    registerNewer();
  });
});
