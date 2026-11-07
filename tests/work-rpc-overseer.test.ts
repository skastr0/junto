/**
 * The overseer ops as one contract on both sides of the work socket: the CLI
 * calls them through `callWorkRpc` with the contract's types, and the core
 * answers them from the contract's handlers, over the real socket. Admission
 * stays the work server's (an overseer seat, the native Overseer seat), the
 * refusals keep v1's words, and an answer the contract does not describe is
 * never written.
 */
import { mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime, Result } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Overseer, OverseerLive } from "../src/contract/work/overseer";
import { WorkSocketLive, callWorkRpc } from "../src/cli/core/socket";
import { WORK_TOKEN_ENV, encodeWorkFrame } from "../src/shared/work-control";
import { LIVE_OVERSEER_ENABLED } from "../src/shared/features";
import { decodeOverseerArgs, decodeOverseerRequest, type OverseerResult } from "../src/shared/overseer-control";
import { decodeOverseerHostRequest } from "../src/shared/overseer-host-control";
import { publishSeatCredential } from "./helpers/seat-credential";
import { ModelStoresLive, seedCanvas } from "./support/seed-canvas";
import { region, seat as seatNode, wire } from "./support/model-nodes";
import { startWorkControlServer, type WorkControlServer, type WorkControlServerOptions } from "../src/core/work/control";
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
import { makeTestLog } from "./support/test-log";

const testLog = makeTestLog();

const CANVAS = "contract";
/** A human-enabled overseer seat. */
const OVERSEER = "overseer";
/** An ordinary seat. */
const SEAT = "seat";
/** The native Overseer seat. */
const NATIVE = "native";

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
  const tasksLive = Layer.provide(TaskRepositoryLive, RulingRecorderLive);
  const canvasesLive = Layer.provideMerge(Layer.mergeAll(ModelStoresLive, tasksLive), repositoriesLive);
  const workLive = Layer.provideMerge(WorkLive, canvasesLive);
  return ManagedRuntime.make(Layer.mergeAll(workLive, PausePlaneAllPlaying, testLog.log.loggerLayer));
};

type Executors = Pick<WorkControlServerOptions, "onOverseer" | "onOverseerLive" | "validateOverseerLive">;

let root: string;
let runtime: ReturnType<typeof makeRuntime>;
let server: WorkControlServer;
const tokens: Record<string, string> = {};

const startServer = async (executors: Executors): Promise<void> => {
  server = await startWorkControlServer({
    version: "test",
    workHome: join(root, "work"),
    home: root,
    run: (effect) => runtime.runPromise(effect),
    authoringGate: createMainAuthoringGate(),
    ...executors,
  });
  for (const id of [OVERSEER, SEAT, NATIVE]) tokens[id] = publishSeatCredential(server.credentials, { agentKey: `local:${id}` });
};

/** Serves the canvas again with these executors. */
const serveWith = async (executors: Executors): Promise<void> => {
  await server.close();
  await startServer(executors);
};

const status: OverseerResult = { ok: true, operation: "status", data: { up: true } };
const execute = vi.fn<NonNullable<WorkControlServerOptions["onOverseer"]>>();

beforeEach(async () => {
  execute.mockReset();
  execute.mockImplementation(async (request) => (request.operation === "status" ? status : { ok: true, operation: request.operation, data: {} }));
  root = await mkdtemp(join(tmpdir(), "junto-work-rpc-overseer-"));
  mkdirSync(join(root, "work"), { recursive: true });
  process.env.JUNTO_WORK_HOME = join(root, "work");
  runtime = makeRuntime(root);
  await runtime.runPromise(nameThisMachine);
  await runtime.runPromise(
    seedCanvas(
      CANVAS,
      [
        region("region", { x: -40, y: -40, width: 900, height: 300 }, { label: "Canvas" }),
        seatNode(OVERSEER, { x: 0, overseer: true }),
        seatNode(SEAT, { x: 200 }),
        seatNode(NATIVE, { x: 400, harness: "junto-overseer", overseer: true }),
      ],
      [wire("edge", SEAT, OVERSEER, "messages")],
    ),
  );
  await startServer({ onOverseer: execute });
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
const cli = <A, E>(token: string, call: Effect.Effect<A, E, never>): Promise<Result.Result<A, E>> => {
  process.env[WORK_TOKEN_ENV] = token;
  return Effect.runPromise(Effect.result(call));
};

describe("the overseer contract across the work socket", () => {
  it("answers an overseer seat's command as the contract types it, decoded by the CLI", async () => {
    const answered = await cli(tokens[OVERSEER]!, callWorkRpc(Overseer, { operation: "status" }).pipe(Effect.provide(WorkSocketLive)));
    expect(answered).toEqual(Result.succeed(status));
    // The CLI's decode keeps the answer as the core wrote it.
    expect((await raw(tokens[OVERSEER]!, "overseer", { operation: "status" })).data).toEqual(status);
    expect(execute.mock.calls[0]?.[0]).toEqual({ operation: "status" });
    expect(execute.mock.calls[0]?.[1]).toEqual({ canvasName: CANVAS, nodeId: OVERSEER });
  });

  it("refuses a seat that is not an overseer before it reads the request", async () => {
    for (const args of [{ operation: "status" }, { operation: "status", extra: true }, { operation: 42 }]) {
      const refused = await raw(tokens[SEAT]!, "overseer", args);
      expect(refused.error).toEqual({
        type: "ScopeError",
        message: "only a human-enabled overseer seat may administer the canvas",
        details: { retryable: false, caller: SEAT },
      });
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it("refuses an envelope in the schema's own words, as v1 did", async () => {
    const envelope = { operation: "status", extra: true };
    const refused = await raw(tokens[OVERSEER]!, "overseer", envelope);
    const v1 = decodeOverseerRequest(envelope);
    if (Result.isSuccess(v1)) throw new Error("the envelope decoded");
    expect(refused.error).toEqual({ type: "InputError", message: v1.failure.message, details: { retryable: false } });
    expect(execute).not.toHaveBeenCalled();
  });

  it("refuses a command's arguments in their schema's words, as v1 did", async () => {
    const args = { nodeId: OVERSEER, x: 2, y: 3, overseer: true };
    const refused = await raw(tokens[OVERSEER]!, "overseer", { operation: "node.move", args });
    const v1 = decodeOverseerArgs("node.move", args);
    if (Result.isSuccess(v1)) throw new Error("the arguments decoded");
    expect(refused.error).toEqual({ type: "InputError", message: v1.failure.message, details: { retryable: false } });
    expect(execute).not.toHaveBeenCalled();
  });

  it("answers a command's own failure as its answer, and the CLI reads it as the command's", async () => {
    execute.mockImplementation(async (request) => ({ ok: false, operation: request.operation, error: { type: "NotFound", message: "no such node" } }));
    const answered = await cli(tokens[OVERSEER]!, callWorkRpc(Overseer, { operation: "node.get", args: { nodeId: "gone" } }).pipe(Effect.provide(WorkSocketLive)));
    expect(answered).toEqual(Result.succeed({ ok: false, operation: "node.get", error: { type: "NotFound", message: "no such node" } }));
  });

  it("never writes an answer the contract does not describe", async () => {
    execute.mockImplementation(async (request) => ({ ok: true, operation: request.operation, data: {}, extra: true }) as OverseerResult);
    const answered = await raw(tokens[OVERSEER]!, "overseer", { operation: "status" });
    expect(answered.ok).toBe(false);
    expect(answered.error.type).toBe("InternalError");
  });

  it("answers what v1 wrote: a key holding undefined left out, a date as its string", async () => {
    const at = new Date("2026-11-07T12:00:00.000Z");
    execute.mockImplementation(async (request) => ({ ok: true, operation: request.operation, data: { harness: "codex", model: undefined, at } }));
    const answered = await raw(tokens[OVERSEER]!, "overseer", { operation: "agent.get", args: { nodeId: SEAT } });
    expect(answered.data).toEqual({ ok: true, operation: "agent.get", data: { harness: "codex", at: at.toISOString() } });
  });

  it("refuses the request byte limit before it reads the request", async () => {
    const refused = await raw(tokens[OVERSEER]!, "overseer", { operation: "status", args: { pad: "x".repeat(1024 * 1024) } });
    expect(refused.error).toEqual({ type: "InputError", message: "overseer request exceeds the request byte limit", details: { retryable: false } });
    expect(execute).not.toHaveBeenCalled();
  });

  it("answers RuntimeDown in v1's words when main gave no executor", async () => {
    await serveWith({});
    const refused = await raw(tokens[OVERSEER]!, "overseer", { operation: "status" });
    expect(refused.error).toEqual({ type: "RuntimeDown", message: "overseer administration is unavailable in this runtime", details: { retryable: false } });
  });

  it.runIf(!LIVE_OVERSEER_ENABLED)("refuses the Live protocol while disabled", async () => {
    const refused = await raw(tokens[NATIVE]!, "overseer.live", { type: "next" });
    expect(refused.error).toEqual({ type: "ScopeError", message: "Live conversation is disabled in this Junto build" });
  });

  it.runIf(LIVE_OVERSEER_ENABLED)("answers the native seat's Live protocol through the contract, and refuses any other seat before it reads the request", async () => {
    const bridge = vi.fn<NonNullable<WorkControlServerOptions["onOverseerLive"]>>(async () => ({ type: "idle" }));
    await serveWith({ onOverseer: execute, onOverseerLive: bridge });
    const answered = await cli(tokens[NATIVE]!, callWorkRpc(OverseerLive, { type: "next" }).pipe(Effect.provide(WorkSocketLive)));
    expect(answered).toEqual(Result.succeed({ type: "idle" }));
    expect(bridge.mock.calls[0]?.[0]).toEqual({ type: "next" });
    expect(bridge.mock.calls[0]?.[1]).toMatchObject({ canvasName: CANVAS, nodeId: NATIVE, bindingId: `binding-${NATIVE}` });

    for (const args of [{ type: "next" }, { type: "nonsense" }]) {
      expect((await raw(tokens[OVERSEER]!, "overseer.live", args)).error).toEqual({
        type: "AuthError", message: "the Live controller protocol belongs to the native Overseer seat",
      });
    }

    const request = { type: "next", extra: true };
    const v1 = decodeOverseerHostRequest(request);
    if (Result.isSuccess(v1)) throw new Error("the request decoded");
    expect((await raw(tokens[NATIVE]!, "overseer.live", request)).error).toEqual({ type: "InputError", message: v1.failure.message });
    expect(bridge).toHaveBeenCalledTimes(1);
  });
});
