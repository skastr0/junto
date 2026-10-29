import { use$ } from "@legendapp/state/react";
import { feedSettings, quietNotesOf } from "@shared/settings";
import { state$ } from "./state";

/**
 * The operator's quick replies, read from settings. Offered as one-click
 * answers on open agent signals; each is sent through the ordinary answer
 * path, so it reaches the seat as operator mail.
 */
export const useQuickReplies = (): ReadonlyArray<string> =>
  use$(() => feedSettings(state$.settings.get()).quickReplies);

/**
 * The operator's quiet notes: answers recorded on the signal without mail,
 * so the seat is not woken and reads them in `signal list`.
 */
export const useQuietNotes = (): ReadonlyArray<string> => use$(() => quietNotesOf(state$.settings.get()));

export * from "./quick-reply-rules";
