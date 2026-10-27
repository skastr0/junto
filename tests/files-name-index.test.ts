import { describe, expect, it } from "vitest";
import { foldForSearch, scoreFilePath } from "@shared/files";
import { MessageChannel } from "node:worker_threads";
import { NameIndexBuilder, scoreCodes } from "../src/main/junto/files/name-index";
import { portEngine, serveIndex, SWEEP_MAX } from "../src/main/junto/files/index-engine";

describe("name index", () => {
  it("removes, adds and sweeps folders by delta", async () => {
    const builder = new NameIndexBuilder();
    builder.add(["a/x.ts", "a/y.ts", "b/z.ts"]);
    const index = await builder.finish(async () => undefined);
    expect(index.size).toBe(3);
    index.remove("b/z.ts");
    index.add("c/w.ts");
    index.removeUnder(["a"]);
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

describe("index engine over a message port", () => {
  it("builds, searches with narrowing, applies deltas and drops, as the worker does", async () => {
    const { port1, port2 } = new MessageChannel();
    serveIndex(port2);
    const engine = portEngine(port1);
    try {
      engine.begin(1);
      engine.names(1, ["src/app.ts", "src/lib/util.ts"]);
      engine.names(1, ["README.md", "docs/guide.md"]);
      expect(await engine.finish(1)).toEqual({ size: 4, drift: 0 });
      expect((await engine.search(1, "s", "ts")).matches.map((match) => match.path)).toEqual(["src/app.ts", "src/lib/util.ts"]);
      expect(await engine.search(1, "s", "")).toEqual({ matches: [], total: 4 });
      const applied = await engine.apply(1, { adds: ["src/new.ts"], gone: ["docs", "README.md"], drop: ["src/app.ts"] });
      expect(applied).toMatchObject({ size: 2, overflow: false });
      expect((await engine.search(1, "s", "ts")).matches.map((match) => match.path).sort()).toEqual(["src/lib/util.ts", "src/new.ts"]);
      const many = Array.from({ length: SWEEP_MAX + 1 }, (_, i) => `gone-${String(i)}`);
      expect(await engine.apply(1, { adds: [], gone: many, drop: [] })).toMatchObject({ overflow: true });
      engine.drop(1);
      await expect(engine.search(1, "s", "ts")).rejects.toThrow("no index in slot 1");
      engine.lost(new Error("stopped"));
    } finally {
      port1.close();
      port2.close();
    }
  });

  it("a lost worker rejects every pending call", async () => {
    const { port1, port2 } = new MessageChannel();
    const engine = portEngine(port1);
    const pending = engine.finish(7);
    engine.lost(new Error("files index worker exited 1"));
    await expect(pending).rejects.toThrow("exited 1");
    port1.close();
    port2.close();
  });
});
