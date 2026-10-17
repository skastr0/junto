/**
 * Awareness as an author on the seat signal contract: decisive answers become
 * `AwarenessAssessed` envelopes that decode against the contract, fold through
 * the shared reducer, and stay advisory on the one urgency ladder.
 */

import { Result, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  decodeSignalEnvelope,
  deriveNeeds,
  initialSnapshot,
  NEED_URGENCY,
  reduceSeatSignals,
  type SignalEnvelope,
} from "../src/shared/harness-domain";
import { BindingId } from "../src/shared/terminal-session-domain";
import {
  AWARENESS_PACK_VERSION,
  AWARENESS_QUESTIONS,
} from "../src/main/junto/term/awareness/questions";
import {
  selectAwarenessInput,
  type AwarenessRequestState,
} from "../src/main/junto/term/awareness/select-input";
import {
  projectAwarenessAnswers,
  type RawAwarenessAnswer,
} from "../src/main/junto/term/awareness/project-result";
import { assessmentSignals } from "../src/main/junto/term/awareness/seat-signals";
import { makeAwarenessRuntime } from "../src/main/junto/term/awareness/runtime";
import { makeAwarenessScheduler } from "../src/main/junto/term/awareness/scheduler";
import {
  EVIDENCE_TEXT,
  makeAskRecorder,
  makeFakePlane,
  makeFakeProjectionPort,
  makeFakeSeatPort,
  makeManualTimers,
  makeSnapshot,
} from "./helpers/awareness-fakes";

const OBSERVED_AT = 1_700_000_000_000;

const request = (lines: readonly string[] = ["alpha", "beta", "gamma"]): AwarenessRequestState =>
  selectAwarenessInput({
    bindingId: "seat-1",
    epoch: "e1",
    cols: 120,
    rows: 32,
    seq: 42n,
    lines,
    totalLines: lines.length,
    truncated: false,
    observedAt: OBSERVED_AT,
  });

/** Two comparable failing attempts, so the repetition question is asked. */
const paired = (): AwarenessRequestState =>
  request(["$ npm test", "Tests  2 failed", "FAIL src/a.test.ts", "", "$ npm test", "Tests  2 failed", "FAIL src/a.test.ts"]);

const noul = (req: AwarenessRequestState, questionId: string, probability: number): RawAwarenessAnswer => ({
  questionId,
  kind: "noul",
  probability,
  evidenceHash: req.evidenceHash,
});

const repetition = (req: AwarenessRequestState, selected: "repeats" | "different"): RawAwarenessAnswer => ({
  questionId: "concern.repetition",
  kind: "choice",
  selectedOptionId: selected,
  confidence: 0.95,
  optionProbabilities:
    selected === "repeats"
      ? { repeats: 0.95, different: 0.03, insufficient_evidence: 0.02 }
      : { repeats: 0.03, different: 0.95, insufficient_evidence: 0.02 },
  evidenceHash: req.evidenceHash,
});

const assess = (req: AwarenessRequestState, answers: readonly RawAwarenessAnswer[]) =>
  projectAwarenessAnswers(req, { packVersion: req.packVersion, answers });

const signalsOf = (envelopes: readonly SignalEnvelope[]) =>
  envelopes.map(({ signal }) =>
    signal._tag === "AwarenessAssessed"
      ? { questionId: signal.questionId, present: signal.present, probability: signal.probability }
      : signal._tag,
  );

const seat = Schema.decodeSync(BindingId)("seat-1");
const fold = (...batches: ReadonlyArray<readonly SignalEnvelope[]>) =>
  reduceSeatSignals(initialSnapshot(seat, 0), batches.flat());

describe("awareness signals: decisive answers only", () => {
  it("emits one envelope per decided question, in pack order, with full provenance", () => {
    const req = request();
    const envelopes = assessmentSignals(
      assess(req, [
        noul(req, "concern.execution_error", 0.02),
        noul(req, "activity.tests_running", 0.95),
        noul(req, "concern.approval_requested", 0.93),
        noul(req, "health.thrashing", 0.91),
        noul(req, "health.stuck", 0.5),
      ]),
    );

    expect(signalsOf(envelopes)).toEqual([
      { questionId: "concern.approval_requested", present: true, probability: 0.93 },
      { questionId: "concern.execution_error", present: false, probability: 0.98 },
      { questionId: "health.thrashing", present: true, probability: 0.91 },
      { questionId: "activity.tests_running", present: true, probability: 0.95 },
    ]);
    for (const envelope of envelopes) {
      expect(Result.isSuccess(decodeSignalEnvelope(envelope))).toBe(true);
      expect(envelope).toMatchObject({
        seat: "seat-1",
        at: OBSERVED_AT,
        source: "awareness",
        fidelity: "screen",
        signal: { evidenceHash: req.evidenceHash, packVersion: AWARENESS_PACK_VERSION },
      });
    }
    expect(envelopes.map(({ signal }) => signal._tag === "AwarenessAssessed" && signal.answer)).toEqual([
      { axis: "concern", value: "approval_requested" },
      { axis: "concern", value: "execution_error" },
      { axis: "health", value: "thrashing" },
      { axis: "activity", value: "testing" },
    ]);
  });

  it("does not re-emit a concern as the health reading the pack derives from it", () => {
    const req = request();
    const assessment = assess(req, [noul(req, "concern.answer_requested", 0.95)]);
    expect(assessment.health?.signals.map((signal) => signal.questionId)).toEqual(["concern.answer_requested"]);
    expect(signalsOf(assessmentSignals(assessment))).toEqual([
      { questionId: "concern.answer_requested", present: true, probability: 0.95 },
    ]);
  });

  it("emits nothing for indecisive, unavailable or highlight-only answers", () => {
    const req = request();
    expect(assessmentSignals(assess(req, [noul(req, "concern.approval_requested", 0.5)]))).toEqual([]);
    expect(assessmentSignals(assess(req, []))).toEqual([]);
    expect(
      assessmentSignals(
        assess(req, [
          {
            questionId: "highlight.line",
            kind: "choice",
            selectedOptionId: "L000",
            confidence: 0.95,
            optionProbabilities: { L000: 0.95, NONE: 0.05 },
            evidenceHash: req.evidenceHash,
          },
        ]),
      ),
    ).toEqual([]);
  });

  it("holds a strong good claim back until its partner is decided too", () => {
    const req = request();
    expect(signalsOf(assessmentSignals(assess(req, [noul(req, "health.exceeding", 0.95)])))).toEqual([]);
    expect(
      signalsOf(
        assessmentSignals(assess(req, [noul(req, "health.exceeding", 0.95), noul(req, "health.succeeding", 0.92)])),
      ),
    ).toEqual([
      { questionId: "health.exceeding", present: true, probability: 0.95 },
      { questionId: "health.succeeding", present: true, probability: 0.92 },
    ]);
  });

  it("reads a repetition Choice on the concern axis, both ways", () => {
    const req = paired();
    expect(signalsOf(assessmentSignals(assess(req, [repetition(req, "repeats")])))).toEqual([
      { questionId: "concern.repetition", present: true, probability: 0.95 },
    ]);
    expect(signalsOf(assessmentSignals(assess(req, [repetition(req, "different")])))).toEqual([
      { questionId: "concern.repetition", present: false, probability: 0.95 },
    ]);
  });

  it("answers every askable axis question with a value the contract accepts", () => {
    const req = paired();
    const answers = req.questions.flatMap((question): RawAwarenessAnswer[] => {
      if (question.id === "concern.repetition") return [repetition(req, "repeats")];
      return question.kind === "noul" ? [noul(req, question.id, 0.95)] : [];
    });
    const envelopes = assessmentSignals(assess(req, answers));
    const axisQuestions = AWARENESS_QUESTIONS.filter(
      (question) => req.questions.some((asked) => asked.id === question.id) && question.id !== "highlight.line",
    ).map((question) => question.id);
    expect(envelopes.map(({ signal }) => signal._tag === "AwarenessAssessed" && signal.questionId)).toEqual(axisQuestions);
    for (const envelope of envelopes) expect(Result.isSuccess(decodeSignalEnvelope(envelope))).toBe(true);
  });
});

describe("awareness signals: on the contract", () => {
  it("raises advisory needs no higher than escalated and withdraws them on a decisive clear", () => {
    const first = request();
    const raised = fold(
      assessmentSignals(
        assess(first, [noul(first, "concern.approval_requested", 0.95), noul(first, "health.thrashing", 0.95)]),
      ),
    );
    const needs = deriveNeeds(raised).filter((need) => need.source === "awareness");
    expect(needs.map((need) => need.cause)).toEqual(["awareness_approval", "awareness_thrashing"]);
    for (const need of needs) expect(need.urgency).toBeLessThanOrEqual(NEED_URGENCY.escalated);
    expect(needs[0]!.probability).toBe(0.95);

    const second = request(["alpha", "beta", "approved, continuing"]);
    const cleared = reduceSeatSignals(
      raised,
      assessmentSignals(assess(second, [noul(second, "concern.approval_requested", 0.03)])),
    );
    expect(deriveNeeds(cleared).filter((need) => need.source === "awareness").map((need) => need.cause)).toEqual([
      "awareness_thrashing",
    ]);
  });
});

describe("awareness signals: runtime stream", () => {
  it("publishes each assessment's envelopes once, and a replay adds none", async () => {
    const timers = makeManualTimers();
    const plane = makeFakePlane();
    const seats = makeFakeSeatPort();
    const projection = makeFakeProjectionPort();
    const model = makeAskRecorder();
    const options = { seats, projection, config: {}, clock: timers.clock, timers };
    const scheduler = makeAwarenessScheduler({
      ...options,
      ask: model.ask,
      unavailable: model.unavailable,
      modelId: "jev-latest",
      modelAvailable: true,
      modelUnavailableReason: undefined,
      random: () => 0.5,
    });
    const runtime = makeAwarenessRuntime({ ...options, plane: plane.plane, scheduler });
    const received: SignalEnvelope[] = [];
    runtime.subscribeSignals((envelope) => received.push(envelope));
    runtime.start();

    seats.set("s1", {});
    plane.publish(makeSnapshot({ bindingId: "s1", epoch: "e1", text: EVIDENCE_TEXT }));
    timers.advance(0);
    timers.advance(300);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(runtime.advisory("s1").status).toBe("fresh");
    expect(signalsOf(received)).toEqual([
      { questionId: "concern.approval_requested", present: true, probability: 0.97 },
    ]);

    runtime.hover("s1");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(received).toHaveLength(1);
    runtime.stop();
  });
});
