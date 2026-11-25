import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { asNodeId } from "../src/shared/physics/schema";
import type { FilePath } from "../src/shared/files";
import { FilesLinkClosed, FilesRefused, type HostFilesError } from "../src/shared/files-link";
import {
  decodeChunk, encodeChunk, FILE_BYTES_CHUNK_BASE64_MAX, FILE_BYTES_CHUNK_MAX,
} from "../src/shared/files-bytes-link";
import { FileBytesLink, makeFileBytesLinkChannel, type FileBytesHost } from "../src/core/files/bytes-link";
import { makeFilesService } from "../src/core/files/service";
import { bindLinkChannel, linkClient } from "../src/core/link/contract";
import { MachineLink } from "../src/core/link/service";
import type { LinkSession, MachineLinkError } from "../src/core/link/types";
import { MachineRepository, makeMachineRepositoryLive } from "../src/core/machines/repository";
import { ModelService } from "../src/core/model/service";
import { makeStateEngineLive } from "../src/core/state/engine";
import { WorkRepositoryLive } from "../src/core/work/repository";
import { InstallationId } from "../src/shared/installation-id";
import { asCanvasName } from "../src/shared/model";
import { setFilesStageParentForTests } from "../src/node/files-stage";
import { THIS_MACHINE } from "./support/machines";
import { files as filesNode } from "./support/model-nodes";
import { ModelStoresLive } from "./support/seed-canvas";
import { clearMachines, seedThisMachine } from "./support/seed-this-machine";
import { hello, machineLinkLayer, machineLinkOver, makeSessions, pair } from "./support/link-pair";
import { makeTestLog } from "./support/test-log";

/**
 * The `file-bytes` channel's host end (0.12.1, plan 12-files-over-ssh, X3),
 * against remote-security's seven terms: chunks bounded and strictly decoded,
 * streams and uploads bound to the session that made them, the stage this
 * user's alone and gone when the upload ends, the hash checked before
 * anything lands, and every op admitted as `files` admits it.
 */

const testLog = makeTestLog();
const installation = Schema.decodeUnknownSync(InstallationId);
const editor = installation("editor-installation");
const canvas = asCanvasName("bytes-canvas");
const NODE = "files-1";
const path = (raw: string) => raw as FilePath;
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

const cleanups: Array<() => Promise<void>> = [];
const links = makeSessions();
beforeEach(() => seedThisMachine());
afterEach(async () => {
  await links.closeAll();
  for (const close of cleanups.splice(0).reverse()) await close();
  setFilesStageParentForTests(undefined);
  clearMachines();
});

type Outcome<A> = { readonly answer: A } | { readonly refused: HostFilesError };

const fixture = async (options: {
  readonly enabled?: boolean;
  readonly asker?: string;
  readonly host?: (service: FileBytesHost) => FileBytesHost;
  readonly limits?: Parameters<typeof makeFileBytesLinkChannel>[0]["limits"];
  readonly staleStage?: boolean;
} = {}) => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "junto-bytes-link-")));
  const root = join(base, "root");
  const stageParent = join(base, "stage");
  await mkdir(root, { recursive: true });
  await mkdir(stageParent, { mode: 0o700 });
  setFilesStageParentForTests(stageParent);
  const juntoHome = join(base, "home");
  if (options.staleStage === true) {
    // A stage a crashed core of this home left: the next start removes it.
    const { filesStageParent } = await import("../src/node/files-stage");
    const own = filesStageParent(juntoHome);
    await mkdir(join(own, "up-stale"));
    await writeFile(join(own, "up-stale", "left.bin"), "left behind");
  }
  const nodes = [filesNode(NODE, { host: THIS_MACHINE, root })];
  const repositories = Layer.provideMerge(Layer.mergeAll(
    WorkRepositoryLive,
    makeMachineRepositoryLive({ defaultName: () => THIS_MACHINE }),
  ), makeStateEngineLive(join(base, "junto.db")));
  let hostSession: LinkSession | undefined;
  const runtime = ManagedRuntime.make(Layer.mergeAll(
    Layer.provideMerge(ModelStoresLive, repositories),
    testLog.log.loggerLayer,
    machineLinkLayer(() => hostSession),
  ));
  cleanups.push(async () => { await runtime.dispose(); await rm(base, { recursive: true, force: true }); });
  await runtime.runPromise(Effect.gen(function* () {
    const machines = yield* MachineRepository;
    yield* machines.pinPeer({ machineName: "macbook", installationId: editor });
    yield* (yield* ModelService).installCopy({ canvas, canvasId: "copied", seq: 1, editor, nodes, wires: [] });
  }));
  const service = makeFilesService({
    node: async (ref) => {
      const node = nodes.find((candidate) => candidate.id === ref.node);
      return node === undefined ? undefined : { host: node.host, root: node.root };
    },
    machineName: async () => THIS_MACHINE,
    deny: async () => [join(root, ".junto")],
    trash: async () => undefined,
    openPath: async () => "",
    reveal: () => undefined,
    send: () => undefined,
    names: { isGitRoot: async () => false, gitNames: async () => undefined, walkNames: async (_root, sink) => sink([]), gitIgnored: async () => new Set() },
  });
  const host = options.host === undefined ? service : options.host(service);
  const channel = await runtime.runPromise(makeFileBytesLinkChannel({
    service: () => host, juntoHome,
    ...(options.enabled === undefined ? {} : { enabled: options.enabled }),
    ...(options.limits === undefined ? {} : { limits: options.limits }),
  }));
  const die = () => Effect.die("the asking end serves nothing");
  const asking = bindLinkChannel(FileBytesLink, {
    requests: { ReadOpen: die, ReadChunk: die, ReadClose: die, ImportOpen: die, ImportChunk: die, ImportEnd: die },
  });
  const { a: asker, b: hostEnd } = pair(
    { self: hello("macbook", options.asker ?? editor), channels: { "file-bytes": asking } },
    { self: hello("mini"), channels: { "file-bytes": channel }, run: (effect) => runtime.runPromise(effect.pipe(Effect.provide(testLog.log.loggerLayer))) },
  );
  hostSession = hostEnd;
  links.keep(asker, hostEnd);
  await Promise.all([asker.ready, hostEnd.ready]);
  const client = await Effect.runPromise(linkClient(FileBytesLink).pipe(Effect.provideService(MachineLink, machineLinkOver(() => asker))));
  const ask = async <A>(call: (bytes: typeof client) => Effect.Effect<A, FilesRefused | FilesLinkClosed | MachineLinkError>): Promise<Outcome<A>> => {
    const result = await Effect.runPromise(Effect.result(call(client)));
    if (result._tag === "Success") return { answer: result.success };
    if (result.failure instanceof FilesRefused) return { refused: result.failure.error };
    throw result.failure;
  };
  const where = { canvas, node: asNodeId(NODE) };
  const ownStage = async () => {
    const entries = await readdir(stageParent);
    return entries.length === 0 ? [] : readdir(join(stageParent, entries[0]!));
  };
  return { base, root, stageParent, ask, where, asker, hostEnd, ownStage };
};

const answer = <A>(outcome: Outcome<A>): A => {
  if (!("answer" in outcome)) throw new Error(`refused ${outcome.refused}`);
  return outcome.answer;
};

describe("a chunk on the wire", () => {
  it("is canonical base64 of at most 48 KiB, its length checked before it decodes", () => {
    const whole = new Uint8Array(FILE_BYTES_CHUNK_MAX).fill(7);
    const text = encodeChunk(whole);
    expect(text.length).toBe(FILE_BYTES_CHUNK_BASE64_MAX);
    expect(FILE_BYTES_CHUNK_BASE64_MAX).toBe(65_536);
    expect(decodeChunk(text)?.byteLength).toBe(FILE_BYTES_CHUNK_MAX);
    expect(decodeChunk(encodeChunk(new Uint8Array(FILE_BYTES_CHUNK_MAX + 1)))).toBeUndefined();
    expect(decodeChunk("")?.byteLength).toBe(0);
    expect(decodeChunk("QQ==")).toEqual(new Uint8Array([65]));
    // One chunk has one spelling: stray padding bits, whitespace, URL-safe letters and missing padding are refused.
    for (const bad of ["QR==", "QQ= =", " QQ==", "QQ==\n", "QQ", "-_8=", "QQ==QQ==", "Q===", "=QQ="]) expect(decodeChunk(bad)).toBeUndefined();
  });
});

describe("file-bytes host", () => {
  it("reads a file in chunks, never more than asked, and nothing past its end", async () => {
    const f = await fixture();
    const body = Buffer.alloc(FILE_BYTES_CHUNK_MAX * 2 + 10, 3);
    await writeFile(join(f.root, "big.bin"), body);
    const opened = answer(await f.ask((bytes) => bytes.ReadOpen("mini", { ...f.where, path: path("big.bin") })));
    expect(opened.size).toBe(body.length);
    expect(opened.stamp.size).toBe(body.length);
    expect(opened.stream).toMatch(/^[0-9a-f]{32}$/u);
    const first = answer(await f.ask((bytes) => bytes.ReadChunk("mini", { stream: opened.stream, offset: 0, length: 100 })));
    expect(decodeChunk(first.data)?.byteLength).toBe(100);
    const tail = answer(await f.ask((bytes) => bytes.ReadChunk("mini", { stream: opened.stream, offset: FILE_BYTES_CHUNK_MAX * 2, length: FILE_BYTES_CHUNK_MAX })));
    expect(decodeChunk(tail.data)?.byteLength).toBe(10);
    const past = answer(await f.ask((bytes) => bytes.ReadChunk("mini", { stream: opened.stream, offset: body.length, length: 1 })));
    expect(past.data).toBe("");
    answer(await f.ask((bytes) => bytes.ReadClose("mini", { stream: opened.stream })));
    // Closed, the stream is gone.
    expect(await f.ask((bytes) => bytes.ReadChunk("mini", { stream: opened.stream, offset: 0, length: 1 }))).toEqual({ refused: "not-found" });
  });

  it("refuses a read over its chunk bound at the schema, and a stream it never made", async () => {
    const f = await fixture();
    await writeFile(join(f.root, "a.txt"), "a");
    const opened = answer(await f.ask((bytes) => bytes.ReadOpen("mini", { ...f.where, path: path("a.txt") })));
    const over = await f.ask((bytes) => bytes.ReadChunk("mini", { stream: opened.stream, offset: 0, length: FILE_BYTES_CHUNK_MAX + 1 })).catch((cause: unknown) => cause);
    expect(over).not.toHaveProperty("answer");
    expect(await f.ask((bytes) => bytes.ReadChunk("mini", { stream: "0".repeat(32), offset: 0, length: 1 }))).toEqual({ refused: "not-found" });
  });

  it("keeps the root's scope and deny list, and a folder is not bytes", async () => {
    const f = await fixture();
    await mkdir(join(f.root, ".junto"));
    await writeFile(join(f.root, ".junto", "secret"), "x");
    await writeFile(join(f.base, "outside.txt"), "x");
    await symlink(join(f.base, "outside.txt"), join(f.root, "escape.txt"));
    await mkdir(join(f.root, "dir"));
    for (const target of [".junto/secret", "escape.txt", "dir"]) {
      const outcome = await f.ask((bytes) => bytes.ReadOpen("mini", { ...f.where, path: path(target) }));
      expect(outcome).toHaveProperty("refused");
    }
  });

  it("refuses every op denied to a machine that is not the canvas's editor, and while the feature is off", async () => {
    const stranger = await fixture({ asker: "stranger-installation" });
    await writeFile(join(stranger.root, "a.txt"), "a");
    expect(await stranger.ask((bytes) => bytes.ReadOpen("mini", { ...stranger.where, path: path("a.txt") }))).toEqual({ refused: "denied" });
    expect(await stranger.ask((bytes) => bytes.ImportOpen("mini", { ...stranger.where, into: path(""), name: "b.txt", size: 1 }))).toEqual({ refused: "denied" });
    const off = await fixture({ enabled: false });
    await writeFile(join(off.root, "a.txt"), "a");
    expect(await off.ask((bytes) => bytes.ReadOpen("mini", { ...off.where, path: path("a.txt") }))).toEqual({ refused: "denied" });
  });

  it("stages a drop this user's alone, hashes it as it lands, and imports it whole", async () => {
    const f = await fixture();
    const body = Buffer.alloc(FILE_BYTES_CHUNK_MAX + 5, 9);
    const opened = answer(await f.ask((bytes) => bytes.ImportOpen("mini", { ...f.where, into: path(""), name: "drop.bin", size: body.length })));
    const [directory] = await f.ownStage();
    const staged = join(f.stageParent, (await readdir(f.stageParent))[0]!, directory!);
    expect((await stat(staged)).mode & 0o777).toBe(0o700);
    expect((await stat(join(staged, "drop.bin"))).mode & 0o777).toBe(0o600);
    answer(await f.ask((bytes) => bytes.ImportChunk("mini", { upload: opened.upload, offset: 0, data: encodeChunk(body.subarray(0, FILE_BYTES_CHUNK_MAX)) })));
    answer(await f.ask((bytes) => bytes.ImportChunk("mini", { upload: opened.upload, offset: FILE_BYTES_CHUNK_MAX, data: encodeChunk(body.subarray(FILE_BYTES_CHUNK_MAX)) })));
    const imported = answer(await f.ask((bytes) => bytes.ImportEnd("mini", { upload: opened.upload, sha256: sha(body) })));
    expect(imported.map((one) => one.path)).toEqual(["drop.bin"]);
    expect(Buffer.compare(await readFile(join(f.root, "drop.bin")), body)).toBe(0);
    expect(await f.ownStage()).toEqual([]);
  });

  it("writes nothing into the root when the hash does not match, and leaves no stage", async () => {
    const f = await fixture();
    const opened = answer(await f.ask((bytes) => bytes.ImportOpen("mini", { ...f.where, into: path(""), name: "drop.txt", size: 3 })));
    answer(await f.ask((bytes) => bytes.ImportChunk("mini", { upload: opened.upload, offset: 0, data: encodeChunk(Buffer.from("abc")) })));
    expect(await f.ask((bytes) => bytes.ImportEnd("mini", { upload: opened.upload, sha256: sha(Buffer.from("abd")) }))).toEqual({ refused: "failed" });
    expect(await readdir(f.root)).toEqual([]);
    expect(await f.ownStage()).toEqual([]);
  });

  it("refuses a chunk out of order or past the size, and drops the upload with it", async () => {
    const f = await fixture();
    const open = async () => answer(await f.ask((bytes) => bytes.ImportOpen("mini", { ...f.where, into: path(""), name: "drop.txt", size: 3 })));
    const skipped = await open();
    expect(await f.ask((bytes) => bytes.ImportChunk("mini", { upload: skipped.upload, offset: 1, data: encodeChunk(Buffer.from("b")) }))).toEqual({ refused: "denied" });
    expect(await f.ask((bytes) => bytes.ImportEnd("mini", { upload: skipped.upload, sha256: sha(Buffer.from("abc")) }))).toEqual({ refused: "not-found" });
    const over = await open();
    expect(await f.ask((bytes) => bytes.ImportChunk("mini", { upload: over.upload, offset: 0, data: encodeChunk(Buffer.from("abcd")) }))).toEqual({ refused: "denied" });
    expect(await f.ownStage()).toEqual([]);
    expect(await readdir(f.root)).toEqual([]);
  });

  it("refuses an upload past this machine's staged total, and past the per-session count", async () => {
    const f = await fixture({ limits: { stagedTotal: 10, uploads: 1, freeFloor: 0 } });
    expect(await f.ask((bytes) => bytes.ImportOpen("mini", { ...f.where, into: path(""), name: "big.bin", size: 11 }))).toEqual({ refused: "denied" });
    answer(await f.ask((bytes) => bytes.ImportOpen("mini", { ...f.where, into: path(""), name: "a.bin", size: 4 })));
    expect(await f.ask((bytes) => bytes.ImportOpen("mini", { ...f.where, into: path(""), name: "b.bin", size: 4 }))).toEqual({ refused: "denied" });
  });

  it("refuses an upload that would leave the stage's disk under its floor", async () => {
    const f = await fixture({ limits: { freeFloor: Number.MAX_SAFE_INTEGER } });
    expect(await f.ask((bytes) => bytes.ImportOpen("mini", { ...f.where, into: path(""), name: "a.bin", size: 1 }))).toEqual({ refused: "denied" });
  });

  it("removes every stage and closes every stream when the link closes", async () => {
    const f = await fixture();
    answer(await f.ask((bytes) => bytes.ImportOpen("mini", { ...f.where, into: path(""), name: "a.bin", size: 4 })));
    expect(await f.ownStage()).toHaveLength(1);
    await f.asker.close();
    await f.hostEnd.closed;
    for (let tries = 0; tries < 50 && (await f.ownStage()).length > 0; tries++) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(await f.ownStage()).toEqual([]);
  });

  it("sweeps a stage a crashed core of this home left, at start", async () => {
    const f = await fixture({ staleStage: true });
    expect(await f.ownStage()).toEqual([]);
  });

  it("refuses a third byte request while two wait, and closes the stream it named, with the link kept", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let opens = 0;
    const f = await fixture({
      host: (service) => ({
        ...service,
        bytesAt: async (ref, target) => {
          opens += 1;
          await gate;
          return service.bytesAt(ref, target);
        },
      }),
    });
    await writeFile(join(f.root, "a.txt"), "a");
    const calls = [0, 1, 2].map(() => f.ask((bytes) => bytes.ReadOpen("mini", { ...f.where, path: path("a.txt") })));
    const third = await Promise.race([calls[2]!, new Promise((resolve) => setTimeout(() => resolve("waiting"), 500))]);
    expect(third).toEqual({ refused: "denied" });
    release();
    const [one, two] = await Promise.all([calls[0]!, calls[1]!]);
    expect(one).toHaveProperty("answer");
    expect(two).toHaveProperty("answer");
    expect(opens).toBe(2);
  });
});
