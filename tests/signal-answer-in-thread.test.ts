/**
 * Signals in threads, the operator side (artifact 01M855GV69YVAA8AM3PDJHCJXX,
 * points 4 and 5). The answer to a signal in a thread is the operator's next
 * mail in that thread, in reply to the seat's mail that is the signal; an
 * answer that starts a thread makes its signal the head. A reply the operator
 * types in a thread answers every open signal there that asks only for words,
 * through the same answer path, so the feed card closes; a signal that asks
 * for work stays open; a dismissed or withdrawn signal is left as it is.
 * The mail store is real, under a temp root. The signals are held in memory
 * until the store keeps a signal's thread (migration 75 to 76, cli-performance):
 * the answer path reads them through the same repository service.
 */
import { mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ModelStoresLive, seedCanvas } from "./support/seed-canvas";
import { seat as seatNode } from "./support/model-nodes";
import { WorkLive, WorkService } from "../src/core/work/service";
import { CrewRepositoryLive } from "../src/core/work/crew-repository";
import { makeContentServiceLive } from "../src/core/content/service";
import { WorkRepositoryLive } from "../src/core/work/repository";
import { makeStateEngineLive } from "../src/core/state/engine";
import { makeInstallOpsLive } from "../src/core/install-ops/engine";
import { MachineRepositoryLive } from "../src/core/machines/repository";
import { SettingsLive } from "../src/core/settings/service";
import { PausePlaneAllPlaying } from "../src/core/pause-plane";
import { AgentSignalNotFound, AgentSignalRepository } from "../src/core/signals/repository";
import { answerAgentSignal, dismissAgentSignal } from "../src/core/signals/operator";
import { sendOperatorThreadMail } from "../src/core/work/operator-threads";
import { OperatorThreadSend as OperatorThreadSendSchema, type OperatorThreadSend } from "../src/shared/mail-threads";
import type { AgentSignal } from "../src/shared/agent-signals";
import { ulid } from "ulid";
import type { Message } from "../src/shared/work-model";
import { nameThisMachine } from "./support/name-this-machine";
import { makeTestLog } from "./support/test-log";

const testLog = makeTestLog();
const CANVAS = "threads";
const SEAT = "agent";

/** The signals, as the repository holds them: open until answered, dismissed or withdrawn. */
const held = new Map<string, AgentSignal>();
const missing = (signalId: string) => new AgentSignalNotFound({ signalId, message: `no signal ${signalId}` });
const close = (signalId: string, closed: Partial<AgentSignal>) =>
  Effect.suspend(() => {
    const signal = held.get(signalId);
    if (signal === undefined || signal.state !== "open") return Effect.fail(missing(signalId));
    const next = { ...signal, ...closed, closedAt: Date.now() } as AgentSignal;
    held.set(signalId, next);
    return Effect.succeed(next);
  });
const memorySignals = Layer.mock(AgentSignalRepository, {
  get: (signalId) => Effect.suspend(() => {
    const signal = held.get(signalId);
    return signal === undefined ? Effect.fail(missing(signalId)) : Effect.succeed(signal);
  }),
  listSeat: (seat) =>
    Effect.sync(() => [...held.values()].filter((signal) => signal.canvasName === seat.canvasName && signal.nodeId === seat.nodeId)),
  answer: (signalId, text) => close(signalId, { state: "answered", response: { text, at: Date.now() } }),
  dismiss: (signalId) => close(signalId, { state: "dismissed" }),
  withdraw: (_seat, signalId) => Effect.map(close(signalId!, { state: "withdrawn" }), (signal) => [signal]),
});

const makeRuntime = (root: string) => {
  const repositoriesLive = Layer.provideMerge(
    Layer.mergeAll(
      WorkRepositoryLive,
      CrewRepositoryLive,
      MachineRepositoryLive,
      SettingsLive,
      memorySignals,
      makeContentServiceLive({ root: join(root, "content"), skipInlineMediaMigration: true }),
    ),
    Layer.mergeAll(
      makeStateEngineLive(join(root, "state", "junto.db")),
      makeInstallOpsLive(join(root, "state", "install-ops.db")),
    ),
  );
  const canvasesLive = Layer.provideMerge(ModelStoresLive, repositoriesLive);
  const workLive = Layer.provideMerge(WorkLive, canvasesLive);
  return ManagedRuntime.make(Layer.mergeAll(workLive, PausePlaneAllPlaying, testLog.log.loggerLayer));
};

let root: string;
let runtime: ReturnType<typeof makeRuntime>;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "junto-signal-thread-"));
  const workHome = join(root, "work");
  mkdirSync(workHome, { recursive: true });
  process.env.JUNTO_WORK_HOME = workHome;
  runtime = makeRuntime(root);
  await runtime.runPromise(nameThisMachine);
  await runtime.runPromise(
    seedCanvas(CANVAS, [
      seatNode(SEAT, {
        x: 0,
        y: 40,
        width: 120,
        height: 48,
        bindingId: `bind-${SEAT}` as never,
        launch: { kind: "harness", argv: ["claude"] },
      }),
    ]),
  );
});

afterEach(async () => {
  held.clear();
  await runtime.dispose();
  await rm(root, { recursive: true, force: true });
  delete process.env.JUNTO_WORK_HOME;
});

const run = <A>(effect: Effect.Effect<A, unknown, any>): Promise<A> => runtime.runPromise(effect as Effect.Effect<A, unknown, never>);

const decodeSend = Schema.decodeUnknownSync(OperatorThreadSendSchema);
const send = (input: Omit<OperatorThreadSend, "canvasName" | "nodeId">): Promise<any> =>
  run(sendOperatorThreadMail(decodeSend({ canvasName: CANVAS, nodeId: SEAT, ...input })));

const mailbox = (): Promise<ReadonlyArray<Message>> => run(Effect.flatMap(WorkService, (work) => work.readMailbox(CANVAS, SEAT)));
const stored = async (messageId: string): Promise<Message> => {
  const found = (await mailbox()).find((message) => message.messageId === messageId);
  if (found === undefined) throw new Error(`${messageId} is not in the mailbox`);
  return found;
};

const signal = (signalId: string): Promise<AgentSignal> => run(Effect.flatMap(AgentSignalRepository, (signals) => signals.get(signalId)));
const answer = (signalId: string, text: string): Promise<any> => run(answerAgentSignal(signalId, text));

type Raise = Pick<AgentSignal, "kind" | "text"> & Partial<Pick<AgentSignal, "form" | "threadId" | "messageId">>;
let clock = 1;
const raise = async (input: Raise): Promise<AgentSignal> => {
  const signal: AgentSignal = { signalId: ulid(), canvasName: CANVAS, nodeId: SEAT, createdAt: (clock += 1), state: "open", ...input };
  held.set(signal.signalId, signal);
  return signal;
};

/**
 * A thread between the operator and the seat, and a signal the seat raised
 * in it. The operator's mail starts the thread; its id stands in for the
 * seat's mail that is the signal, which the raise handler writes.
 */
const threadWithSignal = async (form?: Raise["form"]) => {
  const started = await send({ text: "Ship it today?" });
  const raised = await raise({
    kind: "escalate",
    text: "Which region first?",
    threadId: started.threadId,
    messageId: started.messageId,
    ...(form === undefined ? {} : { form }),
  });
  return { threadId: started.threadId as string, rootId: started.messageId as string, raised };
};

describe("the answer to a signal in a thread", () => {
  it("is the operator's next mail in that thread, in reply to the signal's mail", async () => {
    const { threadId, rootId, raised } = await threadWithSignal();
    const answered = await answer(raised.signalId, "Europe first.");
    expect(answered.ok).toBe(true);
    expect(answered.messageId).not.toBe(threadId);
    expect((await stored(answered.messageId)).metadata).toMatchObject({
      agentSignalId: raised.signalId,
      threadId,
      inReplyTo: rootId,
    });
    expect((await signal(raised.signalId)).state).toBe("answered");
    // No new thread: the thread keeps its id.
    expect((await signal(raised.signalId)).threadId).toBe(threadId);
  });

  it("starts a thread when the signal has none", async () => {
    const raised = await raise({ kind: "blocked", text: "Need the token." });
    const answered = await answer(raised.signalId, "Set it.");
    expect(answered.ok).toBe(true);
    const metadata = (await stored(answered.messageId)).metadata ?? {};
    expect(metadata).toMatchObject({ agentSignalId: raised.signalId });
    expect("threadId" in metadata).toBe(false);
    expect("inReplyTo" in metadata).toBe(false);
    // The answer is the thread's root: the thread's id is its own.
    expect((await signal(raised.signalId)).state).toBe("answered");
  });
});

describe("a reply the operator types in a thread", () => {
  it("answers its open signal through the answer path, so the card closes", async () => {
    const { threadId, raised } = await threadWithSignal();
    const replied = await send({ threadId, text: "Asia first." });
    expect(replied).toMatchObject({ threadId });
    const after = await signal(raised.signalId);
    expect(after.state).toBe("answered");
    expect(after.response?.text).toBe("Asia first.");
    expect((await stored(replied.messageId)).metadata).toMatchObject({ agentSignalId: raised.signalId, threadId });
  });

  it("answers a signal with a text form, which asks only for words", async () => {
    const { threadId, raised } = await threadWithSignal({ kind: "text" });
    await send({ threadId, text: "Here are the words." });
    expect((await signal(raised.signalId)).state).toBe("answered");
  });

  it("answers every open plain signal in the thread with one mail", async () => {
    const { threadId, rootId, raised } = await threadWithSignal();
    const second = await raise({ kind: "feedback", text: "Ready for review.", threadId, messageId: rootId });
    const before = (await mailbox()).length;
    const replied = await send({ threadId, text: "Both fine." });
    expect((await mailbox()).length).toBe(before + 1);
    expect((await signal(raised.signalId)).state).toBe("answered");
    expect((await signal(second.signalId)).state).toBe("answered");
    // The mail names the newest; each signal records the same words.
    expect((await stored(replied.messageId)).metadata).toMatchObject({ agentSignalId: second.signalId });
    expect((await signal(raised.signalId)).response?.text).toBe("Both fine.");
  });

  it("leaves a signal that asks for work open, and goes as plain mail", async () => {
    const { threadId, raised } = await threadWithSignal({ kind: "proof" });
    const replied = await send({ threadId, text: "Working on it." });
    expect((await signal(raised.signalId)).state).toBe("open");
    const metadata = (await stored(replied.messageId)).metadata ?? {};
    expect("agentSignalId" in metadata).toBe(false);
    expect(metadata).toMatchObject({ threadId });
  });

  it("leaves a dismissed or withdrawn signal as it reads, and goes as plain mail", async () => {
    const { threadId, rootId, raised } = await threadWithSignal();
    const before = (await mailbox()).length;
    await run(dismissAgentSignal(raised.signalId));
    const withdrawn = await raise({ kind: "feedback", text: "Draft up.", threadId, messageId: rootId });
    await run(Effect.flatMap(AgentSignalRepository, (signals) => signals.withdraw({ canvasName: CANVAS, nodeId: SEAT }, withdrawn.signalId)));

    // Dismissing and withdrawing wrote nothing into the thread.
    expect((await mailbox()).length).toBe(before);
    const replied = await send({ threadId, text: "Thanks anyway." });
    expect((await signal(raised.signalId)).state).toBe("dismissed");
    expect((await signal(withdrawn.signalId)).state).toBe("withdrawn");
    expect("agentSignalId" in ((await stored(replied.messageId)).metadata ?? {})).toBe(false);
  });

  it("answers nothing when it starts a new thread", async () => {
    const raised = await raise({ kind: "escalate", text: "Which store?" });
    await send({ text: "Unrelated." });
    expect((await signal(raised.signalId)).state).toBe("open");
  });
});
