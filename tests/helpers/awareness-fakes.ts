/**
 * Test-only fakes for the seat-awareness sidecar.
 *
 * Everything the awareness plane touches is injected, so these fakes are the
 * whole world the scheduler and runtime see: a deterministic clock with manual
 * timers, a fake observation plane, a fake seat port, the REAL evidence
 * projection (workstream C's `selectAwarenessInput`), and a recording model ask
 * that builds real assessments through C's own projection.
 */

import type {
  ObserverGridSnapshot,
  ObserverListener,
} from "../../src/main/junto/term/observer";
import type { AwarenessObservationPlane } from "../../src/main/junto/term/awareness/runtime";
import type {
  AwarenessProjectionPort,
  AwarenessSeatFacts,
  AwarenessSeatPort,
  AwarenessTimers,
} from "../../src/main/junto/term/awareness/scheduler";
import {
  isRetryableFailure,
  type AwarenessAsk,
  type AwarenessAskOutcome,
  type AwarenessModelShape,
  type AwarenessTransportFailureKind,
} from "../../src/main/junto/term/awareness/jev-client";
import { selectAwarenessInput } from "../../src/main/junto/term/awareness/select-input";
import {
  projectAwarenessAnswers,
  projectAwarenessUnavailable,
} from "../../src/main/junto/term/awareness/project-result";

// ---------------------------------------------------------------------------
// Clock and timers
// ---------------------------------------------------------------------------

export type ManualTimers = AwarenessTimers & {
  readonly clock: () => number;
  /** Advance the clock, firing every timer that comes due, in order. */
  readonly advance: (ms: number) => void;
};

export const makeManualTimers = (startAt = 1_000_000): ManualTimers => {
  let current = startAt;
  let nextId = 1;
  const timers = new Map<number, { readonly at: number; readonly fn: () => void }>();
  return {
    clock: () => current,
    setTimeout: (fn, ms) => {
      const id = nextId;
      nextId += 1;
      timers.set(id, { at: current + Math.max(0, ms), fn });
      return id;
    },
    clearTimeout: (handle) => {
      timers.delete(handle as number);
    },
    advance: (ms) => {
      const target = current + ms;
      for (let guard = 0; guard < 10_000; guard += 1) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= target)
          .sort((a, b) => a[1].at - b[1].at || a[0] - b[0]);
        const next = due[0];
        if (next === undefined) {
          current = target;
          return;
        }
        timers.delete(next[0]);
        current = Math.max(current, next[1].at);
        next[1].fn();
      }
      throw new Error("manual timers: a timer rescheduled itself without advancing time");
    },
  };
};

// ---------------------------------------------------------------------------
// Snapshots and the observation plane
// ---------------------------------------------------------------------------

export const makeSnapshot = (input: {
  readonly bindingId: string;
  readonly epoch: string;
  readonly cols?: number;
  readonly rows?: number;
  readonly text?: string;
  readonly lines?: readonly string[];
  readonly seq?: bigint;
}): ObserverGridSnapshot => ({
  bindingId: input.bindingId,
  epoch: input.epoch,
  cols: input.cols ?? 80,
  rows: input.rows ?? 24,
  lines: input.lines ?? (input.text ?? "").split("\n"),
  text: input.text ?? "",
  signals: {
    title: "",
    osc9: "",
    modes: {
      bracketedPaste: false,
      synchronizedOutput: false,
      altScreen: false,
      mouseModes: [],
    },
  },
  seq: input.seq ?? 1n,
});

/** Evidence lines that survive composer exclusion and redaction untouched. */
export const EVIDENCE_TEXT = "step one: reading the config\nstep two: applying the change";

export type FakePlane = {
  readonly plane: AwarenessObservationPlane;
  readonly publish: (snapshot: ObserverGridSnapshot) => void;
  /** Store a snapshot behind the plane without notifying listeners. */
  readonly seed: (snapshot: ObserverGridSnapshot) => void;
  readonly listenerCount: () => number;
  /** Non-flushing reads through the plane's sync accessor. */
  readonly snapshotReads: () => number;
  /** Non-flushing window reads. */
  readonly windowReads: () => number;
};

export const makeFakePlane = (): FakePlane => {
  const listeners = new Set<ObserverListener>();
  const snapshots = new Map<string, ObserverGridSnapshot>();
  let reads = 0;
  let windowReads = 0;
  return {
    plane: {
      subscribeAll: (listener) => {
        listeners.add(listener);
        // Real plane semantics: a subscription replays live seats.
        for (const snapshot of snapshots.values()) listener(snapshot);
        return () => {
          listeners.delete(listener);
        };
      },
      snapshot: (bindingId) => {
        reads += 1;
        return snapshots.get(bindingId);
      },
      readWindowNow: (bindingId, lines) => {
        windowReads += 1;
        const snapshot = snapshots.get(bindingId);
        if (snapshot === undefined) return undefined;
        const wanted = Math.max(1, Math.trunc(lines));
        const kept = snapshot.lines.slice(Math.max(0, snapshot.lines.length - wanted));
        return {
          bindingId: snapshot.bindingId,
          epoch: snapshot.epoch,
          cols: snapshot.cols,
          rows: snapshot.rows,
          seq: snapshot.seq,
          lines: kept,
          totalLines: snapshot.lines.length,
          truncated: wanted > snapshot.lines.length,
        };
      },
    },
    publish: (snapshot) => {
      snapshots.set(snapshot.bindingId, snapshot);
      for (const listener of listeners) listener(snapshot);
    },
    seed: (snapshot) => {
      snapshots.set(snapshot.bindingId, snapshot);
    },
    listenerCount: () => listeners.size,
    snapshotReads: () => reads,
    windowReads: () => windowReads,
  };
};

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

export type FakeSeatPort = AwarenessSeatPort & {
  readonly set: (bindingId: string, facts: Partial<AwarenessSeatFacts>) => void;
  readonly read: (bindingId: string) => AwarenessSeatFacts;
};

export const makeFakeSeatPort = (): FakeSeatPort => {
  const facts = new Map<string, AwarenessSeatFacts>();
  const read = (bindingId: string): AwarenessSeatFacts =>
    facts.get(bindingId) ?? {
      harness: "claude",
      controlRevision: 0,
      attention: false,
      episode: undefined,
    };
  return {
    facts: read,
    read,
    set: (bindingId, next) => {
      facts.set(bindingId, { ...read(bindingId), ...next });
    },
  };
};

export type FakeProjectionPort = AwarenessProjectionPort & {
  /** Number of times the projection ran. */
  readonly calls: () => number;
  /** Throw from the projection, to prove the plane survives a port fault. */
  readonly failWith: (error: Error | undefined) => void;
};

export const makeFakeProjectionPort = (): FakeProjectionPort => {
  let calls = 0;
  let failure: Error | undefined;
  return {
    calls: () => calls,
    failWith: (error) => {
      failure = error;
    },
    project: ({ window }) => {
      calls += 1;
      if (failure !== undefined) throw failure;
      // The real projection: caps, redaction, line ids, and the window digest.
      return { state: selectAwarenessInput(window) };
    },
  };
};

// ---------------------------------------------------------------------------
// Model ask
// ---------------------------------------------------------------------------

export type RecordedAsk = {
  readonly ask: AwarenessAsk;
  readonly signal: AbortSignal;
  readonly settle: (outcome: AwarenessAskOutcome) => void;
};

export type AskRecorder = {
  readonly ask: (ask: AwarenessAsk, signal: AbortSignal) => Promise<AwarenessAskOutcome>;
  readonly unavailable: AwarenessModelShape["unavailable"];
  readonly calls: ReadonlyArray<RecordedAsk>;
  readonly count: () => number;
  readonly last: () => RecordedAsk | undefined;
  /** Settle one recorded call by index (a no-op once it has settled). */
  readonly settleAt: (index: number, outcome: AwarenessAskOutcome) => void;
  /** Answer every call from now on with the same outcome builder. */
  readonly answerWith: (build: (ask: AwarenessAsk) => AwarenessAskOutcome) => void;
  /** Fail this call and every later one with a transport failure. */
  readonly failWith: (kind: AwarenessTransportFailureKind, message?: string, status?: number) => void;
};

/** The provenance every assessment carries, from the request that produced it. */
const provenanceOf = (request: AwarenessAsk["request"]) => ({
  bindingId: request.bindingId,
  epoch: request.epoch,
  sourceSeq: request.sourceSeq,
  observedAt: request.observedAt,
  evidenceHash: request.evidenceHash,
  packVersion: request.packVersion,
});

export const makeUnavailable = (): AwarenessModelShape["unavailable"] =>
  ({ request, reason, detail }) =>
    projectAwarenessUnavailable({ ...provenanceOf(request), reason, detail });

/** An accepted concern Noul: a real `current` assessment. */
export const currentOutcome = (ask: AwarenessAsk, probability = 0.97): AwarenessAskOutcome => ({
  assessment: projectAwarenessAnswers(
    ask.request,
    {
      packVersion: ask.request.packVersion,
      requestedModel: "jev-test",
      returnedModel: "jev-test-1",
      answers: [
        {
          questionId: "concern.approval_requested",
          evidenceHash: ask.request.evidenceHash,
          kind: "noul",
          probability,
        },
      ],
    },
  ),
  failure: undefined,
  usage: { inputTokens: 1_200, outputTokens: 40 },
});

/** A Noul below the acceptance bar: a real `abstained` assessment. */
export const abstainedOutcome = (ask: AwarenessAsk): AwarenessAskOutcome => ({
  assessment: projectAwarenessAnswers(
    ask.request,
    {
      packVersion: ask.request.packVersion,
      requestedModel: "jev-test",
      returnedModel: "jev-test-1",
      answers: [
        {
          questionId: "concern.approval_requested",
          evidenceHash: ask.request.evidenceHash,
          kind: "noul",
          probability: 0.5,
        },
      ],
    },
  ),
  failure: undefined,
  usage: { inputTokens: 1_200, outputTokens: 40 },
});

/**
 * An accepted concern plus a confidently absent one, plus an absent ACTIVITY
 * property. The concern absence is a verdict ("checked and clear") and must
 * reach the display; the activity absence is a control-plane cross-check and
 * must not.
 */
export const mixedOutcome = (ask: AwarenessAsk): AwarenessAskOutcome => ({
  assessment: projectAwarenessAnswers(ask.request, {
    packVersion: ask.request.packVersion,
    requestedModel: "jev-test",
    returnedModel: "jev-test-1",
    answers: [
      {
        questionId: "concern.approval_requested",
        evidenceHash: ask.request.evidenceHash,
        kind: "noul",
        probability: 0.97,
      },
      {
        questionId: "concern.execution_error",
        evidenceHash: ask.request.evidenceHash,
        kind: "noul",
        probability: 0.05,
      },
      {
        questionId: "activity.command_executing",
        evidenceHash: ask.request.evidenceHash,
        kind: "noul",
        probability: 0.05,
      },
    ],
  }),
  failure: undefined,
  usage: { inputTokens: 1_200, outputTokens: 40 },
});

/** Only accepted absences: no concern is raised, and nothing failed. */
export const negativesOnlyOutcome = (ask: AwarenessAsk): AwarenessAskOutcome => ({
  assessment: projectAwarenessAnswers(ask.request, {
    packVersion: ask.request.packVersion,
    requestedModel: "jev-test",
    returnedModel: "jev-test-1",
    answers: [
      {
        questionId: "concern.execution_error",
        evidenceHash: ask.request.evidenceHash,
        kind: "noul",
        probability: 0.05,
      },
    ],
  }),
  failure: undefined,
  usage: { inputTokens: 1_200, outputTokens: 40 },
});

/**
 * A ruled-out concern plus an unanswered-concern list: the "nothing raised, but
 * not everything was answered" case the display must not read as checked and
 * clear. The list is pinned rather than derived, so the advisory's pass-through
 * can be asserted without depending on the projection's own derivation.
 */
export const unansweredOutcome = (ask: AwarenessAsk): AwarenessAskOutcome => ({
  assessment: {
    ...projectAwarenessAnswers(ask.request, {
      packVersion: ask.request.packVersion,
      requestedModel: "jev-test",
      returnedModel: "jev-test-1",
      answers: [
        {
          questionId: "concern.execution_error",
          evidenceHash: ask.request.evidenceHash,
          kind: "noul",
          probability: 0.05,
        },
      ],
    }),
    unansweredConcerns: ["answer_requested", "access_problem"],
  },
  failure: undefined,
  usage: { inputTokens: 1_200, outputTokens: 40 },
});

/** Answers the projection rejects outright: a real `unavailable` assessment. */
export const rejectedOutcome = (ask: AwarenessAsk): AwarenessAskOutcome => ({
  assessment: projectAwarenessAnswers(
    ask.request,
    {
      packVersion: ask.request.packVersion,
      requestedModel: "jev-test",
      returnedModel: "jev-test-1",
      answers: [
        {
          questionId: "concern.approval_requested",
          evidenceHash: ask.request.evidenceHash,
          kind: "choice",
          selectedOptionId: "yes",
          confidence: 0.99,
          optionProbabilities: { yes: 0.99 },
        },
      ],
    },
  ),
  failure: undefined,
  usage: { inputTokens: 1_200, outputTokens: 40 },
});

export const transportOutcome = (
  ask: AwarenessAsk,
  kind: AwarenessTransportFailureKind,
  message = `test ${kind}`,
  status: number | undefined = undefined,
): AwarenessAskOutcome => ({
  assessment: projectAwarenessUnavailable({
    ...provenanceOf(ask.request),
    reason: kind === "unavailable" ? "not_configured" : "transport_error",
    detail: message,
  }),
  failure: { kind, message, status, retryable: isRetryableFailure(kind) },
  usage: undefined,
});

export const makeAskRecorder = (
  options: {
    readonly auto?: boolean;
    readonly build?: (ask: AwarenessAsk) => AwarenessAskOutcome;
  } = {},
): AskRecorder => {
  const auto = options.auto ?? true;
  let build = options.build ?? currentOutcome;
  const calls: RecordedAsk[] = [];
  const ask = (input: AwarenessAsk, signal: AbortSignal): Promise<AwarenessAskOutcome> =>
    new Promise<AwarenessAskOutcome>((resolve) => {
      const settle = (outcome: AwarenessAskOutcome): void => resolve(outcome);
      calls.push({ ask: input, signal, settle });
      if (signal.aborted) {
        settle(transportOutcome(input, "aborted"));
        return;
      }
      signal.addEventListener("abort", () => settle(transportOutcome(input, "aborted")), {
        once: true,
      });
      if (auto) settle(build(input));
    });
  return {
    ask,
    unavailable: makeUnavailable(),
    calls,
    count: () => calls.length,
    last: () => calls[calls.length - 1],
    settleAt: (index, outcome) => {
      calls[index]?.settle(outcome);
    },
    answerWith: (next) => {
      build = next;
    },
    failWith: (kind, message, status) => {
      build = (input) => transportOutcome(input, kind, message ?? `test ${kind}`, status);
      for (const call of calls) call.settle(build(call.ask));
    },
  };
};
