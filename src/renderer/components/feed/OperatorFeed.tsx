/**
 * The operator feed: one scrolling surface of everything on the canvas that
 * wants the operator, grouped by region. A card is a seat and its need
 * (blocked, wants input, escalation, feedback, or an AI reading that it is
 * waiting on you); signals are answered inline or with one quick reply,
 * anything else opens the seat.
 *
 * The data is the shared projection (`@shared/operator-feed`), so this is one
 * rendering of a shape a mobile client can read as well.
 *
 * Keys while open: j / k move, 1..9 send that quick reply, Enter writes a
 * reply (or opens the seat), o opens the seat, Esc closes the reply first and
 * then the feed. ⌘I toggles it anywhere.
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { use$ } from "@legendapp/state/react";
import {
  ArrowBigUpDash,
  ArrowUpRight,
  ChevronDown,
  Inbox,
  MessageCircleQuestion,
  MessageSquareText,
  OctagonAlert,
  ScanEye,
  X,
  type LucideIcon,
} from "lucide-react";
import type { CanvasNode } from "@shared/canvas";
import type { FeedItem, FeedItemKind, FeedSection } from "@shared/operator-feed";
import { activateNodeSurface } from "../../lib/activate-node-surface";
import { mailAgeLabel } from "../../lib/actor-ledger";
import { dismissAgentSignal, respondToAgentSignal } from "../../lib/agent-signals-state";
import { SIGNALS_SECTION } from "../../lib/agent-signals-view";
import { isOperatorTyping } from "../../lib/focus-ownership";
import {
  closeOperatorFeed,
  feedItemsInOrder,
  feedStatusLine,
  operatorFeed$,
  reconcileSelection,
  stepFeedSelection,
  toggleOperatorFeed,
  useOperatorFeed,
  withLeavingItems,
} from "../../lib/operator-feed";
import { modKeyGlyph } from "../../lib/platform";
import { quickReplyForKey, useQuickReplies } from "../../lib/quick-replies";
import { requestSectionReveal } from "../../lib/sidebar-sections";
import { state$ } from "../../lib/state";
import { accentColor } from "../../lib/theme";
import { THREAD_HEALTH_STATUS_TONE } from "../../lib/thread-health";
import { AgentPortrait } from "../AgentPortrait";
import { FocusSurface } from "../FocusSurface";
import { SeatRing } from "../SeatRing";
import { QuickReplies } from "../signals/QuickReplies";
import { SignalReply } from "../signals/SignalReply";
import { Button, IconButton, Kbd, OverlayHeader, StatusDot } from "../ui";
import { ArtifactMarkdown } from "../work/ArtifactMarkdown";
import "./operator-feed.css";

const LEAVE_MS = 280;

/** How each need reads: a glyph on the portrait and a word in the meta line. */
const KIND: Readonly<Record<FeedItemKind, { readonly label: string; readonly icon: LucideIcon }>> = {
  blocked: { label: "blocked", icon: OctagonAlert },
  attention: { label: "wants input", icon: MessageCircleQuestion },
  escalate: { label: "escalation", icon: ArrowBigUpDash },
  feedback: { label: "feedback", icon: MessageSquareText },
  health: { label: "AI read", icon: ScanEye },
};

/** The region's own colour, or a quiet steel for the open field. */
const regionStyle = (color: string | undefined): CSSProperties =>
  ({ "--feed-region": color ? accentColor(color) : "var(--color-steel)" }) as CSSProperties;

const openSeat = (item: FeedItem, node: CanvasNode | undefined): void => {
  if (!node) return;
  closeOperatorFeed();
  if (item.signalId) requestSectionReveal(node.id, SIGNALS_SECTION);
  activateNodeSurface(node);
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
}: {
  readonly item: FeedItem;
  readonly node: CanvasNode | undefined;
  readonly nowMs: number;
  readonly quickReplies: ReadonlyArray<string>;
  readonly selected: boolean;
  /** Scroll into view when selected: keyboard moves do, a pointer press does not. */
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
}) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (selected && reveal) ref.current?.scrollIntoView({ block: "nearest" });
  }, [selected, reveal]);
  const kind = KIND[item.kind];
  const KindIcon = kind.icon;
  const age = mailAgeLabel(nowMs, item.since);
  const health = item.kind === "health" ? undefined : item.health;

  return (
    <div className={`operator-feed__slot${leaving ? " operator-feed__slot--leaving" : ""}`}>
      <article
        ref={ref}
        className={`operator-feed__card${selected ? " is-selected" : ""}`}
        data-testid="operator-feed-card"
        data-item-id={item.itemId}
        data-kind={item.kind}
        aria-current={selected ? "true" : undefined}
        aria-label={`${item.seat.name}, ${kind.label}`}
        // Select on click, not on press: selecting numbers the row's pills,
        // and a press that reshaped them would land its release elsewhere.
        onClick={onSelect}
      >
        <div className="operator-feed__portrait">
          {node ? (
            <SeatRing node={node} px={46} />
          ) : (
            <AgentPortrait identity={item.seat.portraitIdentity} size={36} frame="round" outline={false} />
          )}
          <span className="operator-feed__kind-mark" aria-hidden>
            <KindIcon size={11} strokeWidth={2.25} />
          </span>
        </div>
        <div className="operator-feed__body">
          <header className="operator-feed__card-head">
            <span className="operator-feed__name">{item.seat.name}</span>
            <span className="operator-feed__kind">{kind.label}</span>
            {age ? (
              <time className="operator-feed__age" title={new Date(item.since).toLocaleString()}>
                {age}
              </time>
            ) : null}
          </header>
          <p className="operator-feed__text">{item.text}</p>
          {health ? (
            <p className="operator-feed__health" title="Jev's reading of the screen, not the agent's own claim">
              <StatusDot tone={THREAD_HEALTH_STATUS_TONE[health.tone]} />
              AI reads {health.label}
              {health.stale ? <span className="operator-feed__faint">, last observed</span> : null}
            </p>
          ) : null}
          {item.detail ? (
            <button
              type="button"
              className="operator-feed__detail-toggle"
              aria-expanded={expanded}
              onClick={onToggleDetail}
            >
              <ChevronDown size={12} className={expanded ? "operator-feed__chevron--open" : undefined} aria-hidden />
              {expanded ? "Hide details" : "Details"}
            </button>
          ) : null}
          {item.detail && expanded ? (
            <div className="operator-feed__detail">
              <ArtifactMarkdown source={item.detail} />
            </div>
          ) : null}
          {replying && item.signalId ? (
            <SignalReply
              signalId={item.signalId}
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
                  pending={sending}
                  numbered={selected}
                  onPick={onQuickReply}
                  className="operator-feed__quick"
                />
              ) : null}
              <span className="operator-feed__actions-end">
                {item.signalId ? (
                  <Button size="xs" variant="subtle" onClick={() => onReply(true)}>
                    Write reply
                  </Button>
                ) : null}
                <Button size="xs" variant="subtle" disabled={!node} onClick={() => openSeat(item, node)}>
                  Open seat
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
  readonly section: FeedSection & { readonly leavingIds: ReadonlySet<string> };
  readonly children: ReactNode;
}) {
  const live = section.items.length - section.leavingIds.size;
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
        <span className="operator-feed__region-count">{live}</span>
      </header>
      <div className="operator-feed__list">{children}</div>
    </section>
  );
}

function OperatorFeedSurface() {
  const feed = useOperatorFeed();
  const quickReplies = useQuickReplies();
  const doc = use$(state$.doc);
  const nodesById = useMemo(() => new Map(doc.nodes.map((node) => [node.id, node] as const)), [doc]);
  const nodesByIdRef = useRef(nodesById);
  nodesByIdRef.current = nodesById;
  const [selected, setSelected] = useState<string | null>(null);
  // A press selects what is already under the pointer; scrolling it would
  // move the row out from under the click.
  const [reveal, setReveal] = useState(true);
  const [replyFor, setReplyFor] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  // Quick replies in flight, by item: one per card, cards independent.
  const [sending, setSending] = useState<ReadonlyMap<string, string>>(() => new Map());
  const sendingRef = useRef(sending);
  sendingRef.current = sending;
  const [failure, setFailure] = useState<{ readonly itemId: string; readonly message: string } | null>(null);
  const [scrolled, setScrolled] = useState(false);

  // Answered or dismissed items fade out in place before they leave.
  const [ghost, setGhost] = useState<{ readonly previous: ReadonlyArray<FeedSection>; readonly ids: ReadonlySet<string> }>(
    () => ({ previous: [], ids: new Set() }),
  );
  const previousSections = useRef(feed.sections);
  const leaveTimers = useRef(new Set<number>());
  useEffect(() => {
    const before = previousSections.current;
    previousSections.current = feed.sections;
    const now = new Set(feedItemsInOrder(feed.sections).map((item) => item.itemId));
    const gone = feedItemsInOrder(before).filter((item) => !now.has(item.itemId)).map((item) => item.itemId);
    if (gone.length === 0) return;
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
    if (reduced) return;
    setGhost((current) => ({ previous: before, ids: new Set([...current.ids, ...gone]) }));
    // Not cleared by the next feed change: the feed re-renders often, and a
    // ghost whose timer was dropped would never leave.
    const timer = window.setTimeout(() => {
      leaveTimers.current.delete(timer);
      setGhost((current) => {
        const ids = new Set(current.ids);
        for (const id of gone) ids.delete(id);
        return { previous: current.previous, ids };
      });
    }, LEAVE_MS);
    leaveTimers.current.add(timer);
  }, [feed.sections]);
  useEffect(() => {
    const timers = leaveTimers.current;
    return () => {
      for (const timer of timers) window.clearTimeout(timer);
    };
  }, []);
  const sections = useMemo(
    () => withLeavingItems(ghost.previous, feed.sections, ghost.ids),
    [ghost, feed.sections],
  );

  const items = useMemo(() => feedItemsInOrder(feed.sections), [feed.sections]);
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
  const sendQuickRef = useRef(sendQuick);
  sendQuickRef.current = sendQuick;
  const stateRef = useRef({ selected, replyFor, quickReplies });
  stateRef.current = { selected, replyFor, quickReplies };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const { selected: current, replyFor: reply, quickReplies: replies } = stateRef.current;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (reply !== null) setReplyFor(null);
        else closeOperatorFeed();
        return;
      }
      if (isOperatorTyping(event.target) || event.metaKey || event.ctrlKey || event.altKey) return;
      const list = itemsRef.current;
      if (event.key === "j" || event.key === "ArrowDown") {
        event.preventDefault();
        setReveal(true);
        setSelected(stepFeedSelection(list, current, 1));
        return;
      }
      if (event.key === "k" || event.key === "ArrowUp") {
        event.preventDefault();
        setReveal(true);
        setSelected(stepFeedSelection(list, current, -1));
        return;
      }
      const item = list.find((candidate) => candidate.itemId === current);
      if (!item) return;
      const quick = item.signalId ? quickReplyForKey(replies, event.key) : null;
      if (quick !== null) {
        event.preventDefault();
        void sendQuickRef.current(item, quick);
      } else if (event.key === "Enter" || event.key === "o") {
        event.preventDefault();
        if (event.key === "Enter" && item.signalId) setReplyFor(item.itemId);
        else openSeat(item, nodesByIdRef.current.get(item.seat.nodeId));
      }
    };
    // focus-law: asks isOperatorTyping; Escape alone acts while typing, to close the reply.
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, []);
  const status = feedStatusLine(feed);
  const hasSignals = items.some((item) => item.signalId);

  return (
    <FocusSurface
      measure="document"
      height="immersive"
      layer="detail"
      label="Needs you feed"
      onClose={closeOperatorFeed}
      closeOnEscape={false}
      panelClassName="operator-feed__panel"
    >
      <OverlayHeader
        className="operator-feed__head"
        data-scrolled={scrolled ? "true" : undefined}
        title={<span className="operator-feed__title">Needs you</span>}
        status={<span className="operator-feed__status">{status}</span>}
        actions={
          <IconButton aria-label="Close feed" title={`Close (Esc, ${modKeyGlyph()}I)`} onClick={closeOperatorFeed}>
            <X size={15} strokeWidth={1.75} />
          </IconButton>
        }
      />
      <div
        className="operator-feed__scroll"
        data-testid="operator-feed"
        onScroll={(event) => setScrolled(event.currentTarget.scrollTop > 2)}
      >
        {sections.length === 0 ? (
          <div className="operator-feed__empty" role="status">
            <span className="operator-feed__empty-mark" aria-hidden>
              <Inbox size={22} strokeWidth={1.4} />
            </span>
            <p className="operator-feed__empty-title">Nobody needs you right now</p>
            <p className="operator-feed__empty-copy">
              When an agent is blocked, asks for your input, or has work for you to review, it lands here.
            </p>
          </div>
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
                  reveal={reveal}
                  leaving={section.leavingIds.has(item.itemId)}
                  replying={replyFor === item.itemId}
                  expanded={expanded.has(item.itemId)}
                  sending={sending.get(item.itemId) ?? null}
                  error={failure?.itemId === item.itemId ? failure.message : null}
                  onSelect={() => {
                    setReveal(false);
                    setSelected(item.itemId);
                  }}
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
    </FocusSurface>
  );
}

/** Always mounted: owns the ⌘I hotkey and renders the feed while open. */
export function OperatorFeedHost() {
  const open = use$(operatorFeed$.open);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
      if (event.key.toLowerCase() !== "i") return;
      event.preventDefault();
      toggleOperatorFeed();
    };
    // focus-law: a modifier chord that only opens or closes the feed; it types nothing.
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
  return open ? <OperatorFeedSurface /> : null;
}

/** Top bar entry: an inbox with the live count, crimson while anyone is blocked. */
export function OperatorFeedTrigger() {
  const feed = useOperatorFeed();
  const open = use$(operatorFeed$.open);
  const blocked = feed.sections.some((section) => section.items.some((item) => item.kind === "blocked"));
  const label = feed.count === 0 ? "Open needs-you feed, nothing waiting" : `Open needs-you feed, ${feed.count} waiting`;
  return (
    <button
      type="button"
      className="station-icon-button operator-feed-trigger"
      data-testid="operator-feed-trigger"
      aria-label={label}
      aria-pressed={open}
      title={`Needs you (${modKeyGlyph()}I)`}
      style={{ borderColor: "var(--color-stroke)", color: feed.count > 0 ? "var(--color-amber)" : "var(--color-steel)" }}
      onClick={toggleOperatorFeed}
    >
      <Inbox size={15} />
      {feed.count > 0 ? (
        <span className={`operator-feed-trigger__count${blocked ? " operator-feed-trigger__count--blocked" : ""}`} aria-hidden>
          {feed.count > 99 ? "99+" : feed.count}
        </span>
      ) : null}
    </button>
  );
}
