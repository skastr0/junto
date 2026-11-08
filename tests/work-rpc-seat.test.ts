/**
 * The seat.* and preamble ops as one contract on both sides of the work
 * socket: the CLI calls them through `callWorkRpc` with the contract's types,
 * and the core answers them from the contract's handlers, over the real
 * socket. Each answer the CLI decodes is the answer the core wrote, and the
 * core refuses what the contract does not name, in v1's words.
 */
import { mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime, Result, Schema } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Preamble, SeatRead, SeatWait } from "../src/contract/work/seat";
import { SeatReadArgs, SeatWaitArgs } from "../src/shared/seat-control";
import { WorkSocketLive, callWorkRpc } from "../src/cli/core/socket";
import { PreambleArgs, WORK_TOKEN_ENV, encodeWorkFrame } from "../src/shared/work-control";
import { PREAMBLE_MAX_TEXT_LENGTH, PREAMBLE_TTL_MS, type PreambleEvent } from "../src/shared/preamble";
import { liveSeatPreamble } from "../src/core/work/seat-preambles";
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
let preambles: PreambleEvent[] = [];

const startServer = async (workHome: string): Promise<void> => {
  server = await startWorkControlServer({
    version: "test",
    workHome,
    home: root,
    run: (effect) => runtime.runPromise(effect),
    authoringGate: createMainAuthoringGate(),
    onPreamble: (event) => preambles.push(event),
  });
  mine = publishSeatCredential(server.credentials, { agentKey: `local:${ME}` });
};

beforeEach(async () => {
  preambles = [];
  root = await mkdtemp(join(tmpdir(), "junto-work-rpc-seat-"));
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

/** The words v1 refused an argument with: the schema's own, as the if chain decoded it. */
const v1Refusal = <S extends Schema.Top>(schema: S, args: unknown) => {
  const decoded = Schema.decodeUnknownResult(schema as never, { onExcessProperty: "error" })(args);
  if (Result.isSuccess(decoded)) throw new Error("expected a refusal");
  return {
    type: "InputError",
    message: decoded.failure.message,
    details: { path: "args", hint: "pass a JSON object matching the command schema", retryable: false },
  };
};

describe("the preamble contract across the work socket", () => {
  it("answers as the contract types it, decoded by the CLI, and the canvas is told", async () => {
    const before = Date.now();
    const shown = await cli(mine, callWorkRpc(Preamble, { text: "  reading   the  seat ops " }).pipe(Effect.provide(WorkSocketLive)));
    expect(shown).toMatchObject({ canvasName: CANVAS, nodeId: ME, text: "reading the seat ops", disposition: "applied" });
    expect(Object.keys(shown)).toEqual(["preambleId", "canvasName", "nodeId", "text", "expiresAt", "disposition"]);
    expect(shown.expiresAt).toBeGreaterThanOrEqual(before + PREAMBLE_TTL_MS);
    // The seat's read shows it, and the canvas is handed the event.
    expect(liveSeatPreamble(CANVAS, ME)).toEqual({ text: shown.text, expiresAt: shown.expiresAt });
    const { disposition: _, ...event } = shown;
    expect(preambles).toEqual([event]);

    const answered = await raw(mine, "preamble", { text: "again" });
    expect(answered.ok).toBe(true);
    expect(Object.keys(answered.data)).toEqual(["preambleId", "canvasName", "nodeId", "text", "expiresAt", "disposition"]);
  });

  it("refuses an empty or a long text in v1's words", async () => {
    expect((await raw(mine, "preamble", { text: " \n\t " })).error).toEqual({
      type: "InputError",
      message: "text must be non-empty",
      details: { path: "args.text", retryable: false },
    });
    expect((await raw(mine, "preamble", { text: "x".repeat(PREAMBLE_MAX_TEXT_LENGTH + 1) })).error).toEqual({
      type: "InputError",
      message: `text must be at most ${PREAMBLE_MAX_TEXT_LENGTH} characters`,
      details: { path: "args.text", retryable: false },
    });
    expect(preambles).toEqual([]);
  });

  it("refuses arguments the contract does not name, in the schema's words as before", async () => {
    for (const args of [{ text: "hi", tone: "amber" }, { text: 7 }, {}]) {
      expect((await raw(mine, "preamble", args)).error).toEqual(v1Refusal(PreambleArgs, args));
    }
    expect(preambles).toEqual([]);
  });
});

describe("the seat contract across the work socket", () => {
  it("answers seat read on every peer as the contract types it, decoded by the CLI", async () => {
    const brief = await cli(mine, callWorkRpc(SeatRead, { brief: true }).pipe(Effect.provide(WorkSocketLive)));
    expect(brief).toEqual((await raw(mine, "seat.read", { brief: true })).data);
    expect("peers" in brief && brief.peers.map((peer) => peer.target)).toEqual([PEER]);
  });

  it("answers seat read and seat wait on one seat as the core wrote them", async () => {
    // A seat with no terminal: whatever the core answers, the CLI reads the same.
    for (const [op, rpc, args] of [
      ["seat.read", SeatRead, { target: PEER, lines: 5 }],
      ["seat.wait", SeatWait, { target: PEER, until: "working", timeoutMs: 50 }],
    ] as const) {
      const answered = await raw(mine, op, args);
      if (answered.ok) {
        const decoded = await cli(mine, callWorkRpc(rpc as typeof SeatRead, args as never).pipe(Effect.provide(WorkSocketLive)));
        expect(decoded).toEqual(answered.data);
      } else {
        expect(answered.error.type).not.toBe("InputError");
      }
    }
  });

  it("refuses arguments the contract does not name, in the schema's words as before", async () => {
    for (const args of [{}, { target: PEER, any: true, until: "idle" }, { target: PEER, until: "idle", tone: 1 }, { any: true, until: "soon" }]) {
      expect((await raw(mine, "seat.wait", args)).error).toEqual(v1Refusal(SeatWaitArgs, args));
    }
    for (const args of [{}, { brief: true, lines: 3 }, { target: PEER, since: 2 }, { target: PEER, lines: 0 }]) {
      expect((await raw(mine, "seat.read", args)).error).toEqual(v1Refusal(SeatReadArgs, args));
    }
  });
});
