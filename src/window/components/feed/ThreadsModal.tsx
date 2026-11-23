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
import { useEffect, useMemo, useRef, useState, type HTMLAttributes, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { use$ } from "@legendapp/state/react";
import { Check, Plus } from "lucide-react";
import { titleOf, type Node } from "@shared/model";
import type { FeedRegion } from "@shared/operator-feed";
import { regionChipStyle } from "../../lib/region-chip-style";
import { claimFocus, focusPrimaryControl } from "../../lib/focus-ownership";
import { useListNav } from "../../lib/list-nav";
import { regionPickKey } from "../../lib/operator-feed";
import { markSeatThreadRead, previewText, threadTime } from "../../lib/seat-threads";
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
  nav,
  onSelect,
}: {
  readonly row: ThreadRow;
  readonly node: Node | undefined;
  readonly selected: boolean;
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
            <span className="seat-threads__row-unread" data-testid="operator-threads-row-unread" aria-label={`${String(row.unread)} unread`}>
              {row.unread > 99 ? "99+" : row.unread}
            </span>
          ) : null}
          <span className="seat-threads__row-time operator-threads__time">{threadTime(row.lastAt)}</span>
        </span>
        <span className="operator-threads__line">
          <Line text={row.title} known={[row.seat.name]} />
        </span>
        <span className="operator-threads__last">
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
  /** The one thread chat for the picked row. */
  readonly chat: (row: ThreadRow) => ReactNode;
  /** Quick thread, when it is built: New thread opens it in the right pane. */
  readonly quickThread?: (done: (first?: { readonly seatId: string; readonly threadId: string }) => void) => ReactNode;
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
  const previous = useRef<ReadonlyArray<string>>(keys);
  const selected = composing ? null : reconcileThreadSelection(previous.current, keys, picked);
  useEffect(() => {
    previous.current = keys;
    if (!composing && selected !== picked) setPicked(selected);
  }, [keys, selected, picked, composing]);
  const selectedRow = selected === null ? undefined : rows.find((row) => row.threadId === selected);

  // A thread on screen is read, on every device: the chat shows it while the
  // modal is open. Mail landing in it while it shows reads too. One behind
  // the Quick thread pane, or not picked, is not on screen and stays unread.
  const shownSeat = selectedRow?.seat.nodeId;
  const shownThread = selectedRow?.threadId;
  const shownUnread = selectedRow?.unread ?? 0;
  useEffect(() => {
    if (shownSeat === undefined || shownThread === undefined) return;
    void markSeatThreadRead({ canvasName, seatId: shownSeat }, shownThread);
  }, [canvasName, shownSeat, shownThread, shownUnread]);

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
  const select = (key: string): void => {
    setComposing(false);
    setPicked(key);
  };
  const nav = useListNav({
    ids: keys,
    selected,
    onSelect: select,
    // Enter opens the thread on the right with the keyboard in its reply.
    onOpen: (key) => {
      select(key);
      requestAnimationFrame(() => focusPrimaryControl(chatRef.current));
    },
  });

  const searchRef = useRef<HTMLInputElement>(null);
  const seatsToggleRef = useRef<HTMLButtonElement>(null);
  const clearAll = (event: ReactMouseEvent<HTMLButtonElement>): void => {
    clearThreadsFilters();
    claimFocus(searchRef.current, "gesture", { event });
  };
  const onEscape = (): boolean => {
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
    setComposing(true);
  };
  const quickDone = (first?: { readonly seatId: string; readonly threadId: string }): void => {
    setComposing(false);
    if (first) setPicked(first.threadId);
  };
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
        <div className="operator-feed__chips" role="group" aria-label="Unread">
          <button
            type="button"
            className="operator-feed__filter-chip"
            data-testid="threads-unread-chip"
            aria-pressed={unreadOnly}
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
        {filtering ? `${String(read.total)} of ${String(all.total)} shown with these filters` : ""}
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
                  nav={nav.rowProps(row.threadId)}
                  onSelect={() => select(row.threadId)}
                />
              ))}
            </ul>
            {read.loadingMore === true ? <p className="seat-threads__note">Reading more…</p> : null}
          </div>
          <div ref={chatRef} className="operator-feed__detail-pane operator-threads__pane" data-testid="operator-threads-pane">
            {composing && quickThread ? (
              quickThread(quickDone)
            ) : selectedRow ? (
              <>
                <header className="operator-threads__pane-head">
                  <AgentPortrait identity={selectedRow.seat.portraitIdentity} size={18} frame="round" badge={false} outline={false} />
                  <span className="operator-threads__pane-seat">{selectedRow.seat.name}</span>
                  <RegionMark region={selectedRow.region} />
                  {onOpenSeat ? (
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
                  {chat(selectedRow)}
                </div>
              </>
            ) : null}
          </div>
        </div>
      )}
    </OperatorModalShell>
  );
}
