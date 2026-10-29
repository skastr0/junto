import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { carriedValues, performSignalAction, type SignalAction } from "../src/main/junto/automation/signal-action";
import { AgentSignalNotFound, type AgentSignalRepository, type RaiseAgentSignal } from "../src/main/junto/signals/repository";
import { type Automation, AutomationId, AutomationVersion } from "../src/shared/automation";
import type { Canvas } from "../src/shared/model";
import { asNodeId } from "../src/shared/physics/schema";
import { VAULT_ENABLED } from "../src/shared/features";
import { ItemId } from "../src/shared/work-ids";

const NODE = asNodeId("automations-1");
const SHELF = asNodeId("journal");
const DOC = ItemId.make("01M5ESKJFC1A88R1MH1NEZWJ51");
const SIGNAL_ID = "01M62Q58WDSXMG4YBXNKR2RB91";
const FIRING_ID = "01M62Q58WDA1B2C3D4E5F6G7H8";
const VALUES = { "fired.at": "2026-09-22T09:00:00.000Z" };
const canvas = {
  nodes: new Map([
    [SHELF, { kind: "artifacts", id: SHELF, title: "Journal", x: 0, y: 0, width: 10, height: 10, z: 0 }],
    [NODE, { kind: "automations", id: NODE, x: 0, y: 0, width: 10, height: 10, z: 0 }],
  ]),
  wires: new Map(),
} as unknown as Canvas;
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
    canvas,
    canvasName: "factory",
    machine: "mini",
    automation,
    action,
    index: 0,
    values: VALUES,
    resolve: (text) => Effect.succeed(text.replaceAll("{{fired.at}}", "Tuesday")),
    firingId: FIRING_ID,
    signalId: SIGNAL_ID,
  }));

const write: SignalAction = {
  kind: "signal",
  id: "pages",
  signal: "escalate",
  title: "Write 500 words, {{fired.at}}",
  detail: "Morning pages",
  show: [{ kind: "artifact", nodeId: SHELF, artifactId: DOC }],
  form: { kind: "artifact", node: SHELF, labels: ["Daily"] as never, minWords: 500 },
};
const RAISED = { index: 0, ruling: "raised", signalId: SIGNAL_ID, step: "pages" } as const;

describe("an automation's signal step (0.11/07 N2, 0.11/09 H1)", () => {
  it("raises an escalate from the Automations node, with its values said and its form settled, and keeps the firing's values", async () => {
    const { raised, signals } = store();
    expect(await perform(signals, write)).toEqual(RAISED);
    expect(raised).toEqual([{
      canvasName: "factory",
      nodeId: NODE,
      signalId: SIGNAL_ID,
      kind: "escalate",
      text: "Write 500 words, Tuesday",
      detail: "Morning pages",
      // The step and the firing's values ride the signal, for the answer on any machine.
      source: { kind: "automation", automationId: automation.automationId, nodeId: NODE, firingId: FIRING_ID, step: { index: 0, id: "pages", raised: VALUES } },
      // Titled from the signal when the form names none; labels fold as a seat raise folds them.
      form: { kind: "artifact", nodeId: SHELF, title: "Write 500 words, Tuesday", labels: ["daily"], minWords: 500 },
      attachments: [{ kind: "artifact", nodeId: SHELF, artifactId: DOC }],
    }]);
  });

  it("raises once for a retried firing", async () => {
    const { raised, signals } = store();
    await perform(signals, write);
    expect(await perform(signals, write)).toEqual(RAISED);
    expect(raised).toHaveLength(1);
  });

  it("raises one signal per firing, never merged: ten firings raise ten", async () => {
    const { raised, signals } = store();
    const ids = Array.from({ length: 10 }, (_, k) => `01M62Q58WDSXMG4YBXNKR2RB${String(k).padStart(2, "0")}`);
    for (const [k, signalId] of ids.entries()) {
      await Effect.runPromise(performSignalAction(signals, {
        canvas, canvasName: "factory", machine: "mini", automation, action: write, index: 0, values: VALUES,
        resolve: Effect.succeed, firingId: `01M62Q58WDA1B2C3D4E5F6G7${String(k).padStart(2, "0")}`, signalId,
      }));
    }
    expect(raised.map((one) => one.signalId)).toEqual(ids);
  });

  it("raises blocked and feedback as a seat would, and a notice with no form", async () => {
    const { raised, signals } = store();
    await perform(signals, { kind: "signal", signal: "blocked", title: "The deploy key expired", form: { kind: "text" } });
    expect(raised[0]).toMatchObject({ kind: "blocked", form: { kind: "text" } });
    const fresh = store();
    await perform(fresh.signals, { kind: "signal", signal: "feedback", title: "Read this draft" });
    expect(fresh.raised[0]).toMatchObject({ kind: "feedback", text: "Read this draft" });
    // Feedback is answered in words: a stored one with a form is refused, raising nothing.
    const formed = store();
    expect(await perform(formed.signals, { kind: "signal", signal: "feedback", title: "Read this draft", form: { kind: "text" } }))
      .toEqual({ index: 0, ruling: "refused", reason: "invalid_input" });
    expect(formed.raised).toEqual([]);
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
    await perform(signals, { ...write, form: { kind: "artifact", node: SHELF, title: "Pages, {{fired.at}}" } });
    expect(raised[0]!.form).toEqual({ kind: "artifact", nodeId: SHELF, title: "Pages, Tuesday", labels: [], minWords: 1 });
    expect(raised[0]).not.toHaveProperty("work");
    await perform(signals, { ...write, form: { kind: "proof" } });
    expect(raised).toHaveLength(1);
  });

  it("refuses a form whose Artifacts node is gone from the board, raising nothing", async () => {
    const { raised, signals } = store();
    expect(await perform(signals, { ...write, form: { kind: "artifact", node: asNodeId("gone") } }))
      .toEqual({ index: 0, ruling: "refused", reason: "unknown_target" });
    expect(raised).toEqual([]);
  });

  it("refuses a stored notice that holds a form, raising nothing", async () => {
    const { raised, signals } = store();
    expect(await perform(signals, { kind: "signal", signal: "notice", title: "Read this", form: { kind: "text" } }))
      .toEqual({ index: 0, ruling: "refused", reason: "invalid_input" });
    expect(raised).toEqual([]);
  });

  it("refuses a secret form no region declares for the firing's machine, and one with no machine, raising nothing", async () => {
    const { raised, signals } = store();
    const secret = { ...write, form: { kind: "secret", name: "CLOUDFLARE_API_TOKEN" } } as SignalAction;
    // Without the vault (N5) every secret form is not_available; with it, an undeclared name is the step's own.
    expect(await perform(signals, secret)).toEqual({ index: 0, ruling: "refused", reason: VAULT_ENABLED ? "invalid_input" : "not_available" });
    expect(await Effect.runPromise(performSignalAction(signals, {
      canvas, canvasName: "factory", machine: undefined, automation, action: secret, index: 0,
      values: VALUES, resolve: Effect.succeed, firingId: FIRING_ID, signalId: SIGNAL_ID,
    }))).toEqual({ index: 0, ruling: "refused", reason: "not_available" });
    expect(raised).toEqual([]);
  });

  it("cuts a title its values made too long to the feed's length", async () => {
    const { raised, signals } = store();
    const long = (text: string) => Effect.succeed(text.replaceAll("{{fired.at}}", "x".repeat(400)));
    await Effect.runPromise(performSignalAction(signals, {
      canvas, canvasName: "factory", machine: "mini", automation, action: write, index: 0, values: VALUES, resolve: long, firingId: FIRING_ID, signalId: SIGNAL_ID,
    }));
    expect(raised[0]!.text.length).toBe(280);
    expect((raised[0]!.form as { title: string }).title.length).toBe(200);
  });

  it("carries the firing's values cut to the signal's bounds, leaving off what does not fit", () => {
    const long = "x".repeat(2_500);
    const carried = carriedValues({ "fired.at": "2026-09-22T09:00:00.000Z", "code.a": long, ...Object.fromEntries(Array.from({ length: 20 }, (_, k) => [`code.f${k}`, long])) });
    expect(carried["fired.at"]).toBe("2026-09-22T09:00:00.000Z");
    expect(carried["code.a"]).toHaveLength(2_000);
    expect(Object.values(carried).reduce((total, value) => total + value.length, 0)).toBeLessThanOrEqual(32_000);
    expect(Object.keys(carried)).toHaveLength(16);
  });
});
