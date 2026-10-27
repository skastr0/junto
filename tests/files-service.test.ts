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
import { COUNT_KEEP_MS, makeFilesService, type FilesNodeFacts, type NameSources } from "../src/main/junto/files/service";
import { walkNames } from "../src/main/junto/files/sources";
import { mainNameSources } from "../src/main/junto/files/git-spawn";
import { execFileSync } from "node:child_process";
import { numberedName } from "../src/main/junto/files/fs-ops";
import { createFileProtocolHandler } from "../src/main/junto/files/protocol";
import { BURST, watchRoot, type WatchBatch, type WatchFactory } from "../src/main/junto/files/watcher";

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

describe("symlinks that point out of the root", () => {
  const listed = async (list: (sink: (names: ReadonlyArray<string>) => void) => Promise<void>) => {
    const names: string[] = [];
    await list((batch) => names.push(...batch));
    return names.sort();
  };

  it("the walk lists a link only when it resolves inside the root", async () => {
    await symlink(join(root, "README.md"), join(root, "link-in.md"));
    await symlink(join(root, "gone.txt"), join(root, "dangling.txt"));
    const signal = new AbortController().signal;
    expect(await listed((sink) => walkNames(root, sink, signal))).toEqual(["README.md", "link-in.md", "src/a.ts"]);
    // A folder of the root walked on its own still judges links by the root.
    await symlink(join(root, "README.md"), join(root, "src", "up.md"));
    await symlink(join(outside, "secret.txt"), join(root, "src", "out.txt"));
    expect(await listed((sink) => walkNames(join(root, "src"), sink, signal, undefined, root))).toEqual(["a.ts", "up.md"]);
  });

  it("git lists a tracked or untracked link only when it resolves inside the root", async () => {
    const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { stdio: "ignore" });
    git("init", "-q");
    await symlink(join(root, "README.md"), join(root, "link-in.md"));
    git("add", "README.md", "src/a.ts", "link-out.txt", "link-in.md");
    await symlink(join(outside, "secret.txt"), join(root, "untracked-out.txt"));
    await symlink(join(root, "src", "a.ts"), join(root, "untracked-in.ts"));
    await writeFile(join(root, "notes.txt"), "n\n");
    const signal = new AbortController().signal;
    expect(await listed((sink) => mainNameSources.gitNames(root, sink, signal))).toEqual([
      "README.md", "link-in.md", "notes.txt", "src/a.ts", "untracked-in.ts",
    ]);
  });

  it("the tree lists a link only when it resolves inside the root and outside Junto's home", async () => {
    await symlink(join(root, "README.md"), join(root, "link-in.md"));
    await symlink(join(root, "src"), join(root, "src-link"));
    await symlink(join(root, "gone.txt"), join(root, "dangling.txt"));
    await mkdir(join(root, ".junto"));
    await symlink(join(root, ".junto"), join(root, "home-link"));
    const { files } = service();
    const listing = value(await files.list(ref, ROOT_PATH)).map((entry) => [entry.path, entry.dir]);
    expect(listing).toEqual([
      ["src", true],
      ["src-link", true],
      ["link-in.md", false],
      ["README.md", false],
    ]);
  });

  it("a link that appears pointing out is never indexed", async () => {
    const watch = manualWatch();
    const queued: Array<() => void> = [];
    const { files } = service({
      watch: watch.factory,
      timers: { set: (fn) => queued.push(fn), clear: () => undefined },
      names: fakeNames(() => ["README.md"]),
    });
    value(await files.open(1, ref));
    value(await files.search(1, ref, "md", 1));
    await symlink(join(outside, "secret.txt"), join(root, "new-out.txt"));
    await symlink(join(root, "README.md"), join(root, "new-in.txt"));
    watch.fire("new-out.txt");
    watch.fire("new-in.txt");
    while (queued.length > 0) queued.shift()?.();
    await files.settle();
    const found = value(await files.search(1, ref, "new", 2));
    expect(found).toMatchObject({ matches: [{ path: "new-in.txt" }] });
  });
});

describe("comment threads follow a move", () => {
  it("carries from the old path to the new after a rename or move lands, and answers even if carrying fails", async () => {
    const carried: Array<[string, string]> = [];
    let fail = false;
    const { files } = service({
      carryThreads: async (_ref, from, to) => {
        carried.push([from, to]);
        if (fail) throw new Error("db busy");
      },
    });
    expect(value(await files.rename(ref, p("README.md"), "INTRO.md"))).toBe("INTRO.md");
    expect(value(await files.move(ref, p("INTRO.md"), p("src")))).toBe("src/INTRO.md");
    expect(errorOf(await files.rename(ref, p("nope.md"), "x.md"))).toBe("not-found");
    fail = true;
    expect(value(await files.rename(ref, p("src"), "lib"))).toBe("lib");
    expect(carried).toEqual([["README.md", "INTRO.md"], ["INTRO.md", "src/INTRO.md"], ["src", "lib"]]);
  });
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
  it("lists folders first, .git hidden, links out of the root left out", async () => {
    await mkdir(join(root, ".git"));
    const { files } = service();
    const entries = value(await files.list(ref, ROOT_PATH));
    expect(entries.map((entry) => [entry.path, entry.dir])).toEqual([
      ["src", true],
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

  it("never copies Junto's home in, named or inside a dropped folder", async () => {
    const home = join(base, "home");
    await mkdir(join(home, ".junto"), { recursive: true });
    await writeFile(join(home, ".junto", "seat.token"), "SECRET");
    await writeFile(join(home, "notes.txt"), "notes\n");
    const { files } = service({ deny: async () => [join(home, ".junto")] });
    expect(errorOf(await files.import(ref, ROOT_PATH, [join(home, ".junto", "seat.token")]))).toBe("denied");
    expect(errorOf(await files.import(ref, ROOT_PATH, [join(home, ".junto")]))).toBe("denied");
    expect(value(await files.import(ref, ROOT_PATH, [home]))).toEqual([{ path: "home", dir: true }]);
    expect(await readFile(join(root, "home", "notes.txt"), "utf8")).toBe("notes\n");
    await expect(stat(join(root, "home", ".junto"))).rejects.toThrow();
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
    await files.settle();
    const after = value(await files.search(1, ref, "newfiles", 3));
    if (after.kind !== "results") throw new Error("results");
    expect(after.matches.map((match) => match.path)).toEqual(["src/new-files.ts"]);
  });

  it("a search or open that waited across a close holds nothing", async () => {
    let gate: (() => void) | undefined;
    const { files } = service({
      names: fakeNames(() => ["a.ts"]),
      node: async () => {
        if (gate !== undefined) await new Promise<void>((resolve) => (gate = resolve));
        return facts;
      },
    });
    value(await files.open(1, ref));
    gate = () => undefined;
    const searching = files.search(1, ref, "a", 1);
    value(files.close(1, ref));
    gate();
    expect(errorOf(await searching)).toBe("no-node");
    expect(files.heldRoots()).toEqual([]);
    expect(errorOf(await files.bytes(ref.node.toLowerCase(), p("a.ts")))).toBe("no-node");
    gate = () => undefined;
    const opening = files.open(1, ref);
    value(files.close(1, ref));
    gate();
    expect(errorOf(await opening)).toBe("no-node");
    expect(files.heldRoots()).toEqual([]);
  });

  it("a search after the node's root moved asks for open again", async () => {
    const { files } = service({ names: fakeNames(() => ["a.ts"]) });
    value(await files.open(1, ref));
    facts = { host: "studio", root: outside };
    expect(errorOf(await files.search(1, ref, "a", 1))).toBe("no-node");
    expect(files.heldRoots()).toEqual([root]);
    value(await files.open(1, ref));
    expect(files.heldRoots()).toEqual([outside]);
    expect(value(await files.search(1, ref, "secret", 2))).toMatchObject({ kind: "results" });
  });

  it("a close during a search already in the index leaves no watcher behind", async () => {
    let watchers = 0;
    let release: (() => void) | undefined;
    const { files } = service({
      watch: () => {
        watchers += 1;
        return { close: () => (watchers -= 1) };
      },
      names: {
        ...fakeNames(() => ["a.ts"]),
        walkNames: async (_root, sink) => {
          await new Promise<void>((resolve) => (release = resolve));
          sink(["a.ts"]);
        },
      },
    });
    value(await files.open(1, ref));
    const searching = files.search(1, ref, "a", 1);
    while (release === undefined) await new Promise((resolve) => setImmediate(resolve));
    value(files.close(1, ref));
    expect(watchers).toBe(0);
    release();
    expect(value(await searching)).toEqual({ kind: "superseded", query: "a" });
    await files.settle();
    expect(watchers).toBe(0);
    expect(files.heldRoots()).toEqual([]);
  });

  it("a count taken before a hold never replaces the count the hold left", async () => {
    let listed = ["a.ts"];
    let gate: Promise<void> | undefined;
    let started: (() => void) | undefined;
    const walking = new Promise<void>((resolve) => (started = resolve));
    const { files } = service({
      names: {
        ...fakeNames(() => listed),
        walkNames: async (_root, sink) => {
          const names = listed;
          const held = gate;
          started?.();
          if (held !== undefined) await held;
          sink(names);
        },
      },
    });
    let open: (() => void) | undefined;
    gate = new Promise<void>((resolve) => (open = resolve));
    const early = files.count(ref);
    await walking;
    gate = undefined;
    listed = ["a.ts", "b.ts", "c.ts"];
    value(await files.open(1, ref));
    value(await files.search(1, ref, "a", 1));
    value(files.close(1, ref));
    expect(value(await files.count(ref))).toEqual({ files: 3, capped: false });
    open?.();
    expect(value(await early)).toEqual({ files: 1, capped: false });
    expect(value(await files.count(ref))).toEqual({ files: 3, capped: false });
  });

  it("an unheld count is taken again after a Junto write, or once it is 30 s old", async () => {
    let listed = ["README.md"];
    let clock = 1_000;
    const { files } = service({ names: fakeNames(() => listed), now: () => clock });
    expect(value(await files.count(ref))).toEqual({ files: 1, capped: false });
    listed = ["README.md", "new.txt"];
    value(await files.create(ref, p("new.txt"), false));
    expect(value(await files.count(ref))).toEqual({ files: 2, capped: false });
    // A change outside Junto (Finder, a shell): no watcher on an unheld root.
    listed = ["README.md", "new.txt", "finder.txt"];
    clock += COUNT_KEEP_MS - 1;
    expect(value(await files.count(ref))).toEqual({ files: 2, capped: false });
    clock += 1;
    expect(value(await files.count(ref))).toEqual({ files: 3, capped: false });
    // A refused write keeps the count.
    listed = [];
    expect(errorOf(await files.create(ref, p("new.txt"), false))).toBe("exists");
    expect(value(await files.count(ref))).toEqual({ files: 3, capped: false });
  });

  it("counts files for the card without a session, then from the held index", async () => {
    let listed = ["a.ts", "b.ts", "c/d.ts"];
    const { files } = service({ names: fakeNames(() => listed) });
    expect(value(await files.count(ref))).toEqual({ files: 3, capped: false });
    expect(files.heldRoots()).toEqual([]);
    listed = ["a.ts", "b.ts"];
    // Kept: a canvas of cards does not rescan.
    expect(value(await files.count(ref))).toEqual({ files: 3, capped: false });
    value(await files.open(1, ref));
    listed = ["a.ts"];
    expect(value(await files.count(ref))).toEqual({ files: 1, capped: false });
    value(files.close(1, ref));
    listed = ["x", "y", "z", "w"];
    expect(value(await files.count(ref))).toEqual({ files: 1, capped: false });
    facts = { host: "laptop", root };
    expect(errorOf(await files.count(ref))).toBe("elsewhere");
  });

  it("sweeps a folder that went away and skips ignored paths", async () => {
    const watch = manualWatch();
    const queued: Array<() => void> = [];
    const ignoredAsked: string[] = [];
    const { files } = service({
      watch: watch.factory,
      timers: { set: (fn) => queued.push(fn), clear: () => undefined },
      names: {
        isGitRoot: async () => true,
        gitNames: async (_root, sink) => sink(["src/a.ts", "src/deep/b.ts", "README.md"]),
        walkNames: async () => undefined,
        gitIgnored: async (_root, paths) => {
          ignoredAsked.push(...paths);
          return new Set(paths.filter((path) => path.startsWith("dist/")));
        },
      },
    });
    value(await files.open(1, ref));
    expect(value(await files.search(1, ref, "ts", 1))).toMatchObject({ total: 3 });
    await rm(join(root, "src"), { recursive: true });
    watch.fire("src");
    watch.fire("dist/out.js");
    queued.shift()?.();
    await files.settle();
    const after = value(await files.search(1, ref, "ts", 2));
    expect(after).toMatchObject({ total: 1, matches: [] });
    expect(ignoredAsked).toContain("dist/out.js");
  });

  it("still applies deltas after one overflow sent the index stale", async () => {
    const watch = manualWatch();
    const queued: Array<() => void> = [];
    let scans = 0;
    let listed = ["a.ts"];
    const { files } = service({
      watch: watch.factory,
      timers: { set: (fn) => queued.push(fn), clear: () => undefined },
      names: {
        isGitRoot: async () => true,
        gitNames: async (_root, sink) => {
          scans += 1;
          sink(listed);
        },
        walkNames: async () => undefined,
        gitIgnored: async () => new Set<string>(),
      },
    });
    value(await files.open(1, ref));
    value(await files.search(1, ref, "a", 1));
    // Quiet windows of 99 paths each (no streak, no burst) until more are queued than a rebuild costs.
    for (let window = 0; window < 50; window += 1) {
      for (let i = 0; i < 99; i += 1) watch.fire(`w${String(window)}-${String(i)}.txt`);
      while (queued.length > 0) queued.shift()?.();
    }
    listed = ["a.ts", "b.ts"];
    value(await files.search(1, ref, "b", 2));
    await files.settle();
    expect(scans).toBe(2);
    await writeFile(join(root, "new.ts"), "");
    watch.fire("new.ts");
    while (queued.length > 0) queued.shift()?.();
    await files.settle();
    const found = value(await files.search(1, ref, "new", 3));
    expect(found).toMatchObject({ matches: [{ path: "new.ts" }] });
    expect(scans).toBe(2);
  });

  it("a stale index keeps answering while its rebuild runs", async () => {
    const watch = manualWatch();
    const queued: Array<() => void> = [];
    let release: (() => void) | undefined;
    let listed = ["old.ts"];
    const { files } = service({
      watch: watch.factory,
      timers: { set: (fn) => queued.push(fn), clear: () => undefined },
      names: {
        isGitRoot: async () => true,
        gitNames: async (_root, sink) => {
          const names = listed;
          if (names.includes("new.ts")) await new Promise<void>((resolve) => (release = resolve));
          sink(names);
        },
        walkNames: async () => undefined,
        gitIgnored: async () => new Set<string>(),
      },
    });
    value(await files.open(1, ref));
    expect(value(await files.search(1, ref, "ts", 1))).toMatchObject({ matches: [{ path: "old.ts" }] });
    listed = ["old.ts", "new.ts"];
    watch.fire(null); // a burst: stale
    while (queued.length > 0) queued.shift()?.();
    // The rebuild is held open; the search answers from the old index.
    expect(value(await files.search(1, ref, "ts", 2))).toMatchObject({ matches: [{ path: "old.ts" }], total: 1 });
    expect(value(await files.count(ref))).toEqual({ files: 1, capped: false });
    release?.();
    await files.settle();
    expect(value(await files.search(1, ref, "ts", 3))).toMatchObject({ total: 2 });
  });

  it("a burst that lands mid-scan leaves the new index stale", async () => {
    const watch = manualWatch();
    const queued: Array<() => void> = [];
    let scans = 0;
    const { files } = service({
      watch: watch.factory,
      timers: { set: (fn) => queued.push(fn), clear: () => undefined },
      names: {
        isGitRoot: async () => true,
        gitNames: async (_root, sink) => {
          scans += 1;
          if (scans === 1) {
            watch.fire(null);
            while (queued.length > 0) queued.shift()?.();
          }
          sink(["a.ts"]);
        },
        walkNames: async () => undefined,
        gitIgnored: async () => new Set<string>(),
      },
    });
    value(await files.open(1, ref));
    value(await files.search(1, ref, "a", 1));
    value(await files.search(1, ref, "a", 2));
    expect(scans).toBe(2);
    value(await files.search(1, ref, "a", 3));
    expect(scans).toBe(2);
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

/** A watcher on a virtual clock: timers run in time order, nothing waits on a real one. */
const clockedWatch = () => {
  let now = 0;
  let next = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let listener: ((event: string, filename: string | null) => void) | undefined;
  const batches: WatchBatch[] = [];
  watchRoot("/r", (batch) => batches.push(batch), (_root, l) => {
    listener = l;
    return { close: () => undefined };
  }, {
    set: (fn, ms) => {
      next += 1;
      timers.set(next, { at: now + ms, fn });
      return next;
    },
    clear: (handle) => timers.delete(handle as number),
  });
  const advanceTo = (until: number): void => {
    for (;;) {
      let id = -1;
      let at = Number.POSITIVE_INFINITY;
      for (const [key, timer] of timers) if (timer.at < at) [id, at] = [key, timer.at];
      if (at > until) break;
      const timer = timers.get(id)!;
      timers.delete(id);
      now = at;
      timer.fn();
    }
    now = until;
  };
  const fire = (name: string | null): void => listener?.("change", name);
  const kinds = (): string[] => batches.map((batch) => batch.kind);
  const sent = (): string[] => batches.flatMap((batch) => (batch.kind === "paths" ? batch.paths : []));
  return { batches, advanceTo, fire, kinds, sent, now: () => now };
};

describe("watcher", () => {
  it("coalesces, skips .git and node_modules, and folds a burst into one", () => {
    const watch = clockedWatch();
    watch.fire("a.ts");
    watch.fire("a.ts");
    watch.fire(".git/index");
    watch.fire("web/node_modules/x/y.js");
    watch.advanceTo(100);
    expect(watch.batches).toEqual([{ kind: "paths", paths: ["a.ts"] }]);
    for (let i = 0; i <= BURST; i += 1) watch.fire(`f${String(i)}`);
    watch.advanceTo(1_000);
    expect(watch.kinds()).toEqual(["paths", "burst"]);
  });

  it("an unnamed event is a burst", () => {
    const watch = clockedWatch();
    watch.fire(null);
    watch.advanceTo(1_000);
    expect(watch.kinds()).toEqual(["burst"]);
  });

  it("a log written every 50 ms never holds a burst open: edits keep going out", () => {
    const watch = clockedWatch();
    // A checkout first: one burst.
    for (let i = 0; i <= BURST; i += 1) watch.fire(`f${String(i)}`);
    const edits = [120_000, 300_000, 480_000];
    for (let t = 0; t < 600_000; t += 50) {
      watch.advanceTo(t);
      watch.fire("app.log");
      if (edits.includes(t)) watch.fire(`edit-${String(t)}.ts`);
    }
    watch.advanceTo(600_500);
    for (const t of edits) expect(watch.sent()).toContain(`edit-${String(t)}.ts`);
    expect(watch.kinds().filter((kind) => kind === "burst")).toHaveLength(1);
  });

  it("a checkout spread over seconds is one burst, sent when it ends", () => {
    const watch = clockedWatch();
    // 300 paths a window for 3 s: past BURST in the fourth window.
    for (let t = 0; t < 3_000; t += 100) {
      watch.advanceTo(t);
      for (let i = 0; i < 300; i += 1) watch.fire(`t${String(t)}/f${String(i)}`);
    }
    watch.advanceTo(2_950);
    expect(watch.kinds()).toEqual(["paths", "paths", "paths"]);
    watch.advanceTo(3_500);
    expect(watch.kinds()).toEqual(["paths", "paths", "paths", "burst"]);
    watch.fire("late.ts");
    watch.advanceTo(4_000);
    expect(watch.batches.at(-1)).toEqual({ kind: "paths", paths: ["late.ts"] });
  });

  it("an install that jitters around any rate stays one streak", () => {
    const watch = clockedWatch();
    // About 1,000 files a second, 95 or 105 a window, with a 300 ms stall.
    for (let t = 0; t < 30_000; t += 100) {
      if (t >= 12_000 && t < 12_300) continue;
      watch.advanceTo(t);
      const count = t % 200 === 0 ? 105 : 95;
      for (let i = 0; i < count; i += 1) watch.fire(`t${String(t)}/f${String(i)}`);
    }
    watch.advanceTo(31_000);
    expect(watch.kinds().filter((kind) => kind === "burst")).toHaveLength(3);
  });

  it("an install that never pauses sends a burst at most every 10 s", () => {
    const watch = clockedWatch();
    for (let t = 0; t < 25_000; t += 100) {
      watch.advanceTo(t);
      for (let i = 0; i < 400; i += 1) watch.fire(`t${String(t)}/f${String(i)}`);
    }
    watch.advanceTo(24_950);
    expect(watch.kinds().filter((kind) => kind === "burst")).toHaveLength(2);
    watch.advanceTo(26_000);
    expect(watch.kinds().filter((kind) => kind === "burst")).toHaveLength(3);
    expect(watch.kinds().filter((kind) => kind === "paths")).toHaveLength(2);
  });
});
