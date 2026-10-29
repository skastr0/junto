// The quick replies' rules, free of the settings store: what a key picks,
// the merged row, the four answers and how they are sent. quick-replies.ts
// adds the operator's lists, read from settings, and re-exports these.

/** Keys 1..9 pick the matching quick reply; anything else picks none. */
export const quickReplyForKey = (replies: ReadonlyArray<string>, key: string): string | null => {
  if (!/^[1-9]$/.test(key)) return null;
  return replies[Number(key) - 1] ?? null;
};

/**
 * The sendable row as one list: the seat's suggested replies first, then the
 * operator's own replies minus exact repeats. Pills and the 1..9 keys both
 * read this, so what is marked is what sends.
 */
export const mergedQuickReplies = (
  replies: ReadonlyArray<string>,
  suggested: ReadonlyArray<string> | undefined,
): ReadonlyArray<string> => {
  if (!suggested || suggested.length === 0) return replies;
  const taken = new Set(suggested);
  return [...suggested, ...replies.filter((text) => !taken.has(text))];
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

/**
 * The four answers to a signal, as the feed sends them: a reply mails and
 * wakes the seat; a quiet note and an acknowledgement (a quiet answer with
 * no note) are recorded without mail; a dismissal closes it untold.
 */
export type SignalAnswer =
  | { readonly kind: "reply"; readonly text: string }
  | { readonly kind: "quiet"; readonly text: string }
  | { readonly kind: "acknowledge" }
  | { readonly kind: "dismiss" };

/** What the busy pill is matched on: quiet and waking rows may share a text. */
export const answerLabel = (answer: SignalAnswer): string =>
  answer.kind === "reply" ? answer.text : answer.kind === "quiet" ? `quiet:${answer.text}` : answer.kind;

const SHIFTED_DIGIT = /^(?:Digit|Numpad)([1-9])$/;

/**
 * A key on the selected feed card, as an answer: 1..9 a quick reply,
 * Shift+1..9 a quiet note (read off the physical key, since Shift changes
 * what the digit types), a acknowledges, d dismisses. Anything else is none.
 */
export const feedAnswerForKey = (
  event: { readonly key: string; readonly code: string; readonly shiftKey: boolean },
  replies: ReadonlyArray<string>,
  quietNotes: ReadonlyArray<string>,
): SignalAnswer | null => {
  if (event.shiftKey) {
    const digit = SHIFTED_DIGIT.exec(event.code);
    const text = digit ? quietNotes[Number(digit[1]) - 1] : undefined;
    return text === undefined ? null : { kind: "quiet", text };
  }
  if (event.key === "a") return { kind: "acknowledge" };
  if (event.key === "d") return { kind: "dismiss" };
  const text = quickReplyForKey(replies, event.key);
  return text === null ? null : { kind: "reply", text };
};

type AnswerResult = { readonly ok: true } | { readonly ok: false; readonly message: string };

/**
 * Send one of the four answers through the signal actions: a reply as mail,
 * a quiet note with `silent`, an acknowledgement as an empty silent answer
 * (main records it answered, no mail), a dismissal through dismiss.
 */
export const sendSignalAnswer = <R extends AnswerResult>(
  signalId: string,
  answer: SignalAnswer,
  actions: {
    readonly respond: (signalId: string, text: string, options?: { readonly silent?: boolean }) => Promise<R>;
    readonly dismiss: (signalId: string) => Promise<R>;
  },
): Promise<R> => {
  switch (answer.kind) {
    case "reply":
      return actions.respond(signalId, answer.text);
    case "quiet":
      return actions.respond(signalId, answer.text, { silent: true });
    case "acknowledge":
      return actions.respond(signalId, "", { silent: true });
    case "dismiss":
      return actions.dismiss(signalId);
  }
};
