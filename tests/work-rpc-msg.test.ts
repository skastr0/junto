/**
 * The msg ops as one contract on both sides of the work socket: the CLI calls
 * them through `callWorkRpc` with the contract's types, and the core answers
 * them from the contract's handlers, over the real socket. Each answer the
 * CLI decodes is the answer the core wrote, and the core refuses what the
 * contract does not name, in v1's words.
 */
import { mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MsgList, MsgRead, MsgReact, MsgReply, MsgSend, MsgSent } from "../src/contract/work/msg";
import { WorkSocketLive, callWorkRpc } from "../src/cli/core/socket";
import { MSG_LIST_ARGS_SHAPE, WORK_TOKEN_ENV, encodeWorkFrame } from "../src/shared/work-control";
import { publishSeatCredential } from "./helpers/seat-credential";
import { ModelStoresLive, seedCanvas } from "./support/seed-canvas";
import { region, seat as seatNode, wire } from "./support/model-nodes";
import { startWorkControlServer, type WorkControlServer } from "../src/core/work/control";
import { WorkLive, WorkService, type WorkServiceShape } from "../src/core/work/service";
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
import { makeTestLog } from "./support/test-log";

const testLog = makeTestLog();

const CANVAS = "contract";
const ME = "agent";
const PEER = "peer";

/** The work store with some of its methods replaced, the rest as the app runs them. */
type WorkOverride = Partial<WorkServiceShape>;

const makeRuntime = (root: string, override: WorkOverride = {}) => {
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
  const tasksLive = Layer.provide(TaskRepositoryLive, RulingRecorderLive);
  const canvasesLive = Layer.provideMerge(Layer.mergeAll(ModelStoresLive, tasksLive), repositoriesLive);
  const workLive = Layer.provideMerge(WorkLive, canvasesLive);
  const overridden = Layer.provideMerge(
    Layer.effect(WorkService, Effect.map(Effect.service(WorkService), (work) => ({ ...work, ...override }))),
    workLive,
  );
  return ManagedRuntime.make(Layer.mergeAll(overridden, PausePlaneAllPlaying, testLog.log.loggerLayer));
};

let root: string;
let runtime: ReturnType<typeof makeRuntime>;
let server: WorkControlServer;
let mine = "";
let peerToken = "";

const startServer = async (workHome: string): Promise<void> => {
  server = await startWorkControlServer({
    version: "test",
    workHome,
    home: root,
    run: (effect) => runtime.runPromise(effect),
    authoringGate: createMainAuthoringGate(),
  });
  mine = publishSeatCredential(server.credentials, { agentKey: `local:${ME}` });
  peerToken = publishSeatCredential(server.credentials, { agentKey: `local:${PEER}` });
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "junto-work-rpc-msg-"));
  const workHome = join(root, "work");
  mkdirSync(workHome, { recursive: true });
  process.env.JUNTO_WORK_HOME = workHome;
  runtime = makeRuntime(root);
  await runtime.runPromise(nameThisMachine);
  await runtime.runPromise(
    seedCanvas(
      CANVAS,
      [region("region", { x: -40, y: -40, width: 900, height: 300 }, { label: "Canvas" }), seatNode(ME, { x: 0 }), seatNode(PEER, { x: 200 })],
      [wire("edge", ME, PEER, "messages"), wire("back", PEER, ME, "messages")],
    ),
  );
  await startServer(workHome);
});

afterEach(async () => {
  await server.close();
  await runtime.dispose();
  await rm(root, { recursive: true, force: true });
  delete process.env.JUNTO_WORK_HOME;
  delete process.env[WORK_TOKEN_ENV];
});

/** A v1 frame as a seat writes it by hand, and the frame the core answers. */
const raw = (token: string, op: string, args: unknown): Promise<any> =>
  new Promise((resolve, reject) => {
    const socket = createConnection({ path: server.socketPath });
    let buffer = "";
    socket.on("connect", () => socket.write(encodeWorkFrame({ token, op, args })));
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      socket.destroy();
      resolve(JSON.parse(buffer.slice(0, newline)));
    });
    socket.on("error", reject);
  });

/** The CLI's typed call, as the seat whose credential is in its environment. */
const cli = <A>(token: string, call: Effect.Effect<A, unknown, never>): Promise<A> => {
  process.env[WORK_TOKEN_ENV] = token;
  return Effect.runPromise(call);
};

describe("the msg contract across the work socket", () => {
  it("answers each op as the contract types it, decoded by the CLI", async () => {
    const sent = await cli(mine, callWorkRpc(MsgSend, { target: PEER, text: "hello" }).pipe(Effect.provide(WorkSocketLive)));
    expect("delivery" in sent && sent.recipient.nodeId).toBe(PEER);
    const messageId = sent.messageId;

    const listed = await cli(peerToken, callWorkRpc(MsgList, { peek: true }).pipe(Effect.provide(WorkSocketLive)));
    // The CLI's decode keeps the answer as the core wrote it.
    expect(listed).toEqual((await raw(peerToken, "msg.list", { peek: true })).data);
    expect("sent" in listed && listed.items.map((item) => item.messageId)).toEqual([messageId]);

    const read = await cli(peerToken, callWorkRpc(MsgRead, { messageId }).pipe(Effect.provide(WorkSocketLive)));
    expect(read.message?.messageId).toBe(messageId);

    const reacted = await cli(peerToken, callWorkRpc(MsgReact, { messageId }).pipe(Effect.provide(WorkSocketLive)));
    expect(reacted.reaction).toBe("ack");

    const replied = await cli(peerToken, callWorkRpc(MsgReply, { target: ME, text: "back", inReplyTo: messageId }).pipe(Effect.provide(WorkSocketLive)));
    expect(replied.inReplyTo).toBe(messageId);
    expect(replied.threadId).toBe(messageId);

    const mySent = await cli(mine, callWorkRpc(MsgSent, {}).pipe(Effect.provide(WorkSocketLive)));
    expect(mySent.items.map((item) => [item.messageId, item.to.nodeId])).toEqual([[messageId, PEER]]);
  });

  it("refuses an argument the contract does not name", async () => {
    const refused = await raw(mine, "msg.send", { target: PEER, text: "hello", role: "user" });
    expect(refused.ok).toBe(false);
    expect(refused.error.type).toBe("InputError");
    expect(refused.error.details).toMatchObject({ path: "args", retryable: false });
  });

  it("answers a handler that dies after admission as a defect, not as a refusal of its arguments", async () => {
    // The same canvas, served again by a core whose mail store dies on a read.
    await server.close();
    await runtime.dispose();
    runtime = makeRuntime(root, { readMailMessage: () => Effect.die(new Error("the mail store died")) });
    await startServer(join(root, "work"));
    const answered = await raw(peerToken, "msg.read", { messageId: "01JB2C3D4E5F6G7H8J9K0M1N2Q" });
    expect(answered.ok).toBe(false);
    expect(answered.error).toMatchObject({ type: "InternalError", message: expect.stringContaining("the mail store died") });
  });

  it("refuses msg list's arguments in its own words, never quoting them", async () => {
    const refused = await raw(mine, "msg.list", { limit: "secret words" });
    expect(refused.error).toEqual({ type: "InputError", message: MSG_LIST_ARGS_SHAPE, details: { path: "args", retryable: false } });
  });
});
