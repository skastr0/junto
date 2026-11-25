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
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type HTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { use$ } from "@legendapp/state/react";
import { ArrowUpRight, Check, MonitorSmartphone } from "lucide-react";
import {
  feedChainPlaces,
  feedDependsLineOf,
  feedItemWaits,
  foldFeedChains,
  feedCardSpeech,
  foldName,
  foldedItemIds,
  waitsOnTarget,
  type FeedChainPlace,
  type FeedRow,
} from "../../lib/feed-order";
import { keyAria, keyCaps, keyIs } from "../../lib/key-match";
import { titleOf, type Node, type Seat } from "@shared/model";
import {
  FEED_KIND_LABEL,
  feedKindChips,
  feedSeatChips,
  needsOperatorCount,
  orderFeedSections,
  type FeedItem,
  type FeedSeatChip,
  type FeedSortOrder,
} from "@shared/operator-feed";
import { activateNodeSurface } from "../../lib/activate-node-surface";
import { openWorkDetail } from "../../lib/work-detail-open";
import { SIGNALS_SECTION, useSignalActions } from "../../lib/agent-signals-view";
import { agentSignals$ } from "../../lib/agent-signals-state";
import { claimFocus, isOperatorTyping } from "../../lib/focus-ownership";
import {
  clearFeedFilters,
  feedAsked$,
  feedFilterOf,
  feedItemsInOrder,
  feedRegionChips,
  feedStatusLine,
  feedView$,
  holdFeedPlaces,
  reconcileSelection,
  regionPickKey,
  regionPickName,
  regionMatches,
  toggleFeedKind,
  toggleFeedSeat,
  useOperatorFeed,
  viewFeedSections,
  type ShownFeedSection,
} from "../../lib/operator-feed";
import { feedFilterOn } from "@shared/operator-feed";
import { canReviewCommit, openCommitReview } from "../../lib/git-summary";
import { closeOperatorModal, openOperatorModalFrom, operatorModalPlace } from "../../lib/operator-modal";
import { askThread } from "../../lib/threads-view";
import { isThisMacItem, openRemoteLoginSettings } from "../../lib/phone-reach";
import { CompanionWindow } from "../../../contract/window/companion";
import { useWindowRuntime, useWindowService, type WindowRuntime } from "../../rpc/runtime";
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
import { itemWorkOf, paneAnswerOf, type PaneAnswer } from "../../lib/signal-work";
import { VAULT_ENABLED } from "@shared/features";
import { state$ } from "../../lib/state";
import { useCanvasTasks } from "../../lib/tasks-source";
import { useCanvas } from "../../lib/use-model";
import { accentColor } from "../../lib/theme";
import { KindMark } from "../NodeKindMark";
import { SeatRingView, useSeatGlanceOf } from "../SeatRing";
import { SignalReply } from "../signals/SignalReply";
import { SignalResourceChips } from "../signals/SignalResourceChips";
import { SignalWorkForm } from "../signals/SignalWorkForm";
import { OperatorModalShell } from "../operator-modal/OperatorModalShell";
import { PreviewedMarkdown } from "../preview/PreviewedMarkdown";
import { Button, Dropdown, Kbd } from "../ui";
import { FeedExchange } from "./FeedExchange";
import { crossedClosing, crossedLiveWords, crossedWords } from "@shared/signal-crossing";
import { FeedRegionStrip } from "./FeedRegionStrip";
import { FeedEmpty, FeedSeatChosen, FeedSeatsRow, FeedSeatsToggle } from "./FeedFilterParts";
import { feedTasksByNumber, type FeedTaskRef } from "./feed-text";
import {
  KIND_ICON,
  FeedCardView,
  FeedPills,
  FeedPortraitWell,
  FeedWords,
  NO_NOTES,
  automationSourceOf,
  quietNotesFor,
  type FeedCardViewProps,
} from "./FeedCardView";
import "./operator-feed.css";

const LEAVE_MS = 280;
const NO_IDS: ReadonlySet<string> = new Set();
const NO_WAITS: ReadonlyArray<{ readonly item: FeedItem; readonly place: FeedChainPlace | undefined }> = [];
/** The seat row's id, which the toggle names as the thing it opens. */
const SEATS_ROW_ID = "operator-feed-seats";

const closeOperatorFeed = (): void => closeOperatorModal("feed");

/** The region's own colour, or a quiet steel for the open field. */
const regionStyle = (color: string | undefined): CSSProperties =>
  ({ "--feed-region": color ? accentColor(color) : "var(--color-steel)" }) as CSSProperties;

/** A seat's ring, live: its own component so only a seat's card follows a seat. */
function LiveSeatRing({ seat }: { readonly seat: Seat }) {
  return <SeatRingView node={seat} px={46} glance={useSeatGlanceOf(seat)} />;
}

export const openSeat = (
  runtime: WindowRuntime,
  companion: CompanionWindow["Service"],
  item: FeedItem,
  node: Node | undefined,
): void => {
// Fixed in System Settings; the feed stays open where it was.
if (isThisMacItem(item)) {
openRemoteLoginSettings(runtime, companion);
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

/**
 * A task named in a card's words: the feed steps aside and the task opens on
 * its board, as a press on a signal's attachment chip does.
 */
export const openFeedTask = (task: FeedTaskRef): void => {
  closeOperatorFeed();
  openWorkDetail(task.nodeId, { itemId: task.taskId });
};

/** What sits in a card's portrait well, live: this Mac, the seat's own ring, the node's mark. */
const feedFace = (item: FeedItem, node: Node | undefined): ReactNode =>
  isThisMacItem(item) ? (
    <span className="operator-feed__node-mark">
      <MonitorSmartphone size={18} aria-hidden />
    </span>
  ) : node?.kind === "agent" ? (
    <LiveSeatRing seat={node} />
  ) : node ? (
    <KindMark node={node} className="operator-feed__node-mark" iconSize={18} />
  ) : undefined;

function FeedPortrait({ item, node }: { readonly item: FeedItem; readonly node: Node | undefined }) {
  return <FeedPortraitWell item={item} face={feedFace(item, node)} />;
}

/** A feed row drawn live: its portrait well holds the seat's ring or the node's mark. */
export function FeedCard({ node, ...card }: { readonly node: Node | undefined } & Omit<FeedCardViewProps, "face">) {
  return <FeedCardView {...card} face={feedFace(card.item, node)} />;
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
      <span>
        <Kbd>o</Kbd>{" "}
        {automationSourceOf(item) !== undefined ? "open run" : "open seat"}
      </span>
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
  taskByNumber,
  onOpenTask,
  onAnswer,
  onReply,
  onReviewCommit,
  waitsOn = NO_WAITS,
  notHere = 0,
  onGoTo,
  onOpenThread,
  crossed = false,
}: {
  readonly item: FeedItem;
  readonly node: Node | undefined;
  readonly nowMs: number;
  readonly quickReplies: ReadonlyArray<string>;
  readonly quietNotes: ReadonlyArray<string>;
  readonly replying: boolean;
  readonly sending: string | null;
  readonly error: string | null;
  readonly taskByNumber: ReadonlyMap<number, FeedTaskRef>;
  readonly onOpenTask: (task: FeedTaskRef) => void;
  readonly onAnswer: (answer: SignalAnswer) => void;
  readonly onReply: (open: boolean) => void;
  readonly onReviewCommit: (sha: string) => void;
  /** The open signals it depends on, each with its place in the chain: the band under the head. */
  readonly waitsOn?: ReadonlyArray<{ readonly item: FeedItem; readonly place: FeedChainPlace | undefined }>;
  /** Signals it comes after that are not here yet: a row each, never hidden. */
  readonly notHere?: number;
  readonly onGoTo?: (target: FeedItem) => void;
  /** Open Threads on the thread this signal is in. */
  readonly onOpenThread?: (threadId: string) => void;
  /** The seat withdrew it before the operator's answer reached it: it is closed, and the answer area says so. */
  readonly crossed?: boolean;
}) {
  const runtime = useWindowRuntime();
  const companion = useWindowService(CompanionWindow);
  const actions = useSignalActions();
  // A signal an automation raised opens its run, whatever the node lookup says.
  const isSeat = automationSourceOf(item) === undefined && (node === undefined || node.kind === "agent");
  const thisMac = isThisMacItem(item);
  const work = itemWorkOf(item);
  const { form } = work;
  // No seat to wake on an automation's signal: one row of answers.
  const quiet = quietNotesFor(item, quietNotes);
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
            <FeedWords item={item} nowMs={nowMs} taskByNumber={taskByNumber} chipTabStop onOpenTask={onOpenTask} />
          </div>
        </div>
        {waitsOn.length > 0 || notHere > 0 ? (
          <div className="operator-feed__band" data-testid="feed-depends-band">
            <p className="operator-feed__band-head" id={`${item.itemId}-depends`}>
              Depends on
            </p>
            <ul className="operator-feed__band-rows" aria-labelledby={`${item.itemId}-depends`}>
              {waitsOn.map(({ item: before, place }) => {
                const Icon = KIND_ICON[before.kind];
                return (
                  <li key={before.itemId}>
                    <button
                      type="button"
                      className="operator-feed__band-row"
                      data-testid="feed-depends-row"
                      data-kind={before.kind}
                      onClick={() => onGoTo?.(before)}
                    >
                      <Icon size={12} strokeWidth={2} aria-hidden className="operator-feed__band-glyph" />
                      <span className="operator-feed__band-kind">{FEED_KIND_LABEL[before.kind]}</span>
                      <span className="operator-feed__band-text">{before.text}</span>
                      {place ? (
                        <span className="operator-feed__chain-place">{`${String(place.index)} of ${String(place.size)}`}</span>
                      ) : null}
                    </button>
                  </li>
                );
              })}
              {Array.from({ length: notHere }, (_, at) => (
                <li key={`not-here-${String(at)}`} className="operator-feed__band-missing" data-testid="feed-depends-missing">
                  {`A signal from ${item.seat.name}, not here yet`}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {item.follows !== undefined && item.threadId !== undefined && onOpenThread !== undefined ? (
          <FeedExchange item={item} nowMs={nowMs} onOpenThread={onOpenThread} />
        ) : null}
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
        {crossed && !(replying && item.signalId) ? (
          // Nothing failed for the operator to fix, so it is said in ink, not as an error.
          <p className="operator-feed__crossed" data-testid="feed-crossed" tabIndex={-1}>
            {crossedWords(item.seat.name)}
          </p>
        ) : item.signalId &&
        (form?.kind === "artifact" || form?.kind === "proof" || (form?.kind === "secret" && VAULT_ENABLED)) &&
        answer === form.kind ? (
          <>
            <SignalWorkForm
              key={item.signalId}
              signalId={item.signalId}
              canvasName={item.canvasName}
              text={item.text}
              form={form}
              asker={item.seat.name}
              handIn={actions.handIn}
              putSecret={actions.putSecret}
              dismiss={actions.dismiss}
              onDone={() => onReply(false)}
            />
            {/* The form is the whole answer; the run is still one press away. */}
            {thisMac ? null : (
              <div className="operator-feed__actions">
                <OpenTargetButton item={item} node={node} isSeat={isSeat} />
              </div>
            )}
          </>
        ) : item.signalId && answer === "secret" ? (
          // Never answered in text: a secret goes only into the vault, which this build has off.
          <>
            <p className="operator-feed__secret-wait" role="note">
              This asks for a secret. Secrets are set through the vault, which is not set up yet, so it cannot be answered here.
            </p>
            {thisMac ? null : (
              <div className="operator-feed__actions">
                <OpenTargetButton item={item} node={node} isSeat={isSeat} />
              </div>
            )}
          </>
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
            {thisMac ? null : <OpenTargetButton item={item} node={node} isSeat={isSeat} />}
          </div>
        ) : replying && item.signalId ? (
          <>
            {crossed ? (
              <p className="operator-feed__crossed" data-testid="feed-crossed" tabIndex={-1}>
                {crossedWords(item.seat.name)} Your draft was not sent.
              </p>
            ) : null}
            {/* Locked when the card closes under it: the draft stays mounted to be read and copied, and nothing sends. */}
            <SignalReply
              signalId={item.signalId}
              canvasName={item.canvasName}
              seatNodeId={item.seat.nodeId}
              suggested={item.suggestions}
              respond={actions.respond}
              dismiss={actions.dismiss}
              onDone={() => onReply(false)}
              className="operator-feed__reply"
              locked={crossed}
            />
          </>
        ) : (
          <>
            {item.signalId ? (
              <FeedPills
                item={item}
                quickReplies={quickReplies}
                quietNotes={quiet}
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
                <Button size="xs" variant="subtle" onClick={() => openRemoteLoginSettings(runtime, companion)}>
                  Open Remote Login settings
                  <ArrowUpRight size={11} aria-hidden />
                </Button>
              ) : (
                <OpenTargetButton item={item} node={node} isSeat={isSeat} />
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
        quietCount={answer === "reply" ? quiet.length : 0}
        answer={answer}
      />
    </section>
  );
}

/**
 * The way out of a card, in its pane: the seat's own surface, or the run an
 * automation's signal raised. Shown wherever the pane answers, a form
 * included: a work signal's whole answer is its form, and the run is still
 * one press away.
 */
function OpenTargetButton({
  item,
  node,
  isSeat,
}: {
  readonly item: FeedItem;
  readonly node: Node | undefined;
  readonly isSeat: boolean;
  }) {
  const runtime = useWindowRuntime();
  const companion = useWindowService(CompanionWindow);
  return (
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
  onClick={() => openSeat(runtime, companion, item, node)}
  >
      {isSeat ? "Open seat" : automationSourceOf(item) === undefined ? "Open" : "Open run"}
      <ArrowUpRight size={11} aria-hidden />
    </Button>
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
  { value: "act", label: "In order to act" },
  { value: "urgency", label: "Most urgent first" },
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
];

export function OperatorFeed() {
const runtime = useWindowRuntime();
const companion = useWindowService(CompanionWindow);
const feed = useOperatorFeed();
  const signalActions = useSignalActions();
  const quickReplies = useQuickReplies();
  const quietNotes = useQuietNotes();
  const canvasName = use$(state$.canvasName);
  const nodesById: ReadonlyMap<string, Node> = useCanvas(canvasName).nodes;
  // A card's `#42` is the canvas's task 42: the numbers the seats write.
  const tasks = useCanvasTasks(canvasName);
  const taskByNumber = useMemo(() => feedTasksByNumber(tasks), [tasks]);
  const regionPick = use$(feedView$.region);
  const feedOrder = use$(feedView$.order);
  const feedQuery = use$(feedView$.query);
  const feedKinds = use$(feedView$.kinds);
  const feedSeatId = use$(feedView$.seat);
  const seatsOpen = use$(feedView$.seatsOpen);
  const feedReady = use$(feedView$.ready);
  const filter = useMemo(
    () => feedFilterOf({ query: feedQuery, kinds: feedKinds, seat: feedSeatId, ready: feedReady }),
    [feedQuery, feedKinds, feedSeatId, feedReady],
  );
  const filtering = feedFilterOn(filter);
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
  /** Clear takes the keyboard with it: it lands in the search field rather than on the body. */
  const searchRef = useRef<HTMLInputElement>(null);
  /** The Seats toggle, where closing the row hands the keyboard back. */
  const seatsToggleRef = useRef<HTMLButtonElement>(null);
  const refocusSeats = useRef(false);
  const clearAll = (event: ReactMouseEvent<HTMLButtonElement>): void => {
    clearFeedFilters();
    claimFocus(searchRef.current, "gesture", { event });
  };

  // The view the operator picked: one region, or all of them, in the picked
  // order. Kept in feedView$ so it survives the modal's open and close.
  const viewSections = useMemo(
    () => viewFeedSections(feed.sections, regionPick, canvasName, feedOrder, filter),
    [feed.sections, regionPick, canvasName, feedOrder, filter],
  );

  // What the feed draws. The operator's own picks (canvas, region, order)
  // rank it afresh; any other change keeps every card where the operator
  // sees it: a new card goes where the ranking puts it, and an answered or
  // dismissed one fades out in its place, its region with it, before it
  // leaves. Worked out while rendering, against what was last drawn, so no
  // commit ever draws the list without a card that is still fading: one that
  // did remounted the card, a reply box open on it took focus again, and the
  // list scrolled to it.
  const pick = `${canvasName}\n${activeRegion ? `region:${regionPickKey(activeRegion.path)}` : "all"}\n${feedOrder}\n${feedQuery}\n${feedKinds.join(",")}\n${feedSeatId ?? ""}\n${String(feedReady)}`;
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

  // The whole feed in the picked order, unfiltered: what a chain counts
  // ("3 of 10" stays true under a filter) and where a link may go.
  const everyItem = useMemo(
    () => feedItemsInOrder(viewFeedSections(feed.sections, undefined, canvasName, feedOrder)),
    [feed.sections, canvasName, feedOrder],
  );
  const chainPlaces = useMemo(() => feedChainPlaces(everyItem), [everyItem]);
  // In the order to act a chain folds after its next waiting card; a press on the fold unfolds it.
  const [unfolded, setUnfolded] = useState<ReadonlySet<string>>(NO_IDS);
  const unfoldChainOf = (itemId: string): void => {
    const chainId = chainPlaces.get(itemId)?.chainId;
    if (chainId === undefined) return;
    const members = everyItem.filter((item) => chainPlaces.get(item.itemId)?.chainId === chainId).map((item) => item.itemId);
    setUnfolded((current) => new Set([...current, ...members]));
  };
  const rowsOf = useMemo(() => {
    const rows = new Map<ShownFeedSection, ReadonlyArray<FeedRow>>();
    for (const section of sections) {
      rows.set(
        section,
        feedOrder === "act"
          ? foldFeedChains(section.items, chainPlaces, unfolded)
          : section.items.map((item): FeedRow => ({ kind: "card", item })),
      );
    }
    return rows;
  }, [sections, feedOrder, chainPlaces, unfolded]);
  const folded = useMemo(
    () => new Set(sections.flatMap((section) => [...foldedItemIds(section.items, rowsOf.get(section) ?? [])])),
    [sections, rowsOf],
  );
  // The cards still waiting, in the order they are drawn, a fold's left out.
  const items = useMemo(
    () =>
      sections.flatMap((section) =>
        section.items.filter((item) => !section.leavingIds.has(item.itemId) && !folded.has(item.itemId)),
      ),
    [sections, folded],
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
  // The selected card closed because the seat withdrew it before the operator's answer reached it: the pane
  // keeps it and says so, in the answer area, until the operator moves; the list has already handed on.
  const [crossed, setCrossed] = useState<FeedItem | null>(null);
  const lastSelected = useRef<FeedItem | undefined>(undefined);
  // On the render where the selected card has just left and the hold is not set yet, the pane keeps it
  // (never an empty pane for a frame): a reply being written in it stays mounted if the hold follows.
  const paneItem =
    crossed ?? selectedItem ?? (selected !== null && lastSelected.current?.itemId === selected ? lastSelected.current : undefined);
  // The control the operator was on left with the answer area: the keyboard goes back to the frame, where keys are heard.
  useEffect(() => {
    if (crossed === null) return;
    const active = document.activeElement;
    const frame = scrollRef.current?.closest<HTMLElement>(".operator-modal__frame") ?? null;
    const answerArea = frame?.querySelector(".operator-feed__answer") ?? null;
    // Body, or the reply the operator was typing in (locked now): the keyboard goes to the note, so it is heard and keys are heard.
    if (active === null || active === document.body || answerArea?.contains(active) === true) {
      claimFocus(frame?.querySelector<HTMLElement>('[data-testid="feed-crossed"]') ?? frame, "gesture");
    }
  }, [crossed]);
  const replyForRef = useRef(replyFor);
  replyForRef.current = replyFor;
  useEffect(() => {
    const before = lastSelected.current;
    if (before?.signalId !== undefined && !items.some((item) => item.itemId === before.itemId)) {
      const closed = agentSignals$[before.signalId].peek();
      if (closed !== undefined && crossedClosing(closed)) {
        setCrossed(before);
        setAnnounceNote(
          `${crossedLiveWords(before.seat.name, before.text)}${replyForRef.current === before.itemId ? ". Your draft was not sent." : ""}`,
        );
      }
    }
    lastSelected.current = selectedItem;
  }, [items, selectedItem]);
  // A card asked for by openNeedsYouOn: selected and brought into view once
  // the list holds it. A filter hiding it is cleared first; an ask for a card
  // the feed does not hold (closed already) is let go.
  // Said once by the live line when a link cleared the filters, until the operator narrows again.
  const [announceNote, setAnnounceNote] = useState("");
  const clearedForAsk = useRef(false);
  // The ask came from a link, a band row or W (not from outside the feed), and the filters were cleared for it.
  const wentTo = useRef(false);
  const announcedClear = useRef(false);
  const asked = use$(feedAsked$.itemId);
  useEffect(() => {
    if (asked === null) return;
    const target = items.find((item) => item.itemId === asked);
    if (target !== undefined) {
      feedAsked$.itemId.set(null);
      setSelected(asked);
      setRevealId(asked);
      if (wentTo.current) {
        wentTo.current = false;
        // The press left the link or row it was on: the keyboard stays in the feed, and the move is said.
        claimFocus(scrollRef.current?.closest<HTMLElement>(".operator-modal__frame") ?? null, "gesture");
        const place = chainPlaces.get(asked);
        const went = `Went to: ${target.text}${place ? `, ${String(place.index)} of ${String(place.size)}` : ""}`;
        // After a clear it says both, so the operator hears where they landed.
        setAnnounceNote(announcedClear.current ? `Filters cleared to show it. ${went}` : went);
        announcedClear.current = false;
      }
      return;
    }
    const held = feed.sections.some((section) => section.items.some((item) => item.itemId === asked));
    if (held && folded.has(asked)) {
      unfoldChainOf(asked);
      return;
    }
    if (held && (filtering || activeRegion !== undefined)) {
      clearFeedFilters();
      clearedForAsk.current = true;
      announcedClear.current = true;
      setAnnounceNote("Filters cleared to show it");
      return;
    }
    feedAsked$.itemId.set(null);
    wentTo.current = false;
    announcedClear.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asked, items, feed.sections, filtering, activeRegion, folded]);
  useEffect(() => {
    if (clearedForAsk.current) {
      clearedForAsk.current = false;
      return;
    }
    setAnnounceNote("");
  }, [filter, activeRegion]);
  /** A Depends on link, a band row, the W key: select the card and bring it into view. */
  const goTo = (target: FeedItem): void => {
    setCrossed(null);
    wentTo.current = true;
    feedAsked$.itemId.set(target.itemId);
  };
  const waitsOnKeys = keyCaps("inFeed.waitsOn");
  const waitsOnShortcut = keyAria("inFeed.waitsOn");
  /** A card's place in its chain and its Depends on line. */
  const cardOrderOf = (item: FeedItem): Pick<FeedCardViewProps, "chain" | "depends" | "dependsKeys" | "dependsShortcut"> => {
    const chain = chainPlaces.get(item.itemId);
    const depends = feedDependsLineOf(item, everyItem);
    return {
      ...(chain === undefined ? {} : { chain }),
      ...(depends === undefined ? {} : { depends }),
      ...(depends?.kind === "waiting" && waitsOnKeys !== undefined ? { dependsKeys: waitsOnKeys } : {}),
      ...(depends?.kind === "waiting" && waitsOnShortcut !== undefined ? { dependsShortcut: waitsOnShortcut } : {}),
    };
  };

  // An answer that went through: said once its card has left and the next one holds the selection.
  const [closedBy, setClosedBy] = useState<{ readonly itemId: string; readonly word: string } | null>(null);
  useEffect(() => {
    if (closedBy === null || items.some((candidate) => candidate.itemId === closedBy.itemId)) return;
    if (items.length > 0 && (selectedItem === undefined || selected === closedBy.itemId)) return;
    setClosedBy(null);
    // A seat filter drops with its last need, in the same beat: that is no narrowing by the operator, so it keeps this note.
    if (filtering || activeRegion !== undefined) clearedForAsk.current = true;
    setAnnounceNote(
      selectedItem === undefined
        ? // The list is what the filters show: with some on and the feed still holding needs, others wait out of sight.
          `${closedBy.word}. ${
            feed.count === 0 || (!filtering && activeRegion === undefined)
              ? "Nothing else waiting"
              : filtering
                ? "Nothing else shown with these filters"
                : "Nothing else shown in this region"
          }`
        : `${closedBy.word}. Next: ${feedCardSpeech(selectedItem, chainPlaces.get(selectedItem.itemId))}`,
    );
  }, [closedBy, items, selected, selectedItem, chainPlaces, filtering, activeRegion, feed.count]);

  const answer = async (item: FeedItem, chosen: SignalAnswer): Promise<void> => {
    if (!item.signalId || sendingRef.current.has(item.itemId)) return;
    setSending((current) => new Map(current).set(item.itemId, answerLabel(chosen)));
    setFailure(null);
    try {
      const result = await sendSignalAnswer(item.signalId, chosen, {
        respond: signalActions.respond,
        dismiss: signalActions.dismiss,
      });
      if (!result.ok) setFailure({ itemId: item.itemId, message: result.message });
      else setClosedBy({ itemId: item.itemId, word: chosen.kind === "dismiss" ? "Dismissed" : "Answered" });
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
    // A task chip in a card's words is a button: Enter opens the task, and no
    // answer key acts from it (a chip can name another card's task).
    if (event.target instanceof Element && event.target.closest(".operator-feed__text .resource-chip")) return;
    // The order menu reads letters as type-ahead: keys that land inside a
    // listbox are the menu's, never j/k movement.
    if (event.target instanceof Element && event.target.closest('[role="listbox"]')) return;
    // A region chip is a button: Enter picks it, and no answer key acts from it.
    if (event.target instanceof Element && event.target.closest('[data-testid="feed-region-strip"]')) return;
    // The filter bar's chips and search field are their own: their keys are theirs.
    if (event.target instanceof Element && event.target.closest('[data-testid="feed-filter-bar"]')) return;
    // A Depends on link, a band row and the fold are buttons: Enter presses them, and no answer key acts from them.
    if (
      event.target instanceof Element &&
      event.target.closest(".operator-feed__depends-link, .operator-feed__band-row, .operator-feed__fold")
    )
      return;
    // The moves every list shares (lib/list-nav). Enter is the feed's own: it replies.
    const intent = listIntentOf(event.nativeEvent);
    if (intent !== null && intent !== "open") {
      event.preventDefault();
      const next = stepList(
        items.map((item) => item.itemId),
        selected,
        intent,
      );
      setCrossed(null);
      setSelected(next);
      setRevealId(next);
      // The keyboard stays on the frame, so the card stepped onto is said by the live line.
      const stepped = items.find((candidate) => candidate.itemId === next);
      if (stepped !== undefined && next !== selected) setAnnounceNote(feedCardSpeech(stepped, chainPlaces.get(stepped.itemId)));
      return;
    }
    // The pane shows a card that closed, not the selected one: a key that would act is only let go of, so no
    // answer lands on a card the pane is not showing. Tab, Escape and the arrows pass.
    if (crossed !== null && (event.key.length === 1 || event.key === "Enter")) {
      event.preventDefault();
      setCrossed(null);
      // Said, so the pane flipping to the next card is not silent: the key answered nothing.
      setAnnounceNote(
        `Your key did not answer: that card was withdrawn.${
          selectedItem === undefined ? "" : ` Now: ${feedCardSpeech(selectedItem, chainPlaces.get(selectedItem.itemId))}`
        }`,
      );
      return;
    }
    const item = items.find((candidate) => candidate.itemId === selected);
    if (!item) return;
    // W: to what the selected card waits on, the first still open; again goes further back. A ready card has none.
    if (keyIs(event.nativeEvent, "inFeed.waitsOn")) {
      const target = waitsOnTarget(item, everyItem);
      if (target !== undefined) {
        event.preventDefault();
        goTo(target);
      }
      return;
    }
    // A held key answers once: its repeats would land on the neighbour that
    // takes the selection, closing a signal the operator never saw.
    if (event.repeat) return;
    const keyed = item.signalId
      ? feedAnswerForKey(event, mergedQuickReplies(quickReplies, item.suggestions), quietNotesFor(item, quietNotes))
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
      else openSeat(runtime, companion, item, nodesById.get(item.seat.nodeId));
    }
  };
  // Escape closes an open reply first, then the seats row, and only then does
  // the shell close the feed.
  const onEscape = (): boolean => {
    if (replyFor !== null) {
      setReplyFor(null);
      return true;
    }
    if (seatsOpen) {
      refocusSeats.current = true;
      feedView$.seatsOpen.set(false);
      return true;
    }
    return false;
  };
  // The region chips, in the order the feed's sections run, each parent just
  // before its first child; a pick that emptied out stays so it can be seen
  // and cleared.
  const regionChips = useMemo(
    () => feedRegionChips(orderFeedSections(feed.sections, feedOrder), activeRegion?.path),
    [feed.sections, feedOrder, activeRegion],
  );
  // The kind and seat chips, in the order the feed runs them: every kind it
  // holds in the one order every surface says them, and every seat with a need.
  // Counted over the whole feed, so picking one chip never empties the others.
  const kindChips = useMemo(() => feedKindChips(orderFeedSections(feed.sections, feedOrder)), [feed.sections, feedOrder]);

  // The seat chips follow the region chips: with a region picked, only the
  // seats with a need in it, so the row says what the list is showing. The
  // kind filter is left out on purpose: picking one chip never empties the rest.
  const seatChips = useMemo(() => {
    const scoped =
      activeRegion === undefined
        ? feed.sections
        : feed.sections.filter((section) => regionMatches(activeRegion.path, section.region));
    return feedSeatChips(orderFeedSections(scoped, feedOrder));
  }, [feed.sections, feedOrder, activeRegion]);
  // Ready, counted over the whole feed: offered once anything waits, and kept while it is on.
  const readyCount = everyItem.filter((item) => !feedItemWaits(item)).length;
  const readyChipShown = feedReady || everyItem.some(feedItemWaits);
  // A row of one chip chooses nothing: the toggle waits for a second seat.
  const seatsToggleShown = seatChips.length >= 2;
  // A seat the region does not hold would empty the feed with no other sign:
  // the seat goes with the region that does not keep it, and with its last need.
  useEffect(() => {
    if (feedSeatId === undefined) return;
    if (seatChips.some((chip) => chip.seatId === feedSeatId)) return;
    feedView$.seat.set(undefined);
  }, [feedSeatId, seatChips]);
  useEffect(() => {
    if (seatsOpen && !seatsToggleShown) feedView$.seatsOpen.set(false);
  }, [seatsOpen, seatsToggleShown]);
  // Closing the row takes the keyboard with it: back to the toggle that opened
  // it, which is where the operator was when they pressed Escape in the row.
  useEffect(() => {
    if (seatsOpen || !refocusSeats.current) return;
    refocusSeats.current = false;
    claimFocus(seatsToggleRef.current, "gesture");
  }, [seatsOpen]);
  // The picked seat, while the row is folded or its needs just left the list:
  // the chip keeps its name and its region's dot, so a filter is never invisible.
  const activeSeat = useMemo((): FeedSeatChip | undefined => {
    if (feedSeatId === undefined) return undefined;
    const chip = seatChips.find((candidate) => candidate.seatId === feedSeatId);
    if (chip) return chip;
    const node = nodesById.get(feedSeatId);
    return {
      seatId: feedSeatId,
      name: node ? titleOf(node) : "that seat",
      count: 0,
      regionLabel: activeRegion ? regionPickName(activeRegion.path) : "",
      regionPath: activeRegion?.path ?? [],
      open: activeRegion !== undefined && activeRegion.path.length === 0,
      color: undefined,
    };
  }, [feedSeatId, seatChips, nodesById, activeRegion]);
  const chosenRegion = activeRegion ? regionPickKey(activeRegion.path) : undefined;
  const regionName = activeRegion ? regionPickName(activeRegion.path) : "";
  // The rows the whole feed holds, readings included: what a filter's pair counts against.
  const feedRows = feed.sections.reduce((total, section) => total + section.items.length, 0);
  const status = feedStatusLine(
    feed,
    activeRegion ? { label: regionName, count: needsOperatorCount(items) } : undefined,
    filtering ? { count: items.length, total: feedRows } : undefined,
  );

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
      belowBar
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
      {feed.count > 0 ? (
        <div className="operator-feed__filter-bar" data-testid="feed-filter-bar">
          <input
            ref={searchRef}
            className="operator-feed__search"
            type="search"
            placeholder="Search needs"
            aria-label="Search needs"
            value={feedQuery}
            onChange={(event) => feedView$.query.set(event.target.value)}
          />
          {readyChipShown ? (
            <div className="operator-feed__chips operator-feed__chips--ready" role="group" aria-label="Show only">
              <button
                type="button"
                className="operator-feed__filter-chip"
                data-testid="feed-ready-chip"
                aria-pressed={feedReady}
                aria-label={`Ready, ${String(readyCount)}`}
                onClick={() => feedView$.ready.set(!feedReady)}
              >
                {feedReady ? <Check size={11} strokeWidth={2} aria-hidden /> : null}
                Ready
                <span className="operator-feed__filter-count" aria-hidden>
                  {readyCount}
                </span>
              </button>
            </div>
          ) : null}
          <div className="operator-feed__chips" role="group" aria-label="Kinds">
            {kindChips.map((chip) => (
              <button
                key={chip.kind}
                type="button"
                className="operator-feed__filter-chip"
                data-testid="feed-kind-chip"
                data-kind={chip.kind}
                aria-pressed={feedKinds.includes(chip.kind)}
                onClick={() => toggleFeedKind(chip.kind)}
              >
                {feedKinds.includes(chip.kind) ? <Check size={11} strokeWidth={2} aria-hidden /> : null}
                {chip.label}
                <span className="operator-feed__filter-count" aria-hidden>
                  {chip.count}
                </span>
              </button>
            ))}
          </div>
          {seatsToggleShown ? (
            <FeedSeatsToggle
              ref={seatsToggleRef}
              count={seatChips.length}
              open={seatsOpen}
              controls={SEATS_ROW_ID}
              onToggle={() => feedView$.seatsOpen.set(!seatsOpen)}
            />
          ) : null}
          {activeSeat === undefined ? null : (
            <FeedSeatChosen seat={activeSeat} onClear={() => feedView$.seat.set(undefined)} />
          )}
          {filtering || activeRegion !== undefined ? (
            <Button size="sm" variant="subtle" data-testid="feed-clear-filters" onClick={clearAll}>
              Clear
            </Button>
          ) : null}
          {seatsToggleShown ? (
            <FeedSeatsRow
              id={SEATS_ROW_ID}
              chips={seatChips}
              chosen={feedSeatId}
              open={seatsOpen}
              countWord="waiting"
              onPick={toggleFeedSeat}
            />
          ) : null}
        </div>
      ) : null}
      {/* Mounted for the modal's life: a live region added with its text says nothing. */}
      <span className="operator-feed__announce" role="status" aria-live="polite">
        {announceNote !== ""
          ? announceNote
          : filtering
            ? `${String(items.length)} of ${String(feedRows)} shown with these filters`
            : ""}
      </span>
      {sections.length === 0 ? (
        <div className="operator-feed__scroll" data-testid="operator-feed">
          {filtering ? (
            <FeedEmpty
              testId="feed-no-matches"
              status={false}
              title="Nothing matches these filters"
              copy="Clear the search or the chips to see what is still waiting."
              action={
                <Button size="sm" variant="subtle" onClick={clearAll}>
                  Clear
                </Button>
              }
            />
          ) : activeRegion !== undefined ? (
            <FeedEmpty
              title={<>Nothing waiting in {regionName}</>}
              copy="This corner is clear. The rest of the feed is still waiting where it was."
              action={
                <Button size="sm" variant="subtle" onClick={() => feedView$.region.set(undefined)}>
                  Show all regions
                </Button>
              }
            />
          ) : (
            <FeedEmpty
              title="Your work for today is done"
              copy="Nothing is waiting on you. Work an automation raises, notices, and agents that need you land here."
            />
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
                {(rowsOf.get(section) ?? []).map((row, at, rows) =>
                  row.kind === "fold" ? (
                    <div key={`fold-${row.chainId}`} className="operator-feed__slot" role="listitem">
                      <button
                        type="button"
                        className="operator-feed__fold"
                        data-testid="feed-chain-fold"
                        aria-label={foldName(row.count, at > 0 ? rows[at - 1] : undefined)}
                        onClick={() => {
                          unfoldChainOf(row.firstId);
                          setSelected(row.firstId);
                          setAnnounceNote(`${String(row.count)} more shown`);
                          // The fold leaves with the press: the keyboard stays in the feed.
                          claimFocus(scrollRef.current?.closest<HTMLElement>(".operator-modal__frame") ?? null, "gesture");
                        }}
                      >
                        {`${String(row.count)} more in this order`}
                      </button>
                    </div>
                  ) : (
                  <FeedCard
                    key={row.item.itemId}
                    item={row.item}
                    node={nodesById.get(row.item.seat.nodeId)}
                    nowMs={feed.generatedAt}
                    quickReplies={quickReplies}
                    selected={selected === row.item.itemId}
                    reveal={revealId === row.item.itemId}
                    leaving={section.leavingIds.has(row.item.itemId)}
                    sending={sending.get(row.item.itemId) ?? null}
                    pills={false}
                    taskByNumber={taskByNumber}
                    onOpenTask={openFeedTask}
                    {...cardOrderOf(row.item)}
                    onGoTo={goTo}
                    onSelect={() => {
                      setCrossed(null);
                      setSelected(row.item.itemId);
                    }}
                    onQuickReply={(text) => void answer(row.item, { kind: "reply", text })}
                  />
                  ),
                )}
              </FeedRegionSection>
            ))}
          </div>
          {paneItem ? (
            <FeedDetail
              key={paneItem.itemId}
              item={paneItem}
              node={nodesById.get(paneItem.seat.nodeId)}
              waitsOn={(paneItem.waitingOn ?? []).flatMap((signalId) => {
                const before = everyItem.find((one) => one.signalId === signalId);
                return before === undefined ? [] : [{ item: before, place: chainPlaces.get(before.itemId) }];
              })}
              notHere={paneItem.notReceived?.length ?? 0}
              onGoTo={goTo}
              crossed={crossed !== null}
              onOpenThread={(threadId) => {
                askThread(threadId);
                openOperatorModalFrom("feed", "threads", {
                  itemId: paneItem.itemId,
                  expanded: [],
                  scrollTop: scrollRef.current?.scrollTop ?? 0,
                });
              }}
              nowMs={feed.generatedAt}
              quickReplies={quickReplies}
              quietNotes={quietNotes}
              replying={replyFor === paneItem.itemId}
              sending={sending.get(paneItem.itemId) ?? null}
              error={failure?.itemId === paneItem.itemId ? failure.message : null}
              taskByNumber={taskByNumber}
              onOpenTask={openFeedTask}
              onAnswer={(chosen) => void answer(paneItem, chosen)}
              onReply={(open) => setReplyFor(open ? paneItem.itemId : null)}
              onReviewCommit={(sha) =>
                openCommitReview({
                  nodeId: paneItem.seat.nodeId,
                  sha,
                  place: { itemId: paneItem.itemId, expanded: [], scrollTop: scrollRef.current?.scrollTop ?? 0 },
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
