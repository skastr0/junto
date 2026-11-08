import { Context, Effect, Layer, Schema } from "effect";
import type { CanvasPauseState, PauseChangeListener } from "@shared/pause";

// Factory pause plane — the safety switch that decides whether the factory
// may act at all. App-state, never the document: definitions travel with the
// file; the switch that spends real actions exists only in the running app,
// flipped by a human.
//
// LAW (enforced here and in @shared/pause): a canvas with no recorded play
// decision is PAUSED. The factory is born paused; the first play is an
// explicit operator confirmation (everPlayed is the latch the UI reads).
//
// Fail closed, fail loud: unreadable SQLite state leaves every canvas paused
// and refuses writes so corrupt state is never clobbered.
//
// LAUNCH (Command Center): every canvas the operator has played before comes
// back playing, so mail and work reach their seats without a press of play
// per launch. Seats still start only when work arrives for them. A canvas
// never played keeps the one-time first-play confirmation. Pause is
// canvas-wide only.
//
// A canvas held as a copy is another machine's to play or pause. Launch
// leaves it as the last copy said: a machine that starts with no link must
// not play what the operator paused.

/** A pause state mutation that could not land durably. */
export class PauseStateError extends Schema.TaggedError<PauseStateError>()(
  "PauseStateError",
  { message: Schema.String },
) {}

export class PausePlane extends Context.Service<PausePlane,
  {
    /** Hydrate from normalized SQLite state. Idempotent. */
    readonly start: Effect.Effect<void>;
    /** Sync hot read — unknown canvas is the born-paused default. */
    readonly stateFor: (canvas: string) => CanvasPauseState;
    /** Canvas play/pause. Playing stamps everPlayed. Store-first. */
    readonly setPlaying: (
      canvas: string,
      playing: boolean,
    ) => Effect.Effect<void, PauseStateError>;
    readonly subscribe: (listener: PauseChangeListener) => () => void;
  }>()("junto/PausePlane") {}

/**
 * Harness double: everything playing, writes accepted but inert. For suites
 * and acceptance scripts exercising OTHER planes (transport, authz, arming) —
 * never for pause-behavior tests.
 */
export const PausePlaneAllPlaying = Layer.succeed(PausePlane, {
  start: Effect.void,
  stateFor: () => ({ playing: true, everPlayed: true }),
  setPlaying: () => Effect.void,
  subscribe: () => () => {},
});
