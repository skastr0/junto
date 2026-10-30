import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { asNodeId } from "../src/shared/physics/schema";
import type { FilesChanged } from "../src/shared/files";
import { decodeFilesResponse, FILES_LINK_TEXT_JSON_MAX } from "../src/shared/files-link";
import { makeFilesLinkChannel, type FilesHost } from "../src/main/junto/files/link";
import { makePeerSubscribers, PEER_SUBSCRIBER_BASE } from "../src/main/junto/files/peer-subscribers";
import { makeFilesService } from "../src/main/junto/files/service";
import { LinkHelloSchema } from "../src/main/junto/link/protocol";
import { makeLinkSession } from "../src/main/junto/link/session";
import type { LinkChannelContext, LinkChannelHandler } from "../src/main/junto/link/types";
import { MachineRepository, makeMachineRepositoryLive } from "../src/main/junto/machines/repository";
import { ModelService } from "../src/main/junto/model/service";
import { closeMachineLog, installMachineLog, ObservabilityLoggerLive } from "../src/main/junto/observability/logger";
import { machineLogDir } from "../src/main/junto/observability/log-file";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { WorkRepositoryLive } from "../src/main/junto/work/repository";
import { InstallationId } from "../src/shared/installation-id";
import { asCanvasName } from "../src/shared/model";
import { THIS_MACHINE } from "./support/machines";
import { files as filesNode } from "./support/model-nodes";
import { ModelStoresLive, seedCanvas } from "./support/seed-canvas";
import { clearMachines, seedThisMachine } from "./support/seed-this-machine";

const installation = Schema.decodeUnknownSync(InstallationId);
const editor = installation("editor-installation");
const canvas = asCanvasName("files-canvas");
const NODE = "files-1";
const AWAY = "files-away";

const cleanups: Array<() => Promise<void>> = [];
beforeEach(() => seedThisMachine());
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  clearMachines();
});

const fixture = async (options: { readonly editor?: "editor" | "self"; readonly host?: FilesHost; readonly enabled?: boolean } = {}) => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "junto-files-link-")));
  const root = join(base, "root");
  await mkdir(root, { recursive: true });
  const nodes = [filesNode(NODE, { host: THIS_MACHINE, root }), filesNode(AWAY, { host: THIS_MACHINE, root })];
  const repositories = Layer.provideMerge(Layer.mergeAll(
    WorkRepositoryLive,
    makeMachineRepositoryLive({ defaultName: () => THIS_MACHINE }),
  ), makeStateEngineLive(join(base, "junto.db")));
  const runtime = ManagedRuntime.make(Layer.mergeAll(Layer.provideMerge(ModelStoresLive, repositories), ObservabilityLoggerLive));
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
  const sent: Array<unknown> = [];
  const context: LinkChannelContext = {
    peer: { build: "same-build", installationId: editor, machineName: "macbook" },
    keyBound: false,
    sessionId: "admitted-link", operationId: "op-files-1", signal: new AbortController().signal,
    sendEvent: (_channel, payload) => Effect.sync(() => { sent.push(payload); }), close: () => Effect.void, request: () => Effect.die("unused"),
  };
  const ask = (raw: unknown, caller = context) =>
    runtime.runPromise(channel.handleRequest!(caller, raw).pipe(Effect.provide(ObservabilityLoggerLive))).then((response) => decodeFilesResponse(response));
  const where = { canvas, node: NODE };
  return { base, root, channel, context, ask, where, sent, subscribers, trashed, runtime };
};

describe("files channel host", () => {
  it("serves every op through the Files service for the editing machine", async () => {
    const f = await fixture();
    await writeFile(join(f.root, "a.md"), "hello");
    expect(await f.ask({ _tag: "Open", ...f.where })).toMatchObject({ _tag: "Opened", root: { repo: false } });
    expect(await f.ask({ _tag: "Count", ...f.where })).toMatchObject({ _tag: "Counted", capped: false });
    const listed = await f.ask({ _tag: "List", ...f.where, dir: "" });
    expect(listed).toMatchObject({ _tag: "Listed", entries: [{ path: "a.md", dir: false }] });
    const read = await f.ask({ _tag: "Read", ...f.where, path: "a.md" });
    expect(read).toMatchObject({ _tag: "Read", read: { kind: "text", text: "hello" } });
    const stamp = (read as { read: { stamp: { mtimeMs: number; size: number } } }).read.stamp;
    const written = await f.ask({ _tag: "Write", ...f.where, path: "a.md", text: "changed", base: stamp });
    expect(written).toMatchObject({ _tag: "Written" });
    expect(await readFile(join(f.root, "a.md"), "utf8")).toBe("changed");
    expect(await f.ask({ _tag: "Write", ...f.where, path: "a.md", text: "again", base: stamp })).toEqual({ _tag: "Refused", error: "stale" });
    expect(await f.ask({ _tag: "Create", ...f.where, path: "d", dir: true })).toMatchObject({ _tag: "Created", entry: { path: "d", dir: true } });
    expect(await f.ask({ _tag: "Rename", ...f.where, path: "a.md", name: "b.md" })).toEqual({ _tag: "Renamed", path: "b.md" });
    expect(await f.ask({ _tag: "Move", ...f.where, path: "b.md", into: "d" })).toEqual({ _tag: "Moved", path: "d/b.md" });
    expect(await f.ask({ _tag: "Trash", ...f.where, path: "d/b.md" })).toEqual({ _tag: "Trashed" });
    expect(f.trashed).toEqual([join(f.root, "d", "b.md")]);
    expect(await f.ask({ _tag: "Close", ...f.where })).toEqual({ _tag: "Closed" });
  });

  it("answers the service's own refusals: a node elsewhere, a missing file, a path through a link out of the root", async () => {
    const f = await fixture();
    expect(await f.ask({ _tag: "List", canvas, node: AWAY, dir: "" })).toEqual({ _tag: "Refused", error: "elsewhere" });
    expect(await f.ask({ _tag: "List", canvas, node: "files-none", dir: "" })).toEqual({ _tag: "Refused", error: "no-node" });
    expect(await f.ask({ _tag: "Read", ...f.where, path: "missing.md" })).toEqual({ _tag: "Refused", error: "not-found" });
  });

  it("admits only the pinned editor of the canvas, and answers denied, never unreachable", async () => {
    const stranger = await fixture();
    await writeFile(join(stranger.root, "a.md"), "keep");
    const refused = await stranger.ask({ _tag: "Write", ...stranger.where, path: "a.md", text: "x", base: null },
      { ...stranger.context, peer: { ...stranger.context.peer, installationId: installation("stranger") } });
    expect(refused).toEqual({ _tag: "Refused", error: "denied" });
    const self = await fixture({ editor: "self" });
    await writeFile(join(self.root, "a.md"), "keep");
    expect(await self.ask({ _tag: "Trash", ...self.where, path: "a.md" })).toEqual({ _tag: "Refused", error: "denied" });
    expect(await readFile(join(self.root, "a.md"), "utf8")).toBe("keep");
    expect(self.trashed).toEqual([]);
    const unknown = await self.ask({ _tag: "List", canvas: "not-held", node: NODE, dir: "" });
    expect(unknown).toEqual({ _tag: "Refused", error: "denied" });
  });

  it("checks the editor on every request, not once per link", async () => {
    const f = await fixture();
    await writeFile(join(f.root, "a.md"), "keep");
    expect(await f.ask({ _tag: "List", ...f.where, dir: "" })).toMatchObject({ _tag: "Listed" });
    await f.runtime.runPromise(Effect.gen(function* () {
      yield* (yield* MachineRepository).pinPeer({ machineName: "macbook", installationId: installation("someone-else") });
    }).pipe(Effect.ignore));
    const other = { ...f.context, peer: { ...f.context.peer, installationId: installation("someone-else") } };
    expect(await f.ask({ _tag: "List", ...f.where, dir: "" }, other)).toEqual({ _tag: "Refused", error: "denied" });
  });

  it("does nothing for a link that closed", async () => {
    const f = await fixture();
    await writeFile(join(f.root, "a.md"), "keep");
    const closed = new AbortController();
    closed.abort();
    await expect(f.ask({ _tag: "Trash", ...f.where, path: "a.md" }, { ...f.context, signal: closed.signal })).rejects.toBeTruthy();
    expect(await readFile(join(f.root, "a.md"), "utf8")).toBe("keep");
  });

  it("reads text that does not fit one frame as too-large with its size, and refuses such a write untouched", async () => {
    const f = await fixture();
    const big = "x".repeat(FILES_LINK_TEXT_JSON_MAX + 10);
    await writeFile(join(f.root, "big.txt"), big);
    expect(await f.ask({ _tag: "Read", ...f.where, path: "big.txt" })).toMatchObject({ _tag: "Read", read: { kind: "too-large", size: big.length } });
    await writeFile(join(f.root, "small.txt"), "small");
    expect(await f.ask({ _tag: "Write", ...f.where, path: "small.txt", text: big, base: null })).toEqual({ _tag: "Refused", error: "too-large" });
    const stamp = ((await f.ask({ _tag: "Read", ...f.where, path: "small.txt" })) as { read: { stamp: { mtimeMs: number; size: number } } }).read.stamp;
    expect(await f.ask({ _tag: "Write", ...f.where, path: "small.txt", text: big, base: stamp })).toEqual({ _tag: "Refused", error: "too-large" });
    expect(await readFile(join(f.root, "small.txt"), "utf8")).toBe("small");
  });

  it("refuses import as denied until bytes travel", async () => {
    const f = await fixture();
    expect(await f.ask({ _tag: "Import", ...f.where, into: "" })).toEqual({ _tag: "Refused", error: "denied" });
  });

  it("decodes requests closed, with no root, absolute path or command", () => {
    return fixture().then((f) => {
      for (const bad of [
        { _tag: "List", ...f.where, dir: "/etc" },
        { _tag: "List", ...f.where, dir: "", root: "/" },
        { _tag: "Read", ...f.where, path: "../x" },
        { _tag: "Exec", ...f.where },
      ]) expect(() => f.channel.decodeRequest(bad), JSON.stringify(bad)).toThrow();
    });
  });
});

describe("files channel while filesRemote is off on the host", () => {
  const hello = (name: string) => Schema.decodeUnknownSync(LinkHelloSchema)({ build: "a".repeat(64), installationId: `${name}-install`, machineName: name });

  it("is bound and refuses every op denied, without admission, the service or a log of names", async () => {
    const f = await fixture({ enabled: false });
    await writeFile(join(f.root, "a.md"), "keep");
    for (const request of [
      { _tag: "Open", ...f.where }, { _tag: "List", ...f.where, dir: "" }, { _tag: "Read", ...f.where, path: "a.md" },
      { _tag: "Trash", ...f.where, path: "a.md" }, { _tag: "Write", ...f.where, path: "a.md", text: "x", base: null },
    ]) expect(await f.ask(request)).toEqual({ _tag: "Refused", error: "denied" });
    expect(await readFile(join(f.root, "a.md"), "utf8")).toBe("keep");
    expect(f.trashed).toEqual([]);
    // Still a closed decoder: a malformed request is refused at decode, as when it is on.
    expect(() => f.channel.decodeRequest({ _tag: "List", ...f.where, dir: "/etc" })).toThrow();
  });

  it("answers a window machine that has it on denied, and the seat traffic on the same link keeps flowing", async () => {
    const f = await fixture({ enabled: false });
    const echo: LinkChannelHandler = {
      decodeRequest: (payload) => payload, decodeResponse: (payload) => payload, decodeEvent: (payload) => payload,
      handleRequest: (_context, payload) => Effect.succeed(payload),
    };
    const toHost = new PassThrough();
    const toWindow = new PassThrough();
    const host = makeLinkSession({
      readable: toHost, writable: toWindow, self: hello("mini"), admit: async () => {}, run: Effect.runPromise,
      channels: { status: echo, files: f.channel },
    });
    const window = makeLinkSession({
      readable: toWindow, writable: toHost, self: hello("macbook"), admit: async () => {}, run: Effect.runPromise,
      channels: { status: echo, files: f.channel },
    });
    cleanups.push(async () => { await Promise.all([host.close(), window.close()]); });
    await Promise.all([host.ready, window.ready]);
    // The host runs the handler against its own admitted peer; the editor check is not reached while the feature is off.
    expect(await window.request("files", { _tag: "Open", ...f.where })).toEqual({ _tag: "Refused", error: "denied" });
    expect(await window.request("status", { seat: "start" })).toEqual({ seat: "start" });
    expect(await window.request("files", { _tag: "List", ...f.where, dir: "" })).toEqual({ _tag: "Refused", error: "denied" });
    expect(await window.request("status", { seat: "attach" })).toEqual({ seat: "attach" });
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
    await f.ask({ _tag: "Open", ...f.where });
    const [subscriber] = fake.opened;
    expect(subscriber).toBeGreaterThanOrEqual(PEER_SUBSCRIBER_BASE);
    await f.ask({ _tag: "Open", canvas, node: AWAY });
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
    await f.ask({ _tag: "Open", ...f.where });
    const paths = Array.from({ length: 300 }, (_, i) => `${"d".repeat(3000)}${String(i)}`);
    f.subscribers.deliver(fake.opened[0]!, { node: asNodeId(NODE), kind: "paths", paths: paths as never });
    await expect.poll(() => f.sent.length).toBe(1);
    expect(f.sent[0]).toEqual({ node: NODE, kind: "reset" });
  });

  it("drops the session's subscriber when the link closes", async () => {
    const fake = fakeHost();
    const f = await fixture({ host: fake.host });
    await f.ask({ _tag: "Open", ...f.where });
    await f.runtime.runPromise(f.channel.closed!(f.context));
    expect(fake.closed).toEqual(fake.opened);
    expect(f.subscribers.deliver(fake.opened[0]!, { node: asNodeId(NODE), kind: "reset" })).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(f.sent).toEqual([]);
  });
});

describe("files channel logs", () => {
  it("names the op, the node and the outcome, never a name or text", async () => {
    const logHome = await mkdtemp(join(tmpdir(), "junto-files-log-"));
    cleanups.push(async () => { closeMachineLog(); await rm(logHome, { recursive: true, force: true }); });
    installMachineLog({ home: logHome, process: "core", echo: false });
    const f = await fixture();
    await writeFile(join(f.root, "secretname-a1.md"), "secrettext-b2");
    await f.ask({ _tag: "List", ...f.where, dir: "" });
    await f.ask({ _tag: "Read", ...f.where, path: "secretname-a1.md" });
    await f.ask({ _tag: "Rename", ...f.where, path: "secretname-a1.md", name: "secretname-c3.md" });
    await f.ask({ _tag: "Read", ...f.where, path: "secretname-gone.md" });
    const log = readFileSync(join(machineLogDir(logHome), "core.jsonl"), "utf8");
    expect(log).toContain("files op");
    expect(log).toContain(NODE);
    for (const leaked of ["secretname", "secrettext"]) expect(log).not.toContain(leaked);
  });
});
