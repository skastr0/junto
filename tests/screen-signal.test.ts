/**
 * The screen channel emits seat signals (docs/harness-domain.md, build step 2).
 *
 * Every rule in every pack means a signal, and that signal projects back to
 * the state the rule declares, so the five-value seat state is unchanged
 * while it is derived from SeatStatus. Named groups in a rule's patterns fill
 * the signal's fields.
 */
import { describe, expect, it } from "vitest";
import {
  SeatStateMachine,
  evaluate,
  rulePackFor,
} from "../src/main/junto/term/agent-state";
import { projectAgentSeatState } from "../src/main/junto/term/agent-state/projection";
import {
  factSignal,
  parseResetAt,
  processTimeZone,
  parseScreenDuration,
  parseScreenNumber,
  retryCause,
  ruleSignal,
  signalForState,
} from "../src/main/junto/term/agent-state/screen-signal";
import type { SeatRulePack } from "../src/main/junto/term/agent-state/types";
import type { ObserverGridSnapshot } from "../src/main/junto/term/observer/types";
import {
  initialSnapshot,
  reduceSeat,
  type BindingId,
  type HarnessSignal,
  type SeatSnapshot,
} from "../src/shared/harness-domain";
import { HARNESS_IDS } from "../src/shared/managed-terminal-templates";

const SEAT = "b1" as BindingId;
const NOW = new Date(2026, 9, 16, 14, 0, 0, 0).getTime();

const snap = (lines: readonly string[], title = ""): ObserverGridSnapshot => ({
  cols: 80,
  rows: 24,
  lines,
  text: lines.join("\n"),
  signals: {
    title,
    osc9: "",
    modes: { bracketedPaste: false, synchronizedOutput: false, altScreen: false, mouseModes: [] },
  },
  seq: 1n,
  epoch: "e1",
  bindingId: SEAT,
});

const screenFold = (snapshot: SeatSnapshot, signal: HarnessSignal, at = NOW): SeatSnapshot =>
  reduceSeat(snapshot, { seat: SEAT, at, source: "screen", fidelity: "screen", signal });

/** The statuses a screen read can find a seat in. */
const PRIORS: ReadonlyArray<readonly [string, SeatSnapshot]> = [
  ["Starting", initialSnapshot(SEAT, NOW - 10)],
  ["Idle", screenFold(initialSnapshot(SEAT, NOW - 10), signalForState("idle"), NOW - 5)],
  ["Working", screenFold(initialSnapshot(SEAT, NOW - 10), signalForState("working"), NOW - 5)],
  [
    "Blocked",
    screenFold(initialSnapshot(SEAT, NOW - 10), { _tag: "PermissionRequested" }, NOW - 5),
  ],
  ["Unknown", screenFold(initialSnapshot(SEAT, NOW - 10), signalForState("unknown"), NOW - 5)],
];

describe("every rule means a signal that projects to its state", () => {
  for (const harness of HARNESS_IDS) {
    for (const rule of rulePackFor(harness).rules) {
      if (rule.skipStateUpdate) continue;
      it(`${harness} ${rule.id} (${rule.state})`, () => {
        const signal = ruleSignal(rule, { groups: {}, matched: null }, { now: NOW });
        // The declared template reads as a signal: no fallback to the state's.
        expect(signal._tag).toBe((rule.signal ?? signalForState(rule.state))._tag);
        for (const [name, prior] of PRIORS) {
          expect(projectAgentSeatState(screenFold(prior, signal)), `from ${name}`).toBe(rule.state);
        }
      });
    }
  }
});

describe("every fact rule means a signal that leaves the status as it was", () => {
  for (const harness of HARNESS_IDS) {
    for (const rule of rulePackFor(harness).facts ?? []) {
      it(`${harness} ${rule.id}`, () => {
        const signal = factSignal(rule, { groups: {}, matched: null }, { now: NOW });
        expect(signal?._tag).toBe(rule.signal._tag);
        for (const [name, prior] of PRIORS) {
          expect(screenFold(prior, signal!).status, `from ${name}`).toEqual(prior.status);
        }
      });
    }
  }
});

describe("named captures fill the signal", () => {
  const limitPack: SeatRulePack = {
    harness: "codex",
    version: "test",
    rules: [
      {
        id: "usage_limit",
        state: "attention",
        priority: 100,
        region: "whole_recent",
        visibleAttention: true,
        signal: { _tag: "UsageLimitHit", scope: "5h" },
        matchers: { regex: ["usage limit\\. Resets (?<resetsAt>[^\\n]+)"] },
      },
    ],
  };

  it("a reset time on the screen becomes resetsAt, and the matched text the message", () => {
    const evaluation = evaluate(snap(["■ You've hit your usage limit. Resets 3pm"]), {
      harness: "codex",
      pack: limitPack,
      now: NOW,
    });
    expect(evaluation.state).toBe("attention");
    expect(evaluation.source).toBe("screen");
    expect(evaluation.fidelity).toBe("screen");
    expect(evaluation.signal).toEqual({
      _tag: "UsageLimitHit",
      scope: "5h",
      resetsAt: new Date(2026, 9, 16, 15, 0, 0, 0).getTime(),
      message: "usage limit. Resets 3pm",
    });
  });

  it("a capture that does not read as its field costs that field, never the signal", () => {
    const evaluation = evaluate(snap(["You've hit your usage limit. Resets soon"]), {
      harness: "codex",
      pack: limitPack,
      now: NOW,
    });
    expect(evaluation.signal).toEqual({
      _tag: "UsageLimitHit",
      scope: "5h",
      message: "usage limit. Resets soon",
    });
  });

  it("pi's retry line reads attempt, max and delay", () => {
    const evaluation = evaluate(snap(["", "Retrying (2/5) in 4s..."]), { harness: "pi", now: NOW });
    expect(evaluation.state).toBe("working");
    expect(evaluation.ruleId).toBe("retry_status");
    expect(evaluation.signal).toEqual({
      _tag: "Retrying",
      cause: "unknown",
      attempt: 2,
      max: 5,
      retryInMs: 4_000,
    });
  });

  it("an untyped rule emits the signal its state stands for", () => {
    const evaluation = evaluate(snap(["nothing this pack knows"]), { harness: "codex", pack: limitPack, now: NOW });
    expect(evaluation.state).toBe("idle");
    expect(evaluation.signal).toEqual({ _tag: "ActivityObserved", activity: "idle" });
  });
});

describe("reading times, durations and numbers off a screen", () => {
  it("reset times", () => {
    expect(parseResetAt("3pm", NOW)).toBe(new Date(2026, 9, 16, 15, 0).getTime());
    expect(parseResetAt("at 3:30 PM", NOW)).toBe(new Date(2026, 9, 16, 15, 30).getTime());
    expect(parseResetAt("15:45", NOW)).toBe(new Date(2026, 9, 16, 15, 45).getTime());
    // A clock time already past is tomorrow's.
    expect(parseResetAt("1pm", NOW)).toBe(new Date(2026, 9, 17, 13, 0).getTime());
    expect(parseResetAt("in 2h 30m", NOW)).toBe(NOW + 9_000_000);
    expect(parseResetAt("2026-10-17T09:00:00Z", NOW)).toBe(Date.parse("2026-10-17T09:00:00Z"));
    expect(parseResetAt("soon", NOW)).toBeUndefined();
    expect(parseResetAt("13pm", NOW)).toBeUndefined();
    expect(parseResetAt("3", NOW)).toBeUndefined();
  });

  it("dated and zoned reset times, as Claude and Codex print them", () => {
    const utcNow = Date.UTC(2026, 9, 16, 3, 0);
    expect(parseResetAt("6:23am (UTC)", utcNow)).toBe(Date.UTC(2026, 9, 16, 6, 23));
    expect(parseResetAt("2am (UTC)", utcNow)).toBe(Date.UTC(2026, 9, 17, 2, 0));
    expect(parseResetAt("Oct 21 at 6:23am (UTC)", utcNow)).toBe(Date.UTC(2026, 9, 21, 6, 23));
    // Lisbon is UTC+1 in October.
    expect(parseResetAt("3pm (Europe/Lisbon)", utcNow)).toBe(Date.UTC(2026, 9, 16, 14, 0));
    // No zone: the machine's own.
    expect(parseResetAt("Oct 21st, 2026 6:25 AM", utcNow)).toBe(new Date(2026, 9, 21, 6, 25).getTime());
    // A date already past this year is next year's.
    expect(parseResetAt("Jan 2 at 9am (UTC)", utcNow)).toBe(Date.UTC(2027, 0, 2, 9, 0));
    expect(parseResetAt("6:23am (Mars/Base)", utcNow)).toBeUndefined();
    // A bare time reads in the seat process's zone; a named one wins over it.
    expect(parseResetAt("6:25 AM", utcNow, "America/Sao_Paulo")).toBe(Date.UTC(2026, 9, 16, 9, 25));
    expect(parseResetAt("Oct 21st, 2026 6:25 AM", utcNow, "America/Sao_Paulo")).toBe(Date.UTC(2026, 9, 21, 9, 25));
    expect(parseResetAt("6:23am (UTC)", utcNow, "America/Sao_Paulo")).toBe(Date.UTC(2026, 9, 16, 6, 23));
    expect(parseResetAt("Smarch 3 at 9am", utcNow)).toBeUndefined();
  });

  it("a process TZ reads as a zone only when it is one", () => {
    expect(processTimeZone(":America/Sao_Paulo")).toBe("America/Sao_Paulo");
    expect(processTimeZone("UTC")).toBe("UTC");
    expect(processTimeZone("Mars/Base")).toBeUndefined();
    expect(processTimeZone(undefined)).toBeUndefined();
  });

  it("retry causes", () => {
    expect(retryCause("529 Overloaded")).toBe("overloaded");
    expect(retryCause("429 Rate limit reached for requests per minute.")).toBe("rate");
    expect(retryCause("Connection dropped (ECONNRESET)")).toBe("network");
    expect(retryCause("500 Internal server error")).toBe("server");
    expect(retryCause("API error")).toBe("unknown");
  });

  it("durations", () => {
    expect(parseScreenDuration("4s...")).toBe(4_000);
    expect(parseScreenDuration("1m 30s")).toBe(90_000);
    expect(parseScreenDuration("2 hours and 5 minutes")).toBe(7_500_000);
    expect(parseScreenDuration("250ms")).toBe(250);
    expect(parseScreenDuration("4 parsecs")).toBeUndefined();
    expect(parseScreenDuration("soon")).toBeUndefined();
  });

  it("numbers", () => {
    expect(parseScreenNumber("1,234")).toBe(1_234);
    expect(parseScreenNumber("12k")).toBe(12_000);
    expect(parseScreenNumber("1.5M")).toBe(1_500_000);
    expect(parseScreenNumber("42%")).toBe(42);
    expect(parseScreenNumber("$0.31")).toBe(0.31);
    expect(parseScreenNumber("lots")).toBeUndefined();
  });
});

describe("the published state is the projection of the slot's snapshot", () => {
  const permissionPack: SeatRulePack = {
    harness: "claude",
    version: "test",
    rules: [
      {
        id: "permission",
        state: "attention",
        priority: 100,
        region: "whole_recent",
        visibleAttention: true,
        signal: { _tag: "PermissionRequested" },
        matchers: { contains: ["Allow this?"] },
      },
    ],
  };

  it("a bound generation is Starting, and a screen read folds in", () => {
    const m = new SeatStateMachine({ now: () => NOW });
    m.bind(SEAT, { harness: "claude", epoch: "e1" });
    expect(m.snapshot(SEAT)?.status).toEqual({ _tag: "Starting" });
    expect(m.getState(SEAT)).toBe("unknown");
    const event = m.feed(snap(["Allow this?"]), { pack: permissionPack });
    expect(event?.state).toBe("attention");
    expect(m.snapshot(SEAT)).toMatchObject({
      status: { _tag: "Blocked", reason: { _tag: "Permission" } },
      statusSource: "screen",
      statusFidelity: "screen",
    });
  });

  it("a stalled turn reads attention until the next judgment resumes it", () => {
    const m = new SeatStateMachine({ now: () => NOW });
    m.bind(SEAT, { harness: "claude", epoch: "e1" });
    m.force(SEAT, "working", "rule:test_working");
    const stalled = m.force(SEAT, "attention", "turn_stalled", "high", {
      signal: { _tag: "HeartbeatStalled", lastSeenAt: NOW - 1_000 },
      source: "system",
      fidelity: "native",
    });
    expect(stalled.state).toBe("attention");
    expect(m.snapshot(SEAT)).toMatchObject({ status: { _tag: "Working" }, stalledSince: NOW - 1_000 });
    expect(m.force(SEAT, "working", "rule:test_working").state).toBe("working");
    expect(m.snapshot(SEAT)?.stalledSince).toBeUndefined();
  });

  it("a released reporter stops owning the seat, so the screen carries it again", () => {
    const m = new SeatStateMachine({ now: () => NOW });
    m.bind(SEAT, { harness: "claude", epoch: "e1" });
    m.setHookState(SEAT, { state: "working", reason: "report", at: NOW, fullLifecycle: true });
    m.force(SEAT, "working", "report", "high", {
      signal: { _tag: "ActivityObserved", activity: "working" },
      source: "report",
      fidelity: "native",
    });
    expect(m.snapshot(SEAT)?.channels).toContain("report");
    m.setHookState(SEAT, null);
    expect(m.snapshot(SEAT)?.channels).not.toContain("report");
    expect(m.force(SEAT, "idle", "rule:test_idle").state).toBe("idle");
    expect(m.snapshot(SEAT)?.statusSource).toBe("screen");
  });

  it("an unbound generation is Exited, published gone", () => {
    const m = new SeatStateMachine({ now: () => NOW });
    m.bind(SEAT, { harness: "claude", epoch: "e1" });
    m.force(SEAT, "working", "rule:test_working");
    expect(m.unbind(SEAT, { epoch: "e1", reason: "generation_exited" })?.state).toBe("gone");
    expect(m.snapshot(SEAT)).toBeUndefined();
  });

  it("a moved slot's snapshot moves with it and keeps reading", () => {
    const m = new SeatStateMachine({ now: () => NOW });
    m.bind(SEAT, { harness: "claude", epoch: "e1" });
    m.force(SEAT, "working", "rule:test_working");
    expect(m.rekey(SEAT, "drain:b1:e1")).toBe(true);
    expect(m.snapshot("drain:b1:e1")?.seat).toBe("drain:b1:e1");
    expect(m.force("drain:b1:e1", "idle", "rule:test_idle").state).toBe("idle");
    expect(m.snapshot("drain:b1:e1")?.status).toEqual({ _tag: "Idle" });
  });
});
