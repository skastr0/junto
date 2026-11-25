import { Check, Undo2, X } from "lucide-react";
import { useMemo, useState } from "react";
import { FEED_KIND_LABEL, type FeedItem } from "@shared/operator-feed";
import { mailAgeLabel } from "@shared/actor-ledger";
import type { AgentSignalState } from "@shared/wire/agent-signals";
import { crossedWords } from "@shared/signal-crossing";
import { EXCHANGE_STATE_WORD, exchangeRows, exchangeShown, type ExchangeRow } from "../../lib/feed-exchange";
import { loadOlderMessages, useSeatThreadMessages } from "../../lib/seat-threads";
import { Button } from "../ui/Button";
import { KIND_ICON } from "./FeedCardView";

// A signal that follows another tells its exchange in the pane (part 7), under
// the head and any Depends on band: the thread's earlier signals and the
// operator's answers between them, oldest first, ending at this signal, drawn
// selected. The kind words are the feed's own. Read only for a signal in a
// thread with an earlier one, and only while it is the selected card.

const STATE_ICON: Readonly<Partial<Record<AgentSignalState, typeof Check>>> = {
  answered: Check,
  dismissed: X,
  withdrawn: Undo2,
};

const word = (text: string): string => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

function SignalRow({ row, nowMs, seat }: { readonly row: Extract<ExchangeRow, { kind: "signal" }>; readonly nowMs: number; readonly seat: string }) {
  const KindIcon = KIND_ICON[row.signalKind];
  const StateIcon = STATE_ICON[row.state];
  const kindWord = word(FEED_KIND_LABEL[row.signalKind]);
  return (
    <li
      className="operator-feed__exchange-row"
      data-testid="feed-exchange-signal"
      data-signal-id={row.signalId}
      data-current={row.current ? "true" : undefined}
      data-state={row.state}
      data-kind={row.signalKind}
      aria-current={row.current ? "true" : undefined}
    >
      <KindIcon size={12} strokeWidth={2} aria-hidden className="operator-feed__band-glyph" />
      <span className="operator-feed__band-kind">{kindWord}</span>
      {row.current ? null : (
        <span className="operator-feed__exchange-state">
          {StateIcon ? <StateIcon size={11} strokeWidth={2} aria-hidden /> : null}
          {EXCHANGE_STATE_WORD[row.state]}
        </span>
      )}
      <span className="operator-feed__band-text">{row.text}</span>
      {row.at === undefined ? null : <time className="operator-feed__exchange-time">{mailAgeLabel(nowMs, row.at)}</time>}
      {row.state === "withdrawn" && row.crossed ? (
        <span className="operator-feed__exchange-note">{crossedWords(seat)}</span>
      ) : null}
    </li>
  );
}

export function FeedExchange({
  item,
  nowMs,
  onOpenThread,
}: {
  readonly item: FeedItem;
  readonly nowMs: number;
  readonly onOpenThread: (threadId: string) => void;
}) {
  const seat = { canvasName: item.canvasName, seatId: item.seat.nodeId };
  const { messages, headSignal, older } = useSeatThreadMessages(seat, item.threadId);
  const rows = useMemo(() => exchangeRows(item, messages, headSignal), [item, messages, headSignal]);
  const [all, setAll] = useState(false);
  const shown = exchangeShown(rows, all);
  // Nothing before this signal is known yet: the pane says nothing rather than a one-row exchange.
  if (rows.length < 2 || item.threadId === undefined) return null;
  const threadId = item.threadId;
  return (
    <div className="operator-feed__exchange" data-testid="feed-exchange">
      <p className="operator-feed__band-head" id={`${item.itemId}-exchange`}>
        This thread
      </p>
      {shown.hidden > 0 ? (
        <Button
          size="sm"
          variant="subtle"
          data-testid="feed-exchange-all"
          onClick={() => {
            setAll(true);
            if (older !== undefined) void loadOlderMessages(seat, threadId);
          }}
        >
          {`Show all ${String(shown.total)}`}
        </Button>
      ) : null}
      <ul className="operator-feed__exchange-rows" aria-labelledby={`${item.itemId}-exchange`}>
        {shown.rows.map((row, at) =>
          row.kind === "signal" ? (
            <SignalRow key={`s-${row.signalId}`} row={row} nowMs={nowMs} seat={item.seat.name} />
          ) : (
            <li key={`a-${String(at)}-${String(row.at)}`} className="operator-feed__exchange-you" data-testid="feed-exchange-answer">
              <span>You:</span> {row.text}
            </li>
          ),
        )}
      </ul>
      <Button size="sm" variant="subtle" data-testid="feed-exchange-open" onClick={() => onOpenThread(threadId)}>
        Open thread
      </Button>
    </div>
  );
}
