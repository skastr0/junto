import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { Effect, Fiber } from "effect";
import { Header, type HeaderData } from "tar";
import { afterEach, expect, it, vi } from "vitest";
import { makeMachineBundleSources, makeReleaseMachineBundleAcquirer, type MachineBundleAcquirer } from "../src/main/junto/hosts/machine-bundle-download";
import { acquireMachineBundleCache, releaseMachineBundleCache, pruneMachineBundleCache, discardMachineBundleAttempt, type OwnedMachineBundleAttempt } from "../src/main/junto/hosts/machine-bundle-cache";
import { MachineInstallError } from "../src/shared/machine-install";
import { decodeMachineReleaseCatalog, MACHINE_RELEASE_ORIGIN, MAX_MACHINE_UNPACKED_BYTES } from "../src/shared/machine-release";
import type { MachineSendEvent } from "../src/shared/machine-progress";

const homes: string[] = [];
afterEach(async () => { for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true }); });
const hash = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
interface Member extends HeaderData { readonly path: string; readonly body: Buffer }
const tar = (members: readonly Member[]): Buffer => gzipSync(Buffer.concat([
  ...members.flatMap(member => {
    const header = new Header({ ...member, size: member.size ?? member.body.length, mode: member.mode ?? 0o644, uid: 0, gid: 0, mtime: new Date(0), type: member.type ?? "File" });
    header.encode();
    return [header.block!, member.body, Buffer.alloc((512 - member.body.length % 512) % 512)];
  }), Buffer.alloc(1024),
]));
const fixture = async (options: { members?: (members: Member[]) => Member[]; manifestBuild?: string; manifestTarget?: string; manifestHash?: string } = {}) => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "junto-download-test-"))); homes.push(home);
  const build = "a".repeat(64);
  const files: Member[] = [
    { path: "bin/junto", mode: 0o755, body: Buffer.from("cli fixture\n") },
    { path: "bin/node", mode: 0o755, body: Buffer.from("node fixture\n") },
    { path: "core/junto.cjs", mode: 0o644, body: Buffer.from("core fixture\n") },
  ];
  const manifest = Buffer.from(JSON.stringify({ build: options.manifestBuild ?? build, target: options.manifestTarget ?? "darwin-arm64", node: "26.10.0", appVersion: "0.7.0",
    files: files.map(file => ({ path: file.path, mode: file.mode, bytes: file.body.length, sha256: hash(file.body) })),
  }));
  const members = [...files, { path: "manifest.json", body: manifest }];
  const bytes = tar(options.members?.(members) ?? members);
  const archive = { target: "darwin-arm64", archivePath: `/machines/${build}/darwin-arm64.tar.gz`, archiveBytes: bytes.length, archiveSha256: hash(bytes), manifestSha256: options.manifestHash ?? hash(manifest) };
  const catalog = decodeMachineReleaseCatalog({ schema: "junto/machine-release/v1", build, appVersion: "0.7.0", origin: MACHINE_RELEASE_ORIGIN, archives: [archive] });
  const cache = join(home, ".junto/cache/machine-bundles");
  const archiveFile = join(cache, build, "darwin-arm64.tar.gz");
  const fetcher = vi.fn<(url: URL, init: RequestInit) => Promise<Response>>(async () => new Response(new Uint8Array(bytes), { headers: { "Content-Length": "1" } }));
  const acquire = makeReleaseMachineBundleAcquirer({ home, build, catalog, fetch: fetcher });
  return { home, build, bytes, catalog, archive, cache, archiveFile, fetcher, acquire };
};
const run = (acquire: MachineBundleAcquirer, events: MachineSendEvent[] = []) => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const bundle = yield* acquire("darwin-arm64", event => events.push(event));
  return yield* Effect.promise(async () => ({ bundle, core: await readFile(join(bundle, "core/junto.cjs"), "utf8") }));
})));
const errorFrom = (acquire: MachineBundleAcquirer) => Effect.runPromise(Effect.scoped(acquire("darwin-arm64").pipe(Effect.flip)));

it("keeps source and Preview local even when no bundle exists, while a release ignores local lookup", async () => {
  const f = await fixture();
  const localRoot = vi.fn(() => join(f.home, "local"));
  const local = () => makeMachineBundleSources({ home: f.home, build: f.build, catalog: undefined, localRoot });
  expect(local()).toEqual({ bundles: {} });
  await mkdir(join(localRoot(), "darwin-arm64"), { recursive: true, mode: 0o700 });
  await writeFile(join(localRoot(), "darwin-arm64/manifest.json"), "local fixture");
  expect(local()).toEqual({ bundles: { "darwin-arm64": join(localRoot(), "darwin-arm64") } });
  localRoot.mockClear();
  const release = makeMachineBundleSources({ home: f.home, build: f.build, catalog: f.catalog, localRoot });
  expect(release.bundles).toEqual({}); expect(release.acquireBundle).toBeTypeOf("function");
  expect(localRoot).not.toHaveBeenCalled(); expect(f.fetcher).not.toHaveBeenCalled();
});

it("downloads from the pinned origin, checks actual bytes and reuses a verified archive", async () => {
  const f = await fixture(), events: MachineSendEvent[] = [];
  expect((await run(f.acquire, events)).core).toBe("core fixture\n");
  expect(f.fetcher).toHaveBeenCalledExactlyOnceWith(new URL(f.archive.archivePath, MACHINE_RELEASE_ORIGIN), expect.objectContaining({ redirect: "error", credentials: "omit", headers: { "Accept-Encoding": "identity" } }));
  expect(events[0]).toMatchObject({ event: "machine-download", downloadedBytes: 0, totalBytes: f.bytes.length });
  expect(events.at(-1)).toMatchObject({ event: "machine-download", downloadedBytes: f.bytes.length, state: "downloaded" });
  expect(await readFile(f.archiveFile)).toEqual(f.bytes);
  const cachedEvents: MachineSendEvent[] = [];
  const cached = await run(f.acquire, cachedEvents);
  expect(cached.core).toBe("core fixture\n"); expect(f.fetcher).toHaveBeenCalledTimes(1); expect(cachedEvents).toEqual([]);
  await expect(readFile(join(cached.bundle, "manifest.json"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readdir(f.cache)).toEqual([f.build]);
});

it("refuses corrupt cache bytes, retires only that file, and downloads on the next explicit action", async () => {
  const f = await fixture(); await run(f.acquire);
  const changed = Buffer.from(f.bytes); changed[changed.length - 1]! ^= 1;
  await writeFile(f.archiveFile, changed);
  expect((await errorFrom(f.acquire)).message).toContain("saved download failed its check");
  expect(f.fetcher).toHaveBeenCalledTimes(1);
  await expect(readFile(f.archiveFile)).rejects.toMatchObject({ code: "ENOENT" });
  expect((await run(f.acquire)).core).toBe("core fixture\n"); expect(f.fetcher).toHaveBeenCalledTimes(2);
});

it.each(["overrun", "truncated", "checksum", "redirect", "offline"])("leaves no cached candidate after %s", async kind => {
  const f = await fixture();
  f.fetcher.mockImplementation(async () => {
    if (kind === "offline") throw new Error("offline");
    if (kind === "redirect") return new Response(null, { status: 302, headers: { Location: "https://example.invalid/payload" } });
    const bytes = kind === "overrun" ? Buffer.concat([f.bytes, Buffer.from("x")]) : kind === "truncated" ? f.bytes.subarray(0, -1) : Buffer.alloc(f.bytes.length);
    return new Response(new Uint8Array(bytes), { headers: { "Content-Length": String(f.bytes.length) } });
  });
  expect(await errorFrom(f.acquire)).toBeInstanceOf(MachineInstallError);
  await expect(readFile(f.archiveFile)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readdir(f.cache)).toEqual([f.build]);
  f.fetcher.mockImplementation(async () => new Response(new Uint8Array(f.bytes)));
  expect((await run(f.acquire)).core).toBe("core fixture\n"); expect(f.fetcher).toHaveBeenCalledTimes(2);
});

it.each([
  { path: "../outside", body: Buffer.from("refuse") },
  { path: "/outside", body: Buffer.from("refuse") },
  { path: "core/link", type: "SymbolicLink" as const, linkpath: "../../outside", body: Buffer.alloc(0) },
  { path: "core/link", type: "Link" as const, linkpath: "bin/node", body: Buffer.alloc(0) },
  { path: "core/pipe", type: "FIFO" as const, body: Buffer.alloc(0) },
  { path: "bin/node", body: Buffer.from("duplicate") },
  { path: "core/large", size: MAX_MACHINE_UNPACKED_BYTES + 1, body: Buffer.alloc(0) },
  { path: "core/writable", mode: 0o666, body: Buffer.alloc(0) },
])("refuses archive member $path ($type) before using its files", async bad => {
  const f = await fixture({ members: members => [...members, bad] });
  expect((await errorFrom(f.acquire)).message).toMatch(/download failed its check/);
  await expect(readFile(join(f.home, "outside"))).rejects.toMatchObject({ code: "ENOENT" });
  expect((await readdir(f.cache)).filter(name => name.startsWith(".attempt-"))).toEqual([]);
});

it("bounds member count and rejects file/directory collisions", async () => {
  for (const members of [
    (base: Member[]) => [...base, ...Array.from({ length: 126 }, (_, index) => ({ path: `extra-${index}`, body: Buffer.alloc(0) }))],
    (base: Member[]) => [...base, { path: "core", body: Buffer.alloc(0) }],
  ]) {
    const f = await fixture({ members });
    expect((await errorFrom(f.acquire)).message).toContain("download failed its check");
  }
});

it.each([{ manifestHash: "b".repeat(64) }, { manifestBuild: "b".repeat(64) }, { manifestTarget: "linux-x64" },
  { members: (members: Member[]) => members.map(member => member.path === "core/junto.cjs" ? { ...member, body: Buffer.from("tampered core\n") } : member) },
])("checks the manifest pin, build, target and complete file inventory", async options => {
  const f = await fixture(options), events: MachineSendEvent[] = [];
  await expect(run(f.acquire, events)).rejects.toBeInstanceOf(MachineInstallError);
  expect(events.some(event => event.event === "machine-download" && event.state === "downloaded")).toBe(false);
});

it("shares one download, verifies each private use and fans out progress", async () => {
  const f = await fixture();
  let controller!: ReadableStreamDefaultController<Uint8Array>, fetched!: () => void, joined!: () => void;
  const fetching = new Promise<void>(resolve => { fetched = resolve; });
  const joining = new Promise<void>(resolve => { joined = resolve; });
  f.fetcher.mockImplementation(async () => new Response(new ReadableStream<Uint8Array>({ start(value) { controller = value; fetched(); } })));
  const first: MachineSendEvent[] = [], second: MachineSendEvent[] = [];
  const one = run(f.acquire, first); await fetching;
  const two = Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const bundle = yield* f.acquire("darwin-arm64", event => { second.push(event); if (event.event === "machine-download" && event.downloadedBytes === 0) joined(); });
    return yield* Effect.promise(() => readFile(join(bundle, "core/junto.cjs"), "utf8"));
  })));
  await joining;
  controller.enqueue(new Uint8Array(f.bytes)); controller.close();
  expect((await one).core).toBe("core fixture\n"); expect(await two).toBe("core fixture\n");
  expect(f.fetcher).toHaveBeenCalledTimes(1);
  expect(first.at(-1)).toMatchObject({ state: "downloaded" }); expect(second.at(-1)).toMatchObject({ state: "downloaded" });
});

it("cancels an abandoned download, cleans its attempts and releases the failed shared acquisition", async () => {
  const f = await fixture();
  let fetched!: () => void;
  const fetching = new Promise<void>(resolve => { fetched = resolve; });
  const stopped = vi.fn();
  f.fetcher.mockImplementation(async () => new Response(new ReadableStream<Uint8Array>({ start() { fetched(); }, cancel: stopped })));
  const fiber = Effect.runFork(Effect.scoped(f.acquire("darwin-arm64")));
  await fetching; await Effect.runPromise(Fiber.interrupt(fiber));
  expect(stopped).toHaveBeenCalledOnce();
  expect(await readdir(f.cache)).toEqual([f.build]);
  f.fetcher.mockImplementation(async () => new Response(new Uint8Array(f.bytes)));
  expect((await run(f.acquire)).core).toBe("core fixture\n"); expect(f.fetcher).toHaveBeenCalledTimes(2);
});

it("lets a shared download finish for another machine when one caller is interrupted", async () => {
  const f = await fixture();
  let controller!: ReadableStreamDefaultController<Uint8Array>, fetched!: () => void, joined!: () => void;
  const fetching = new Promise<void>(resolve => { fetched = resolve; });
  const joining = new Promise<void>(resolve => { joined = resolve; });
  const stopped = vi.fn();
  f.fetcher.mockImplementation(async () => new Response(new ReadableStream<Uint8Array>({ start(value) { controller = value; fetched(); }, cancel: stopped })));
  const one = Effect.runFork(Effect.scoped(f.acquire("darwin-arm64"))); await fetching;
  const two = Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const bundle = yield* f.acquire("darwin-arm64", event => { if (event.event === "machine-download" && event.downloadedBytes === 0) joined(); });
    return yield* Effect.promise(() => readFile(join(bundle, "core/junto.cjs"), "utf8"));
  })));
  await joining; await Effect.runPromise(Fiber.interrupt(one));
  expect(stopped).not.toHaveBeenCalled();
  controller.enqueue(new Uint8Array(f.bytes)); controller.close();
  expect(await two).toBe("core fixture\n"); expect(f.fetcher).toHaveBeenCalledTimes(1);
  expect(await readdir(f.cache)).toEqual([f.build]);
});

it("refuses an archive cache link without touching its target", async () => {
  const f = await fixture(); await run(f.acquire);
  const target = join(f.home, "untouched"); await writeFile(target, "keep");
  await rm(f.archiveFile); await symlink(target, f.archiveFile);
  expect((await errorFrom(f.acquire)).message).toContain("owned regular file");
  expect(await readFile(target, "utf8")).toBe("keep"); expect(f.fetcher).toHaveBeenCalledTimes(1);
});

it("protects active old builds while pruning and refuses fake cleanup authority or symlink caches", async () => {
  const f = await fixture(); await run(f.acquire);
  const held = await acquireMachineBundleCache(f.home, f.build);
  const next = await acquireMachineBundleCache(f.home, "b".repeat(64));
  try {
    await pruneMachineBundleCache(next); expect(await readFile(f.archiveFile)).toEqual(f.bytes);
    releaseMachineBundleCache(held);
    await pruneMachineBundleCache(next); await expect(readFile(f.archiveFile)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(discardMachineBundleAttempt({} as OwnedMachineBundleAttempt)).rejects.toThrow("owned attempt");
  } finally { releaseMachineBundleCache(next); }
  const other = await fixture();
  const target = join(other.home, "untouched"); await mkdir(target);
  await mkdir(join(other.home, ".junto/cache"), { recursive: true, mode: 0o700 });
  await symlink(target, other.cache);
  expect((await errorFrom(other.acquire)).message).toContain("not owned"); expect(await readdir(target)).toEqual([]);
});
