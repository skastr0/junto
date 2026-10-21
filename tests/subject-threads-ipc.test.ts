import { describe, expect, it, vi } from "vitest";
import { asNodeId } from "../src/shared/model";
import { mintItemId } from "../src/shared/resource-command";
import type { ThreadResourceApi } from "../src/shared/resource-ipc";
import {
  installIpcSubjectThreads,
  makeIpcSubjectThreads,
  subjectThreadsLive,
} from "../src/renderer/lib/subject-threads-source";

const board = asNodeId("tasks-build");
const task = mintItemId();
const subject = { kind: "task", nodeId: board, taskId: task } as const;

const fakeApi = (over: Partial<ThreadResourceApi> = {}): ThreadResourceApi => ({
  list: async () => [],
  post: async (_c, _s, post) => ({ kind: "applied", opId: post.opId, threadId: "t1" as never, postId: "p1" as never, notified: [] }),
  onChanged: () => () => undefined,
  ...over,
});

describe("subject threads over the resource IPC", () => {
  it("is not live until main's source is installed, and a bridge without threads installs nothing", () => {
    expect(subjectThreadsLive()).toBe(false);
    expect(installIpcSubjectThreads(undefined)).toBe(false);
    expect(subjectThreadsLive()).toBe(false);
  });

  it("maps main's threads: post ids, author names, the author as an actor, the anchor", async () => {
    const api = fakeApi({
      list: async () => [
        {
          threadId: "t1" as never,
          posts: [
            { postId: "p1" as never, author: { kind: "operator", name: "You" }, text: "hello", at: 1 },
            { postId: "p2" as never, author: { kind: "seat", seatId: "agent-s" as never, nodeId: asNodeId("seat-ada"), name: "Ada" }, text: "hi", at: 2 },
            { postId: "p3" as never, author: { kind: "automation", nodeId: asNodeId("auto-1"), name: "Nightly" }, text: "ran", at: 3 },
          ],
        },
      ],
    });
    const [thread] = await makeIpcSubjectThreads(api).threads("c", subject);
    expect(thread?.threadId).toBe("t1");
    expect(thread?.posts.map((post) => [post.messageId, post.name, post.author.kind])).toEqual([
      ["p1", "You", "operator"],
      ["p2", "Ada", "seat"],
      ["p3", "Nightly", "automation"],
    ]);
    expect(thread?.posts[1]?.author).toEqual({ kind: "seat", nodeId: "seat-ada" });
  });

  it("answers an applied post with where it landed and a refusal with main's words, sending the caller's op id", async () => {
    const post = vi.fn(fakeApi().post);
    const source = makeIpcSubjectThreads(fakeApi({ post }));
    expect(await source.post("c", subject, { text: "ok", opId: "op-1" })).toEqual({ ok: true, threadId: "t1", messageId: "p1" });
    expect(post).toHaveBeenCalledWith("c", subject, { opId: "op-1", text: "ok" });
    const refused = makeIpcSubjectThreads(
      fakeApi({
        post: async (_c, _s, draft) => ({
          kind: "refused",
          opId: draft.opId,
          error: { type: "ScopeError", message: "seat-bob is not in reach of this task." },
        }),
      }),
    );
    expect(await refused.post("c", subject, { text: "hi @bob", opId: "op-2" })).toEqual({
      ok: false,
      message: "seat-bob is not in reach of this task.",
    });
  });

  it("passes a thread id and an anchor on, and forwards changes", async () => {
    const post = vi.fn(fakeApi().post);
    let fire: () => void = () => undefined;
    const source = makeIpcSubjectThreads(
      fakeApi({
        post,
        onChanged: (listener) => {
          fire = () => listener({ canvasName: "c", kind: "task" });
          return () => undefined;
        },
      }),
    );
    await source.post("c", subject, { text: "x", opId: "o", threadId: "t9", anchor: { kind: "whole" } });
    expect(post).toHaveBeenCalledWith("c", subject, { opId: "o", text: "x", threadId: "t9", anchor: { kind: "whole" } });
    const heard = vi.fn();
    source.subscribe(heard);
    fire();
    expect(heard).toHaveBeenCalledOnce();
  });

  it("goes live once a bridge with threads installs, and only installs once", () => {
    const list = vi.fn(async () => []);
    expect(installIpcSubjectThreads(fakeApi({ list }))).toBe(true);
    expect(subjectThreadsLive()).toBe(true);
    expect(installIpcSubjectThreads(fakeApi())).toBe(true);
  });
});
