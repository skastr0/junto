// Factory pause plane — pure law. The switch state itself is app-state
// (never the document; see pause-plane in main): definitions travel with
// the file, the switch that lets the crew act exists only in the running
// app, flipped by a human. Pause is canvas-wide only: there is no node or
// region pause.
//
// LAW: a canvas with no recorded play decision is PAUSED. The crew is
// born paused, always; the first play is an explicit operator confirmation.

export type CanvasPauseState = {
  /** false = paused. Absence of a record decodes to false — paused. */
  readonly playing: boolean;
  /** Latch for the first-play confirmation. */
  readonly everPlayed: boolean;
};

export type PauseChangeListener = (
  canvas: string,
  previous: CanvasPauseState,
  current: CanvasPauseState,
) => void;

/** Only a released pause authorizes resuming held delivery. */
export const pauseWasResumed = (
  previous: CanvasPauseState,
  current: CanvasPauseState,
): boolean => current.playing && !previous.playing;

/** The born-paused default: not playing, never played. */
export const PAUSED_CANVAS: CanvasPauseState = {
  playing: false,
  everPlayed: false,
};
