/**
 * The operator feed: one scrolling surface of everything on the canvas that
 * wants the operator, grouped by region. A card is a seat and its need
 * (blocked, needs input, escalation, ready for review, or an AI reading that
 * it is waiting on you), or a need read off the canvas (a stoppage, a held
 * node, a sink that wants input). The list sits on the left; the selected
 * item fills the detail pane on the right, with its full details, its pill
 * rows, its keys and its composer. Anything that is not a signal opens the
 * node.
 *
 * The data is the shared projection (`@shared/operator-feed`), so this is one
 * rendering of a shape a mobile client can read as well.
 *
 * Four answers, each one key on the selected item: 1..9 a quick reply (mails
 * and wakes the seat), Shift+1..9 a quiet note (answered, the seat is not
 * woken), a acknowledges with no note (also quiet), d dismisses (closed, the
 * seat is not told). Also: j / k move, Enter writes a reply (or opens the
 * seat), o opens the seat, Esc closes the reply first and then the feed.
 *
 * An operator modal: OperatorModalHost owns the chord (⌘I) and mounts this
 * only while open, so selection and reply reset on every open. The shell
 * owns the frame, the header, focus and Escape.
 */
import { listIntentOf, stepList } from "../../lib/list-nav";
import {
  useEffect,
  useMemo,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type HTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { use$ } from "@legendapp/state/react";
import {
  ArrowBigUpDash,
  ArrowUpRight,
  Bell,
  CirclePause,
  Inbox,
  MessageCircleQuestion,
  MessageSquareText,
  MonitorSmartphone,
  NotebookPen,
  OctagonAlert,
  ScanEye,
  type LucideIcon,
} from "lucide-react";
import type { Node, Seat } from "@shared/model";
import {
  FEED_KIND_LABEL,
  needsOperatorCount,
  orderFeedSections,
  type FeedItem,
  type FeedItemKind,
  type FeedSortOrder,
} from "@shared/operator-feed";
import { activateNodeSurface } from "../../lib/activate-node-surface";
import { openWorkDetail } from "../../lib/work-detail-open";
import { mailAgeLabel } from "../../lib/actor-ledger";
import { dismissAgentSignal, respondToAgentSignal } from "../../lib/agent-signals-state";
import { SIGNALS_SECTION } from "../../lib/agent-signals-view";
import { isOperatorTyping } from "../../lib/focus-ownership";
import {
  feedItemsInOrder,
  feedRegionChips,
  feedStatusLine,
  feedView$,
  holdFeedPlaces,
  reconcileSelection,
  regionPickKey,
  regionPickName,
  useOperatorFeed,
  viewFeedSections,
  type ShownFeedSection,
} from "../../lib/operator-feed";
import { canReviewCommit, openCommitReview } from "../../lib/git-summary";
import { closeOperatorModal, operatorModalPlace } from "../../lib/operator-modal";
import { isThisMacItem, openRemoteLoginSettings } from "../../lib/phone-reach";
import {
  answerLabel,
  feedAnswerForKey,
  mergedQuickReplies,
  sendSignalAnswer,
  useQuickReplies,
  useQuietNotes,
  type SignalAnswer,
} from "../../lib/quick-replies";
import { requestSectionReveal } from "../../lib/sidebar-sections";
import { dueWords, handInSignalWork, itemWorkOf, paneAnswerOf, putSignalSecret, workIsDue, type PaneAnswer } from "../../lib/signal-work";
import { VAULT_ENABLED } from "@shared/features";
import { state$ } from "../../lib/state";
import { useCanvas } from "../../lib/use-model";
import { accentColor } from "../../lib/theme";
import { THREAD_HEALTH_STATUS_TONE } from "../../lib/thread-health";
import { AgentPortrait } from "../AgentPortrait";
import { KindMark } from "../NodeKindMark";
import { SeatRingView, useSeatGlanceOf } from "../SeatRing";
import { QuickReplies } from "../signals/QuickReplies";
import { SignalReply } from "../signals/SignalReply";
import { SignalResourceChips } from "../signals/SignalResourceChips";
import { SignalWorkForm } from "../signals/SignalWorkForm";
import { OperatorModalShell } from "../operator-modal/OperatorModalShell";
import { PreviewedMarkdown } from "../preview/PreviewedMarkdown";
import { Button, Dropdown, Kbd, StatusDot } from "../ui";
import { FeedRegionStrip } from "./FeedRegionStrip";
import "./operator-feed.css";

const LEAVE_MS = 280;
const NO_IDS: ReadonlySet<string> = new Set();
const NO_NOTES: ReadonlyArray<string> = [];

const closeOperatorFeed = (): void => closeOperatorModal("feed");

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

/** The region's own colour, or a quiet steel for the open field. */
const regionStyle = (color: string | undefined): CSSProperties =>
  ({ "--feed-region": color ? accentColor(color) : "var(--color-steel)" }) as CSSProperties;

/** A seat's ring, live: its own component so only a seat's card follows a seat. */
function LiveSeatRing({ seat }: { readonly seat: Seat }) {
  return <SeatRingView node={seat} px={46} glance={useSeatGlanceOf(seat)} />;
}

export const openSeat = (item: FeedItem, node: Node | undefined): void => {
  // Fixed in System Settings; the feed stays open where it was.
  if (isThisMacItem(item)) {
    openRemoteLoginSettings();
    return;
  }
  if (!node) return;
  closeOperatorFeed();
  // An automation's signal opens the run that raised it: the Automations node
  // with that firing marked in its history (0.11.1). A signal from before a
  // firing was named opens the automation without one.
  const source = item.source;
  if (source?.kind === "automation") {
    activateNodeSurface(node.id);
    openWorkDetail(node.id, {
      automationId: source.automationId,
      ...(source.firingId === undefined ? {} : { firingId: source.firingId }),
    });
    return;
  }
  if (item.signalId) requestSectionReveal(node.id, SIGNALS_SECTION);
  activateNodeSurface(node.id);
};

/** What an automation card's action says: the run it opens, never a seat. */
const automationSourceOf = (item: FeedItem): Extract<FeedItem["source"], { readonly kind: "automation" }> | undefined =>
  item.source?.kind === "automation" ? item.source : undefined;

function FeedPortrait({ item, node }: { readonly item: FeedItem; readonly node: Node | undefined }) {
  const KindIcon = KIND_ICON[item.kind];
  return (
    <div className="operator-feed__portrait">
      {isThisMacItem(item) ? (
        <span className="operator-feed__node-mark">
          <MonitorSmartphone size={18} aria-hidden />
        </span>
      ) : node?.kind === "agent" ? (
        <LiveSeatRing seat={node} />
      ) : node ? (
        <KindMark node={node} className="operator-feed__node-mark" iconSize={18} />
      ) : (
        <AgentPortrait identity={item.seat.portraitIdentity} size={36} frame="round" outline={false} />
      )}
      <span className="operator-feed__kind-mark" aria-hidden>
        <KindIcon size={11} strokeWidth={2.25} />
      </span>
    </div>
  );
}

/** Who, what, how long, and the sentence: the same words in the list and the pane. */
function FeedWords({
  item,
  nowMs,
  labelId,
}: {
  readonly item: FeedItem;
  readonly nowMs: number;
  readonly labelId?: string;
}) {
  const age = mailAgeLabel(nowMs, item.since);
  const health = item.kind === "health" ? undefined : item.health;
  const { kind: workKind, work } = itemWorkOf(item);
  const due = workKind === "work" ? dueWords(work?.dueAt, nowMs) : undefined;
  const urgent = workKind === "work" && work !== undefined && workIsDue(work, nowMs);
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
      <p id={labelId && `${labelId}-text`} className="operator-feed__text">{item.text}</p>
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
function FeedPills({
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

/**
 * One feed row in the list: portrait, who, what and the sentence. Exported
 * so other surfaces (the onboarding tour) can show a real row from fixture
 * items: with `node` undefined it draws the seat's portrait without the live
 * ring. With `pills` (the tour), the selected row carries its pill rows; in
 * the feed they live in the detail pane, so no row repeats them.
 */
export function FeedCard({
  item,
  node,
  nowMs,
  quickReplies,
  quietNotes = NO_NOTES,
  selected,
  reveal,
  leaving,
  sending,
  pills = true,
  onSelect,
  onQuickReply,
  onQuietNote,
}: {
  readonly item: FeedItem;
  readonly node: Node | undefined;
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
  readonly onSelect: () => void;
  readonly onQuickReply: (text: string) => void;
  readonly onQuietNote?: (text: string) => void;
}) {
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
        <FeedPortrait item={item} node={node} />
        <div className="operator-feed__body">
          <FeedWords item={item} nowMs={nowMs} labelId={labelId} />
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

/** The selected item's keys, at the foot of its pane. */
function FeedKeys({
  item,
  quickCount,
  quietCount,
  answer,
}: {
  readonly item: FeedItem;
  readonly quickCount: number;
  readonly quietCount: number;
  /** How the pane answers: only a reply or a notice takes a and d, only a reply Enter. */
  readonly answer: PaneAnswer;
}) {
  const keyed = item.signalId !== undefined && (answer === "reply" || answer === "clear");
  const range = (count: number, shift: boolean): ReactNode => (
    <>
      <Kbd>{shift ? "⇧1" : "1"}</Kbd>
      {count > 1 ? <>–<Kbd>{`${shift ? "⇧" : ""}${Math.min(9, count)}`}</Kbd></> : null}
    </>
  );
  return (
    <footer className="operator-feed__keys" data-testid="operator-feed-keys" aria-hidden>
      <span><Kbd>j</Kbd><Kbd>k</Kbd> move</span>
      {item.signalId && quickCount > 0 ? <span>{range(quickCount, false)} quick reply</span> : null}
      {item.signalId && quietCount > 0 ? <span>{range(quietCount, true)} quiet note</span> : null}
      {keyed ? <span><Kbd>a</Kbd> {answer === "clear" ? "clear" : "acknowledge"}</span> : null}
      {keyed ? <span><Kbd>d</Kbd> dismiss</span> : null}
      {item.signalId && answer === "reply" ? <span><Kbd>↵</Kbd> write reply</span> : null}
      <span><Kbd>o</Kbd> open seat</span>
      <span><Kbd>esc</Kbd> close</span>
    </footer>
  );
}

/**
 * The selected item, whole: its words, its full details and files without
 * an expander, then its answers (both pill rows, Write reply, Open seat) or,
 * after Enter, the composer. Remounted per item, so its scroll and its
 * composer start fresh as j and k move.
 */
function FeedDetail({
  item,
  node,
  nowMs,
  quickReplies,
  quietNotes,
  replying,
  sending,
  error,
  onAnswer,
  onReply,
  onReviewCommit,
}: {
  readonly item: FeedItem;
  readonly node: Node | undefined;
  readonly nowMs: number;
  readonly quickReplies: ReadonlyArray<string>;
  readonly quietNotes: ReadonlyArray<string>;
  readonly replying: boolean;
  readonly sending: string | null;
  readonly error: string | null;
  readonly onAnswer: (answer: SignalAnswer) => void;
  readonly onReply: (open: boolean) => void;
  readonly onReviewCommit: (sha: string) => void;
}) {
  const isSeat = node === undefined || node.kind === "agent";
  const thisMac = isThisMacItem(item);
  const work = itemWorkOf(item);
  const { form } = work;
  // A notice is read and cleared, whatever it carries; otherwise a form is the whole answer.
  const answer = paneAnswerOf(work);
  const hasDetails = item.signalId !== undefined && (Boolean(item.detail) || (item.attachments?.length ?? 0) > 0);
  return (
    <section
      className="operator-feed__detail-pane"
      data-testid="operator-feed-detail"
      data-item-id={item.itemId}
      data-kind={item.kind}
      aria-label={`${item.seat.name}, ${FEED_KIND_LABEL[item.kind]}`}
    >
      <div className="operator-feed__detail-scroll">
        <div className="operator-feed__detail-head">
          <FeedPortrait item={item} node={node} />
          <div className="operator-feed__body">
            <FeedWords item={item} nowMs={nowMs} />
          </div>
        </div>
        {/* Only a signal carries details, so the signal is always there to read from. */}
        {hasDetails && item.signalId ? (
          <PreviewedMarkdown
            markdown={item.detail}
            attachments={item.attachments}
            source={{ kind: "signal", signalId: item.signalId }}
            seat={{ canvasName: item.canvasName, nodeId: item.seat.nodeId }}
            // Only a sender on the open canvas with a folder can be reviewed.
            onReviewCommit={canReviewCommit(item.canvasName, item.seat.nodeId) ? onReviewCommit : undefined}
            textClassName="operator-feed__detail"
          />
        ) : null}
        <SignalResourceChips canvasName={item.canvasName} attachments={item.attachments} beforeOpen={closeOperatorFeed} />
      </div>
      <div className="operator-feed__answer">
        {item.signalId &&
        (form?.kind === "artifact" || form?.kind === "proof" || (form?.kind === "secret" && VAULT_ENABLED)) &&
        answer === form.kind ? (
          <SignalWorkForm
            key={item.signalId}
            signalId={item.signalId}
            canvasName={item.canvasName}
            text={item.text}
            form={form}
            asker={item.seat.name}
            handIn={handInSignalWork}
            putSecret={putSignalSecret}
            dismiss={dismissAgentSignal}
            onDone={() => onReply(false)}
          />
        ) : item.signalId && answer === "secret" ? (
          // Never answered in text: a secret goes only into the vault, which this build has off.
          <p className="operator-feed__secret-wait" role="note">
            This asks for a secret. Secrets are set through the vault, which is not set up yet, so it cannot be answered here.
          </p>
        ) : answer === "clear" && item.signalId ? (
          // A notice is read and cleared: no reply to write.
          <div className="operator-feed__actions">
            {/* aria-disabled, not disabled: focus stays on Clear while it is sent. */}
            <Button
              size="xs"
              variant="primary"
              aria-disabled={sending !== null || undefined}
              onClick={() => {
                if (sending === null) onAnswer({ kind: "acknowledge" });
              }}
            >
              Clear
            </Button>
          </div>
        ) : replying && item.signalId ? (
          <SignalReply
            signalId={item.signalId}
            canvasName={item.canvasName}
            seatNodeId={item.seat.nodeId}
            suggested={item.suggestions}
            respond={respondToAgentSignal}
            dismiss={dismissAgentSignal}
            onDone={() => onReply(false)}
            className="operator-feed__reply"
          />
        ) : (
          <>
            {item.signalId ? (
              <FeedPills
                item={item}
                quickReplies={quickReplies}
                quietNotes={quietNotes}
                numbered
                sending={sending}
                onAnswer={onAnswer}
              />
            ) : null}
            <div className="operator-feed__actions">
              {item.signalId ? (
                <Button size="xs" variant="subtle" aria-label={`Write reply to ${item.seat.name}`} onClick={() => onReply(true)}>
                  Write reply
                </Button>
              ) : null}
              {thisMac ? (
                <Button size="xs" variant="subtle" onClick={openRemoteLoginSettings}>
                  Open Remote Login settings
                  <ArrowUpRight size={11} aria-hidden />
                </Button>
              ) : (
                <Button
                  size="xs"
                  variant="subtle"
                  disabled={!node}
                  aria-label={
                    isSeat
                      ? `Open seat ${item.seat.name}`
                      : automationSourceOf(item) === undefined
                        ? `Open ${item.seat.name}`
                        : `Open the run in ${item.seat.name}`
                  }
                  onClick={() => openSeat(item, node)}
                >
                  {isSeat ? "Open seat" : automationSourceOf(item) === undefined ? "Open" : "Open run"}
                  <ArrowUpRight size={11} aria-hidden />
                </Button>
              )}
            </div>
          </>
        )}
        {error && !replying ? (
          <p className="operator-feed__error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
      <FeedKeys
        item={item}
        quickCount={answer === "reply" ? mergedQuickReplies(quickReplies, item.suggestions).length : 0}
        quietCount={answer === "reply" ? quietNotes.length : 0}
        answer={answer}
      />
    </section>
  );
}

function FeedRegionSection({
  section,
  children,
}: {
  readonly section: ShownFeedSection;
  readonly children: ReactNode;
}) {
  const live = needsOperatorCount(section.items.filter((item) => !section.leavingIds.has(item.itemId)));
  const outer = section.region.path.slice(0, -1);
  return (
    <section
      className="operator-feed__region"
      style={regionStyle(section.region.color)}
      data-open-field={section.region.regionId === null ? "true" : undefined}
      aria-label={`${section.region.label}, ${live} waiting`}
    >
      <header className="operator-feed__region-head">
        <span className="operator-feed__region-swatch" aria-hidden />
        <span className="operator-feed__region-label">{section.region.label}</span>
        {outer.length > 0 ? <span className="operator-feed__region-path">in {outer.join(" / ")}</span> : null}
        <span className="operator-feed__region-rule" aria-hidden />
        {live > 0 ? <span className="operator-feed__region-count">{live}</span> : null}
      </header>
      <div className="operator-feed__list" role="list">
        {children}
      </div>
    </section>
  );
}


const FEED_ORDER_OPTIONS: ReadonlyArray<{ readonly value: FeedSortOrder; readonly label: string }> = [
  { value: "urgency", label: "Most urgent first" },
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
];

export function OperatorFeed() {
  const feed = useOperatorFeed();
  const quickReplies = useQuickReplies();
  const quietNotes = useQuietNotes();
  const canvasName = use$(state$.canvasName);
  const nodesById: ReadonlyMap<string, Node> = useCanvas(canvasName).nodes;
  const regionPick = use$(feedView$.region);
  const feedOrder = use$(feedView$.order);
  const activeRegion = regionPick?.canvasName === canvasName ? regionPick : undefined;
  // Coming back from a review opened on a card: the same card, the same
  // open details, the same scroll. Read as the feed mounts.
  const [place] = useState(() => operatorModalPlace("feed"));
  const scrollRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (place && scrollRef.current) scrollRef.current.scrollTop = place.scrollTop;
  }, [place]);
  const [selected, setSelected] = useState<string | null>(place?.itemId ?? null);
  // The list moves only when the operator moves it. A j/k step may bring the
  // card it selects into view, once; nothing else scrolls a card in: not a
  // press (it would move the row out from under the click), not an answer
  // handing the selection on, not a card leaving or arriving.
  const [revealId, setRevealId] = useState<string | null>(null);
  useEffect(() => {
    if (revealId !== null) setRevealId(null);
  }, [revealId]);
  const [replyFor, setReplyFor] = useState<string | null>(null);
  // Answers in flight, by item (answerLabel): one per card, cards independent.
  const [sending, setSending] = useState<ReadonlyMap<string, string>>(() => new Map());
  const sendingRef = useRef(sending);
  sendingRef.current = sending;
  const [failure, setFailure] = useState<{ readonly itemId: string; readonly message: string } | null>(null);
  const [scrolled, setScrolled] = useState(false);

  // The view the operator picked: one region, or all of them, in the picked
  // order. Kept in feedView$ so it survives the modal's open and close.
  const viewSections = useMemo(
    () => viewFeedSections(feed.sections, regionPick, canvasName, feedOrder),
    [feed.sections, regionPick, canvasName, feedOrder],
  );

  // What the feed draws. The operator's own picks (canvas, region, order)
  // rank it afresh; any other change keeps every card where the operator
  // sees it: a new card goes where the ranking puts it, and an answered or
  // dismissed one fades out in its place, its region with it, before it
  // leaves. Worked out while rendering, against what was last drawn, so no
  // commit ever draws the list without a card that is still fading: one that
  // did remounted the card, a reply box open on it took focus again, and the
  // list scrolled to it.
  const pick = `${canvasName}\n${activeRegion ? `region:${regionPickKey(activeRegion.path)}` : "all"}\n${feedOrder}`;
  const drawn = useRef<{ readonly pick: string; readonly sections: ReadonlyArray<ShownFeedSection> }>({ pick, sections: [] });
  // Cards whose fade is over: the next draw leaves them out.
  const [faded, setFaded] = useState<ReadonlySet<string>>(NO_IDS);
  const sections = useMemo(() => {
    const held = drawn.current.pick === pick ? drawn.current.sections : [];
    const live = new Set(feedItemsInOrder(viewSections).map((item) => item.itemId));
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
    const leaving = new Set(
      reduced
        ? []
        : feedItemsInOrder(held)
            .map((item) => item.itemId)
            .filter((itemId) => !live.has(itemId) && !faded.has(itemId)),
    );
    return holdFeedPlaces(held, viewSections, leaving);
  }, [viewSections, pick, faded]);
  useLayoutEffect(() => {
    drawn.current = { pick, sections };
  }, [pick, sections]);
  // One timer per fading card, kept through every change until it fires: the
  // feed re-renders often, and a card whose timer was dropped would never leave.
  const leaveTimers = useRef(new Map<string, number>());
  useEffect(() => {
    const timers = leaveTimers.current;
    const leaving = new Set(sections.flatMap((section) => [...section.leavingIds]));
    for (const [itemId, timer] of timers) {
      if (leaving.has(itemId)) continue;
      window.clearTimeout(timer);
      timers.delete(itemId);
    }
    for (const itemId of leaving) {
      if (timers.has(itemId)) continue;
      const timer = window.setTimeout(() => {
        timers.delete(itemId);
        setFaded((current) => new Set(current).add(itemId));
      }, LEAVE_MS);
      timers.set(itemId, timer);
    }
    // Forget a faded card once it is off the list, so a card with the same id
    // that comes back (a seat asking again) fades out again when it leaves.
    const drawnIds = new Set(feedItemsInOrder(sections).map((item) => item.itemId));
    if ([...faded].some((itemId) => !drawnIds.has(itemId))) {
      setFaded((current) => new Set([...current].filter((itemId) => drawnIds.has(itemId))));
    }
  }, [sections, faded]);
  useEffect(() => {
    const timers = leaveTimers.current;
    return () => {
      for (const timer of timers.values()) window.clearTimeout(timer);
      timers.clear();
    };
  }, []);

  // The cards still waiting, in the order they are drawn.
  const items = useMemo(
    () => sections.flatMap((section) => section.items.filter((item) => !section.leavingIds.has(item.itemId))),
    [sections],
  );
  const itemsRef = useRef(items);
  // When the selected item leaves, for whatever reason, its neighbour takes over.
  useEffect(() => {
    const before = itemsRef.current;
    itemsRef.current = items;
    if (before !== items) setSelected((current) => reconcileSelection(before, items, current));
  }, [items]);
  // The detail pane always shows something: with nothing picked, the first.
  // Queued after the hand-on above, so it keeps the neighbour that took over.
  useEffect(() => {
    setSelected((current) =>
      current !== null && items.some((item) => item.itemId === current) ? current : (items[0]?.itemId ?? null),
    );
  }, [items, selected]);
  const selectedItem = items.find((item) => item.itemId === selected);

  const answer = async (item: FeedItem, chosen: SignalAnswer): Promise<void> => {
    if (!item.signalId || sendingRef.current.has(item.itemId)) return;
    setSending((current) => new Map(current).set(item.itemId, answerLabel(chosen)));
    setFailure(null);
    try {
      const result = await sendSignalAnswer(item.signalId, chosen, {
        respond: respondToAgentSignal,
        dismiss: dismissAgentSignal,
      });
      if (!result.ok) setFailure({ itemId: item.itemId, message: result.message });
    } finally {
      setSending((current) => {
        const next = new Map(current);
        next.delete(item.itemId);
        return next;
      });
    }
  };
  // Heard wherever focus sits inside the modal; the shell takes Escape.
  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>): void => {
    if (event.key === "Escape") return;
    if (event.defaultPrevented) return;
    if (isOperatorTyping(event.target) || event.metaKey || event.ctrlKey || event.altKey) return;
    // The open composer owns its keys: an answer key on its buttons (Attach,
    // a chip's Remove) would answer without the files it holds.
    if (event.target instanceof Element && event.target.closest('[data-testid="signal-reply"]')) return;
    // A task or artifact chip is a button: Enter opens it, and no answer key acts from it.
    if (event.target instanceof Element && event.target.closest('[data-testid="signal-resource-chips"]')) return;
    // The order menu reads letters as type-ahead: keys that land inside a
    // listbox are the menu's, never j/k movement.
    if (event.target instanceof Element && event.target.closest('[role="listbox"]')) return;
    // A region chip is a button: Enter picks it, and no answer key acts from it.
    if (event.target instanceof Element && event.target.closest('[data-testid="feed-region-strip"]')) return;
    // The moves every list shares (lib/list-nav). Enter is the feed's own: it replies.
    const intent = listIntentOf(event.nativeEvent);
    if (intent !== null && intent !== "open") {
      event.preventDefault();
      const next = stepList(
        items.map((item) => item.itemId),
        selected,
        intent,
      );
      setSelected(next);
      setRevealId(next);
      return;
    }
    const item = items.find((candidate) => candidate.itemId === selected);
    if (!item) return;
    // A held key answers once: its repeats would land on the neighbour that
    // takes the selection, closing a signal the operator never saw.
    if (event.repeat) return;
    const keyed = item.signalId
      ? feedAnswerForKey(event, mergedQuickReplies(quickReplies, item.suggestions), quietNotes)
      : null;
    // Keys answer in text only where a reply is the answer: a notice takes a and d,
    // and work in a form or a secret takes none (its Dismiss asks first).
    const pane = paneAnswerOf(itemWorkOf(item));
    const chosen =
      keyed === null || pane === "reply"
        ? keyed
        : pane === "clear" && (keyed.kind === "acknowledge" || keyed.kind === "dismiss")
          ? keyed
          : null;
    if (chosen !== null) {
      event.preventDefault();
      void answer(item, chosen);
    } else if (event.key === "o" || (event.key === "Enter" && (item.signalId === undefined || pane === "reply"))) {
      // Enter writes a reply only where a reply is the answer; a form is answered in its own fields.
      event.preventDefault();
      if (event.key === "Enter" && item.signalId) setReplyFor(item.itemId);
      else openSeat(item, nodesById.get(item.seat.nodeId));
    }
  };
  // Escape closes an open reply first; only then does the shell close the feed.
  const onEscape = (): boolean => {
    if (replyFor === null) return false;
    setReplyFor(null);
    return true;
  };
  // The region chips, in the order the feed's sections run, each parent just
  // before its first child; a pick that emptied out stays so it can be seen
  // and cleared.
  const regionChips = useMemo(
    () => feedRegionChips(orderFeedSections(feed.sections, feedOrder), activeRegion?.path),
    [feed.sections, feedOrder, activeRegion],
  );
  const chosenRegion = activeRegion ? regionPickKey(activeRegion.path) : undefined;
  const regionName = activeRegion ? regionPickName(activeRegion.path) : "";
  const status = activeRegion
    ? feedStatusLine(feed, { label: regionName, count: needsOperatorCount(items) })
    : feedStatusLine(feed);

  return (
    <OperatorModalShell
      id="feed"
      label="Needs you feed"
      title={<span className="operator-feed__title">Needs you</span>}
      status={<span className="operator-feed__status">{status}</span>}
      headerProps={
        { className: "operator-feed__head", "data-scrolled": scrolled ? "true" : undefined } as HTMLAttributes<HTMLElement>
      }
      width={1180}
      fill
      panelClassName="operator-feed__panel"
      onEscape={onEscape}
      onKeyDown={onKeyDown}
    >
      {feed.count > 0 || activeRegion !== undefined ? (
        <div className="operator-feed__controls">
          <FeedRegionStrip
            chips={regionChips}
            chosen={chosenRegion}
            total={feed.count}
            onPick={(chip) => feedView$.region.set(chip ? { canvasName, path: chip.path } : undefined)}
          />
          <span className="operator-feed__control-label" aria-hidden>
            Order
          </span>
          <Dropdown
            aria-label="Order needs"
            value={feedOrder}
            options={FEED_ORDER_OPTIONS}
            onChange={(value) => feedView$.order.set(value as FeedSortOrder)}
            triggerClassName="operator-feed__control"
          />
        </div>
      ) : null}
      {sections.length === 0 ? (
        <div className="operator-feed__scroll" data-testid="operator-feed">
          {activeRegion !== undefined ? (
            <div className="operator-feed__empty" role="status">
              <span className="operator-feed__empty-mark" aria-hidden>
                <Inbox size={22} strokeWidth={1.4} />
              </span>
              <p className="operator-feed__empty-title">Nothing waiting in {regionName}</p>
              <p className="operator-feed__empty-copy">
                This corner is clear. The rest of the feed is still waiting where it was.
              </p>
              <Button size="sm" variant="subtle" onClick={() => feedView$.region.set(undefined)}>
                Show all regions
              </Button>
            </div>
          ) : (
            <div className="operator-feed__empty" role="status">
              <span className="operator-feed__empty-mark" aria-hidden>
                <Inbox size={22} strokeWidth={1.4} />
              </span>
              <p className="operator-feed__empty-title">Your work for today is done</p>
              <p className="operator-feed__empty-copy">
                Nothing is waiting on you. Work an automation raises, notices, and agents that need you land here.
              </p>
            </div>
          )}
        </div>
      ) : (
        <div className="operator-feed__split">
          <div
            ref={scrollRef}
            className="operator-feed__scroll"
            data-testid="operator-feed"
            onScroll={(event) => setScrolled(event.currentTarget.scrollTop > 2)}
          >
            {sections.map((section) => (
              <FeedRegionSection key={section.region.regionId ?? "open-field"} section={section}>
                {section.items.map((item) => (
                  <FeedCard
                    key={item.itemId}
                    item={item}
                    node={nodesById.get(item.seat.nodeId)}
                    nowMs={feed.generatedAt}
                    quickReplies={quickReplies}
                    selected={selected === item.itemId}
                    reveal={revealId === item.itemId}
                    leaving={section.leavingIds.has(item.itemId)}
                    sending={sending.get(item.itemId) ?? null}
                    pills={false}
                    onSelect={() => setSelected(item.itemId)}
                    onQuickReply={(text) => void answer(item, { kind: "reply", text })}
                  />
                ))}
              </FeedRegionSection>
            ))}
          </div>
          {selectedItem ? (
            <FeedDetail
              key={selectedItem.itemId}
              item={selectedItem}
              node={nodesById.get(selectedItem.seat.nodeId)}
              nowMs={feed.generatedAt}
              quickReplies={quickReplies}
              quietNotes={quietNotes}
              replying={replyFor === selectedItem.itemId}
              sending={sending.get(selectedItem.itemId) ?? null}
              error={failure?.itemId === selectedItem.itemId ? failure.message : null}
              onAnswer={(chosen) => void answer(selectedItem, chosen)}
              onReply={(open) => setReplyFor(open ? selectedItem.itemId : null)}
              onReviewCommit={(sha) =>
                openCommitReview({
                  nodeId: selectedItem.seat.nodeId,
                  sha,
                  place: { itemId: selectedItem.itemId, expanded: [], scrollTop: scrollRef.current?.scrollTop ?? 0 },
                })
              }
            />
          ) : (
            <div className="operator-feed__detail-pane operator-feed__detail-pane--empty" aria-hidden />
          )}
        </div>
      )}
    </OperatorModalShell>
  );
}
