/**
 * thread.list and thread.show across the work socket: a seat reads its own
 * threads with no edge and no port, and a connected seat's on threads.read,
 * through the core's one thread read. The seat's view leaves the operator's
 * read state out, and reading moves no read point.
 */
import { mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ThreadList, ThreadRpcs, ThreadShow } from "../src/contract/work/thread";
import { callWorkRpc } from "./support/work-rpc";
import { OperatorThreadSend } from "../src/shared/mail-threads";
import { WORK_TOKEN_ENV, encodeWorkFrame } from "../src/shared/work-control";
import { publishSeatCredential } from "./helpers/seat-credential";
import { ModelStoresLive, seedCanvas } from "./support/seed-canvas";
import { region, seat as seatNode, taskBoard, wire } from "./support/model-nodes";
import { startWorkControlServer, type WorkControlServer } from "../src/core/work/control";
import { WorkLive } from "../src/core/work/service";
import { CrewRepositoryLive } from "../src/core/work/crew-repository";
import { makeContentServiceLive } from "../src/core/content/service";
import { WorkRepositoryLive } from "../src/core/work/repository";
import { makeStateEngineLive } from "../src/core/state/engine";
import { makeInstallOpsLive } from "../src/core/install-ops/engine";
import { MachineRepositoryLive } from "../src/core/machines/repository";
import { SettingsLive } from "../src/core/settings/service";
import { nameThisMachine } from "./support/name-this-machine";
import { PausePlaneAllPlaying } from "../src/core/pause-plane";
import { createMainAuthoringGate } from "../src/node/main-authoring-gate";
import { RulingRecorderLive } from "../src/core/work/ruling-recorder";
import { TaskRepositoryLive } from "../src/core/work/task-repository";
import { ArtifactRepositoryLive } from "../src/core/work/artifact-repository";
import { sendOperatorThreadMail } from "../src/core/work/operator-threads";
import { readPoints } from "../src/core/work/mail-reads";
import { makeTestLog } from "./support/test-log";

const testLog = makeTestLog();

const CANVAS = "threads";
const ME = "agent";
const PEER = "peer";
const STRANGER = "stranger";
/** Wired with threads.read and terminal.read masked off. */
const THREADS_ONLY = "threads-only";
/** Wired with terminal.read and threads.read masked off. */
const TERMINAL_ONLY = "terminal-only";
/** A Tasks node in the caller's reach: not a seat. */
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
  const rulersLive = Layer.provide(Layer.mergeAll(TaskRepositoryLive, ArtifactRepositoryLive), RulingRecorderLive);
  const canvasesLive = Layer.provideMerge(Layer.mergeAll(ModelStoresLive, rulersLive), repositoriesLive);
  return ManagedRuntime.make(Layer.mergeAll(Layer.provideMerge(WorkLive, canvasesLive), PausePlaneAllPlaying, testLog.log.loggerLayer));
};

let root: string;
let runtime: ReturnType<typeof makeRuntime>;
let server: WorkControlServer;
let mine = "";

const decodeSend = Schema.decodeUnknownSync(OperatorThreadSend);

/** The operator writes a new thread into a seat's mailbox, as the desktop does. */
const operatorWrites = async (nodeId: string, text: string): Promise<string> => {
  const written = await runtime.runPromise(
    sendOperatorThreadMail(decodeSend({ canvasName: CANVAS, nodeId, text })) as Effect.Effect<any, unknown, never>,
  );
  expect(written).toHaveProperty("threadId");
  return written.threadId as string;
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "junto-work-rpc-thread-"));
  const workHome = join(root, "work");
  mkdirSync(workHome, { recursive: true });
  process.env.JUNTO_WORK_HOME = workHome;
  runtime = makeRuntime(root);
  await runtime.runPromise(nameThisMachine);
  await runtime.runPromise(
    seedCanvas(
      CANVAS,
      [
        region("region", { x: -40, y: -40, width: 1400, height: 300 }, { label: "Canvas" }),
        seatNode(ME, { x: 0 }),
        seatNode(PEER, { x: 200 }),
        seatNode(STRANGER, { x: 400 }),
        seatNode(THREADS_ONLY, { x: 600 }),
        seatNode(TERMINAL_ONLY, { x: 800 }),
        taskBoard(BOARD, { x: 0, y: 120 }),
      ],
      [
        wire("edge", ME, PEER, "messages"),
        wire("back", PEER, ME, "messages"),
        wire("threads-only", ME, THREADS_ONLY, "messages", { mask: ["msg.send", "threads.read"] }),
        wire("terminal-only", ME, TERMINAL_ONLY, "messages", { mask: ["msg.send", "terminal.read"] }),
      ],
    ),
  );
  server = await startWorkControlServer({
    version: "test",
    workHome,
    home: root,
    run: (effect) => runtime.runPromise(effect),
    authoringGate: createMainAuthoringGate(),
  });
  mine = publishSeatCredential(server.credentials, { agentKey: `local:${ME}` });
});

afterEach(async () => {
  await server.close();
  await runtime.dispose();
  await rm(root, { recursive: true, force: true });
  delete process.env.JUNTO_WORK_HOME;
  delete process.env[WORK_TOKEN_ENV];
});

/** A v1 frame as a seat writes it by hand, and the frame the core answers. */
const raw = (op: string, args: unknown): Promise<any> =>
  new Promise((resolve, reject) => {
    const socket = createConnection({ path: server.socketPath });
    let buffer = "";
    socket.on("connect", () => socket.write(encodeWorkFrame({ token: mine, op, args })));
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      socket.destroy();
      resolve(JSON.parse(buffer.slice(0, newline)));
    });
    socket.on("error", reject);
  });

const cli = <A>(call: Effect.Effect<A, unknown>): Promise<A> => {
  process.env[WORK_TOKEN_ENV] = mine;
  return Effect.runPromise(call);
};

describe("thread.list and thread.show across the work socket", () => {
  it("serves both ops of the group through RPC", () => {
    expect([...ThreadRpcs.requests.keys()].sort()).toEqual(["thread.list", "thread.show"]);
  });

  it("reads the caller's own threads with no edge, without the operator's read state", async () => {
    const threadId = await operatorWrites(ME, "Can you review the plan?");
    const before = await runtime.runPromise(readPoints(CANVAS, ME) as Effect.Effect<ReadonlyMap<string, unknown>, unknown, never>);

    const listed = await cli(callWorkRpc(ThreadList, {}));
    expect(listed.seat).toBe(ME);
    expect(listed.threads.map((thread) => thread.threadId)).toEqual([threadId]);
    const [thread] = listed.threads;
    expect(thread).toMatchObject({ title: "Can you review the plan?", owned: true, canReply: true, messageCount: 1 });
    expect(thread).not.toHaveProperty("unread");
    expect(thread).not.toHaveProperty("readAt");
    expect(listed).not.toHaveProperty("next");

    const shown = await cli(callWorkRpc(ThreadShow, { threadId }));
    expect(shown).toMatchObject({ seat: ME, threadId });
    expect(shown.messages.map((message) => message.text)).toEqual(["Can you review the plan?"]);

    // The seat's read moved no read point of the operator's.
    const after = await runtime.runPromise(readPoints(CANVAS, ME) as Effect.Effect<ReadonlyMap<string, unknown>, unknown, never>);
    expect([...after]).toEqual([...before]);

    // Naming itself is its own read.
    expect((await raw("thread.list", { seat: ME })).data.seat).toBe(ME);
  });

  it("pages threads by the cursor each page answers", async () => {
    const first = await operatorWrites(ME, "first");
    const second = await operatorWrites(ME, "second");
    const page = await cli(callWorkRpc(ThreadList, { limit: 1 }));
    expect(page.threads.map((thread) => thread.threadId)).toEqual([second]);
    expect(page.next).toBeDefined();
    const rest = await cli(callWorkRpc(ThreadList, { limit: 1, after: page.next! }));
    expect(rest.threads.map((thread) => thread.threadId)).toEqual([first]);
    expect(rest).not.toHaveProperty("next");
  });

  it("reads a connected seat's threads on threads.read, and refuses a seat it has no edge to", async () => {
    const threadId = await operatorWrites(PEER, "Peer, a question for you");
    const listed = (await raw("thread.list", { seat: PEER })).data;
    expect(listed.seat).toBe(PEER);
    expect(listed.threads.map((thread: { threadId: string }) => thread.threadId)).toEqual([threadId]);
    const shown = (await raw("thread.show", { seat: PEER, threadId })).data;
    expect(shown.messages.map((message: { text: string }) => message.text)).toEqual(["Peer, a question for you"]);
    // The peer's thread is not the caller's.
    expect((await raw("thread.show", { threadId })).error.type).toBe("UnknownTarget");

    await operatorWrites(STRANGER, "not yours");
    const refused = await raw("thread.list", { seat: STRANGER });
    expect(refused.ok).toBe(false);
    expect(refused.error.type).toBe("ScopeError");
  });

  it("refuses a thread the seat is not in, and arguments the contract does not name", async () => {
    const unknown = await raw("thread.show", { threadId: "01ARZ3NDEKTSV4RRFFQ69G5FAV" });
    expect(unknown.error).toMatchObject({ type: "UnknownTarget", details: { next_step: "junto thread list" } });
    expect((await raw("thread.show", { threadId: "nope" })).error.type).toBe("InputError");
    expect((await raw("thread.list", { limit: 0 })).error.type).toBe("InputError");
    expect((await raw("thread.list", { group: "mine" })).error.type).toBe("InputError");
    const extra = await raw("thread.list", { target: PEER });
    expect(extra.error).toMatchObject({ type: "InputError", details: { hint: "junto schema show thread.list" } });
  });
});

describe("thread reads between seats: admission on threads.read alone", () => {
  const readPointsOf = (nodeId: string) =>
    runtime.runPromise(readPoints(CANVAS, nodeId) as Effect.Effect<ReadonlyMap<string, unknown>, unknown, never>);

  it("reads a seat whose edge keeps threads.read with terminal.read masked off", async () => {
    const threadId = await operatorWrites(THREADS_ONLY, "only threads here");
    const listed = await raw("thread.list", { seat: THREADS_ONLY });
    expect(listed.data.threads.map((thread: { threadId: string }) => thread.threadId)).toEqual([threadId]);
    const shown = await raw("thread.show", { seat: THREADS_ONLY, threadId });
    expect(shown.data.messages.map((message: { text: string }) => message.text)).toEqual(["only threads here"]);
    // Threads opened nothing of the terminal.
    const screen = await raw("seat.read", { target: THREADS_ONLY, lines: 10 });
    expect(screen.ok).toBe(false);
    expect(screen.error.type).toBe("ScopeError");
  });

  it("refuses a seat whose edge keeps terminal.read with threads.read masked off", async () => {
    const threadId = await operatorWrites(TERMINAL_ONLY, "terminal only");
    for (const [op, args] of [
      ["thread.list", { seat: TERMINAL_ONLY }],
      ["thread.show", { seat: TERMINAL_ONLY, threadId }],
    ] as const) {
      const refused = await raw(op, args);
      expect(refused.ok, op).toBe(false);
      expect(refused.error.type, op).toBe("ScopeError");
    }
  });

  it("refuses a target that is not a seat, even one in the caller's reach", async () => {
    for (const [op, args] of [
      ["thread.list", { seat: BOARD }],
      ["thread.show", { seat: BOARD, threadId: "01ARZ3NDEKTSV4RRFFQ69G5FAV" }],
    ] as const) {
      const refused = await raw(op, args);
      expect(refused.ok, op).toBe(false);
      expect(["ScopeError", "UnknownTarget"], op).toContain(refused.error.type);
    }
  });

  it("refuses a seat with no edge on both ops", async () => {
    const threadId = await operatorWrites(STRANGER, "not yours");
    const refused = await raw("thread.show", { seat: STRANGER, threadId });
    expect(refused.ok).toBe(false);
    expect(refused.error.type).toBe("ScopeError");
  });

  it("moves none of the operator's read points in the seat it reads", async () => {
    const threadId = await operatorWrites(PEER, "read me without marking");
    const before = await readPointsOf(PEER);
    expect((await raw("thread.list", { seat: PEER })).ok).toBe(true);
    expect((await raw("thread.show", { seat: PEER, threadId })).ok).toBe(true);
    expect([...(await readPointsOf(PEER))]).toEqual([...before]);
  });
});
