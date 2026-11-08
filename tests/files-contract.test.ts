import { describe, expect, it } from "vitest";
import {
  foldForSearch,
  joinFilePath,
  parentOf,
  parseFilePath,
  ROOT_PATH,
  scoreFilePath,
  type FilePath,
} from "@shared/files";
import { fileMime, fileUrl, parseFileUrl } from "@shared/file-url";

const path = (raw: string): FilePath => {
  const parsed = parseFilePath(raw);
  if (parsed === undefined) throw new Error(`not a path: ${raw}`);
  return parsed;
};

describe("FilePath", () => {
  it("accepts relative slash paths and the root", () => {
    expect(parseFilePath("")).toBe(ROOT_PATH);
    expect(parseFilePath("src/a b/c.ts")).toBe("src/a b/c.ts");
    expect(parseFilePath(".gitignore")).toBe(".gitignore");
    expect(parseFilePath("a/..b/c")).toBe("a/..b/c");
  });

  it("refuses anything that could name a place outside the root", () => {
    for (const raw of ["/etc/passwd", "..", "a/../b", "a/./b", "a//b", "a/", "a\\b", "a\0b", "./a"]) {
      expect(parseFilePath(raw), raw).toBeUndefined();
    }
    expect(parseFilePath(42)).toBeUndefined();
    expect(parseFilePath("a".repeat(256))).toBeUndefined();
  });

  it("joins and splits", () => {
    expect(joinFilePath(ROOT_PATH, "a.ts")).toBe("a.ts");
    expect(joinFilePath(path("src"), "a.ts")).toBe("src/a.ts");
    expect(joinFilePath(path("src"), "x/y")).toBeUndefined();
    expect(joinFilePath(path("src"), "..")).toBeUndefined();
    expect(parentOf(path("src/a.ts"))).toBe("src");
    expect(parentOf(path("a.ts"))).toBe(ROOT_PATH);
  });
});

describe("junto-file URL", () => {
  it("round-trips node and path, lower-casing the node", () => {
    const url = fileUrl("files-01M5Z6HYFZY0C19XKP9Y1GY5RH", path("docs/a b#1?.pdf"), 12);
    expect(url).toBe("junto-file://files-01m5z6hyfzy0c19xkp9y1gy5rh/docs/a%20b%231%3F.pdf?v=12");
    expect(parseFileUrl(url)).toEqual({ node: "files-01m5z6hyfzy0c19xkp9y1gy5rh", path: "docs/a b#1?.pdf" });
  });

  it("refuses traversal, encoded slashes, credentials and other schemes", () => {
    for (const url of [
      "junto-file://files-1/a%2Fb",
      "junto-file://files-1/a%5Cb",
      "junto-file://files-1/",
      "junto-file://u:p@files-1/a",
      "junto-file://files-1/a?path=/etc/passwd",
      "junto-file://files-1/a#x",
      "junto-content://files-1/a",
      "junto-file://files-1\\a",
      "junto-file://bad.host/a",
    ]) {
      expect(parseFileUrl(url), url).toBeUndefined();
    }
    // The URL parser collapses ".." (encoded too): it cannot climb above the host.
    expect(parseFileUrl("junto-file://files-1/a/../b")).toEqual({ node: "files-1", path: "b" });
    expect(parseFileUrl("junto-file://files-1/%2e%2e/etc/passwd")).toEqual({ node: "files-1", path: "etc/passwd" });
  });

  it("serves only previewable types as themselves", () => {
    expect(fileMime("a/b.PDF")).toBe("application/pdf");
    expect(fileMime("x.svg")).toBe("image/svg+xml");
    expect(fileMime("index.html")).toBe("application/octet-stream");
    expect(fileMime("Makefile")).toBe("application/octet-stream");
  });
});

describe("scoreFilePath", () => {
  const rank = (query: string, paths: ReadonlyArray<string>): ReadonlyArray<string> =>
    paths
      .map((p) => ({ p, s: scoreFilePath(foldForSearch(p), foldForSearch(query)) }))
      .filter((x): x is { p: string; s: number } => x.s !== undefined)
      .sort((a, b) => b.s - a.s)
      .map((x) => x.p);

  it("needs every query character in order", () => {
    expect(scoreFilePath("src/index.ts", "sit")).toBeDefined();
    expect(scoreFilePath("src/index.ts", "zz")).toBeUndefined();
    expect(scoreFilePath("ab", "abc")).toBeUndefined();
  });

  it("puts the file name first, then word starts, then shorter paths", () => {
    expect(rank("files", ["src/files/other.ts", "src/main/files.ts", "docs/f-i-l-e-s.md"])[0]).toBe("src/main/files.ts");
    expect(rank("fu", ["src/foobaru.ts", "src/file-url.ts"])[0]).toBe("src/file-url.ts");
    expect(rank("index", ["a/b/c/index.ts", "index.ts"])[0]).toBe("index.ts");
  });

  it("reports the matched positions", () => {
    const positions: number[] = [];
    scoreFilePath("src/file-url.ts", "fu", positions);
    expect(positions).toEqual([4, 9]);
  });
});
