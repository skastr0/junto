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
import type { AgentSignalOperatorResult } from "@shared/ipc";
import { upsertAgentSignal } from "./agent-signals-state";
import type { SignalActionResult } from "./agent-signals-view";
import { getJuntoApi } from "./junto-api";

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
 * What the operator has written for a signal and not handed in, by part
 * (the writing; a proof's text and links), kept for as long as the window
 * runs: closing the feed, or moving to another signal, never loses it.
 * Attached files are not kept: they go with the tray.
 */
export type WorkDraftPart = "writing" | "proof-text" | "proof-links";
const drafts = new Map<string, string>();
const draftKey = (signalId: string, part: WorkDraftPart): string => `${signalId}\u0000${part}`;
export const workDraftOf = (signalId: string, part: WorkDraftPart = "writing"): string => drafts.get(draftKey(signalId, part)) ?? "";
export const keepWorkDraft = (signalId: string, text: string, part: WorkDraftPart = "writing"): void => {
  if (text === "") drafts.delete(draftKey(signalId, part));
  else drafts.set(draftKey(signalId, part), text);
};
/** Handed in or dismissed: nothing of it is kept. */
export const forgetWorkDrafts = (signalId: string): void => {
  for (const part of ["writing", "proof-text", "proof-links"] as const) drafts.delete(draftKey(signalId, part));
};

/**
 * What a feed item says of the operator's work: its kind when it is a
 * notice or work, its form, and work's timing. N1 stand-in: read off the
 * item by the names N1 gives them until FeedItem carries them.
 */
export type ItemWork = {
  readonly kind: "notice" | "work" | undefined;
  readonly form: SignalForm | undefined;
  readonly work: WorkTiming | undefined;
};

export const itemWorkOf = (item: { readonly kind: string }): ItemWork => {
  const carried = item as { readonly kind: string; readonly form?: SignalForm; readonly work?: WorkTiming };
  return {
    kind: carried.kind === "notice" || carried.kind === "work" ? carried.kind : undefined,
    form: carried.form,
    work: carried.work,
  };
};

/**
 * Hand in work through N1's one reply call. Until main has it the answer
 * is that it is not available, and nothing is lost: the writing stays.
 */
export const handInSignalWork = async (signalId: string, reply: WorkReply): Promise<SignalActionResult> => {
  const api = getJuntoApi() as
    | (ReturnType<typeof getJuntoApi> & {
        readonly agentSignalReply?: (signalId: string, reply: WorkReply) => Promise<AgentSignalOperatorResult>;
      })
    | undefined;
  if (!api) return { ok: false, message: "Junto is not connected." };
  if (api.agentSignalReply === undefined) return { ok: false, message: "Handing in work is not available yet." };
  return api.agentSignalReply(signalId, reply).then(
    (result) => {
      if (!result.ok) return result;
      upsertAgentSignal(result.signal);
      return { ok: true };
    },
    (error: unknown) => ({ ok: false, message: error instanceof Error ? error.message : "hand in failed" }),
  );
};
