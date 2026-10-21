/**
 * Mail threads over the real work-control socket. A reply carries its root's
 * id as `threadId`, a send may join a thread this seat can read, a list
 * filters by thread, and a seat answers operator mail with target
 * "operator", which lands in its own mailbox as an agent-role row. Every
 * store, home and socket lives under a temp root.
 */
import { mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { ulid } from "ulid";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodeWorkFrame } from "../src/shared/work-control";
import { mailExtensionMetadata } from "../src/shared/crew";
import { makeUserMessage } from "../src/shared/task";
import { OPERATOR_SEAT_ID, operatorActorRef } from "../src/shared/work-reference";
import type { Message } from "../src/shared/work-model";
import { publishSeatCredential } from "./helpers/seat-credential";
import { ModelStoresLive, seedCanvas } from "./support/seed-canvas";
import { linesAnchorOf } from "../src/shared/thread-subject";
import { page as pageNode, region, seat as seatNode, taskBoard, wire } from "./support/model-nodes";
import { postSubjectComment } from "../src/main/junto/work/subject-comment";
import { mentionLink } from "../src/shared/mention";
import { ModelService } from "../src/main/junto/model/service";
import { ItemId, OpId } from "../src/shared/work-ids";
import type { MailMessageId } from "../src/shared/crew";
import { asNodeId } from "../src/shared/physics/schema";
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
import {
  mentionableSeats,
  reviewCopyId,
  seatThreadMessages,
  seatThreads,
  sendOperatorThreadMail,
} from "../src/main/junto/work/operator-threads";
import {
  OPERATOR_MAIL_MAX_TEXT,
  OperatorThreadSend as OperatorThreadSendSchema,
  type OperatorThreadSend,
} from "../src/shared/mail-threads";
import type { MailThreadMessage, MailThreadSummary } from "../src/shared/wire/mail-threads";
import { OPERATOR_ATTACHMENTS_MAX } from "../src/shared/operator-attachments";
import { putOperatorContent } from "../src/main/junto/content/operator-attachments";
import { createMainAuthoringGate } from "../src/main/junto/main-authoring-gate";

const CANVAS = "threads";

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
  const workLive = Layer.provideMerge(WorkLive, canvasesLive);
  return ManagedRuntime.make(Layer.mergeAll(workLive, PausePlaneAllPlaying));
};

const seat = (id: string, x: number) =>
  seatNode(id, {
    x,
    y: 40,
    width: 120,
    height: 48,
    bindingId: `bind-${id}` as never,
    launch: { kind: "harness", argv: ["claude"] },
  });

let root: string;
let runtime: ReturnType<typeof makeRuntime>;
let server: WorkControlServer;
const tokens: Record<string, string> = {};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "junto-mail-threads-"));
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
  for (const id of ["agent", "peer", "loner"]) {
    tokens[id] = publishSeatCredential(server.credentials, { agentKey: `local:${id}` });
  }
  await runtime.runPromise(
    seedCanvas(
      CANVAS,
      [seat("agent", 0), seat("peer", 160), seat("loner", 320)],
      [wire("agent-peer", "agent", "peer", "messages"), wire("peer-agent", "peer", "agent", "messages")],
    ),
  );
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

const mailbox = (nodeId: string): Promise<ReadonlyArray<Message>> =>
  runtime.runPromise(Effect.flatMap(WorkService, (work) => work.readMailbox(CANVAS, nodeId)));

const stored = async (nodeId: string, messageId: string): Promise<Message> => {
  const found = (await mailbox(nodeId)).find((message) => message.messageId === messageId);
  if (found === undefined) throw new Error(`${messageId} is not in ${nodeId}'s mailbox`);
  return found;
};

/** Operator mail as the desktop and the phone write it. */
const operatorMail = async (nodeId: string, text: string): Promise<string> => {
  const sender = operatorActorRef(CANVAS);
  const appended = await runtime.runPromise(
    Effect.flatMap(WorkService, (work) =>
      work.workSystemMailboxNotify(
        CANVAS,
        nodeId,
        makeUserMessage({
          messageId: ulid(),
          text,
          contextId: CANVAS,
          metadata: {
            factoryMail: true,
            ...mailExtensionMetadata({
              mailKind: "prompt",
              fromSeat: sender.seatId,
              senderNodeId: sender.nodeId,
              senderName: "operator",
              senderGeneration: "operator",
              senderHarness: "unknown",
            }),
          },
        }),
      ),
    ),
  );
  if (!appended.ok) throw new Error(appended.message);
  return appended.data.messageId;
};

describe("mail threads", () => {
  it("a reply carries the root's id, however deep the reply", async () => {
    const root = await call("peer", "msg.send", { target: "agent", text: "can you look at this?" });
    expect(root.ok).toBe(true);
    const rootId: string = root.data.messageId;
    expect(root.data.threadId).toBe(rootId);
    expect((await stored("agent", rootId)).metadata).not.toHaveProperty("threadId");

    const first = await call("agent", "msg.reply", { target: "peer", text: "on it", inReplyTo: rootId });
    expect(first.ok).toBe(true);
    expect(first.data).toMatchObject({ inReplyTo: rootId, threadId: rootId });
    const firstId: string = first.data.messageId;
    expect((await stored("peer", firstId)).metadata).toMatchObject({ inReplyTo: rootId, threadId: rootId });

    const second = await call("peer", "msg.reply", { target: "agent", text: "thanks", inReplyTo: firstId });
    expect(second.ok).toBe(true);
    expect((await stored("agent", second.data.messageId)).metadata).toMatchObject({ inReplyTo: firstId, threadId: rootId });
  });

  it("a reply names mail in the seat's own mailbox", async () => {
    const refused = await call("agent", "msg.reply", { target: "peer", text: "?", inReplyTo: "01JB2C3D4E5F6G7H8J9K0M1N2Z" });
    expect(refused.ok).toBe(false);
    expect(refused.error.type).toBe("UnknownTarget");
  });

  it("a send joins a thread the seat can read, by its root or by any mail in it", async () => {
    const rootId: string = (await call("peer", "msg.send", { target: "agent", text: "start" })).data.messageId;
    const replyId: string = (await call("agent", "msg.reply", { target: "peer", text: "reply", inReplyTo: rootId })).data.messageId;

    const byRoot = await call("agent", "msg.send", { target: "peer", text: "more", threadId: rootId });
    expect(byRoot.ok).toBe(true);
    expect(byRoot.data.threadId).toBe(rootId);
    expect((await stored("peer", byRoot.data.messageId)).metadata).toMatchObject({ threadId: rootId });

    // The agent sent the reply, so it can read it, and the reply stands for its thread.
    const byMember = await call("agent", "msg.send", { target: "peer", text: "and more", threadId: replyId });
    expect(byMember.ok).toBe(true);
    expect((await stored("peer", byMember.data.messageId)).metadata).toMatchObject({ threadId: rootId });
  });

  it("a send refuses a thread the seat cannot read", async () => {
    const rootId: string = (await call("peer", "msg.send", { target: "agent", text: "private" })).data.messageId;
    // loner has no mail; a wire to agent lets it send, never read agent's thread.
    await runtime.runPromise(seedCanvas(CANVAS, [], [wire("loner-agent", "loner", "agent", "messages")]));
    const refused = await call("loner", "msg.send", { target: "agent", text: "let me in", threadId: rootId });
    expect(refused.ok).toBe(false);
    expect(refused.error.type).toBe("UnknownTarget");
    expect(refused.error.details.path).toBe("threadId");
    expect((await mailbox("agent")).map((message) => message.messageId)).toEqual([rootId]);
  });

  it("list and read name the thread, and a list filters by it", async () => {
    const one: string = (await call("peer", "msg.send", { target: "agent", text: "thread one" })).data.messageId;
    const two: string = (await call("peer", "msg.send", { target: "agent", text: "thread two" })).data.messageId;
    const reply = await call("agent", "msg.reply", { target: "peer", text: "on one", inReplyTo: one });

    const all = await call("agent", "msg.list");
    expect(all.data.items.map((item: any) => [item.messageId, item.threadId])).toEqual(
      expect.arrayContaining([[one, one], [two, two]]),
    );

    const listed = await call("agent", "msg.list", { threadId: one });
    expect(listed.ok).toBe(true);
    expect(listed.data.threadId).toBe(one);
    expect(listed.data.items.map((item: any) => item.messageId)).toEqual([one]);
    expect(listed.data.sent.map((item: any) => [item.messageId, item.threadId, item.inReplyTo])).toEqual([
      [reply.data.messageId, one, one],
    ]);

    const read = await call("peer", "msg.read", { messageId: reply.data.messageId });
    expect(read.data.message).toMatchObject({ threadId: one, inReplyTo: one });
  });

  it("a seat answers operator mail in its thread, in its own mailbox, never typed back into it", async () => {
    const asked = await operatorMail("agent", "what is left?");
    const answered = await call("agent", "msg.reply", { target: "operator", text: "nothing, done", inReplyTo: asked });
    expect(answered.ok).toBe(true);
    expect(answered.data).toMatchObject({ inReplyTo: asked, threadId: asked });

    const row = await stored("agent", answered.data.messageId);
    expect(row.role).toBe("agent");
    expect(row.metadata).toMatchObject({ toNodeId: "operator", inReplyTo: asked, threadId: asked, senderNodeId: "agent" });
    expect((await mailbox("peer"))).toEqual([]);

    const thread = await call("agent", "msg.list", { threadId: asked });
    expect(thread.data.items.map((item: any) => item.messageId).sort()).toEqual([asked, answered.data.messageId].sort());
  });

  it("a seat writes to the operator only in reply to the operator's own mail", async () => {
    const fromPeer: string = (await call("peer", "msg.send", { target: "agent", text: "hi" })).data.messageId;
    const refused = await call("agent", "msg.reply", { target: "operator", text: "psst", inReplyTo: fromPeer });
    expect(refused.ok).toBe(false);
    expect(refused.error.type).toBe("ScopeError");

    const noReply = await call("agent", "msg.send", { target: "operator", text: "hello" });
    expect(noReply.ok).toBe(false);
    expect((await mailbox("agent")).map((message) => message.messageId)).toEqual([fromPeer]);
  });
});

describe("msg list filters", () => {
  const ids = (listed: any): string[] => listed.data.items.map((item: any) => item.messageId).sort();

  it("filters by sender, by name or by node id", async () => {
    const fromPeer: string = (await call("peer", "msg.send", { target: "agent", text: "from peer" })).data.messageId;
    const fromOperator = await operatorMail("agent", "from the operator");
    expect(ids(await call("agent", "msg.list", { from: "peer", peek: true }))).toEqual([fromPeer]);
    expect(ids(await call("agent", "msg.list", { from: "operator", peek: true }))).toEqual([fromOperator]);
    expect(ids(await call("agent", "msg.list", { from: "loner", peek: true }))).toEqual([]);
  });

  it("peek marks nothing read, a plain list still does, and unread lists what is left", async () => {
    const first: string = (await call("peer", "msg.send", { target: "agent", text: "one" })).data.messageId;
    const peeked = await call("agent", "msg.list", { peek: true });
    expect(peeked.data.items[0].metadata.readAt).toBeUndefined();
    expect(ids(await call("agent", "msg.list", { unread: true, peek: true }))).toEqual([first]);

    const listed = await call("agent", "msg.list");
    expect(typeof listed.data.items[0].metadata.readAt).toBe("number");
    const second: string = (await call("peer", "msg.send", { target: "agent", text: "two" })).data.messageId;
    expect(ids(await call("agent", "msg.list", { unread: true }))).toEqual([second]);
    expect(ids(await call("agent", "msg.list", { unread: true }))).toEqual([]);
  });

  it("since takes a message id (strictly after it) or an ISO time", async () => {
    const before = new Date(Date.now() - 60_000).toISOString();
    const first: string = (await call("peer", "msg.send", { target: "agent", text: "one" })).data.messageId;
    const second: string = (await call("peer", "msg.send", { target: "agent", text: "two" })).data.messageId;
    expect(ids(await call("agent", "msg.list", { since: first, peek: true }))).toEqual([second]);
    expect(ids(await call("agent", "msg.list", { since: before, peek: true }))).toEqual([first, second].sort());
    expect(ids(await call("agent", "msg.list", { since: "2999-01-01", peek: true }))).toEqual([]);
  });

  it("text matches ignoring case, and every filter combines with threadId", async () => {
    const root: string = (await call("peer", "msg.send", { target: "agent", text: "Release 0.9.0 is out" })).data.messageId;
    await call("peer", "msg.send", { target: "agent", text: "unrelated" });
    const inThread: string = (await call("peer", "msg.send", { target: "agent", text: "release notes", threadId: root })).data.messageId;
    expect(ids(await call("agent", "msg.list", { text: "RELEASE", peek: true }))).toEqual([root, inThread].sort());
    expect(ids(await call("agent", "msg.list", { threadId: root, text: "notes", from: "peer", since: root, peek: true }))).toEqual([inThread]);
  });

  it("refuses a bad filter by its path and shape, never echoing it", async () => {
    const SECRET = "not-valid <script>secret</script>";
    for (const [args, path] of [
      [{ since: SECRET }, "since"],
      [{ from: " " }, "from"],
      [{ text: "x".repeat(1001) }, "text"],
      [{ unread: SECRET }, "args"],
      [{ peek: SECRET }, "args"],
    ] as const) {
      const refused = await call("agent", "msg.list", args);
      expect(refused.ok).toBe(false);
      expect(refused.error).toMatchObject({ type: "InputError", details: { path } });
      expect(JSON.stringify(refused)).not.toContain("secret");
    }
  });
});

describe("operator threads", () => {
  const decodeSend = Schema.decodeUnknownSync(OperatorThreadSendSchema);
  const send = (input: Omit<OperatorThreadSend, "canvasName">) =>
    runtime.runPromise(
      sendOperatorThreadMail(decodeSend({ canvasName: CANVAS, ...input })) as Effect.Effect<any, unknown, never>,
    );
  const threadsOf = (nodeId: string) =>
    runtime.runPromise(seatThreads(CANVAS, nodeId) as Effect.Effect<ReadonlyArray<MailThreadSummary>, unknown, never>);
  const messagesOf = (nodeId: string, threadId: string) =>
    runtime.runPromise(
      seatThreadMessages(CANVAS, nodeId, threadId) as Effect.Effect<ReadonlyArray<MailThreadMessage>, unknown, never>,
    );

  it("lists a page thread as the page, and the operator's reply in it is a comment held at the page", async () => {
    await runtime.runPromise(
      seedCanvas(CANVAS, [pageNode("web", { x: 600, y: 40, width: 200, height: 120 })], []),
    );
    const root = await runtime.runPromise(postSubjectComment(
      { subject: { kind: "page", nodeId: asNodeId("web") }, text: "look at the header", actor: { kind: "operator" }, opId: OpId.make(ulid()) },
      { canvas: await runtime.runPromise(Effect.flatMap(ModelService, (model) => model.canvas(CANVAS))), canvasName: CANVAS, people: [asNodeId("agent")] },
    ) as Effect.Effect<{ threadId: MailMessageId }, unknown, never>);
    const threadId = root.threadId;
    const [listed] = await threadsOf("agent");
    expect(listed).toMatchObject({ threadId, subject: { kind: "page", nodeId: "web" } });
    expect(listed?.title).not.toContain("look at the header");

    const sent = await send({ nodeId: "agent", threadId, text: "fixed it" });
    expect(sent, JSON.stringify(sent)).toMatchObject({ threadId, comment: true });
    const held = (await mailbox("web")).find((message) => message.messageId === sent.messageId);
    expect(held?.metadata).toMatchObject({ threadId, fromSeat: OPERATOR_SEAT_ID, senderName: "operator" });
    const notices = (await mailbox("agent")).filter((message) => message.metadata?.threadId === threadId);
    expect(notices).toHaveLength(2);
    expect(await send({ nodeId: "agent", threadId, text: "and a file", attachments: [] })).toMatchObject({ comment: true });
  });

  it("carries files the operator staged: claimed for the mail, named as main recorded them, read back in the thread", async () => {
    const bytes = Buffer.from("not really a png");
    const staged = await runtime.runPromise(
      putOperatorContent(CANVAS, {
        bytesBase64: bytes.toString("base64"),
        done: { mediaType: "image/png", displayName: "shot.png" },
      } as never) as Effect.Effect<any, unknown, never>,
    );
    expect(staged.ok).toBe(true);
    const staged_ref = staged.result.ref;
    // The caller's spelling of the type and name is not trusted.
    const sent = await send({ nodeId: "agent", text: "", attachments: [{ ...staged_ref, mediaType: "application/x-evil", displayName: "evil.exe" }] });
    expect(sent).toMatchObject({ messageId: expect.any(String), threadId: expect.any(String) });
    const [row] = (await mailbox("agent")).filter((message) => message.messageId === sent.messageId);
    expect(row!.metadata!.attachments).toEqual([
      expect.objectContaining({ sha256: staged_ref.sha256, byteLength: bytes.length, displayName: "shot.png" }),
    ]);
    const [message] = await messagesOf("agent", sent.threadId);
    expect(message!.text).toBe("");
    expect(message!.attachments).toEqual([expect.objectContaining({ sha256: staged_ref.sha256, displayName: "shot.png" })]);
    const [thread] = await threadsOf("agent");
    expect(thread!.title).toBe("shot.png");
    // A staged file is claimed once.
    const again = await send({ nodeId: "agent", text: "again", attachments: [staged_ref] });
    expect(again).toMatchObject({ ok: false, reason: "invalid" });
  });

  it("refuses mail with neither text nor files, and files that were never staged", async () => {
    expect(await send({ nodeId: "agent", text: "  " })).toMatchObject({ ok: false, reason: "invalid" });
    const ghost = { sha256: "b".repeat(64), byteLength: 4, mediaType: "image/png", displayName: "ghost.png" };
    const refused = await send({ nodeId: "agent", text: "look", attachments: [ghost] });
    expect(refused).toMatchObject({ ok: false, reason: "invalid" });
    expect(await mailbox("agent")).toEqual([]);
  });

  it("starts a thread to a seat, and the seat's answer lands in it", async () => {
    const started = await send({ nodeId: "agent", text: "What is left?\nDetails follow." });
    expect(started.messageId).toBe(started.threadId);
    const answered = await call("agent", "msg.reply", { target: "operator", text: "nothing", inReplyTo: started.messageId });
    expect(answered.ok).toBe(true);

    const [thread] = await threadsOf("agent");
    expect(thread).toMatchObject({
      threadId: started.threadId,
      title: "What is left?",
      messageCount: 2,
      canReply: true,
      participants: [{ kind: "operator" }, { kind: "seat", nodeId: "agent", name: "agent" }],
    });
    expect((await messagesOf("agent", started.threadId)).map((message) => [message.mine, message.from.kind, message.text])).toEqual([
      [true, "operator", "What is left?\nDetails follow."],
      [false, "seat", "nothing"],
    ]);
  });

  it("a reply in a thread derives its thread from the parent", async () => {
    const started = await send({ nodeId: "agent", text: "first" });
    const answer = await call("agent", "msg.reply", { target: "operator", text: "ok", inReplyTo: started.messageId });
    const followUp = await send({ nodeId: "agent", text: "and then?", inReplyTo: answer.data.messageId });
    expect(followUp.threadId).toBe(started.threadId);
    expect((await stored("agent", followUp.messageId)).metadata).toMatchObject({
      threadId: started.threadId,
      inReplyTo: answer.data.messageId,
    });
    expect(await send({ nodeId: "agent", text: "?", inReplyTo: "01JB2C3D4E5F6G7H8J9K0M1N2Z" })).toMatchObject({ ok: false, reason: "not-found" });
    expect(await send({ nodeId: "agent", text: "?", threadId: "01JB2C3D4E5F6G7H8J9K0M1N2Z" })).toMatchObject({ ok: false, reason: "not-found" });
  });

  it("a mention is the link in the text: nothing is kept beside it, and the mentioned seat gets nothing", async () => {
    const text = `${mentionLink({ kind: "seat", nodeId: asNodeId("peer") }, "peer", CANVAS)} has the numbers`;
    const started = await send({ nodeId: "agent", text });
    expect(started).toMatchObject({ messageId: expect.any(String), threadId: started.messageId });
    expect((await stored("agent", started.messageId)).metadata).not.toHaveProperty("mentions");
    expect(await mailbox("peer")).toEqual([]);

    const [message] = await messagesOf("agent", started.threadId);
    expect(message).toMatchObject({ to: [{ kind: "seat", nodeId: "agent", name: "agent" }], text });
    expect(message).not.toHaveProperty("mentions");
    const [thread] = await threadsOf("agent");
    expect(thread!.participants).toEqual([{ kind: "operator" }, { kind: "seat", nodeId: "agent", name: "agent" }]);
    // The title reads the mention as its label, not as its link.
    expect(thread!.title).toBe("peer has the numbers");
    expect(await threadsOf("peer")).toEqual([]);
  });

  it("in a subject thread, the operator mentions a seat in reach of the resource, wired to the seat or not", async () => {
    await runtime.runPromise(
      seedCanvas(CANVAS, [pageNode("web", { x: 600, y: 40, width: 200, height: 120 })], []),
    );
    const root = await runtime.runPromise(postSubjectComment(
      { subject: { kind: "page", nodeId: asNodeId("web") }, text: "look at the header", actor: { kind: "operator" }, opId: OpId.make(ulid()) },
      { canvas: await runtime.runPromise(Effect.flatMap(ModelService, (model) => model.canvas(CANVAS))), canvasName: CANVAS, people: [asNodeId("agent")] },
    ) as Effect.Effect<{ threadId: MailMessageId }, unknown, never>);
    // loner has no edge to agent, and the page, in no region, is in its reach.
    const sent = await send({ nodeId: "agent", threadId: root.threadId, text: `${mentionLink({ kind: "seat", nodeId: asNodeId("loner") }, "loner", CANVAS)} see this` });
    expect(sent, JSON.stringify(sent)).toMatchObject({ threadId: root.threadId, comment: true });
    expect((await mailbox("loner")).filter((message) => message.metadata?.subjectNotice === "mention")).toHaveLength(1);
  });

  it("refuses the operator's reply in a task thread whose task the board does not hold, writing nothing", async () => {
    await runtime.runPromise(seedCanvas(CANVAS, [taskBoard("board", { x: 600, y: 40, width: 200, height: 120 })], []));
    const root = await runtime.runPromise(postSubjectComment(
      { subject: { kind: "task", nodeId: asNodeId("board"), taskId: ItemId.make(ulid()) }, text: "about this task", actor: { kind: "operator" }, opId: OpId.make(ulid()) },
      { canvas: await runtime.runPromise(Effect.flatMap(ModelService, (model) => model.canvas(CANVAS))), canvasName: CANVAS, people: [asNodeId("agent")] },
    ) as Effect.Effect<{ threadId: MailMessageId; messageId: string }, unknown, never>);
    const sent = await send({ nodeId: "agent", threadId: root.threadId, text: "still on it?" });
    expect(sent).toEqual({ ok: false, reason: "not-found", message: "That task is no longer on its board." });
    expect((await mailbox("board")).map((message) => message.messageId)).toEqual([root.messageId]);
  });

  it("refuses a mention of a seat not wired to the seat, writing nothing", async () => {
    const refused = await send({ nodeId: "agent", text: `hi ${mentionLink({ kind: "seat", nodeId: asNodeId("loner") }, "loner", CANVAS)}` });
    expect(refused).toEqual({ ok: false, reason: "invalid", message: "loner is not connected to agent, so it cannot be mentioned here." });
    expect(await mailbox("agent")).toEqual([]);
    expect(await mailbox("loner")).toEqual([]);
    expect(await runtime.runPromise(mentionableSeats(CANVAS, "agent") as Effect.Effect<any, unknown, never>)).toEqual([
      { nodeId: "peer", name: "peer" },
    ]);
  });

  it("a review's row carries its lines, and a seat it mentions gets the row in the same thread, wired or not", async () => {
    const lines = { kind: "lines", file: "src/a.ts", from: 3, to: 5, side: "deletions" } as const;
    const text = `src/a.ts, lines 3 to 5. ${mentionLink({ kind: "seat", nodeId: asNodeId("loner") }, "loner", CANVAS)} owns this`;
    const root = await send({ nodeId: "agent", text: "Code review from the operator.", review: { anchorNodeId: "agent" } });
    const sent = await send({ nodeId: "agent", text, threadId: root.threadId, review: { anchorNodeId: "agent", anchor: lines } });
    expect(sent).toMatchObject({ threadId: root.threadId, copies: [{ nodeId: "loner", messageId: expect.any(String) }] });
    expect(linesAnchorOf(await stored("agent", sent.messageId))).toEqual(lines);
    const [copy] = await mailbox("loner");
    expect(copy).toMatchObject({
      messageId: sent.copies[0].messageId,
      parts: [{ kind: "text", text }],
      metadata: { threadId: root.threadId, copyOf: sent.messageId },
    });
    expect(linesAnchorOf(copy!)).toEqual(lines);
    expect(linesAnchorOf(await stored("agent", root.messageId))).toBeUndefined();
    expect(await mailbox("peer")).toEqual([]);
    // The copy's id is the row's and the seat's: a retried copy is the same row.
    expect(sent.copies[0].messageId).toBe(reviewCopyId(sent.messageId, asNodeId("loner")));
    expect(reviewCopyId(sent.messageId, asNodeId("loner"))).not.toBe(reviewCopyId(sent.messageId, asNodeId("peer")));
  });

  it("a review's copy that cannot be written is skipped: the row and the other copies stand", async () => {
    const link = (id: string) => mentionLink({ kind: "seat", nodeId: asNodeId(id) }, id, CANVAS);
    const text = `Look here, ${link("loner")} and ${link("peer")}`;
    const sending = Effect.flatMap(WorkService, (work) =>
      sendOperatorThreadMail(
        Schema.decodeUnknownSync(OperatorThreadSendSchema)({ canvasName: CANVAS, nodeId: "agent", text, review: { anchorNodeId: "agent" } }),
      ).pipe(
        Effect.provideService(WorkService, {
          ...work,
          // Only the copy to loner fails; every other write goes through.
          workSystemMailboxNotify: (canvas: string, node: string, message: Message, ...rest: ReadonlyArray<unknown>) =>
            node === "loner"
              ? Effect.succeed({ ok: false as const, code: "invalid" as const, message: "mailbox down" })
              : (work.workSystemMailboxNotify as (...args: ReadonlyArray<unknown>) => unknown)(canvas, node, message, ...rest),
        } as never),
      ),
    );
    const sent = await runtime.runPromise(sending as Effect.Effect<any, unknown, never>);
    expect(sent).toMatchObject({ copies: [{ nodeId: "peer", messageId: expect.any(String) }] });
    expect(sent.copies).toHaveLength(1);
    expect(await stored("agent", sent.messageId)).toBeDefined();
    expect(await mailbox("loner")).toEqual([]);
    expect((await mailbox("peer")).map((row) => row.messageId)).toEqual([reviewCopyId(sent.messageId, asNodeId("peer"))]);
  });

  it("a review opened from a place no longer on the canvas is refused, never sent to every agent", async () => {
    const text = `see ${mentionLink({ kind: "seat", nodeId: asNodeId("loner") }, "loner", CANVAS)}`;
    expect(await send({ nodeId: "agent", text, review: { anchorNodeId: "gone-git" } })).toEqual({
      ok: false, reason: "invalid", message: "The place this review was opened from is no longer on the canvas.",
    });
    expect(await mailbox("agent")).toEqual([]);
    expect(await mailbox("loner")).toEqual([]);
    // No anchor at all is the open field: every agent.
    expect(await send({ nodeId: "agent", text, review: {} })).toMatchObject({ copies: [{ nodeId: "loner" }] });
  });

  it("a review refuses a seat out of reach of where it was opened, writing nothing", async () => {
    await runtime.runPromise(seedCanvas(CANVAS, [
      region("left", { x: -10, y: 0, width: 300, height: 120 }),
      region("right", { x: 310, y: 0, width: 160, height: 120 }),
    ]));
    const text = `see ${mentionLink({ kind: "seat", nodeId: asNodeId("loner") }, "loner", CANVAS)}`;
    expect(await send({ nodeId: "agent", text, review: { anchorNodeId: "agent" } })).toEqual({
      ok: false, reason: "invalid", message: "loner cannot receive this review.",
    });
    expect(await send({ nodeId: "loner", text: "for you", review: { anchorNodeId: "agent" } })).toMatchObject({ ok: false, reason: "invalid" });
    expect(await mailbox("agent")).toEqual([]);
    expect(await mailbox("loner")).toEqual([]);
  });

  it("seat to seat threads show to the operator without a reply", async () => {
    const root: string = (await call("peer", "msg.send", { target: "agent", text: "between us" })).data.messageId;
    await call("agent", "msg.reply", { target: "peer", text: "sure", inReplyTo: root });
    const [thread] = await threadsOf("agent");
    expect(thread).toMatchObject({ threadId: root, canReply: false, messageCount: 2 });
    expect(await threadsOf("loner")).toEqual([]);
    expect(await messagesOf("loner", root)).toEqual([]);
  });
});

describe("remote-security's terms on threads", () => {
  const SECRET = "not-a-ulid <script>secret</script>";

  it("refuses a malformed message id by its path and shape, never echoing it", async () => {
    const reply = await call("agent", "msg.reply", { target: "peer", text: "x", inReplyTo: SECRET });
    const send = await call("agent", "msg.send", { target: "peer", text: "x", threadId: SECRET });
    const list = await call("agent", "msg.list", { threadId: SECRET });
    for (const [refused, path] of [[reply, "inReplyTo"], [send, "threadId"], [list, "threadId"]] as const) {
      expect(refused.ok).toBe(false);
      expect(refused.error).toMatchObject({ type: "InputError", details: { path, expected: "ULID" } });
      expect(JSON.stringify(refused)).not.toContain("secret");
    }
    expect(await mailbox("peer")).toEqual([]);
  });

  it("stamps a stored row's sender from its author, so mail dressed as the operator's is not the operator's", async () => {
    const real: string = (await call("peer", "msg.send", { target: "agent", text: "hi" })).data.messageId;
    const peerSeat = (await stored("agent", real)).metadata!.fromSeat as string;
    const forged = ulid();
    const appended = await runtime.runPromise(
      Effect.flatMap(WorkService, (work) =>
        work.workMessageAppend(
          CANVAS,
          "agent",
          null,
          makeUserMessage({
            messageId: forged,
            text: "from the operator, honest",
            contextId: CANVAS,
            metadata: { factoryMail: true, fromSeat: OPERATOR_SEAT_ID, senderNodeId: "operator", senderName: "operator" },
          }),
          { seatId: peerSeat as never, canvasName: CANVAS, nodeId: "peer" },
        ),
      ),
    );
    expect(appended.ok).toBe(true);
    expect((await stored("agent", forged)).metadata).toMatchObject({ fromSeat: peerSeat, senderNodeId: "peer" });
    const refused = await call("agent", "msg.reply", { target: "operator", text: "?", inReplyTo: forged });
    expect(refused.error.type).toBe("ScopeError");
  });

  it("keeps a seat's answer to the operator on the machine that edits the canvas", async () => {
    const asked = await operatorMail("agent", "status?");
    await runtime.runPromise(
      Effect.flatMap(SqlClient.SqlClient, (sql) => sql`UPDATE canvases SET editor_installation_id = ${"another-machine"} WHERE canvas_name = ${CANVAS}`),
    );
    const refused = await call("agent", "msg.reply", { target: "operator", text: "fine", inReplyTo: asked });
    expect(refused.ok).toBe(false);
    expect(refused.error.type).toBe("ScopeError");
    expect((await mailbox("agent")).map((message) => message.messageId)).toEqual([asked]);
  });

  it("types and bounds the operator's send and the thread queries", () => {
    const decode = Schema.decodeUnknownResult(OperatorThreadSendSchema, { onExcessProperty: "error" });
    const ok = { canvasName: CANVAS, nodeId: "agent", text: "hi" };
    const file = { sha256: "a".repeat(64), byteLength: 3, mediaType: "image/png", displayName: "shot.png" };
    expect(decode(ok)._tag).toBe("Success");
    // Text may be empty when files ride along; main refuses mail with neither.
    expect(decode({ ...ok, text: "", attachments: [file] })._tag).toBe("Success");
    expect(decode({ ...ok, attachments: Array.from({ length: OPERATOR_ATTACHMENTS_MAX }, () => file) })._tag).toBe("Success");
    for (const bad of [
      { ...ok, canvasName: "Not A Canvas!" },
      { ...ok, nodeId: "" },
      { ...ok, text: "x".repeat(OPERATOR_MAIL_MAX_TEXT + 1) },
      { ...ok, attachments: Array.from({ length: OPERATOR_ATTACHMENTS_MAX + 1 }, () => file) },
      { ...ok, attachments: [{ ...file, sha256: "not a digest" }] },
      { ...ok, threadId: "thread-1" },
      { ...ok, inReplyTo: "msg_01" },
      // A mention is the link in the text: a list beside it is no field of the send.
      { ...ok, mentions: ["seat-1"] },
      { ...ok, extra: true },
    ]) {
      expect(decode(bad)._tag).toBe("Failure");
    }
  });

  it("a failed write is refused in fixed words: the mail's text never leaves the mailbox", async () => {
    const body = "the launch codes are 0000";
    const failing = Effect.flatMap(WorkService, (work) =>
      sendOperatorThreadMail(
        Schema.decodeUnknownSync(OperatorThreadSendSchema)({ canvasName: CANVAS, nodeId: "agent", text: body }),
      ).pipe(
        Effect.provideService(WorkService, {
          ...work,
          workSystemMailboxNotify: (_canvas: string, _node: string, message: Message) =>
            Effect.succeed({ ok: false as const, code: "invalid" as const, message: `could not store ${JSON.stringify(message)}` }),
        } as never),
      ),
    );
    const result = await runtime.runPromise(failing as Effect.Effect<any, unknown, never>);
    expect(result).toEqual({ ok: false, reason: "failed", message: "The mail could not be written." });
    expect(JSON.stringify(result)).not.toContain("launch codes");
  });
});
