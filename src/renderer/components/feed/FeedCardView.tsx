import { useEffect, useId, useRef, type ReactNode } from "react";
import {
  ArrowBigUpDash,
  Bell,
  CirclePause,
  MessageCircleQuestion,
  MessageSquareText,
  NotebookPen,
  OctagonAlert,
  ScanEye,
  type LucideIcon,
} from "lucide-react";
import { FEED_KIND_LABEL, type FeedItem, type FeedItemKind } from "@shared/operator-feed";
import { mailAgeLabel } from "../../lib/actor-ledger";
import type { SignalAnswer } from "../../lib/quick-reply-rules";
import { dueWords, itemWorkOf, workIsDue } from "../../lib/signal-work-words";
import { THREAD_HEALTH_STATUS_TONE } from "../../lib/thread-health-tone";
import { AgentPortrait } from "../AgentPortrait";
import { ResourceChip } from "../ui/ResourceChip";
import { QuickReplies } from "../signals/QuickReplies";
import { StatusDot } from "../ui/StatusDot";
import { feedTextPieces, type FeedTaskRef } from "./feed-text";
import "./operator-feed.css";

// A feed card as drawn, from props alone: no store, no IPC. The feed fills
// its portrait well live (FeedCard in OperatorFeed.tsx); the tour and the
// kit draw it from fixture items.

export const NO_NOTES: ReadonlyArray<string> = [];

/** How each need reads: a glyph on the portrait; its word is FEED_KIND_LABEL. */
const KIND_ICON: Readonly<Record<FeedItemKind, LucideIcon>> = {
  blocked: OctagonAlert,
  attention: MessageCircleQuestion,
  stopped: CirclePause,
  escalate: ArrowBigUpDash,
  feedback: MessageSquareText,
  health: ScanEye,
  work: NotebookPen,
  notice: Bell,
};

/** What an automation card's action says: the run it opens, never a seat. */
export const automationSourceOf = (item: FeedItem): Extract<FeedItem["source"], { readonly kind: "automation" }> | undefined =>
  item.source?.kind === "automation" ? item.source : undefined;

/**
 * An automation's signal has no seat to wake, so a quiet note says nothing a
 * reply does not: the automation hears both as answered. One row of answers,
 * and no Shift+digit keys behind it.
 */
export const quietNotesFor = (item: FeedItem, quietNotes: ReadonlyArray<string>): ReadonlyArray<string> =>
  automationSourceOf(item) === undefined ? quietNotes : NO_NOTES;

/**
 * A card's portrait well: `face` (the live seat ring, a node's mark) or,
 * without one, the seat's own portrait, and the need's glyph on it.
 */
export function FeedPortraitWell({ item, face }: { readonly item: FeedItem; readonly face?: ReactNode }) {
  const KindIcon = KIND_ICON[item.kind];
  return (
    <div className="operator-feed__portrait">
      {face ?? <AgentPortrait identity={item.seat.portraitIdentity} size={36} frame="round" outline={false} />}
      <span className="operator-feed__kind-mark" aria-hidden>
        <KindIcon size={11} strokeWidth={2.25} />
      </span>
    </div>
  );
}

/** Who, what, how long, and the sentence: the same words in the list and the pane. */
export function FeedWords({
  item,
  nowMs,
  labelId,
  taskByNumber,
  chipTabStop,
  onOpenTask,
}: {
  readonly item: FeedItem;
  readonly nowMs: number;
  readonly labelId?: string;
  /** The canvas's tasks by number: a `#42` the canvas holds is drawn as a chip that opens it. */
  readonly taskByNumber?: ReadonlyMap<number, FeedTaskRef>;
  /** The chip is a Tab stop only on the selected card, so a long list does not grow one stop per card. */
  readonly chipTabStop?: boolean;
  readonly onOpenTask?: (task: FeedTaskRef) => void;
}) {
  const age = mailAgeLabel(nowMs, item.since);
  const health = item.kind === "health" ? undefined : item.health;
  const { kind: workKind, work } = itemWorkOf(item);
  const due = workKind === "work" ? dueWords(work?.dueAt, nowMs) : undefined;
  const urgent = workKind === "work" && work !== undefined && workIsDue(work, nowMs);
  const pieces = feedTextPieces(item.text, taskByNumber);
  // Nothing named: the sentence is the sentence, not a span inside one.
  const plain = pieces.length === 1 && pieces[0]!.kind === "text" ? pieces[0]!.text : undefined;
  return (
    <>
      <header className="operator-feed__card-head">
        <span id={labelId && `${labelId}-name`} className="operator-feed__name">{item.seat.name}</span>
        <span id={labelId && `${labelId}-kind`} className="operator-feed__kind">{FEED_KIND_LABEL[item.kind]}</span>
        {due ? (
          <span className="operator-feed__due" data-urgent={urgent || undefined}>
            {due}
          </span>
        ) : null}
        {age ? (
          <time className="operator-feed__age" title={new Date(item.since!).toLocaleString()}>
            {age}
          </time>
        ) : null}
      </header>
      <p id={labelId && `${labelId}-text`} className="operator-feed__text">
        {plain ??
          pieces.map((piece, index) =>
            piece.kind === "text" ? (
              <span key={index}>{piece.text}</span>
            ) : (
              <ResourceChip
                key={index}
                kind="task"
                label={piece.task.title}
                number={piece.number}
                tabIndex={chipTabStop ? 0 : -1}
                {...(onOpenTask === undefined ? {} : { onOpen: () => onOpenTask(piece.task) })}
              />
            ),
          )}
      </p>
      {health ? (
        <p className="operator-feed__health" title="Jev's reading of the screen, not the agent's own claim">
          <StatusDot tone={THREAD_HEALTH_STATUS_TONE[health.tone]} />
          AI reads {health.label}
          {health.stale ? <span className="operator-feed__faint">, last observed</span> : null}
        </p>
      ) : null}
    </>
  );
}

/**
 * The selected signal's two pill rows: the waking quick replies (1..9) and,
 * apart below them, the quiet notes (Shift+1..9).
 */
export function FeedPills({
  item,
  quickReplies,
  quietNotes,
  numbered,
  sending,
  onAnswer,
}: {
  readonly item: FeedItem;
  readonly quickReplies: ReadonlyArray<string>;
  readonly quietNotes: ReadonlyArray<string>;
  readonly numbered: boolean;
  readonly sending: string | null;
  readonly onAnswer: (answer: SignalAnswer) => void;
}) {
  return (
    <div className="operator-feed__pills">
      <QuickReplies
        replies={quickReplies}
        suggested={item.suggestions}
        pending={sending}
        numbered={numbered}
        to={item.seat.name}
        wakes={automationSourceOf(item) === undefined}
        onPick={(text) => onAnswer({ kind: "reply", text })}
        className="operator-feed__quick"
      />
      <QuickReplies
        replies={quietNotes}
        pending={sending}
        numbered={numbered}
        quiet
        to={item.seat.name}
        onPick={(text) => onAnswer({ kind: "quiet", text })}
        className="operator-feed__quick"
      />
    </div>
  );
}

export type FeedCardViewProps = {
  readonly item: FeedItem;
  /** What sits in the portrait well; the seat's own portrait without it. */
  readonly face?: ReactNode;
  readonly nowMs: number;
  readonly quickReplies: ReadonlyArray<string>;
  readonly quietNotes?: ReadonlyArray<string>;
  readonly selected: boolean;
  /** Scroll into view as it is selected: only a j/k step asks for it. */
  readonly reveal: boolean;
  readonly leaving: boolean;
  /** The answer in flight for this card, if any (answerLabel). */
  readonly sending: string | null;
  /** Draw the selected row's pill rows in the row itself. */
  readonly pills?: boolean;
  /** The canvas's tasks by number: a `#42` the canvas holds is drawn as a chip that opens it. */
  readonly taskByNumber?: ReadonlyMap<number, FeedTaskRef>;
  /** See FeedWords: the selected row's chip is the list's one Tab stop. */
  readonly chipTabStop?: boolean;
  readonly onOpenTask?: (task: FeedTaskRef) => void;
  readonly onSelect: () => void;
  readonly onQuickReply: (text: string) => void;
  readonly onQuietNote?: (text: string) => void;
};

/**
 * One feed row in the list: portrait, who, what and the sentence, from props
 * alone. `FeedCard` (OperatorFeed.tsx) fills its portrait well live; the tour
 * and the kit draw it from fixture items, with the seat's own portrait. With `pills` (the tour), the selected row carries its pill rows; in
 * the feed they live in the detail pane, so no row repeats them.
 */
export function FeedCardView({
  item,
  face,
  nowMs,
  quickReplies,
  quietNotes = NO_NOTES,
  selected,
  reveal,
  leaving,
  sending,
  pills = true,
  taskByNumber,
  chipTabStop,
  onOpenTask,
  onSelect,
  onQuickReply,
  onQuietNote,
}: FeedCardViewProps) {
  const ref = useRef<HTMLElement>(null);
  const labelId = useId();
  useEffect(() => {
    if (selected && reveal) ref.current?.scrollIntoView({ block: "nearest" });
  }, [selected, reveal]);

  return (
    <div className={`operator-feed__slot${leaving ? " operator-feed__slot--leaving" : ""}`} role="listitem">
      <article
        ref={ref}
        className={`operator-feed__card${selected ? " is-selected" : ""}`}
        data-testid="operator-feed-card"
        data-item-id={item.itemId}
        data-kind={item.kind}
        aria-current={selected ? "true" : undefined}
        // Named by who, what and its own sentence, so two cards from one seat
        // are told apart on entry.
        aria-labelledby={`${labelId}-name ${labelId}-kind ${labelId}-text`}
        onClick={onSelect}
      >
        <FeedPortraitWell item={item} face={face} />
        <div className="operator-feed__body">
          <FeedWords
            item={item}
            nowMs={nowMs}
            labelId={labelId}
            {...(taskByNumber === undefined ? {} : { taskByNumber })}
            chipTabStop={chipTabStop ?? selected}
            {...(onOpenTask === undefined ? {} : { onOpenTask })}
          />
          {pills && selected && item.signalId ? (
            <FeedPills
              item={item}
              quickReplies={quickReplies}
              quietNotes={quietNotes}
              numbered
              sending={sending}
              onAnswer={(answer) => {
                if (answer.kind === "reply") onQuickReply(answer.text);
                else if (answer.kind === "quiet") onQuietNote?.(answer.text);
              }}
            />
          ) : null}
        </div>
      </article>
    </div>
  );
}

