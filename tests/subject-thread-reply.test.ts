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
import { TASKS_ENABLED } from "../src/shared/features";
import { asNodeId } from "../src/shared/physics/schema";
import { subjectNoticeRow, type SubjectNoticeInput } from "../src/shared/subject-notice";
import { makeUserMessage } from "../src/shared/task";
import { threadSubjectOf } from "../src/shared/thread-subject";
import { ItemId, OpId } from "../src/shared/work-ids";
import type { MailMessageId, MailSenderStamp } from "../src/shared/crew";
import type { Message } from "../src/shared/work-model";
import { publishSeatCredential } from "./helpers/seat-credential";
import { ModelStoresLive, readSeeded, seedCanvas } from "./support/seed-canvas";
import { automations, canvasOf, region, seat as seatNode, taskBoard, wire } from "./support/model-nodes";
import { AUTOMATION_SEAT_ID } from "../src/shared/mail-author";
import { postSubjectComment } from "../src/main/junto/work/subject-comment";
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
  return ManagedRuntime.make(Layer.mergeAll(Layer.provideMerge(WorkLive, canvasesLive), PausePlaneAllPlaying));
};

const seat = (id: string, x: number) =>
  seatNode(id, { x, y: 40, width: 120, height: 48, bindingId: `bind-${id}` as never, launch: { kind: "harness", argv: ["claude"] } });

const NODES = [
  region("team", { x: -40, y: -40, width: 900, height: 400 }),
  seat("agent", 0),
  seat("peer", 160),
  taskBoard(BOARD, { x: 400, y: 40, width: 200, height: 100 }),
  automations("auto", { x: 640, y: 40, width: 160, height: 100 }),
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
      expect(refused.error).toMatchObject({ type: "UnknownTarget", message: `no task "${taskId}" on "${BOARD}"`, details: { path: "taskId", target: taskId } });
    }
    expect((await mailbox(BOARD)).filter((message) => threadSubjectOf(message) !== undefined)).toEqual([]);
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
