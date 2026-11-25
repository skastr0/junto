import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Manifest } from "../scripts/collect-sourcemaps";
import { parseTarget, pickEntry, resolveLocation } from "../scripts/sourcemap-resolve";
import { decodeSegments, lineOrigins, lookup, type RawSourceMap } from "../scripts/source-map-lookup";

/**
 * A logged bundle line maps back to source with a release's source map
 * archive (docs/source-maps.md). The map here is built by an encoder written
 * in the test, so the decoder is checked against the format, not against itself.
 */

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const vlq = (value: number): string => {
  let rest = value < 0 ? -value * 2 + 1 : value * 2;
  let out = "";
  do {
    let digit = rest % 32;
    rest = Math.floor(rest / 32);
    if (rest > 0) digit += 32;
    out += BASE64[digit];
  } while (rest > 0);
  return out;
};
/** Segments as absolute [generatedColumn, source, sourceLine0, sourceColumn, name?] per generated line. */
const encode = (lines: ReadonlyArray<ReadonlyArray<ReadonlyArray<number>>>): string => {
  let source = 0, sourceLine = 0, sourceColumn = 0, name = 0;
  return lines
    .map((segments) => {
      let column = 0;
      return segments
        .map((segment) => {
          const [gc = 0, s = 0, sl = 0, sc = 0, n] = segment;
          let text = vlq(gc - column) + vlq(s - source) + vlq(sl - sourceLine) + vlq(sc - sourceColumn);
          column = gc;
          source = s;
          sourceLine = sl;
          sourceColumn = sc;
          if (n !== undefined) {
            text += vlq(n - name);
            name = n;
          }
          return text;
        })
        .join(",");
    })
    .join(";");
};

const map: RawSourceMap = {
  version: 3,
  sources: ["src/a.ts", "node_modules/lib/parse.js"],
  sourcesContent: ["export const a = 1;\nexport const b = a.trim();\n", "line one\nconst [, , name] = x;\nname.trim();\n"],
  names: ["a", "trim"],
  mappings: encode([
    [[0, 0, 0, 0], [7, 0, 0, 13, 0]],
    [[0, 0, 1, 0], [20, 0, 1, 17, 1]],
    [],
    [[2, 1, 2, 0, 1]],
  ]),
};

describe("source map lookup", () => {
  it("decodes every segment with its generated and original position", () => {
    const segments = decodeSegments(map);
    expect(segments.map((s) => [s.line, s.column, s.source, s.sourceLine, s.sourceColumn, s.name])).toEqual([
      [1, 0, "src/a.ts", 1, 0, undefined],
      [1, 7, "src/a.ts", 1, 13, "a"],
      [2, 0, "src/a.ts", 2, 0, undefined],
      [2, 20, "src/a.ts", 2, 17, "trim"],
      [4, 2, "node_modules/lib/parse.js", 3, 0, "trim"],
    ]);
  });

  it("finds the segment a column falls in, and none on a line the map skips", () => {
    const segments = decodeSegments(map);
    expect(lookup(segments, 2, 25)?.sourceColumn).toBe(17);
    expect(lookup(segments, 2, 5)?.sourceColumn).toBe(0);
    expect(lookup(segments, 3, 0)).toBeUndefined();
  });

  it("gives every original position a line holds when the log names no column", () => {
    expect(lineOrigins(decodeSegments(map), 1).map((s) => `${s.source}:${String(s.sourceLine)}`)).toEqual(["src/a.ts:1"]);
    // two segments of one original line are one origin: the line is what a log can name
    expect(lineOrigins(decodeSegments(map), 2).map((s) => `${s.source}:${String(s.sourceLine)}:${String(s.sourceColumn)}`)).toEqual(["src/a.ts:2:0"]);
  });
});

describe("the bundle line a log prints", () => {
  const manifest: Manifest = {
    schema: "junto/source-maps/v1",
    version: "1.2.3",
    commit: "a".repeat(40),
    collectedAt: "2026-11-25T00:00:00.000Z",
    maps: [
      { map: "out/renderer/assets/CodeView-Dti807Lo.js.map", mapBytes: 1, mapSha256: "x", bundle: "out/renderer/assets/CodeView-Dti807Lo.js", bundleSha256: null },
      { map: "out/main/index.js.map", mapBytes: 1, mapSha256: "x", bundle: "out/main/index.js", bundleSha256: null },
      { map: "out/preload/index.js.map", mapBytes: 1, mapSha256: "x", bundle: "out/preload/index.js", bundleSha256: null },
    ],
  };

  it("reads the renderer URL, a path in the build, and a bare name", () => {
    expect(parseTarget("junto-app://renderer/assets/CodeView-Dti807Lo.js:17736")).toEqual({ bundle: "assets/CodeView-Dti807Lo.js", line: 17736, column: undefined });
    expect(parseTarget("(junto-app://renderer/assets/CodeView-Dti807Lo.js:17736:9)")).toEqual({ bundle: "assets/CodeView-Dti807Lo.js", line: 17736, column: 9 });
    expect(parseTarget("out/main/core-process.js:2140:17")).toEqual({ bundle: "out/main/core-process.js", line: 2140, column: 17 });
    expect(() => parseTarget("no location here")).toThrow(/not a location/u);
  });

  it("picks the one map, by renderer URL, path or name, and refuses an unknown or ambiguous one", () => {
    expect(pickEntry(manifest, "assets/CodeView-Dti807Lo.js").bundle).toBe("out/renderer/assets/CodeView-Dti807Lo.js");
    expect(pickEntry(manifest, "out/main/index.js").bundle).toBe("out/main/index.js");
    expect(() => pickEntry(manifest, "index.js")).toThrow(/ambiguous/u);
    expect(() => pickEntry(manifest, "nothing.js")).toThrow(/no source map for nothing\.js/u);
  });

  describe("against an unpacked archive", () => {
    let folder = "";
    beforeEach(async () => {
      folder = await mkdtemp(join(tmpdir(), "junto-resolve-"));
      await mkdir(join(folder, "out/renderer/assets"), { recursive: true });
      await writeFile(join(folder, "manifest.json"), JSON.stringify(manifest));
      await writeFile(join(folder, "out/renderer/assets/CodeView-Dti807Lo.js.map"), JSON.stringify(map));
    });
    afterEach(async () => {
      await rm(folder, { recursive: true, force: true });
    });

    it("prints the original file, line and the source line for a line with no column", () => {
      const text = resolveLocation(folder, parseTarget("junto-app://renderer/assets/CodeView-Dti807Lo.js:4"));
      expect(text).toContain("node_modules/lib/parse.js:3:1 (trim)");
      expect(text).toContain("name.trim();");
      expect(text).toContain("1.2.3, commit aaaaaaaaaaaa");
    });

    it("prints the one segment a column falls in", () => {
      expect(resolveLocation(folder, parseTarget("assets/CodeView-Dti807Lo.js:2:25"))).toContain("src/a.ts:2:18 (trim)");
    });
  });
});
