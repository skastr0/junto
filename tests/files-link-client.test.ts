import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { asNodeId } from "../src/shared/physics/schema";
import type { FilesChanged, FilesNodeRef, FilesResult } from "../src/shared/files";
import { decodeFilesEvent, FILES_LINK_TEXT_JSON_MAX } from "../src/shared/files-link";
import { eventOf } from "../src/main/junto/files/link";
import { makeFilesRemote, type RemoteChange } from "../src/main/junto/files/link-client";
import { MachineLink } from "../src/main/junto/link/service";
import { linkClosed, LinkRequestFailed, LinkUnavailable, type LinkEventContext } from "../src/main/junto/link/types";
import { MachineRepository } from "../src/main/junto/machines/repository";

const MINI = "mini";
const ref: FilesNodeRef = { canvas: "factory", node: asNodeId("files-1") };
const stamp = { mtimeMs: 1, size: 1 };
const context: LinkEventContext = {
  peer: { build: "b", installationId: "mini-install" as never, machineName: MINI },
  keyBound: false, sessionId: "s", signal: new AbortController().signal,
  sendEvent: () => Effect.void, close: () => Effect.void,
};

/** A link whose next answers the test scripts; every request it saw is kept. */
const fixture = async () => {
  const seen: Array<{ machine: string; channel: string; payload: Record<string, unknown> }> = [];
  const script: Array<() => Effect.Effect<unknown, unknown>> = [];
  const link = MachineLink.of({
    request: (machine: string, channel: string, payload: unknown) => {
      seen.push({ machine, channel, payload: payload as Record<string, unknown> });
      const next = script.shift();
      return (next === undefined ? Effect.fail(new LinkUnavailable({ machine, reason: "not-linked", message: "not linked" })) : next()) as never;
    },
  } as never);
  const machines = { peer: (name: string) => Effect.succeed(name === MINI ? { machineName: MINI, installationId: "mini-install" } : undefined) } as never;
  let at = 1000;
  const remote = await Effect.runPromise(makeFilesRemote({ now: () => at }).pipe(
    Effect.provide(Layer.mergeAll(Layer.succeed(MachineLink, link), Layer.succeed(MachineRepository, machines))),
  ));
  const changes: RemoteChange[] = [];
  remote.onChange((change) => changes.push(change));
  return { remote, seen, script, changes, tick: (to: number) => { at = to; } };
};

const answers = (response: unknown) => () => Effect.succeed(response);
const fails = (failure: unknown) => () => Effect.fail(failure);
const unreachable = (lastReachedAt: number | null) => ({ ok: false, error: "unreachable", machine: MINI, lastReachedAt });
const closedLink = () => linkClosed({ machine: MINI, by: "peer", reason: "peer-closed" });

describe("files remote: unreachable comes from the link alone", () => {
  it("answers unreachable with a null last-reached when no link was ever open", async () => {
    const f = await fixture();
    expect(await f.remote.list(MINI, ref, "" as never)).toEqual(unreachable(null));
    expect(f.seen).toHaveLength(1);
  });

  it("answers unreachable with when it last reached the machine, when the link is lost", async () => {
    const f = await fixture();
    f.script.push(answers({ _tag: "Listed", entries: [] }), fails(closedLink()), fails(new LinkUnavailable({ machine: MINI, reason: "asleep", message: "asleep" })));
    f.tick(2000);
    expect(await f.remote.list(MINI, ref, "" as never)).toEqual({ ok: true, value: [] });
    f.tick(9000);
    expect(await f.remote.list(MINI, ref, "" as never)).toEqual(unreachable(2000));
    expect(await f.remote.trash(MINI, ref, "a.md" as never)).toEqual(unreachable(2000));
  });

  it("refuses a save in flight when the link drops, never queues it, and keeps no copy", async () => {
    const f = await fixture();
    f.script.push(fails(closedLink()));
    expect(await f.remote.write(MINI, ref, "a.md" as never, "draft", stamp)).toEqual(unreachable(null));
    expect(f.seen).toHaveLength(1);
    // The link is back, nothing was held to send again.
    expect(await f.remote.list(MINI, ref, "" as never)).toEqual(unreachable(null));
    expect(f.seen).toHaveLength(2);
    expect(f.seen[1]!.payload["_tag"]).toBe("List");
  });

  it("carries the host's own refusals as answers, never as unreachable", async () => {
    const f = await fixture();
    f.script.push(answers({ _tag: "Refused", error: "denied" }), answers({ _tag: "Refused", error: "elsewhere" }), answers({ _tag: "Refused", error: "no-node" }));
    expect(await f.remote.read(MINI, ref, "a.md" as never)).toEqual({ ok: false, error: "denied" });
    expect(await f.remote.list(MINI, ref, "" as never)).toEqual({ ok: false, error: "elsewhere" });
    expect(await f.remote.count(MINI, ref)).toEqual({ ok: false, error: "no-node" });
    // The machine answered, so it was reached.
    f.script.push(fails(closedLink()));
    f.tick(5000);
    expect(await f.remote.count(MINI, ref)).toEqual(unreachable(1000));
  });

  it("fails, not unreachable, when the host's handler failed or answered a different op", async () => {
    const f = await fixture();
    const requestFailed = new LinkRequestFailed({
      machine: MINI, channel: "files", operationId: "op", message: "failed",
      failure: { tag: "FilesLinkClosed", message: "closed", machine: MINI, causes: [] } as never,
    });
    f.script.push(fails(requestFailed), answers({ _tag: "Closed" }), answers({ nonsense: true }));
    const result = (await f.remote.list(MINI, ref, "" as never)) as FilesResult<unknown>;
    expect(result).toEqual({ ok: false, error: "failed" });
    expect(await f.remote.list(MINI, ref, "" as never)).toEqual({ ok: false, error: "failed" });
    expect(await f.remote.list(MINI, ref, "" as never)).toEqual({ ok: false, error: "failed" });
  });

  it("refuses a text over one frame before it reaches the link", async () => {
    const f = await fixture();
    const result = await f.remote.write(MINI, ref, "a.md" as never, "x".repeat(FILES_LINK_TEXT_JSON_MAX), null);
    expect(result).toEqual({ ok: false, error: "too-large" });
    expect(f.seen).toEqual([]);
  });

  it("names the machine, the node and the path on the wire and nothing else", async () => {
    const f = await fixture();
    f.script.push(answers({ _tag: "Renamed", path: "b.md" }));
    expect(await f.remote.rename(MINI, ref, "a.md" as never, "b.md")).toEqual({ ok: true, value: "b.md" });
    expect(f.seen).toEqual([{ machine: MINI, channel: "files", payload: { _tag: "Rename", canvas: "factory", node: "files-1", path: "a.md", name: "b.md" } }]);
  });
});

describe("files remote: events and the link coming and going", () => {
  const opened = async (f: Awaited<ReturnType<typeof fixture>>) => {
    f.script.push(answers({ _tag: "Opened", root: { name: "docs", repo: false } }));
    expect(await f.remote.open(MINI, ref)).toMatchObject({ ok: true });
    expect(f.remote.watched(MINI)).toEqual(["files-1"]);
  };

  it("says closed with unreachable and when it was last reached when the link drops, then back when it returns", async () => {
    const f = await fixture();
    f.tick(2000);
    await opened(f);
    f.tick(7000);
    await Effect.runPromise(f.remote.onClosed(context));
    expect(f.changes).toEqual([{ machine: MINI, change: { node: "files-1", kind: "closed", error: "unreachable", machine: MINI, lastReachedAt: 7000 } }]);
    // The window is told once; the node stays watched so it opens again.
    expect(f.remote.watched(MINI)).toEqual(["files-1"]);
    f.script.push(answers({ _tag: "Opened", root: { name: "docs", repo: false } }));
    await Effect.runPromise(f.remote.onOpened(context));
    await expect.poll(() => f.changes.length).toBe(2);
    expect(f.changes[1]).toEqual({ machine: MINI, change: { node: "files-1", kind: "back" } });
    expect(f.seen.at(-1)!.payload).toEqual({ _tag: "Open", canvas: "factory", node: "files-1" });
  });

  it("watches a node opened while the machine is unreachable, and opens it again with back when the link comes up", async () => {
    const f = await fixture();
    expect(await f.remote.open(MINI, ref)).toEqual(unreachable(null));
    expect(f.remote.watched(MINI)).toEqual(["files-1"]);
    f.script.push(answers({ _tag: "Opened", root: { name: "docs", repo: false } }));
    await Effect.runPromise(f.remote.onOpened(context));
    await expect.poll(() => f.changes.length).toBe(1);
    expect(f.changes[0]).toEqual({ machine: MINI, change: { node: "files-1", kind: "back" } });
    expect(f.seen.at(-1)!.payload).toEqual({ _tag: "Open", canvas: "factory", node: "files-1" });
  });

  it("stops watching a node the window closes while the machine is unreachable, so nothing opens it again", async () => {
    const f = await fixture();
    await f.remote.open(MINI, ref);
    expect(await f.remote.close(MINI, ref)).toEqual(unreachable(null));
    expect(f.remote.watched(MINI)).toEqual([]);
    const before = f.seen.length;
    await Effect.runPromise(f.remote.onOpened(context));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(f.seen).toHaveLength(before);
    expect(f.changes).toEqual([]);
  });

  it("says why when the node cannot open again, and stops watching it", async () => {
    const f = await fixture();
    await opened(f);
    f.script.push(answers({ _tag: "Refused", error: "root-missing" }));
    await Effect.runPromise(f.remote.onOpened(context));
    await expect.poll(() => f.changes.length).toBe(1);
    expect(f.changes[0]).toEqual({ machine: MINI, change: { node: "files-1", kind: "closed", error: "root-missing" } });
    expect(f.remote.watched(MINI)).toEqual([]);
  });

  it("passes a host's change for a node opened here, and drops any other", async () => {
    const f = await fixture();
    await opened(f);
    const paths: FilesChanged = { node: asNodeId("files-1"), kind: "paths", paths: ["a.md"] as never };
    await Effect.runPromise(f.remote.onEvent(context, { node: asNodeId("files-1"), kind: "paths", paths: ["a.md"] as never }));
    await Effect.runPromise(f.remote.onEvent(context, { node: asNodeId("files-2"), kind: "reset" }));
    await Effect.runPromise(f.remote.onEvent({ ...context, peer: { ...context.peer, installationId: "stranger" as never } }, { node: asNodeId("files-1"), kind: "reset" }));
    expect(f.changes).toEqual([{ machine: MINI, change: paths }]);
  });

  it("carries a rename on the host as a move the window machine follows", async () => {
    const f = await fixture();
    await opened(f);
    const renamed: FilesChanged = {
      node: asNodeId("files-1"), kind: "paths", paths: ["notes/b.md"] as never,
      moves: [{ from: "notes/a.md" as never, to: "notes/b.md" as never }],
    };
    // Host: the change becomes an event, crosses the link as JSON, and is decoded closed at the other end.
    const onWire = decodeFilesEvent(JSON.parse(JSON.stringify(eventOf(renamed))));
    await Effect.runPromise(f.remote.onEvent(context, onWire));
    expect(f.changes).toEqual([{ machine: MINI, change: renamed }]);
  });

  it("stops watching a node the host says closed, and one the window closed", async () => {
    const f = await fixture();
    await opened(f);
    await Effect.runPromise(f.remote.onEvent(context, { node: asNodeId("files-1"), kind: "closed", error: "failed" }));
    expect(f.remote.watched(MINI)).toEqual([]);
    await opened(f);
    f.script.push(answers({ _tag: "Closed" }));
    await f.remote.close(MINI, ref);
    expect(f.remote.watched(MINI)).toEqual([]);
  });
});
