/**
 * The window's threads on tasks and artifacts (resource-ipc.ts, thread):
 * read from the subject node's mailbox, posted as the operator through the
 * CLI's own task.comment and artifact.comment paths, over the real comment
 * writer and an in-memory mailbox. The list and post run in every build;
 * the channels follow each kind's product.
 */
import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";
import { ActorSeatId } from "../src/shared/actor-seat";
import { ARTIFACTS_ENABLED, TASKS_ENABLED, productResourceKindEnabled } from "../src/shared/features";
import { asNodeId } from "../src/shared/model";
import {
  RESOURCE_IPC_CHANNELS,
  type ThreadPostDraft,
  type ThreadPostOutcome,
  type ThreadResourceSubject,
} from "../src/shared/resource-ipc";
import type { Message } from "../src/shared/work-model";
import { threadSubjectOf } from "../src/shared/thread-subject";
import { ItemId, OpId } from "../src/shared/work-ids";
import { MachineRepository } from "../src/main/junto/machines/repository";
import { ArtifactRepository } from "../src/main/junto/work/artifact-repository";
import { onResourceChanged } from "../src/main/junto/work/resource-changes";
import { listThreads, postThread, registerResourceIpc, type ResourceIpcPorts } from "../src/main/junto/work/resource-ipc";
import { WorkService, type WorkServiceShape } from "../src/main/junto/work/service";
import { postSubjectComment } from "../src/main/junto/work/subject-comment";
import { artifacts, canvasOf, region, seat, taskBoard } from "./support/model-nodes";

// Region R holds seat S, task node T and Artifacts node A; seat FAR sits in
// a sibling region, out of their reach.
const board = canvasOf([
  region("R", { x: 0, y: 0, width: 1000, height: 1000 }),
  seat("S", { x: 10, y: 10 }),
  taskBoard("T", { x: 300, y: 10 }),
  artifacts("A", { x: 600, y: 10 }),
  region("F", { x: 2000, y: 0, width: 500, height: 500 }),
  seat("FAR", { x: 2010, y: 10 }),
]);
const TASK = ItemId.make("01M5F9000000000000000000T1");
const ART = ItemId.make("01M5F9000000000000000000A1");
const OTHER = ItemId.make("01M5F9000000000000000000A2");
const MISSING = ItemId.make("01M5F9000000000000000000A9");
// Comment ids keep their opId's time, so these order by their first letters.
const EARLY = OpId.make("01M5FA00000000000000000001");
const LATE = OpId.make("01M5FB00000000000000000002");
const REPLY = OpId.make("01M5FC00000000000000000003");
const SEAT_OP = OpId.make("01M5FD00000000000000000004");
const S_SEAT = ActorSeatId.make(`seat_${"b".repeat(64)}`);

const taskSubject: ThreadResourceSubject = { kind: "task", nodeId: asNodeId("T"), taskId: TASK };
const artifactSubject: ThreadResourceSubject = { kind: "artifact", nodeId: asNodeId("A"), artifactId: ART };

/** The mailboxes a WorkService holds, in memory; a row written again is the same row. */
const mailboxes = () => {
  const boxes = new Map<string, Message[]>();
  const append = (nodeId: string, message: Message) =>
    Effect.sync(() => {
      const box = boxes.get(nodeId) ?? [];
      const written = !box.some((row) => row.messageId === message.messageId);
      if (written) boxes.set(nodeId, [...box, message]);
      return { ok: true, data: { messageId: message.messageId, written } };
    });
  const work = {
    readMailbox: (_canvas: string, nodeId: string) => Effect.succeed(boxes.get(nodeId) ?? []),
    workSubjectRow: (_canvas: string, nodeId: string, message: Message) => append(nodeId, message),
    workSubjectNotice: (_canvas: string, nodeId: string, message: Message) => append(nodeId, message),
  } as unknown as WorkServiceShape;
  return { boxes, work };
};

const portsOf = (work: WorkServiceShape): ResourceIpcPorts => ({
  topology: () => Effect.succeed(board),
  tasks: {
    list: () => Effect.die("unused"),
    submit: () => Effect.die("unused"),
    find: (_canvas, _name, lookup) =>
      Effect.succeed(
        lookup.kind === "id" && lookup.taskId === TASK
          ? ({ taskId: TASK, current: { node: asNodeId("T"), assignee: asNodeId("S"), reviewers: [] } } as never)
          : undefined,
      ),
    comment: postSubjectComment,
  },
  artifacts: {
    list: () => Effect.die("unused"),
    body: () => Effect.die("unused"),
    history: () => Effect.die("unused"),
    submit: () => Effect.die("unused"),
    pull: () => Effect.void,
    head: (_canvas, artifactId) =>
      Effect.succeed(
        artifactId === MISSING
          ? Option.none()
          : Option.some({
              artifact: { artifactId, nodeId: asNodeId("A"), type: "document", version: 1, createdBy: { kind: "seat", nodeId: asNodeId("S") } },
              body: { type: "document", markdown: "hello world" },
              bodyRef: { sha256: "x" },
            } as never),
      ),
    comment: postSubjectComment,
  },
  mailbox: (canvasName, nodeId) => work.readMailbox(canvasName, nodeId).pipe(Effect.orDie),
  queue: () => Effect.succeed(undefined),
});

const harness = () => {
  const { boxes, work } = mailboxes();
  const ports = portsOf(work);
  const run = <A, E>(effect: Effect.Effect<A, E>) =>
    Effect.runPromise(
      effect.pipe(
        Effect.provideService(WorkService, work),
        Effect.provideService(MachineRepository, { installationId: Effect.succeed("mini") } as unknown as MachineRepository["Service"]),
      ),
    );
  const post = (subject: ThreadResourceSubject, draft: ThreadPostDraft) => run(postThread(ports, "factory", subject, draft));
  const list = (subject: ThreadResourceSubject) => run(listThreads(ports, "factory", subject));
  return { boxes, work, ports, run, post, list };
};

const applied = (outcome: ThreadPostOutcome) => {
  if (outcome.kind !== "applied") throw new Error(JSON.stringify(outcome));
  return outcome;
};

describe("threads on an artifact", () => {
  it("lists its threads from the node's mailbox, grouped, each oldest post first, threads by their first post", async () => {
    const { post, list } = harness();
    const late = applied(await post(artifactSubject, { opId: LATE, text: "the title is off", anchor: { kind: "text", quote: "hello" } }));
    const early = applied(await post(artifactSubject, { opId: EARLY, text: "first look" }));
    await post({ ...artifactSubject, artifactId: OTHER }, { opId: SEAT_OP, text: "another artifact's" });
    const reply = applied(await post(artifactSubject, { opId: REPLY, text: "fixed it", threadId: late.threadId }));

    expect(reply.threadId).toBe(late.threadId);
    const threads = await list(artifactSubject);
    expect(threads.map((thread) => ({ threadId: thread.threadId, anchor: thread.anchor, posts: thread.posts.map((p) => p.postId) }))).toEqual([
      { threadId: early.threadId, anchor: undefined, posts: [early.postId] },
      { threadId: late.threadId, anchor: { kind: "text", quote: "hello" }, posts: [late.postId, reply.postId] },
    ]);
    expect(threads[1]!.posts[1]).toEqual({
      postId: reply.postId,
      author: { kind: "operator", name: "operator" },
      text: "fixed it",
      at: expect.any(Number),
    });
    expect(threads[1]!.posts[0]!.at).toBeLessThan(threads[1]!.posts[1]!.at);
  });

  it("posts as the operator on the CLI's path: the author is told, a seat's post reads as that seat, and the next list shows both", async () => {
    const { post, list, run } = harness();
    const outcome = applied(await post(artifactSubject, { opId: EARLY, text: "looks good" }));
    expect(outcome).toEqual({ kind: "applied", opId: EARLY, threadId: outcome.postId, postId: outcome.postId, notified: ["S"] });
    await run(postSubjectComment(
      { subject: artifactSubject, text: "thanks", actor: { kind: "seat", seatId: S_SEAT, nodeId: asNodeId("S") }, opId: SEAT_OP, threadId: outcome.threadId },
      { canvas: board, canvasName: "factory", people: [] },
    ));
    const [thread] = await list(artifactSubject);
    expect(thread!.posts.map((p) => [p.author, p.text])).toEqual([
      [{ kind: "operator", name: "operator" }, "looks good"],
      [{ kind: "seat", seatId: S_SEAT, nodeId: "S", name: "S" }, "thanks"],
    ]);
  });

  it("keeps a moved artifact's comments: those held where it was list with those where it is (0.11.1, 10)", async () => {
    const { post, run, work } = harness();
    const before = applied(await post(artifactSubject, { opId: EARLY, text: "written on A" }));
    // The artifact moved to B: its next comment is held there, and both read as its threads.
    const moved = { ...portsOf(work), artifacts: { ...portsOf(work).artifacts, moves: () => Effect.succeed([{ from: asNodeId("A"), to: asNodeId("B"), by: { kind: "operator" }, at: 1 }]) } } as ResourceIpcPorts;
    await run(work.workSubjectRow("factory", "B", { messageId: LATE, subject: { kind: "artifact", nodeId: "B", artifactId: ART } } as never, { kind: "operator" } as never));
    const threads = await run(listThreads(moved, "factory", { kind: "artifact", nodeId: asNodeId("B"), artifactId: ART }));
    expect(threads.map((thread) => thread.threadId)).toContain(before.threadId);
    // Another artifact's comment on the old node stays its own.
    await post({ ...artifactSubject, artifactId: OTHER }, { opId: SEAT_OP, text: "another artifact's" });
    expect((await run(listThreads(moved, "factory", { kind: "artifact", nodeId: asNodeId("B"), artifactId: ART }))).map((t) => t.posts[0]!.text)).not.toContain("another artifact's");
  });

  it("takes a seat's reply to a thread begun before the artifact moved, naming where it is now (0.11.1, 10)", async () => {
    const { post, run, boxes } = harness();
    const root = applied(await post(artifactSubject, { opId: EARLY, text: "written on A" }));
    const movedBoard = canvasOf([
      region("R", { x: 0, y: 0, width: 1000, height: 1000 }),
      seat("S", { x: 10, y: 10 }),
      artifacts("A", { x: 600, y: 10 }),
      artifacts("B", { x: 800, y: 10 }),
      artifacts("C", { x: 900, y: 10 }),
    ]);
    // Its moves out of clock order, as two rulers can stamp them: its head says where it is.
    const moves = {
      head: () => Effect.succeed(Option.some({ artifact: { artifactId: ART, nodeId: asNodeId("B") } })),
      moves: () => Effect.succeed([
        { from: asNodeId("C"), to: asNodeId("B"), by: { kind: "operator" }, at: 1 },
        { from: asNodeId("A"), to: asNodeId("C"), by: { kind: "operator" }, at: 2 },
      ]),
    };
    const reply = await run(postSubjectComment(
      { subject: { kind: "artifact", nodeId: asNodeId("B"), artifactId: ART }, text: "still here", actor: { kind: "seat", seatId: S_SEAT, nodeId: asNodeId("S") }, opId: SEAT_OP, threadId: root.threadId },
      { canvas: movedBoard, canvasName: "factory", people: [] },
    ).pipe(Effect.provideService(ArtifactRepository, moves as unknown as ArtifactRepository["Service"])));
    expect(reply.threadId).toBe(root.threadId);
    const written = boxes.get("B")!.find((row) => row.messageId === reply.messageId)!;
    expect(threadSubjectOf(written)).toEqual({ kind: "artifact", nodeId: "B", artifactId: ART });
    // A comment that names the node the artifact left goes where it is now.
    const late = await run(postSubjectComment(
      { subject: artifactSubject, text: "named the old node", actor: { kind: "seat", seatId: S_SEAT, nodeId: asNodeId("S") }, opId: LATE },
      { canvas: movedBoard, canvasName: "factory", people: [] },
    ).pipe(Effect.provideService(ArtifactRepository, moves as unknown as ArtifactRepository["Service"])));
    expect(boxes.get("B")!.map((row) => row.messageId)).toContain(late.messageId);
    expect(boxes.get("A")!.map((row) => row.messageId)).not.toContain(late.messageId);
  });

  it("answers a replayed opId as its first post, and writes no second row", async () => {
    const { post, boxes } = harness();
    const first = await post(artifactSubject, { opId: EARLY, text: "once" });
    expect(await post(artifactSubject, { opId: EARLY, text: "once" })).toEqual(first);
    expect(boxes.get("A")).toHaveLength(1);
  });

  it("links a mention in reach, and posts one out of reach as plain text", async () => {
    const { post, list, boxes } = harness();
    const linked = applied(await post(artifactSubject, { opId: EARLY, text: "ask @S" }));
    expect((await list(artifactSubject))[0]!.posts[0]!.text).toContain("](junto://");
    expect(linked.notified).toEqual(["S"]);
    applied(await post(artifactSubject, { opId: LATE, text: "ask @FAR" }));
    expect((await list(artifactSubject)).flatMap((thread) => thread.posts.map((posted) => posted.text))).toContain("ask @FAR");
    expect(boxes.get("A")).toHaveLength(2);
  });

  it("refuses an unknown artifact, one on another node, and an anchor its type does not take", async () => {
    const { post, boxes } = harness();
    expect(await post({ ...artifactSubject, artifactId: MISSING }, { opId: EARLY, text: "x" })).toMatchObject({
      kind: "refused",
      opId: EARLY,
      error: { type: "UnknownTarget" },
    });
    expect(await post({ ...artifactSubject, nodeId: asNodeId("T") }, { opId: EARLY, text: "x" })).toMatchObject({
      kind: "refused",
      error: { type: "UnknownTarget" },
    });
    expect(await post(artifactSubject, { opId: EARLY, text: "x", anchor: { kind: "cells", range: "B2" } })).toMatchObject({
      kind: "refused",
      error: { type: "InputError", details: { path: "anchor" } },
    });
    expect(boxes.get("A")).toBeUndefined();
  });

  it("tells the windows the artifact changed when the operator comments", async () => {
    const { post } = harness();
    const heard: Array<[string, string]> = [];
    const stop = onResourceChanged((domain, canvasName) => heard.push([domain, canvasName]));
    try {
      applied(await post(artifactSubject, { opId: EARLY, text: "noted" }));
    } finally {
      stop();
    }
    expect(heard).toEqual([["artifact", "factory"]]);
  });
});

describe("threads on a task", () => {
  it("is the task's one thread, oldest post first, and the next list shows a post", async () => {
    const { post, list } = harness();
    const late = applied(await post(taskSubject, { opId: LATE, text: "blocked on review" }));
    const early = applied(await post(taskSubject, { opId: EARLY, text: "picking this up" }));
    expect(late).toMatchObject({ threadId: TASK, notified: ["S"] });
    expect(early.threadId).toBe(TASK);
    const threads = await list(taskSubject);
    expect(threads).toHaveLength(1);
    expect(threads[0]).toEqual({
      threadId: TASK,
      posts: [
        { postId: early.postId, author: { kind: "operator", name: "operator" }, text: "picking this up", at: expect.any(Number) },
        { postId: late.postId, author: { kind: "operator", name: "operator" }, text: "blocked on review", at: expect.any(Number) },
      ],
    });
  });

  it("refuses an anchor, another thread, and an unknown task, before any row", async () => {
    const { post, boxes } = harness();
    expect(await post(taskSubject, { opId: EARLY, text: "x", anchor: { kind: "whole" } })).toMatchObject({
      kind: "refused",
      error: { details: { path: "anchor" } },
    });
    expect(await post(taskSubject, { opId: EARLY, text: "x", threadId: LATE as string as never })).toMatchObject({
      kind: "refused",
      error: { details: { path: "threadId" } },
    });
    expect(await post({ ...taskSubject, taskId: MISSING }, { opId: EARLY, text: "x" })).toMatchObject({
      kind: "refused",
      error: { type: "UnknownTarget" },
    });
    expect(boxes.get("T")).toBeUndefined();
  });

  it("tells the windows the task changed when the operator comments", async () => {
    const { post } = harness();
    const heard: Array<[string, string]> = [];
    const stop = onResourceChanged((domain, canvasName) => heard.push([domain, canvasName]));
    try {
      applied(await post(taskSubject, { opId: EARLY, text: "noted" }));
    } finally {
      stop();
    }
    expect(heard).toEqual([["task", "factory"]]);
  });
});

describe("the thread channels", () => {
  it("follow each kind's product in this build: a kind left out is refused, the other posts", async () => {
    const { work, ports } = harness();
    const handlers = new Map<string, (event: unknown, input: unknown) => Promise<unknown>>();
    const sent: Array<[string, unknown]> = [];
    const stop = registerResourceIpc(
      { handle: (channel: string, listener: (event: unknown, input: unknown) => Promise<unknown>) => handlers.set(channel, listener) } as never,
      (effect) =>
        Effect.runPromise(
          (effect as Effect.Effect<never>).pipe(
            Effect.provideService(WorkService, work),
            Effect.provideService(MachineRepository, { installationId: Effect.succeed("mini") } as unknown as MachineRepository["Service"]),
          ),
        ),
      ports,
      (channel, payload) => sent.push([channel, payload]),
      { task: true, artifact: true, file: true },
      { task: (operation) => operation(), artifact: (operation) => operation(), thread: (operation) => operation() },
    );
    try {
      if (!TASKS_ENABLED && !ARTIFACTS_ENABLED) {
        expect(handlers.has(RESOURCE_IPC_CHANNELS.thread.post)).toBe(false);
        return;
      }
      const post = handlers.get(RESOURCE_IPC_CHANNELS.thread.post)!;
      const list = handlers.get(RESOURCE_IPC_CHANNELS.thread.list)!;
      for (const [subject, opId] of [[taskSubject, EARLY], [artifactSubject, LATE]] as const) {
        const outcome = (await post(undefined, { canvasName: "factory", subject, post: { opId, text: "hi" } })) as ThreadPostOutcome;
        if (productResourceKindEnabled(subject.kind)) {
          expect(outcome.kind, subject.kind).toBe("applied");
          expect(await list(undefined, { canvasName: "factory", subject })).toHaveLength(1);
          expect(sent).toContainEqual([RESOURCE_IPC_CHANNELS.thread.changed, { canvasName: "factory", kind: subject.kind }]);
        } else {
          expect(outcome).toMatchObject({ kind: "refused", opId, error: { details: { reason: "not_available" } } });
          await expect(list(undefined, { canvasName: "factory", subject })).rejects.toThrow("not in this Junto build");
        }
      }
      await expect(post(undefined, { canvasName: "factory", subject: artifactSubject, post: { opId: REPLY, text: "hi" }, actor: {} })).rejects.toThrow();
    } finally {
      stop();
    }
  });
});
