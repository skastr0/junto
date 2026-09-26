import { use$ } from "@legendapp/state/react";
import { feedSettings } from "@shared/settings";
import { state$ } from "./state";

/**
 * The operator's quick replies, read from settings. Offered as one-click
 * answers on open agent signals; each is sent through the ordinary answer
 * path, so it reaches the seat as operator mail.
 */
export const useQuickReplies = (): ReadonlyArray<string> =>
  use$(() => feedSettings(state$.settings.get()).quickReplies);

/** Keys 1..9 pick the matching quick reply; anything else picks none. */
export const quickReplyForKey = (replies: ReadonlyArray<string>, key: string): string | null => {
  if (!/^[1-9]$/.test(key)) return null;
  return replies[Number(key) - 1] ?? null;
};

/** Move one reply up or down; out-of-range moves leave the list as it is. */
export const moveQuickReply = (
  replies: ReadonlyArray<string>,
  index: number,
  step: -1 | 1,
): ReadonlyArray<string> => {
  const target = index + step;
  if (index < 0 || index >= replies.length || target < 0 || target >= replies.length) return replies;
  const next = [...replies];
  [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
};
