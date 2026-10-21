/**
 * Subject threads over the real work-control socket. A comment on a task
 * joins the task's one thread and carries its subject; a reply to a notice
 * in that thread posts to the task, never to the notice's sender; a refusal
 * takes no reply. Every store, home and socket lives under a temp root.
 * Mail to a task node over the socket needs the task kind (TASKS_ENABLED).
 */
import { mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime } from "effect";
import { ulid } from "ulid";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodeWorkFrame } from "../src/shared/work-control";
import { productNodeKindEnabled, TASKS_ENABLED } from "../src/shared/features";
import { asNodeId } from "../src/shared/physics/schema";
import { subjectNoticeRow, type SubjectNoticeInput } from "../src/shared/subject-notice";
import { makeUserMessage } from "../src/shared/task";
import { threadSubjectOf } from "../src/shared/thread-subject";
import { ItemId, OpId } from "../src/shared/work-ids";
import type { MailMessageId, MailSenderStamp } from "../src/shared/crew";
import type { Message } from "../src/shared/work-model";
import { publishSeatCredential } from "./helpers/seat-credential";
import { ModelStoresLive, readSeeded, seedCanvas } from "./support/seed-canvas";
import { artifacts, automations, canvasOf, page, region, seat as seatNode, taskBoard, wire } from "./support/model-nodes";
import { AUTOMATION_SEAT_ID } from "../src/shared/mail-author";
import { postSubjectComment } from "../src/main/junto/work/subject-comment";
import type { SubjectCommentInput } from "../src/shared/subject-comment";
import { mentionLink } from "../src/shared/mention";
import type { ActorSeatId } from "../src/shared/actor-seat";
import { startWorkControlServer, type WorkControlServer } from "../src/main/junto/work/control";
import { WorkLive, WorkService } from "../src/main/junto/work/service";
import { CrewRepositoryLive } from "../src/main/junto/work/crew-repository";
import { makeContentServiceLive } from "../src/main/junto/content/service";
import { WorkRepositoryLive } from "../src/main/junto/work/repository";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { makeInstallOpsLive } from "../src/main/junto/install-ops/engine";
import { MachineRepository, MachineRepositoryLive } from "../src/main/junto/machines/repository";
import { RulingRecorderLive } from "../src/main/junto/work/ruling-recorder";
import { TaskRepository, TaskRepositoryLive } from "../src/main/junto/work/task-repository";
import { taskCanvasEnv, taskRulingContext } from "../src/main/junto/work/task-control";
import { mintItemId, mintOpId } from "../src/shared/resource-command";
import { taskNodeId } from "../src/shared/task-model";
import { SettingsLive } from "../src/main/junto/settings/service";
import { nameThisMachine } from "./support/name-this-machine";
import { PausePlaneAllPlaying } from "../src/main/junto/pause-plane";
import { createMainAuthoringGate } from "../src/main/junto/main-authoring-gate";

const CANVAS = "subjects";
const BOARD = "board";
/** A task board in region other: out of reach of agent, peer and the board. */
const FAR_BOARD = "far-board";

const makeRuntime = (root: string) => {
  const repositoriesLive = Layer.provideMerge(
    Layer.mergeAll(
      WorkRepositoryLive,
      CrewRepositoryLive,
      MachineRepositoryLive,
      SettingsLive,
      makeContentServiceLive({ root: join(root, "content"), skipInlineMediaMigration: true }),
      Layer.provide(TaskRepositoryLive, Layer.provide(RulingRecorderLive, WorkRepositoryLive)),
    ),
    Layer.mergeAll(
      makeStateEngineLive(join(root, "state", "junto.db")),
      makeInstallOpsLive(join(root, "state", "install-ops.db")),
    ),
  );
  const canvasesLive = Layer.provideMerge(ModelStoresLive, repositoriesLive);
  return ManagedRuntime.make(Layer.mergeAll(Layer.provideMerge(Layer.provide(OldTaskStoreDies, WorkLive), canvasesLive), PausePlaneAllPlaying));
};

/**
 * The work service with the old task store gone: reading a task from it, or
 * appending mail to a task's old channel, dies. Mail on a task is a comment
 * in its 0.10 thread and never reaches either.
 */
const OldTaskStoreDies = Layer.effect(WorkService, Effect.gen(function* () {
  const work = yield* WorkService;
  return {
    ...work,
    readTask: () => Effect.die(new Error("read the old task store")),
    workMessageAppend: (canvas, nodeId, taskId, message, sentBy, admin) =>
      taskId === null
        ? work.workMessageAppend(canvas, nodeId, taskId, message, sentBy, admin)
        : Effect.die(new Error("appended to an old task's channel")),
  } satisfies typeof WorkService.Service;
}));

const seat = (id: string, x: number) =>
  seatNode(id, { x, y: 40, width: 120, height: 48, bindingId: `bind-${id}` as never, launch: { kind: "harness", argv: ["claude"] } });

const SHELF = "shelf";
const PAGE = "page";

const NODES = [
  region("team", { x: -40, y: -40, width: 900, height: 400 }),
  seat("agent", 0),
  seat("peer", 160),
  taskBoard(BOARD, { x: 400, y: 40, width: 200, height: 100 }),
  automations("auto", { x: 640, y: 40, width: 160, height: 100 }),
  artifacts(SHELF, { x: 400, y: 200, width: 120, height: 100 }),
  page(PAGE, { x: 600, y: 200, width: 120, height: 100 }),
  region("other", { x: -40, y: 600, width: 400, height: 300 }),
  taskBoard(FAR_BOARD, { x: 200, y: 640, width: 120, height: 100 }),
  seatNode("outsider", { x: 0, y: 640, width: 120, height: 48, bindingId: "bind-outsider" as never, launch: { kind: "harness", argv: ["claude"] } }),
];
const WIRES = [wire("agent-peer", "agent", "peer", "messages"), wire("peer-agent", "peer", "agent", "messages")];

let root: string;
let runtime: ReturnType<typeof makeRuntime>;
let server: WorkControlServer;
const tokens: Record<string, string> = {};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "junto-subject-threads-"));
  const workHome = join(root, "work");
  mkdirSync(workHome, { recursive: true });
  process.env.JUNTO_WORK_HOME = workHome;
  runtime = makeRuntime(root);
  await runtime.runPromise(nameThisMachine);
  server = await startWorkControlServer({
    version: "test",
    workHome,
    home: root,
    run: (effect) => runtime.runPromise(effect),
    authoringGate: createMainAuthoringGate(),
  });
  for (const id of ["agent", "peer", "outsider"]) {
    tokens[id] = publishSeatCredential(server.credentials, { agentKey: `local:${id}` });
  }
  await runtime.runPromise(seedCanvas(CANVAS, NODES, WIRES));
});

afterEach(async () => {
  await server.close();
  await runtime.dispose();
  await rm(root, { recursive: true, force: true });
  delete process.env.JUNTO_WORK_HOME;
});

const call = (as: string, op: string, args: unknown = {}): Promise<any> =>
  new Promise((resolve, reject) => {
    const socket = createConnection({ path: server.socketPath });
    let buffer = "";
    socket.on("connect", () => socket.write(encodeWorkFrame({ token: tokens[as]!, op, args })));
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      socket.destroy();
      resolve(JSON.parse(buffer.slice(0, newline)));
    });
    socket.on("error", reject);
  });

const run = <A>(f: (work: typeof WorkService.Service) => Effect.Effect<A, unknown>): Promise<A> =>
  runtime.runPromise(Effect.flatMap(WorkService, f) as Effect.Effect<A>);

const mailbox = (nodeId: string): Promise<ReadonlyArray<Message>> => run((work) => work.readMailbox(CANVAS, nodeId));

/**
 * A 0.10 task on the board, or on `nodeId`, created by the operator in the
 * real task store: a comment is admitted only on a task held at its node.
 */
const createTask = async (nodeId: string = BOARD): Promise<string> => {
  const taskId = mintItemId();
  const outcome = await runtime.runPromise(Effect.gen(function* () {
    const canvas = yield* readSeeded(CANVAS);
    const writer = yield* (yield* MachineRepository).installationId;
    return yield* (yield* TaskRepository).submit(
      writer,
      { opId: mintOpId(), canvasName: CANVAS, actor: { kind: "operator" }, target: { kind: "task", nodeId: taskNodeId(asNodeId(nodeId)) }, basis: null, after: [], op: { kind: "create", taskId, title: "fix tabs" } },
      taskRulingContext(canvas),
      taskCanvasEnv(canvas),
    );
  }) as unknown as Effect.Effect<{ readonly kind: string }>);
  expect(outcome.kind).toBe("applied");
  return taskId;
};

const sender: MailSenderStamp = {
  fromSeat: "seat_agent" as MailSenderStamp["fromSeat"],
  senderNodeId: "agent",
  senderName: "agent",
  senderGeneration: "ep_1",
  senderHarness: "claude",
};

/** A notice in peer's mailbox, as the ruling writer appends it. */
const notice = async (taskId: string, kind: "assignment" | "refusal"): Promise<string> => {
  const base = {
    installationId: "inst-1",
    sourceId: OpId.make("01M5ESMJV6GNZ0891YFFWS0S3P"),
    subject: { kind: "task", nodeId: asNodeId(BOARD), taskId: ItemId.make(taskId) },
    threadId: taskId as MailMessageId,
    recipient: asNodeId("peer"),
    text: "told",
  } as const;
  const input: SubjectNoticeInput = kind === "refusal"
    ? { ...base, kind, from: { nodeId: asNodeId(BOARD), name: "Tasks" } }
    : { ...base, kind, sender };
  const row = subjectNoticeRow(input);
  const appended = await run((work) =>
    work.workSystemMailboxNotify(CANVAS, "peer", makeUserMessage({ messageId: row.messageId, text: row.text, contextId: CANVAS, metadata: row.metadata })),
  );
  expect(appended.ok, JSON.stringify(appended)).toBe(true);
  return row.messageId;
};

describe("subject threads", () => {
  it.skipIf(!TASKS_ENABLED)("a task comment joins its task's thread, and no other", async () => {
    const taskId = await createTask();
    const sent = await call("agent", "msg.send", { target: BOARD, taskId, text: "starting" });
    expect(sent.ok, JSON.stringify(sent)).toBe(true);
    expect(sent.data.threadId).toBe(taskId);

    const joined = await call("agent", "msg.send", { target: BOARD, taskId, threadId: taskId, text: "and more" });
    expect(joined.ok, JSON.stringify(joined)).toBe(true);

    const elsewhere = await call("agent", "msg.send", { target: BOARD, taskId, threadId: "01M5ESQ6X9VS1GKZHNAS6BKJ49", text: "?" });
    expect(elsewhere.ok).toBe(false);
    expect(elsewhere.error.type).toBe("InputError");
  });

  it.skipIf(!TASKS_ENABLED)("a task comment is admitted by the task's own node: a task held elsewhere, or no task, is refused alike", async () => {
    const far = await createTask(FAR_BOARD);
    for (const taskId of [far, ulid()]) {
      const refused = await call("agent", "msg.send", { target: BOARD, taskId, text: "look" });
      expect(refused.ok, JSON.stringify(refused)).toBe(false);
      expect(refused.error).toMatchObject({ type: "UnknownTarget", message: `no task ${taskId} in this seat's reach`, details: { path: "taskId", received: taskId } });
    }
    expect((await mailbox(BOARD)).filter((message) => threadSubjectOf(message) !== undefined)).toEqual([]);
  });

  it.skipIf(!TASKS_ENABLED)("msg list on a task reads its thread: a comment posted by msg send, or by task comment, is there", async () => {
    const taskId = await createTask();
    const sent = await call("agent", "msg.send", { target: BOARD, taskId, text: "starting @peer" });
    expect(sent.ok, JSON.stringify(sent)).toBe(true);
    const commented = await call("peer", "task.comment", { opId: mintOpId(), task: taskId, text: "seen" });
    expect(commented.ok, JSON.stringify(commented)).toBe(true);

    const listed = await call("peer", "msg.list", { target: BOARD, taskId });
    expect(listed.ok, JSON.stringify(listed)).toBe(true);
    expect(listed.data).toMatchObject({ target: BOARD, taskId });
    const texts = listed.data.items.map((item: Message) => item.parts.map((part) => (part.kind === "text" ? part.text : "")).join(""));
    expect(texts).toEqual([`starting ${mentionLink({ kind: "seat", nodeId: asNodeId("peer") }, "@peer", CANVAS)}`, "seen"]);
    expect(listed.data.items.map((item: Message) => item.messageId)).toEqual([sent.data.messageId, commented.data.messageId]);
    expect(sent.data).toMatchObject({ threadId: taskId, taskId, nodeId: BOARD, recipient: { nodeId: BOARD } });
  });

  it.skipIf(!TASKS_ENABLED)("msg list and msg send on a task out of reach are refused, and write nothing", async () => {
    const far = await createTask(FAR_BOARD);
    for (const [op, args] of [
      ["msg.list", { target: FAR_BOARD, taskId: far }],
      ["msg.send", { target: FAR_BOARD, taskId: far, text: "look" }],
      ["msg.list", { target: BOARD, taskId: far }],
    ] as const) {
      const refused = await call("agent", op, args);
      expect(refused.ok, `${op} ${JSON.stringify(refused)}`).toBe(false);
      expect(refused.error.type).toBe("UnknownTarget");
    }
    expect((await mailbox(FAR_BOARD)).filter((message) => threadSubjectOf(message) !== undefined)).toEqual([]);
  });

  it.skipIf(!TASKS_ENABLED)("a task comment or a subject reply sent again under its opId is written once, and told once", async () => {
    const taskId = await createTask();
    const said = async (text: string) =>
      (await mailbox(BOARD)).filter((message) => message.parts.some((part) => part.kind === "text" && part.text === text));

    const comment = { target: BOARD, taskId, text: "starting once", opId: mintOpId() };
    const first = await call("agent", "msg.send", comment);
    const again = await call("agent", "msg.send", comment);
    expect(first.ok, JSON.stringify(first)).toBe(true);
    expect(again.ok, JSON.stringify(again)).toBe(true);
    expect(again.data.messageId).toBe(first.data.messageId);
    expect(await said("starting once")).toHaveLength(1);

    const noticeId = await notice(taskId, "assignment");
    const reply = { target: BOARD, inReplyTo: noticeId, text: "on it once", opId: mintOpId() };
    const replied = await call("peer", "msg.reply", reply);
    const repliedAgain = await call("peer", "msg.reply", reply);
    expect(replied.ok, JSON.stringify(replied)).toBe(true);
    expect(repliedAgain.ok, JSON.stringify(repliedAgain)).toBe(true);
    expect(repliedAgain.data.messageId).toBe(replied.data.messageId);
    expect(await said("on it once")).toHaveLength(1);
    // agent posted before, so it is told of the reply: once.
    expect((await mailbox("agent")).filter((message) => message.metadata?.subjectNotice === "comment")).toHaveLength(1);
  });

  it.skipIf(!TASKS_ENABLED)("a reply to a notice posts to the task, not to the notice's sender", async () => {
    const taskId = await createTask();
    const noticeId = await notice(taskId, "assignment");

    const toSender = await call("peer", "msg.reply", { target: "agent", inReplyTo: noticeId, text: "on it" });
    expect(toSender.ok).toBe(false);
    expect(toSender.error.type).toBe("InputError");
    expect(toSender.error.details.next_step).toContain(BOARD);

    const replied = await call("peer", "msg.reply", { target: BOARD, inReplyTo: noticeId, text: "on it" });
    expect(replied.ok, JSON.stringify(replied)).toBe(true);
    expect(replied.data).toMatchObject({ threadId: taskId, inReplyTo: noticeId });
    expect((await mailbox("agent")).some((message) => message.parts.some((part) => part.kind === "text" && part.text === "on it"))).toBe(false);
  });

  // 0.10.0 refused these at the target's kind: an artifacts or page node takes no mail.
  const mentioned = [
    { kind: "artifacts", on: "an artifact", subjectOf: async () => ({ kind: "artifact", nodeId: asNodeId(SHELF), artifactId: ItemId.make("01M5G0BJD8MBEJG2QVX5VM6DJ1") } as const) },
    { kind: "task", on: "a task", subjectOf: async () => ({ kind: "task", nodeId: asNodeId(BOARD), taskId: ItemId.make(await createTask()) } as const) },
    { kind: "page", on: "a page", subjectOf: async () => ({ kind: "page", nodeId: asNodeId(PAGE) } as const) },
  ] as const;
  for (const { kind, on, subjectOf } of mentioned) {
    it.skipIf(!productNodeKindEnabled(kind))(`a seat mentioned on ${on} replies with msg reply, and the reply posts there`, async () => {
      const subject = await subjectOf();
      const peerLink = mentionLink({ kind: "seat", nodeId: asNodeId("peer") }, "@peer", CANVAS);
      const comment = await runtime.runPromise(postSubjectComment(
        { subject, text: `${peerLink} have a look`, actor: { kind: "seat", seatId: `seat_${"a".repeat(64)}` as ActorSeatId, nodeId: asNodeId("agent") }, opId: mintOpId() } as SubjectCommentInput,
        { canvas: canvasOf(NODES, WIRES, CANVAS), canvasName: CANVAS, people: [] },
      ));
      expect(comment.notified).toEqual(["peer"]);
      const mention = (await mailbox("peer")).find((message) => message.metadata?.subjectNotice === "mention");
      expect(mention).toBeDefined();

      const replied = await call("peer", "msg.reply", { target: subject.nodeId, inReplyTo: mention!.messageId, text: "on it" });
      expect(replied.ok, JSON.stringify(replied)).toBe(true);
      expect(replied.data).toMatchObject({ threadId: comment.threadId, inReplyTo: mention!.messageId, notified: ["agent"] });
      const posted = (await mailbox(subject.nodeId)).find((message) => message.messageId === replied.data.messageId);
      expect(posted?.metadata).toMatchObject({ threadId: comment.threadId, inReplyTo: mention!.messageId, senderNodeId: "peer" });
      expect(posted === undefined ? undefined : threadSubjectOf(posted)).toMatchObject(subject);
    });
  }

  it("a reply to plain mail at an artifacts node is still refused by its kind", async () => {
    const plain = await call("agent", "msg.send", { target: "peer", text: "hello" });
    expect(plain.ok, JSON.stringify(plain)).toBe(true);
    const refused = await call("peer", "msg.reply", { target: SHELF, inReplyTo: plain.data.messageId, text: "?" });
    expect(refused.ok).toBe(false);
    expect(refused.error.type).toBe("ScopeError");
  });

  it.skipIf(!TASKS_ENABLED)("a reply to a comment read from a task's thread points to task comment", async () => {
    const taskId = await createTask();
    const sent = await call("agent", "msg.send", { target: BOARD, taskId, text: "starting" });
    expect(sent.ok, JSON.stringify(sent)).toBe(true);
    const refused = await call("peer", "msg.reply", { target: BOARD, inReplyTo: sent.data.messageId, text: "seen" });
    expect(refused.ok).toBe(false);
    expect(refused.error.details.next_step).toContain("junto task comment");
  });

  it.skipIf(!TASKS_ENABLED)("a refusal takes no reply", async () => {
    const taskId = await createTask();
    const noticeId = await notice(taskId, "refusal");
    const refused = await call("peer", "msg.reply", { target: BOARD, inReplyTo: noticeId, text: "why?" });
    expect(refused.ok).toBe(false);
    expect(refused.error.message).toBe("a refusal notice takes no reply");
  });

  it("the stored notice reads back its subject", async () => {
    const taskId = await createTask();
    const noticeId = await notice(taskId, "assignment");
    const held = (await mailbox("peer")).find((message) => message.messageId === noticeId);
    expect(held === undefined ? undefined : threadSubjectOf(held)).toEqual({ kind: "task", nodeId: BOARD, taskId });
  });

  it.skipIf(!TASKS_ENABLED)("a comment's own row is held at the task node, and earlier posters are told of the next", async () => {
    const taskId = await createTask();
    const first = await call("agent", "msg.send", { target: BOARD, taskId, text: "starting" });
    expect(first.ok, JSON.stringify(first)).toBe(true);
    const second = await call("peer", "msg.send", { target: BOARD, taskId, text: "I can pair" });
    expect(second.ok, JSON.stringify(second)).toBe(true);
    expect(second.data.notified).toEqual(["agent"]);
    const held = (await mailbox(BOARD)).filter((message) => message.metadata?.threadId === taskId);
    expect(held.map((message) => message.parts[0]?.kind === "text" ? message.parts[0].text : "")).toEqual(["starting", "I can pair"]);
    const told = (await mailbox("agent")).find((message) => message.metadata?.subjectNotice === "comment");
    expect(told?.metadata).toMatchObject({ threadId: taskId, senderNodeId: "peer" });
  });

  it.skipIf(!TASKS_ENABLED)("a mentioned seat gets a mention; a seat out of reach cannot be mentioned or comment", async () => {
    const taskId = await createTask();
    const peerLink = mentionLink({ kind: "seat", nodeId: asNodeId("peer") }, "peer", CANVAS);
    const sent = await call("agent", "msg.send", { target: BOARD, taskId, text: `${peerLink} can you look?` });
    expect(sent.ok, JSON.stringify(sent)).toBe(true);
    expect((await mailbox("peer")).find((message) => message.metadata?.subjectNotice === "mention")).toBeDefined();
    const outsiderLink = mentionLink({ kind: "seat", nodeId: asNodeId("outsider") }, "outsider", CANVAS);
    const far = await call("agent", "msg.send", { target: BOARD, taskId, text: `${outsiderLink} too?` });
    expect(far.ok).toBe(false);
    expect(far.error.details.reason).toBe("not_in_reach");
  });

  it("a retried comment with the same opId posts once", async () => {
    const taskId = ItemId.make("01M5ESKX20QX0HA3Y6SHEPXBCY");
    const input = {
      subject: { kind: "task", nodeId: asNodeId(BOARD), taskId },
      text: "once",
      actor: { kind: "seat", seatId: `seat_${"b".repeat(64)}` as ActorSeatId, nodeId: asNodeId("peer") },
      opId: OpId.make("01M5ESMJV6GNZ0891YFFWS0S3Q"),
    } as const;
    const context = { canvas: canvasOf(NODES, WIRES, CANVAS), canvasName: CANVAS, people: [asNodeId("agent")] };
    const a = await runtime.runPromise(postSubjectComment(input, context));
    const b = await runtime.runPromise(postSubjectComment(input, context));
    expect(b.messageId).toBe(a.messageId);
    expect((await mailbox(BOARD)).filter((message) => message.messageId === a.messageId)).toHaveLength(1);
    expect((await mailbox("agent")).filter((message) => message.metadata?.subjectNotice === "comment")).toHaveLength(1);
  });

  it.skipIf(!TASKS_ENABLED)("a far live overseer comments on a task and is told of the next comment; with the flag off it is refused", async () => {
    const taskId = ItemId.make("01M5ESKX20QX0HA3Y6SHEPXBD3");
    // outsider sits in region other, out of reach of the board, unwired.
    const flagged = (overseer: boolean) => canvasOf(NODES.map((node) => (node.id === "outsider" ? { ...node, overseer } : node)) as typeof NODES, WIRES, CANVAS);
    const as = (nodeId: string) => ({ kind: "seat" as const, seatId: `seat_${(nodeId === "agent" ? "a" : "b").repeat(64)}` as ActorSeatId, nodeId: asNodeId(nodeId) });
    const comment = (canvas: ReturnType<typeof flagged>, from: string, text: string, opId: string) =>
      postSubjectComment({ subject: { kind: "task", nodeId: asNodeId(BOARD), taskId }, text, actor: as(from), opId: OpId.make(opId) }, { canvas, canvasName: CANVAS, people: [] });

    const refused = await runtime.runPromise(Effect.flip(comment(flagged(false), "outsider", "from afar", "01M5ESMJV6GNZ0891YFFWS0S3W")));
    expect(refused.details?.reason).toBe("not_in_reach");

    const on = flagged(true);
    const posted = await runtime.runPromise(comment(on, "outsider", "from afar", "01M5ESMJV6GNZ0891YFFWS0S3X"));
    expect((await mailbox(BOARD)).some((message) => message.messageId === posted.messageId)).toBe(true);
    const next = await runtime.runPromise(comment(on, "agent", "seen it", "01M5ESMJV6GNZ0891YFFWS0S3Y"));
    expect(next.notified).toEqual(["outsider"]);
    expect((await mailbox("outsider")).find((message) => message.metadata?.subjectNotice === "comment")?.metadata).toMatchObject({ threadId: taskId, senderNodeId: "agent" });
  });

  it("one notice that fails, or a person whose node is gone, strands no other: the comment stands and the rest are told", async () => {
    const taskId = ItemId.make("01M5ESKX20QX0HA3Y6SHEPXBD4");
    // auto is no seat, so its notice is refused; gone is on no canvas.
    const context = { canvas: canvasOf(NODES, WIRES, CANVAS), canvasName: CANVAS, people: [asNodeId("auto"), asNodeId("gone"), asNodeId("peer")] };
    const posted = await runtime.runPromise(postSubjectComment({
      subject: { kind: "task", nodeId: asNodeId(BOARD), taskId },
      text: "the rest are told",
      actor: { kind: "operator" },
      opId: OpId.make("01M5ESMJV6GNZ0891YFFWS0S3Z"),
    }, context));
    expect(posted.notified).toEqual(["peer"]);
    expect((await mailbox(BOARD)).some((message) => message.messageId === posted.messageId)).toBe(true);
    expect((await mailbox("peer")).filter((message) => message.metadata?.subjectNotice === "comment")).toHaveLength(1);
  });

  it("an automation comments as its own node, and never from the operator's", async () => {
    const taskId = ItemId.make("01M5ESKX20QX0HA3Y6SHEPXBD1");
    const context = { canvas: canvasOf(NODES, WIRES, CANVAS), canvasName: CANVAS, people: [asNodeId("peer")] };
    const automationId = ItemId.make("01M5ESKX20QX0HA3Y6SHEPXBD2");
    const posted = await runtime.runPromise(postSubjectComment({
      subject: { kind: "task", nodeId: asNodeId(BOARD), taskId },
      text: "nightly run failed",
      actor: { kind: "automation", nodeId: asNodeId("auto"), automationId },
      opId: OpId.make("01M5ESMJV6GNZ0891YFFWS0S3T"),
    }, context));
    expect(posted.notified).toEqual(["peer"]);
    const held = (await mailbox(BOARD)).find((message) => message.messageId === posted.messageId);
    expect(held?.metadata).toMatchObject({ fromSeat: AUTOMATION_SEAT_ID, senderNodeId: "auto" });
    const told = (await mailbox("peer")).find((message) => message.metadata?.subjectNotice === "comment");
    expect(told?.metadata).toMatchObject({ fromSeat: AUTOMATION_SEAT_ID, senderNodeId: "auto" });

    const forged = await runtime.runPromise(Effect.flip(postSubjectComment({
      subject: { kind: "task", nodeId: asNodeId(BOARD), taskId },
      text: "as the operator",
      actor: { kind: "automation", nodeId: asNodeId("operator"), automationId },
      opId: OpId.make("01M5ESMJV6GNZ0891YFFWS0S3V"),
    }, context)));
    expect(forged.type).not.toBe(undefined);
  });
});
