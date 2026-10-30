import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MessageChannel } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import { foldForSearch, scoreFilePath } from "@shared/files";
import { NameIndexBuilder, scoreCodes } from "../src/main/junto/files/name-index";
import { spawnGit } from "../src/main/junto/files/git-spawn";
import type { RootEvent } from "../src/main/junto/files/root-index";
import { portRootIndex, serveRootIndex } from "../src/main/junto/files/root-index-port";

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

  it("scores files that share a folder as scoring each path whole does", async () => {
    let seed = 9;
    const pick = (text: string): string => text[(seed = (seed * 48271) % 2147483647) % text.length]!;
    const word = (len: number, from = "abcdes-_."): string => Array.from({ length: len }, () => pick(from)).join("");
    // Folders also hold "f" and "0", which no name does: a query ending in one matches only in the folder.
    const folders = [
      "",
      ...Array.from({ length: 40 }, (_, n) => Array.from({ length: 1 + (n % 4) }, () => word(2 + (n % 5), "abdf0-")).join("/")),
    ];
    const paths = new Set<string>();
    for (let n = 0; n < 4000; n += 1) {
      const folder = folders[n % folders.length]!;
      const name = word(1 + (n % 9));
      paths.add(folder === "" ? name : `${folder}/${name}`);
    }
    const builder = new NameIndexBuilder();
    builder.add([...paths]);
    const index = await builder.finish(async () => undefined);
    const brute = (query: string): number[] =>
      [...paths]
        .map((path) => scoreFilePath(foldForSearch(path), query))
        .filter((score): score is number => score !== undefined)
        .sort((a, b) => b - a)
        .slice(0, 25);
    for (const typed of ["abcd", "a/b", "s.e", "d/a-s", "_/_", "ee/", "cab.s", "/a", "aaaa", "af", "d0", "b/f", "fa0"]) {
      let previous: ReturnType<typeof index.search>["set"] | undefined;
      for (let end = 1; end <= typed.length; end += 1) {
        const query = typed.slice(0, end);
        for (const narrowed of [undefined, previous]) {
          const result = index.search(query, narrowed, 25);
          const got = result.matches.map((match) => scoreFilePath(foldForSearch(match.path), query)!);
          expect(got, query).toEqual(brute(query));
        }
        previous = index.search(query, previous, 25).set;
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

describe("names with a unit above U+00FF", () => {
  it("are found, removed and counted like any other, and are not drift", async () => {
    const builder = new NameIndexBuilder();
    builder.add(["docs/naïve.md", "docs/日本語-guide.md", "src/app.ts"]);
    const index = await builder.finish(async () => undefined);
    expect(index.size).toBe(3);
    expect(index.drift).toBe(0);
    expect(index.search("日本").matches.map((match) => match.path)).toEqual(["docs/日本語-guide.md"]);
    expect(index.search("naive").matches).toEqual([]);
    expect(index.search("naïve").matches.map((match) => match.path)).toEqual(["docs/naïve.md"]);
    expect(index.has("docs/日本語-guide.md")).toBe(true);
    index.remove("docs/日本語-guide.md");
    expect(index.size).toBe(2);
    expect(index.drift).toBe(1);
    expect(index.search("guide").matches).toEqual([]);
  });
});

describe("root index across a message port", () => {
  /** Poll on loop turns (git and lstat are real I/O), never on a clock. */
  const settled = async (check: () => Promise<boolean>): Promise<void> => {
    for (let turn = 0; turn < 20_000; turn += 1) {
      if (await check()) return;
      await new Promise((resolve) => setImmediate(resolve));
    }
    throw new Error("never settled");
  };

  it("holds, searches, counts and releases a git root, git spawned on the main side", async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "junto-root-port-")));
    const { port1, port2 } = new MessageChannel();
    try {
      mkdirSync(join(base, "src"));
      writeFileSync(join(base, "src", "app.ts"), "");
      writeFileSync(join(base, "README.md"), "");
      writeFileSync(join(base, ".gitignore"), "dist/\n");
      execFileSync("git", ["init", "-q", base]);
      let fire: ((event: string, filename: string | null) => void) | undefined;
      const queued: Array<() => void> = [];
      serveRootIndex(port2, {
        watch: (_root, listener) => {
          fire = listener;
          return { close: () => undefined };
        },
        timers: { set: (fn) => queued.push(fn), clear: () => undefined },
      });
      const events: RootEvent[] = [];
      const gitRuns: string[][] = [];
      const index = portRootIndex(port1, {
        git: (cwd, args, onBytes, signal, stdin) => {
          gitRuns.push([...args]);
          return spawnGit(cwd, args, onBytes, signal, stdin);
        },
        emit: (_root, event) => events.push(event),
      });
      expect(await index.hold(base, "s")).toEqual({ repo: true });
      expect((await index.search(base, "s", "app")).matches.map((match) => match.path)).toEqual(["src/app.ts"]);
      expect(await index.count(base)).toEqual({ files: 3, capped: false });
      expect(gitRuns.some((args) => args.includes("ls-files"))).toBe(true);
      writeFileSync(join(base, "src", "late.ts"), "");
      fire?.("rename", "src/late.ts");
      queued.shift()?.();
      await settled(async () => (await index.search(base, "s", "late")).matches.length === 1);
      expect(events.some((event) => event.kind === "paths")).toBe(true);
      expect(await index.release(base, "s")).toEqual({ files: 4, capped: false });
      expect(index.idle()).toBe(true);
    } finally {
      port1.close();
      port2.close();
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("a lost worker rejects every pending call", async () => {
    const { port1, port2 } = new MessageChannel();
    const index = portRootIndex(port1, { git: async () => 0, emit: () => undefined });
    const pending = index.count("/nowhere");
    index.lost(new Error("files index worker exited 1"));
    await expect(pending).rejects.toThrow("exited 1");
    port1.close();
    port2.close();
  });
});
