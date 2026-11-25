import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown, ChevronRight, Clock, X } from "lucide-react";
import type { BroadcastSeat } from "@shared/broadcast";
import { claimFocus, claimFocusOnMount, recentGestureKind } from "../../lib/focus-ownership";
import { keyIs } from "../../lib/key-match";
import {
  confirmDetail,
  confirmQuestion,
  crossLine,
  groupByRegion,
  leftOutLine,
  LIMIT_GROUPS,
  limitLabel,
  limitsOf,
  pickHas,
  regionTokenText,
  sendToCount,
  type BroadcastReceipt,
  type Limit,
  type RegionPick,
} from "../../lib/quick-thread-broadcast";
import type { QuickThreadRegion } from "../../lib/quick-thread";
import { regionChipStyle } from "../../lib/region-chip-style";
import { AgentPortrait } from "../AgentPortrait";
// The limit chips are the feed's own; its rules come with them, so they draw with the feed closed.
import "../feed/operator-feed.css";
import { Button, IconButton, Popover } from "../ui";

const seatsWord = (count: number): string => (count === 1 ? "1 seat" : `${count} seats`);

/**
 * The region as one token: swatch, name, its limits after commas, its count.
 * Pressing it opens the limits; its own control takes the region off.
 */
export function RegionToken({
  region,
  pick,
  count,
  total,
  countAlone,
  onToggle,
  onRemove,
}: {
  readonly region: QuickThreadRegion;
  readonly pick: RegionPick;
  /** Seats the pick reaches as limited. */
  readonly count: number;
  /** Seats the region holds with no limit. */
  readonly total: number;
  /** What one limit alone would reach in this region. */
  readonly countAlone: (limit: Limit) => number;
  readonly onToggle: (limit: Limit) => void;
  readonly onRemove: () => void;
}) {
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const body = useRef<HTMLDivElement | null>(null);
  // The limits are a dialog: it takes the keyboard on open, whatever opened it (the popover itself leaves a
  // pointer's press where it was), and gives it back to the token when a key closed it.
  useEffect(() => {
    if (!open) return;
    let frame = 0;
    let tries = 0;
    const take = (): void => {
      const first = body.current?.querySelector<HTMLElement>("button");
      if (first !== null && first !== undefined) claimFocus(first, "open", { preventScroll: true });
      // The panel is drawn hidden until it is placed, and a hidden control takes no focus: try again next frame.
      if ((first === null || first === undefined || document.activeElement !== first) && (tries += 1) < 12) frame = requestAnimationFrame(take);
    };
    frame = requestAnimationFrame(take);
    return () => cancelAnimationFrame(frame);
  }, [open]);
  const giveBack = useRef(false);
  const closeLimits = (): void => {
    giveBack.current = recentGestureKind() === "key";
    setOpen(false);
  };
  useEffect(() => {
    if (open || !giveBack.current) return;
    giveBack.current = false;
    claimFocus(anchor, "gesture");
  }, [open, anchor]);
  const limits = limitsOf(pick);
  const label = regionTokenText(region.name, pick);
  const heading = useId();
  return (
    <li
      className="quick-thread__seat quick-thread__region"
      data-testid="quick-thread-region"
      data-region={region.id}
      style={regionChipStyle({ open: false, color: region.color })}
    >
      <button
        ref={setAnchor}
        type="button"
        className="quick-thread__region-press"
        data-testid="quick-thread-region-press"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${label}, ${seatsWord(count)}. Change the limits`}
        onClick={() => (open ? closeLimits() : setOpen(true))}
      >
        <span className="feed-region-chip__swatch" aria-hidden />
        <span className="quick-thread__region-name">{region.name}</span>
        {limits.length > 0 ? <span className="quick-thread__region-limits">{limits.map((limit) => `, ${limitLabel(limit).toLowerCase()}`).join("")}</span> : null}
        <span className="quick-thread__region-count" aria-hidden>
          {count}
        </span>
      </button>
      <IconButton size="xs" aria-label={`Take ${region.name} off`} title={`Take ${region.name} off`} onClick={onRemove}>
        <X size={10} strokeWidth={2} />
      </IconButton>
      {open && anchor !== null ? (
        <Popover anchor={anchor} onClose={closeLimits} label={`Limits for ${region.name}`} width={300} testId="quick-thread-limits">
          <div ref={body} className="quick-thread__limits" data-testid="quick-thread-limits-body">
            {LIMIT_GROUPS.map((group) => (
              <div key={group.group} role="group" aria-labelledby={`${heading}-${group.group}`} className="quick-thread__limit-group">
                <span id={`${heading}-${group.group}`} className="quick-thread__limit-heading">
                  {group.heading}
                </span>
                <div className="quick-thread__limit-chips">
                  {group.limits.map((limit) => {
                    const on = pickHas(pick, limit);
                    return (
                      <button
                        key={limit.value}
                        type="button"
                        className="operator-feed__filter-chip"
                        aria-pressed={on}
                        aria-label={`${limitLabel(limit)}, ${seatsWord(countAlone(limit))}`}
                        data-testid="quick-thread-limit"
                        data-limit={limit.value}
                        onClick={() => onToggle(limit)}
                      >
                        {on ? <Check size={11} strokeWidth={2} aria-hidden /> : null}
                        {limitLabel(limit)}
                        <span className="operator-feed__filter-count">{countAlone(limit)}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
            <p className="quick-thread__limit-foot" role="status" data-testid="quick-thread-limit-foot">
              {count} of {seatsWord(total)}
            </p>
          </div>
        </Popover>
      ) : null}
    </li>
  );
}

/** Names under a toggle, grouped by region: portrait and name, a clock before the seats that get it later. */
function Names({
  seats,
  regionOf,
  label,
  marked = true,
}: {
  readonly seats: ReadonlyArray<BroadcastSeat>;
  readonly regionOf: (nodeId: string) => string | undefined;
  readonly label: string;
  /** False for seats that are not sent to: no clock for "gets it when back". */
  readonly marked?: boolean;
}) {
  const groups = groupByRegion(seats, regionOf);
  const heading = useId();
  const box = useRef<HTMLDivElement | null>(null);
  // A list that fits is not a stop of its own; one that scrolls has the keyboard, so it is read without a mouse.
  const [scrolls, setScrolls] = useState(false);
  useLayoutEffect(() => {
    const element = box.current;
    if (element !== null) setScrolls(element.scrollHeight > element.clientHeight);
  }, [seats]);
  return (
    <div ref={box} className="quick-thread__names" role="region" aria-label={label} {...(scrolls ? { tabIndex: 0 } : {})}>
      {groups.map((group, at) => (
        <div key={group.region} className="quick-thread__names-group">
          {group.region !== "" ? (
            <span id={`${heading}-${at}`} className="quick-thread__names-region">
              {group.region}
            </span>
          ) : null}
          <ul role="list" className="quick-thread__names-list" {...(group.region !== "" ? { "aria-labelledby": `${heading}-${at}` } : {})}>
            {group.seats.map((seat) => (
              <li key={seat.nodeId} className="quick-thread__name-row" data-testid="quick-thread-name" data-seat={seat.nodeId}>
                {marked && !seat.running ? <Clock size={11} aria-hidden className="quick-thread__arrival" /> : null}
                <AgentPortrait identity={seat.nodeId} size={18} frame="round" outline={false} badge={false} />
                <span className="quick-thread__name">{seat.name}</span>
                {marked && !seat.running ? <span className="sr-only">, gets it when back</span> : null}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

/** A line with a toggle that shows the names behind its count. */
function Disclosure({
  text,
  lineId,
  label,
  names: namesLabel,
  marked,
  seats,
  regionOf,
  initiallyOpen = false,
  ink = false,
  testId,
  aside,
}: {
  readonly text: string;
  /** The toggle's id, for a control that is described by this line. */
  readonly lineId?: string;
  /** What the toggle is called to a screen reader, when its words alone are not enough: "Show the 40 seats". */
  readonly label?: string;
  /** What the list of names is called: by what it holds, not by the command that shows it. */
  readonly names: string;
  readonly seats: ReadonlyArray<BroadcastSeat>;
  readonly regionOf: (nodeId: string) => string | undefined;
  /** False for seats that are not sent to: their names carry no mark for getting it later. */
  readonly marked?: boolean;
  readonly initiallyOpen?: boolean;
  readonly ink?: boolean;
  readonly testId: string;
  /** At the end of the line. */
  readonly aside?: ReactNode;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  const names = useId();
  return (
    <div className="quick-thread__disclosure" data-testid={testId} data-open={open ? "true" : undefined} data-ink={ink ? "true" : undefined}>
      <div className="quick-thread__disclosure-line">
        <button id={lineId} type="button" className="quick-thread__disclosure-toggle" aria-expanded={open} aria-controls={names} {...(label === undefined ? {} : { "aria-label": label })} onClick={() => setOpen((was) => !was)}>
          {open ? <ChevronDown size={12} aria-hidden /> : <ChevronRight size={12} aria-hidden />}
          {text}
        </button>
        {aside}
      </div>
      <div id={names} hidden={!open}>
        {open ? <Names seats={seats} regionOf={regionOf} label={namesLabel} {...(marked === undefined ? {} : { marked })} /> : null}
      </div>
    </div>
  );
}

/**
 * The confirm for any send with a region, in the frame's place. The set it
 * shows was read when it opened and is the set that is sent: it never counts
 * again. Seats left out of a doing limit (their machine cannot be read) are
 * said apart and are not in the send.
 *
 * It opens with the keyboard on the question, not on Send: a key still held
 * from the press that opened it must not send to every seat. Send is a few
 * Tabs away (the names, Cancel); the send key pressed on the question itself
 * sends too, unless it is a repeat. Its words are said once through the host's live line as it opens.
 */
export function BroadcastConfirm({
  seats,
  unread,
  crossing = [],
  regionOf,
  sending,
  onCancel,
  onConfirm,
  onAddThem,
}: {
  readonly seats: ReadonlyArray<BroadcastSeat>;
  readonly unread: ReadonlyArray<BroadcastSeat>;
  /** Per region chosen, the seats that straddle its edge: not members, so not in the send. Said in the description. */
  readonly crossing?: ReadonlyArray<{ readonly region: string; readonly seats: ReadonlyArray<BroadcastSeat> }>;
  readonly regionOf: (nodeId: string) => string | undefined;
  readonly sending: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
  readonly onAddThem: () => void;
}) {
  const title = useId();
  const detail = useId();
  const leftOut = useId();
  const edge = useId();
  const later = seats.filter((seat) => !seat.running).length;
  return (
    <div
      ref={claimFocusOnMount}
      tabIndex={-1}
      onKeyDown={(event) => {
        // The question has the keyboard: the send key there is Send, once; a held key does nothing.
        if (event.target !== event.currentTarget || event.repeat || !keyIs(event, "inThread.send") || sending) return;
        event.preventDefault();
        event.stopPropagation();
        onConfirm();
      }}
      className="quick-thread__confirm"
      data-testid="quick-thread-confirm"
      role="group"
      aria-labelledby={title}
      aria-describedby={[detail, ...crossing.map((_, at) => `${edge}-${at}`), ...(unread.length > 0 ? [leftOut] : [])].join(" ")}
    >
      <p id={title} className="quick-thread__confirm-title">
        {confirmQuestion(seats.length)}
      </p>
      <p id={detail} className="quick-thread__confirm-detail">
        {confirmDetail(later)}
      </p>
      <Disclosure
        text={`Show the ${seats.length}`}
        label={`Show the ${seatsWord(seats.length)}`}
        names={`The ${seatsWord(seats.length)} that get it`}
        seats={seats}
        regionOf={regionOf}
        testId="quick-thread-confirm-names"
      />
      {/* One line per region, with its own disclosure under it: these seats do not get the thread, so they are not in the list above or its count. */}
      {crossing.map((entry, at) => (
        <div key={entry.region} className="quick-thread__crossing" data-testid="quick-thread-crossing-block">
          <p id={`${edge}-${at}`} className="quick-thread__confirm-detail" data-testid="quick-thread-crossing">
            {crossLine(entry.region, entry.seats.length)}
          </p>
          <Disclosure
            text={`Show the ${entry.seats.length}`}
            label={`Show the ${seatsWord(entry.seats.length)} partly inside ${entry.region}`}
            names={`The ${seatsWord(entry.seats.length)} partly inside ${entry.region}, not included`}
            marked={false}
            seats={entry.seats}
            regionOf={regionOf}
            testId="quick-thread-crossing-names"
          />
        </div>
      ))}
      {unread.length > 0 ? (
        <div className="quick-thread__leftout" data-testid="quick-thread-leftout">
          <p id={leftOut} className="quick-thread__leftout-text">
            {leftOutLine(unread.length)}
          </p>
          <Disclosure
            text={`Show the ${unread.length}`}
            label={`Show the ${unread.length} left out`}
            names={`The ${unread.length} left out`}
            seats={unread}
            regionOf={regionOf}
            testId="quick-thread-leftout-names"
            aside={
              <Button size="sm" variant="chrome" data-testid="quick-thread-add-them" aria-disabled={sending ? true : undefined} onClick={onAddThem}>
                {unread.length === 1 ? "Add it" : "Add them"}
              </Button>
            }
          />
        </div>
      ) : null}
      <div className="quick-thread__confirm-actions">
        <Button size="sm" variant="chrome" data-testid="quick-thread-confirm-cancel" aria-disabled={sending ? true : undefined} onClick={onCancel}>
          Cancel
        </Button>
        <Button
          size="sm"
          variant="primary"
          data-testid="quick-thread-confirm-send"
          aria-disabled={sending ? true : undefined}
          onClick={() => {
            if (!sending) onConfirm();
          }}
        >
          {sending ? "Sending" : sendToCount(seats.length)}
        </Button>
      </div>
    </div>
  );
}

/**
 * What a send with a region came to, in three counted lines, each a toggle
 * for the names by region: not sent first, then who has it, then who gets it
 * when they are back. A line with none is not drawn. Its buttons stay in
 * place while a send is on its way (aria-disabled), and when the control the
 * keyboard was on leaves with its line, Done takes the keyboard.
 */
export function BroadcastReceiptView({
  receipt,
  regionOf,
  sending,
  onSendAgain,
  onDone,
}: {
  readonly receipt: BroadcastReceipt;
  readonly regionOf: (nodeId: string) => string | undefined;
  readonly sending: boolean;
  readonly onSendAgain: () => void;
  readonly onDone: () => void;
}) {
  const root = useRef<HTMLDivElement | null>(null);
  const done = useRef<HTMLButtonElement | null>(null);
  const setDone = useCallback((element: HTMLButtonElement | null) => {
    done.current = element;
    claimFocusOnMount(element);
  }, []);
  // The control the keyboard was on left with its line: the keyboard falls to the body, so Done takes it. Not taken from where the operator went.
  useEffect(() => {
    const active = document.activeElement;
    if (active === null || active === document.body) claimFocus(done.current, "gesture");
  }, [receipt]);
  const inert = sending ? true : undefined;
  // Done is described by the counted lines, as the single-seat receipt's Done is by its line.
  const ids = useId();
  const lines = [
    receipt.notSent.length > 0 ? `${ids}-not` : undefined,
    receipt.have.length > 0 ? `${ids}-have` : undefined,
    receipt.later.length > 0 ? `${ids}-later` : undefined,
  ].filter((id): id is string => id !== undefined);
  return (
    <div ref={root} className="quick-thread__confirm" data-testid="quick-thread-broadcast-receipt">
      {receipt.notSent.length > 0 ? (
        <Disclosure
          text={`${receipt.notSent.length} not sent`}
          lineId={`${ids}-not`}
          names={`${receipt.notSent.length} not sent`}
          seats={receipt.notSent}
          regionOf={regionOf}
          // Open for up to five: the seats that need the operator are in sight without a press.
          initiallyOpen={receipt.notSent.length <= 5}
          ink
          testId="quick-thread-not-sent"
          aside={
            <Button size="sm" variant="chrome" data-testid="quick-thread-send-again" aria-disabled={inert} onClick={() => !sending && onSendAgain()}>
              {sending ? "Sending" : "Send again"}
            </Button>
          }
        />
      ) : null}
      {receipt.reasons.length > 0 ? (
        <div className="quick-thread__unsent" data-testid="quick-thread-not-sent-reasons">
          {receipt.reasons.map(({ reason, names }) => (
            <p key={reason}>
              Not sent to {names}. {reason}
            </p>
          ))}
        </div>
      ) : null}
      {receipt.have.length > 0 ? (
        <Disclosure text={`${receipt.have.length} have it`} lineId={`${ids}-have`} names={`${receipt.have.length} have it`} seats={receipt.have} regionOf={regionOf} testId="quick-thread-have" />
      ) : null}
      {receipt.later.length > 0 ? (
        <Disclosure
          text={`${receipt.later.length} get it when they are back`}
          lineId={`${ids}-later`}
          names={`${receipt.later.length} get it when they are back`}
          seats={receipt.later}
          regionOf={regionOf}
          testId="quick-thread-later"
        />
      ) : null}
      <div className="quick-thread__done">
        <Button ref={setDone} size="sm" variant="chrome" data-testid="quick-thread-done" aria-describedby={lines.join(" ")} aria-disabled={inert} onClick={() => !sending && onDone()}>
          Done
        </Button>
      </div>
    </div>
  );
}
