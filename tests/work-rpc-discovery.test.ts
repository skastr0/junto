/**
 * The discovery ops as one contract on both sides of the work socket: the
 * CLI calls them through `callWorkRpc` with the contract's types, and the
 * core answers them from the contract's handlers, over the real socket. Each
 * answer the CLI decodes is the answer the core wrote, and the core refuses
 * what the contract does not name, in v1's words.
 */
import { mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Capabilities, EnvReport, LogsRead, OpList, OpShow, Onboard, SignalClear, SignalList, SignalRaise, Since } from "../src/contract/work/discovery";
import { WorkSocketLive, callWorkRpc } from "../src/cli/core/socket";
import { WORK_TOKEN_ENV, encodeWorkFrame } from "../src/shared/work-control";
import { publishSeatCredential } from "./helpers/seat-credential";
import { ModelStoresLive, seedCanvas } from "./support/seed-canvas";
import { region, seat as seatNode, wire } from "./support/model-nodes";
import { startWorkControlServer, type WorkControlServer } from "../src/core/work/control";
import { WorkLive } from "../src/core/work/service";
import { CrewRepositoryLive } from "../src/core/work/crew-repository";
import { makeContentServiceLive } from "../src/core/content/service";
import { WorkRepositoryLive } from "../src/core/work/repository";
import { OpRepositoryLive } from "../src/core/work/op-repository";
import { AgentSignalRepositoryLive } from "../src/core/signals/repository";
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

const CANVAS = "discovery";
const ME = "agent";
const PEER = "peer";

const makeRuntime = (root: string) => {
  const repositoriesLive = Layer.provideMerge(
    Layer.mergeAll(
      WorkRepositoryLive,
      CrewRepositoryLive,
      MachineRepositoryLive,
      SettingsLive,
      OpRepositoryLive,
      AgentSignalRepositoryLive,
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
  return ManagedRuntime.make(Layer.mergeAll(workLive, PausePlaneAllPlaying, testLog.log.loggerLayer));
};

let root: string;
let runtime: ReturnType<typeof makeRuntime>;
let server: WorkControlServer;
let mine = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "junto-work-rpc-discovery-"));
  const workHome = join(root, "work");
  mkdirSync(workHome, { recursive: true });
  process.env.JUNTO_WORK_HOME = workHome;
  // The machine log is read under this home: none written yet.
  process.env.JUNTO_HOME = root;
  runtime = makeRuntime(root);
  await runtime.runPromise(nameThisMachine);
  await runtime.runPromise(
    seedCanvas(
      CANVAS,
      [region("region", { x: -40, y: -40, width: 900, height: 300 }, { label: "Canvas" }), seatNode(ME, { x: 0 }), seatNode(PEER, { x: 200 })],
      [wire("edge", ME, PEER, "messages")],
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
  delete process.env.JUNTO_HOME;
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

describe("the discovery contract across the work socket", () => {
  it("raises, lists and clears this seat's signals as the contract types them", async () => {
    const raised = await cli(mine, callWorkRpc(SignalRaise, { kind: "feedback", text: "the report is ready" }).pipe(Effect.provide(WorkSocketLive)));
    expect(raised.signal).toMatchObject({ kind: "feedback", text: "the report is ready", nodeId: ME, state: "open" });
    expect(raised.next_step).toContain("junto signal clear");

    const listed = await cli(mine, callWorkRpc(SignalList, {}).pipe(Effect.provide(WorkSocketLive)));
    // The CLI's decode keeps the answer as the core wrote it.
    expect(listed).toEqual((await raw(mine, "signal.list", {})).data);
    expect(listed.open).toBe(1);
    expect(listed.signals.map((signal) => signal.signalId)).toEqual([raised.signal.signalId]);

    const cleared = await cli(mine, callWorkRpc(SignalClear, { signalId: raised.signal.signalId }).pipe(Effect.provide(WorkSocketLive)));
    expect(cleared.signals.map((signal) => [signal.signalId, signal.state])).toEqual([[raised.signal.signalId, "withdrawn"]]);
  });

  it("refuses a raise in its own words once its arguments decode", async () => {
    const refused = await raw(mine, "signal.raise", { kind: "feedback", text: "   " });
    expect(refused.error).toMatchObject({ type: "InputError", details: { path: "args.text", retryable: false } });
  });

  it("answers op list and op show as the contract types them", async () => {
    const listed = await cli(mine, callWorkRpc(OpList, {}).pipe(Effect.provide(WorkSocketLive)));
    expect(listed).toEqual((await raw(mine, "op.list", {})).data);
    expect(listed.ops).toEqual([]);

    const unknown = await raw(mine, "op.show", { opId: "01JB2C3D4E5F6G7H8J9K0M1N2Q" });
    expect(unknown.ok).toBe(false);
    expect(unknown.error.type).toBe("UnknownTarget");
    await expect(cli(mine, callWorkRpc(OpShow, { opId: "01JB2C3D4E5F6G7H8J9K0M1N2Q" as never }).pipe(Effect.provide(WorkSocketLive)))).rejects.toThrow();
  });

  it("reads this machine's log and this seat's environment through the contract", async () => {
    const log = await cli(mine, callWorkRpc(LogsRead, {}).pipe(Effect.provide(WorkSocketLive)));
    expect(log).toEqual((await raw(mine, "logs.read", {})).data);
    expect(log.rows).toEqual([]);

    const env = await raw(mine, "env.report", {});
    if (env.ok) {
      expect(await cli(mine, callWorkRpc(EnvReport, {}).pipe(Effect.provide(WorkSocketLive)))).toEqual(env.data);
    } else {
      expect(env.error).toEqual({ type: "RuntimeDown", message: "this seat's region environment could not be read", details: { retryable: true } });
    }
  });

  it("answers since as the contract types it, capped or whole", async () => {
    const since = await cli(mine, callWorkRpc(Since, {}).pipe(Effect.provide(WorkSocketLive)));
    // Each read is as of its own moment; the rest is the answer the core wrote.
    const { as_of: _asOf, ...written } = (await raw(mine, "since", {})).data;
    expect({ ...since, as_of: undefined }).toEqual({ ...written, as_of: undefined });
    expect(since.unread).toBe(0);
    const all = await cli(mine, callWorkRpc(Since, { all: true }).pipe(Effect.provide(WorkSocketLive)));
    expect(all.unread).toBe(0);
  });

  it("answers capabilities and onboard as the contract types them", async () => {
    const capabilities = await cli(mine, callWorkRpc(Capabilities, {}).pipe(Effect.provide(WorkSocketLive)));
    expect(capabilities).toEqual((await raw(mine, "capabilities", {})).data);
    expect(capabilities.node.id).toBe(ME);
    expect(capabilities.connected.map((peer) => peer.id)).toEqual([PEER]);
    expect(capabilities.connected[0]?.grants).toContain("msg.send");

    const onboard = await cli(mine, callWorkRpc(Onboard, {}).pipe(Effect.provide(WorkSocketLive)));
    const { since: _since, ...written } = (await raw(mine, "onboard", {})).data;
    const { since, ...decoded } = onboard;
    expect(decoded).toEqual(written);
    expect(onboard.node.id).toBe(ME);
    expect("unread" in since && since.unread).toBe(0);
  });

  it("refuses onboard's arguments in onboard's own words", async () => {
    const refused = await raw(mine, "onboard", { seat: PEER });
    expect(refused.error).toEqual({
      type: "InputError",
      message: "onboard takes no arguments: a seat onboards itself",
      details: { path: "args", retryable: false, hint: "junto schema show onboard" },
    });
  });

  it("refuses offboard notes that say nothing, in offboard's own words", async () => {
    const refused = await raw(mine, "offboard", { notes: "   " });
    expect(refused.error).toMatchObject({ type: "InputError", message: "notes must say what happened in this session", details: { path: "args.notes" } });
    const extra = await raw(mine, "offboard", { notes: "done", gist: "done" });
    expect(extra.error).toMatchObject({ type: "InputError", details: { path: "args", retryable: false } });
  });

  it("refuses op show's arguments in the schema's words, with its own hint", async () => {
    const refused = await raw(mine, "op.show", { opId: 7 });
    expect(refused.error).toMatchObject({
      type: "InputError",
      details: { path: "args", hint: "junto schema show shows this command's input", retryable: false },
    });
  });

  // capabilities and env.report take an empty struct, which admits any object, as v1's decode did.
  it("refuses an argument the contract does not name", async () => {
    for (const [op, args] of [["signal.list", { all: true }], ["since", { peek: true }], ["signal.clear", { id: "x" }], ["op.list", { page: 2 }]] as const) {
      const refused = await raw(mine, op, args);
      expect(refused.ok, op).toBe(false);
      expect(refused.error, op).toMatchObject({ type: "InputError" });
      expect(refused.error.details).toMatchObject({ path: "args", retryable: false });
    }
  });
});
