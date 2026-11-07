import { describe, expect, it } from "vitest";
import { FilesRefused, fitsOneFrame, HOST_FILES_ERRORS, FILES_LINK_TEXT_JSON_MAX } from "../src/shared/files-link";
import { FilesLink } from "../src/core/files/link";

/** One op's codecs: the ones the session decodes with at receipt and encodes with when it sends. */
const op = (tag: string) => FilesLink.requests.get(tag)!;
const decodeFilesEvent = FilesLink.events!.decode;

const where = { canvas: "factory", node: "files-1" };
const stamp = { mtimeMs: 1.5, size: 3 };

describe("the files link wire", () => {
  it("has one request per op, each with a node and a relative path", () => {
    expect([...FilesLink.requests.keys()].sort()).toEqual(
      ["Close", "Count", "Create", "Import", "List", "Move", "Open", "Read", "Rename", "Search", "Trash", "Write"],
    );
    for (const [tag, request] of [
      ["Open", where], ["Close", where], ["Count", where],
      ["List", { ...where, dir: "" }], ["Read", { ...where, path: "a/b.md" }],
      ["Write", { ...where, path: "a.md", text: "x", base: stamp }], ["Write", { ...where, path: "a.md", text: "x", base: null }],
      ["Create", { ...where, path: "n", dir: true }], ["Rename", { ...where, path: "a.md", name: "b.md" }],
      ["Move", { ...where, path: "a.md", into: "d" }], ["Trash", { ...where, path: "a.md" }],
      ["Import", { ...where, into: "d" }], ["Search", { ...where, query: "re", seq: 2 }],
    ] as const) expect(op(tag).payload.decode(request)).toEqual(request);
  });

  it("refuses a root, an absolute path, a command and any excess field", () => {
    for (const [tag, request] of [
      ["List", { ...where, dir: "", root: "/Users" }],
      ["Read", { ...where, path: "/etc/passwd" }],
      ["Read", { ...where, path: "../x" }],
      ["Read", { ...where, path: "a/../b" }],
      ["Read", { ...where, path: "a\\b" }],
      ["Read", { ...where, path: "a\0b" }],
      ["Read", { ...where, path: "a//b" }],
      ["Rename", { ...where, path: "a", name: "b/c" }],
      ["Rename", { ...where, path: "a", name: "" }],
      ["Import", { ...where, into: "d", sources: ["/Users/x/secret"] }],
      ["Open", { ...where, command: "sh" }],
      ["Open", { canvas: "Not Canonical", node: "files-1" }],
      ["Open", { canvas: "factory" }],
      // The tag is not in the payload: it crosses beside it.
      ["Open", { _tag: "Open", ...where }],
      ["Search", { ...where, query: "x".repeat(513), seq: 0 }],
      ["Search", { ...where, query: "x", seq: -1 }],
    ] as const) expect(() => op(tag).payload.decode(request), JSON.stringify(request)).toThrow();
    expect(FilesLink.requests.has("Exec")).toBe(false);
  });

  it("carries only the host's own refusals, never unreachable", () => {
    expect(HOST_FILES_ERRORS).not.toContain("unreachable");
    for (const error of HOST_FILES_ERRORS) {
      const refusal = op("Read").error.decode(op("Read").error.encode(new FilesRefused({ error })));
      expect(refusal).toBeInstanceOf(FilesRefused);
      expect(refusal).toMatchObject({ _tag: "FilesRefused", error });
      expect(decodeFilesEvent({ node: "files-1", kind: "closed", error })).toEqual({ node: "files-1", kind: "closed", error });
    }
    expect(() => op("Read").error.decode({ _tag: "FilesRefused", error: "unreachable" })).toThrow();
    expect(() => decodeFilesEvent({ node: "files-1", kind: "closed", error: "unreachable" })).toThrow();
  });

  it("decodes each op's answer and each event, and refuses a path outside the root in them", () => {
    for (const [tag, answer] of [
      ["Open", { name: "docs", repo: true }], ["Close", null], ["Count", { files: 3, capped: false }],
      ["List", [{ path: "a", dir: false, stamp }]],
      ["Read", { kind: "text", text: "hi", stamp }], ["Read", { kind: "binary", mime: "application/pdf", stamp }],
      ["Read", { kind: "too-large", size: 9, stamp }],
      ["Write", stamp], ["Create", { path: "n", dir: true, stamp }],
      ["Rename", "b"], ["Move", "d/b"], ["Trash", null],
      ["Import", [{ path: "d/x", dir: false }]],
      ["Search", { kind: "results", query: "a", matches: [{ path: "a", positions: [0] }], total: 1 }],
      ["Search", { kind: "superseded", query: "a" }],
    ] as const) expect(op(tag).success.decode(answer)).toEqual(answer);
    for (const event of [
      { node: "files-1", kind: "paths", paths: ["a", "d/b"] }, { node: "files-1", kind: "reset" },
      { node: "files-1", kind: "missing" }, { node: "files-1", kind: "back" },
    ]) expect(decodeFilesEvent(event)).toEqual(event);
    expect(() => op("List").success.decode([{ path: "/abs", dir: false, stamp }])).toThrow();
    expect(() => op("Open").success.decode({ name: "docs", repo: true, path: "/Users/x/docs" })).toThrow();
    expect(() => decodeFilesEvent({ node: "files-1", kind: "paths", paths: ["../x"] })).toThrow();
    const moved = { node: "files-1", kind: "paths", paths: ["b.md"], moves: [{ from: "a.md", to: "b.md" }] };
    expect(decodeFilesEvent(moved)).toEqual(moved);
    for (const bad of [{ from: "/abs", to: "b.md" }, { from: "a.md", to: "../b.md" }, { from: "a.md" }, { from: "a.md", to: "b.md", via: "x" }])
      expect(() => decodeFilesEvent({ ...moved, moves: [bad] }), JSON.stringify(bad)).toThrow();
  });

  it("measures what fits one frame as JSON", () => {
    expect(fitsOneFrame("a".repeat(1000))).toBe(true);
    expect(fitsOneFrame("a".repeat(FILES_LINK_TEXT_JSON_MAX))).toBe(false);
    expect(fitsOneFrame("\n".repeat(FILES_LINK_TEXT_JSON_MAX / 2 + 1))).toBe(false);
  });
});
