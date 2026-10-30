import { describe, expect, it } from "vitest";
import {
  decodeFilesEvent, decodeFilesRequest, decodeFilesResponse, fitsOneFrame, HOST_FILES_ERRORS, FILES_LINK_TEXT_JSON_MAX,
} from "../src/shared/files-link";

const where = { canvas: "factory", node: "files-1" };
const stamp = { mtimeMs: 1.5, size: 3 };

describe("the files link wire", () => {
  it("decodes every op with a node and a relative path", () => {
    for (const request of [
      { _tag: "Open", ...where }, { _tag: "Close", ...where }, { _tag: "Count", ...where },
      { _tag: "List", ...where, dir: "" }, { _tag: "Read", ...where, path: "a/b.md" },
      { _tag: "Write", ...where, path: "a.md", text: "x", base: stamp }, { _tag: "Write", ...where, path: "a.md", text: "x", base: null },
      { _tag: "Create", ...where, path: "n", dir: true }, { _tag: "Rename", ...where, path: "a.md", name: "b.md" },
      { _tag: "Move", ...where, path: "a.md", into: "d" }, { _tag: "Trash", ...where, path: "a.md" },
      { _tag: "Import", ...where, into: "d" }, { _tag: "Search", ...where, query: "re", seq: 2 },
    ]) expect(decodeFilesRequest(request)).toEqual(request);
  });

  it("refuses a root, an absolute path, a command and any excess field", () => {
    for (const request of [
      { _tag: "List", ...where, dir: "", root: "/Users" },
      { _tag: "Read", ...where, path: "/etc/passwd" },
      { _tag: "Read", ...where, path: "../x" },
      { _tag: "Read", ...where, path: "a/../b" },
      { _tag: "Read", ...where, path: "a\\b" },
      { _tag: "Read", ...where, path: "a\0b" },
      { _tag: "Read", ...where, path: "a//b" },
      { _tag: "Rename", ...where, path: "a", name: "b/c" },
      { _tag: "Rename", ...where, path: "a", name: "" },
      { _tag: "Import", ...where, into: "d", sources: ["/Users/x/secret"] },
      { _tag: "Open", ...where, command: "sh" },
      { _tag: "Open", canvas: "Not Canonical", node: "files-1" },
      { _tag: "Open", canvas: "factory" },
      { _tag: "Exec", ...where },
      { _tag: "Search", ...where, query: "x".repeat(513), seq: 0 },
      { _tag: "Search", ...where, query: "x", seq: -1 },
    ]) expect(() => decodeFilesRequest(request), JSON.stringify(request)).toThrow();
  });

  it("carries only the host's own refusals, never unreachable", () => {
    expect(HOST_FILES_ERRORS).not.toContain("unreachable");
    for (const error of HOST_FILES_ERRORS) {
      expect(decodeFilesResponse({ _tag: "Refused", error })).toEqual({ _tag: "Refused", error });
      expect(decodeFilesEvent({ node: "files-1", kind: "closed", error })).toEqual({ node: "files-1", kind: "closed", error });
    }
    expect(() => decodeFilesResponse({ _tag: "Refused", error: "unreachable" })).toThrow();
    expect(() => decodeFilesEvent({ node: "files-1", kind: "closed", error: "unreachable" })).toThrow();
  });

  it("decodes each answer and event, and refuses a path outside the root in them", () => {
    for (const response of [
      { _tag: "Opened", root: { name: "docs", repo: true } }, { _tag: "Closed" }, { _tag: "Counted", files: 3, capped: false },
      { _tag: "Listed", entries: [{ path: "a", dir: false, stamp }] },
      { _tag: "Read", read: { kind: "text", text: "hi", stamp } }, { _tag: "Read", read: { kind: "binary", mime: "application/pdf", stamp } },
      { _tag: "Read", read: { kind: "too-large", size: 9, stamp } },
      { _tag: "Written", stamp }, { _tag: "Created", entry: { path: "n", dir: true, stamp } },
      { _tag: "Renamed", path: "b" }, { _tag: "Moved", path: "d/b" }, { _tag: "Trashed" },
      { _tag: "Imported", imported: [{ path: "d/x", dir: false }] },
      { _tag: "Searched", search: { kind: "results", query: "a", matches: [{ path: "a", positions: [0] }], total: 1 } },
      { _tag: "Searched", search: { kind: "superseded", query: "a" } },
    ]) expect(decodeFilesResponse(response)).toEqual(response);
    for (const event of [
      { node: "files-1", kind: "paths", paths: ["a", "d/b"] }, { node: "files-1", kind: "reset" },
      { node: "files-1", kind: "missing" }, { node: "files-1", kind: "back" },
    ]) expect(decodeFilesEvent(event)).toEqual(event);
    expect(() => decodeFilesResponse({ _tag: "Listed", entries: [{ path: "/abs", dir: false, stamp }] })).toThrow();
    expect(() => decodeFilesResponse({ _tag: "Opened", root: { name: "docs", repo: true, path: "/Users/x/docs" } })).toThrow();
    expect(() => decodeFilesEvent({ node: "files-1", kind: "paths", paths: ["../x"] })).toThrow();
  });

  it("measures what fits one frame as JSON", () => {
    expect(fitsOneFrame("a".repeat(1000))).toBe(true);
    expect(fitsOneFrame("a".repeat(FILES_LINK_TEXT_JSON_MAX))).toBe(false);
    expect(fitsOneFrame("\n".repeat(FILES_LINK_TEXT_JSON_MAX / 2 + 1))).toBe(false);
  });
});
