import { describe, expect, expectTypeOf, it } from "vitest";
import { Result, Schema } from "effect";
import {
  AUTOMATION_READ_OPS,
  AUTOMATION_WRITE_OPS,
  AutomationCreateArgs,
  AutomationCreateCliArgs,
  AutomationEditCliArgs,
  AutomationHistoryArgs,
  AutomationListArgs,
  AutomationVersion,
  DefinitionInput,
  OpId,
  TargetText,
  definitionOf,
  editedDefinition,
  isAutomationReadOp,
  isAutomationWriteOp,
  reservedTriggerRefusal,
  resolveTargets,
  type AutomationDisposition,
  type AutomationWriteResult,
  type TargetResolver,
  type TargetWant,
} from "../src/shared/automation-control";
import { AutomationId, POLL_MIN_EVERY_MS, type TriggerKind } from "../src/shared/automation";
import type { MentionRef } from "../src/shared/mention";
import { asNodeId } from "../src/shared/physics/schema";
import { ItemId } from "../src/shared/work-ids";
import type { WorkErrorBody } from "../src/shared/work-control";

const decode = <S extends Schema.Top>(schema: S) => (value: unknown) =>
  Schema.decodeUnknownResult(schema as never)(value) as Result.Result<S["Type"], unknown>;

const ok = <S extends Schema.Top>(schema: S, value: unknown): S["Type"] => {
  const out = decode(schema)(value);
  if (Result.isFailure(out)) throw new Error(String(out.failure));
  return out.success;
};

const refused = (schema: Schema.Top, value: unknown): boolean => Result.isFailure(decode(schema)(value));

const OP = "01M5ESM1XHCJ7JYJDBC37MREBZ";
const ID = "01M5ESMQ2ZT55QZ073EWPH10SG";

const draft = {
  target: "Automations",
  name: "nightly review",
  trigger: { kind: "schedule", cron: "0 9 * * 1-5", timezone: "America/Sao_Paulo" },
  when: [{ kind: "seat", seat: "@cli-lead", becomes: "idle", holds: true }],
  then: [
    { kind: "mail", to: "@cli-lead", text: "Nightly review is due" },
    { kind: "create-task", node: "CLI tasks", title: "Review the night's commits", assign: "@cli-overseer" },
    { kind: "assign-task", task: "#42", to: "@cli-external" },
    { kind: "comment", on: "junto://canvas?node=artifacts-1&item=01M5ESMQ2ZT55QZ073EWPH10SG", text: "Looked at it" },
  ],
};

describe("automation input", () => {
  it("takes a definition with @name, #number and junto:// targets", () => {
    const value = ok(AutomationCreateCliArgs, draft);
    expect(value.then).toHaveLength(4);
    expect(value.enabled).toBeUndefined();
  });

  it("refuses target text that names nothing a seat could mean", () => {
    for (const text of ["cli-lead", "@", "#", "# 42", "http://example.com", ""]) {
      expect(refused(TargetText, text), text).toBe(true);
    }
    for (const text of ["@cli-lead", "@Product Feed", "#42", "#T-42", "junto://canvas?node=a"]) {
      expect(refused(TargetText, text), text).toBe(false);
    }
  });

  it("refuses a poll faster than the floor, an empty then, and unknown fields", () => {
    expect(refused(AutomationCreateCliArgs, { ...draft, trigger: { kind: "poll", everyMs: POLL_MIN_EVERY_MS - 1 } })).toBe(true);
    expect(refused(AutomationCreateCliArgs, { ...draft, trigger: { kind: "poll", everyMs: POLL_MIN_EVERY_MS } })).toBe(false);
    expect(refused(AutomationCreateCliArgs, { ...draft, then: [] })).toBe(true);
    expect(refused(AutomationCreateCliArgs, { ...draft, host: "mini" })).toBe(true);
  });

  it("decodes a webhook trigger so main can refuse it by name", () => {
    const value = ok(AutomationCreateCliArgs, { ...draft, trigger: { kind: "webhook", endpointId: "gh" } });
    const resolved = resolveTargets({ trigger: value.trigger }, resolver());
    if (!resolved.ok || resolved.value.trigger === undefined) throw new Error("unresolved");
    expect(reservedTriggerRefusal(resolved.value.trigger)).toMatchObject({
      type: "InputError",
      details: { reason: "not_available", path: "trigger.kind" },
    });
    expect(reservedTriggerRefusal({ kind: "poll", everyMs: POLL_MIN_EVERY_MS })).toBeUndefined();
  });

  it("needs the ids the CLI mints on the wire, and never from a seat", () => {
    expect(refused(AutomationCreateArgs, { ...draft, enabled: false, limits: { minIntervalMs: 0, maxPerHour: 1 } })).toBe(true);
    const wire = ok(AutomationCreateArgs, {
      ...draft, opId: OP, automationId: ID, enabled: false, limits: { minIntervalMs: 0, maxPerHour: 1 },
    });
    expect(wire.opId).toBe(OP);
    expect(refused(OpId, "op-1")).toBe(true);
  });

  it("makes an edit carry its base version", () => {
    const edit = { target: "Automations", automation: "nightly review", change: { name: "weekly review" } };
    expect(refused(AutomationEditCliArgs, edit)).toBe(true);
    expect(refused(AutomationEditCliArgs, { ...edit, baseVersion: 3 })).toBe(false);
    expect(refused(AutomationEditCliArgs, { ...edit, baseVersion: 0 })).toBe(true);
    expect(refused(AutomationEditCliArgs, { ...edit, baseVersion: "3" })).toBe(true);
  });

  it("bounds history pages and lets list name no node", () => {
    expect(refused(AutomationHistoryArgs, { target: "Automations", limit: 201 })).toBe(true);
    expect(refused(AutomationListArgs, {})).toBe(false);
  });
});

const seat = (nodeId: string): MentionRef => ({ kind: "seat", nodeId: asNodeId(nodeId) });
const TASK = ItemId.make("01M5ETAKR8YSPP5Y22H4KH2YMW");
const ARTIFACT = ItemId.make("01M5ESMQ2ZT55QZ073EWPH10SG");

const resolver = (seen: Array<[string, TargetWant | "node", string]> = []): TargetResolver => ({
  ref: (text, want, path) => {
    seen.push([text, want, path]);
    if (text === "@nobody") return { type: "UnknownTarget", message: "no seat named nobody", details: { path } };
    if (want === "seat") return seat(`agent-${text.slice(1)}`);
    if (want === "task") return { kind: "task", nodeId: asNodeId("task-1"), taskId: TASK };
    return { kind: "artifact", nodeId: asNodeId("artifacts-1"), artifactId: ARTIFACT };
  },
  node: (text, path) => {
    seen.push([text, "node", path]);
    return asNodeId(`node:${text}`);
  },
});

describe("resolveTargets", () => {
  it("resolves every target position by what it must name", () => {
    const value = ok(AutomationCreateCliArgs, draft);
    const seen: Array<[string, TargetWant | "node", string]> = [];
    const out = resolveTargets(value, resolver(seen));
    expect(out.ok).toBe(true);
    expect(seen).toEqual([
      ["@cli-lead", "seat", "when[0].seat"],
      ["@cli-lead", "seat", "then[0].to"],
      ["CLI tasks", "node", "then[1].node"],
      ["@cli-overseer", "seat", "then[1].assign"],
      ["#42", "task", "then[2].task"],
      ["@cli-external", "seat", "then[2].to"],
      [draft.then[3]!.on, "subject", "then[3].on"],
    ]);
    if (!out.ok) return;
    expect(out.value.when).toEqual([{ kind: "seat", seat: seat("agent-cli-lead"), becomes: "idle", holds: true }]);
    expect(out.value.then?.[1]).toEqual({
      kind: "create-task", node: "node:CLI tasks", title: "Review the night's commits", assign: seat("agent-cli-overseer"),
    });
  });

  it("resolves a change trigger's watch, and a task watch over a whole node", () => {
    const value = ok(AutomationCreateCliArgs, {
      ...draft,
      trigger: { kind: "change", on: { kind: "task", task: { node: "CLI tasks" }, becomes: "in-review" } },
    });
    const out = resolveTargets({ trigger: value.trigger }, resolver());
    expect(out).toEqual({
      ok: true,
      value: { trigger: { kind: "change", on: { kind: "task", task: { node: "node:CLI tasks" }, becomes: "in-review" } } },
    });
  });

  it("stops at the first refusal and keeps its path", () => {
    const value = ok(AutomationCreateCliArgs, {
      ...draft,
      then: [{ kind: "mail", to: "@nobody", text: "hi" }, { kind: "mail", to: "@nobody", text: "again" }],
    });
    const out = resolveTargets(value, resolver());
    expect(out).toEqual({
      ok: false,
      error: { type: "UnknownTarget", message: "no seat named nobody", details: { path: "then[0].to" } },
    });
  });

  it("leaves out what an edit did not change", () => {
    expect(resolveTargets({}, resolver())).toEqual({ ok: true, value: {} });
  });

  it("builds the stored definition a create rules on", () => {
    const { when: _when, ...unconditional } = draft;
    const wire = ok(AutomationCreateArgs, {
      ...unconditional, opId: OP, automationId: ID, enabled: true, limits: { minIntervalMs: 0, maxPerHour: 2 },
    });
    const out = resolveTargets(wire, resolver());
    if (!out.ok || out.value.trigger === undefined || out.value.then === undefined) throw new Error("unresolved");
    const definition = definitionOf(wire, { trigger: out.value.trigger, then: out.value.then });
    expect(definition).not.toHaveProperty("when");
    expect(definition).not.toHaveProperty("enabled");
  });
});

describe("automation ops", () => {
  it("lets seats read and leaves every write to the overseer plane", () => {
    expect(AUTOMATION_READ_OPS.some((op) => isAutomationWriteOp(op))).toBe(false);
    expect(AUTOMATION_WRITE_OPS.some((op) => isAutomationReadOp(op))).toBe(false);
    expect(isAutomationWriteOp("automation.archive")).toBe(true);
    expect(isAutomationReadOp("automation.history")).toBe(true);
  });
});

describe("editedDefinition", () => {
  const head = {
    automationId: AutomationId.make(ID),
    nodeId: asNodeId("AU"),
    author: { kind: "operator" as const },
    version: AutomationVersion.make(2),
    enabled: true,
    name: "nightly",
    trigger: { kind: "poll" as const, everyMs: POLL_MIN_EVERY_MS },
    when: [{ kind: "seat" as const, seat: seat("S1"), becomes: "idle" as const, holds: true as const }],
    then: [{ kind: "mail" as const, to: seat("S1"), text: "hi" }],
    limits: { minIntervalMs: 0, maxPerHour: 1 },
  };

  it("replaces what the change names and keeps the rest", () => {
    expect(editedDefinition(head, { name: "weekly" }, {})).toEqual({
      name: "weekly", trigger: head.trigger, when: head.when, then: head.then, limits: head.limits,
    });
  });

  it("clears the conditions on when: []", () => {
    expect(editedDefinition(head, {}, { when: [] })).not.toHaveProperty("when");
  });
});

describe("automation types", () => {
  it("never takes a bare string for a minted id, nor a bare number for a version", () => {
    expectTypeOf<string>().not.toMatchTypeOf<OpId>();
    expectTypeOf<string>().not.toMatchTypeOf<AutomationId>();
    expectTypeOf<number>().not.toMatchTypeOf<AutomationVersion>();
    // @ts-expect-error an edit's base version is branded
    const bad: typeof AutomationEditCliArgs.Type = { target: "a", automation: "b", baseVersion: 1, change: {} };
    void bad;
  });

  it("gives a queued write no version, and has no refused result", () => {
    expectTypeOf<AutomationDisposition>().toEqualTypeOf<"applied" | "queued">();
    type Queued = Extract<AutomationWriteResult, { disposition: "queued" }>;
    expectTypeOf<Queued>().not.toHaveProperty("version");
    // @ts-expect-error a refusal is the typed error, not a result
    const refusedResult: AutomationWriteResult = { disposition: "refused", opId: OP as OpId, error: {} as WorkErrorBody };
    void refusedResult;
  });

  it("closes the trigger kinds", () => {
    type InputKind = (typeof DefinitionInput.Type)["trigger"]["kind"];
    expectTypeOf<InputKind>().toEqualTypeOf<TriggerKind>();
  });
});
