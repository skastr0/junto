/**
 * Everything that can change what a phone shows bumps the companion's change
 * clock: canvas documents, seat state, Jev readings, pause, mail delivery,
 * the desktop's report, preambles, and every signal (whoever changed it: an
 * agent raising or withdrawing, the operator answering or dismissing, on the
 * desktop or the phone). Returns the unsubscribe.
 */
import { Effect } from "effect";
import type { PreambleEvent } from "@shared/preamble";
import { AppRuntime } from "../../runtime";
import { CanvasesService } from "../canvases";
import { PausePlane } from "../pause-plane";
import { raisedHands } from "../signals/raised-hands";
import { seatStateRuntime } from "../term/agent-state";
import { seatAwarenessPlane } from "../term/seat-awareness";
import { messageDelivery } from "../work/message-delivery";
import { noteMailFailure } from "./backend";
import type { CompanionChanges } from "./changes";
import { onDesktopReport } from "./desktop-report";
import { notePreamble } from "./preambles";

let changesRef: CompanionChanges | undefined;

export const wireCompanionChanges = async (changes: CompanionChanges): Promise<() => void> => {
  changesRef = changes;
  const [canvases, pause] = await AppRuntime.runPromise(Effect.all([CanvasesService, PausePlane]));
  const offs = [
    canvases.subscribeChanges(() => changes.bump()),
    pause.subscribe(() => changes.bump()),
    seatStateRuntime.subscribe(() => changes.bump()),
    seatAwarenessPlane.subscribe(() => changes.bump()),
    raisedHands.onSignal((signal) => changes.noteSignal(signal)),
    messageDelivery.subscribeDelivered((event) => {
      if (event.failed) noteMailFailure(event.messageId);
      changes.bump();
    }),
    onDesktopReport(() => changes.bump()),
  ];
  return () => {
    for (const off of offs) off();
    changesRef = undefined;
  };
};

/** Main hears every preamble here first; the phone keeps it while it is live. */
export const companionNotePreamble = (event: PreambleEvent): void => {
  notePreamble(event);
  changesRef?.bump();
};
