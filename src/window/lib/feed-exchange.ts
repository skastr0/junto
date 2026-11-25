/**
 * The exchange behind a signal that follows another, as the pane tells it
 * (part 7): the thread's earlier signals and the operator's answers between
 * them, oldest first, ending at this signal. Pure: the thread's messages in,
 * rows out.
 */
import type { FeedItem } from "@shared/operator-feed";
import type { AgentSignalState } from "@shared/wire/agent-signals";
import type { ThreadHeadSignal } from "@shared/wire/mail-threads";
import type { SeatThreadMessage } from "./seat-threads";

/** Where an earlier signal stands, in the words the thread frame uses. */
export const EXCHANGE_STATE_WORD: Readonly<Record<AgentSignalState, string>> = {
  open: "Open",
  answered: "Answered",
  dismissed: "Dismissed",
  withdrawn: "Withdrawn",
};

export type ExchangeRow =
  | {
      readonly kind: "signal";
      readonly signalId: string;
      readonly signalKind: NonNullable<FeedItem["signalKind"]>;
      readonly state: AgentSignalState;
      readonly text: string;
      /** Epoch ms; absent on this signal's own row when its mail is not here. */
      readonly at?: number;
      /** The answer and the seat's withdrawal crossed. */
      readonly crossed: boolean;
      /** This signal: the last row. */
      readonly current: boolean;
    }
  | { readonly kind: "answer"; readonly text: string; readonly at: number };

/** The sentence for an answer and a withdrawal that crossed, in the pane's answer area and on an exchange row. */
export const crossedWords = (seat: string): string => `${seat} withdrew this before your answer reached it.`;

/** The same said alone, where the card is out of sight: it names the signal, its headline last after a colon. */
export const crossedLiveWords = (seat: string, headline: string): string =>
  `${seat} withdrew a signal before your answer reached it: ${headline}`;

/** More earlier rows than this fold: the last `EXCHANGE_TAIL` show, and the rest sit behind "Show all N". */
export const EXCHANGE_FOLD_AT = 4;
export const EXCHANGE_TAIL = 3;

const firstLine = (text: string): string => text.split("\n").find((line) => line.trim() !== "")?.trim() ?? "";

/**
 * The rows before `item` in its thread and `item` itself last. The head
 * signal (whose answer started the thread) comes first; each message that is
 * a signal is a row, each operator answer to a signal a "You" row. Nothing
 * after this signal is read.
 */
export const exchangeRows = (
  item: FeedItem,
  messages: ReadonlyArray<SeatThreadMessage>,
  head: ThreadHeadSignal | undefined,
): ReadonlyArray<ExchangeRow> => {
  const rows: ExchangeRow[] = [];
  const current = item.signalId;
  const push = (signal: { signalId: string; kind: NonNullable<FeedItem["signalKind"]>; state: AgentSignalState; text: string; crossed?: true }, at: number): boolean => {
    if (signal.signalId === current) return true;
    rows.push({
      kind: "signal",
      signalId: signal.signalId,
      signalKind: signal.kind,
      state: signal.state,
      text: signal.text,
      at,
      crossed: signal.crossed === true,
      current: false,
    });
    return false;
  };
  let reached = false;
  if (head !== undefined) reached = push(head, head.at);
  for (const message of messages) {
    if (reached) break;
    if (message.signal !== undefined) reached = push(message.signal, message.at);
    else if (message.mine && message.answers !== undefined) {
      const text = firstLine(message.text);
      if (text !== "") rows.push({ kind: "answer", text, at: message.at });
    }
  }
  if (item.signalId !== undefined && item.signalKind !== undefined) {
    rows.push({
      kind: "signal",
      signalId: item.signalId,
      signalKind: item.signalKind,
      state: "open",
      text: item.text,
      ...(item.since === undefined ? {} : { at: item.since }),
      crossed: false,
      current: true,
    });
  }
  return rows;
};

/** The rows to draw: all, or the last three of the earlier ones and this signal, with how many are behind "Show all". */
export const exchangeShown = (
  rows: ReadonlyArray<ExchangeRow>,
  all: boolean,
): { readonly rows: ReadonlyArray<ExchangeRow>; readonly hidden: number; readonly total: number } => {
  const earlier = rows.length - 1;
  if (all || earlier <= EXCHANGE_FOLD_AT) return { rows, hidden: 0, total: earlier };
  const keep = rows.slice(rows.length - 1 - EXCHANGE_TAIL);
  return { rows: keep, hidden: earlier - EXCHANGE_TAIL, total: earlier };
};
