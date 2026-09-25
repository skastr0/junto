/**
 * The operator feed: one scrolling surface of everything on the canvas that
 * wants the operator, grouped by region. A card is a seat and its need
 * (blocked, wants input, escalation, feedback, or an AI reading that it is
 * waiting on you); signals are answered inline, anything else opens the seat.
 *
 * The data is the shared projection (`@shared/operator-feed`), so this is one
 * rendering of a shape a mobile client can read as well.
 *
 * Keys while open: j / k move, Enter replies (or opens the seat), o opens the
 * seat, Esc closes the reply first and then the feed. ⌘I toggles it anywhere.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { use$ } from "@legendapp/state/react";
import { ArrowUpRight, ChevronDown, Inbox, X } from "lucide-react";
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
  stepFeedSelection,
  toggleOperatorFeed,
  useOperatorFeed,
  withLeavingItems,
} from "../../lib/operator-feed";
import { modKeyGlyph } from "../../lib/platform";
import { requestSectionReveal } from "../../lib/sidebar-sections";
import { state$ } from "../../lib/state";
import { THREAD_HEALTH_STATUS_TONE } from "../../lib/thread-health";
import { AgentPortrait } from "../AgentPortrait";
import { FocusSurface } from "../FocusSurface";
import { SeatRing } from "../SeatRing";
import { SignalReply } from "../signals/SignalReply";
import { Button, Chip, IconButton, Kbd, OverlayHeader, StatusDot, type ChipTone } from "../ui";
import { ArtifactMarkdown } from "../work/ArtifactMarkdown";
import "./operator-feed.css";

const LEAVE_MS = 320;

const KIND_CHIP: Readonly<Record<FeedItemKind, { readonly tone: ChipTone; readonly label: string }>> = {
  blocked: { tone: "crimson", label: "blocked" },
  attention: { tone: "amber", label: "wants input" },
  escalate: { tone: "amber", label: "escalation" },
  feedback: { tone: "cyan", label: "feedback" },
  health: { tone: "steel", label: "AI read" },
};

const openSeat = (item: FeedItem, node: CanvasNode | undefined): void => {
  if (!node) return;
  closeOperatorFeed();
  if (item.signalId) requestSectionReveal(node.id, SIGNALS_SECTION);
  activateNodeSurface(node);
};

function FeedCard({
  item,
  node,
  nowMs,
  selected,
  leaving,
  replying,
  expanded,
  onSelect,
  onReply,
  onToggleDetail,
}: {
  readonly item: FeedItem;
  readonly node: CanvasNode | undefined;
  readonly nowMs: number;
  readonly selected: boolean;
  readonly leaving: boolean;
  readonly replying: boolean;
  readonly expanded: boolean;
  readonly onSelect: () => void;
  readonly onReply: (open: boolean) => void;
  readonly onToggleDetail: () => void;
}) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: "nearest" });
  }, [selected]);
  const chip = KIND_CHIP[item.kind];
  const age = mailAgeLabel(nowMs, item.since);
  const health = item.kind === "health" ? undefined : item.health;

  return (
    <div className={`operator-feed__slot${leaving ? " operator-feed__slot--leaving" : ""}`}>
      <article
        ref={ref}
        className={`operator-feed__card operator-feed__card--${item.kind}${selected ? " is-selected" : ""}`}
        data-testid="operator-feed-card"
        data-item-id={item.itemId}
        data-kind={item.kind}
        aria-current={selected ? "true" : undefined}
        onPointerDown={onSelect}
      >
        <div className="operator-feed__portrait">
          {node ? (
            <SeatRing node={node} px={52} />
          ) : (
            <AgentPortrait identity={item.seat.portraitIdentity} size={40} frame="round" outline={false} />
          )}
        </div>
        <div className="operator-feed__body">
          <header className="operator-feed__card-head">
            <span className="operator-feed__name">{item.seat.name}</span>
            <Chip tone={chip.tone}>{chip.label}</Chip>
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
              {item.detail ? (
                <Button size="xs" variant="chrome" aria-expanded={expanded} onClick={onToggleDetail}>
                  <ChevronDown size={12} className={expanded ? "operator-feed__chevron--open" : undefined} />
                  {expanded ? "less" : "details"}
                </Button>
              ) : null}
              {item.signalId ? (
                <Button size="xs" variant="primary" onClick={() => onReply(true)}>
                  Reply
                </Button>
              ) : null}
              <Button
                size="xs"
                variant={item.signalId ? "subtle" : "primary"}
                disabled={!node}
                onClick={() => openSeat(item, node)}
              >
                <ArrowUpRight size={12} />
                Open seat
              </Button>
            </div>
          )}
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
    <section className="operator-feed__region" aria-label={`${section.region.label}, ${live} waiting`}>
      <header className="operator-feed__region-head">
        <span className="operator-feed__region-label">{section.region.label}</span>
        {outer.length > 0 ? <span className="operator-feed__region-path">in {outer.join(" / ")}</span> : null}
        <span className="operator-feed__region-count">{live}</span>
      </header>
      <div className="operator-feed__list">{children}</div>
    </section>
  );
}

function OperatorFeedSurface() {
  const feed = useOperatorFeed();
  const doc = use$(state$.doc);
  const nodesById = useMemo(() => new Map(doc.nodes.map((node) => [node.id, node] as const)), [doc]);
  const nodesByIdRef = useRef(nodesById);
  nodesByIdRef.current = nodesById;
  const [selected, setSelected] = useState<string | null>(null);
  const [replyFor, setReplyFor] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());

  // Answered or dismissed items fade out in place before they leave.
  const [ghost, setGhost] = useState<{ readonly previous: ReadonlyArray<FeedSection>; readonly ids: ReadonlySet<string> }>(
    () => ({ previous: [], ids: new Set() }),
  );
  const previousSections = useRef(feed.sections);
  useEffect(() => {
    const before = previousSections.current;
    previousSections.current = feed.sections;
    const now = new Set(feedItemsInOrder(feed.sections).map((item) => item.itemId));
    const gone = feedItemsInOrder(before).filter((item) => !now.has(item.itemId)).map((item) => item.itemId);
    if (gone.length === 0) return;
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
    if (reduced) return;
    setGhost((current) => ({ previous: before, ids: new Set([...current.ids, ...gone]) }));
    const timer = window.setTimeout(() => {
      setGhost((current) => {
        const ids = new Set(current.ids);
        for (const id of gone) ids.delete(id);
        return { previous: current.previous, ids };
      });
    }, LEAVE_MS);
    return () => window.clearTimeout(timer);
  }, [feed.sections]);
  const sections = useMemo(
    () => withLeavingItems(ghost.previous, feed.sections, ghost.ids),
    [ghost, feed.sections],
  );

  const items = feedItemsInOrder(feed.sections);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const stateRef = useRef({ selected, replyFor });
  stateRef.current = { selected, replyFor };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const { selected: current, replyFor: reply } = stateRef.current;
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
        setSelected(stepFeedSelection(list, current, 1));
      } else if (event.key === "k" || event.key === "ArrowUp") {
        event.preventDefault();
        setSelected(stepFeedSelection(list, current, -1));
      } else if (event.key === "Enter" || event.key === "o") {
        const item = list.find((candidate) => candidate.itemId === current);
        if (!item) return;
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
        eyebrow="needs you"
        title="Feed"
        status={status}
        actions={
          <>
            <span className="operator-feed__keys" aria-hidden>
              <Kbd>j</Kbd>
              <Kbd>k</Kbd>
              <Kbd>↵</Kbd>
            </span>
            <IconButton aria-label="Close feed" title={`Close (Esc, ${modKeyGlyph()}I)`} onClick={closeOperatorFeed}>
              <X size={15} strokeWidth={1.75} />
            </IconButton>
          </>
        }
      />
      <div className="operator-feed__scroll" data-testid="operator-feed">
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
                  selected={selected === item.itemId}
                  leaving={section.leavingIds.has(item.itemId)}
                  replying={replyFor === item.itemId}
                  expanded={expanded.has(item.itemId)}
                  onSelect={() => setSelected(item.itemId)}
                  onReply={(open) => setReplyFor(open ? item.itemId : null)}
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
