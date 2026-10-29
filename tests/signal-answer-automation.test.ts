/**
 * An automation's signal is answered without mail to its Automations node
 * (0.11/09 H2). The answer is recorded, and the automation's machine hears
 * the answered row through the store's own change, which is the event its
 * answered watches read. A seat's signal keeps mailing its seat.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { AgentSignalRepository, AgentSignalRepositoryLive } from "../src/main/junto/signals/repository";
import { onAgentSignalChanged } from "../src/main/junto/signals/changes";
import { answerAgentSignal } from "../src/main/junto/signals/operator";
import { WorkService, type WorkServiceShape } from "../src/main/junto/work/service";
import type { AgentSignal } from "../src/shared/agent-signals";

const AUTOMATION_ID = "01M62Q58WDSXMG4YBXNKR2RB91";
const FIRING_ID = "01M62Q58WDSXMG4YBXNKR2RB92";
const AUTOMATIONS_NODE = "routines";

let root: string;
let runtime: ManagedRuntime.ManagedRuntime<AgentSignalRepository, unknown>;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "junto-signal-answer-"));
  runtime = ManagedRuntime.make(AgentSignalRepositoryLive.pipe(Layer.provide(makeStateEngineLive(join(root, "junto.db")))));
});

afterEach(async () => {
  await runtime.dispose();
  await rm(root, { recursive: true, force: true });
});

/** A mailbox that records who was mailed; the answer path never reads the canvas here. */
const mailbox = () => {
  const mailed: Array<{ readonly nodeId: string }> = [];
  const work = {
    workSystemMailboxNotify: (_canvasName: string, nodeId: string) =>
      Effect.sync(() => {
        mailed.push({ nodeId });
        return { ok: true as const, data: { messageId: "m1", written: true } };
      }),
  } as unknown as WorkServiceShape;
  return { mailed, work };
};

const raise = (input: Parameters<AgentSignalRepository["Service"]["raise"]>[0]) =>
  runtime.runPromise(Effect.flatMap(AgentSignalRepository, (signals) => signals.raise(input)));

const answer = (signalId: string, text: string, work: WorkServiceShape) =>
  runtime.runPromise(answerAgentSignal(signalId, text).pipe(Effect.provideService(WorkService, work)));

describe("answering an automation's signal", () => {
  it("records the answer, mails no node, and lets the answered row be heard", async () => {
    const { mailed, work } = mailbox();
    const raised = await raise({
      canvasName: "factory",
      nodeId: AUTOMATIONS_NODE,
      kind: "escalate",
      text: "Which post goes out first?",
      source: { kind: "automation", automationId: AUTOMATION_ID, nodeId: AUTOMATIONS_NODE, firingId: FIRING_ID },
    });
    const heard: AgentSignal[] = [];
    const stop = onAgentSignalChanged((signal) => heard.push(signal));
    try {
      const answered = await answer(raised.signalId, "Ship the second one", work);
      expect(answered).toMatchObject({ ok: true });
      if (!answered.ok) return;
      expect(answered.signal.state).toBe("answered");
      expect(answered.signal.response?.text).toBe("Ship the second one");
      // The Automations node is no seat: nothing was typed into it.
      expect(answered.messageId).toBeUndefined();
      expect(mailed).toEqual([]);
      // The store says so, and that is the row the automation's runner hears.
      expect(heard.map((signal) => [signal.signalId, signal.state])).toEqual([[raised.signalId, "answered"]]);
    } finally {
      stop();
    }
  });

  it("still mails a seat's own signal", async () => {
    const { mailed, work } = mailbox();
    const raised = await raise({ canvasName: "factory", nodeId: "agent-a", kind: "escalate", text: "Which store?" });
    const answered = await answer(raised.signalId, "sqlite", work);
    expect(answered).toMatchObject({ ok: true });
    if (!answered.ok) return;
    expect(answered.messageId).toBe("m1");
    expect(mailed).toEqual([{ nodeId: "agent-a" }]);
  });
});
