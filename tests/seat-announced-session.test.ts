/**
 * An id a seat announced but the capture path refused is never offered as
 * that seat's session. A Hermes seat's screen is read for its id, and its
 * tool output names other sessions (`junto onboard` lists the seat's past
 * ones). If such an id were offered to a first-turn `junto offboard`, the
 * notes and record would be saved under a session that is not the seat's.
 */
import { mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodeWorkFrame } from "../src/shared/work-control";
import { publishSeatCredential } from "./helpers/seat-credential";
import { ModelStoresLive, seedCanvas } from "./support/seed-canvas";
import { seat } from "./support/model-nodes";
import { startWorkControlServer, type WorkControlServer } from "../src/main/junto/work/control";
import { WorkLive } from "../src/main/junto/work/service";
import { CrewRepositoryLive } from "../src/main/junto/work/crew-repository";
import { makeContentServiceLive } from "../src/main/junto/content/service";
import { WorkRepositoryLive } from "../src/main/junto/work/repository";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { makeInstallOpsLive } from "../src/main/junto/install-ops/engine";
import { MachineRepository, makeMachineRepositoryLive } from "../src/main/junto/machines/repository";
import { SettingsLive } from "../src/main/junto/settings/service";
import { PausePlaneAllPlaying } from "../src/main/junto/pause-plane";
import { createMainAuthoringGate } from "../src/main/junto/main-authoring-gate";
import { makeSeatSessionRepositoryLive, SeatSessionRepository } from "../src/main/junto/seat-sessions/repository";
import { __setSessionExistenceHomeForTest } from "../src/main/junto/term/session-existence";
import {
  getCapturedSessionId,
  offeredCapturedSessionId,
  recordCapturedSessionId,
  refuseCapturedSessionId,
  resetSessionIdStoreForTest,
} from "../src/main/junto/term/session-id-store";
import {
  __setCapturedSessionWriterForTest,
  resetCapturedSessionPersistForTest,
  scheduleCapturedSessionPersist,
} from "../src/main/junto/term/session-capture-persist";

const CANVAS = "announced";
/** Hermes session ids, each proven by the harness's own store. */
const PAST = "20261009_055214_01a119";
const OTHERS = "20261009_060000_0b0b0b";
const NOW = "20261018_150000_c0c0c0";

const makeRuntime = (root: string) => {
  const repositoriesLive = Layer.provideMerge(
    Layer.mergeAll(
      WorkRepositoryLive,
      CrewRepositoryLive,
      makeSeatSessionRepositoryLive(join(root, "seats")),
      makeMachineRepositoryLive({ defaultName: () => "workbench" }),
      SettingsLive,
      makeContentServiceLive({ root: join(root, "content"), skipInlineMediaMigration: true }),
    ),
    Layer.mergeAll(
      makeStateEngineLive(join(root, "state", "junto.db")),
      makeInstallOpsLive(join(root, "state", "install-ops.db")),
    ),
  );
  const workLive = Layer.provideMerge(WorkLive, Layer.provideMerge(ModelStoresLive, repositoriesLive));
  return ManagedRuntime.make(Layer.mergeAll(workLive, PausePlaneAllPlaying));
};

const hermes = (id: string, x: number) =>
  seat(id, { x, host: "workbench", harness: "hermes", bindingId: `bind-${id}` as never, launch: { kind: "harness", argv: ["hermes"] } });

let root: string;
let runtime: ReturnType<typeof makeRuntime>;
let server: WorkControlServer;
let credential = "";

beforeEach(async () => {
  resetSessionIdStoreForTest();
  root = await mkdtemp(join(tmpdir(), "junto-announced-"));
  const home = join(root, "home");
  mkdirSync(join(home, ".hermes"), { recursive: true });
  const db = new DatabaseSync(join(home, ".hermes", "state.db"));
  db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY);");
  for (const id of [PAST, OTHERS, NOW]) db.prepare("INSERT INTO sessions (id) VALUES (?)").run(id);
  db.close();
  __setSessionExistenceHomeForTest(home);
  const workHome = join(root, "work");
  mkdirSync(workHome, { recursive: true });
  process.env.JUNTO_WORK_HOME = workHome;
  runtime = makeRuntime(root);
  await runtime.runPromise(Effect.flatMap(MachineRepository, (machine) => machine.configureName("workbench")));
  await runtime.runPromise(seedCanvas(CANVAS, [hermes("agent", 0), hermes("other", 200)]));
  // The agent seat offboarded PAST; the other seat runs OTHERS.
  await runtime.runPromise(
    Effect.flatMap(SeatSessionRepository, (sessions) =>
      Effect.gen(function* () {
        yield* sessions.record({ seatId: "agent", bindingId: "bind-agent", sessionId: PAST, harness: "hermes" });
        yield* sessions.end("agent", "offboard", PAST);
        yield* sessions.record({ seatId: "other", bindingId: "bind-other", sessionId: OTHERS, harness: "hermes" });
      }),
    ),
  );
  server = await startWorkControlServer({
    version: "test",
    workHome,
    home: root,
    run: (effect) => runtime.runPromise(effect),
    authoringGate: createMainAuthoringGate(),
  });
  credential = publishSeatCredential(server.credentials, { agentKey: "local:agent" });
});

afterEach(async () => {
  __setSessionExistenceHomeForTest(undefined);
  __setCapturedSessionWriterForTest(undefined);
  resetCapturedSessionPersistForTest();
  resetSessionIdStoreForTest();
  await server.close();
  await runtime.dispose();
  await rm(root, { recursive: true, force: true });
  delete process.env.JUNTO_WORK_HOME;
});

const offboard = (): Promise<any> =>
  new Promise((resolve, reject) => {
    const socket = createConnection({ path: server.socketPath });
    let buffer = "";
    socket.on("connect", () => socket.write(encodeWorkFrame({ token: credential, op: "offboard", args: { notes: "# Stop\n\n- first turn" } })));
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      socket.destroy();
      resolve(JSON.parse(buffer.slice(0, newline)));
    });
    socket.on("error", reject);
  });

const history = (seatId: string) =>
  runtime.runPromise(Effect.flatMap(SeatSessionRepository, (sessions) => sessions.list(seatId)));

const NOT_KNOWN = { ok: false, error: { type: "InvalidTransition", message: "Junto does not know this session's id yet" } };

describe("a first-turn junto offboard on an announced id", () => {
  it("never saves under a session this seat ended, though its screen named it", async () => {
    recordCapturedSessionId("bind-agent", PAST);
    expect(await offboard()).toMatchObject(NOT_KNOWN);
    expect((await history("agent")).map((session) => [session.sessionId, session.endedAt !== undefined])).toEqual([[PAST, true]]);
  });

  it("never saves under another seat's session", async () => {
    recordCapturedSessionId("bind-agent", OTHERS);
    expect(await offboard()).toMatchObject(NOT_KNOWN);
    expect((await history("agent")).map((session) => session.sessionId)).toEqual([PAST]);
  });

  it("never offers a candidate the capture path refused", async () => {
    recordCapturedSessionId("bind-agent", NOW);
    refuseCapturedSessionId("bind-agent", NOW);
    expect(await offboard()).toMatchObject(NOT_KNOWN);
  });

  it("offers the seat's own proven session as before", async () => {
    recordCapturedSessionId("bind-agent", NOW);
    const result = await offboard();
    expect(result).toMatchObject({ ok: true, data: { session_id: NOW } });
  });
});

describe("the proof ladder for a screen candidate", () => {
  const input = { canvasName: CANVAS, nodeId: "agent", bindingId: "bind-agent", harness: "hermes", sessionId: NOW };

  it("marks a candidate the store would not take as refused, and keeps it so the screen is not read again", async () => {
    __setCapturedSessionWriterForTest(async () => {
      throw new Error("capture cannot reopen a session this seat ended");
    });
    recordCapturedSessionId("bind-agent", NOW);
    expect(await scheduleCapturedSessionPersist("bind-agent@1", input, [0])).toBe("failed");
    expect(offeredCapturedSessionId("bind-agent")).toBeUndefined();
    expect(getCapturedSessionId("bind-agent")).toBe(NOW);
  });

  it("leaves a stored candidate offered", async () => {
    __setCapturedSessionWriterForTest(async () => "written");
    recordCapturedSessionId("bind-agent", NOW);
    expect(await scheduleCapturedSessionPersist("bind-agent@1", input, [0])).toBe("written");
    expect(offeredCapturedSessionId("bind-agent")).toBe(NOW);
  });

  it("a refusal of one candidate does not refuse the next", () => {
    recordCapturedSessionId("bind-agent", PAST);
    refuseCapturedSessionId("bind-agent", PAST);
    recordCapturedSessionId("bind-agent", NOW);
    expect(offeredCapturedSessionId("bind-agent")).toBe(NOW);
  });
});
