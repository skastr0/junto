import { describe, expect, it } from "vitest";
import { foldForSearch, scoreFilePath } from "@shared/files";
import { NameIndexBuilder, scoreCodes } from "../src/main/junto/files/name-index";

describe("name index", () => {
  it("removes, adds and sweeps folders by delta", async () => {
    const builder = new NameIndexBuilder();
    builder.add(["a/x.ts", "a/y.ts", "b/z.ts"]);
    const index = await builder.finish(async () => undefined);
    expect(index.size).toBe(3);
    index.remove("b/z.ts");
    index.add("c/w.ts");
    index.removeUnder("a");
    expect(index.size).toBe(1);
    expect(index.search("w").matches.map((match) => match.path)).toEqual(["c/w.ts"]);
    expect(index.search("ts").matches.map((match) => match.path)).toEqual(["c/w.ts"]);
  });

  it("scores packed codes exactly as the shared scorer does", () => {
    let seed = 11;
    const pick = (text: string): string => text[(seed = (seed * 48271) % 2147483647) % text.length]!;
    const alphabet = "abcse/-_.0ST";
    for (let n = 0; n < 2000; n += 1) {
      let path = "";
      for (let i = 0, len = 1 + (n % 30); i < len; i += 1) path += pick(alphabet);
      let query = "";
      for (let i = 0, len = 1 + (n % 4); i < len; i += 1) query += pick("abcse/.");
      const packed = `x/y\0${path}\0z`;
      const folded = foldForSearch(packed);
      const codes = Uint8Array.from(folded, (c) => c.charCodeAt(0));
      const from = 4;
      const to = from + path.length;
      const q = Uint16Array.from(query, (c) => c.charCodeAt(0));
      expect(scoreCodes(codes, from, to, q, Number.NEGATIVE_INFINITY), `${path} ${query}`).toBe(
        scoreFilePath(folded, query, undefined, from, to),
      );
    }
  });

  it("finds the same best scores as scoring every path, with every cut and narrowing on", async () => {
    let seed = 5;
    const pick = (text: string): string => text[(seed = (seed * 48271) % 2147483647) % text.length]!;
    const paths = new Set<string>();
    while (paths.size < 3000) {
      let path = "";
      for (let i = 0, len = 3 + (paths.size % 40); i < len; i += 1) path += pick("abcdese/-_.0");
      if (!path.startsWith("/") && !path.endsWith("/") && !path.includes("//")) paths.add(path);
    }
    const builder = new NameIndexBuilder();
    builder.add([...paths]);
    const index = await builder.finish(async () => undefined);
    const brute = (query: string): number[] =>
      [...paths]
        .map((path) => scoreFilePath(foldForSearch(path), query))
        .filter((score): score is number => score !== undefined)
        .sort((a, b) => b - a)
        .slice(0, 7);
    for (const typed of ["s", "se", "ses", "s/", "s/e", "a.e", "-d", "zz"]) {
      let previous: ReturnType<typeof index.search>["set"] | undefined;
      for (let end = 1; end <= typed.length; end += 1) {
        const query = typed.slice(0, end);
        const result = index.search(query, previous, 7);
        previous = result.set;
        const got = result.matches.map((match) => scoreFilePath(foldForSearch(match.path), query)!);
        expect(got, query).toEqual(brute(query));
      }
    }
  });

  it("narrows a growing query from the previous match set", async () => {
    const builder = new NameIndexBuilder();
    builder.add(["src/alpha.ts", "src/beta.ts", "docs/alphabet.md"]);
    const index = await builder.finish(async () => undefined);
    const one = index.search("al");
    expect(one.set.ids.length).toBe(2);
    const two = index.search("alpha.t", one.set);
    expect(two.matches.map((match) => match.path)).toEqual(["src/alpha.ts"]);
  });
});
