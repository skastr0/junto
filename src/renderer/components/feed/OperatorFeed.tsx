/**
 * The operator feed: one scrolling surface of everything on the canvas that
 * wants the operator, grouped by region. A card is a seat and its need
 * (blocked, needs input, escalation, ready for review, or an AI reading that
 * it is waiting on you), or a need read off the canvas (a stoppage, a held
 * node, a sink that wants input); signals are answered inline or with one
 * quick reply, anything else opens the node.
 *
 * The data is the shared projection (`@shared/operator-feed`), so this is one
 * rendering of a shape a mobile client can read as well.
 *
 * Keys while open: j / k move, 1..9 send that quick reply, Enter writes a
 * reply (or opens the seat), o opens the seat, Esc closes the reply first and
 * then the feed.
 *
 * An operator modal: OperatorModalHost owns the chord (⌘I) and mounts this
 * only while open, so selection, reply and expanded details reset on every
 * open. The shell owns the frame, the header, focus and Escape.
 */
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
  ChevronDown,
  CirclePause,
  Inbox,
  MessageCircleQuestion,
  MessageSquareText,
  OctagonAlert,
  ScanEye,
  type LucideIcon,
} from "lucide-react";
import type { Node, Seat } from "@shared/model";
import {
  FEED_KIND_LABEL,
  needsOperatorCount,
  type FeedItem,
  type FeedItemKind,
  type FeedSortOrder,
} from "@shared/operator-feed";
import { activateNodeSurface } from "../../lib/activate-node-surface";
import { mailAgeLabel } from "../../lib/actor-ledger";
import { dismissAgentSignal, respondToAgentSignal } from "../../lib/agent-signals-state";
import { SIGNALS_SECTION } from "../../lib/agent-signals-view";
import { isOperatorTyping } from "../../lib/focus-ownership";
import {
  feedItemsInOrder,
  feedStatusLine,
  feedView$,
  holdFeedPlaces,
  reconcileSelection,
  stepFeedSelection,
  useOperatorFeed,
  viewFeedSections,
  type ShownFeedSection,
} from "../../lib/operator-feed";
import { canReviewCommit, openCommitReview } from "../../lib/git-summary";
import { closeOperatorModal, operatorModalPlace } from "../../lib/operator-modal";
import { mergedQuickReplies, quickReplyForKey, useQuickReplies } from "../../lib/quick-replies";
import { requestSectionReveal } from "../../lib/sidebar-sections";
import { state$ } from "../../lib/state";
import { useCanvas } from "../../lib/use-model";
import { accentColor } from "../../lib/theme";
import { THREAD_HEALTH_STATUS_TONE } from "../../lib/thread-health";
import { AgentPortrait } from "../AgentPortrait";
import { KindMark } from "../NodeKindMark";
import { SeatRingView, useSeatGlanceOf } from "../SeatRing";
import { QuickReplies } from "../signals/QuickReplies";
import { SignalReply } from "../signals/SignalReply";
import { OperatorModalShell } from "../operator-modal/OperatorModalShell";
import { PreviewedMarkdown } from "../preview/PreviewedMarkdown";
import { Button, Dropdown, Kbd, StatusDot } from "../ui";
import "./operator-feed.css";

const LEAVE_MS = 280;
const NO_IDS: ReadonlySet<string> = new Set();

const closeOperatorFeed = (): void => closeOperatorModal("feed");

/** How each need reads: a glyph on the portrait; its word is FEED_KIND_LABEL. */
const KIND_ICON: Readonly<Record<FeedItemKind, LucideIcon>> = {
  blocked: OctagonAlert,
  attention: MessageCircleQuestion,
  stopped: CirclePause,
  escalate: ArrowBigUpDash,
  feedback: MessageSquareText,
  health: ScanEye,
};

/** The region's own colour, or a quiet steel for the open field. */
const regionStyle = (color: string | undefined): CSSProperties =>
  ({ "--feed-region": color ? accentColor(color) : "var(--color-steel)" }) as CSSProperties;

/** A seat's ring, live: its own component so only a seat's card follows a seat. */
function LiveSeatRing({ seat }: { readonly seat: Seat }) {
  return <SeatRingView node={seat} px={46} glance={useSeatGlanceOf(seat)} />;
}

const openSeat = (item: FeedItem, node: Node | undefined): void => {
  if (!node) return;
  closeOperatorFeed();
  if (item.signalId) requestSectionReveal(node.id, SIGNALS_SECTION);
  activateNodeSurface(node.id);
};

/**
 * One feed row. Exported so other surfaces (the onboarding tour) can show a
 * real row from fixture items: with `node` undefined it draws the seat's
 * portrait without the live ring and disables Open seat.
 */
export function FeedCard({
  item,
  node,
  nowMs,
  quickReplies,
  selected,
  reveal,
  leaving,
  replying,
  expanded,
  sending,
  error,
  onSelect,
  onReply,
  onQuickReply,
  onToggleDetail,
  onReviewCommit,
}: {
  readonly item: FeedItem;
  readonly node: Node | undefined;
  readonly nowMs: number;
  readonly quickReplies: ReadonlyArray<string>;
  readonly selected: boolean;
  /** Scroll into view as it is selected: only a j/k step asks for it. */
  readonly reveal: boolean;
  readonly leaving: boolean;
  readonly replying: boolean;
  readonly expanded: boolean;
  /** The quick reply in flight for this card, if any. */
  readonly sending: string | null;
  readonly error: string | null;
  readonly onSelect: () => void;
  readonly onReply: (open: boolean) => void;
  readonly onQuickReply: (text: string) => void;
  readonly onToggleDetail: () => void;
  /** Leave the feed for the full review of a commit this card carries. Absent where there is no feed to leave. */
  readonly onReviewCommit?: ((sha: string) => void) | undefined;
}) {
  const ref = useRef<HTMLElement>(null);
  const labelId = useId();
  useEffect(() => {
    if (selected && reveal) ref.current?.scrollIntoView({ block: "nearest" });
  }, [selected, reveal]);
  const label = FEED_KIND_LABEL[item.kind];
  const KindIcon = KIND_ICON[item.kind];
  const isSeat = node === undefined || node.kind === "agent";
  const age = mailAgeLabel(nowMs, item.since);
  const health = item.kind === "health" ? undefined : item.health;
  // More to see than the sentence: the agent's longer text, or files it attached.
  const hasDetails =
    item.signalId !== undefined && (Boolean(item.detail) || (item.attachments?.length ?? 0) > 0);

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
        // are told apart on entry and their buttons can keep short names.
        aria-labelledby={`${labelId}-name ${labelId}-kind ${labelId}-text`}
        // Select on click, not on press: selecting numbers the row's pills,
        // and a press that reshaped them would land its release elsewhere.
        onClick={onSelect}
      >
        <div className="operator-feed__portrait">
          {node?.kind === "agent" ? (
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
        <div className="operator-feed__body">
          <header className="operator-feed__card-head">
            <span id={`${labelId}-name`} className="operator-feed__name">{item.seat.name}</span>
            <span id={`${labelId}-kind`} className="operator-feed__kind">{label}</span>
            {age ? (
              <time className="operator-feed__age" title={new Date(item.since!).toLocaleString()}>
                {age}
              </time>
            ) : null}
          </header>
          <p id={`${labelId}-text`} className="operator-feed__text">{item.text}</p>
          {health ? (
            <p className="operator-feed__health" title="Jev's reading of the screen, not the agent's own claim">
              <StatusDot tone={THREAD_HEALTH_STATUS_TONE[health.tone]} />
              AI reads {health.label}
              {health.stale ? <span className="operator-feed__faint">, last observed</span> : null}
            </p>
          ) : null}
          {hasDetails ? (
            <button
              type="button"
              className="operator-feed__detail-toggle"
              aria-expanded={expanded}
              // One name in both states: aria-expanded says which.
              aria-label={`Details from ${item.seat.name}`}
              onClick={onToggleDetail}
            >
              <ChevronDown size={12} className={expanded ? "operator-feed__chevron--open" : undefined} aria-hidden />
              {expanded ? "Hide details" : "Details"}
            </button>
          ) : null}
          {/* Mounted with the open details, so a closed card reads no file. */}
          {/* Only a signal carries details, so the signal is always there to read from. */}
          {hasDetails && item.signalId && expanded ? (
            <PreviewedMarkdown
              markdown={item.detail}
              attachments={item.attachments}
              source={{ kind: "signal", signalId: item.signalId }}
              seat={{ canvasName: item.canvasName, nodeId: item.seat.nodeId }}
              // Only a sender on the open canvas with a folder can be reviewed.
              onReviewCommit={onReviewCommit && canReviewCommit(item.canvasName, item.seat.nodeId) ? onReviewCommit : undefined}
              textClassName="operator-feed__detail"
            />
          ) : null}
          {replying && item.signalId ? (
            <SignalReply
              signalId={item.signalId}
              suggested={item.suggestions}
              respond={respondToAgentSignal}
              dismiss={dismissAgentSignal}
              onDone={() => onReply(false)}
              className="operator-feed__reply"
            />
          ) : (
            <div className="operator-feed__actions">
              {item.signalId ? (
                <QuickReplies
                  replies={quickReplies}
                  suggested={item.suggestions}
                  pending={sending}
                  numbered={selected}
                  to={item.seat.name}
                  onPick={onQuickReply}
                  className="operator-feed__quick"
                />
              ) : null}
              <span className="operator-feed__actions-end">
                {item.signalId ? (
                  <Button
                    size="xs"
                    variant="subtle"
                    aria-label={`Write reply to ${item.seat.name}`}
                    onClick={() => onReply(true)}
                  >
                    Write reply
                  </Button>
                ) : null}
                <Button
                  size="xs"
                  variant="subtle"
                  disabled={!node}
                  aria-label={`${isSeat ? "Open seat" : "Open"} ${item.seat.name}`}
                  onClick={() => openSeat(item, node)}
                >
                  {isSeat ? "Open seat" : "Open"}
                  <ArrowUpRight size={11} aria-hidden />
                </Button>
              </span>
            </div>
          )}
          {error && !replying ? (
            <p className="operator-feed__error" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      </article>
    </div>
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

/** Dropdown values for the region pick; canvas region ids never collide. */
const ALL_REGIONS = "all";
const OPEN_FIELD = "open-field";

const FEED_ORDER_OPTIONS: ReadonlyArray<{ readonly value: FeedSortOrder; readonly label: string }> = [
  { value: "urgency", label: "Most urgent first" },
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
];

export function OperatorFeed() {
  const feed = useOperatorFeed();
  const quickReplies = useQuickReplies();
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
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set(place?.expanded));
  // Quick replies in flight, by item: one per card, cards independent.
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
  const pick = `${canvasName}\n${activeRegion ? (activeRegion.regionId ?? OPEN_FIELD) : ALL_REGIONS}\n${feedOrder}`;
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

  const sendQuick = async (item: FeedItem, text: string): Promise<void> => {
    if (!item.signalId || sendingRef.current.has(item.itemId)) return;
    setSending((current) => new Map(current).set(item.itemId, text));
    setFailure(null);
    try {
      const result = await respondToAgentSignal(item.signalId, text);
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
    // The region and order menus read letters as type-ahead: keys that land
    // inside a listbox are the menu's, never j/k movement.
    if (event.target instanceof Element && event.target.closest('[role="listbox"]')) return;
    if (event.key === "j" || event.key === "ArrowDown" || event.key === "k" || event.key === "ArrowUp") {
      event.preventDefault();
      const next = stepFeedSelection(items, selected, event.key === "j" || event.key === "ArrowDown" ? 1 : -1);
      setSelected(next);
      setRevealId(next);
      return;
    }
    const item = items.find((candidate) => candidate.itemId === selected);
    if (!item) return;
    const quick = item.signalId ? quickReplyForKey(mergedQuickReplies(quickReplies, item.suggestions), event.key) : null;
    if (quick !== null) {
      event.preventDefault();
      void sendQuick(item, quick);
    } else if (event.key === "Enter" || event.key === "o") {
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
  // Regions the feed can be narrowed to, with how many are waiting in each.
  // A pick whose region emptied out stays listed so it can be seen and cleared.
  const regionChoices = useMemo(() => {
    const choices = feed.sections.map((section) => ({
      regionId: section.region.regionId,
      label: section.region.label,
      count: needsOperatorCount(section.items),
    }));
    if (activeRegion && !choices.some((choice) => choice.regionId === activeRegion.regionId)) {
      choices.push({ regionId: activeRegion.regionId, label: activeRegion.label, count: 0 });
    }
    return choices;
  }, [feed.sections, activeRegion]);
  const regionOptions = useMemo(
    () => [
      { value: ALL_REGIONS, label: "All regions" },
      ...regionChoices.map((choice) => ({
        value: choice.regionId ?? OPEN_FIELD,
        label: `${choice.label} (${choice.count})`,
      })),
    ],
    [regionChoices],
  );
  const onRegionChange = (value: string): void => {
    if (value === ALL_REGIONS) {
      feedView$.region.set(undefined);
      return;
    }
    const regionId = value === OPEN_FIELD ? null : value;
    const choice = regionChoices.find((candidate) => candidate.regionId === regionId);
    feedView$.region.set({ canvasName, regionId, label: choice?.label ?? "" });
  };
  const regionName = activeRegion?.regionId === null ? "the open field" : (activeRegion?.label ?? "");
  const status = activeRegion
    ? feedStatusLine(feed, { label: regionName, count: needsOperatorCount(items) })
    : feedStatusLine(feed);
  const hasSignals = items.some((item) => item.signalId);

  return (
    <OperatorModalShell
      id="feed"
      label="Needs you feed"
      title={<span className="operator-feed__title">Needs you</span>}
      status={<span className="operator-feed__status">{status}</span>}
      headerProps={
        { className: "operator-feed__head", "data-scrolled": scrolled ? "true" : undefined } as HTMLAttributes<HTMLElement>
      }
      width={760}
      fill
      panelClassName="operator-feed__panel"
      onEscape={onEscape}
      onKeyDown={onKeyDown}
    >
      {feed.count > 0 || activeRegion !== undefined ? (
        <div className="operator-feed__controls">
          <span className="operator-feed__control-label" aria-hidden>
            Region
          </span>
          <Dropdown
            aria-label="Filter needs by region"
            value={activeRegion ? (activeRegion.regionId ?? OPEN_FIELD) : ALL_REGIONS}
            options={regionOptions}
            onChange={onRegionChange}
            triggerClassName="operator-feed__control"
          />
          <span className="operator-feed__controls-spread" aria-hidden />
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
      <div
        ref={scrollRef}
        className="operator-feed__scroll"
        data-testid="operator-feed"
        onScroll={(event) => setScrolled(event.currentTarget.scrollTop > 2)}
      >
        {sections.length === 0 ? (
          activeRegion !== undefined ? (
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
              <p className="operator-feed__empty-title">Nobody needs you right now</p>
              <p className="operator-feed__empty-copy">
                When an agent is blocked, asks for your input, or has work for you to review, it lands here.
              </p>
            </div>
          )
        ) : (
          sections.map((section) => (
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
                  replying={replyFor === item.itemId}
                  expanded={expanded.has(item.itemId)}
                  sending={sending.get(item.itemId) ?? null}
                  error={failure?.itemId === item.itemId ? failure.message : null}
                  onSelect={() => setSelected(item.itemId)}
                  onReply={(open) => setReplyFor(open ? item.itemId : null)}
                  onQuickReply={(text) => void sendQuick(item, text)}
                  onToggleDetail={() =>
                    setExpanded((current) => {
                      const next = new Set(current);
                      if (next.has(item.itemId)) next.delete(item.itemId);
                      else next.add(item.itemId);
                      return next;
                    })
                  }
                  onReviewCommit={(sha) =>
                    openCommitReview({
                      nodeId: item.seat.nodeId,
                      sha,
                      place: { itemId: item.itemId, expanded: [...expanded], scrollTop: scrollRef.current?.scrollTop ?? 0 },
                    })
                  }
                />
              ))}
            </FeedRegionSection>
          ))
        )}
      </div>
      {items.length > 0 ? (
        <footer className="operator-feed__keys" aria-hidden>
          <span><Kbd>j</Kbd><Kbd>k</Kbd> move</span>
          {hasSignals && quickReplies.length > 0 ? (
            <span>
              <Kbd>1</Kbd>
              {quickReplies.length > 1 ? <>–<Kbd>{Math.min(9, quickReplies.length)}</Kbd></> : null} quick reply
            </span>
          ) : null}
          {hasSignals ? <span><Kbd>↵</Kbd> write reply</span> : null}
          <span><Kbd>o</Kbd> open seat</span>
          <span><Kbd>esc</Kbd> close</span>
        </footer>
      ) : null}
    </OperatorModalShell>
  );
}
