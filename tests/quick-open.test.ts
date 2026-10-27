import { describe, expect, it, vi } from "vitest";
import { parseFilePath, type FilesNodeRef, type FilesResult, type FilesSearchResult } from "../src/shared/files";
import { asNodeId } from "../src/shared/physics/schema";
import { fileQuickOpen, itemsQuickOpen, QUICK_OPEN_LIMIT, QUICK_OPEN_WORDS } from "../src/renderer/lib/quick-open";
import { registerQuickOpenHost, toggleQuickOpenFor } from "../src/renderer/lib/quick-open-host";

const node = asNodeId("shelf");
const ref: FilesNodeRef = { canvas: "canvas", node };
const path = (raw: string): NonNullable<ReturnType<typeof parseFilePath>> => parseFilePath(raw)!;

/** Artifacts as the palette sees them: a title, and the type as prose. */
const artifacts = [
  { id: "a1", title: "Launch brief", noun: "Document" },
  { id: "a2", title: "Sprint notes", noun: "Sheet" },
  { id: "a3", title: "Design references", noun: "Link" },
];
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
    expect(source.search("").map((row) => row.title)).toEqual(["Launch brief", "Sprint notes", "Design references"]);
    expect(source.search("zzz")).toEqual([]);
  });

  it("ranks a name hit over prose, through the shared matcher", () => {
    const source = artifactSource();
    // "sheet" is a metadata hit on Sprint notes, and no title starts with it.
    expect(source.search("sheet").map((row) => row.title)).toEqual(["Sprint notes"]);
    // A title prefix always leads.
    expect(source.search("launch").map((row) => row.title)).toEqual(["Launch brief"]);
  });

  it("carries the kind and the quieter line each row shows", () => {
    const [row] = artifactSource().search("launch");
    expect(row).toEqual({ id: "a1", title: "Launch brief", detail: "Document", kind: "artifact" });
  });

  it("offers no more than the palette can hold", () => {
    const many = Array.from({ length: QUICK_OPEN_LIMIT + 12 }, (_, index) => ({ id: `t${String(index)}`, title: `Task ${String(index)}` }));
    const source = itemsQuickOpen({
      kind: "task",
      items: many,
      itemOf: ({ id, title }) => ({ row: { id, title }, match: { identity: [title] } }),
    });
    expect(source.search("")).toHaveLength(QUICK_OPEN_LIMIT);
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
    await expect(source.search("big")).resolves.toEqual([
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
    const search = vi.fn(async () => answers.shift()!);
    const source = fileQuickOpen({ canvas: "canvas", node, search });
    expect((await source.search("a")).map((row) => row.id)).toEqual(["a.ts"]);
    expect(await source.search("ab")).toEqual([]);
    expect(await source.search("abc")).toEqual([]);
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
