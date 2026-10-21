import { Result } from "effect";
import { describe, expect, it } from "vitest";
import {
  decide,
  dueSlot,
  MISSED_SLOTS_COUNTED,
  nextSlot,
  signalWatchMatches,
  type Considered,
} from "../src/main/junto/automation/plan";
import { asNodeId } from "../src/shared/physics/schema";
import { type Automation, type AutomationWire, decodeAutomation } from "../src/shared/automation";

const at = (iso: string) => Date.parse(iso);
const MIN = 60_000;

const automation = (over: Partial<AutomationWire> = {}): Automation => {
  const result = decodeAutomation({
    automationId: "01M5ESKJFC1A88R1MH1NEZWJ2Q",
    nodeId: "automations-1",
    author: { kind: "operator" },
    version: 1,
    name: "Standup",
    enabled: true,
    trigger: { kind: "schedule", cron: "0 9 * * *", timezone: "UTC" },
    then: [{ kind: "mail", to: { kind: "seat", nodeId: "agent-a" }, text: "Plan?" }],
    limits: { minIntervalMs: MIN, maxPerHour: 3 },
    ...over,
  });
  if (Result.isFailure(result)) throw new Error(String(result.failure));
  return result.success;
};

const daily = { kind: "schedule", cron: "0 9 * * *", timezone: "UTC" } as const;
const everyMinute = { kind: "schedule", cron: "* * * * *", timezone: "UTC" } as const;
const poll = { kind: "poll", everyMs: 5 * MIN } as const;

describe("dueSlot, schedules", () => {
  it("is not due before the next slot", () => {
    expect(dueSlot(daily, at("2026-10-21T08:00:00Z"), at("2026-10-21T08:59:00Z"))).toBeUndefined();
  });

  it("is due at the slot, with nothing missed", () => {
    expect(dueSlot(daily, at("2026-10-21T08:00:00Z"), at("2026-10-21T09:00:30Z"))).toEqual({
      cause: { kind: "schedule", slot: at("2026-10-21T09:00:00Z"), missed: 0 },
    });
  });

  it("fires a missed schedule once, for its latest slot, counting the rest", () => {
    // Lid closed from Monday 08:00 to Thursday 10:00: Mon, Tue, Wed, Thu slots passed.
    expect(dueSlot(daily, at("2026-10-19T08:00:00Z"), at("2026-10-22T10:00:00Z"))).toEqual({
      cause: { kind: "schedule", slot: at("2026-10-22T09:00:00Z"), missed: 3 },
    });
  });

  it("never fires the cursor's own slot again", () => {
    expect(dueSlot(daily, at("2026-10-21T09:00:00Z"), at("2026-10-21T12:00:00Z"))).toBeUndefined();
  });

  it("bounds a long catch-up and still lands on the latest slot", () => {
    const due = dueSlot(everyMinute, at("2026-10-01T00:00:00Z"), at("2026-10-21T10:30:20Z"));
    expect(due).toEqual({ cause: { kind: "schedule", slot: at("2026-10-21T10:30:00Z"), missed: MISSED_SLOTS_COUNTED } });
  });
});

describe("dueSlot, across a fall-back hour", () => {
  it("computes from the last slot, so 01:45 fires once", () => {
    const fallBack = { kind: "schedule", cron: "45 1 * * *", timezone: "America/New_York" } as const;
    const first = dueSlot(fallBack, at("2026-11-01T04:00:00Z"), at("2026-11-01T06:10:00Z"));
    expect(first?.cause.slot).toBe(at("2026-11-01T05:45:00Z"));
    // The cursor moves to that slot; the second 01:45 (06:45Z) is never due.
    expect(dueSlot(fallBack, first!.cause.slot, at("2026-11-01T07:00:00Z"))).toBeUndefined();
    expect(nextSlot(fallBack, first!.cause.slot)).toBe(at("2026-11-02T06:45:00Z"));
  });
});

describe("dueSlot, polls", () => {
  it("aligns slots to the poll interval", () => {
    expect(nextSlot(poll, 7 * MIN)).toBe(10 * MIN);
    expect(nextSlot(poll, 10 * MIN)).toBe(15 * MIN);
  });

  it("fires the latest slot and counts the missed ones", () => {
    expect(dueSlot(poll, 0, 4 * MIN)).toBeUndefined();
    expect(dueSlot(poll, 0, 5 * MIN)).toEqual({ cause: { kind: "poll", slot: 5 * MIN, missed: 0 } });
    expect(dueSlot(poll, 0, 23 * MIN)).toEqual({ cause: { kind: "poll", slot: 20 * MIN, missed: 3 } });
  });
});

describe("decide", () => {
  const considered = (over: Partial<Considered> = {}): Considered => ({
    automation: automation(),
    cause: { kind: "schedule", slot: 0, missed: 0 },
    now: 10 * 60 * MIN,
    firedAt: [],
    inReach: true,
    conditionsHold: true,
    ...over,
  });

  it("fires when everything holds", () => {
    expect(decide(considered())).toEqual({ kind: "fire" });
  });

  it("skips a disabled automation, unless run by hand", () => {
    const off = automation({ enabled: false });
    expect(decide(considered({ automation: off }))).toEqual({ kind: "skip", reason: "disabled" });
    expect(decide(considered({ automation: off, cause: { kind: "run" } }))).toEqual({ kind: "fire" });
  });

  it("skips a webhook as not available", () => {
    const hook = automation({ trigger: { kind: "webhook", endpointId: "ep" } });
    expect(decide(considered({ automation: hook }))).toEqual({ kind: "skip", reason: "not_available" });
  });

  it("skips out of reach before conditions, and conditions before limits", () => {
    const now = 10 * 60 * MIN;
    const tooSoon = { now, firedAt: [now - 1] };
    expect(decide(considered({ ...tooSoon, inReach: false, conditionsHold: false }))).toEqual({
      kind: "skip",
      reason: "out_of_reach",
    });
    expect(decide(considered({ ...tooSoon, conditionsHold: false }))).toEqual({ kind: "skip", reason: "condition_unmet" });
    expect(decide(considered(tooSoon))).toEqual({ kind: "skip", reason: "min_interval" });
  });

  it("skips at the hourly cap and never disables", () => {
    const now = 10 * 60 * MIN;
    const three = [now - 30 * MIN, now - 20 * MIN, now - 10 * MIN];
    const result = decide(considered({ now, firedAt: three }));
    expect(result).toEqual({ kind: "skip", reason: "max_per_hour" });
    expect(decide(considered({ now: now + 31 * MIN, firedAt: three }))).toEqual({ kind: "fire" });
  });
});

describe("signalWatchMatches", () => {
  const a = asNodeId("agent-a");
  const b = asNodeId("agent-b");
  const targets = new Set([a]);

  it("matches a named seat only", () => {
    const watch = { kind: "signal", from: { kind: "seat", nodeId: a }, signal: "blocked" } as const;
    expect(signalWatchMatches(watch, { signal: "blocked", seat: a }, new Set())).toBe(true);
    expect(signalWatchMatches(watch, { signal: "blocked", seat: b }, new Set([a, b]))).toBe(false);
    expect(signalWatchMatches(watch, { signal: "feedback", seat: a }, targets)).toBe(false);
  });

  it("matches a from-less watch only from seats in the targets", () => {
    const watch = { kind: "signal", signal: "blocked" } as const;
    expect(signalWatchMatches(watch, { signal: "blocked", seat: a }, targets)).toBe(true);
    // A seat in a sibling region is not among the targets.
    expect(signalWatchMatches(watch, { signal: "blocked", seat: b }, targets)).toBe(false);
  });
});
