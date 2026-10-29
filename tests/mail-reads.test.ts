/**
 * The operator's read point in each mail thread (0.11.3), through the real
 * stores and seat mail: one point per thread, read under either seat of a
 * thread between two, forward only, a mark that moves nothing silent, and a
 * refusal answered as undefined.
 */
import { mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodeWorkFrame } from "../src/shared/work-control";
import { unreadPast, type MailReadChanged } from "../src/shared/mail-threads";
import { publishSeatCredential } from "./helpers/seat-credential";
import { ModelStoresLive, seedCanvas } from "./support/seed-canvas";
import { seat as seatNode, wire } from "./support/model-nodes";
import { startWorkControlServer, type WorkControlServer } from "../src/main/junto/work/control";
import { WorkLive } from "../src/main/junto/work/service";
import { CrewRepositoryLive } from "../src/main/junto/work/crew-repository";
import { makeContentServiceLive } from "../src/main/junto/content/service";
import { WorkRepositoryLive } from "../src/main/junto/work/repository";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { makeInstallOpsLive } from "../src/main/junto/install-ops/engine";
import { MachineRepositoryLive } from "../src/main/junto/machines/repository";
import { SettingsLive } from "../src/main/junto/settings/service";
import { nameThisMachine } from "./support/name-this-machine";
import { PausePlaneAllPlaying } from "../src/main/junto/pause-plane";
import { seatThreadMessages } from "../src/main/junto/work/operator-threads";
import { markRead, onReadChanged, readPoints } from "../src/main/junto/work/mail-reads";
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
  return ManagedRuntime.make(Layer.mergeAll(Layer.provideMerge(WorkLive, canvasesLive), PausePlaneAllPlaying));
};

const seat = (id: string, x: number) =>
  seatNode(id, { x, y: 40, width: 120, height: 48, bindingId: `bind-${id}` as never, launch: { kind: "harness", argv: ["claude"] } });

let root: string;
let runtime: ReturnType<typeof makeRuntime>;
let server: WorkControlServer;
const tokens: Record<string, string> = {};
let heard: Array<MailReadChanged>;
let unsubscribe: () => void;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "junto-mail-reads-"));
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
  heard = [];
  unsubscribe = onReadChanged((change) => heard.push(change));
});

afterEach(async () => {
  unsubscribe();
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

/** A thread between agent and peer: peer writes, agent replies. */
const conversation = async () => {
  const opened = await call("peer", "msg.send", { target: "agent", text: "can you look at this?" });
  const reply = await call("agent", "msg.reply", { target: "peer", text: "on it", inReplyTo: opened.data.messageId });
  return { threadId: opened.data.messageId as string, first: opened.data.messageId as string, last: reply.data.messageId as string };
};

const points = (nodeId: string, threadIds?: ReadonlyArray<string>) => runtime.runPromise(readPoints(CANVAS, nodeId, threadIds));
const mark = (nodeId: string, threadId: string, through?: string) => runtime.runPromise(markRead(CANVAS, nodeId, threadId, through));
const unread = async (nodeId: string, threadId: string) =>
  unreadPast(await runtime.runPromise(seatThreadMessages(CANVAS, nodeId, threadId)), (await points(nodeId)).get(threadId));
const readAt = () =>
  runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql<{ read_at: number }>`SELECT read_at FROM operator_mail_reads`));

describe("the operator's mail read points", () => {
  it("a thread between two seats, read under one, is read under both", async () => {
    const { threadId, last } = await conversation();
    expect((await points("agent")).has(threadId)).toBe(false);
    // Never read: every mail the operator did not write is unread, under each seat.
    expect(await unread("agent", threadId)).toBe(2);
    expect(await unread("peer", threadId)).toBe(2);

    const point = await mark("agent", threadId);
    expect(point).toMatchObject({ through: last });
    expect((await points("agent")).get(threadId)).toEqual(point);
    expect((await points("peer")).get(threadId)).toEqual(point);
    expect(await unread("agent", threadId)).toBe(0);
    expect(await unread("peer", threadId)).toBe(0);
    // Heard once, naming both seats, so both Threads buttons count again.
    expect(heard).toHaveLength(1);
    expect(heard[0]).toMatchObject({ canvasName: CANVAS, threadId });
    expect([...heard[0]!.seats].sort()).toEqual(["agent", "peer"]);
  });

  it("only moves forward, and a mark that moves nothing writes nothing and tells no one", async () => {
    const { threadId, first, last } = await conversation();
    const point = await mark("peer", threadId, last);
    const written = await readAt();
    expect(await mark("peer", threadId)).toEqual(point);
    expect(await mark("agent", threadId, first)).toEqual(point);
    expect(await readAt()).toEqual(written);
    expect(heard).toHaveLength(1);

    // New seat mail past the point is unread again, and a mark with no mail named reads through it.
    const more = await call("peer", "msg.reply", { target: "agent", text: "and this", inReplyTo: last });
    expect(await unread("agent", threadId)).toBe(1);
    expect(await mark("agent", threadId)).toMatchObject({ through: more.data.messageId });
    expect(await unread("peer", threadId)).toBe(0);
    expect(heard).toHaveLength(2);
  });

  it("a read before the newest mail leaves what came after it unread", async () => {
    const { threadId, first } = await conversation();
    expect(await mark("agent", threadId, first)).toMatchObject({ through: first });
    expect(await unread("agent", threadId)).toBe(1);
  });

  it("answers a refusal as undefined, and writes nothing", async () => {
    const { threadId } = await conversation();
    // Not the seat's thread, a mail not of the thread, a canvas that is not there.
    expect(await mark("loner", threadId)).toBeUndefined();
    expect(await mark("agent", threadId, "01M00000000000000000000000")).toBeUndefined();
    expect(await runtime.runPromise(markRead("nowhere", "agent", threadId))).toBeUndefined();
    expect(await readAt()).toEqual([]);
    expect(heard).toEqual([]);
  });

  it("reads one page of a seat's points, and leaves out a thread not of the seat's", async () => {
    const { threadId } = await conversation();
    await mark("agent", threadId);
    expect([...(await points("agent", [threadId, "elsewhere"])).keys()]).toEqual([threadId]);
    expect((await points("loner", [threadId])).size).toBe(0);
  });
});
