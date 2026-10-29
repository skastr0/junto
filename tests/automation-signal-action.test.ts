import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { performSignalAction, type SignalAction } from "../src/main/junto/automation/signal-action";
import { AgentSignalNotFound, type AgentSignalRepository, type RaiseAgentSignal } from "../src/main/junto/signals/repository";
import { type Automation, AutomationId, AutomationVersion } from "../src/shared/automation";
import { asNodeId } from "../src/shared/physics/schema";
import { ItemId } from "../src/shared/work-ids";

const NODE = asNodeId("automations-1");
const SHELF = asNodeId("journal");
const DOC = ItemId.make("01M5ESKJFC1A88R1MH1NEZWJ51");
const SIGNAL_ID = "01M62Q58WDSXMG4YBXNKR2RB91";
const FIRED_AT = 1_790_000_000_000;
const automation: Automation = {
  automationId: AutomationId.make("01M5ESKJFC1A88R1MH1NEZWJ2Q"),
  nodeId: NODE,
  author: { kind: "operator" },
  version: AutomationVersion.make(1),
  name: "Daily writing",
  enabled: true,
  trigger: { kind: "schedule", cron: "0 9 * * *" } as never,
  then: [],
  limits: { minIntervalMs: 0, maxPerHour: 60 },
};

/** A signal store that records each raise; a raised id reads back. */
const store = () => {
  const raised: RaiseAgentSignal[] = [];
  const signals = {
    get: (signalId: string) =>
      raised.some((one) => one.signalId === signalId)
        ? Effect.succeed({ signalId } as never)
        : Effect.fail(new AgentSignalNotFound({ signalId, message: "not found" })),
    raise: (input: RaiseAgentSignal) => Effect.sync(() => {
      raised.push(input);
      return { signalId: input.signalId } as never;
    }),
  } as unknown as AgentSignalRepository["Service"];
  return { raised, signals };
};

const perform = (signals: AgentSignalRepository["Service"], action: SignalAction) =>
  Effect.runPromise(performSignalAction(signals, {
    canvasName: "factory",
    automation,
    action,
    index: 0,
    fired: { at: FIRED_AT },
    resolve: (text) => Effect.succeed(text.replaceAll("{{fired.at}}", "Tuesday")),
    signalId: SIGNAL_ID,
  }));

const write: SignalAction = {
  kind: "signal",
  signal: "work",
  title: "Write 500 words, {{fired.at}}",
  detail: "Morning pages",
  show: [{ kind: "artifact", nodeId: SHELF, artifactId: DOC }],
  form: { kind: "artifact", node: SHELF, labels: ["Daily"] as never, minWords: 500 },
  work: { dueInMs: 3_600_000, urgent: true },
};

describe("an automation's signal step (0.11/07 N2)", () => {
  it("raises work from the Automations node, with its values said, its form settled and its due time from the firing", async () => {
    const { raised, signals } = store();
    expect(await perform(signals, write)).toEqual({ index: 0, ruling: "applied" });
    expect(raised).toEqual([{
      canvasName: "factory",
      nodeId: NODE,
      signalId: SIGNAL_ID,
      kind: "work",
      text: "Write 500 words, Tuesday",
      detail: "Morning pages",
      source: { kind: "automation", automationId: automation.automationId, nodeId: NODE },
      work: { dueAt: FIRED_AT + 3_600_000, urgent: true },
      // Titled from the signal when the form names none; labels fold as a seat raise folds them.
      form: { kind: "artifact", nodeId: SHELF, title: "Write 500 words, Tuesday", labels: ["daily"], minWords: 500 },
      attachments: [{ kind: "artifact", nodeId: SHELF, artifactId: DOC }],
    }]);
  });

  it("raises once for a retried firing", async () => {
    const { raised, signals } = store();
    await perform(signals, write);
    expect(await perform(signals, write)).toEqual({ index: 0, ruling: "applied" });
    expect(raised).toHaveLength(1);
  });

  it("raises a notice with no form and no timing", async () => {
    const { raised, signals } = store();
    await perform(signals, { kind: "signal", signal: "notice", title: "The nightly run finished" });
    expect(raised[0]).toMatchObject({ kind: "notice", text: "The nightly run finished" });
    expect(raised[0]).not.toHaveProperty("form");
    expect(raised[0]).not.toHaveProperty("work");
  });

  it("names the document as the form says, defaults the condition, and asks for a reply or proof as is", async () => {
    const { raised, signals } = store();
    await perform(signals, { ...write, form: { kind: "artifact", node: SHELF, title: "Pages, {{fired.at}}" }, work: undefined });
    expect(raised[0]!.form).toEqual({ kind: "artifact", nodeId: SHELF, title: "Pages, Tuesday", labels: [], minWords: 1 });
    expect(raised[0]).not.toHaveProperty("work");
    await perform(signals, { ...write, form: { kind: "proof" } });
    expect(raised).toHaveLength(1);
  });

  it("refuses the secret form until the vault (N5), raising nothing", async () => {
    const { raised, signals } = store();
    expect(await perform(signals, { ...write, form: { kind: "secret", name: "CLOUDFLARE_API_TOKEN" as never } }))
      .toEqual({ index: 0, ruling: "refused", reason: "not_available" });
    expect(raised).toEqual([]);
  });

  it("cuts a title its values made too long to the feed's length", async () => {
    const { raised, signals } = store();
    const long = (text: string) => Effect.succeed(text.replaceAll("{{fired.at}}", "x".repeat(400)));
    await Effect.runPromise(performSignalAction(signals, {
      canvasName: "factory", automation, action: write, index: 0, fired: { at: FIRED_AT }, resolve: long, signalId: SIGNAL_ID,
    }));
    expect(raised[0]!.text.length).toBe(280);
    expect((raised[0]!.form as { title: string }).title.length).toBe(200);
  });
});
