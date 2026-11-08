import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { asNodeId } from "../src/shared/physics/schema";
import type { FilePath, FilesChanged } from "../src/shared/files";
import { FILES_LINK_TEXT_JSON_MAX, FilesLinkClosed, FilesRefused, type FilesEvent, type HostFilesError } from "../src/shared/files-link";
import { FilesLink, makeFilesLinkChannel, type FilesHost } from "../src/core/files/link";
import { makePeerSubscribers, PEER_SUBSCRIBER_BASE } from "../src/core/files/peer-subscribers";
import { makeFilesService } from "../src/core/files/service";
import { bindLinkChannel, linkClient } from "../src/core/link/contract";
import { MachineLink } from "../src/core/link/service";
import type { LinkChannelContext, LinkChannelHandler, MachineLinkError } from "../src/core/link/types";
import { MachineRepository, makeMachineRepositoryLive } from "../src/core/machines/repository";
import { ModelService } from "../src/core/model/service";
import { makeTestLog } from "./support/test-log";

const testLog = makeTestLog();
import { machineLogDir } from "../src/node/observability/log-file";
import { makeStateEngineLive } from "../src/core/state/engine";
import { WorkRepositoryLive } from "../src/core/work/repository";
import { InstallationId } from "../src/shared/installation-id";
import { asCanvasName } from "../src/shared/model";
import { THIS_MACHINE } from "./support/machines";
import { files as filesNode } from "./support/model-nodes";
import { ModelStoresLive, seedCanvas } from "./support/seed-canvas";
import { clearMachines, seedThisMachine } from "./support/seed-this-machine";
import { hello, machineLinkLayer, machineLinkOver, makeSessions, pair } from "./support/link-pair";
import type { LinkSession } from "../src/core/link/types";

const installation = Schema.decodeUnknownSync(InstallationId);
const editor = installation("editor-installation");
const canvas = asCanvasName("files-canvas");
const NODE = "files-1";
const AWAY = "files-away";
const HOST = "mini";
const path = (raw: string) => raw as FilePath;

const cleanups: Array<() => Promise<void>> = [];
const links = makeSessions();
beforeEach(() => seedThisMachine());
afterEach(async () => {
  await links.closeAll();
  for (const close of cleanups.splice(0).reverse()) await close();
  clearMachines();
});

/** What a call came to: its answer, or the host's refusal. Any other failure is thrown. */
type Outcome<A> = { readonly answer: A } | { readonly refused: HostFilesError };

const fixture = async (
  options: {
    readonly editor?: "editor" | "self";
    readonly host?: FilesHost;
    readonly enabled?: boolean;
    /** The installation the asking machine's hello carries; the pinned editor's unless a test says another. */
    readonly asker?: string;
    readonly extra?: Record<string, LinkChannelHandler>;
  } = {},
) => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "junto-files-link-")));
  const root = join(base, "root");
  await mkdir(root, { recursive: true });
  const nodes = [filesNode(NODE, { host: THIS_MACHINE, root }), filesNode(AWAY, { host: THIS_MACHINE, root })];
  const repositories = Layer.provideMerge(Layer.mergeAll(
    WorkRepositoryLive,
    makeMachineRepositoryLive({ defaultName: () => THIS_MACHINE }),
  ), makeStateEngineLive(join(base, "junto.db")));
  // The host's typed send goes to the machine's link, which is the session toward the asking machine.
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
    if (options.editor === "self") return yield* seedCanvas(canvas, nodes);
    yield* (yield* ModelService).installCopy({ canvas, canvasId: "copied", seq: 1, editor, nodes, wires: [] });
  }));
  const trashed: string[] = [];
  const service = makeFilesService({
    node: async (ref) => {
      const node = nodes.find((candidate) => candidate.id === ref.node);
      // The model keeps every Files node on its own machine; this one is another machine's as the service reads it.
      return node === undefined ? undefined : { host: node.id === AWAY ? "elsewhere" : node.host, root: node.root };
    },
    machineName: async () => THIS_MACHINE,
    deny: async () => [join(root, ".junto")],
    trash: async (absolute) => { trashed.push(absolute); await rm(absolute, { recursive: true }); },
    openPath: async () => "",
    reveal: () => undefined,
    send: () => undefined,
    names: { isGitRoot: async () => false, gitNames: async () => undefined, walkNames: async (_root, sink) => sink([]), gitIgnored: async () => new Set() },
  });
  const subscribers = makePeerSubscribers();
  const channel = await runtime.runPromise(makeFilesLinkChannel({ service: () => options.host ?? service, peerSubscribers: subscribers, ...(options.enabled === undefined ? {} : { enabled: options.enabled }) }));

  // The asking machine: it takes the host's events, and answers no request.
  const sent: FilesEvent[] = [];
  const die = () => Effect.die("the asking end serves nothing");
  const asking = bindLinkChannel(FilesLink, {
    requests: { Open: die, Close: die, Count: die, List: die, Read: die, Write: die, Create: die, Rename: die, Move: die, Trash: die, Import: die, Search: die },
    event: (event) => Effect.sync(() => { sent.push(event); }),
  });
  const { a: asker, b: host } = pair(
    { self: hello("macbook", options.asker ?? editor), channels: { files: asking, ...options.extra } },
    // The host runs its handlers in the core's runtime, with its log.
    { self: hello(HOST), channels: { files: channel, ...options.extra }, run: (effect) => runtime.runPromise(effect.pipe(Effect.provide(testLog.log.loggerLayer))) },
  );
  hostSession = host;
  links.keep(asker, host);
  await Promise.all([asker.ready, host.ready]);

  const files = await Effect.runPromise(linkClient(FilesLink).pipe(Effect.provideService(MachineLink, machineLinkOver(() => asker))));
  const ask = async <A>(call: (files: typeof client) => Effect.Effect<A, FilesRefused | FilesLinkClosed | MachineLinkError>): Promise<Outcome<A>> => {
    const result = await Effect.runPromise(Effect.result(call(client)));
    if (result._tag === "Success") return { answer: result.success };
    if (result.failure instanceof FilesRefused) return { refused: result.failure.error };
    throw result.failure;
  };
  const client = files;
  /** A request as the session hands it to the host, with a context the test shapes. */
  const context: LinkChannelContext = {
    peer: { build: "same-build", installationId: editor, machineName: "macbook" },
    keyBound: false,
    sessionId: "admitted-link", operationId: "op-files-1", signal: new AbortController().signal,
    sendEvent: () => Effect.void, close: () => Effect.void, request: () => Effect.die("unused"),
  };
  const where = { canvas, node: asNodeId(NODE) };
  return { base, root, channel, context, ask, where, sent, subscribers, trashed, runtime, asker, host };
};

describe("files channel host", () => {
  it("serves every op through the Files service for the editing machine", async () => {
    const f = await fixture();
    await writeFile(join(f.root, "a.md"), "hello");
    expect(await f.ask((c) => c.Open(HOST, f.where))).toMatchObject({ answer: { repo: false } });
    expect(await f.ask((c) => c.Count(HOST, f.where))).toMatchObject({ answer: { capped: false } });
    expect(await f.ask((c) => c.List(HOST, { ...f.where, dir: path("") }))).toMatchObject({ answer: [{ path: "a.md", dir: false }] });
    const read = await f.ask((c) => c.Read(HOST, { ...f.where, path: path("a.md") }));
    expect(read).toMatchObject({ answer: { kind: "text", text: "hello" } });
    const stamp = (read as { answer: { stamp: { mtimeMs: number; size: number } } }).answer.stamp;
    const written = await f.ask((c) => c.Write(HOST, { ...f.where, path: path("a.md"), text: "changed", base: stamp }));
    expect(written).toHaveProperty("answer");
    expect(await readFile(join(f.root, "a.md"), "utf8")).toBe("changed");
    expect(await f.ask((c) => c.Write(HOST, { ...f.where, path: path("a.md"), text: "again", base: stamp }))).toEqual({ refused: "stale" });
    expect(await f.ask((c) => c.Create(HOST, { ...f.where, path: path("d"), dir: true }))).toMatchObject({ answer: { path: "d", dir: true } });
    expect(await f.ask((c) => c.Rename(HOST, { ...f.where, path: path("a.md"), name: "b.md" }))).toEqual({ answer: "b.md" });
    expect(await f.ask((c) => c.Move(HOST, { ...f.where, path: path("b.md"), into: path("d") }))).toEqual({ answer: "d/b.md" });
    expect(await f.ask((c) => c.Trash(HOST, { ...f.where, path: path("d/b.md") }))).toEqual({ answer: null });
    expect(f.trashed).toEqual([join(f.root, "d", "b.md")]);
    expect(await f.ask((c) => c.Close(HOST, f.where))).toEqual({ answer: null });
  });

  it("answers the service's own refusals: a node elsewhere, a missing file, a path through a link out of the root", async () => {
    const f = await fixture();
    expect(await f.ask((c) => c.List(HOST, { canvas, node: asNodeId(AWAY), dir: path("") }))).toEqual({ refused: "elsewhere" });
    expect(await f.ask((c) => c.List(HOST, { canvas, node: asNodeId("files-none"), dir: path("") }))).toEqual({ refused: "no-node" });
    expect(await f.ask((c) => c.Read(HOST, { ...f.where, path: path("missing.md") }))).toEqual({ refused: "not-found" });
  });

  it("admits only the pinned editor of the canvas, and refuses denied, never unreachable", async () => {
    const stranger = await fixture({ asker: "stranger-installation" });
    await writeFile(join(stranger.root, "a.md"), "keep");
    expect(await stranger.ask((c) => c.Write(HOST, { ...stranger.where, path: path("a.md"), text: "x", base: null }))).toEqual({ refused: "denied" });
    const self = await fixture({ editor: "self" });
    await writeFile(join(self.root, "a.md"), "keep");
    expect(await self.ask((c) => c.Trash(HOST, { ...self.where, path: path("a.md") }))).toEqual({ refused: "denied" });
    expect(await readFile(join(self.root, "a.md"), "utf8")).toBe("keep");
    expect(self.trashed).toEqual([]);
    expect(await self.ask((c) => c.List(HOST, { canvas: "not-held", node: asNodeId(NODE), dir: path("") }))).toEqual({ refused: "denied" });
  });

  it("checks the editor on every request, not once per link", async () => {
    const f = await fixture();
    await writeFile(join(f.root, "a.md"), "keep");
    expect(await f.ask((c) => c.List(HOST, { ...f.where, dir: path("") }))).toHaveProperty("answer");
    // The link stays up and the hello is unchanged; the machine is no longer pinned.
    await f.runtime.runPromise(Effect.flatMap(MachineRepository, (machines) => machines.retirePeer("macbook")));
    expect(await f.ask((c) => c.List(HOST, { ...f.where, dir: path("") }))).toEqual({ refused: "denied" });
  });

  it("does nothing for a link that closed", async () => {
    const f = await fixture();
    await writeFile(join(f.root, "a.md"), "keep");
    const closed = new AbortController();
    closed.abort();
    const trash = f.channel.handleRequest("Trash", { ...f.context, signal: closed.signal }, { ...f.where, path: "a.md" });
    const failure = await f.runtime.runPromise(Effect.flip(trash));
    expect(failure).toBeInstanceOf(FilesLinkClosed);
    expect(await readFile(join(f.root, "a.md"), "utf8")).toBe("keep");
  });

  it("reads text that does not fit one frame as too-large with its size, and refuses such a write untouched", async () => {
    const f = await fixture();
    const big = "x".repeat(FILES_LINK_TEXT_JSON_MAX + 10);
    await writeFile(join(f.root, "big.txt"), big);
    expect(await f.ask((c) => c.Read(HOST, { ...f.where, path: path("big.txt") }))).toMatchObject({ answer: { kind: "too-large", size: big.length } });
    await writeFile(join(f.root, "small.txt"), "small");
    expect(await f.ask((c) => c.Write(HOST, { ...f.where, path: path("small.txt"), text: big, base: null }))).toEqual({ refused: "too-large" });
    const read = await f.ask((c) => c.Read(HOST, { ...f.where, path: path("small.txt") }));
    const stamp = (read as { answer: { stamp: { mtimeMs: number; size: number } } }).answer.stamp;
    expect(await f.ask((c) => c.Write(HOST, { ...f.where, path: path("small.txt"), text: big, base: stamp }))).toEqual({ refused: "too-large" });
    expect(await readFile(join(f.root, "small.txt"), "utf8")).toBe("small");
  });

  it("refuses import as denied until bytes travel", async () => {
    const f = await fixture();
    expect(await f.ask((c) => c.Import(HOST, { ...f.where, into: path("") }))).toEqual({ refused: "denied" });
  });

  it("refuses a request no contract schema holds, at the asking end and at the host's decode, with no root, absolute path or command", async () => {
    const f = await fixture();
    const payload = FilesLink.requests.get("List")!.payload;
    for (const bad of [
      { ...f.where, dir: "/etc" },
      { ...f.where, dir: "", root: "/" },
    ]) expect(() => payload.decode(bad), JSON.stringify(bad)).toThrow();
    expect(() => FilesLink.requests.get("Read")!.payload.decode({ ...f.where, path: "../x" })).toThrow();
    // There is no request to run a command with.
    expect(FilesLink.requests.has("Exec")).toBe(false);
    // The typed client encodes with the same schema, so it never puts one on the link.
    await expect(f.ask((c) => c.List(HOST, { ...f.where, dir: "/etc" as FilePath }))).rejects.toMatchObject({ _tag: "LinkFrameInvalid" });
  });
});

describe("files channel while filesRemote is off on the host", () => {
  it("is bound and refuses every op denied, without admission, the service or a log of names", async () => {
    const f = await fixture({ enabled: false });
    await writeFile(join(f.root, "a.md"), "keep");
    expect(await f.ask((c) => c.Open(HOST, f.where))).toEqual({ refused: "denied" });
    expect(await f.ask((c) => c.List(HOST, { ...f.where, dir: path("") }))).toEqual({ refused: "denied" });
    expect(await f.ask((c) => c.Read(HOST, { ...f.where, path: path("a.md") }))).toEqual({ refused: "denied" });
    expect(await f.ask((c) => c.Trash(HOST, { ...f.where, path: path("a.md") }))).toEqual({ refused: "denied" });
    expect(await f.ask((c) => c.Write(HOST, { ...f.where, path: path("a.md"), text: "x", base: null }))).toEqual({ refused: "denied" });
    expect(await readFile(join(f.root, "a.md"), "utf8")).toBe("keep");
    expect(f.trashed).toEqual([]);
    // Still a closed decoder: a malformed request is refused at decode, as when it is on.
    expect(() => FilesLink.requests.get("List")!.payload.decode({ ...f.where, dir: "/etc" })).toThrow();
  });

  it("answers a window machine that has it on denied, and the seat traffic on the same link keeps flowing", async () => {
    const echo: LinkChannelHandler = {
      decodeRequest: (payload) => payload, decodeResponse: (payload) => payload, decodeEvent: (payload) => payload,
      handleRequest: (_context, payload) => Effect.succeed(payload),
    };
    const f = await fixture({ enabled: false, extra: { status: echo } });
    expect(await f.ask((c) => c.Open(HOST, f.where))).toEqual({ refused: "denied" });
    expect(await f.asker.request("status", { seat: "start" })).toEqual({ seat: "start" });
    expect(await f.ask((c) => c.List(HOST, { ...f.where, dir: path("") }))).toEqual({ refused: "denied" });
    expect(await f.asker.request("status", { seat: "attach" })).toEqual({ seat: "attach" });
  });
});

describe("files channel events", () => {
  const fakeHost = () => {
    const opened: number[] = [];
    const closed: number[] = [];
    const host = {
      open: async (subscriber: number) => { opened.push(subscriber); return { ok: true, value: { name: "root", repo: false } } as const; },
      closeSubscriber: (subscriber: number) => { closed.push(subscriber); },
    } as unknown as FilesHost;
    return { host, opened, closed };
  };

  it("gives a peer's session a subscriber above any window id, whose changes go to the link", async () => {
    const fake = fakeHost();
    const f = await fixture({ host: fake.host });
    await f.ask((c) => c.Open(HOST, f.where));
    const [subscriber] = fake.opened;
    expect(subscriber).toBeGreaterThanOrEqual(PEER_SUBSCRIBER_BASE);
    await f.ask((c) => c.Open(HOST, { canvas, node: asNodeId(AWAY) }));
    expect(fake.opened[1]).toBe(subscriber);
    const change: FilesChanged = { node: asNodeId(NODE), kind: "paths", paths: ["a.md"] as never };
    expect(f.subscribers.deliver(subscriber!, change)).toBe(true);
    await expect.poll(() => f.sent.length).toBe(1);
    expect(f.sent[0]).toEqual({ node: NODE, kind: "paths", paths: ["a.md"] });
    expect(f.subscribers.deliver(5, change)).toBe(false);
    f.subscribers.deliver(subscriber!, { node: asNodeId(NODE), kind: "closed", error: "unreachable", machine: "mini", lastReachedAt: null });
    await expect.poll(() => f.sent.length).toBe(2);
    expect(f.sent[1]).toEqual({ node: NODE, kind: "closed", error: "failed" });
  });

  it("says reset when a change is too large for one frame", async () => {
    const fake = fakeHost();
    const f = await fixture({ host: fake.host });
    await f.ask((c) => c.Open(HOST, f.where));
    const paths = Array.from({ length: 300 }, (_, i) => `${"d".repeat(3000)}${String(i)}`);
    f.subscribers.deliver(fake.opened[0]!, { node: asNodeId(NODE), kind: "paths", paths: paths as never });
    await expect.poll(() => f.sent.length).toBe(1);
    expect(f.sent[0]).toEqual({ node: NODE, kind: "reset" });
  });

  it("drops the session's subscriber when the link closes", async () => {
    const fake = fakeHost();
    const f = await fixture({ host: fake.host });
    await f.ask((c) => c.Open(HOST, f.where));
    await f.asker.close();
    await expect.poll(() => fake.closed).toEqual(fake.opened);
    expect(f.subscribers.deliver(fake.opened[0]!, { node: asNodeId(NODE), kind: "reset" })).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(f.sent).toEqual([]);
  });
});

describe("files channel logs", () => {
  it("names the op, the node and the outcome, never a name or text", async () => {
    const logHome = await mkdtemp(join(tmpdir(), "junto-files-log-"));
    cleanups.push(async () => { testLog.log.closeFile(); await rm(logHome, { recursive: true, force: true }); });
    testLog.log.openFile({ home: logHome });
    const f = await fixture();
    await writeFile(join(f.root, "secretname-a1.md"), "secrettext-b2");
    await f.ask((c) => c.List(HOST, { ...f.where, dir: path("") }));
    await f.ask((c) => c.Read(HOST, { ...f.where, path: path("secretname-a1.md") }));
    await f.ask((c) => c.Rename(HOST, { ...f.where, path: path("secretname-a1.md"), name: "secretname-c3.md" }));
    await f.ask((c) => c.Read(HOST, { ...f.where, path: path("secretname-gone.md") }));
    const log = readFileSync(join(machineLogDir(logHome), "core.jsonl"), "utf8");
    expect(log).toContain("files op");
    expect(log).toContain(NODE);
    for (const leaked of ["secretname", "secrettext"]) expect(log).not.toContain(leaked);
  });
});
