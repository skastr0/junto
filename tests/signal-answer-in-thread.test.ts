/**
 * Signals in threads, the operator side (artifact 01M855GV69YVAA8AM3PDJHCJXX,
 * points 4 and 5). The answer to a signal in a thread is the operator's next
 * mail in that thread, in reply to the seat's mail that is the signal; an
 * answer that starts a thread makes its signal the head. A reply the operator
 * types in a thread answers every open signal there that asks only for words,
 * through the same answer path, so the feed card closes; a signal that asks
 * for work stays open; a dismissed or withdrawn signal is left as it is.
 * Real stores under a temp root, the signals' thread included (step 76).
 */
import { mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { AgentSignalRepository, AgentSignalRepositoryLive } from "../src/core/signals/repository";
import { answerAgentSignal, dismissAgentSignal } from "../src/core/signals/operator";
import { sendOperatorThreadMail } from "../src/core/work/operator-threads";
import { OperatorThreadSend as OperatorThreadSendSchema, type OperatorThreadSend } from "../src/shared/mail-threads";
import { AGENT_SIGNAL_MAX_RESPONSE_LENGTH, type AgentSignal } from "../src/shared/agent-signals";
import type { Message } from "../src/shared/work-model";
import { nameThisMachine } from "./support/name-this-machine";
import { makeTestLog } from "./support/test-log";

const testLog = makeTestLog();
const CANVAS = "threads";
const SEAT = "agent";

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
const raise = (input: Raise): Promise<AgentSignal> =>
  run(Effect.flatMap(AgentSignalRepository, (signals) => signals.raise({ canvasName: CANVAS, nodeId: SEAT, ...input })));

/**
 * A thread with more mail in it, each standing in for a later signal's own
 * mail. Written before any signal is raised: a reply in the thread after one
 * is raised would answer it.
 */
const threadOf = async (more: number) => {
  const started = await send({ text: "Ship it today?" });
  const threadId = started.threadId as string;
  const mails: string[] = [];
  for (let n = 0; n < more; n += 1) mails.push((await send({ threadId, text: `And ${n}?` })).messageId as string);
  return { threadId, rootId: started.messageId as string, mails };
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

  it("starts a thread when the signal has none, and the signal heads it", async () => {
    const raised = await raise({ kind: "blocked", text: "Need the token." });
    const answered = await answer(raised.signalId, "Set it.");
    expect(answered.ok).toBe(true);
    const metadata = (await stored(answered.messageId)).metadata ?? {};
    expect(metadata).toMatchObject({ agentSignalId: raised.signalId });
    expect("threadId" in metadata).toBe(false);
    expect("inReplyTo" in metadata).toBe(false);
    // The answer is the thread's root, and the signal heads that thread.
    const head = await signal(raised.signalId);
    expect(head.state).toBe("answered");
    expect(head.threadId).toBe(answered.messageId);
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
    const { threadId, rootId, mails } = await threadOf(1);
    const raised = await raise({ kind: "escalate", text: "Which region first?", threadId, messageId: rootId });
    const second = await raise({ kind: "feedback", text: "Ready for review.", threadId, messageId: mails[0]! });
    const before = (await mailbox()).length;
    const replied = await send({ threadId, text: "Both fine." });
    expect((await mailbox()).length).toBe(before + 1);
    expect((await signal(raised.signalId)).state).toBe("answered");
    expect((await signal(second.signalId)).state).toBe("answered");
    // The mail names the newest; each signal records the same words, and the mail says both were answered.
    const sent = await stored(replied.messageId);
    expect(sent.metadata).toMatchObject({ agentSignalId: second.signalId });
    expect((await signal(raised.signalId)).response?.text).toBe("Both fine.");
    const words = sent.parts.map((part) => (part.kind === "text" ? part.text : "")).join("");
    expect(words).toContain(raised.signalId);
    expect(words).toContain(second.signalId);
    expect(words.trimEnd().endsWith("Both fine.")).toBe(true);
  });

  it("names the later signal when two are raised in one millisecond", async () => {
    // A frozen clock puts both signals at one created_at, so only their ids can order them.
    const frozen = vi.spyOn(Date, "now").mockReturnValue(Date.now());
    try {
      for (let round = 0; round < 25; round += 1) {
        const { threadId, rootId, mails } = await threadOf(1);
        const first = await raise({ kind: "escalate", text: `Which region ${round}?`, threadId, messageId: rootId });
        const second = await raise({ kind: "feedback", text: `Ready ${round}.`, threadId, messageId: mails[0]! });
        expect(first.createdAt).toBe(second.createdAt);
        expect(second.signalId > first.signalId).toBe(true);
        const replied = await send({ threadId, text: `Both fine ${round}.` });
        expect((await stored(replied.messageId)).metadata).toMatchObject({ agentSignalId: second.signalId });
      }
    } finally {
      frozen.mockRestore();
    }
  });

  it("names the signal whose mail the operator replied to, not the newest", async () => {
    const { threadId, rootId, mails } = await threadOf(1);
    const older = await raise({ kind: "escalate", text: "Which region?", threadId, messageId: rootId });
    await raise({ kind: "feedback", text: "Draft up.", threadId, messageId: mails[0]! });
    const replied = await send({ threadId, inReplyTo: rootId, text: "Europe." });
    expect((await stored(replied.messageId)).metadata).toMatchObject({ agentSignalId: older.signalId, inReplyTo: rootId });
  });

  it("keeps the mail and its id when the seat withdrew the signal between the read and the answer", async () => {
    const { threadId, raised } = await threadWithSignal();
    const before = (await mailbox()).length;
    // The seat withdraws as the answer is recorded: the read saw it open, the store has it closed.
    const withdrawing = Layer.effect(
      AgentSignalRepository,
      Effect.map(AgentSignalRepository, (live) =>
        AgentSignalRepository.of({
          ...live,
          answer: (signalId, ...rest) =>
            live.withdraw({ canvasName: CANVAS, nodeId: SEAT }, signalId).pipe(Effect.andThen(live.answer(signalId, ...rest))),
        }),
      ),
    );
    const replied: any = await run(
      sendOperatorThreadMail(decodeSend({ canvasName: CANVAS, nodeId: SEAT, threadId, text: "Asia first." })).pipe(
        Effect.provide(withdrawing),
      ),
    );
    expect(replied.ok).not.toBe(false);
    expect(replied).toMatchObject({ threadId });
    expect((await mailbox()).length).toBe(before + 1);
    expect((await stored(replied.messageId)).metadata).toMatchObject({ threadId });
    expect((await signal(raised.signalId)).state).toBe("withdrawn");
  });

  it("answers with a reply at the thread's full length, which is the answer's limit too", async () => {
    const { threadId, raised } = await threadWithSignal();
    const long = "a".repeat(AGENT_SIGNAL_MAX_RESPONSE_LENGTH);
    const replied = await send({ threadId, text: long });
    expect(replied.messageId).toEqual(expect.any(String));
    const after = await signal(raised.signalId);
    expect(after.state).toBe("answered");
    expect(after.response?.text).toBe(long);
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
    const { threadId, rootId, mails } = await threadOf(1);
    const raised = await raise({ kind: "escalate", text: "Which region first?", threadId, messageId: rootId });
    const withdrawn = await raise({ kind: "feedback", text: "Draft up.", threadId, messageId: mails[0]! });
    const before = (await mailbox()).length;
    await run(dismissAgentSignal(raised.signalId));
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
