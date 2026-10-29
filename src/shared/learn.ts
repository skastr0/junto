/**
 * Lessons: the scenes and quizzes the first-run tour, the website docs and
 * the landing page all teach from (content/learn/{scenes,quizzes}/*.json).
 *
 * A scene is a scripted patch of canvas: seats, regions and wires, and beats
 * that change them over time, drawn with the app's own views (src/renderer/kit).
 * Its vocabulary is the app's, so a scene can only show what Junto draws.
 * A quiz is a section's questions, each one grounded in code receipts that
 * tests/learn-content.test.ts checks against the commit they name.
 *
 * Decode with `decodeScene` / `decodeQuiz`; both refuse a malformed file
 * with the field that is wrong.
 */
import { Schema } from "effect";
import { PREAMBLE_ACTIONS, PREAMBLE_PROVENANCES, PREAMBLE_TONES } from "./preamble";
import { SEAT_RAISE_KINDS } from "./wire/agent-signals";
import { THREAD_HEALTH_TONES, THREAD_HEALTH_VALUES } from "./wire/thread-health";

/** File-name ids: lowercase words joined by hyphens. */
const LessonId = Schema.String.pipe(Schema.check(Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)));
const Text = Schema.String.pipe(Schema.check(Schema.isMinLength(1)));
const Px = Schema.Number.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)));

// --- Scenes ------------------------------------------------------------------

export const SceneRegion = Schema.Struct({
  id: Text,
  label: Text,
  x: Px,
  y: Px,
  width: Px,
  height: Px,
  color: Schema.optionalKey(Text),
});

export const SceneSeat = Schema.Struct({
  id: Text,
  name: Text,
  harness: Text,
  x: Px,
  y: Px,
  caption: Schema.optionalKey(Text),
  overseer: Schema.optionalKey(Schema.Boolean),
});

export const SceneWire = Schema.Struct({
  id: Text,
  from: Text,
  to: Text,
  verb: Schema.Literal("messages"),
});

/** The seat's control state, as terminalActivity reads it (shared/wire/seat-activity.ts). */
export const SceneTerminal = Schema.Struct({
  seatState: Schema.Literals(["idle", "working", "attention", "unknown"]),
  /** Done and not yet read: green until the operator opens it. */
  needsLook: Schema.optionalKey(Schema.Boolean),
  /** With `unknown`, a seat that is not running. */
  managedSeat: Schema.optionalKey(Schema.Boolean),
});

/** An AI reading of the session (experimental in the app). */
export const SceneHealth = Schema.Struct({
  health: Schema.Literals(THREAD_HEALTH_TONES),
  value: Schema.optionalKey(Schema.Literals(THREAD_HEALTH_VALUES)),
  line: Schema.optionalKey(Text),
});

export const SceneSignal = Schema.Struct({
  kind: Schema.Literals(SEAT_RAISE_KINDS),
  text: Text,
});

export const SceneBubble = Schema.Struct({
  text: Text,
  provenance: Schema.Literals(PREAMBLE_PROVENANCES),
  action: Schema.optionalKey(Schema.Literals(PREAMBLE_ACTIONS)),
  tone: Schema.optionalKey(Schema.Literals(PREAMBLE_TONES)),
});

/** A patch on one seat: a beat changes only what it names, and null clears. */
export const SceneSeatPatch = Schema.Struct({
  id: Text,
  terminal: Schema.optionalKey(SceneTerminal),
  health: Schema.optionalKey(Schema.NullOr(SceneHealth)),
  signal: Schema.optionalKey(Schema.NullOr(SceneSignal)),
  bubble: Schema.optionalKey(Schema.NullOr(SceneBubble)),
  selected: Schema.optionalKey(Schema.Boolean),
});

/**
 * Light along a wire. Mail is a notice (violet) or a prompt (amber): those
 * are the kinds delivery sends (shared/wire-traffic.ts, wireTrafficOfMail).
 */
export const ScenePulse = Schema.Struct({
  wire: Text,
  kind: Schema.Literals(["notice", "prompt"]),
  reverse: Schema.optionalKey(Schema.Boolean),
});

/** A card in the needs-you feed, from shown through answered and leaving. */
export const SceneFeed = Schema.Struct({
  item: Text,
  seat: Text,
  kind: Schema.Literals(SEAT_RAISE_KINDS),
  text: Text,
  detail: Schema.optionalKey(Text),
  suggest: Schema.optionalKey(Schema.Array(Text)),
  phase: Schema.Literals(["shown", "selected", "sending", "leaving"]),
  /** While sending: which quick reply, from 0. */
  reply: Schema.optionalKey(Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)))),
});

export const SceneBeat = Schema.Struct({
  /** Milliseconds from the scene's start. */
  at: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  seat: Schema.optionalKey(SceneSeatPatch),
  pulse: Schema.optionalKey(ScenePulse),
  feed: Schema.optionalKey(SceneFeed),
});

const duplicate = (ids: ReadonlyArray<string>): string | undefined =>
  ids.find((id, index) => ids.indexOf(id) !== index);

export const Scene = Schema.Struct({
  id: LessonId,
  /** What the scene shows, for assistive tech; the drawing itself is decorative. */
  label: Text,
  stage: Schema.Struct({ width: Px, height: Px }),
  regions: Schema.optionalKey(Schema.Array(SceneRegion)),
  seats: Schema.Array(SceneSeat).pipe(Schema.check(Schema.isMinLength(1))),
  wires: Schema.Array(SceneWire),
  beats: Schema.Array(SceneBeat),
  loop: Schema.Boolean,
  /** A slot beside the stage the host fills with real app chrome (the tour's editor, composer). */
  aside: Schema.optionalKey(Text),
}).pipe(
  Schema.check(
    Schema.makeFilter(({ seats, wires, beats, regions }) => {
      const seatIds = seats.map((seat) => seat.id);
      const wireIds = wires.map((wire) => wire.id);
      const twice = duplicate(seatIds) ?? duplicate(wireIds) ?? duplicate((regions ?? []).map((region) => region.id));
      if (twice !== undefined) return `id "${twice}" is used twice`;
      for (const wire of wires) {
        if (!seatIds.includes(wire.from) || !seatIds.includes(wire.to)) return `wire "${wire.id}" joins a seat the scene does not have`;
      }
      for (const [index, beat] of beats.entries()) {
        if (index > 0 && beat.at < beats[index - 1]!.at) return `beat ${String(index)} comes before the one above it`;
        if (beat.seat === undefined && beat.pulse === undefined && beat.feed === undefined) return `beat ${String(index)} changes nothing`;
        if (beat.seat !== undefined && !seatIds.includes(beat.seat.id)) return `beat ${String(index)} names seat "${beat.seat.id}", not in the scene`;
        if (beat.pulse !== undefined && !wireIds.includes(beat.pulse.wire)) return `beat ${String(index)} names wire "${beat.pulse.wire}", not in the scene`;
        if (beat.feed !== undefined && !seatIds.includes(beat.feed.seat)) return `beat ${String(index)} feeds seat "${beat.feed.seat}", not in the scene`;
      }
      return true;
    }),
  ),
);
export type Scene = typeof Scene.Type;

// --- Quizzes -----------------------------------------------------------------

/** `path:line` or `path:from-to`, at the commit it was read: `src/a.ts:12-14@1a2b3c4d5`. */
export const RECEIPT_PATTERN = /^([^\s:@]+):(\d+)(?:-(\d+))?@([0-9a-f]{7,40})$/;
const Receipt = Schema.String.pipe(Schema.check(Schema.isPattern(RECEIPT_PATTERN)));

export const QuizChoice = Schema.Struct({
  id: Text,
  text: Text,
  correct: Schema.optionalKey(Schema.Literal(true)),
  /** Why it is right, or why it is wrong: every choice says. */
  why: Text,
});

export const QuizQuestion = Schema.Struct({
  id: Text,
  /** Concept ids, so a tour chapter and a docs section pull the same questions. */
  concepts: Schema.Array(LessonId).pipe(Schema.check(Schema.isMinLength(1))),
  /** Who it is for: the operator, their agents, or both. */
  reader: Schema.Literals(["you", "agent", "both"]),
  prompt: Text,
  choices: Schema.Array(QuizChoice).pipe(Schema.check(Schema.isMinLength(2), Schema.isMaxLength(4))),
  receipts: Schema.Array(Receipt).pipe(Schema.check(Schema.isMinLength(1))),
}).pipe(
  Schema.check(
    Schema.makeFilter(({ choices }) => {
      if (choices.filter((choice) => choice.correct === true).length !== 1) return "exactly one choice is correct";
      const twice = duplicate(choices.map((choice) => choice.id));
      return twice === undefined || `choice id "${twice}" is used twice`;
    }),
  ),
);

export const Quiz = Schema.Struct({
  id: LessonId,
  title: Text,
  questions: Schema.Array(QuizQuestion).pipe(Schema.check(Schema.isMinLength(3), Schema.isMaxLength(5))),
}).pipe(
  Schema.check(
    Schema.makeFilter(({ questions }) => {
      const twice = duplicate(questions.map((question) => question.id));
      return twice === undefined || `question id "${twice}" is used twice`;
    }),
  ),
);
export type Quiz = typeof Quiz.Type;

export const decodeScene = Schema.decodeUnknownSync(Scene);
export const decodeQuiz = Schema.decodeUnknownSync(Quiz);
