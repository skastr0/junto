/**
 * Junto's sound: a procedural engine written on the Web Audio API. No
 * samples, no dependencies; every cue is synthesized from one palette
 * (palette.ts, voices.ts) through one room (graph.ts), picked by meaning
 * (cues.ts) and thinned by the mixer (mixer.ts) so a busy canvas stays calm.
 *
 * Callers name what happened; they never pick a sound or a volume.
 */

import { state$ } from "../state";
import { SoundEngine } from "./engine";
import { CUES, type CueId } from "./cues";
import type { CueRequest, RequestOutcome } from "./mixer";

export {
  CATEGORY_LABEL,
  CUE_IDS,
  CUES,
  cuesInCategory,
  isCueId,
  type CueId,
  type MailTone,
} from "./cues";
export type { CueRequest } from "./mixer";

export const soundEngine = new SoundEngine();

/** How long a canvas that just opened stays quiet while its seats hydrate. */
const OPEN_HUSH_MS = 4_000;
state$.canvasName.onChange(() => soundEngine.hush(OPEN_HUSH_MS));

/** How far left or right a seat can place its sound: a hint, never a jump. */
export const PAN_SPREAD = 0.6;

/** A screen x (0 at the left edge, `width` at the right) as a stereo position. */
export const panForScreenX = (x: number, width: number): number =>
  Math.max(-PAN_SPREAD, Math.min(PAN_SPREAD, ((x / Math.max(1, width)) * 2 - 1) * PAN_SPREAD));

/** Where a canvas node sits across the window, if it is drawn. */
const panForNode = (nodeId: string): number | undefined => {
  if (typeof document === "undefined" || typeof window === "undefined") return undefined;
  const node = document.querySelector(`.react-flow__node[data-id="${CSS.escape(nodeId)}"]`);
  if (node === null) return undefined;
  const box = node.getBoundingClientRect();
  return panForScreenX(box.left + box.width / 2, window.innerWidth);
};

/**
 * Something happened that has a sound. A cue about a seat comes from where
 * the seat sits on screen (off screen, from the side it is on).
 */
export const playCue = (cue: CueId, request: CueRequest = {}): RequestOutcome | "silent" =>
  soundEngine.play(
    cue,
    request.pan === undefined && request.subject !== undefined
      ? { ...request, pan: panForNode(request.subject) }
      : request,
  );

/** Settings: hear one cue at the current levels. */
export const previewCue = (cue: CueId): void => soundEngine.previewCue(cue);

/** Settings: hear every cue in a family, or all of them, one after another. */
export const previewCues = (cues: ReadonlyArray<CueId>): void =>
  soundEngine.previewRun(cues.map((cue) => ({ cue, variant: { count: 1 } })));

/** What a native notification is about (notifications.ts posts them silent). */
export type NotificationCueKind = "blocked" | "needs-you" | "done" | "failed" | "summary";

const NOTIFICATION_CUE: Readonly<Record<NotificationCueKind, CueId>> = {
  blocked: "blocked",
  "needs-you": "waiting",
  done: "done",
  failed: "failed",
  summary: "summary",
};

/**
 * The sound for a native notification. It goes through the same mixer as
 * the in-app cue for the same event, so the operator hears it once.
 */
export const playNotificationCue = (kind: NotificationCueKind): void => {
  soundEngine.play(NOTIFICATION_CUE[kind], { echo: true });
};

/** Demo scenario sound ids, mapped onto the catalog. */
const DEMO_CUE: Readonly<Record<string, CueId>> = {
  alert: "waiting",
  artifact: "done",
  clear: "answered",
  cycle: "navigate",
  request: "review",
  task: "working",
  wake: "working",
};

export const playDemoCue = (id: string): void => {
  const cue = id in CUES ? (id as CueId) : DEMO_CUE[id];
  if (cue !== undefined) soundEngine.play(cue);
};
