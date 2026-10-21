/**
 * Subject threads over the real work-control socket. A comment on a task
 * joins the task's one thread and carries its subject; a reply to a notice
 * in that thread posts to the task, never to the notice's sender; a refusal
 * takes no reply. Every store, home and socket lives under a temp root.
 */
import { mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodeWorkFrame } from "../src/shared/work-control";
import { asNodeId } from "../src/shared/physics/schema";
import { subjectNoticeRow, type SubjectNoticeInput } from "../src/shared/subject-notice";
import { makeUserMessage } from "../src/shared/task";
import { threadSubjectOf } from "../src/shared/thread-subject";
import { ItemId, OpId } from "../src/shared/work-ids";
import type { MailMessageId, MailSenderStamp } from "../src/shared/crew";
import type { Message } from "../src/shared/work-model";
import { publishSeatCredential } from "./helpers/seat-credential";
import { ModelStoresLive, seedCanvas } from "./support/seed-canvas";
import { canvasOf, region, seat as seatNode, taskBoard, wire } from "./support/model-nodes";
import { deliverTaskEffects } from "../src/main/junto/work/task-delivery";
import { seatNodeId, taskNodeId } from "../src/shared/task-model";
import type { ActorSeatId } from "../src/shared/actor-seat";
import { startWorkControlServer, type WorkControlServer } from "../src/main/junto/work/control";
import { WorkLive, WorkService } from "../src/main/junto/work/service";
import { CrewRepositoryLive } from "../src/main/junto/work/crew-repository";
import { makeContentServiceLive } from "../src/main/junto/content/service";
import { WorkRepositoryLive } from "../src/main/junto/work/repository";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { makeInstallOpsLive } from "../src/main/junto/install-ops/engine";
import { MachineRepositoryLive } from "../src/main/junto/machines/repository";
import { SettingsLive } from "../src/main/junto/settings/service";
import { nameThisMachine } from "./support/name-this-machine";
import { PausePlaneAllPlaying } from "../src/main/junto/pause-plane";
import { createMainAuthoringGate } from "../src/main/junto/main-authoring-gate";

const CANVAS = "subjects";
const BOARD = "board";

const makeRuntime = (root: string) => {
  const repositoriesLive = Layer.provideMerge(
    Layer.mergeAll(
      WorkRepositoryLive,
      CrewRepositoryLive,
      MachineRepositoryLive,
      SettingsLive,
      makeContentServiceLive({ root: join(root, "content"), skipInlineMediaMigration: true }),
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
  for (const id of ["agent", "peer"]) {
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

const createTask = async (): Promise<string> => {
  const created = await call("agent", "task.create", { target: BOARD, brief: "fix tabs", metadata: { details: "the tab strip wraps" } });
  expect(created.ok, JSON.stringify(created)).toBe(true);
  const id = created.data.task?.id ?? created.data.taskId ?? created.data.id;
  expect(typeof id).toBe("string");
  return id as string;
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
  it("a task comment joins its task's thread, and no other", async () => {
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

  it("a reply to a notice posts to the task, not to the notice's sender", async () => {
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

  it("a refusal takes no reply", async () => {
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

  it("a ruling's notices are delivered as the actor's mail, once however often it is delivered", async () => {
    const taskId = ItemId.make("01M5ESKX20QX0HA3Y6SHEPXBCX");
    const agentSeat = `seat_${"a".repeat(64)}` as ActorSeatId;
    const delivery = {
      canvas: canvasOf(NODES, WIRES, CANVAS),
      canvasName: CANVAS,
      actor: { kind: "seat", seatId: agentSeat, nodeId: asNodeId("agent") },
      opId: OpId.make("01M5ESMJV6GNZ0891YFFWS0S3P"),
      task: {
        id: taskId,
        number: 3 as never,
        title: "fix tabs",
        dependsOn: [],
        state: "assigned",
        node: taskNodeId(asNodeId(BOARD)),
        assignee: seatNodeId(asNodeId("peer")),
        epoch: 1,
        stampPolicy: { required: 0 },
        reviewers: [],
        stamps: [],
      },
      effects: [{ kind: "assignment-notice", seat: seatNodeId(asNodeId("peer")) }, { kind: "number-minted", number: 3 as never }],
    } as const;
    await runtime.runPromise(deliverTaskEffects(delivery) as Effect.Effect<void>);
    await runtime.runPromise(deliverTaskEffects(delivery) as Effect.Effect<void>);
    const told = (await mailbox("peer")).filter((message) => threadSubjectOf(message) !== undefined);
    expect(told).toHaveLength(1);
    expect(told[0]?.metadata).toMatchObject({ fromSeat: agentSeat, senderNodeId: "agent", subjectNotice: "assignment", threadId: taskId });
    expect((await mailbox("agent")).filter((message) => threadSubjectOf(message) !== undefined)).toEqual([]);
  });
});
