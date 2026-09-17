/**
 * Seat awareness — store, ingest hygiene, availability, and presentation.
 *
 * The binding contract these tests hold:
 *   - authority: awareness is display only; the canonical control status is
 *     echoed unchanged and canonical attention is never downgraded
 *   - extractive only: the excerpt is a line from the evidence window captured
 *     for THAT observation, never prose, never another window's mapping
 *   - honest availability: missing key / provider failure / budget exhaustion
 *     render `unavailable`; expiry and a moved screen render `stale`
 *   - deterministic fallback: no assessment still shows the deterministic
 *     status plus a neutral line
 *   - terminal text is evidence, never instruction: sanitized and bounded
 *   - no U+00B7 anywhere in copy, including terminal-derived copy
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SEAT_AWARENESS_ACTIVITIES,
  SEAT_AWARENESS_AVAILABILITIES,
  SEAT_AWARENESS_CHANNEL,
  SEAT_AWARENESS_CONCERNS,
  SEAT_AWARENESS_MAX_CONCERNS,
  SEAT_AWARENESS_MAX_EXCERPT_CHARS,
  SEAT_AWARENESS_MAX_LINES,
  SEAT_AWARENESS_MAX_LINE_CHARS,
  SEAT_AWARENESS_PUBLISHED_AVAILABILITIES,
  SEAT_AWARENESS_SNAPSHOT_CHANNEL,
  SEAT_AWARENESS_TTL_MS,
  SEAT_AWARENESS_UNAVAILABLE_REASONS,
  decodeSeatAwarenessEvent,
  type SeatAwarenessAssessment,
  type SeatAwarenessAssessmentEvent,
  type SeatAwarenessEvidenceLine,
  type SeatAwarenessEvent,
  type SeatAwarenessWindowEvent,
} from "../src/renderer/lib/seat-awareness-contract";
import {
  SEAT_AWARENESS_ACTIVITY_COPY,
  SEAT_AWARENESS_EXCERPT_STABILITY_MS,
  SEAT_AWARENESS_ATTRIBUTION,
  SEAT_AWARENESS_AVAILABILITY_COPY,
  SEAT_AWARENESS_CONCERN_COPY,
  SEAT_AWARENESS_NEUTRAL_LINE,
  SEAT_AWARENESS_UNAVAILABLE_COPY,
  applySeatAwarenessEvent,
  awarenessForBinding,
  boundExcerptText,
  formatSeatAwarenessAge,
  resetSeatAwareness,
  sanitizeTerminalText,
  seatAwareness$,
  seatAwarenessAvailability,
  seatAwarenessExcerptFreshness,
  seatAwarenessTurnLive,
  seatAwarenessView,
  seatAwarenessViewForBinding,
  subscribeSeatAwareness,
  windowDigestForBinding,
  type SeatAwarenessControl,
  type SeatAwarenessLiveWindow,
} from "../src/renderer/lib/seat-awareness";

const T0 = 1_700_000_000_000;
const MIDDLE_DOT = "\u00B7";

const line = (id: string, text: string): SeatAwarenessEvidenceLine => ({ id, text });

const assessment = (
  partial: Partial<SeatAwarenessAssessment> & { readonly bindingId: string },
): SeatAwarenessAssessment => ({
  assessmentId: "assessment-1",
  availability: "current",
  observedAt: T0,
  activity: "testing",
  concerns: [],
  evidence: {
    digest: "w1",
    capturedAt: T0,
    lines: [line("l1", "3 tests failed in auth.spec.ts")],
  },
  selectedLineId: "l1",
  unavailableReason: null,
  ...partial,
});

const assessmentEvent = (
  value: SeatAwarenessAssessment,
  extra?: { readonly at?: number; readonly windowDigest?: string },
): SeatAwarenessAssessmentEvent => ({
  kind: "assessment",
  assessment: value,
  windowDigest: extra?.windowDigest ?? value.evidence.digest,
  at: extra?.at ?? value.observedAt,
});

const windowEvent = (
  bindingId: string,
  windowDigest: string,
  at: number,
): SeatAwarenessWindowEvent => ({
  kind: "window",
  bindingId,
  windowDigest,
  windowCapturedAt: at,
  at,
});

/**
 * A live evidence revision. The default stability clock is a minute old, so the
 * excerpt stability floor is satisfied; pass a recent `stableSince` to model a
 * revision that has only just appeared.
 */
const liveWindow = (
  digest: string,
  stableSince: number = T0 - 60_000,
): SeatAwarenessLiveWindow => ({ digest, stableSince });

const control = (partial?: Partial<SeatAwarenessControl>): SeatAwarenessControl => ({
  state: "working",
  label: "Working",
  tone: "cyan",
  ...partial,
});

beforeEach(() => {
  resetSeatAwareness();
});

afterEach(() => {
  resetSeatAwareness();
  vi.unstubAllGlobals();
});

describe("channel contract", () => {
  it("pins the channel identity the parent registers in preload", () => {
    // The renderer side of the contract. The parent registers these exact
    // channels and exposes `onSeatAwarenessChanged` / `seatAwarenessSnapshot`
    // on window.junto; changing either side alone breaks the wire.
    expect(SEAT_AWARENESS_CHANNEL).toBe("junto:seat-awareness");
    expect(SEAT_AWARENESS_SNAPSHOT_CHANNEL).toBe("junto:seat-awareness-snapshot");
    expect(SEAT_AWARENESS_TTL_MS).toBe(5 * 60_000);
    expect(SEAT_AWARENESS_AVAILABILITIES).toEqual([
      "not_assessed",
      "current",
      "stale",
      "abstained",
      "unavailable",
    ]);
    expect(SEAT_AWARENESS_ACTIVITIES).toEqual([
      "investigating",
      "editing",
      "running_command",
      "testing",
      "reviewing",
      "reporting",
      "indeterminate",
    ]);
    expect(SEAT_AWARENESS_CONCERNS).toEqual([
      "approval_requested",
      "answer_requested",
      "access_problem",
      "execution_error",
      "repetition",
    ]);
    // `not_assessed` and `stale` are renderer derivations: the wire never
    // carries them, so the published axis is a strict subset.
    expect(
      SEAT_AWARENESS_AVAILABILITIES.filter(
        (value) =>
          !(SEAT_AWARENESS_PUBLISHED_AVAILABILITIES as ReadonlyArray<string>).includes(
            value,
          ),
      ),
    ).toEqual(["not_assessed", "stale"]);
  });
});

describe("decodeSeatAwarenessEvent", () => {
  it("accepts a full assessment event and a window event", () => {
    const full = assessmentEvent(
      assessment({ bindingId: "b1", concerns: ["approval_requested"] }),
    );
    expect(decodeSeatAwarenessEvent(full)).toEqual(full);
    const win = windowEvent("b1", "w2", T0 + 1_000);
    expect(decodeSeatAwarenessEvent(win)).toEqual(win);
  });

  it("drops a malformed event whole — never half-applied", () => {
    expect(decodeSeatAwarenessEvent(null)).toBeUndefined();
    expect(decodeSeatAwarenessEvent({ kind: "window", bindingId: "b" })).toBeUndefined();
    expect(
      decodeSeatAwarenessEvent({ ...windowEvent("b1", "w", T0), windowDigest: "" }),
    ).toBeUndefined();
    expect(
      decodeSeatAwarenessEvent({ ...windowEvent("b1", "w", T0), at: Number.NaN }),
    ).toBeUndefined();
    // An `assessment` kind with no assessment body is dropped; a `window` kind
    // carrying a stray body is still just a window event.
    expect(
      decodeSeatAwarenessEvent({ kind: "assessment", bindingId: "b1", windowDigest: "w", at: T0 }),
    ).toBeUndefined();
    expect(
      decodeSeatAwarenessEvent({ ...windowEvent("b1", "w", T0), assessment: {} })?.kind,
    ).toBe("window");
  });

  it("rejects unknown axis values and a missing evidence mapping", () => {
    const base = assessment({ bindingId: "b1" });
    expect(
      decodeSeatAwarenessEvent(assessmentEvent({ ...base, activity: "vibing" as never })),
    ).toBeUndefined();
    expect(
      decodeSeatAwarenessEvent(
        assessmentEvent({ ...base, concerns: ["panic" as never] }),
      ),
    ).toBeUndefined();
    expect(
      decodeSeatAwarenessEvent(
        assessmentEvent({ ...base, availability: "stale" as never }),
      ),
    ).toBeUndefined();
    expect(
      decodeSeatAwarenessEvent(
        assessmentEvent({ ...base, evidence: { digest: "w", capturedAt: T0 } as never }),
      ),
    ).toBeUndefined();
    expect(
      decodeSeatAwarenessEvent(
        assessmentEvent({ ...base, selectedLineId: 7 as never }),
      ),
    ).toBeUndefined();
  });

  it("rejects an observation that carries no binding of its own", () => {
    const event = assessmentEvent(assessment({ bindingId: "b2" }));
    const { bindingId: _dropped, ...bodyless } = event.assessment;
    expect(
      decodeSeatAwarenessEvent({ ...event, assessment: bodyless }),
    ).toBeUndefined();
    expect(
      decodeSeatAwarenessEvent({ ...event, assessment: { ...event.assessment, bindingId: "" } }),
    ).toBeUndefined();
  });

  it("rejects an absurd evidence payload instead of storing it", () => {
    const huge = Array.from({ length: 5_000 }, (_, index) => line(`l${index}`, "x"));
    expect(
      decodeSeatAwarenessEvent(
        assessmentEvent(
          assessment({
            bindingId: "b1",
            evidence: { digest: "w1", capturedAt: T0, lines: huge },
          }),
        ),
      ),
    ).toBeUndefined();
  });

  it("keeps an unavailable reason only on an honest failure", () => {
    const judged = assessment({
      bindingId: "b1",
      unavailableReason: "missing_key",
    });
    const decoded = decodeSeatAwarenessEvent(assessmentEvent(judged));
    expect(decoded?.kind === "assessment" && decoded.assessment.unavailableReason).toBeNull();
    const failed = assessment({
      bindingId: "b1",
      availability: "unavailable",
      activity: null,
      selectedLineId: null,
      unavailableReason: "missing_key",
    });
    const decodedFailure = decodeSeatAwarenessEvent(assessmentEvent(failed));
    expect(
      decodedFailure?.kind === "assessment" && decodedFailure.assessment.unavailableReason,
    ).toBe("missing_key");
  });
});

describe("seat awareness store", () => {
  it("keeps the latest observation and the live window digest per binding", () => {
    applySeatAwarenessEvent(assessmentEvent(assessment({ bindingId: "b1" })));
    expect(awarenessForBinding("b1")?.assessmentId).toBe("assessment-1");
    expect(windowDigestForBinding("b1")).toBe("w1");
    expect(awarenessForBinding(undefined)).toBeUndefined();
    expect(windowDigestForBinding("nope")).toBeUndefined();
  });

  it("advances the live digest on a window event without touching the judgment", () => {
    applySeatAwarenessEvent(assessmentEvent(assessment({ bindingId: "b1" })));
    applySeatAwarenessEvent(windowEvent("b1", "w2", T0 + 60_000));
    expect(windowDigestForBinding("b1")).toBe("w2");
    expect(awarenessForBinding("b1")?.evidence.digest).toBe("w1");
  });

  it("ignores a replayed or raced older event", () => {
    applySeatAwarenessEvent(
      assessmentEvent(assessment({ bindingId: "b1", assessmentId: "newer" }), {
        at: T0 + 10_000,
      }),
    );
    applySeatAwarenessEvent(windowEvent("b1", "w-stale", T0));
    expect(windowDigestForBinding("b1")).toBe("w1");
    applySeatAwarenessEvent(
      assessmentEvent(assessment({ bindingId: "b1", assessmentId: "older" }), { at: T0 }),
    );
    expect(awarenessForBinding("b1")?.assessmentId).toBe("newer");
  });

  it("never lets an older observation replace a newer one", () => {
    applySeatAwarenessEvent(
      assessmentEvent(assessment({ bindingId: "b1", assessmentId: "second", observedAt: T0 + 5_000 }), {
        at: T0 + 5_000,
      }),
    );
    applySeatAwarenessEvent(
      assessmentEvent(assessment({ bindingId: "b1", assessmentId: "first", observedAt: T0 }), {
        at: T0 + 6_000,
      }),
    );
    expect(awarenessForBinding("b1")?.assessmentId).toBe("second");
  });

  it("sanitizes and bounds every evidence line before any render can read it", () => {
    const hostile = [
      "before \u001b]8;;http://evil.example\u0007link\u001b]8;;\u0007 after",
      "col\u0000umn\u00b7dot\tand   spaces",
      "x".repeat(SEAT_AWARENESS_MAX_LINE_CHARS + 200),
    ];
    const long = Array.from({ length: SEAT_AWARENESS_MAX_LINES + 40 }, (_, index) =>
      line(`l${index}`, `line ${index}`),
    );
    applySeatAwarenessEvent(
      assessmentEvent(
        assessment({
          bindingId: "b1",
          evidence: { digest: "w1", capturedAt: T0, lines: [line("a", hostile[0]), line("b", hostile[1]), line("c", hostile[2]), ...long] },
          concerns: [
            "repetition",
            "repetition",
            "approval_requested",
            "answer_requested",
            "access_problem",
          ],
        }),
      ),
    );
    const stored = awarenessForBinding("b1");
    expect(stored).toBeDefined();
    const lines = stored?.evidence.lines ?? [];
    expect(lines.length).toBe(SEAT_AWARENESS_MAX_LINES);
    expect(lines[0]?.text).toBe("before link after");
    expect(lines[1]?.text).toBe("col umn dot and spaces");
    expect(lines[2]?.text.length).toBeLessThanOrEqual(SEAT_AWARENESS_MAX_LINE_CHARS);
    // Deduped, order preserved, bounded.
    expect(stored?.concerns).toEqual([
      "repetition",
      "approval_requested",
      "answer_requested",
    ]);
    expect(stored?.concerns.length).toBe(SEAT_AWARENESS_MAX_CONCERNS);
  });

  it("subscribes, decodes, hydrates, and degrades to a no-op without a bridge", async () => {
    const noop = subscribeSeatAwareness();
    expect(typeof noop).toBe("function");
    noop();

    const listeners: Array<(event: unknown) => void> = [];
    vi.stubGlobal("window", {
      junto: {
        onSeatAwarenessChanged: (listener: (event: unknown) => void) => {
          listeners.push(listener);
          return () => {
            listeners.splice(listeners.indexOf(listener), 1);
          };
        },
        seatAwarenessSnapshot: async () => [
          assessmentEvent(assessment({ bindingId: "snap", assessmentId: "hydrated" })),
          { nonsense: true },
        ],
      },
    });
    const unsubscribe = subscribeSeatAwareness();
    expect(listeners.length).toBe(1);
    listeners[0]?.(assessmentEvent(assessment({ bindingId: "b1" })));
    // A malformed message is dropped, not half-applied.
    listeners[0]?.({ nonsense: true });
    expect(awarenessForBinding("b1")?.assessmentId).toBe("assessment-1");
    // Subscribing twice must not double-subscribe.
    subscribeSeatAwareness();
    expect(listeners.length).toBe(1);
    await Promise.resolve();
    await Promise.resolve();
    expect(awarenessForBinding("snap")?.assessmentId).toBe("hydrated");
    unsubscribe();
    expect(listeners.length).toBe(0);
  });
});

describe("freshness axes", () => {
  const workingControl = control();
  const idleControl = control({ state: "idle", label: "Idle", tone: "steel" });

  it("keeps the judgment current while the turn lives, even as the digest churns", () => {
    // The failure the split exists to prevent: a continuously printing seat
    // moves its digest on every burst, and the label must survive that.
    const stored = assessment({ bindingId: "b1" });
    const view = seatAwarenessView({
      control: workingControl,
      assessment: stored,
      window: liveWindow("w7"),
      now: T0 + 4 * 60_000,
    });
    expect(view.availability).toBe("current");
    expect(view.judgmentFreshness).toBe("current");
    expect(view.aiLabel).toBe("Likely testing");
    expect(view.freshness).toBe("AI assessment, observed 4m ago");
    // Only the quoted screen is withdrawn, and it is stamped with its own age.
    expect(view.excerptFreshness).toBe("last_observed");
    expect(view.excerptLabel).toBe("terminal excerpt (last observed at 4m ago)");
    expect(view.excerpt).toBe("3 tests failed in auth.spec.ts");
  });

  it("is current only on an exact live digest match that has held", () => {
    const stored = assessment({ bindingId: "b1" });
    const at = { now: T0 } as const;
    expect(
      seatAwarenessExcerptFreshness(stored, { ...at, window: liveWindow("w1") }),
    ).toBe("current");
    expect(
      seatAwarenessExcerptFreshness(stored, { ...at, window: liveWindow("w2") }),
    ).toBe("last_observed");
    expect(
      seatAwarenessExcerptFreshness(stored, { ...at, window: liveWindow("w1 ") }),
    ).toBe("last_observed");
    // A match whose revision has only just appeared is not yet evidence of
    // currency: the screen is still moving.
    expect(
      seatAwarenessExcerptFreshness(stored, {
        ...at,
        window: liveWindow("w1", T0 - 1_000),
      }),
    ).toBe("last_observed");
    // Exactly at the floor, and beyond it, the claim is supported.
    expect(
      seatAwarenessExcerptFreshness(stored, {
        ...at,
        window: liveWindow("w1", T0 - SEAT_AWARENESS_EXCERPT_STABILITY_MS),
      }),
    ).toBe("current");
    // No live window cannot prove a match, so it never reads as current.
    expect(seatAwarenessExcerptFreshness(stored, at)).toBe("last_observed");
    expect(
      seatAwarenessExcerptFreshness(stored, { ...at, window: undefined }),
    ).toBe("last_observed");
    // The floor is overridable, including to 0 for the unfloored rule.
    expect(
      seatAwarenessExcerptFreshness(stored, {
        ...at,
        window: liveWindow("w1", T0),
        stabilityMs: 0,
      }),
    ).toBe("current");
  });

  it("holds a busy seat's excerpt steady instead of switching twice per revision", () => {
    // A seat printing a new material revision every two seconds, with a
    // digest-keyed scheduler observing each one — the cadence that produced the
    // flicker. Count eyebrow switches the operator would see with the hover open.
    const switches = (stabilityMs: number): number => {
      resetSeatAwareness();
      let count = 0;
      let previous: string | null = null;
      const sample = (now: number) => {
        const view = seatAwarenessViewForBinding({
          bindingId: "b1",
          control: control(),
          now,
          stabilityMs,
        });
        if (previous !== null && view.excerptLabel !== previous) count += 1;
        previous = view.excerptLabel;
      };
      for (let step = 0; step < 30; step += 1) {
        const at = T0 + step * 2_000;
        const digest = `rev-${step}`;
        applySeatAwarenessEvent(windowEvent("b1", digest, at));
        sample(at);
        applySeatAwarenessEvent(
          assessmentEvent(
            assessment({
              bindingId: "b1",
              assessmentId: `a-${step}`,
              observedAt: at,
              evidence: { digest, capturedAt: at, lines: [line("l1", "3 tests failed")] },
            }),
            { at, windowDigest: digest },
          ),
        );
        sample(at);
      }
      return count;
    };
    // Unfloored: the label flips on every revision and every new observation.
    expect(switches(0)).toBe(58);
    // Floored: the busy seat settles on one stable state for the whole minute.
    expect(switches(SEAT_AWARENESS_EXCERPT_STABILITY_MS)).toBe(0);
    // A quiet seat is unaffected: its revision has already held past the floor,
    // so a fresh observation is current immediately and never flips.
    resetSeatAwareness();
    applySeatAwarenessEvent(windowEvent("b1", "rev-quiet", T0 - 120_000));
    applySeatAwarenessEvent(
      assessmentEvent(
        assessment({ bindingId: "b1", evidence: { digest: "rev-quiet", capturedAt: T0, lines: [line("l1", "3 tests failed")] } }),
        { at: T0, windowDigest: "rev-quiet" },
      ),
    );
    const quiet = seatAwarenessViewForBinding({ bindingId: "b1", control: control(), now: T0 });
    expect(quiet.excerptFreshness).toBe("current");
    expect(quiet.excerptLabel).toBe("terminal excerpt");
  });

  it("keeps the excerpt current while the judgment is stale", () => {
    // The digest still matches, so the quoted screen is the screen; what aged
    // out is the judgment, because the seat settled.
    const view = seatAwarenessView({
      control: idleControl,
      assessment: assessment({ bindingId: "b1" }),
      window: liveWindow("w1"),
      now: T0 + 20_000,
    });
    expect(view.availability).toBe("stale");
    expect(view.judgmentFreshness).toBe("stale");
    expect(view.freshness).toBe("AI assessment, last observed 20s ago");
    expect(view.excerptFreshness).toBe("current");
    expect(view.excerptLabel).toBe("terminal excerpt");
  });

  it("expires the judgment at the enrichment lifetime while the turn still lives", () => {
    const stored = assessment({ bindingId: "b1" });
    expect(
      seatAwarenessAvailability(stored, {
        now: T0 + SEAT_AWARENESS_TTL_MS - 1,
        controlState: "working",
      }),
    ).toBe("current");
    expect(
      seatAwarenessAvailability(stored, {
        now: T0 + SEAT_AWARENESS_TTL_MS,
        controlState: "working",
      }),
    ).toBe("stale");
  });

  it("ages the judgment out when the seat has left the turn", () => {
    const stored = assessment({ bindingId: "b1" });
    for (const state of ["working", "attention"] as const) {
      expect(seatAwarenessTurnLive(state), state).toBe(true);
      expect(
        seatAwarenessAvailability(stored, { now: T0 + 1_000, controlState: state }),
        state,
      ).toBe("current");
    }
    for (const state of ["idle", "done", "gone"] as const) {
      expect(seatAwarenessTurnLive(state), state).toBe(false);
      expect(
        seatAwarenessAvailability(stored, { now: T0 + 1_000, controlState: state }),
        state,
      ).toBe("stale");
    }
    // `unknown` and an absent state cannot prove the turn ended — the same
    // "never claim more than the evidence shows" rule as the excerpt axis.
    for (const state of ["unknown", undefined] as const) {
      expect(seatAwarenessTurnLive(state), String(state)).toBe(true);
      expect(
        seatAwarenessAvailability(stored, { now: T0 + 1_000, controlState: state }),
        String(state),
      ).toBe("current");
    }
  });

  it("keeps a canonical attention seat's judgment inside the turn", () => {
    // The highest-value case: a seat waiting on the operator keeps its label.
    const view = seatAwarenessView({
      control: control({ state: "attention", label: "needs operator input", tone: "amber" }),
      assessment: assessment({
        bindingId: "b1",
        activity: null,
        concerns: ["approval_requested"],
      }),
      window: liveWindow("w1"),
      now: T0 + 60_000,
    });
    expect(view.availability).toBe("current");
    expect(view.judgmentFreshness).toBe("current");
    expect(view.aiLabel).toBe("AI suggests checking approval");
    expect(view.canonicalAttention).toBe(true);
  });

  it("passes abstention and failure through — neither claims currency", () => {
    const abstained = assessment({ bindingId: "b1", availability: "abstained", activity: null, selectedLineId: null });
    const failed = assessment({ bindingId: "b1", availability: "unavailable", activity: null, selectedLineId: null });
    expect(
      seatAwarenessAvailability(abstained, {
        now: T0 + SEAT_AWARENESS_TTL_MS * 4,
        controlState: "idle",
      }),
    ).toBe("abstained");
    expect(
      seatAwarenessAvailability(failed, {
        now: T0 + SEAT_AWARENESS_TTL_MS * 4,
        controlState: "idle",
      }),
    ).toBe("unavailable");
  });

  it("treats a replayed cache hit as the same old observation", () => {
    const cached = assessment({ bindingId: "b1" });
    applySeatAwarenessEvent(assessmentEvent(cached, { at: T0 }));
    // Replayed ten minutes later with the same observation time.
    applySeatAwarenessEvent(assessmentEvent(cached, { at: T0 + 600_000 }));
    const stored = awarenessForBinding("b1");
    expect(stored?.observedAt).toBe(T0);
    expect(
      seatAwarenessAvailability(stored, {
        now: T0 + 600_000,
        controlState: "working",
      }),
    ).toBe("stale");
  });
});

describe("presentation", () => {
  it("composes the fresh example copy exactly", () => {
    const view = seatAwarenessView({
      control: control(),
      assessment: assessment({ bindingId: "b1" }),
      window: liveWindow("w1"),
      now: T0 + 8_000,
    });
    expect(view.sentence).toBe(
      "Likely testing - terminal excerpt: '3 tests failed in auth.spec.ts' - AI assessment, observed 8s ago",
    );
    expect(view.availability).toBe("current");
    expect(view.excerpt).toBe("3 tests failed in auth.spec.ts");
    expect(view.excerptLabel).toBe("terminal excerpt");
    expect(view.freshness).toBe("AI assessment, observed 8s ago");
    expect(view.attribution).toBe(SEAT_AWARENESS_ATTRIBUTION);
  });

  it("leads with a concern and attributes it as a suggestion", () => {
    const view = seatAwarenessView({
      control: control({ state: "attention", label: "needs operator input", tone: "amber" }),
      assessment: assessment({
        bindingId: "b1",
        activity: null,
        concerns: ["approval_requested"],
        evidence: { digest: "w1", capturedAt: T0, lines: [line("l1", "Allow this command to run?")] },
      }),
      window: liveWindow("w1"),
      now: T0,
    });
    expect(view.aiLabel).toBe("AI suggests checking approval");
    expect(view.sentence).toBe(
      "AI suggests checking approval - terminal excerpt: 'Allow this command to run?' - AI assessment, observed just now",
    );
    // Canonical attention is echoed unchanged, never replaced by the answer.
    expect(view.control.state).toBe("attention");
    expect(view.canonicalAttention).toBe(true);
  });

  it("falls back to the deterministic status plus a neutral line", () => {
    const absent = seatAwarenessView({ control: control(), now: T0 });
    expect(absent.availability).toBe("not_assessed");
    expect(absent.attribution).toBeNull();
    expect(absent.aiLabel).toBeNull();
    expect(absent.availabilityLine).toBe(SEAT_AWARENESS_NEUTRAL_LINE);
    expect(absent.sentence).toBe("Working - recent terminal output available");
    expect(absent.availabilityLabel).toBe(SEAT_AWARENESS_AVAILABILITY_COPY.not_assessed);

    const abstained = seatAwarenessView({
      control: control(),
      assessment: assessment({
        bindingId: "b1",
        availability: "abstained",
        activity: null,
        selectedLineId: null,
      }),
      now: T0,
    });
    expect(abstained.availability).toBe("abstained");
    expect(abstained.aiLabel).toBeNull();
    expect(abstained.sentence).toBe("Working - recent terminal output available");
    expect(abstained.availabilityLabel).toBe("NO JUDGMENT");
  });

  it("shows every failure reason honestly", () => {
    for (const reason of SEAT_AWARENESS_UNAVAILABLE_REASONS) {
      const view = seatAwarenessView({
        control: control(),
        assessment: assessment({
          bindingId: "b1",
          availability: "unavailable",
          activity: null,
          selectedLineId: null,
          unavailableReason: reason,
        }),
        now: T0,
      });
      expect(view.availability).toBe("unavailable");
      expect(view.aiLabel).toBeNull();
      expect(view.availabilityLine).toBe(SEAT_AWARENESS_UNAVAILABLE_COPY[reason]);
      expect(view.sentence).toBe(`Working - ${SEAT_AWARENESS_UNAVAILABLE_COPY[reason]}`);
      expect(view.sentence.toLowerCase()).toContain("unavailable");
    }
  });

  it("never relabels a moved screen as current", () => {
    const view = seatAwarenessView({
      control: control(),
      assessment: assessment({ bindingId: "b1" }),
      window: liveWindow("w2"),
      now: T0 + 60_000,
    });
    expect(view.excerptFreshness).toBe("last_observed");
    expect(view.excerptLabel).toBe("terminal excerpt (last observed at 1m ago)");
    expect(view.sentence).toContain("last observed at 1m ago");
    expect(view.sentence).not.toContain("observed at 1m ago: '");
    // The extractive excerpt is still shown, stamped with the screen it came from.
    expect(view.excerpt).toBe("3 tests failed in auth.spec.ts");
    // The judgment survives the screen churn — that is the point of the split.
    expect(view.judgmentFreshness).toBe("current");
    expect(view.freshness).toBe("AI assessment, observed 1m ago");
  });

  it("presents a current observation with no accepted judgment as an abstention", () => {
    const view = seatAwarenessView({
      control: control(),
      assessment: assessment({ bindingId: "b1", activity: null, concerns: [], selectedLineId: null }),
      window: liveWindow("w1"),
      now: T0,
    });
    expect(view.aiLabel).toBeNull();
    expect(view.excerpt).toBeNull();
    expect(view.freshness).toBeNull();
    expect(view.sentence).toBe("Working - recent terminal output available");
  });

  it("resolves the excerpt against THIS observation's mapping only", () => {
    const first = assessment({
      bindingId: "b1",
      evidence: { digest: "w1", capturedAt: T0, lines: [line("shared", "first screen line")] },
      selectedLineId: "shared",
    });
    const second = assessment({
      bindingId: "b1",
      evidence: { digest: "w2", capturedAt: T0, lines: [line("shared", "second screen line")] },
      selectedLineId: "shared",
    });
    const viewFor = (value: SeatAwarenessAssessment) =>
      seatAwarenessView({
        control: control(),
        assessment: value,
        window: liveWindow(value.evidence.digest),
        now: T0,
      });
    expect(viewFor(first).excerpt).toBe("first screen line");
    expect(viewFor(second).excerpt).toBe("second screen line");

    // An id that is not in this window resolves to nothing — never another
    // window's line and never generated prose to fill the gap.
    const missing = assessment({ bindingId: "b1", selectedLineId: "l9" });
    const view = viewFor(missing);
    expect(view.excerpt).toBeNull();
    expect(view.excerptLabel).toBeNull();
    expect(view.sentence).toBe("Likely testing - AI assessment, observed just now");
  });

  it("keeps the AI plane out of the control vocabulary", () => {
    const controlTokens = ["idle", "working", "attention", "unknown", "gone", "done", "paused", "pausing"];
    const aiCopy = [
      ...Object.values(SEAT_AWARENESS_ACTIVITY_COPY),
      ...Object.values(SEAT_AWARENESS_CONCERN_COPY),
      ...Object.values(SEAT_AWARENESS_UNAVAILABLE_COPY),
      SEAT_AWARENESS_NEUTRAL_LINE,
    ];
    for (const copy of aiCopy) {
      const lowered = copy.toLowerCase();
      for (const token of controlTokens) {
        expect(lowered, copy).not.toContain(token);
      }
    }
    for (const activity of SEAT_AWARENESS_ACTIVITIES) {
      const view = seatAwarenessView({
        control: control({ state: "attention", label: "needs operator input", tone: "amber" }),
        assessment: assessment({ bindingId: "b1", activity, concerns: [] }),
        window: liveWindow("w1"),
        now: T0,
      });
      expect(view.aiLabel).toBe(SEAT_AWARENESS_ACTIVITY_COPY[activity]);
      expect(view.aiLabel).not.toBe(view.control.label);
    }
    for (const concern of SEAT_AWARENESS_CONCERNS) {
      const view = seatAwarenessView({
        control: control({ state: "attention", label: "needs operator input", tone: "amber" }),
        assessment: assessment({ bindingId: "b1", activity: null, concerns: [concern] }),
        window: liveWindow("w1"),
        now: T0,
      });
      expect(view.aiLabel).toBe(SEAT_AWARENESS_CONCERN_COPY[concern]);
    }
  });

  it("never emits U+00B7 in any composed copy", () => {
    const sentences: string[] = [];
    for (const activity of SEAT_AWARENESS_ACTIVITIES) {
      for (const availability of ["current", "abstained", "unavailable"] as const) {
        const view = seatAwarenessView({
          control: control(),
          assessment: assessment({
            bindingId: "b1",
            activity: availability === "current" ? activity : null,
            availability,
            selectedLineId: availability === "current" ? "l1" : null,
            evidence: { digest: "w1", capturedAt: T0, lines: [line("l1", `run ${MIDDLE_DOT} test`)] },
            unavailableReason: availability === "unavailable" ? "provider_failure" : null,
          }),
          window: liveWindow("w1"),
          now: T0 + 8_000,
        });
        sentences.push(view.sentence, view.availabilityLine, view.availabilityLabel);
      }
    }
    for (const value of Object.values(SEAT_AWARENESS_ACTIVITY_COPY)) sentences.push(value);
    for (const value of Object.values(SEAT_AWARENESS_CONCERN_COPY)) sentences.push(value);
    for (const value of Object.values(SEAT_AWARENESS_UNAVAILABLE_COPY)) sentences.push(value);
    for (const value of Object.values(SEAT_AWARENESS_AVAILABILITY_COPY)) sentences.push(value);
    for (const sentence of sentences) {
      expect(sentence).not.toContain(MIDDLE_DOT);
    }
    // Terminal text carrying a middle dot is neutralized, not passed through.
    const view = seatAwarenessView({
      control: control(),
      assessment: assessment({
        bindingId: "b1",
        evidence: { digest: "w1", capturedAt: T0, lines: [line("l1", `npm ${MIDDLE_DOT} run build`)] },
      }),
      window: liveWindow("w1"),
      now: T0,
    });
    expect(view.excerpt).toBe("npm run build");
    expect(view.sentence).not.toContain(MIDDLE_DOT);
  });
});

describe("excerpt hygiene", () => {
  it("strips escape sequences, control characters, invisibles, and middots", () => {
    expect(sanitizeTerminalText("\u001b[31mred\u001b[0m")).toBe("red");
    expect(sanitizeTerminalText("a\u0007b\u0000c\u007fd")).toBe("a b c d");
    expect(sanitizeTerminalText("zero\u200bwidth\u202Eoverride")).toBe("zerowidthoverride");
    expect(sanitizeTerminalText(`mid${MIDDLE_DOT}dot`)).toBe("mid dot");
    expect(sanitizeTerminalText("tab\there\nand   spaces")).toBe("tab here and spaces");
  });

  it("removes an OSC 8 hyperlink whole — no terminal-supplied link survives", () => {
    const hostile = "\u001b]8;;https://evil.example/x\u0007click me\u001b]8;;\u0007";
    const cleaned = sanitizeTerminalText(hostile);
    expect(cleaned).toBe("click me");
    expect(cleaned).not.toContain("http");
    expect(cleaned).not.toContain("\u001b");
  });

  it("bounds length with a plain ASCII ellipsis", () => {
    expect(boundExcerptText("short", 10)).toBe("short");
    const long = boundExcerptText("y".repeat(500), SEAT_AWARENESS_MAX_EXCERPT_CHARS);
    expect(long.length).toBe(SEAT_AWARENESS_MAX_EXCERPT_CHARS);
    expect(long.endsWith("...")).toBe(true);
    const view = seatAwarenessView({
      control: control(),
      assessment: assessment({
        bindingId: "b1",
        evidence: { digest: "w1", capturedAt: T0, lines: [line("l1", "z".repeat(2_000))] },
      }),
      window: liveWindow("w1"),
      now: T0,
    });
    expect((view.excerpt ?? "").length).toBeLessThanOrEqual(SEAT_AWARENESS_MAX_EXCERPT_CHARS);
  });

  it("formats observation ages", () => {
    expect(formatSeatAwarenessAge(0)).toBe("just now");
    expect(formatSeatAwarenessAge(4_999)).toBe("just now");
    expect(formatSeatAwarenessAge(8_000)).toBe("8s ago");
    expect(formatSeatAwarenessAge(6 * 60_000)).toBe("6m ago");
    expect(formatSeatAwarenessAge(2 * 60 * 60_000)).toBe("2h ago");
    expect(formatSeatAwarenessAge(Number.NaN)).toBe("just now");
  });
});

describe("authority boundary", () => {
  it("exposes no writer for seat state, delivery, or the canvas", () => {
    const event: SeatAwarenessEvent = assessmentEvent(assessment({ bindingId: "b1" }));
    applySeatAwarenessEvent(event);
    // The store's only writable surface is the awareness slice itself.
    expect(Object.keys(seatAwareness$.peek()).sort()).toEqual([
      "byBindingId",
      "rev",
      "windowDigestByBindingId",
      "windowStableSinceByBindingId",
    ]);
    expect(Object.keys(seatAwareness$.byBindingId.peek())).toEqual(["b1"]);
  });

  it("keeps the two freshness axes independent", () => {
    const stored = assessment({ bindingId: "b1" });
    const working = control();
    const idle = control({ state: "idle", label: "Idle", tone: "steel" });
    // Digest churn moves the excerpt axis and leaves the judgment axis alone.
    const matched = seatAwarenessView({
      control: working,
      assessment: stored,
      window: liveWindow("w1"),
      now: T0,
    });
    const moved = seatAwarenessView({
      control: working,
      assessment: stored,
      window: liveWindow("w9"),
      now: T0,
    });
    expect(matched.excerptFreshness).toBe("current");
    expect(moved.excerptFreshness).toBe("last_observed");
    expect(moved.availability).toBe(matched.availability);
    expect(moved.judgmentFreshness).toBe(matched.judgmentFreshness);
    expect(moved.aiLabel).toBe(matched.aiLabel);
    expect(moved.freshness).toBe(matched.freshness);
    // The control state moves the judgment axis and leaves the excerpt alone.
    const settled = seatAwarenessView({
      control: idle,
      assessment: stored,
      window: liveWindow("w1"),
      now: T0,
    });
    expect(settled.judgmentFreshness).toBe("stale");
    expect(settled.excerptFreshness).toBe("current");
    expect(settled.aiLabel).toBe("Likely testing");
    // Neither axis can reach the canonical control plane.
    expect(settled.control.state).toBe("idle");
    expect(settled.control.label).toBe("Idle");
  });
});
