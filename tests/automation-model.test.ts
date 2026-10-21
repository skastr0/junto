import { Result, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  type Action,
  type Automation,
  AutomationId,
  type AutomationWire,
  type Condition,
  decodeAutomation,
  DEFAULT_AUTOMATION_LIMITS,
  Firing,
  limitSkip,
  POLL_MIN_EVERY_MS,
  targetNodeIds,
  type Trigger,
  triggerRefusal,
} from "../src/shared/automation";
import { asNodeId } from "../src/shared/physics/schema";

const seat = (id: string) => ({ kind: "seat", nodeId: id }) as const;

const base = (over: Partial<AutomationWire> = {}): AutomationWire => ({
  automationId: "auto-1",
  nodeId: "automations-1",
  name: "Morning standup",
  enabled: true,
  author: { kind: "operator" },
  trigger: { kind: "schedule", cron: "0 9 * * 1-5", timezone: "America/Sao_Paulo" },
  then: [{ kind: "mail", to: seat("agent-a"), text: "Post your plan for today." }],
  limits: DEFAULT_AUTOMATION_LIMITS,
  ...over,
});

const decodes = (input: unknown): Automation => {
  const result = decodeAutomation(input);
  if (Result.isFailure(result)) throw new Error(String(result.failure));
  return result.success;
};
const refuses = (input: unknown): boolean => Result.isFailure(decodeAutomation(input));

describe("Automation schema", () => {
  it("decodes a schedule automation", () => {
    const automation = decodes(base());
    expect(automation.trigger.kind).toBe("schedule");
  });

  it("decodes poll, change and webhook triggers", () => {
    expect(decodes(base({ trigger: { kind: "poll", everyMs: POLL_MIN_EVERY_MS } })).trigger.kind).toBe("poll");
    expect(
      decodes(base({ trigger: { kind: "change", on: { kind: "seat", seat: seat("agent-a"), becomes: "idle" } } }))
        .trigger.kind,
    ).toBe("change");
    expect(decodes(base({ trigger: { kind: "webhook", endpointId: "ep-1" } })).trigger.kind).toBe("webhook");
  });

  it("refuses a poll under the floor", () => {
    expect(refuses(base({ trigger: { kind: "poll", everyMs: POLL_MIN_EVERY_MS - 1 } }))).toBe(true);
  });

  it("refuses a bad cron and an unknown timezone", () => {
    expect(refuses(base({ trigger: { kind: "schedule", cron: "every morning", timezone: "UTC" } }))).toBe(true);
    expect(refuses(base({ trigger: { kind: "schedule", cron: "0 9 * * *", timezone: "Mars/Olympus" } }))).toBe(true);
  });

  it("refuses an automation with no action, and limits out of bounds", () => {
    expect(refuses(base({ then: [] }))).toBe(true);
    expect(refuses(base({ limits: { minIntervalMs: 0, maxPerHour: 0 } }))).toBe(true);
    expect(refuses(base({ limits: { minIntervalMs: -1, maxPerHour: 1 } }))).toBe(true);
    expect(refuses(base({ limits: { minIntervalMs: 0, maxPerHour: 61 } }))).toBe(true);
  });

  it("refuses an event as a condition", () => {
    const when = [{ kind: "artifact", artifact: { kind: "artifact", nodeId: "art-1", artifactId: "a" }, event: "edited", holds: true }];
    expect(refuses({ ...base(), when })).toBe(true);
    const ok = [{ kind: "seat", seat: seat("agent-a"), becomes: "idle", holds: true }];
    expect(decodes({ ...base(), when: ok }).when).toHaveLength(1);
  });

  it("refuses excess properties and an old task state", () => {
    expect(refuses({ ...base(), host: "mac-mini" })).toBe(true);
    const trigger = { kind: "change", on: { kind: "task", task: { node: "tasks-1" }, becomes: "failed" } };
    expect(refuses(base({ trigger } as Partial<AutomationWire>))).toBe(true);
  });

  it("refuses a firing with neither outcome", () => {
    const decode = Schema.decodeUnknownResult(Firing);
    const firing = { firingId: "f-1", automationId: "auto-1", at: 1, cause: { kind: "run" } };
    expect(Result.isFailure(decode({ ...firing, outcome: { kind: "fired" } }))).toBe(true);
    expect(Result.isFailure(decode({ ...firing, outcome: { kind: "skipped", reason: "tired" } }))).toBe(true);
    expect(Result.isSuccess(decode({ ...firing, outcome: { kind: "skipped", reason: "max-per-hour" } }))).toBe(true);
  });
});

describe("triggerRefusal", () => {
  it("refuses only webhooks in 0.10", () => {
    expect(triggerRefusal({ kind: "webhook", endpointId: "ep" })).toBe("not_available");
    expect(triggerRefusal(decodes(base()).trigger)).toBeUndefined();
  });
});

describe("targetNodeIds", () => {
  it("collects every node a trigger, condition and action names, once", () => {
    const automation = decodes(
      base({
        trigger: { kind: "change", on: { kind: "task", task: { node: "tasks-1" }, becomes: "done" } },
        when: [{ kind: "seat", seat: seat("agent-a"), becomes: "idle", holds: true }],
        then: [
          { kind: "mail", to: seat("agent-a"), text: "Next one is yours." },
          { kind: "create-task", node: "tasks-2", title: "Review", assign: seat("agent-b") },
          { kind: "comment", on: { kind: "artifact", nodeId: "art-1", artifactId: "doc" }, text: "Done." },
        ],
      }),
    );
    expect([...targetNodeIds(automation)].sort()).toEqual(["agent-a", "agent-b", "art-1", "tasks-1", "tasks-2"]);
  });
});

describe("limitSkip", () => {
  const limits = { minIntervalMs: 60_000, maxPerHour: 3 };
  const now = 10 * 60 * 60_000;

  it("allows the first firing", () => {
    expect(limitSkip(limits, [], now)).toBeUndefined();
  });

  it("skips inside the minimum interval", () => {
    expect(limitSkip(limits, [now - 59_999], now)).toBe("min-interval");
    expect(limitSkip(limits, [now - 60_000], now)).toBeUndefined();
  });

  it("skips at the hourly cap and counts only the last hour", () => {
    const three = [now - 50 * 60_000, now - 30 * 60_000, now - 10 * 60_000];
    expect(limitSkip(limits, three, now)).toBe("max-per-hour");
    const old = [now - 61 * 60_000, now - 30 * 60_000, now - 10 * 60_000];
    expect(limitSkip(limits, old, now)).toBeUndefined();
  });
});

describe("type-level", () => {
  it("refuses misuse at compile time", () => {
    // @ts-expect-error a bare string is not an AutomationId
    const id: AutomationId = "auto-1";
    // @ts-expect-error an artifact event is not a condition
    const condition: Condition = { kind: "artifact", artifact: { kind: "artifact", nodeId: asNodeId("a"), artifactId: "x" }, event: "edited", holds: true };
    // @ts-expect-error a condition must hold
    const unheld: Condition = { kind: "seat", seat: { kind: "seat", nodeId: asNodeId("a") }, becomes: "idle", holds: false };
    // @ts-expect-error triggers are a closed union
    const trigger: Trigger = { kind: "interval", everyMs: 60_000 };
    // @ts-expect-error actions are a closed union
    const action: Action = { kind: "wake", to: { kind: "seat", nodeId: asNodeId("a") } };
    // @ts-expect-error a seat state is a held state, never raw
    const raw: Condition = { kind: "seat", seat: { kind: "seat", nodeId: asNodeId("a") }, becomes: "unknown", holds: true };
    expect([id, condition, unheld, trigger, action, raw]).toHaveLength(6);
    expect(AutomationId.make("auto-1")).toBe("auto-1");
  });
});
