import { DatabaseSync } from "node:sqlite";
import { Effect, Layer, ManagedRuntime, Result, Schema } from "effect";
import { Reactivity } from "effect/unstable/reactivity";
import { SqlClient } from "effect/unstable/sql";
import { describe, expect, it } from "vitest";
import { answeredChange } from "../src/main/junto/automation/live";
import { changeMatches, type ChangeEvent } from "../src/main/junto/automation/plan";
import { AutomationRepository, makeAutomationRepositoryLive } from "../src/main/junto/automation/repository";
import { answerDelivery, makeAutomationRunner, type RunnerPorts } from "../src/main/junto/automation/runner";
import { AUTOMATION_STATE_SCHEMA_SQL } from "../src/main/junto/automation/state-schema";
import { firedValue } from "../src/main/junto/automation/values";
import { makeSqliteClient } from "../src/main/junto/state/sqlite-client";
import {
  Action,
  type Automation,
  type AutomationDefinition,
  AutomationId,
  AutomationVersion,
  actionRefusal,
  answeredWatchNodeRefusal,
  answerToValuesOf,
  automationValuesOf,
  decodeAutomation,
  FiringId,
  formatProblem,
  resolveValues,
  stepIdRefusal,
  targetNodeIds,
  valueNamesIn,
  valueRefusal,
  VALUE_FORMATS,
  Watch,
} from "../src/shared/automation";
import { applyValueFormats, parseValueFormats } from "../src/shared/automation-formats";
import type { NodeKind } from "../src/shared/model/kinds";
import { asNodeId } from "../src/shared/physics/schema";
import type { ReachCanvas, ReachNode } from "../src/shared/region-reach";
import type { AgentSignal } from "../src/shared/wire/agent-signals";
import { ItemId } from "../src/shared/work-ids";

const CANVAS = "factory";
const RAISER = Schema.decodeUnknownSync(AutomationId)("01M5ESKJFC1A88R1MH1NEZWJ2Q");
const NODE = asNodeId("automations-1");
const SHELF = asNodeId("journal");
const SEAT = asNodeId("seat-a");
const DOC = ItemId.make("01M5ESKJFC1A88R1MH1NEZWJ51");
const SIGNAL_ID = "01M62Q58WDSXMG4YBXNKR2RB91";
const FIRING_ID = "01M62Q58WDA1B2C3D4E5F6G7H8";
const ANSWERED_AT = Date.parse("2026-10-29T14:05:09Z");

const formats = (written: string) => {
  const parsed = parseValueFormats(written);
  if (!parsed.ok) throw new Error(`bad format ${parsed.bad}`);
  return parsed.formats;
};

describe("value formats (0.11/09 H1)", () => {
  it("writes a date in a pattern, in the automation's time zone", () => {
    const at = "2026-10-29T23:30:05.000Z";
    expect(applyValueFormats(at, formats("|date:YYYY-MM-DD"), "UTC")).toBe("2026-10-29");
    expect(applyValueFormats(at, formats("|date:YYYY-MM-DD HH:mm"), "Asia/Tokyo")).toBe("2026-10-30 08:30");
    expect(applyValueFormats(at, formats("|date:D/M/YY H:mm:ss"), "America/Sao_Paulo")).toBe("29/10/26 20:30:05");
    // A value that is not a time passes as said.
    expect(applyValueFormats("Write 500 words", formats("|date:YYYY"), "UTC")).toBe("Write 500 words");
  });

  it("slugs, cases and trims, left to right", () => {
    expect(applyValueFormats("  Café: Release 0.11 Notes!  ", formats("|slug"), undefined)).toBe("cafe-release-0-11-notes");
    expect(applyValueFormats(" Ship it ", formats("|trim|upper"), undefined)).toBe("SHIP IT");
    expect(applyValueFormats("Ship It", formats("|lower"), undefined)).toBe("ship it");
  });

  it("resolves tokens with formats, and leaves a value the firing lacks as written, formats and all", () => {
    const said = resolveValues(
      "Review {{fired.at|date:YYYY-MM-DD}} {{task.title|slug}} {{answer.text}} {{task.title}x}}",
      (name) => ({ "fired.at": "2026-10-29T09:00:00.000Z", "task.title": "Ship The Thing" })[name as string],
      "UTC",
    );
    expect(said).toBe("Review 2026-10-29 ship-the-thing {{answer.text}} {{task.title}x}}");
    expect(valueNamesIn("{{fired.at|date:YYYY}} {{raised.task.title|upper}} {{raised.code.ticket}}")).toEqual([
      "fired.at",
      "raised.task.title",
      "raised.code.ticket",
    ]);
  });

  it("refuses an unknown format or a pattern it cannot write, naming the set", () => {
    expect(formatProblem("{{fired.at|dat:YYYY}}")).toEqual({
      reason: "invalid_input",
      message: "{{fired.at|dat:YYYY}} names an unknown format",
      next_step: `Use one of: ${VALUE_FORMATS.join(", ")}`,
    });
    expect(formatProblem("{{fired.at|date:YYYY-Q}}")).toMatchObject({ message: "{{fired.at|date:YYYY-Q}} has a date pattern this cannot write" });
    expect(formatProblem("{{fired.at|date:}}")).toMatchObject({ reason: "invalid_input" });
    expect(formatProblem("{{fired.at|date:YYYY-MM-DDTHH:mm}} {{task.title|trim|slug}}")).toBeUndefined();
    expect(VALUE_FORMATS).toEqual(["date:<pattern>", "slug", "lower", "upper", "trim"]);
  });
});

const answeredWatch = { kind: "answered", automation: { node: NODE, automationId: RAISER } } as const;
const definition = (over: Partial<AutomationDefinition>): Pick<AutomationDefinition, "trigger" | "then"> => ({
  trigger: { kind: "change", on: answeredWatch },
  then: [{ kind: "mail", to: { kind: "seat", nodeId: SEAT }, text: "x" }],
  ...over,
});

describe("the answered watch and answerTo (0.11/09 H1)", () => {
  it("decodes the watch, narrowed to a step or kind, on its own node", () => {
    expect(Schema.is(Watch)(answeredWatch)).toBe(true);
    expect(Schema.is(Watch)({ ...answeredWatch, step: "ask-review", signal: "escalate" })).toBe(true);
    expect(Schema.is(Watch)({ ...answeredWatch, step: "Ask Review" })).toBe(false);
    expect(Schema.is(Watch)({ ...answeredWatch, signal: "notice" })).toBe(false);
    // Its own node: reach never lists an Automations node, and an answered watch needs none.
    const listener = { automationId: RAISER, nodeId: NODE, author: { kind: "operator" }, ...definition({}) } as unknown as Automation;
    expect(targetNodeIds(listener)).toEqual([SEAT]);
    expect(answeredWatchNodeRefusal(listener)).toBeUndefined();
    expect(answeredWatchNodeRefusal({ ...listener, nodeId: asNodeId("automations-2") })).toMatchObject({
      message: "an answered watch listens to an automation on its own Automations node",
    });
  });

  it("carries the answer's values and its raising firing's, and only there", () => {
    expect(automationValuesOf({ kind: "change", on: answeredWatch })).toEqual([
      "answer.text", "answer.link", "answer.by", "answer.at", "signal.title", "signal.kind", "signal.link", "fired.at",
    ]);
    const text = (body: string) => definition({ then: [{ kind: "mail", to: { kind: "seat", nodeId: SEAT }, text: body }] });
    expect(valueRefusal(text("{{answer.text}} for {{raised.task.title}} {{raised.code.ticket|upper}}"))).toBeUndefined();
    expect(valueRefusal({ ...text("{{raised.task.title}}"), trigger: { kind: "schedule", cron: "0 9 * * *", timezone: "UTC" } }))
      .toMatchObject({ message: "this trigger carries no {{raised.task.title}}" });
    expect(valueRefusal(text("{{answer.at|dat:YYYY}}"))).toMatchObject({ message: "{{answer.at|dat:YYYY}} names an unknown format" });
  });

  it("lets an answerTo title name the answer, and nothing else in the step", () => {
    const schedule = { kind: "schedule", cron: "0 9 * * *", timezone: "UTC" } as const;
    expect(answerToValuesOf(schedule)).toEqual(["fired.at", "answer.text", "answer.link", "answer.by", "answer.at", "signal.title", "signal.kind", "signal.link"]);
    const ask = (title: string, answerTitle: string) => ({
      trigger: schedule,
      then: [{ kind: "signal", signal: "escalate", title, answerTo: { kind: "document", node: SHELF, title: answerTitle } }] as never,
    });
    expect(valueRefusal(ask("Review today", "Review {{fired.at|date:YYYY-MM-DD}} {{answer.by}}"))).toBeUndefined();
    expect(valueRefusal(ask("Review {{answer.text}}", "Review"))).toMatchObject({ message: "this trigger carries no {{answer.text}}" });
  });

  it("decodes answerTo, reaches its target, and refuses one that cannot take an answer", () => {
    const ask = { kind: "signal", signal: "escalate", title: "Review?" } as const;
    const toSeat = { ...ask, answerTo: { kind: "seat", to: { kind: "seat", nodeId: SEAT } } } as const;
    const toDoc = { ...ask, answerTo: { kind: "document", node: SHELF, title: "Review {{answer.at|date:YYYY-MM-DD}}" } } as const;
    const toAppend = { ...ask, answerTo: { kind: "append", to: { kind: "artifact", nodeId: SHELF, artifactId: DOC } } } as const;
    for (const action of [toSeat, toDoc, toAppend]) {
      expect(Schema.is(Action)(action)).toBe(true);
      expect(actionRefusal(action)).toBeUndefined();
    }
    const raiser = { automationId: RAISER, nodeId: NODE, author: { kind: "operator" }, trigger: { kind: "run" } } as unknown as Automation;
    expect(targetNodeIds({ ...raiser, then: [toSeat] })).toEqual([SEAT]);
    expect(targetNodeIds({ ...raiser, then: [toDoc] })).toEqual([SHELF]);
    expect(actionRefusal({ ...toSeat, signal: "notice" })).toMatchObject({ message: "a notice is read and cleared, so no answer comes back" });
    expect(actionRefusal({ ...toSeat, answerTo: { kind: "seat", to: { kind: "page", nodeId: SHELF } } })).toMatchObject({ message: "an answer goes to a seat as a prompt" });
    expect(actionRefusal({ ...toAppend, answerTo: { kind: "append", to: { kind: "seat", nodeId: SEAT } } })).toMatchObject({ message: "an answer is appended to an artifact" });
  });

  it("refuses two signal steps sharing an id", () => {
    const step = (id: string) => ({ kind: "signal", id, signal: "escalate", title: "Review?" }) as const;
    expect(stepIdRefusal({ then: [step("a"), step("b")] })).toBeUndefined();
    expect(stepIdRefusal({ then: [step("a"), step("a")] })).toMatchObject({ message: "two signal steps are named a" });
  });

  it("reads a stored work signal as an escalate, its due time gone with the kind", () => {
    const stored = {
      automationId: RAISER,
      nodeId: NODE,
      author: { kind: "operator" },
      version: 1,
      enabled: true,
      name: "Daily writing",
      trigger: { kind: "schedule", cron: "0 9 * * *", timezone: "UTC" },
      then: [{ kind: "signal", signal: "work", title: "Write 500 words", form: { kind: "text" }, work: { dueInMs: 3_600_000, urgent: true } }],
      limits: { minIntervalMs: 0, maxPerHour: 60 },
    };
    const read = decodeAutomation(stored);
    expect(Result.isSuccess(read) && read.success.then[0]).toEqual({ kind: "signal", signal: "escalate", title: "Write 500 words", form: { kind: "text" } });
  });
});

const signal = (over: Partial<AgentSignal> = {}): AgentSignal => ({
  signalId: SIGNAL_ID,
  canvasName: CANVAS,
  nodeId: NODE,
  source: {
    kind: "automation",
    automationId: RAISER,
    nodeId: NODE,
    firingId: FIRING_ID,
    step: { index: 1, id: "ask-review", raised: { "fired.at": "2026-10-29T09:00:00.000Z", "task.title": "Release notes" } },
  },
  kind: "escalate",
  text: "Review the release notes?",
  createdAt: ANSWERED_AT - 60_000,
  state: "answered",
  response: { text: "Ship it, fix the typo first", at: ANSWERED_AT },
  closedAt: ANSWERED_AT,
  ...over,
});

describe("an automation's signal answered (0.11/09 H1)", () => {
  it("is heard once answered, from an automation, as a seat's kind, with the step and values the signal carries", () => {
    const event = answeredChange(signal());
    expect(event).toMatchObject({ kind: "answered", key: `answered:${SIGNAL_ID}`, automationId: RAISER, nodeId: NODE, index: 1, step: "ask-review" });
    expect(event?.raised).toEqual({ "fired.at": "2026-10-29T09:00:00.000Z", "task.title": "Release notes" });
    expect(answeredChange(signal({ state: "dismissed" }))).toBeUndefined();
    expect(answeredChange(signal({ state: "open" }))).toBeUndefined();
    expect(answeredChange(signal({ kind: "notice" }))).toBeUndefined();
    expect(answeredChange(signal({ source: { kind: "seat", nodeId: SEAT } }))).toBeUndefined();
    // A stored work signal answered is an escalate.
    expect(answeredChange(signal({ kind: "work" }))?.signal.kind).toBe("escalate");
    // A signal raised before steps rode it: no step, no values, nothing invented.
    expect(answeredChange(signal({ source: { kind: "automation", automationId: RAISER, nodeId: NODE } }))).toMatchObject({ index: undefined, step: undefined, raised: {} });
  });

  it("fires the watch on its automation, narrowed to the step or kind", () => {
    const event = answeredChange(signal())! as ChangeEvent;
    const none = new Set<never>();
    expect(changeMatches(answeredWatch, event, none)).toBe(true);
    expect(changeMatches({ ...answeredWatch, step: "ask-review", signal: "escalate" }, event, none)).toBe(true);
    expect(changeMatches({ ...answeredWatch, step: "other" }, event, none)).toBe(false);
    expect(changeMatches({ ...answeredWatch, signal: "blocked" }, event, none)).toBe(false);
    expect(changeMatches({ ...answeredWatch, automation: { node: NODE, automationId: AutomationId.make("01M5ESKJFC1A88R1MH1NEZWJ2R") } }, event, none)).toBe(false);
  });

  it("says the answer, its signal and the raising firing's values; a secret only by name", () => {
    const event = answeredChange(signal())!;
    const value = (name: string, over: Partial<AgentSignal> = {}, delivering = false) =>
      firedValue(name as never, { event: answeredChange(signal(over)) ?? event, at: ANSWERED_AT + 5, delivering }, {}, undefined, CANVAS);
    expect(value("answer.text")).toBe("Ship it, fix the typo first");
    expect(value("answer.by")).toBe("operator");
    expect(value("answer.at")).toBe("2026-10-29T14:05:09.000Z");
    expect(value("answer.link")).toBe("");
    expect(value("signal.title")).toBe("Review the release notes?");
    expect(value("signal.kind")).toBe("escalate");
    expect(value("signal.link")).toBe(`[Review the release notes?](junto://canvas/${CANVAS}?node=${NODE})`);
    expect(value("raised.task.title")).toBe("Release notes");
    expect(value("raised.code.ticket")).toBeUndefined();
    // Its own fired.at is its own; delivering, the step's own values are the raising firing's.
    expect(value("fired.at")).toBe(new Date(ANSWERED_AT + 5).toISOString());
    expect(value("fired.at", {}, true)).toBe("2026-10-29T09:00:00.000Z");
    const secret = { text: "CLOUDFLARE_API_TOKEN is set", at: ANSWERED_AT, secret: { item: "op://x", name: "CLOUDFLARE_API_TOKEN", regionId: "r", machine: "mini", setAt: ANSWERED_AT } };
    expect(value("answer.text", { response: secret })).toBe("CLOUDFLARE_API_TOKEN is set");
    const handedIn = { text: "Written", at: ANSWERED_AT, artifact: { nodeId: SHELF, artifactId: DOC, title: "Notes", words: 600 } };
    expect(value("answer.link", { response: handedIn })).toBe(`[Notes](junto://canvas/${CANVAS}?node=${SHELF}&item=${DOC})`);
    expect(value("answer.link", { response: { text: "Done", at: ANSWERED_AT, links: ["https://a.example", "https://b.example"] } })).toBe(
      "https://a.example\nhttps://b.example",
    );
  });
});

// ── Delivery, through the runner ───────────────────────────────────────────

const box = (id: string, kind: NodeKind, x: number, y: number, width = 50, height = 50): ReachNode => ({ id: asNodeId(id), kind, x, y, width, height });
const canvas: ReachCanvas = {
  nodes: new Map(
    [box("A", "region", 0, 0, 400, 400), box("automations-1", "automations", 10, 10), box("seat-a", "agent", 100, 100), box("journal", "artifacts", 200, 200)].map(
      (n) => [n.id, n],
    ),
  ),
};

const raiser = (answerTo: NonNullable<Extract<Action, { readonly kind: "signal" }>["answerTo"]> | undefined, over: Partial<Automation> = {}): Automation => ({
  automationId: RAISER,
  nodeId: NODE,
  author: { kind: "operator" },
  version: AutomationVersion.make(1),
  name: "Release review",
  enabled: false,
  trigger: { kind: "schedule", cron: "0 9 * * *", timezone: "UTC" },
  then: [
    { kind: "mail", to: { kind: "seat", nodeId: SEAT }, text: "Notes are up" },
    { kind: "signal", id: "ask-review", signal: "escalate", title: "Review?", ...(answerTo === undefined ? {} : { answerTo }) },
  ],
  limits: { minIntervalMs: 0, maxPerHour: 1 },
  ...over,
});

const harness = async (...seeds: ReadonlyArray<Automation>) => {
  const database = new DatabaseSync(":memory:");
  database.exec(AUTOMATION_STATE_SCHEMA_SQL);
  const sql = Layer.effect(SqlClient.SqlClient, makeSqliteClient(database)).pipe(Layer.provide(Reactivity.layer));
  const runtime = ManagedRuntime.make(makeAutomationRepositoryLive().pipe(Layer.provideMerge(sql)));
  const performed: Array<{ readonly action: Action; readonly index: number; readonly said: string }> = [];
  let minted = 0;
  const ports: RunnerPorts = {
    canvas: () => canvas,
    holds: () => true,
    perform: (_canvas, automation, action, index, _firing, fired) =>
      Effect.sync(() => {
        const text = action.kind === "prompt" || action.kind === "append-artifact" ? action.text : action.kind === "create-artifact" ? `${action.title}\n${action.body}` : "";
        const said = resolveValues(text, (name) => firedValue(name, fired, {}, undefined, CANVAS), automation.trigger.kind === "schedule" ? automation.trigger.timezone : undefined);
        performed.push({ action, index, said });
        return { index, ruling: "applied" as const };
      }),
    mintFiringId: () => FiringId.make(`01M5ESKJFC1A88R1MH1NEZ${String(minted++).padStart(4, "0")}`),
    now: () => ANSWERED_AT + 1_000,
    runsHere: () => true,
  };
  const runner = makeAutomationRunner(ports);
  const go = <A, E>(effect: Effect.Effect<A, E, AutomationRepository>) => runtime.runPromise(effect);
  await go(Effect.flatMap(AutomationRepository, (r) => r.applyFacts(CANVAS, seeds.map((automation) => ({ fact: "automation.created" as const, automation, at: 0 })))));
  const history = () => go(Effect.flatMap(AutomationRepository, (r) => r.firings(CANVAS, { automationId: RAISER })));
  const close = async () => {
    await runtime.dispose();
    database.close();
  };
  return { runner, go, performed, history, close };
};

const heard = () => answeredChange(signal())!;

describe("delivering an answer where its step says (0.11/09 H1)", () => {
  it("writes a new document titled with its values, once, even with the automation off and at its limit", async () => {
    const h = await harness(raiser({ kind: "document", node: SHELF, title: "Review {{fired.at|date:YYYY-MM-DD}}, {{answer.by|upper}}" }));
    try {
      const fired = await h.go(h.runner.onAnswer(CANVAS, heard()));
      expect(fired).toMatchObject({ cause: { kind: "change", key: `answer:${SIGNAL_ID}` }, outcome: { kind: "fired", actions: [{ index: 1, ruling: "applied" }] } });
      expect(await h.go(h.runner.onAnswer(CANVAS, heard()))).toBeUndefined();
      expect(h.performed).toHaveLength(1);
      expect(h.performed[0]!.action).toMatchObject({ kind: "create-artifact", node: SHELF });
      expect(h.performed[0]!.said).toBe("Review 2026-10-29, OPERATOR\nShip it, fix the typo first");
      expect(await h.history()).toHaveLength(1);
    } finally {
      await h.close();
    }
  });

  it("prompts a seat with the signal and the answer, and appends a dated section to an artifact", async () => {
    const seat = await harness(raiser({ kind: "seat", to: { kind: "seat", nodeId: SEAT } }));
    try {
      await seat.go(seat.runner.onAnswer(CANVAS, heard()));
      expect(seat.performed[0]).toMatchObject({ action: { kind: "prompt", to: { kind: "seat", nodeId: SEAT } }, index: 1 });
      expect(seat.performed[0]!.said).toBe('The operator answered the escalate signal "Review the release notes?":\n\nShip it, fix the typo first');
    } finally {
      await seat.close();
    }
    const append = await harness(raiser({ kind: "append", to: { kind: "artifact", nodeId: SHELF, artifactId: DOC } }));
    try {
      await append.go(append.runner.onAnswer(CANVAS, heard()));
      expect(append.performed[0]!.said).toBe("## 2026-10-29 14:05\n\nShip it, fix the typo first");
    } finally {
      await append.close();
    }
  });

  it("finds the step by its id after an edit moved it, and does nothing for a step with nowhere to go", async () => {
    const moved = raiser({ kind: "document", node: SHELF, title: "Review" });
    const h = await harness({ ...moved, then: [moved.then[1]!, moved.then[0]!] });
    try {
      await h.go(h.runner.onAnswer(CANVAS, heard()));
      expect(h.performed[0]!.index).toBe(0);
    } finally {
      await h.close();
    }
    const quiet = await harness(raiser(undefined));
    try {
      expect(await quiet.go(quiet.runner.onAnswer(CANVAS, heard()))).toBeUndefined();
      expect(await quiet.history()).toEqual([]);
    } finally {
      await quiet.close();
    }
  });

  it("delivers when the raising firing is long gone from history: the signal carries what it needs", async () => {
    // This machine holds the raising automation and no firing of it at all, as after pruning.
    const h = await harness(raiser({ kind: "document", node: SHELF, title: "Review of {{task.title}}" }));
    try {
      expect(await h.history()).toEqual([]);
      await h.go(h.runner.onAnswer(CANVAS, heard()));
      expect(h.performed[0]!.said).toBe("Review of Release notes\nShip it, fix the typo first");
    } finally {
      await h.close();
    }
  });

  it("fires a watch on a machine that never ran the raising automation, with the step and values from the signal", async () => {
    // Only the listener lives here: no raising automation, no raising firing.
    const listener: Automation = {
      ...raiser(undefined),
      automationId: AutomationId.make("01M5ESKJFC1A88R1MH1NEZWJ2R"),
      name: "Write review",
      enabled: true,
      trigger: { kind: "change", on: { kind: "answered", automation: { node: NODE, automationId: RAISER }, step: "ask-review" } },
      then: [{ kind: "prompt", to: { kind: "seat", nodeId: SEAT }, text: "{{raised.task.title}}, {{raised.fired.at|date:YYYY-MM-DD}}: {{answer.text}}" }],
    };
    const h = await harness(listener);
    try {
      await h.go(h.runner.onChange(CANVAS, heard()));
      expect(h.performed.map((one) => one.said)).toEqual(["Release notes, 2026-10-29: Ship it, fix the typo first"]);
      await h.go(h.runner.onChange(CANVAS, heard()));
      expect(h.performed).toHaveLength(1);
    } finally {
      await h.close();
    }
  });

  it("delivers nothing out of reach, and records why", async () => {
    const h = await harness(raiser({ kind: "seat", to: { kind: "seat", nodeId: asNodeId("seat-gone") } }));
    try {
      expect(await h.go(h.runner.onAnswer(CANVAS, heard()))).toMatchObject({ outcome: { kind: "skipped", reason: "out_of_reach" } });
      expect(h.performed).toEqual([]);
    } finally {
      await h.close();
    }
  });

  it("builds a delivery that names the answer's values, never its words", () => {
    expect(answerDelivery({ kind: "document", node: SHELF, title: "T" }, true)).toEqual({
      kind: "create-artifact",
      node: SHELF,
      title: "T",
      body: "{{answer.text}}\n\n{{answer.link}}",
    });
  });
});
