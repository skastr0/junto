/**
 * Race C as a seat reads it: the seat withdrew its signal, then the
 * operator's answer to it arrived. The answer is held from the seat, never
 * typed, and stays readable in its thread: `junto thread show` marks it in
 * the fixed words ANSWER_HELD_WORDS, over the real work socket. An answer to a signal still open is ordinary mail.
 */
import { mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime } from "effect";
import { ulid } from "ulid";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ThreadShow } from "../src/contract/work/thread";
import { callWorkRpc } from "./support/work-rpc";
import { WORK_TOKEN_ENV } from "../src/shared/work-control";
import { ANSWER_HELD_WORDS } from "../src/shared/signal-answer-held";
import { mailExtensionMetadata } from "../src/shared/crew";
import { makeUserMessage } from "../src/shared/task";
import { operatorActorRef } from "../src/shared/work-reference";
import { publishSeatCredential } from "./helpers/seat-credential";
import { ModelStoresLive, seedCanvas } from "./support/seed-canvas";
import { region, seat } from "./support/model-nodes";
import { startWorkControlServer, type WorkControlServer } from "../src/core/work/control";
import { WorkLive, WorkService } from "../src/core/work/service";
import { CrewRepositoryLive } from "../src/core/work/crew-repository";
import { makeContentServiceLive } from "../src/core/content/service";
import { WorkRepositoryLive } from "../src/core/work/repository";
import { makeStateEngineLive } from "../src/core/state/engine";
import { makeInstallOpsLive } from "../src/core/install-ops/engine";
import { MachineRepositoryLive } from "../src/core/machines/repository";
import { SettingsLive } from "../src/core/settings/service";
import { AgentSignalRepository, AgentSignalRepositoryLive } from "../src/core/signals/repository";
import { nameThisMachine } from "./support/name-this-machine";
import { PausePlaneAllPlaying } from "../src/core/pause-plane";
import { createMainAuthoringGate } from "../src/node/main-authoring-gate";
import { RulingRecorderLive } from "../src/core/work/ruling-recorder";
import { TaskRepositoryLive } from "../src/core/work/task-repository";
import { makeTestLog } from "./support/test-log";

const testLog = makeTestLog();

const CANVAS = "held";
const ME = "agent";

const makeRuntime = (root: string) => {
  const repositoriesLive = Layer.provideMerge(
    Layer.mergeAll(
      WorkRepositoryLive,
      CrewRepositoryLive,
      MachineRepositoryLive,
      SettingsLive,
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
  return ManagedRuntime.make(Layer.mergeAll(Layer.provideMerge(WorkLive, canvasesLive), PausePlaneAllPlaying, testLog.log.loggerLayer));
};

let root: string;
let runtime: ReturnType<typeof makeRuntime>;
let server: WorkControlServer;
let mine = "";

const run = <A, E>(effect: Effect.Effect<A, E, AgentSignalRepository | WorkService>) =>
  runtime.runPromise(effect as Effect.Effect<A, E, never>);

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "junto-thread-held-"));
  const workHome = join(root, "work");
  mkdirSync(workHome, { recursive: true });
  process.env.JUNTO_WORK_HOME = workHome;
  runtime = makeRuntime(root);
  await runtime.runPromise(nameThisMachine);
  await runtime.runPromise(
    seedCanvas(CANVAS, [region("region", { x: -40, y: -40, width: 600, height: 300 }, { label: "Canvas" }), seat(ME, { x: 0 })]),
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

/** The seat's own signal, raised and, when asked, withdrawn on its machine. */
const raise = (withdraw: boolean) =>
  run(Effect.gen(function* () {
    const store = yield* AgentSignalRepository;
    const signalId = ulid();
    yield* store.raise({ canvasName: CANVAS, nodeId: ME, signalId, kind: "escalate", text: "which database" });
    if (withdraw) yield* store.withdraw({ canvasName: CANVAS, nodeId: ME }, signalId);
    return signalId;
  }));

/** The operator's answer to the signal, arriving in the seat's mailbox as the editing machine writes it. */
const answerArrives = (signalId: string) =>
  run(Effect.gen(function* () {
    const work = yield* WorkService;
    const operator = operatorActorRef(CANVAS);
    const messageId = ulid();
    yield* work.workSystemMailboxNotify(
      CANVAS,
      ME,
      makeUserMessage({
        messageId,
        text: "use sqlite",
        contextId: CANVAS,
        metadata: {
          factoryMail: true,
          agentSignalId: signalId,
          ...mailExtensionMetadata({
            mailKind: "prompt",
            fromSeat: operator.seatId,
            senderNodeId: operator.nodeId,
            senderName: "operator",
            senderGeneration: "operator",
            senderHarness: "unknown",
          }),
        },
      }),
    );
    return messageId;
  }));

/** The seat's own call, with its credential. */
const asSeat = <A>(call: Effect.Effect<A, unknown, never>): Promise<A> => {
  process.env[WORK_TOKEN_ENV] = mine;
  return Effect.runPromise(call);
};

describe("an operator answer the seat withdrew its signal before", () => {
  it("stays readable in its thread, marked in the fixed words", async () => {
    const threadId = await answerArrives(await raise(true));
    const shown = await asSeat(callWorkRpc(ThreadShow, { threadId }));
    const [answer] = shown.messages;
    expect(answer?.text).toBe("use sqlite");
    expect(answer?.answerHeld).toBe(ANSWER_HELD_WORDS);
    // The window's own mark is not the seat's: the seat reads the words.
    expect(answer).not.toHaveProperty("held");
  });

  it("is ordinary mail when the signal is still open", async () => {
    const threadId = await answerArrives(await raise(false));
    const shown = await asSeat(callWorkRpc(ThreadShow, { threadId }));
    expect(shown.messages[0]?.text).toBe("use sqlite");
    expect(shown.messages[0]).not.toHaveProperty("answerHeld");
  });
});
