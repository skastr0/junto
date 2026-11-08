/**
 * `callWorkRpc` sends arguments its contract refuses to the core as given,
 * so the seat reads the core's refusal in v1's words, as it does when the
 * native CLI sends the same arguments, never a refusal of the CLI's own.
 */
import { mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MsgList } from "../src/contract/work/msg";
import { WorkSocketLive, callWorkRpc } from "../src/cli/core/socket";
import { MSG_LIST_ARGS_SHAPE, WORK_TOKEN_ENV } from "../src/shared/work-control";
import { publishSeatCredential } from "./helpers/seat-credential";
import { ModelStoresLive, seedCanvas } from "./support/seed-canvas";
import { region, seat as seatNode } from "./support/model-nodes";
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
import { makeTestLog } from "./support/test-log";

const testLog = makeTestLog();

const ME = "agent";

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
  return ManagedRuntime.make(
    Layer.mergeAll(Layer.provideMerge(WorkLive, canvasesLive), PausePlaneAllPlaying, testLog.log.loggerLayer),
  );
};

let root: string;
let runtime: ReturnType<typeof makeRuntime>;
let server: WorkControlServer;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "junto-work-rpc-socket-"));
  const workHome = join(root, "work");
  mkdirSync(workHome, { recursive: true });
  process.env.JUNTO_WORK_HOME = workHome;
  runtime = makeRuntime(root);
  await runtime.runPromise(nameThisMachine);
  await runtime.runPromise(
    seedCanvas("contract", [region("region", { x: -40, y: -40, width: 400, height: 300 }, { label: "Canvas" }), seatNode(ME, { x: 0 })], []),
  );
  server = await startWorkControlServer({
    version: "test",
    workHome,
    home: root,
    run: (effect) => runtime.runPromise(effect),
    authoringGate: createMainAuthoringGate(),
  });
  process.env[WORK_TOKEN_ENV] = publishSeatCredential(server.credentials, { agentKey: `local:${ME}` });
});

afterEach(async () => {
  await server.close();
  await runtime.dispose();
  await rm(root, { recursive: true, force: true });
  delete process.env.JUNTO_WORK_HOME;
  delete process.env[WORK_TOKEN_ENV];
});

describe("callWorkRpc", () => {
  it("sends arguments the contract refuses as given, and answers the core's refusal", async () => {
    // A limit of 0 is outside the contract's 1 to 200, so the CLI cannot encode it.
    const refused = await Effect.runPromise(
      Effect.flip(callWorkRpc(MsgList, { limit: 0 }).pipe(Effect.provide(WorkSocketLive))),
    );
    expect(refused).toMatchObject({
      _tag: "WireError",
      type: "InputError",
      message: MSG_LIST_ARGS_SHAPE,
      details: { path: "args", retryable: false },
    });
  });
});
