/**
 * Threads: the operator's threads across every seat, the needs-you feed's
 * sibling. The same shell, region strip, Order control, search, seat row and
 * Clear; one Unread chip where the feed has its kinds. The list is flat (each
 * row carries its seat and region), newest first or most urgent seat first;
 * the one thread chat takes the right.
 *
 * The rows come from the operator threads store (over the core's read),
 * which narrows by region, words, unread and seat, pages, and counts:
 * `ThreadsBody` takes its state and draws it, so it knows nothing of where
 * the rows come from. A thread on screen is read; one not shown is not.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type HTMLAttributes,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { use$ } from "@legendapp/state/react";
import { Check, Clock, Plus } from "lucide-react";
import { titleOf, type Node } from "@shared/model";
import type { FeedRegion } from "@shared/operator-feed";
import { regionChipStyle } from "../../lib/region-chip-style";
import { claimFocus, focusPrimaryControl } from "../../lib/focus-ownership";
import { useListNav } from "../../lib/list-nav";
import { regionPickKey, regionPickName } from "../../lib/operator-feed";
import { previewText, waitingForSeats } from "../../lib/seat-threads";
import { ThreadTime } from "../threads/ThreadTime";
import { provideThreadKey } from "../../lib/thread-keys";
import { threadHeadline } from "../../lib/thread-text";
import type { OperatorThreadsState } from "../../lib/operator-threads";
import {
  THREADS_ORDER_OPTIONS,
  clearThreadsFilters,
  lastIsMine,
  reconcileThreadSelection,
  threadRegionChips,
  threadSeatChips,
  threadsFilterOn,
  threadsStatusLine,
  threadsView$,
  toggleThreadsSeat,
  type ThreadRow,
  type ThreadsOrder,
} from "../../lib/threads-view";
import { AgentPortrait } from "../AgentPortrait";
import { SeatRingView, useSeatGlanceOf } from "../SeatRing";
import { OperatorModalShell } from "../operator-modal/OperatorModalShell";
import { Button, Dropdown } from "../ui";
import { FeedRegionStrip } from "./FeedRegionStrip";
import { FeedEmpty, FeedSeatChosen, FeedSeatsRow, FeedSeatsToggle } from "./FeedFilterParts";
import "./operator-feed.css";
import "../threads/seat-threads.css";
import "./threads-modal.css";

/** How far from the list's end, in pixels, the next page is asked for. */
const LIST_NEAR_END = 400;
const SEATS_ROW_ID = "operator-threads-seats";

/** A seat's live ring: its own component so only its row follows the seat. */
function LiveRing({ seat }: { readonly seat: Node & { readonly kind: "agent" } }) {
  return <SeatRingView node={seat} px={32} glance={useSeatGlanceOf(seat)} />;
}

/** The seat's face on a row: its live ring on this canvas, else its portrait. */
function RowFace({ row, node }: { readonly row: ThreadRow; readonly node: Node | undefined }) {
  return node?.kind === "agent" ? (
    <LiveRing seat={node} />
  ) : (
    <AgentPortrait identity={row.seat.portraitIdentity} size={28} frame="round" badge={false} outline={false} />
  );
}

/** The thread's line as the eye reads it: its words, a long id as its token. */
function Line({ text, known }: { readonly text: string; readonly known: ReadonlyArray<string> }) {
  return (
    <>
      {threadHeadline(previewText(text), known).map((segment, index) =>
        segment.id === undefined ? (
          segment.text
        ) : (
          <span key={`${segment.id}-${String(index)}`} className="seat-threads__id">
            {segment.id}
          </span>
        ),
      )}
    </>
  );
}

/** A seat's region as text: the region chip's dot and its name, no chip box. */
function RegionMark({ region }: { readonly region: FeedRegion }) {
  const open = region.path.length === 0;
  return (
    <span
      className="operator-threads__region"
      data-open-field={open ? "true" : undefined}
      style={regionChipStyle({ open, color: region.color })}
      title={region.path.length > 1 ? region.path.join(" > ") : region.label}
    >
      <span className="feed-region-chip__swatch" aria-hidden />
      <span className="operator-threads__region-name">{region.label}</span>
    </span>
  );
}

/** A row: one button of three lines, the seat and its region, the thread's line, its last mail. */
function ThreadListRow({
  row,
  node,
  selected,
  tabStop,
  nav,
  onSelect,
}: {
  readonly row: ThreadRow;
  readonly node: Node | undefined;
  readonly selected: boolean;
  /** The list's one Tab stop: the selected row, or the first when none is. */
  readonly tabStop: boolean;
  readonly nav: Record<string, string>;
  readonly onSelect: () => void;
}) {
  const unread = row.unread > 0;
  const mine = lastIsMine(row);
  return (
    <li>
      <button
        type="button"
        className="seat-threads__row operator-threads__row"
        data-testid="operator-threads-row"
        data-selected={selected ? "true" : undefined}
        data-unread={unread ? "true" : undefined}
        data-seat={row.seat.nodeId}
        data-thread={row.threadId}
        aria-current={selected ? "true" : undefined}
        tabIndex={tabStop ? 0 : -1}
        onClick={onSelect}
        {...nav}
      >
        <span className="operator-threads__row-top">
          <span className="operator-threads__face" aria-hidden>
            <RowFace row={row} node={node} />
          </span>
          <span className="operator-threads__seat">{row.seat.name}</span>
          <RegionMark region={row.region} />
          {unread ? (
            <>
              <span className="seat-threads__row-unread" data-testid="operator-threads-row-unread" aria-hidden>
                {row.unread > 99 ? "99+" : row.unread}
              </span>
              <span className="sr-only">{row.unread > 99 ? "more than 99 unread" : `${String(row.unread)} unread`}</span>
            </>
          ) : null}
          <ThreadTime className="seat-threads__row-time operator-threads__time" at={row.lastAt} />
        </span>
        <span className="operator-threads__line">
          <Line text={row.title} known={[row.seat.name]} />
        </span>
        <span className="operator-threads__last">
          {/* The operator's own last mail, not yet with its seat. */}
          {mine && row.last.waiting === true ? (
            <>
              <span className="operator-threads__waiting" title={waitingForSeats([row.seat.name])} data-testid="operator-threads-row-waiting">
                <Clock size={11} strokeWidth={2} aria-hidden />
              </span>
              <span className="sr-only">{waitingForSeats([row.seat.name])} </span>
            </>
          ) : null}
          {mine ? "You: " : null}
          <Line text={row.last.text} known={[row.seat.name]} />
        </span>
      </button>
    </li>
  );
}

export function ThreadsBody({
  canvasName,
  read,
  all,
  nodesById,
  chat,
  quickThread,
  onOpenSeat,
  onLoadMore,
}: {
  readonly canvasName: string;
  /** The store's rows and counts under the filter the view asks for. */
  readonly read: OperatorThreadsState;
  /** The next page, asked as the list nears its end. */
  readonly onLoadMore: () => void;
  /** Every thread on the canvas and those with unread mail, for "5 of 24". */
  readonly all: { readonly total: number; readonly unread: number };
  readonly nodesById: ReadonlyMap<string, Node>;
  /**
   * The one thread chat for the picked row. It marks its thread read while it
   * is on screen; `yields` is asked as its reply field mounts, true leaving
   * the keyboard in the list.
   */
  readonly chat: (row: ThreadRow, yields: () => boolean) => ReactNode;
  /**
   * Quick thread: New thread and the threads.quick key open it in the right
   * pane. `done` takes the first new thread, to show it selected; `backOut`
   * is asked first on Escape.
   */
  readonly quickThread?: (
    done: (first?: { readonly seatId: string; readonly threadId: string }) => void,
    backOut: RefObject<(() => boolean) | null>,
  ) => ReactNode;
  /** Opens the seat on its Threads view. */
  readonly onOpenSeat?: (seatId: string, threadId: string) => void;
}) {
  const regionPick = use$(threadsView$.region);
  const order = use$(threadsView$.order);
  const query = use$(threadsView$.query);
  const unreadOnly = use$(threadsView$.unread);
  const seatId = use$(threadsView$.seat);
  const seatsOpen = use$(threadsView$.seatsOpen);
  const activeRegion = regionPick?.canvasName === canvasName ? regionPick : undefined;
  const filtering = threadsFilterOn({ query, unread: unreadOnly, seat: seatId });

  const rows = read.rows;
  // One row per thread: its id is its key.
  const keys = useMemo(() => rows.map((row) => row.threadId), [rows]);
  const regionChips = useMemo(() => threadRegionChips(read.regions, activeRegion?.path), [read.regions, activeRegion]);
  const seatChips = useMemo(() => threadSeatChips(read.seatCounts), [read.seatCounts]);
  const seatsToggleShown = seatChips.length >= 2 || seatId !== undefined;
  const activeSeat =
    seatId === undefined
      ? undefined
      : (seatChips.find((chip) => chip.seatId === seatId) ?? {
          seatId,
          name: ((node) => (node ? titleOf(node) : "that seat"))(nodesById.get(seatId)),
          count: 0,
          regionLabel: "",
          regionPath: [],
          open: true,
          color: undefined,
        });

  // Selection: a row key, or the Quick thread pane. A row that leaves hands
  // the pick to its neighbour; nothing picked takes the first.
  const [picked, setPicked] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  // A thread just started from Quick thread: selected as soon as the list has it.
  const [landing, setLanding] = useState<string | null>(null);
  const landed = landing !== null && keys.includes(landing);
  const previous = useRef<ReadonlyArray<string>>(keys);
  const selected = composing
    ? null
    : landing !== null
      ? landing
      : reconcileThreadSelection(previous.current, keys, picked);
  useEffect(() => {
    previous.current = keys;
    if (landed) {
      setLanding(null);
      setPicked(landing);
      return;
    }
    if (!composing && landing === null && selected !== picked) setPicked(selected);
  }, [keys, selected, picked, composing, landing, landed]);
  const selectedRow = selected === null ? undefined : rows.find((row) => row.threadId === selected);

  // A thread on screen is read: the chat marks it while it shows (ThreadChat).
  // One behind the Quick thread pane, or not picked, has no chat mounted and
  // stays unread.

  // The next page when the list nears its end, or when what is read does not
  // fill the column and so cannot be scrolled. After a failure only the
  // reader's next scroll asks again.
  const listRef = useRef<HTMLUListElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fill = (retry: boolean): void => {
    const list = scrollRef.current;
    if (!list || list.clientHeight === 0 || !read.hasMore || read.loadingMore === true || (read.error !== "" && !retry)) return;
    if (list.scrollHeight - list.scrollTop - list.clientHeight < LIST_NEAR_END) onLoadMore();
  };
  const fillNow = useRef(fill);
  fillNow.current = fill;
  useEffect(() => fillNow.current(false), [rows, read.hasMore, read.loadingMore, read.error]);
  useEffect(() => {
    const list = scrollRef.current;
    if (!list || typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(() => fillNow.current(false));
    observer.observe(list);
    return () => observer.disconnect();
  }, []);
  const [scrolled, setScrolled] = useState(false);

  const chatRef = useRef<HTMLDivElement>(null);
  // The reply field takes the keyboard only when the thread was opened with
  // Enter: a row picked by pointer or by the arrows leaves it in the list.
  const replyWanted = useRef(false);
  const chatYields = useCallback((): boolean => !replyWanted.current, []);
  const select = (key: string): void => {
    setComposing(false);
    setLanding(null);
    setPicked(key);
  };
  const nav = useListNav({
    ids: keys,
    selected,
    onSelect: select,
    // Enter opens the thread on the right with the keyboard in its reply.
    onOpen: (key) => {
      replyWanted.current = true;
      select(key);
      requestAnimationFrame(() => {
        replyWanted.current = false;
        focusPrimaryControl(chatRef.current);
      });
    },
  });

  const searchRef = useRef<HTMLInputElement>(null);
  const seatsToggleRef = useRef<HTMLButtonElement>(null);
  const clearAll = (event: ReactMouseEvent<HTMLButtonElement>): void => {
    clearThreadsFilters();
    claimFocus(searchRef.current, "gesture", { event });
  };
  const quickBackOut = useRef<(() => boolean) | null>(null);
  const onEscape = (): boolean => {
    // The innermost layer first: Quick thread's seat picker, then Quick
    // thread itself (its draft is kept), back to the list on New thread.
    if (composing) {
      if (quickBackOut.current?.() !== true) {
        setComposing(false);
        claimFocus(scrollRef.current?.querySelector<HTMLElement>('[data-testid="operator-threads-new"]') ?? null, "gesture");
      }
      return true;
    }
    if (seatsOpen) {
      threadsView$.seatsOpen.set(false);
      claimFocus(seatsToggleRef.current, "gesture");
      return true;
    }
    return false;
  };

  const status = threadsStatusLine({
    total: all.total,
    unread: all.unread,
    shown: read.total,
    ...(activeRegion === undefined ? {} : { region: activeRegion.path }),
    filtering,
  });
  const openQuick = (): void => {
    setLanding(null);
    setComposing(true);
  };
  const quickDone = (first?: { readonly seatId: string; readonly threadId: string }): void => {
    setComposing(false);
    if (first) setLanding(first.threadId);
  };
  // Cmd+Shift+U while Threads is open starts the thread here, with the
  // keyboard in Quick thread's seat field; the canvas-wide one waits behind.
  const quickKey = useRef<() => void>(() => undefined);
  quickKey.current = () => {
    openQuick();
    requestAnimationFrame(() => focusPrimaryControl(chatRef.current));
  };
  const hasQuick = quickThread !== undefined;
  useEffect(() => (hasQuick ? provideThreadKey("threads.quick", () => quickKey.current()) : undefined), [hasQuick]);
  // Said on every narrowing, a region pick too, and once when the last is cleared.
  const narrowed = filtering || activeRegion !== undefined;
  const everNarrowed = useRef(false);
  if (narrowed) everNarrowed.current = true;
  const announce = narrowed
    ? `${String(read.total)} of ${String(all.total)} shown${activeRegion === undefined ? "" : ` in ${regionPickName(activeRegion.path)}`}${filtering ? " with these filters" : ""}`
    : everNarrowed.current
      ? "Every thread shown"
      : "";
  const nothingYet = read.loaded && all.total === 0 && !filtering && activeRegion === undefined;

  return (
    <OperatorModalShell
      id="threads"
      label="Threads"
      title={<span className="operator-feed__title">Threads</span>}
      status={<span className="operator-feed__status">{status}</span>}
      headerProps={
        { className: "operator-feed__head", "data-scrolled": scrolled ? "true" : undefined } as HTMLAttributes<HTMLElement>
      }
      width={1180}
      fill
      panelClassName="operator-feed__panel operator-threads"
      onEscape={onEscape}
    >
      <div className="operator-feed__controls">
        <FeedRegionStrip
          chips={regionChips}
          chosen={activeRegion ? regionPickKey(activeRegion.path) : undefined}
          total={all.unread}
          label="Filter threads by region"
          countWord="unread"
          onPick={(chip) => threadsView$.region.set(chip ? { canvasName, path: chip.path } : undefined)}
        />
        <span className="operator-feed__control-label" aria-hidden>
          Order
        </span>
        <Dropdown
          aria-label="Order threads"
          value={order}
          options={THREADS_ORDER_OPTIONS}
          onChange={(value) => threadsView$.order.set(value as ThreadsOrder)}
          triggerClassName="operator-feed__control"
        />
      </div>
      <div className="operator-feed__filter-bar" data-testid="threads-filter-bar">
        <input
          ref={searchRef}
          className="operator-feed__search"
          type="search"
          placeholder="Search threads"
          aria-label="Search threads"
          value={query}
          onChange={(event) => threadsView$.query.set(event.target.value)}
        />
        <div className="operator-feed__chips">
          <button
            type="button"
            className="operator-feed__filter-chip"
            data-testid="threads-unread-chip"
            aria-pressed={unreadOnly}
            aria-label={`Unread, ${String(read.unread)}`}
            onClick={() => threadsView$.unread.set(!unreadOnly)}
          >
            {unreadOnly ? <Check size={11} strokeWidth={2} aria-hidden /> : null}
            Unread
            <span className="operator-feed__filter-count" aria-hidden>
              {read.unread}
            </span>
          </button>
        </div>
        {seatsToggleShown ? (
          <FeedSeatsToggle
            ref={seatsToggleRef}
            count={seatChips.length}
            open={seatsOpen}
            controls={SEATS_ROW_ID}
            onToggle={() => threadsView$.seatsOpen.set(!seatsOpen)}
          />
        ) : null}
        {activeSeat === undefined ? null : <FeedSeatChosen seat={activeSeat} onClear={() => threadsView$.seat.set(undefined)} />}
        {filtering || activeRegion !== undefined ? (
          <Button size="sm" variant="subtle" data-testid="threads-clear-filters" onClick={clearAll}>
            Clear
          </Button>
        ) : null}
        {seatsToggleShown ? (
          <FeedSeatsRow
            id={SEATS_ROW_ID}
            chips={seatChips}
            chosen={seatId}
            open={seatsOpen}
            countWord={(count) => (count === 1 ? "thread" : "threads")}
            onPick={toggleThreadsSeat}
          />
        ) : null}
      </div>
      {/* Mounted for the modal's life: a live region added with its text says nothing. */}
      <span className="operator-feed__announce" role="status" aria-live="polite">
        {announce}
      </span>
      {nothingYet && !composing ? (
        <div className="operator-feed__scroll" data-testid="operator-threads">
          <FeedEmpty
            title="No threads yet"
            copy="Start one and it lands here."
            action={
              quickThread ? (
                <Button size="sm" variant="subtle" onClick={openQuick}>
                  Quick thread
                </Button>
              ) : undefined
            }
          />
        </div>
      ) : (
        <div className="operator-feed__split">
          <div
            ref={scrollRef}
            className="operator-feed__scroll operator-threads__scroll"
            data-testid="operator-threads"
            onScroll={(event) => {
              setScrolled(event.currentTarget.scrollTop > 2);
              fill(true);
            }}
          >
            {quickThread ? (
              <Button
                size="sm"
                variant="chrome"
                className="seat-threads__new operator-threads__new"
                data-selected={composing ? "true" : undefined}
                aria-current={composing ? "true" : undefined}
                data-testid="operator-threads-new"
                onClick={openQuick}
              >
                <Plus size={13} strokeWidth={1.8} aria-hidden /> New thread
              </Button>
            ) : null}
            {read.error ? (
              <p className="seat-threads__note seat-threads__note--error" role="alert">
                {read.error}
              </p>
            ) : null}
            {read.loaded && rows.length === 0 && !read.error ? (
              <FeedEmpty
                testId="threads-no-matches"
                status={false}
                title="Nothing matches these filters"
                copy="Clear the search or the chips to see every thread."
                action={
                  <Button size="sm" variant="subtle" onClick={clearAll}>
                    Clear
                  </Button>
                }
              />
            ) : null}
            {!read.loaded && !read.error ? <p className="seat-threads__note">Reading threads…</p> : null}
            <ul ref={listRef} className="operator-threads__list" aria-label="Threads" onKeyDown={nav.onKeyDown}>
              {rows.map((row) => (
                <ThreadListRow
                  key={row.threadId}
                  row={row}
                  node={nodesById.get(row.seat.nodeId)}
                  selected={row.threadId === selected}
                  tabStop={row.threadId === (selected !== null && keys.includes(selected) ? selected : keys[0])}
                  nav={nav.rowProps(row.threadId)}
                  onSelect={() => select(row.threadId)}
                />
              ))}
            </ul>
            {read.loadingMore === true ? <p className="seat-threads__note">Reading more…</p> : null}
          </div>
          <div ref={chatRef} className="operator-feed__detail-pane operator-threads__pane" data-testid="operator-threads-pane">
            {composing && quickThread ? (
              quickThread(quickDone, quickBackOut)
            ) : selectedRow ? (
              <>
                <header className="operator-threads__pane-head">
                  <AgentPortrait identity={selectedRow.seat.portraitIdentity} size={18} frame="round" badge={false} outline={false} />
                  <span className="operator-threads__pane-seat">{selectedRow.seat.name}</span>
                  <RegionMark region={selectedRow.region} />
                  {/* A seat on another machine opens from its own side, not here. */}
                  {onOpenSeat && nodesById.get(selectedRow.seat.nodeId)?.kind === "agent" ? (
                    <Button
                      size="sm"
                      variant="chrome"
                      className="operator-threads__open"
                      aria-label={`Open seat ${selectedRow.seat.name}`}
                      onClick={() => onOpenSeat(selectedRow.seat.nodeId, selectedRow.threadId)}
                    >
                      Open seat
                    </Button>
                  ) : null}
                </header>
                <div className="seat-threads__chat operator-threads__chat" key={selected ?? ""}>
                  {chat(selectedRow, chatYields)}
                </div>
              </>
            ) : landing !== null ? (
              <p className="seat-threads__note">Opening the new thread…</p>
            ) : null}
          </div>
        </div>
      )}
    </OperatorModalShell>
  );
}
