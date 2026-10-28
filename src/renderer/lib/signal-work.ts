/**
 * The operator's work in the needs-you feed (plan 0.11/07, N3): what a
 * signal asks of the operator, how far a reply has come toward its
 * condition, and where open work sits on the urgency ladder.
 *
 * Stand-in: N1 (product-feed) names the contract. Until it lands these are
 * the feed's own names for the fields a signal will carry; the switch is a
 * rename here and nowhere else.
 */
import { admitLinkUrl } from "@shared/wire/agent-signals";
import type { ContentRef } from "@shared/wire/content-ref";
import { signalWordCount } from "@shared/word-count";

/**
 * The reply a signal asks for, one per signal. `artifact` is a document the
 * operator writes in the signal, made in an Artifacts node; `proof` is text
 * with links or files; `text` is today's reply. The secret form comes with
 * N5 (a vault), not here.
 */
export type SignalForm =
  | { readonly kind: "text" }
  | {
      readonly kind: "artifact";
      /** The Artifacts node the document is made in. */
      readonly nodeId: string;
      /** The document's title; the raise defaults it to the signal's text. */
      readonly title: string;
      readonly labels: ReadonlyArray<string>;
      /** The condition: at least this many words (1 when the raise named none). */
      readonly minWords: number;
    }
  | { readonly kind: "proof" };

/** What a work signal carries (`signal.work`): when it is due, and whether whoever raised it marked it urgent. */
export type WorkTiming = { readonly dueAt?: number; readonly urgent?: boolean };

/** Open work on the ladder: `due` once urgent or past its due time, `todo` before (N1's levelOfSignal decides; this mirrors it). */
export const workLevel = ({ dueAt, urgent }: WorkTiming, nowMs: number): "due" | "todo" =>
  urgent === true || (dueAt !== undefined && dueAt <= nowMs) ? "due" : "todo";

const DAY_MS = 86_400_000;

/**
 * When work is due, in words: "due 18:00" today, "due tomorrow 09:00",
 * "due Fri 09:00" within the week, "due 3 Nov" further out; once passed,
 * "was due 09:00" and so on. Nothing without a due time.
 */
export const dueWords = (due: number | undefined, nowMs: number, timeZone?: string): string | undefined => {
  if (due === undefined) return undefined;
  const zone = timeZone === undefined ? {} : { timeZone };
  const dayOf = (ms: number): string => new Intl.DateTimeFormat("en-CA", { ...zone, dateStyle: "short" }).format(ms);
  const time = new Intl.DateTimeFormat("en-GB", { ...zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(due);
  const days = Math.round((Date.parse(dayOf(due)) - Date.parse(dayOf(nowMs))) / DAY_MS);
  const when =
    days === 0
      ? time
      : days === 1
        ? `tomorrow ${time}`
        : days === -1
          ? `yesterday ${time}`
          : Math.abs(days) < 7
            ? `${new Intl.DateTimeFormat("en-GB", { ...zone, weekday: "short" }).format(due)} ${time}`
            : new Intl.DateTimeFormat("en-GB", { ...zone, day: "numeric", month: "short" }).format(due);
  return `${due <= nowMs ? "was due" : "due"} ${when}`;
};

/** How far a written reply is toward an artifact form's word condition. */
export type WordProgress = { readonly words: number; readonly min: number; readonly met: boolean };

export const wordProgressOf = (markdown: string, minWords: number): WordProgress => {
  const words = signalWordCount(markdown);
  const min = Math.max(1, minWords);
  return { words, min, met: words >= min };
};

/** The condition as it fills: "212 words of 500"; with the default of one, only the count. */
export const wordProgressWords = ({ words, min }: WordProgress): string => {
  const counted = `${words} ${words === 1 ? "word" : "words"}`;
  return min <= 1 ? counted : `${counted} of ${min}`;
};

/** What the operator hands in for a form: the document's markdown, or proof. */
export type WorkReply =
  | { readonly kind: "artifact"; readonly markdown: string; readonly replyId: string }
  | {
      readonly kind: "proof";
      readonly text: string;
      readonly links: ReadonlyArray<string>;
      readonly files: ReadonlyArray<ContentRef>;
      readonly replyId: string;
    };

/** The links a proof carries, one per line, admitted as the wire admits a link; the first line that is not, and why. */
export const proofLinksOf = (
  typed: string,
): { readonly links: ReadonlyArray<string>; readonly problem?: string } => {
  const links: Array<string> = [];
  for (const line of typed.split("\n").map((each) => each.trim()).filter((each) => each !== "")) {
    const admitted = admitLinkUrl(line);
    if (!admitted.ok) return { links, problem: `${line}: ${admitted.reason}.` };
    links.push(admitted.url);
  }
  return { links };
};

/**
 * What the operator has written for a signal and not handed in, kept for as
 * long as the window runs: closing the feed, or moving to another signal,
 * never loses a page of writing.
 */
const drafts = new Map<string, string>();
export const workDraftOf = (signalId: string): string => drafts.get(signalId) ?? "";
export const keepWorkDraft = (signalId: string, text: string): void => {
  if (text === "") drafts.delete(signalId);
  else drafts.set(signalId, text);
};
