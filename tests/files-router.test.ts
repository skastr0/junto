import { describe, expect, it, vi } from "vitest";
import type { FilesChanged, FilesNodeRef, FilesResult } from "../src/shared/files";
import { asNodeId } from "../src/shared/physics/schema";
import { makeFilesRouter, type FilesRemotePort } from "../src/main/junto/files/router";
import type { FilesService } from "../src/main/junto/files/service";

const HERE = "studio";
const here: FilesNodeRef = { canvas: "c", node: asNodeId("files-here") };
const away: FilesNodeRef = { canvas: "c", node: asNodeId("files-away") };
const hosts: Record<string, string> = { [here.node]: HERE, [away.node]: "mini" };

const counted = (files: number): FilesResult<{ files: number; capped: boolean }> => ({ ok: true, value: { files, capped: false } });

/** A local service and a link client that record what they were asked. */
const stage = (options: { enabled?: boolean; linked?: boolean; closeAnswer?: () => Promise<FilesResult<null>> } = {}) => {
  const calls: string[] = [];
  const sent: Array<{ subscriber: number; event: FilesChanged }> = [];
  let listener: ((change: { machine: string; change: FilesChanged }) => void) | undefined;
  const local = {
    open: async (subscriber: number) => (calls.push(`local open ${String(subscriber)}`), { ok: true, value: { name: "here", repo: false } }),
    close: (subscriber: number) => (calls.push(`local close ${String(subscriber)}`), { ok: true, value: null }),
    closeSubscriber: (subscriber: number) => void calls.push(`local closeSubscriber ${String(subscriber)}`),
    count: async () => (calls.push("local count"), counted(3)),
    read: async () => (calls.push("local read"), { ok: false, error: "not-found" }),
  } as unknown as FilesService;
  const remote = {
    open: async (machine: string) => (calls.push(`remote open ${machine}`), { ok: true, value: { name: "away", repo: false } }),
    close: async (machine: string) => (calls.push(`remote close ${machine}`), options.closeAnswer ? options.closeAnswer() : { ok: true, value: null }),
    count: async (machine: string) => (calls.push(`remote count ${machine}`), { ok: false, error: "unreachable", machine, lastReachedAt: 7 }),
    read: async (machine: string) => (calls.push(`remote read ${machine}`), { ok: false, error: "denied" }),
    onChange: (next: typeof listener) => {
      listener = next;
      return () => undefined;
    },
  } as unknown as FilesRemotePort;
  const router = makeFilesRouter({
    local,
    remote: () => (options.linked === false ? undefined : remote),
    node: async (ref) => ({ host: hosts[ref.node] ?? HERE, root: "/root" }),
    machineName: async () => HERE,
    send: (subscriber, event) => void sent.push({ subscriber, event }),
    enabled: options.enabled ?? true,
  });
  const emit = (change: FilesChanged, machine = "mini"): void => listener?.({ machine, change });
  return { router, calls, sent, emit };
};

describe("the Files router", () => {
  it("sends this machine's node to the local service and another machine's over the link", async () => {
    const { router, calls } = stage();
    expect(await router.count(here)).toEqual(counted(3));
    expect(await router.count(away)).toEqual({ ok: false, error: "unreachable", machine: "mini", lastReachedAt: 7 });
    // The host's own refusal crosses as it is.
    expect(await router.read(away, "a.md" as never)).toEqual({ ok: false, error: "denied" });
    expect(calls).toEqual(["local count", "remote count mini", "remote read mini"]);
  });

  it("keeps every call local with the feature off, or before the link client is built", async () => {
    for (const options of [{ enabled: false }, { linked: false }]) {
      const { router, calls } = stage(options);
      await router.count(away);
      expect(calls).toEqual(["local count"]);
    }
  });

  it("tells each window that has another machine's node open of its changes, and closes it there when the last window leaves", async () => {
    const { router, calls, sent, emit } = stage();
    await router.open(1, away);
    await router.open(2, away);
    emit({ node: away.node, kind: "paths", paths: [] });
    expect(sent.map((each) => each.subscriber)).toEqual([1, 2]);
    // A change for a node no window here has open goes nowhere.
    emit({ node: asNodeId("other"), kind: "reset" });
    expect(sent).toHaveLength(2);
    await router.close(1, away);
    expect(calls).not.toContain("remote close mini");
    router.closeSubscriber(2);
    expect(calls).toContain("local closeSubscriber 2");
    expect(calls.filter((call) => call === "remote close mini")).toHaveLength(1);
  });

  it("keeps a node open through a lost link, and lets it go when its host closes it", async () => {
    const { router, sent, emit } = stage();
    await router.open(1, away);
    emit({ node: away.node, kind: "closed", error: "unreachable", machine: "mini", lastReachedAt: 7 });
    emit({ node: away.node, kind: "back" });
    expect(sent.map((each) => each.event.kind)).toEqual(["closed", "back"]);
    emit({ node: away.node, kind: "closed", error: "no-node" });
    emit({ node: away.node, kind: "back" });
    expect(sent.map((each) => each.event.kind)).toEqual(["closed", "back", "closed"]);
  });

  it("opens a node re-pointed to another machine on that machine, never joining the old one's session", async () => {
    const { router, calls, sent, emit } = stage();
    await router.open(1, away);
    hosts[away.node] = "vps";
    try {
      await router.open(2, away);
      emit({ node: away.node, kind: "reset" }, "vps");
      expect(sent.map((each) => each.subscriber)).toEqual([2]);
      emit({ node: away.node, kind: "reset" }, "mini");
      expect(sent.map((each) => each.subscriber)).toEqual([2, 1]);
      await router.close(2, away);
      await router.close(1, away);
      await vi.waitFor(() => expect(calls.filter((call) => call.startsWith("remote close"))).toEqual(["remote close vps", "remote close mini"]));
    } finally {
      hosts[away.node] = "mini";
    }
  });

  it("keeps a node until its machine answers the close, and logs a close the link refused", async () => {
    let answer: (result: FilesResult<null>) => void = () => undefined;
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { router, sent, emit } = stage({ closeAnswer: () => new Promise((resolve) => (answer = resolve)) });
    await router.open(1, away);
    await router.close(1, away);
    // Closing there: a window opening it now starts afresh rather than joining the one going away.
    await router.open(2, away);
    answer({ ok: false, error: "unreachable", machine: "mini", lastReachedAt: null });
    await vi.waitFor(() => expect(errors).toHaveBeenCalledWith("[files] closing a node on another machine was refused", { machine: "mini", error: "unreachable" }));
    emit({ node: away.node, kind: "reset" });
    expect(sent.map((each) => each.subscriber)).toEqual([2]);
    errors.mockRestore();
  });

  it("closes a local session locally", async () => {
    const { router, calls } = stage();
    await router.open(1, here);
    await router.close(1, here);
    expect(calls).toEqual(["local open 1", "local close 1"]);
  });
});
