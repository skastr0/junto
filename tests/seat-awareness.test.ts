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
  type SeatAwarenessAbsence,
  type SeatAwarenessAssessment,
  type SeatAwarenessAssessmentEvent,
  type SeatAwarenessConcern,
  type SeatAwarenessEvidenceLine,
  type SeatAwarenessEvent,
  type SeatAwarenessWindowEvent,
} from "../src/renderer/lib/seat-awareness-contract";
import {
  SEAT_AWARENESS_ACTIVITY_COPY,
  SEAT_AWARENESS_ATTRIBUTION,
  SEAT_AWARENESS_CLEAR_LINE,
  SEAT_AWARENESS_NO_CONCERN_RAISED_LINE,
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
  seatAwarenessTurnLive,
  seatAwarenessView,
  seatAwarenessViewForBinding,
  subscribeSeatAwareness,
  windowDigestForBinding,
  type SeatAwarenessControl,
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
  absences: [],
  unansweredConcerns: [],
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

  it("normalizes accepted absences, and refuses a malformed one whole", () => {
    const base = assessment({ bindingId: "b1" });
    // Absent on the wire normalizes to empty — which is not "checked and clear".
    const omitted = decodeSeatAwarenessEvent(assessmentEvent(base));
    expect(omitted?.kind === "assessment" && omitted.assessment.absences).toEqual([]);
    const { absences: _dropped, ...withoutAbsences } = base;
    const omittedRaw = decodeSeatAwarenessEvent(
      assessmentEvent(withoutAbsences as SeatAwarenessAssessment),
    );
    expect(omittedRaw?.kind === "assessment" && omittedRaw.assessment.absences).toEqual([]);

    const carried = decodeSeatAwarenessEvent(
      assessmentEvent({
        ...base,
        activity: null,
        selectedLineId: null,
        absences: [
          { concern: "execution_error", probability: 0.04 },
          { concern: "repetition", probability: 0.1 },
        ],
      }),
    );
    expect(carried?.kind === "assessment" && carried.assessment.absences).toEqual([
      { concern: "execution_error", probability: 0.04 },
      { concern: "repetition", probability: 0.1 },
    ]);

    for (const bad of [
      "no",
      [{}],
      [{ concern: "vibes", probability: 0.1 }],
      [{ concern: "repetition" }],
      [{ concern: "repetition", probability: "0.1" }],
      [{ concern: "repetition", probability: Number.NaN }],
    ]) {
      expect(
        decodeSeatAwarenessEvent(
          assessmentEvent({ ...base, absences: bad as unknown as SeatAwarenessAbsence[] }),
        ),
        JSON.stringify(bad),
      ).toBeUndefined();
    }
  });

  it("keeps an omitted unanswered list absent, and refuses a malformed one whole", () => {
    const base = assessment({ bindingId: "b1" });
    const { unansweredConcerns: _dropped, ...withoutUnanswered } = base;
    // Absent on the wire stays absent: the producer never reported, which is a
    // different fact from asserting that nothing was left unanswered.
    const omittedRaw = decodeSeatAwarenessEvent(
      assessmentEvent(withoutUnanswered as SeatAwarenessAssessment),
    );
    expect(
      omittedRaw?.kind === "assessment" && omittedRaw.assessment.unansweredConcerns,
    ).toBeUndefined();
    expect(
      "unansweredConcerns" in
        (omittedRaw?.kind === "assessment" ? omittedRaw.assessment : {}),
    ).toBe(false);
    // A present empty list is the producer's own assertion and survives decode.
    const presentEmpty = decodeSeatAwarenessEvent(
      assessmentEvent({ ...base, unansweredConcerns: [] }),
    );
    expect(
      presentEmpty?.kind === "assessment" && presentEmpty.assessment.unansweredConcerns,
    ).toEqual([]);

    const carried = decodeSeatAwarenessEvent(
      assessmentEvent({
        ...base,
        activity: null,
        selectedLineId: null,
        absences: [{ concern: "approval_requested", probability: 0.06 }],
        unansweredConcerns: ["answer_requested", "access_problem"],
      }),
    );
    expect(
      carried?.kind === "assessment" && carried.assessment.unansweredConcerns,
    ).toEqual(["answer_requested", "access_problem"]);

    for (const bad of ["no", [{}], ["vibes"], [7], [null]]) {
      expect(
        decodeSeatAwarenessEvent(
          assessmentEvent({ ...base, unansweredConcerns: bad as unknown as SeatAwarenessConcern[] }),
        ),
        JSON.stringify(bad),
      ).toBeUndefined();
    }
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

  it("lets a raised concern win over an absence for the same concern", () => {
    // The projection's two lists are mutually exclusive by construction, so this
    // cannot arrive from a well-behaved producer. The rule is pinned anyway: a
    // card must never say "AI suggests checking approval" and "checked and
    // clear" about the same concern, and a raised concern is never suppressed.
    applySeatAwarenessEvent(
      assessmentEvent(
        assessment({
          bindingId: "b1",
          activity: null,
          concerns: ["approval_requested"],
          absences: [
            { concern: "approval_requested", probability: 0.02 },
            { concern: "repetition", probability: 0.08 },
            { concern: "repetition", probability: 0.09 },
          ],
        }),
      ),
    );
    const stored = awarenessForBinding("b1");
    expect(stored?.concerns).toEqual(["approval_requested"]);
    expect(stored?.absences).toEqual([{ concern: "repetition", probability: 0.08 }]);
    const view = seatAwarenessViewForBinding({
      bindingId: "b1",
      control: control(),
      now: T0,
    });
    expect(view.clearClaim).toBeNull();
    expect(view.aiLabel).toBe("AI suggests checking approval");
    expect(view.sentence).not.toContain(SEAT_AWARENESS_CLEAR_LINE);

    // And the view refuses the collision by construction even when a caller
    // hands it an assessment that never passed ingest.
    const direct = seatAwarenessView({
      control: control(),
      assessment: assessment({
        bindingId: "b1",
        activity: null,
        concerns: ["approval_requested"],
        absences: [{ concern: "approval_requested", probability: 0.02 }],
      }),
      now: T0,
    });
    expect(direct.clearClaim).toBeNull();
    expect(direct.aiLabel).toBe("AI suggests checking approval");
    expect(direct.availabilityLine).not.toBe(SEAT_AWARENESS_CLEAR_LINE);
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
    // The failure the one currency axis exists to prevent: a continuously
    // printing seat moves its revision on every burst, and the label must
    // survive that.
    const stored = assessment({ bindingId: "b1" });
    const view = seatAwarenessView({
      control: workingControl,
      assessment: stored,
      now: T0 + 4 * 60_000,
    });
    expect(view.availability).toBe("current");
    expect(view.judgmentFreshness).toBe("current");
    expect(view.aiLabel).toBe("Likely testing");
    expect(view.freshness).toBe("AI assessment, observed 4m ago");
    // The excerpt makes no currency claim at all: it is a quotation attributed
    // to the age of the screen it was read from.
    expect(view.excerpt).toBe("3 tests failed in auth.spec.ts");
    expect(view.excerptLabel).toBe("terminal excerpt (observed 4m ago)");
  });

  it("never claims the excerpt is current, whatever the live revision is", () => {
    // Whatever the producer reports, and however exactly it matches, the
    // excerpt label is an age and nothing else. A digest-based claim could not
    // be both stable and true on a busy seat, so there is none to make.
    const stored = assessment({ bindingId: "b1" });
    for (const now of [T0, T0 + 1_000, T0 + 59_000, T0 + 4 * 60_000]) {
      const view = seatAwarenessView({ control: workingControl, assessment: stored, now });
      expect(view.excerptLabel, String(now)).toBe(
        `terminal excerpt (observed ${formatSeatAwarenessAge(now - T0)})`,
      );
      expect(view.excerptLabel, String(now)).not.toBe("terminal excerpt");
    }
    // A live revision, matching or not, changes nothing about the excerpt.
    resetSeatAwareness();
    applySeatAwarenessEvent(windowEvent("b1", "matching", T0 + 1_000));
    applySeatAwarenessEvent(assessmentEvent(stored, { at: T0 + 1_000, windowDigest: "matching" }));
    const matched = seatAwarenessViewForBinding({
      bindingId: "b1",
      control: workingControl,
      now: T0 + 8_000,
    });
    resetSeatAwareness();
    applySeatAwarenessEvent(windowEvent("b1", "moved-on", T0 + 1_000));
    applySeatAwarenessEvent(assessmentEvent(stored, { at: T0 + 1_000, windowDigest: "moved-on" }));
    const moved = seatAwarenessViewForBinding({
      bindingId: "b1",
      control: workingControl,
      now: T0 + 8_000,
    });
    expect(matched.excerptLabel).toBe("terminal excerpt (observed 8s ago)");
    expect(moved.excerptLabel).toBe(matched.excerptLabel);
    expect(moved.judgmentFreshness).toBe(matched.judgmentFreshness);
  });

  it("does not let a chrome-only repaint refresh the excerpt age", () => {
    // The producer moves the window capture time only when the material
    // revision moves, so a repaint that leaves the digest identical can no
    // longer restamp the evidence as fresher than it is. Pinned here because the
    // excerpt age is a claim about the screen the model actually read: a spinner
    // frame or a counter tick must not age it down.
    resetSeatAwareness();
    const stored = assessment({ bindingId: "b1" });
    applySeatAwarenessEvent(assessmentEvent(stored, { at: T0, windowDigest: "w1" }));
    const before = seatAwarenessViewForBinding({
      bindingId: "b1",
      control: workingControl,
      now: T0 + 30_000,
    });
    // A repaint-only emission: same material digest, newer emission time.
    applySeatAwarenessEvent(windowEvent("b1", "w1", T0 + 30_000));
    const repaint = seatAwarenessViewForBinding({
      bindingId: "b1",
      control: workingControl,
      now: T0 + 30_000,
    });
    expect(repaint.excerptLabel).toBe(before.excerptLabel);
    expect(repaint.excerptLabel).toBe("terminal excerpt (observed 30s ago)");
    expect(repaint.freshness).toBe(before.freshness);
    expect(repaint.judgmentFreshness).toBe("current");
    // A material revision still only ages the excerpt from its own observation:
    // the age follows the assessment's evidence, never the window event.
    applySeatAwarenessEvent(windowEvent("b1", "w2", T0 + 31_000));
    const material = seatAwarenessViewForBinding({
      bindingId: "b1",
      control: workingControl,
      now: T0 + 31_000,
    });
    expect(material.excerptLabel).toBe("terminal excerpt (observed 31s ago)");
    expect(material.excerpt).toBe(before.excerpt);
  });

  it("keeps the excerpt label steady through a busy seat's revisions", () => {
    // A seat printing a new material revision every two seconds, with a
    // digest-keyed scheduler observing each one. The eyebrow is sampled after
    // every event, which is what an open hover would re-render on. It never
    // switches state: the label only carries the age of its own observation,
    // and a fresh observation every couple of seconds keeps that age inside one
    // formatting bucket.
    resetSeatAwareness();
    let switches = 0;
    let previous: string | null = null;
    for (let step = 0; step < 30; step += 1) {
      const at = T0 + step * 2_000;
      const digest = `rev-${step}`;
      applySeatAwarenessEvent(windowEvent("b1", digest, at));
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
      const view = seatAwarenessViewForBinding({
        bindingId: "b1",
        control: workingControl,
        now: at,
      });
      if (previous !== null && view.excerptLabel !== previous) switches += 1;
      previous = view.excerptLabel;
    }
    // One minute of a seat printing every two seconds: zero switches.
    expect(switches).toBe(0);
    expect(previous).toBe("terminal excerpt (observed just now)");
  });

  it("treats a decisive negative as a judgment, not an abstention", () => {
    // Accepted absences are a claim. Only an observation with neither a finding
    // nor absences is an abstention.
    const clear = assessment({
      bindingId: "b1",
      activity: null,
      concerns: [],
      selectedLineId: null,
      absences: [{ concern: "execution_error", probability: 0.04 }],
    });
    expect(
      seatAwarenessAvailability(clear, { now: T0 + 1_000, controlState: "working" }),
    ).toBe("current");
    // It is still a judgment, so it ages like one.
    expect(
      seatAwarenessAvailability(clear, {
        now: T0 + SEAT_AWARENESS_TTL_MS,
        controlState: "working",
      }),
    ).toBe("stale");
    expect(
      seatAwarenessAvailability(clear, { now: T0 + 1_000, controlState: "idle" }),
    ).toBe("stale");
    // And an empty absence list is not a claim at all.
    expect(
      seatAwarenessAvailability(
        assessment({ bindingId: "b1", activity: null, concerns: [], absences: [] }),
        { now: T0 + 1_000, controlState: "working" },
      ),
    ).toBe("abstained");
    expect(
      seatAwarenessAvailability(
        assessment({ bindingId: "b1", activity: null, concerns: [] }),
        { now: T0 + 1_000, controlState: "working" },
      ),
    ).toBe("abstained");
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
      now: T0 + 8_000,
    });
    expect(view.sentence).toBe(
      "Likely testing - terminal excerpt (observed 8s ago): '3 tests failed in auth.spec.ts' - AI assessment, observed 8s ago",
    );
    expect(view.availability).toBe("current");
    expect(view.excerpt).toBe("3 tests failed in auth.spec.ts");
    expect(view.excerptLabel).toBe("terminal excerpt (observed 8s ago)");
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
      now: T0,
    });
    expect(view.aiLabel).toBe("AI suggests checking approval");
    expect(view.sentence).toBe(
      "AI suggests checking approval - terminal excerpt (observed just now): 'Allow this command to run?' - AI assessment, observed just now",
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

  it("says checked and clear for a decisive negative, distinguishably", () => {
    const clear = seatAwarenessView({
      control: control(),
      assessment: assessment({
        bindingId: "b1",
        activity: null,
        concerns: [],
        selectedLineId: null,
        absences: [{ concern: "execution_error", probability: 0.04 }],
      }),
      now: T0 + 8_000,
    });
    expect(clear.clearClaim).toBe("checked_and_clear");
    expect(clear.availability).toBe("current");
    expect(clear.availabilityLabel).toBe("CURRENT");
    expect(clear.aiLabel).toBe(SEAT_AWARENESS_CLEAR_LINE);
    expect(clear.clearNote).toBeNull();
    expect(clear.sentence).toBe(
      "checked and clear - AI assessment, observed 8s ago",
    );
    expect(clear.judgmentFreshness).toBe("current");

    // A stale decisive negative keeps the claim and withdraws only its currency.
    const staleClear = seatAwarenessView({
      control: control({ state: "idle", label: "Idle", tone: "steel" }),
      assessment: assessment({
        bindingId: "b1",
        activity: null,
        concerns: [],
        selectedLineId: null,
        absences: [{ concern: "execution_error", probability: 0.04 }],
      }),
      now: T0 + 8_000,
    });
    // A decisive negative is a finding, so an aged judgment keeps the claim and
    // withdraws only its currency: the chip says LAST OBSERVED while the body
    // still says checked and clear.
    expect(staleClear.clearClaim).toBe("checked_and_clear");
    expect(staleClear.availability).toBe("stale");
    expect(staleClear.availabilityLabel).toBe("LAST OBSERVED");
    expect(staleClear.aiLabel).toBe(SEAT_AWARENESS_CLEAR_LINE);
    expect(staleClear.sentence).toBe(
      "checked and clear - AI assessment, last observed 8s ago",
    );

    // The three "nothing to report" states never share copy. Abstention and
    // not-assessed do share the neutral line by design — they are told apart by
    // their chip, which is why all four chips must differ.
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
    const absent = seatAwarenessView({ control: control(), now: T0 });
    const failed = seatAwarenessView({
      control: control(),
      assessment: assessment({
        bindingId: "b1",
        availability: "unavailable",
        activity: null,
        selectedLineId: null,
        unavailableReason: "budget_exhausted",
      }),
      now: T0,
    });
    expect(clear.availabilityLine).toBe(SEAT_AWARENESS_NEUTRAL_LINE);
    expect(abstained.availabilityLine).toBe(SEAT_AWARENESS_NEUTRAL_LINE);
    expect(absent.availabilityLine).toBe(SEAT_AWARENESS_NEUTRAL_LINE);
    expect(clear.aiLabel).not.toBe(failed.availabilityLine);
    const labels = [clear, abstained, absent, failed].map((view) => view.availabilityLabel);
    expect(new Set(labels).size).toBe(4);
    expect(labels).toEqual(["CURRENT", "NO JUDGMENT", "NOT ASSESSED", "UNAVAILABLE"]);
    expect(abstained.clearClaim).toBeNull();
    expect(absent.clearClaim).toBeNull();
    expect(failed.clearClaim).toBeNull();
  });

  it("needs a present empty unanswered list AND a current judgment for the strong claim", () => {
    const decisive: Partial<SeatAwarenessAssessment> & { bindingId: string } = {
      bindingId: "b1",
      activity: "indeterminate",
      concerns: [],
      selectedLineId: null,
      absences: [{ concern: "approval_requested", probability: 0.06 }],
    };
    const claimFor = (
      partial: Partial<SeatAwarenessAssessment>,
      controlState?: "working" | "idle",
    ) =>
      seatAwarenessView({
        control: control(
          controlState ? { state: controlState, label: controlState, tone: "cyan" } : undefined,
        ),
        assessment: assessment({ ...decisive, ...partial }),
        now: T0 + 8_000,
      }).clearClaim;

    // All three facts: current, and a present empty list from the producer.
    expect(claimFor({ unansweredConcerns: [] })).toBe("checked_and_clear");
    // A concern left unanswered downgrades it.
    expect(claimFor({ unansweredConcerns: ["repetition"] })).toBe("no_concern_raised");
    // An aged judgment keeps the strong claim: currency belongs to the chip.
    expect(claimFor({ unansweredConcerns: [] }, "idle")).toBe("checked_and_clear");
    // Both missing is still the weaker claim, never the strong one.
    expect(claimFor({ unansweredConcerns: ["repetition"] }, "idle")).toBe("no_concern_raised");
  });

  it("never lets a producer that stayed silent claim checked and clear", () => {
    // The trap in the other direction: an omitted list means the producer never
    // reported which questions went unanswered, so the absence of the field
    // cannot be read as the producer asserting that none did. Only a PRESENT
    // empty list supports the strong claim.
    const decisive = {
      bindingId: "b1",
      activity: "indeterminate",
      concerns: [],
      selectedLineId: null,
      absences: [{ concern: "approval_requested", probability: 0.06 }],
    } satisfies Partial<SeatAwarenessAssessment> & { bindingId: string };
    const { unansweredConcerns: _absent, ...withoutUnanswered } = assessment(decisive);
    const silent = withoutUnanswered as SeatAwarenessAssessment;
    expect(silent.unansweredConcerns).toBeUndefined();

    const silentView = seatAwarenessView({
      control: control(),
      assessment: silent,
      now: T0 + 8_000,
    });
    expect(silentView.availability).toBe("current");
    expect(silentView.judgmentFreshness).toBe("current");
    expect(silentView.clearClaim).toBe("no_concern_raised");
    expect(silentView.aiLabel).toBe(SEAT_AWARENESS_NO_CONCERN_RAISED_LINE);
    expect(silentView.sentence).not.toContain(SEAT_AWARENESS_CLEAR_LINE);

    const asserted = seatAwarenessView({
      control: control(),
      assessment: { ...silent, unansweredConcerns: [] },
      now: T0 + 8_000,
    });
    expect(asserted.clearClaim).toBe("checked_and_clear");
    expect(asserted.aiLabel).toBe(SEAT_AWARENESS_CLEAR_LINE);

    // Ingest must not flatten the absence into the empty list on the way in.
    resetSeatAwareness();
    applySeatAwarenessEvent(assessmentEvent(silent));
    expect(awarenessForBinding("b1")?.unansweredConcerns).toBeUndefined();
    const storedView = seatAwarenessViewForBinding({
      bindingId: "b1",
      control: control(),
      now: T0 + 8_000,
    });
    expect(storedView.clearClaim).toBe("no_concern_raised");
  });

  it("never lets an abstention or a failure claim clear, whatever it carries", () => {
    // The trap the refinement names: an abstained or unavailable assessment
    // carries an empty unanswered list, so "empty list" alone would let it
    // claim clear. Nothing decisively answered means no clear claim at all.
    for (const availability of ["abstained", "unavailable"] as const) {
      const view = seatAwarenessView({
        control: control(),
        assessment: assessment({
          bindingId: "b1",
          availability,
          activity: null,
          concerns: [],
          selectedLineId: null,
          absences: [{ concern: "approval_requested", probability: 0.06 }],
          unansweredConcerns: [],
          unavailableReason: availability === "unavailable" ? "provider_failure" : null,
        }),
        now: T0 + 8_000,
      });
      expect(view.clearClaim, availability).toBeNull();
      expect(view.aiLabel, availability).toBeNull();
      expect(view.clearNote, availability).toBeNull();
      expect(view.judgmentFreshness, availability).toBeNull();
      expect(view.availabilityLabel, availability).toBe(
        availability === "abstained" ? "NO JUDGMENT" : "UNAVAILABLE",
      );
      expect(view.sentence, availability).not.toContain(SEAT_AWARENESS_CLEAR_LINE);
      expect(view.sentence, availability).not.toContain(SEAT_AWARENESS_NO_CONCERN_RAISED_LINE);
    }
    // The same is true of a wire-current observation with nothing in it, which
    // is an abstention once the renderer has read it.
    const empty = seatAwarenessView({
      control: control(),
      assessment: assessment({
        bindingId: "b1",
        activity: null,
        concerns: [],
        selectedLineId: null,
        absences: [],
        unansweredConcerns: [],
      }),
      now: T0 + 8_000,
    });
    expect(empty.availability).toBe("abstained");
    expect(empty.clearClaim).toBeNull();
    expect(empty.availabilityLabel).toBe("NO JUDGMENT");
  });

  it("downgrades the clear claim when a concern question went unanswered", () => {
    const base = assessment({
      bindingId: "b1",
      activity: "indeterminate",
      concerns: [],
      selectedLineId: null,
      absences: [{ concern: "approval_requested", probability: 0.06 }],
    });
    const allAnswered = seatAwarenessView({ control: control(), assessment: base, now: T0 + 8_000 });
    expect(allAnswered.clearClaim).toBe("checked_and_clear");
    expect(allAnswered.aiLabel).toBe(SEAT_AWARENESS_CLEAR_LINE);

    // The real band shape: approval decisively absent, the others unanswered.
    const banded = seatAwarenessView({
      control: control(),
      assessment: {
        ...base,
        unansweredConcerns: ["answer_requested", "access_problem", "execution_error"],
      },
      now: T0 + 8_000,
    });
    expect(banded.clearClaim).toBe("no_concern_raised");
    expect(banded.aiLabel).toBe(SEAT_AWARENESS_NO_CONCERN_RAISED_LINE);
    expect(banded.sentence).toBe("no concern raised - AI assessment, observed 8s ago");
    // The weaker claim never wears the stronger claim's words.
    expect(banded.sentence).not.toContain(SEAT_AWARENESS_CLEAR_LINE);
    expect(banded.unansweredConcerns).toEqual([
      "answer_requested",
      "access_problem",
      "execution_error",
    ]);

    // Under a determinate activity the downgraded claim is still shown, beneath.
    const bandedFinding = seatAwarenessView({
      control: control(),
      assessment: {
        ...base,
        activity: "testing",
        unansweredConcerns: ["repetition"],
      },
      now: T0 + 8_000,
    });
    expect(bandedFinding.aiLabel).toBe("Likely testing");
    expect(bandedFinding.clearNote).toBe(SEAT_AWARENESS_NO_CONCERN_RAISED_LINE);
    expect(bandedFinding.clearClaim).toBe("no_concern_raised");

    // A raised concern still wins outright, and clears nothing.
    const raised = seatAwarenessView({
      control: control(),
      assessment: {
        ...base,
        concerns: ["approval_requested"],
        unansweredConcerns: ["repetition"],
      },
      now: T0 + 8_000,
    });
    expect(raised.clearClaim).toBeNull();
    expect(raised.aiLabel).toBe("AI suggests checking approval");
    expect(raised.clearNote).toBeNull();
  });

  it("never strengthens the claim by resolving a contradictory unanswered entry", () => {
    // "Unanswered" means asked but not decisively answered, so a well-behaved
    // producer keeps it disjoint from a raised concern and an accepted absence.
    // A contradictory entry is kept rather than dropped, because dropping it can
    // EMPTY the list, and a present empty list is exactly what licenses the
    // strong "checked and clear" claim. Resolving the contradiction upward is
    // the unsafe direction; keeping the entry leaves the weaker fact, which is
    // true under either reading. Dedupe and the cap still apply.
    applySeatAwarenessEvent(
      assessmentEvent(
        assessment({
          bindingId: "b1",
          activity: "indeterminate",
          concerns: [],
          selectedLineId: null,
          absences: [{ concern: "approval_requested", probability: 0.06 }],
          // Every listed entry is also decisively absent. Dropping them would
          // turn this into a present empty list and claim "checked and clear".
          unansweredConcerns: ["approval_requested", "approval_requested"],
        }),
      ),
    );
    const stored = awarenessForBinding("b1");
    expect(stored?.unansweredConcerns).toEqual(["approval_requested"]);
    const view = seatAwarenessViewForBinding({ bindingId: "b1", control: control(), now: T0 });
    expect(view.clearClaim).toBe("no_concern_raised");
    expect(view.aiLabel).toBe(SEAT_AWARENESS_NO_CONCERN_RAISED_LINE);
    expect(view.sentence).not.toContain(SEAT_AWARENESS_CLEAR_LINE);

    // The same assessment without the contradictory entry is still allowed the
    // strong claim, so the guard does not weaken a clean producer.
    applySeatAwarenessEvent(
      assessmentEvent(
        assessment({
          bindingId: "b3",
          activity: "indeterminate",
          concerns: [],
          selectedLineId: null,
          absences: [{ concern: "approval_requested", probability: 0.06 }],
          unansweredConcerns: [],
        }),
      ),
    );
    expect(
      seatAwarenessViewForBinding({ bindingId: "b3", control: control(), now: T0 }).clearClaim,
    ).toBe("checked_and_clear");

    // A raised concern still wins outright and clears nothing, so keeping the
    // entry costs nothing on the branch that never runs.
    applySeatAwarenessEvent(
      assessmentEvent(
        assessment({
          bindingId: "b2",
          activity: "indeterminate",
          concerns: ["approval_requested"],
          selectedLineId: null,
          absences: [{ concern: "repetition", probability: 0.08 }],
          unansweredConcerns: ["approval_requested", "access_problem"],
        }),
      ),
    );
    const raisedView = seatAwarenessViewForBinding({
      bindingId: "b2",
      control: control(),
      now: T0,
    });
    expect(raisedView.aiLabel).toBe("AI suggests checking approval");
    expect(raisedView.clearClaim).toBeNull();
  });

  it("ranks the headline: concern, determinate activity, checked and clear, activity unclear", () => {
    // The contract's headline ranking, pinned in one place so a later
    // "simplification" into replacement fails here first. The clear fact is
    // never dropped; only its rank changes.
    const rank = (partial: Partial<SeatAwarenessAssessment>) =>
      seatAwarenessView({
        control: control(),
        assessment: assessment({ bindingId: "b1", ...partial }),
        now: T0 + 8_000,
      });
    const absence: SeatAwarenessAbsence = { concern: "repetition", probability: 0.08 };

    // 1. A raised concern beats everything below it, and clears nothing.
    const concernFirst = rank({
      activity: "testing",
      concerns: ["approval_requested"],
      absences: [absence],
    });
    expect(concernFirst.aiLabel).toBe("AI suggests checking approval");
    expect(concernFirst.clearNote).toBeNull();
    expect(concernFirst.clearClaim).toBeNull();

    // 2. A determinate activity beats the clear fact, which stays visible.
    const activityFirst = rank({ activity: "testing", concerns: [], absences: [absence] });
    expect(activityFirst.aiLabel).toBe("Likely testing");
    expect(activityFirst.clearNote).toBe(SEAT_AWARENESS_CLEAR_LINE);

    // 3. Checked and clear beats an indeterminate activity.
    const clearFirst = rank({ activity: "indeterminate", concerns: [], absences: [absence] });
    expect(clearFirst.aiLabel).toBe(SEAT_AWARENESS_CLEAR_LINE);
    expect(clearFirst.clearNote).toBeNull();

    // 4. An indeterminate activity is the last rung, never a finding.
    const unclear = rank({ activity: "indeterminate", concerns: [], absences: [] });
    expect(unclear.aiLabel).toBe("Activity unclear");
    expect(unclear.clearClaim).toBeNull();

    // Every rung is a judgment, so availability never falls back to abstention
    // and the deterministic fallback never fires for any of them.
    for (const view of [concernFirst, activityFirst, clearFirst, unclear]) {
      expect(view.judgmentFreshness).toBe("current");
      expect(view.availabilityLabel).toBe("CURRENT");
      expect(view.availabilityLine).toBe(SEAT_AWARENESS_NEUTRAL_LINE);
    }
  });

  it("does not let the projection's indeterminate activity pre-empt a decisive negative", () => {
    // The projection publishes `indeterminate` whenever no activity property
    // won, which is every assessment that has no activity finding. Read as a
    // finding it would take the headline and the decisive negative would never
    // render, which is what the real corpus showed before this rule.
    const clear = seatAwarenessView({
      control: control(),
      assessment: assessment({
        bindingId: "b1",
        activity: "indeterminate",
        concerns: [],
        selectedLineId: null,
        absences: [{ concern: "execution_error", probability: 0.04 }],
      }),
      now: T0 + 8_000,
    });
    expect(clear.clearClaim).toBe("checked_and_clear");
    expect(clear.aiLabel).toBe(SEAT_AWARENESS_CLEAR_LINE);
    expect(clear.clearNote).toBeNull();

    // With nothing ruled out, `indeterminate` is still the honest headline.
    const unclear = seatAwarenessView({
      control: control(),
      assessment: assessment({
        bindingId: "b1",
        activity: "indeterminate",
        concerns: [],
        selectedLineId: null,
        absences: [],
      }),
      now: T0 + 8_000,
    });
    expect(unclear.clearClaim).toBeNull();
    expect(unclear.aiLabel).toBe("Activity unclear");
    expect(unclear.judgmentFreshness).toBe("current");
    expect(unclear.availabilityLabel).toBe("CURRENT");
  });

  it("keeps the cleared fact on the surface when a finding takes the headline", () => {
    const view = seatAwarenessView({
      control: control(),
      assessment: assessment({
        bindingId: "b1",
        activity: "testing",
        concerns: [],
        selectedLineId: null,
        absences: [{ concern: "repetition", probability: 0.08 }],
      }),
      now: T0 + 8_000,
    });
    expect(view.clearClaim).toBe("checked_and_clear");
    expect(view.aiLabel).toBe("Likely testing");
    expect(view.clearNote).toBe(SEAT_AWARENESS_CLEAR_LINE);
    expect(view.sentence).toBe(
      "Likely testing - checked and clear - AI assessment, observed 8s ago",
    );
  });

  it("attributes the excerpt to its own observation age", () => {
    const view = seatAwarenessView({
      control: control(),
      assessment: assessment({ bindingId: "b1" }),
      now: T0 + 60_000,
    });
    expect(view.excerptLabel).toBe("terminal excerpt (observed 1m ago)");
    expect(view.sentence).toContain("terminal excerpt (observed 1m ago)");
    expect(view.sentence).not.toContain("terminal excerpt:");
    // The extractive excerpt is still shown, attributed to the screen it came from.
    expect(view.excerpt).toBe("3 tests failed in auth.spec.ts");
    // The judgment survives the screen churn — that is what carries currency.
    expect(view.judgmentFreshness).toBe("current");
    expect(view.freshness).toBe("AI assessment, observed 1m ago");
  });

  it("presents a current observation with no accepted judgment as an abstention", () => {
    const view = seatAwarenessView({
      control: control(),
      assessment: assessment({ bindingId: "b1", activity: null, concerns: [], selectedLineId: null }),
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
      SEAT_AWARENESS_CLEAR_LINE,
  SEAT_AWARENESS_NO_CONCERN_RAISED_LINE,
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
        now: T0,
      });
      expect(view.aiLabel).toBe(SEAT_AWARENESS_ACTIVITY_COPY[activity]);
      expect(view.aiLabel).not.toBe(view.control.label);
    }
    for (const concern of SEAT_AWARENESS_CONCERNS) {
      const view = seatAwarenessView({
        control: control({ state: "attention", label: "needs operator input", tone: "amber" }),
        assessment: assessment({ bindingId: "b1", activity: null, concerns: [concern] }),
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
          now: T0 + 8_000,
        });
        sentences.push(view.sentence, view.availabilityLine, view.availabilityLabel);
      }
    }
    for (const value of Object.values(SEAT_AWARENESS_ACTIVITY_COPY)) sentences.push(value);
    for (const value of Object.values(SEAT_AWARENESS_CONCERN_COPY)) sentences.push(value);
    for (const value of Object.values(SEAT_AWARENESS_UNAVAILABLE_COPY)) sentences.push(value);
    for (const value of Object.values(SEAT_AWARENESS_AVAILABILITY_COPY)) sentences.push(value);
    sentences.push(SEAT_AWARENESS_CLEAR_LINE);
    sentences.push(SEAT_AWARENESS_NO_CONCERN_RAISED_LINE);
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
    ]);
    expect(Object.keys(seatAwareness$.byBindingId.peek())).toEqual(["b1"]);
  });

  it("claims currency on the judgment only, never on the excerpt", () => {
    const stored = assessment({ bindingId: "b1" });
    const working = control();
    const idle = control({ state: "idle", label: "Idle", tone: "steel" });
    // The live revision cannot move any presentation state.
    const matched = seatAwarenessView({ control: working, assessment: stored, now: T0 });
    resetSeatAwareness();
    applySeatAwarenessEvent(windowEvent("b1", "moved-on", T0));
    applySeatAwarenessEvent(assessmentEvent(stored, { at: T0, windowDigest: "moved-on" }));
    const moved = seatAwarenessViewForBinding({
      bindingId: "b1",
      control: working,
      now: T0,
    });
    expect(moved.availability).toBe(matched.availability);
    expect(moved.judgmentFreshness).toBe(matched.judgmentFreshness);
    expect(moved.aiLabel).toBe(matched.aiLabel);
    expect(moved.freshness).toBe(matched.freshness);
    expect(moved.excerptLabel).toBe(matched.excerptLabel);
    // The control state moves the judgment axis and leaves the excerpt alone.
    const settled = seatAwarenessView({
      control: idle,
      assessment: stored,
      now: T0,
    });
    expect(settled.judgmentFreshness).toBe("stale");
    expect(settled.excerptLabel).toBe("terminal excerpt (observed just now)");
    expect(settled.aiLabel).toBe("Likely testing");
    // Nothing awareness does can reach the canonical control plane.
    expect(settled.control.state).toBe("idle");
    expect(settled.control.label).toBe("Idle");
  });
});
