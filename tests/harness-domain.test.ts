import { Result, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  admitCommand,
  AwarenessActivity,
  AwarenessConcern,
  COMMAND_CAPABILITIES,
  decodeSignalEnvelope,
  deriveNeeds,
  HARNESS_SIGNAL_KINDS,
  initialSnapshot,
  Need,
  NEED_CAUSES,
  NO_COMMAND,
  NO_SIGNAL,
  reduceSeat,
  reduceSeatSignals,
  topNeed,
  type CommandSupport,
  type Fidelity,
  type HarnessCapabilities,
  type SeatSignal,
  type SeatSnapshot,
  type SignalEnvelope,
  type SignalSource,
} from "../src/shared/harness-domain";
import { atMost, Level } from "../src/shared/wire/urgency";
import { BindingId as SeatBindingId } from "../src/shared/terminal-session-domain";
import {
  AI_ACTIVITY_VALUES,
  AI_CONCERN_VALUES,
} from "../src/main/junto/term/awareness/questions";

const seat = Schema.decodeSync(SeatBindingId)("seat-a");

let clock = 1_000;
const at = (
  source: SignalSource,
  signal: SeatSignal,
  fidelity: Fidelity = source === "screen" ? "screen" : "native",
): SignalEnvelope => ({ seat, at: (clock += 10), source, fidelity, signal });

const fold = (...envelopes: SignalEnvelope[]): SeatSnapshot =>
  reduceSeatSignals(initialSnapshot(seat, 0), envelopes);

const typed: CommandSupport = { level: "typed", channel: "pty" };
const capabilities = (commands: Partial<HarnessCapabilities["commands"]>): HarnessCapabilities => ({
  signals: Object.fromEntries(HARNESS_SIGNAL_KINDS.map((kind) => [kind, NO_SIGNAL])) as HarnessCapabilities["signals"],
  commands: {
    ...(Object.fromEntries(COMMAND_CAPABILITIES.map((key) => [key, NO_COMMAND])) as HarnessCapabilities["commands"]),
    ...commands,
  },
});

describe("harness domain: status", () => {
  it("starts, works and idles from the screen alone", () => {
    const snapshot = fold(
      at("screen", { _tag: "ActivityObserved", activity: "working" }),
      at("screen", { _tag: "ActivityObserved", activity: "idle" }),
    );
    expect(snapshot.status).toEqual({ _tag: "Idle" });
    expect(snapshot.statusSource).toBe("screen");
    expect(snapshot.channels).toEqual(["screen"]);
  });

  it("lets a richer open channel own the activity", () => {
    const snapshot = fold(
      at("osc7501", { _tag: "TurnStarted" }),
      at("screen", { _tag: "ActivityObserved", activity: "idle" }),
    );
    expect(snapshot.status).toEqual({ _tag: "Working", phase: "thinking" });
    expect(snapshot.statusSource).toBe("osc7501");
  });

  it("lets a poorer channel raise a block it sees, never clear one", () => {
    const raised = fold(
      at("osc7501", { _tag: "TurnStarted" }),
      at("screen", { _tag: "PermissionRequested", tool: "Bash" }),
    );
    expect(raised.status._tag).toBe("Blocked");
    const owned = fold(
      at("osc7501", { _tag: "PermissionRequested" }),
      at("screen", { _tag: "ActivityObserved", activity: "working" }),
    );
    expect(owned.status).toEqual({ _tag: "Blocked", reason: { _tag: "Permission" } });
  });

  it("returns to the owner's activity when a poorer channel clears its own block", () => {
    const snapshot = fold(
      at("osc7501", { _tag: "ActivityObserved", activity: "working" }),
      at("screen", { _tag: "DialogShown", kind: "unknown" }),
      at("screen", { _tag: "ActivityObserved", activity: "idle" }),
    );
    expect(snapshot.status).toEqual({ _tag: "Working", phase: "thinking" });
    expect(snapshot.statusSource).toBe("osc7501");
    const later = reduceSeatSignals(snapshot, [at("screen", { _tag: "ActivityObserved", activity: "idle" })]);
    expect(later.status._tag).toBe("Working");
  });

  it("keeps a richer channel's block while a poorer one owns the activity", () => {
    const snapshot = fold(
      at("screen", { _tag: "ActivityObserved", activity: "working" }),
      at("hook", { _tag: "PermissionRequested" }),
      at("system", { _tag: "ChannelOpened", channel: "hook" }),
      at("screen", { _tag: "ActivityObserved", activity: "idle" }),
    );
    expect(snapshot.status._tag).toBe("Blocked");
    expect(snapshot.activity?.status).toEqual({ _tag: "Idle" });
  });

  it("hands the seat to the next channel when the owner closes", () => {
    const snapshot = fold(
      at("osc7501", { _tag: "TurnStarted" }),
      at("system", { _tag: "ChannelClosed", channel: "osc7501" }),
      at("screen", { _tag: "ActivityObserved", activity: "idle" }),
    );
    expect(snapshot.status).toEqual({ _tag: "Idle" });
    expect(snapshot.channels).toEqual(["screen"]);
  });

  it("keeps the phase while the screen still reads working", () => {
    const snapshot = fold(
      at("screen", { _tag: "Retrying", cause: "overloaded", attempt: 2, max: 10 }),
      at("screen", { _tag: "ActivityObserved", activity: "working" }),
    );
    expect(snapshot.status).toEqual({ _tag: "Working", phase: "retrying" });
  });

  it("blocks on a usage limit and holds it through the failed turn", () => {
    const snapshot = fold(
      at("screen", { _tag: "TurnStarted" }),
      at("screen", { _tag: "UsageLimitHit", scope: "weekly", resetsAt: 9_000_000, message: "You've hit your usage limit." }),
      at("screen", { _tag: "TurnEnded", outcome: "failed" }),
    );
    expect(snapshot.status).toEqual({
      _tag: "Blocked",
      reason: { _tag: "UsageLimit", scope: "weekly", resetsAt: 9_000_000 },
    });
    expect(topNeed(snapshot).cause).toBe("usage_limit");
  });

  it("reads a limit the harness resumes from itself as degraded, nobody acts", () => {
    const resuming = fold(
      at("screen", { _tag: "UsageLimitHit", scope: "5h", resetsAt: 9_000, autoResume: true, message: "Continuing automatically at 6:23am" }),
    );
    expect(topNeed(resuming)).toMatchObject({ cause: "usage_limit_resuming", level: "degraded", actor: "none" });
  });

  it("drops a scheduled wake once the limit clears", () => {
    const waking = fold(
      at("screen", { _tag: "UsageLimitHit", scope: "5h", message: "limit" }),
      at("system", { _tag: "WakeScheduled", at: 5_000 }),
    );
    expect(topNeed(waking).cause).toBe("usage_limit_waking");
    expect(topNeed(waking).actor).toBe("junto");
    const resumed = reduceSeatSignals(waking, [at("screen", { _tag: "TurnStarted" })]);
    expect(resumed.wakeAt).toBeUndefined();
  });

  it("returns a manual compaction to idle and an auto one to work", () => {
    const manual = fold(
      at("screen", { _tag: "CompactionStarted", trigger: "manual" }),
      at("screen", { _tag: "CompactionEnded", ok: true }),
    );
    expect(manual.status).toEqual({ _tag: "Idle" });
    expect(manual.compaction).toBeUndefined();
    const auto = fold(
      at("screen", { _tag: "CompactionStarted", trigger: "auto" }),
      at("screen", { _tag: "CompactionEnded", ok: true }),
    );
    expect(auto.status).toEqual({ _tag: "Working", phase: "thinking" });
  });

  it("blocks on auth and crash errors and only records the rest", () => {
    const network = fold(at("screen", { _tag: "ErrorRaised", kind: "network", message: "ECONNREFUSED" }));
    expect(network.status._tag).toBe("Starting");
    expect(network.lastError?.kind).toBe("network");
    const auth = fold(at("screen", { _tag: "ErrorRaised", kind: "auth", message: "Please run /login" }));
    expect(topNeed(auth).cause).toBe("auth_error");
  });

  it("ends at exit and ignores anything after it", () => {
    const snapshot = fold(
      at("process", { _tag: "ProcessExited", code: 1, expected: false }),
      at("screen", { _tag: "ActivityObserved", activity: "working" }),
    );
    expect(snapshot.status._tag).toBe("Exited");
    expect(topNeed(snapshot).cause).toBe("unexpected_exit");
  });

  it("reads an unknown activity as Unknown and an exit of unknown cause as quiet", () => {
    const unknown = fold(at("screen", { _tag: "ActivityObserved", activity: "unknown" }));
    expect(unknown.status).toEqual({ _tag: "Unknown" });
    const exited = fold(at("process", { _tag: "ProcessExited" }));
    expect(exited.status).toEqual({ _tag: "Exited" });
    expect(topNeed(exited).cause).toBe("exited");
  });

  it("keeps since across detail updates of the same status", () => {
    const first = fold(at("screen", { _tag: "UsageLimitHit", scope: "unknown", message: "limit" }));
    const refined = reduceSeatSignals(first, [
      at("screen", { _tag: "UsageLimitHit", scope: "weekly", resetsAt: 7_000, message: "limit" }),
    ]);
    expect(refined.since).toBe(first.since);
  });

  describe("activitySince", () => {
    const on = (ms: number, source: SignalSource, signal: SeatSignal): SignalEnvelope => ({
      seat,
      at: ms,
      source,
      fidelity: source === "screen" ? "screen" : "native",
      signal,
    });
    const steps = (...envelopes: SignalEnvelope[]): Array<number | undefined> => {
      let snapshot = initialSnapshot(seat, 0);
      return envelopes.map((envelope) => (snapshot = reduceSeat(snapshot, envelope)).activitySince);
    };

    it("is absent until the seat first leaves rest", () => {
      expect(initialSnapshot(seat, 0).activitySince).toBeUndefined();
      expect(steps(on(100, "screen", { _tag: "ActivityObserved", activity: "idle" }))).toEqual([undefined]);
    });

    it("moves when the seat leaves idle, and nothing inside the work moves it", () => {
      expect(
        steps(
          on(100, "screen", { _tag: "ActivityObserved", activity: "working" }),
          on(200, "screen", { _tag: "ToolStarted", tool: "Bash" }),
          on(250, "screen", { _tag: "Retrying", cause: "overloaded" }),
          on(300, "screen", { _tag: "PermissionRequested", tool: "Bash" }),
          on(400, "screen", { _tag: "PermissionResolved", decision: "allowed" }),
          on(450, "screen", { _tag: "CompactionStarted", trigger: "auto" }),
          on(500, "screen", { _tag: "TurnEnded", outcome: "completed" }),
          on(600, "screen", { _tag: "TurnStarted" }),
        ),
      ).toEqual([100, 100, 100, 100, 100, 100, 100, 600]);
    });

    it("counts a block raised from idle as leaving it, and keeps it through an exit", () => {
      expect(
        steps(
          on(100, "screen", { _tag: "ActivityObserved", activity: "idle" }),
          on(200, "screen", { _tag: "DialogShown", kind: "unknown" }),
          on(300, "screen", { _tag: "ActivityObserved", activity: "idle" }),
          on(400, "process", { _tag: "ProcessExited", code: 0, expected: true }),
          on(500, "screen", { _tag: "ActivityObserved", activity: "working" }),
        ),
      ).toEqual([undefined, 200, 200, 200, 200]);
    });

    it("reads Unknown as no reading: it never moves the clock, and leaving it for work does", () => {
      expect(
        steps(
          on(100, "screen", { _tag: "ActivityObserved", activity: "idle" }),
          on(200, "system", { _tag: "ActivityObserved", activity: "unknown" }),
          on(300, "screen", { _tag: "ActivityObserved", activity: "working" }),
        ),
      ).toEqual([undefined, undefined, 300]);
    });

    it("ignores what a poorer channel cannot change", () => {
      expect(
        steps(
          on(100, "osc7501", { _tag: "TurnStarted" }),
          on(200, "osc7501", { _tag: "TurnEnded", outcome: "completed" }),
          on(300, "screen", { _tag: "ActivityObserved", activity: "working" }),
        ),
      ).toEqual([100, 100, 100]);
    });
  });

  it("ignores envelopes for another seat", () => {
    const other = Schema.decodeSync(SeatBindingId)("seat-b");
    const snapshot = fold({ seat: other, at: 5, source: "screen", fidelity: "screen", signal: { _tag: "TurnStarted" } });
    expect(snapshot.status._tag).toBe("Starting");
  });
});

describe("harness domain: needs", () => {
  it("orders one ladder across harness, seat, awareness and system authors", () => {
    const snapshot = fold(
      at("screen", { _tag: "TurnStarted" }),
      at("awareness", {
        _tag: "AwarenessAssessed",
        questionId: "health.thrashing",
        answer: { axis: "health", value: "thrashing" },
        present: true,
        probability: 0.9,
        evidenceHash: "h1",
        packVersion: "awareness-pack/2",
      }),
      at("seat", { _tag: "SeatReported", kind: "feedback", signalId: "s1", state: "open" }),
      at("seat", { _tag: "SeatReported", kind: "escalate", signalId: "s2", state: "open" }),
      at("system", { _tag: "HeartbeatStalled", lastSeenAt: 500 }),
    );
    expect(deriveNeeds(snapshot).map((need) => need.cause)).toEqual([
      "seat_escalated",
      "seat_feedback",
      "stalled",
      "awareness_thrashing",
      "working",
    ]);
  });

  it("never lets awareness alone rise above escalated", () => {
    const awarenessCauses = Object.entries(NEED_CAUSES).filter(([cause]) => cause.startsWith("awareness_"));
    for (const [, entry] of awarenessCauses) {
      expect(atMost(entry.level, Level.escalated)).toBe(true);
    }
  });

  it("withdraws an awareness need on a decisive clear", () => {
    const assessed = {
      _tag: "AwarenessAssessed",
      questionId: "concern.approval_requested",
      answer: { axis: "concern", value: "approval_requested" },
      probability: 0.8,
      evidenceHash: "h",
      packVersion: "awareness-pack/2",
    } as const;
    const snapshot = fold(
      at("screen", { _tag: "ActivityObserved", activity: "idle" }),
      at("awareness", { ...assessed, present: true }),
      at("awareness", { ...assessed, present: false }),
    );
    expect(deriveNeeds(snapshot).map((need) => need.cause)).toEqual(["idle"]);
  });

  it("retires awareness held on older evidence, or on expiry", () => {
    const reading = (questionId: string, evidenceHash: string) =>
      at("awareness", {
        _tag: "AwarenessAssessed",
        questionId,
        answer: { axis: "concern", value: "approval_requested" },
        present: true,
        probability: 0.8,
        evidenceHash,
        packVersion: "awareness-pack/2",
      });
    const moved = fold(reading("concern.approval_requested", "old"), reading("health.state", "new"));
    expect(moved.awareness.map((held) => held.evidenceHash)).toEqual(["new"]);
    const retired = reduceSeatSignals(moved, [at("system", { _tag: "AwarenessRetired", reason: "expired" })]);
    expect(retired.awareness).toEqual([]);
  });

  it("shows a finished turn until the operator looks", () => {
    const done = fold(at("screen", { _tag: "TurnStarted" }), at("screen", { _tag: "TurnEnded", outcome: "completed" }));
    expect(topNeed(done).cause).toBe("turn_unseen");
    const viewed = reduceSeatSignals(done, [at("system", { _tag: "OperatorViewed" })]);
    expect(topNeed(viewed).cause).toBe("idle");
    const interrupted = fold(at("screen", { _tag: "TurnStarted" }), at("screen", { _tag: "TurnEnded", outcome: "interrupted" }));
    expect(topNeed(interrupted).cause).toBe("idle");
  });

  it("encodes a need with its schema", () => {
    const need = topNeed(fold(at("screen", { _tag: "QuestionAsked" })));
    expect(Schema.decodeUnknownSync(Need)(Schema.encodeSync(Need)(need))).toEqual(need);
  });

  it("puts a waiting prompt above an escalation", () => {
    const snapshot = fold(
      at("seat", { _tag: "SeatReported", kind: "escalate", signalId: "s", state: "open" }),
      at("screen", { _tag: "QuestionAsked" }),
    );
    expect(topNeed(snapshot)).toMatchObject({ cause: "question", level: "waiting", actor: "operator" });
  });
});

describe("harness domain: commands", () => {
  const harness = capabilities({ mailQueue: typed, interrupt: typed });

  it("delivers mail to an idle seat through any typed mode", () => {
    const idle = fold(at("screen", { _tag: "ActivityObserved", activity: "idle" }));
    const admitted = admitCommand(idle, harness, { _tag: "DeliverMail", text: "hi", mode: "steer" });
    expect(Result.isSuccess(admitted)).toBe(true);
  });

  it("holds mail while compacting, retrying or blocked", () => {
    for (const signal of [
      { _tag: "CompactionStarted", trigger: "auto" },
      { _tag: "Retrying", cause: "rate" },
      { _tag: "PermissionRequested" },
      { _tag: "UsageLimitHit", scope: "5h", message: "limit" },
    ] as const) {
      const admitted = admitCommand(fold(at("screen", signal)), harness, { _tag: "DeliverMail", text: "hi", mode: "queue" });
      expect(Result.isFailure(admitted) && admitted.failure._tag).toBe("SeatNotReadyError");
    }
  });

  it("leaves mail to an unknown read to the composer gate", () => {
    const unknown = fold(at("screen", { _tag: "ActivityObserved", activity: "unknown" }));
    expect(Result.isSuccess(admitCommand(unknown, harness, { _tag: "DeliverMail", text: "hi", mode: "queue" }))).toBe(true);
    expect(Result.isFailure(admitCommand(fold(), harness, { _tag: "DeliverMail", text: "hi", mode: "queue" }))).toBe(true);
  });

  it("refuses a mode the harness does not support on a working seat", () => {
    const working = fold(at("screen", { _tag: "TurnStarted" }));
    const admitted = admitCommand(working, harness, { _tag: "DeliverMail", text: "hi", mode: "steer" });
    expect(Result.isFailure(admitted) && admitted.failure._tag).toBe("CommandUnsupportedError");
  });

  it("answers only the open permission request", () => {
    const blocked = fold(at("screen", { _tag: "PermissionRequested", requestId: "r1" }));
    const answering = capabilities({ answerPermission: typed });
    expect(Result.isSuccess(admitCommand(blocked, answering, { _tag: "AnswerPermission", decision: "once", requestId: "r1" }))).toBe(true);
    expect(Result.isFailure(admitCommand(blocked, answering, { _tag: "AnswerPermission", decision: "once", requestId: "r2" }))).toBe(true);
  });
});

describe("harness domain: wire", () => {
  it("decodes an envelope and rejects an unknown signal", () => {
    const ok = decodeSignalEnvelope({
      seat: "seat-a",
      at: 1,
      source: "osc7501",
      fidelity: "native",
      signal: { _tag: "UsageLimitHit", scope: "weekly", message: "limit" },
    });
    expect(Result.isSuccess(ok)).toBe(true);
    const bad = decodeSignalEnvelope({ seat: "seat-a", at: 1, source: "screen", fidelity: "screen", signal: { _tag: "Nope" } });
    expect(Result.isFailure(bad)).toBe(true);
  });

  it("mirrors the awareness vocabularies exactly", () => {
    expect([...AwarenessActivity.literals].sort()).toEqual([...AI_ACTIVITY_VALUES].sort());
    expect([...AwarenessConcern.literals].sort()).toEqual([...AI_CONCERN_VALUES].sort());
  });
});
