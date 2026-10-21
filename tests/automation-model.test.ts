import { Result, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  type Action,
  AutomationFiringsRequest,
  AutomationOp,
  automationShape,
  type AutomationId,
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
  type Automation,
} from "../src/shared/automation";
import { asNodeId } from "../src/shared/physics/schema";

const ULID_A = "01M5ESKJFC1A88R1MH1NEZWJ2Q";
const ULID_B = "01M5ESMJNGY0103BZJ3NYHP5GG";
const seat = (id: string) => ({ kind: "seat", nodeId: id }) as const;

const base = (over: Partial<AutomationWire> = {}): AutomationWire => ({
  automationId: ULID_A,
  nodeId: "automations-1",
  author: { kind: "operator" },
  version: 1,
  name: "Morning standup",
  enabled: true,
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
    expect(decodes(base()).trigger.kind).toBe("schedule");
  });

  it("decodes poll, change and webhook triggers", () => {
    expect(decodes(base({ trigger: { kind: "poll", everyMs: POLL_MIN_EVERY_MS } })).trigger.kind).toBe("poll");
    const on = { kind: "seat", seat: seat("agent-a"), becomes: "idle" } as const;
    expect(decodes(base({ trigger: { kind: "change", on } })).trigger.kind).toBe("change");
    expect(decodes(base({ trigger: { kind: "webhook", endpointId: "ep-1" } })).trigger.kind).toBe("webhook");
  });

  it("refuses a poll under the floor", () => {
    expect(refuses(base({ trigger: { kind: "poll", everyMs: POLL_MIN_EVERY_MS - 1 } }))).toBe(true);
  });

  it("refuses a bad cron and an unknown timezone", () => {
    expect(refuses(base({ trigger: { kind: "schedule", cron: "every morning", timezone: "UTC" } }))).toBe(true);
    expect(refuses(base({ trigger: { kind: "schedule", cron: "0 9 * * *", timezone: "Mars/Olympus" } }))).toBe(true);
  });

  it("refuses no action, and limits out of bounds", () => {
    expect(refuses(base({ then: [] }))).toBe(true);
    expect(refuses(base({ limits: { minIntervalMs: 0, maxPerHour: 0 } }))).toBe(true);
    expect(refuses(base({ limits: { minIntervalMs: -1, maxPerHour: 1 } }))).toBe(true);
    expect(refuses(base({ limits: { minIntervalMs: 0, maxPerHour: 61 } }))).toBe(true);
  });

  it("refuses an id that is not a ULID", () => {
    expect(refuses(base({ automationId: "auto-1" }))).toBe(true);
  });

  it("refuses an event as a condition", () => {
    const artifact = { kind: "artifact", nodeId: "art-1", artifactId: ULID_B };
    expect(refuses({ ...base(), when: [{ kind: "artifact", artifact, event: "edited", holds: true }] })).toBe(true);
    const ok = [{ kind: "seat", seat: seat("agent-a"), becomes: "idle", holds: true }];
    expect(decodes({ ...base(), when: ok }).when).toHaveLength(1);
  });

  it("refuses a comment on a seat", () => {
    expect(refuses({ ...base(), then: [{ kind: "comment", on: seat("agent-a"), text: "hi" }] })).toBe(true);
    const on = { kind: "page", nodeId: "page-1" } as const;
    expect(decodes(base({ then: [{ kind: "comment", on, anchor: { kind: "whole" }, text: "hi" }] })).then).toHaveLength(1);
  });

  it("refuses excess properties and an old task state", () => {
    expect(refuses({ ...base(), host: "mac-mini" })).toBe(true);
    const trigger = { kind: "change", on: { kind: "task", task: { node: "tasks-1" }, becomes: "failed" } };
    expect(refuses(base({ trigger } as Partial<AutomationWire>))).toBe(true);
  });

  it("refuses a firing with neither outcome", () => {
    const decode = Schema.decodeUnknownResult(Firing);
    const firing = { firingId: ULID_B, automationId: ULID_A, at: 1, cause: { kind: "run" } };
    expect(Result.isFailure(decode({ ...firing, outcome: { kind: "fired" } }))).toBe(true);
    expect(Result.isFailure(decode({ ...firing, outcome: { kind: "skipped", reason: "tired" } }))).toBe(true);
    expect(Result.isSuccess(decode({ ...firing, outcome: { kind: "skipped", reason: "max_per_hour" } }))).toBe(true);
    expect(Result.isSuccess(decode({ ...firing, outcome: { kind: "claimed" } }))).toBe(true);
    const missed = { ...firing, cause: { kind: "schedule", slot: 60_000, missed: 3 } };
    expect(Result.isSuccess(decode({ ...missed, outcome: { kind: "fired", actions: [{ index: 0, ruling: "queued" }] } }))).toBe(
      true,
    );
    const refused = (reason: string) => ({ ...firing, outcome: { kind: "fired", actions: [{ index: 0, ruling: "refused", reason }] } });
    expect(Result.isSuccess(decode(refused("not_in_reach")))).toBe(true);
    expect(Result.isFailure(decode(refused("because")))).toBe(true);
  });
});

describe("AutomationOp", () => {
  const decode = Schema.decodeUnknownResult(AutomationOp, { onExcessProperty: "error" });
  const { automationId, nodeId, author, version, enabled, ...definition } = base();

  it("decodes every verb", () => {
    for (const op of [
      { kind: "create", automationId, enabled, definition },
      { kind: "edit", baseVersion: 1, definition },
      { kind: "set-enabled", enabled: false },
      { kind: "archive" },
      { kind: "run" },
    ]) {
      expect(Result.isSuccess(decode(op)), op.kind).toBe(true);
    }
    expect([nodeId, author, version]).toHaveLength(3);
  });

  it("refuses enablement inside a definition: on and off is its own op", () => {
    expect(Result.isFailure(decode({ kind: "edit", baseVersion: 1, definition: { ...definition, enabled: true } }))).toBe(true);
    expect(Result.isFailure(decode({ kind: "create", automationId, definition }))).toBe(true);
  });

  it("refuses an edit without a base, a toggle with one, and an author in any op", () => {
    expect(Result.isFailure(decode({ kind: "edit", definition }))).toBe(true);
    expect(Result.isFailure(decode({ kind: "edit", baseVersion: 0, definition }))).toBe(true);
    expect(Result.isFailure(decode({ kind: "set-enabled", enabled: true, baseVersion: 1 }))).toBe(true);
    expect(Result.isFailure(decode({ kind: "create", automationId, enabled, definition: { ...definition, author } }))).toBe(true);
  });
});

describe("reads", () => {
  const decode = Schema.decodeUnknownResult(AutomationFiringsRequest);

  it("pages firings at most 100 at a time", () => {
    expect(Result.isSuccess(decode({ automationId: ULID_A, before: ULID_B, limit: 100 }))).toBe(true);
    expect(Result.isSuccess(decode({ automationId: ULID_A }))).toBe(true);
    expect(Result.isFailure(decode({ automationId: ULID_A, limit: 101 }))).toBe(true);
    expect(Result.isFailure(decode({ automationId: ULID_A, limit: 0 }))).toBe(true);
  });
});

describe("automationShape", () => {
  it("builds an input form over target text, same fields as the stored form", () => {
    const input = automationShape(Schema.String, Schema.String, Schema.String);
    const decoded = Schema.decodeUnknownResult(input.Definition)({
      name: "Ping",
      trigger: { kind: "poll", everyMs: POLL_MIN_EVERY_MS },
      then: [{ kind: "mail", to: "@product-feed", text: "ping" }],
      limits: DEFAULT_AUTOMATION_LIMITS,
    });
    expect(Result.isSuccess(decoded)).toBe(true);
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
          { kind: "comment", on: { kind: "artifact", nodeId: "art-1", artifactId: ULID_B }, text: "Done." },
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
    expect(limitSkip(limits, [now - 59_999], now)).toBe("min_interval");
    expect(limitSkip(limits, [now - 60_000], now)).toBeUndefined();
  });

  it("skips while the clock has stepped back behind the last firing", () => {
    expect(limitSkip({ minIntervalMs: 0, maxPerHour: 60 }, [now + 5 * 60_000], now)).toBe("min_interval");
  });

  it("skips at the hourly cap and counts only the last hour", () => {
    expect(limitSkip(limits, [now - 50 * 60_000, now - 30 * 60_000, now - 10 * 60_000], now)).toBe("max_per_hour");
    expect(limitSkip(limits, [now - 61 * 60_000, now - 30 * 60_000, now - 10 * 60_000], now)).toBeUndefined();
  });
});

describe("type-level", () => {
  it("refuses misuse at compile time", () => {
    const at = asNodeId("a");
    // @ts-expect-error a bare string is not an AutomationId
    const id: AutomationId = ULID_A;
    // @ts-expect-error an artifact event is not a condition
    const event: Condition = { kind: "artifact", artifact: { kind: "page", nodeId: at }, event: "edited", holds: true };
    // @ts-expect-error a condition must hold
    const unheld: Condition = { kind: "seat", seat: { kind: "seat", nodeId: at }, becomes: "idle", holds: false };
    // @ts-expect-error a seat state is a held state, never raw
    const raw: Condition = { kind: "seat", seat: { kind: "seat", nodeId: at }, becomes: "unknown", holds: true };
    // @ts-expect-error triggers are a closed union
    const trigger: Trigger = { kind: "interval", everyMs: 60_000 };
    // @ts-expect-error actions are a closed union
    const action: Action = { kind: "wake", to: { kind: "seat", nodeId: at } };
    // @ts-expect-error an edit names the head it replaces
    const edit: AutomationOp = { kind: "edit", definition: base() };
    // @ts-expect-error a seat takes no comment
    const comment: Action = { kind: "comment", on: { kind: "seat", nodeId: at }, text: "hi" };
    expect([id, event, unheld, raw, trigger, action, edit, comment]).toHaveLength(8);
  });
});
