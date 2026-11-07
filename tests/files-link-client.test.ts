import { Effect, Layer, ManagedRuntime, Option } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { asNodeId } from "../src/shared/physics/schema";
import type { FilePath, FilesChanged, FilesNodeRef } from "../src/shared/files";
import { FILES_LINK_TEXT_JSON_MAX, FilesRefused, type FilesLinkFailure, type HostFilesError } from "../src/shared/files-link";
import { eventOf, FilesLink } from "../src/core/files/link";
import { filesRemoteLayer, FilesRemoteService, makeFilesRemote, type RemoteChange } from "../src/core/files/link-client";
import { bindLinkChannel } from "../src/core/link/contract";
import type { LinkEventContext, LinkSession } from "../src/core/link/types";
import { MachineRepository } from "../src/core/machines/repository";
import { facingRaw, hello, machineLinkLayer, makeSessions, pair } from "./support/link-pair";

const MINI = "mini";
const ref: FilesNodeRef = { canvas: "factory", node: asNodeId("files-1") };
const stamp = { mtimeMs: 1, size: 1 };
const path = (raw: string) => raw as FilePath;
const context: LinkEventContext = {
  peer: { build: "b", installationId: "mini-install" as never, machineName: MINI },
  keyBound: false, sessionId: "s", signal: new AbortController().signal,
  sendEvent: () => Effect.void, close: () => Effect.void,
};

const links = makeSessions();
afterEach(() => links.closeAll());

type Next = () => Effect.Effect<unknown, FilesLinkFailure>;

/**
 * The window machine's `FilesRemote` over its link to a host this test
 * scripts: the next answers are the host's handlers' (every one decoded and
 * encoded by the contract on the way), and every request it saw is kept.
 */
const fixture = async () => {
  const seen: Array<{ tag: string; payload: unknown }> = [];
  const script: Next[] = [];
  let at = 1000;
  let windowSession: LinkSession | undefined;
  let hostSession: LinkSession | undefined;
  const changes: RemoteChange[] = [];
  const machines = { peer: (name: string) => Effect.succeed(name === MINI ? { machineName: MINI, installationId: "mini-install" } : undefined) } as never;
  const remote = await Effect.runPromise(makeFilesRemote({ now: () => at }).pipe(
    Effect.provide(Layer.mergeAll(machineLinkLayer(() => windowSession), Layer.succeed(MachineRepository, machines))),
  ));
  remote.onChange((change) => changes.push(change));

  // A tag's handler: it records the request, then runs the next scripted answer. An answer the script does not
  // have is a defect, which the test then sees as the call failing.
  const serve = (tag: string) => (payload: unknown): Effect.Effect<never, FilesLinkFailure> => {
    seen.push({ tag, payload });
    const next = script.shift();
    return (next === undefined ? Effect.die("nothing scripted") : next()) as Effect.Effect<never, FilesLinkFailure>;
  };
  const serving = bindLinkChannel(FilesLink, {
    requests: {
      Open: serve("Open"), Close: serve("Close"), Count: serve("Count"), List: serve("List"), Read: serve("Read"), Write: serve("Write"),
      Create: serve("Create"), Rename: serve("Rename"), Move: serve("Move"), Trash: serve("Trash"), Import: serve("Import"), Search: serve("Search"),
    },
    event: () => Effect.void,
  });
  const die = () => Effect.die("the window machine serves nothing");
  // The window machine's end of the channel: the host's events reach `onEvent` as they do in the core.
  const window = bindLinkChannel(FilesLink, {
    requests: { Open: die, Close: die, Count: die, List: die, Read: die, Write: die, Create: die, Rename: die, Move: die, Trash: die, Import: die, Search: die },
    event: (event, ctx) => remote.onEvent(ctx, event),
  });
  /** The link comes up. */
  const connect = async (): Promise<void> => {
    const { a, b } = pair(
      { self: hello("macbook"), channels: { files: window } },
      { self: hello(MINI), channels: { files: serving } },
    );
    links.keep(a, b);
    await Promise.all([a.ready, b.ready]);
    windowSession = a;
    hostSession = b;
  };
  /** The host goes away: the window's session stays, closed, as it does until the link is made again. */
  const drop = async (): Promise<void> => {
    await hostSession!.close();
    await expect.poll(async () => windowSession!.closed.then(() => true, () => true)).toBe(true);
  };
  return {
    remote, seen, script, changes, connect, drop, tick: (to: number) => { at = to; },
    hostSend: (event: unknown) => hostSession!.sendEvent("files", event),
    /** The window facing a host written by hand, to give it an answer no contract schema holds. */
    facing: (reply: (frame: { id: string; op: string; channel: string }) => unknown) => {
      const raw = facingRaw(hello("macbook"), hello(MINI), { files: window }, (frame) => frame.type === "request" ? reply(frame) : undefined);
      links.keep(raw.session);
      windowSession = raw.session;
    },
  };
};

const answers = (response: unknown): Next => () => Effect.succeed(response);
const refuses = (error: HostFilesError): Next => () => Effect.fail(new FilesRefused({ error }));
const unreachable = (lastReachedAt: number | null) => ({ ok: false, error: "unreachable", machine: MINI, lastReachedAt });
const opened = { name: "docs", repo: false };

describe("files remote: unreachable comes from the link alone", () => {
  it("answers unreachable with a null last-reached when no link was ever open", async () => {
    const f = await fixture();
    expect(await f.remote.list(MINI, ref, path(""))).toEqual(unreachable(null));
    expect(f.seen).toEqual([]);
  });

  it("answers unreachable with when it last reached the machine, when the link is lost", async () => {
    const f = await fixture();
    await f.connect();
    f.script.push(answers([]));
    f.tick(2000);
    expect(await f.remote.list(MINI, ref, path(""))).toEqual({ ok: true, value: [] });
    f.tick(9000);
    await f.drop();
    expect(await f.remote.list(MINI, ref, path(""))).toEqual(unreachable(2000));
    expect(await f.remote.trash(MINI, ref, path("a.md"))).toEqual(unreachable(2000));
  });

  it("refuses a save in flight when the link drops, never queues it, and keeps no copy", async () => {
    const f = await fixture();
    await f.connect();
    await f.drop();
    expect(await f.remote.write(MINI, ref, path("a.md"), "draft", stamp)).toEqual(unreachable(null));
    // The link is back, and nothing was held to send again.
    await f.connect();
    f.script.push(answers([]));
    expect(await f.remote.list(MINI, ref, path(""))).toEqual({ ok: true, value: [] });
    expect(f.seen.map((request) => request.tag)).toEqual(["List"]);
  });

  it("carries the host's own refusals as refusals, never as unreachable", async () => {
    const f = await fixture();
    await f.connect();
    f.script.push(refuses("denied"), refuses("elsewhere"), refuses("no-node"));
    expect(await f.remote.read(MINI, ref, path("a.md"))).toEqual({ ok: false, error: "denied" });
    expect(await f.remote.list(MINI, ref, path(""))).toEqual({ ok: false, error: "elsewhere" });
    expect(await f.remote.count(MINI, ref)).toEqual({ ok: false, error: "no-node" });
    // The machine answered, so it was reached.
    f.tick(5000);
    await f.drop();
    expect(await f.remote.count(MINI, ref)).toEqual(unreachable(1000));
  });

  it("fails, not unreachable, when the host's handler failed or its answer is outside the schema", async () => {
    const f = await fixture();
    await f.connect();
    // Nothing scripted: the host's handler dies, and its link stays up.
    expect(await f.remote.list(MINI, ref, path(""))).toEqual({ ok: false, error: "failed" });
    const raw = await fixture();
    raw.facing((frame) => ({ type: "response", id: frame.id, op: frame.op, channel: frame.channel, ok: true, payload: { nonsense: true } }));
    expect(await raw.remote.list(MINI, ref, path(""))).toEqual({ ok: false, error: "failed" });
  });

  it("refuses a text over one frame before it reaches the link", async () => {
    const f = await fixture();
    await f.connect();
    const result = await f.remote.write(MINI, ref, path("a.md"), "x".repeat(FILES_LINK_TEXT_JSON_MAX), null);
    expect(result).toEqual({ ok: false, error: "too-large" });
    expect(f.seen).toEqual([]);
  });

  it("names the node and the path on the wire and nothing else", async () => {
    const f = await fixture();
    await f.connect();
    f.script.push(answers("b.md"));
    expect(await f.remote.rename(MINI, ref, path("a.md"), "b.md")).toEqual({ ok: true, value: "b.md" });
    expect(f.seen).toEqual([{ tag: "Rename", payload: { canvas: "factory", node: "files-1", path: "a.md", name: "b.md" } }]);
  });
});

describe("files remote: events and the link coming and going", () => {
  const open = async (f: Awaited<ReturnType<typeof fixture>>) => {
    f.script.push(answers(opened));
    expect(await f.remote.open(MINI, ref)).toMatchObject({ ok: true });
    expect(f.remote.watched(MINI)).toEqual(["files-1"]);
  };

  it("says closed with unreachable and when it was last reached when the link drops, then back when it returns", async () => {
    const f = await fixture();
    await f.connect();
    f.tick(2000);
    await open(f);
    f.tick(7000);
    await Effect.runPromise(f.remote.onClosed(context));
    expect(f.changes).toEqual([{ machine: MINI, change: { node: "files-1", kind: "closed", error: "unreachable", machine: MINI, lastReachedAt: 7000 } }]);
    // The window is told once; the node stays watched so it opens again.
    expect(f.remote.watched(MINI)).toEqual(["files-1"]);
    f.script.push(answers(opened));
    await Effect.runPromise(f.remote.onOpened(context));
    await expect.poll(() => f.changes.length).toBe(2);
    expect(f.changes[1]).toEqual({ machine: MINI, change: { node: "files-1", kind: "back" } });
    expect(f.seen.at(-1)).toEqual({ tag: "Open", payload: { canvas: "factory", node: "files-1" } });
  });

  it("watches a node opened while the machine is unreachable, and opens it again with back when the link comes up", async () => {
    const f = await fixture();
    expect(await f.remote.open(MINI, ref)).toEqual(unreachable(null));
    expect(f.remote.watched(MINI)).toEqual(["files-1"]);
    await f.connect();
    f.script.push(answers(opened));
    await Effect.runPromise(f.remote.onOpened(context));
    await expect.poll(() => f.changes.length).toBe(1);
    expect(f.changes[0]).toEqual({ machine: MINI, change: { node: "files-1", kind: "back" } });
    expect(f.seen.at(-1)).toEqual({ tag: "Open", payload: { canvas: "factory", node: "files-1" } });
  });

  it("stops watching a node the window closes while the machine is unreachable, so nothing opens it again", async () => {
    const f = await fixture();
    await f.remote.open(MINI, ref);
    expect(await f.remote.close(MINI, ref)).toEqual(unreachable(null));
    expect(f.remote.watched(MINI)).toEqual([]);
    await f.connect();
    await Effect.runPromise(f.remote.onOpened(context));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(f.seen).toEqual([]);
    expect(f.changes).toEqual([]);
  });

  it("says why when the node cannot open again, and stops watching it", async () => {
    const f = await fixture();
    await f.connect();
    await open(f);
    f.script.push(refuses("root-missing"));
    await Effect.runPromise(f.remote.onOpened(context));
    await expect.poll(() => f.changes.length).toBe(1);
    expect(f.changes[0]).toEqual({ machine: MINI, change: { node: "files-1", kind: "closed", error: "root-missing" } });
    expect(f.remote.watched(MINI)).toEqual([]);
  });

  it("passes a host's change for a node opened here, and drops any other", async () => {
    const f = await fixture();
    await f.connect();
    await open(f);
    const paths: FilesChanged = { node: asNodeId("files-1"), kind: "paths", paths: ["a.md"] as never };
    // The host sends it over the link, and it arrives through the window's event handler.
    await f.hostSend({ node: "files-1", kind: "paths", paths: ["a.md"] });
    await expect.poll(() => f.changes.length).toBe(1);
    await f.hostSend({ node: "files-2", kind: "reset" });
    // A change from a machine that is not pinned with that installation is dropped.
    await Effect.runPromise(f.remote.onEvent({ ...context, peer: { ...context.peer, installationId: "stranger" as never } }, { node: asNodeId("files-1"), kind: "reset" }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(f.changes).toEqual([{ machine: MINI, change: paths }]);
  });

  it("carries a rename on the host as a move the window machine follows", async () => {
    const f = await fixture();
    await f.connect();
    await open(f);
    const renamed: FilesChanged = {
      node: asNodeId("files-1"), kind: "paths", paths: ["notes/b.md"] as never,
      moves: [{ from: "notes/a.md" as never, to: "notes/b.md" as never }],
    };
    // Host: the change becomes an event, crosses the link, and is decoded closed at the other end.
    await f.hostSend(eventOf(renamed));
    await expect.poll(() => f.changes.length).toBe(1);
    expect(f.changes).toEqual([{ machine: MINI, change: renamed }]);
  });

  it("stops watching a node the host says closed, and one the window closed", async () => {
    const f = await fixture();
    await f.connect();
    await open(f);
    await Effect.runPromise(f.remote.onEvent(context, { node: asNodeId("files-1"), kind: "closed", error: "failed" }));
    expect(f.remote.watched(MINI)).toEqual([]);
    await open(f);
    f.script.push(answers(null));
    await f.remote.close(MINI, ref);
    expect(f.remote.watched(MINI)).toEqual([]);
  });
});

describe("files remote: held by a Layer", () => {
  const deps = () => Layer.mergeAll(
    machineLinkLayer(() => undefined),
    Layer.succeed(MachineRepository, { peer: () => Effect.succeed(undefined) } as never),
  );

  it("is one remote for the runtime that has the Layer, and absent in one that has not", async () => {
    const held = ManagedRuntime.make(Layer.provideMerge(filesRemoteLayer(), deps()));
    const bare = ManagedRuntime.make(deps());
    try {
      const [first, second] = await Promise.all([
        held.runPromise(Effect.serviceOption(FilesRemoteService)),
        held.runPromise(Effect.serviceOption(FilesRemoteService)),
      ]);
      expect(Option.isSome(first) && Option.isSome(second) && first.value === second.value).toBe(true);
      expect(Option.isNone(await bare.runPromise(Effect.serviceOption(FilesRemoteService)))).toBe(true);
      // It is the same remote the router asks: with no link open it answers unreachable.
      if (Option.isSome(first)) expect(await first.value.count(MINI, ref)).toEqual(unreachable(null));
    } finally {
      await Promise.all([held.dispose(), bare.dispose()]);
    }
  });
});
