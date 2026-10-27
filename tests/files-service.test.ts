import { mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  FILE_TEXT_MAX_BYTES,
  parseFilePath,
  ROOT_PATH,
  type FilePath,
  type FilesChanged,
  type FilesNodeRef,
  type FilesResult,
} from "@shared/files";
import { fileUrl } from "@shared/file-url";
import { asNodeId } from "@shared/physics/schema";
import { makeFilesService, type FilesNodeFacts, type NameSources } from "../src/main/junto/files/service";
import { numberedName } from "../src/main/junto/files/fs-ops";
import { createFileProtocolHandler } from "../src/main/junto/files/protocol";
import { NameIndexBuilder } from "../src/main/junto/files/name-index";
import { BURST, watchRoot, type WatchFactory } from "../src/main/junto/files/watcher";

const p = (raw: string): FilePath => {
  const path = parseFilePath(raw);
  if (path === undefined) throw new Error(raw);
  return path;
};

const value = <A>(result: FilesResult<A>): A => {
  if (!result.ok) throw new Error(`refused: ${result.error}`);
  return result.value;
};

const errorOf = <A>(result: FilesResult<A>): string | undefined => (result.ok ? undefined : result.error);

/** The walk only, in memory: names given, nothing spawned. */
const fakeNames = (names: () => ReadonlyArray<string>): NameSources => ({
  isGitRoot: async () => false,
  gitNames: async () => undefined,
  walkNames: async (_root, sink) => sink(names()),
  gitIgnored: async () => new Set(),
});

/** A watcher the test fires by hand, and timers it flushes by hand. */
const manualWatch = () => {
  let fire: ((event: string, filename: string | null) => void) | undefined;
  let lose: (() => void) | undefined;
  const factory: WatchFactory = (_root, listener, onError) => {
    fire = listener;
    lose = onError;
    return { close: () => undefined };
  };
  return { factory, fire: (name: string | null) => fire?.("rename", name), lose: () => lose?.() };
};

let base: string;
let root: string;
let outside: string;
let facts: FilesNodeFacts | undefined;
const ref: FilesNodeRef = { canvas: "main", node: asNodeId("files-01M5Z6HYFZY0C19XKP9Y1GY5RH") };

const service = (extra: Partial<Parameters<typeof makeFilesService>[0]> = {}) => {
  const sent: Array<{ subscriber: number; event: FilesChanged }> = [];
  const trashed: string[] = [];
  const files = makeFilesService({
    node: async () => facts,
    machineName: async () => "studio",
    deny: async () => [join(root, ".junto")],
    trash: async (absolute) => {
      trashed.push(absolute);
      await rm(absolute, { recursive: true });
    },
    openPath: async () => "",
    reveal: () => undefined,
    send: (subscriber, event) => sent.push({ subscriber, event }),
    watch: manualWatch().factory,
    names: fakeNames(() => []),
    ...extra,
  });
  return { files, sent, trashed };
};

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "junto-files-")));
  root = join(base, "root");
  outside = join(base, "outside");
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(outside);
  await writeFile(join(root, "src", "a.ts"), "export const a = 1;\n");
  await writeFile(join(root, "README.md"), "# hi\n");
  await writeFile(join(outside, "secret.txt"), "secret\n");
  await symlink(join(outside, "secret.txt"), join(root, "link-out.txt"));
  await symlink(outside, join(root, "dir-out"));
  facts = { host: "studio", root };
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("which node is served", () => {
  it("refuses a missing node, another machine's node and a root that is gone", async () => {
    const { files } = service();
    facts = undefined;
    expect(errorOf(await files.read(ref, p("README.md")))).toBe("no-node");
    facts = { host: "laptop", root };
    expect(errorOf(await files.read(ref, p("README.md")))).toBe("elsewhere");
    facts = { host: "studio", root: join(base, "nope") };
    expect(errorOf(await files.read(ref, p("README.md")))).toBe("root-missing");
    facts = { host: "studio", root: "relative/path" };
    expect(errorOf(await files.read(ref, p("README.md")))).toBe("root-missing");
  });

  it("names the root only by its last segment", async () => {
    const { files } = service();
    expect(value(await files.open(1, ref))).toEqual({ name: "root", repo: false });
  });
});

describe("root scoping", () => {
  it("refuses symlinks out of the root for every content call", async () => {
    const { files } = service();
    expect(errorOf(await files.read(ref, p("link-out.txt")))).toBe("outside-root");
    expect(errorOf(await files.read(ref, p("dir-out/secret.txt")))).toBe("outside-root");
    expect(errorOf(await files.list(ref, p("dir-out")))).toBe("outside-root");
    expect(errorOf(await files.write(ref, p("link-out.txt"), "x", { mtimeMs: 0, size: 0 }))).toBe("outside-root");
    expect(errorOf(await files.create(ref, p("dir-out/new.txt"), false))).toBe("outside-root");
    expect(errorOf(await files.move(ref, p("README.md"), p("dir-out")))).toBe("outside-root");
    expect(errorOf(await files.openInDefaultApp(ref, p("link-out.txt")))).toBe("outside-root");
    expect(errorOf(await files.revealInFinder(ref, p("dir-out")))).toBe("outside-root");
    expect(await readFile(join(outside, "secret.txt"), "utf8")).toBe("secret\n");
  });

  it("refuses Junto's own home inside a root", async () => {
    await mkdir(join(root, ".junto", "state"), { recursive: true });
    await writeFile(join(root, ".junto", "state", "junto.db"), "db");
    await symlink(join(root, ".junto", "state", "junto.db"), join(root, "db-link"));
    const { files } = service();
    expect(errorOf(await files.read(ref, p(".junto/state/junto.db")))).toBe("denied");
    expect(errorOf(await files.read(ref, p("db-link")))).toBe("denied");
    expect(errorOf(await files.list(ref, p(".junto")))).toBe("denied");
    expect(errorOf(await files.trash(ref, p(".junto")))).toBe("denied");
    expect(errorOf(await files.rename(ref, p(".junto"), "x"))).toBe("denied");
    expect(errorOf(await files.create(ref, p(".junto/new"), false))).toBe("denied");
    expect(value(await files.read(ref, p("README.md")))).toMatchObject({ kind: "text" });
  });

  it("trashes a symlink itself, never what it points at", async () => {
    const { files, trashed } = service();
    value(await files.trash(ref, p("link-out.txt")));
    expect(trashed).toEqual([join(root, "link-out.txt")]);
    expect(await readFile(join(outside, "secret.txt"), "utf8")).toBe("secret\n");
    expect(errorOf(await files.trash(ref, ROOT_PATH))).toBe("invalid-path");
  });
});

describe("list and read", () => {
  it("lists folders first, symlinks as what they point at, .git hidden", async () => {
    await mkdir(join(root, ".git"));
    const { files } = service();
    const entries = value(await files.list(ref, ROOT_PATH));
    expect(entries.map((entry) => [entry.path, entry.dir])).toEqual([
      ["dir-out", true],
      ["src", true],
      ["link-out.txt", false],
      ["README.md", false],
    ]);
  });

  it("reads text with its stamp, a binary by type, and caps text", async () => {
    await writeFile(join(root, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]));
    await writeFile(join(root, "big.txt"), "a".repeat(FILE_TEXT_MAX_BYTES + 1));
    await writeFile(join(root, "latin1.txt"), Buffer.from([0x63, 0x61, 0x66, 0xe9]));
    const { files } = service();
    const text = value(await files.read(ref, p("README.md")));
    expect(text).toMatchObject({ kind: "text", text: "# hi\n", stamp: { size: 5 } });
    expect(value(await files.read(ref, p("logo.png")))).toMatchObject({ kind: "binary", mime: "image/png" });
    expect(value(await files.read(ref, p("big.txt")))).toMatchObject({ kind: "too-large", size: FILE_TEXT_MAX_BYTES + 1 });
    expect(value(await files.read(ref, p("latin1.txt")))).toMatchObject({ kind: "binary" });
    expect(errorOf(await files.read(ref, p("src")))).toBe("is-dir");
    expect(errorOf(await files.read(ref, p("nope.txt")))).toBe("not-found");
  });
});

describe("write", () => {
  it("writes against the stamp it read and refuses a stale one", async () => {
    const { files } = service();
    const read = value(await files.read(ref, p("README.md")));
    if (read.kind !== "text") throw new Error("text");
    const next = value(await files.write(ref, p("README.md"), "# two\n", read.stamp));
    expect(next.size).toBe(6);
    expect(await readFile(join(root, "README.md"), "utf8")).toBe("# two\n");
    expect(errorOf(await files.write(ref, p("README.md"), "# three\n", read.stamp))).toBe("stale");
    expect(await readFile(join(root, "README.md"), "utf8")).toBe("# two\n");
  });

  it("keeps the file's mode", async () => {
    const { files } = service();
    const { chmod } = await import("node:fs/promises");
    await chmod(join(root, "README.md"), 0o600);
    const read = value(await files.read(ref, p("README.md")));
    if (read.kind !== "text") throw new Error("text");
    value(await files.write(ref, p("README.md"), "x", read.stamp));
    expect((await stat(join(root, "README.md"))).mode & 0o777).toBe(0o600);
  });
});

describe("create, rename, move", () => {
  it("never replaces what is there", async () => {
    const { files } = service();
    expect(value(await files.create(ref, p("src/b.ts"), false)).path).toBe("src/b.ts");
    expect(errorOf(await files.create(ref, p("src/b.ts"), false))).toBe("exists");
    expect(value(await files.create(ref, p("docs"), true)).dir).toBe(true);
    expect(errorOf(await files.rename(ref, p("src/b.ts"), "a.ts"))).toBe("exists");
    expect(errorOf(await files.rename(ref, p("src/b.ts"), "../x"))).toBe("invalid-path");
    expect(value(await files.rename(ref, p("src/b.ts"), "c.ts"))).toBe("src/c.ts");
    expect(value(await files.move(ref, p("src/c.ts"), p("docs")))).toBe("docs/c.ts");
    expect(errorOf(await files.move(ref, p("src"), p("src")))).toBe("invalid-path");
    expect(errorOf(await files.move(ref, p("README.md"), p("src/a.ts")))).toBe("not-dir");
  });
});

describe("import", () => {
  it("copies dropped files and folders, numbering taken names", async () => {
    const drops = join(base, "drops");
    await mkdir(join(drops, "folder"), { recursive: true });
    await writeFile(join(drops, "README.md"), "dropped\n");
    await writeFile(join(drops, "folder", "x.txt"), "x\n");
    const { files } = service();
    const imported = value(await files.import(ref, ROOT_PATH, [join(drops, "README.md"), join(drops, "folder")]));
    expect(imported).toEqual([
      { path: "README 2.md", dir: false },
      { path: "folder", dir: true },
    ]);
    expect(await readFile(join(root, "README.md"), "utf8")).toBe("# hi\n");
    expect(await readFile(join(root, "README 2.md"), "utf8")).toBe("dropped\n");
    expect(value(await files.import(ref, ROOT_PATH, [join(drops, "folder")]))).toEqual([{ path: "folder 2", dir: true }]);
    expect(await readFile(join(drops, "README.md"), "utf8")).toBe("dropped\n");
  });

  it("numbers names the Finder way", () => {
    expect(numberedName("a.txt", 2, false)).toBe("a 2.txt");
    expect(numberedName(".env", 3, false)).toBe(".env 3");
    expect(numberedName("my.folder", 2, true)).toBe("my.folder 2");
  });
});

describe("open in default app", () => {
  it("opens files and folders, the root too, and refuses what would run", async () => {
    const opened: string[] = [];
    const { files } = service({ openPath: async (absolute) => (opened.push(absolute), "") });
    await writeFile(join(root, "run.command"), "echo hi\n");
    await writeFile(join(root, "tool"), "#!/bin/sh\n", { mode: 0o755 });
    await mkdir(join(root, "Thing.app"));
    value(await files.openInDefaultApp(ref, p("README.md")));
    value(await files.openInDefaultApp(ref, ROOT_PATH));
    value(await files.openInDefaultApp(ref, p("src")));
    expect(opened).toEqual([join(root, "README.md"), root, join(root, "src")]);
    expect(errorOf(await files.openInDefaultApp(ref, p("run.command")))).toBe("denied");
    expect(errorOf(await files.openInDefaultApp(ref, p("tool")))).toBe("denied");
    expect(errorOf(await files.openInDefaultApp(ref, p("Thing.app")))).toBe("denied");
  });
});

describe("junto-file protocol", () => {
  it("serves an opened node's file with byte ranges, and nothing else", async () => {
    await writeFile(join(root, "doc.pdf"), "%PDF-0123456789");
    const { files } = service();
    const handler = createFileProtocolHandler((node, path) => files.bytes(node, path));
    const url = fileUrl(ref.node, p("doc.pdf"));
    expect((await handler(new Request(url))).status).toBe(404);
    value(await files.open(7, ref));
    const whole = await handler(new Request(url));
    expect(whole.status).toBe(200);
    expect(whole.headers.get("content-type")).toBe("application/pdf");
    expect(await whole.text()).toBe("%PDF-0123456789");
    const part = await handler(new Request(url, { headers: { Range: "bytes=5-8" } }));
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe("bytes 5-8/15");
    expect(await part.text()).toBe("0123");
    const out = await handler(new Request(fileUrl(ref.node, p("link-out.txt"))));
    expect(out.status).toBe(403);
    expect(await out.text()).not.toContain(base);
    expect((await handler(new Request(fileUrl(ref.node, p("README.md"))))).headers.get("content-type")).toBe(
      "application/octet-stream",
    );
    value(files.close(7, ref));
    expect((await handler(new Request(url))).status).toBe(404);
  });
});

describe("search", () => {
  it("ranks the index, drops a superseded query, and follows deltas", async () => {
    const watch = manualWatch();
    const queued: Array<() => void> = [];
    const all = ["src/a.ts", "src/files/service.ts", "src/main/files.ts", "README.md"];
    const { files, sent } = service({
      names: fakeNames(() => all),
      watch: watch.factory,
      timers: { set: (fn) => queued.push(fn), clear: () => undefined },
    });
    value(await files.open(1, ref));
    const first = files.search(1, ref, "files", 1);
    const second = files.search(1, ref, "files.ts", 2);
    expect(value(await first)).toEqual({ kind: "superseded", query: "files" });
    const result = value(await second);
    if (result.kind !== "results") throw new Error("results");
    expect(result.matches[0]?.path).toBe("src/main/files.ts");
    expect(result.total).toBe(4);

    await writeFile(join(root, "src", "new-files.ts"), "");
    watch.fire("src/new-files.ts");
    queued.shift()?.();
    expect(sent.at(-1)?.event).toEqual({ node: ref.node, kind: "paths", paths: ["src/new-files.ts"] });
    const after = value(await files.search(1, ref, "newfiles", 3));
    if (after.kind !== "results") throw new Error("results");
    expect(after.matches.map((match) => match.path)).toEqual(["src/new-files.ts"]);
  });

  it("drops the root's watcher and index with the last session", async () => {
    const { files } = service();
    value(await files.open(1, ref));
    value(await files.open(2, ref));
    expect(files.heldRoots()).toEqual([root]);
    files.closeSubscriber(1);
    expect(files.heldRoots()).toEqual([root]);
    value(files.close(2, ref));
    expect(files.heldRoots()).toEqual([]);
  });
});

describe("watcher", () => {
  it("coalesces, skips .git and node_modules, and folds a burst into one", () => {
    let listener: ((event: string, filename: string | null) => void) | undefined;
    const factory: WatchFactory = (_root, l) => {
      listener = l;
      return { close: () => undefined };
    };
    const queued: Array<() => void> = [];
    const batches: unknown[] = [];
    watchRoot("/r", (batch) => batches.push(batch), factory, {
      set: (fn) => queued.push(fn),
      clear: () => undefined,
    });
    listener?.("change", "a.ts");
    listener?.("change", "a.ts");
    listener?.("change", ".git/index");
    listener?.("change", "web/node_modules/x/y.js");
    expect(queued).toHaveLength(1);
    queued.shift()?.();
    expect(batches).toEqual([{ kind: "paths", paths: ["a.ts"] }]);
    for (let i = 0; i <= BURST; i += 1) listener?.("change", `f${String(i)}`);
    queued.shift()?.();
    expect(batches.at(-1)).toEqual({ kind: "burst" });
  });
});

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
