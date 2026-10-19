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
import { Effect, Layer, ManagedRuntime } from "effect";
import { ulid } from "ulid";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodeWorkFrame } from "../src/shared/work-control";
import { mailExtensionMetadata } from "../src/shared/crew";
import { makeUserMessage } from "../src/shared/task";
import { operatorActorRef } from "../src/shared/work-reference";
import type { Message } from "../src/shared/work-model";
import { publishSeatCredential } from "./helpers/seat-credential";
import { ModelStoresLive, seedCanvas } from "./support/seed-canvas";
import { seat as seatNode, wire } from "./support/model-nodes";
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
    const refused = await call("agent", "msg.reply", { target: "peer", text: "?", inReplyTo: "01NOSUCHMAIL0000000000000A" });
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
