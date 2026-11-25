import { useId, useState, type ReactNode } from "react";
import { Check, ChevronDown, ChevronRight, Clock, X } from "lucide-react";
import type { BroadcastSeat } from "@shared/broadcast";
import { claimFocusOnMount } from "../../lib/focus-ownership";
import {
  confirmDetail,
  confirmQuestion,
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
        onClick={() => setOpen((was) => !was)}
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
        <Popover anchor={anchor} onClose={() => setOpen(false)} label={`Limits for ${region.name}`} width={300} testId="quick-thread-limits">
          <div className="quick-thread__limits" data-testid="quick-thread-limits-body">
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
function Names({ seats, regionOf, label }: { readonly seats: ReadonlyArray<BroadcastSeat>; readonly regionOf: (nodeId: string) => string | undefined; readonly label: string }) {
  const groups = groupByRegion(seats, regionOf);
  return (
    // A scroll region has the keyboard, so a long list is read without a mouse.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
    <div className="quick-thread__names" role="region" aria-label={label} tabIndex={0}>
      {groups.map((group) => (
        <div key={group.region} className="quick-thread__names-group">
          {group.region !== "" ? <span className="quick-thread__names-region">{group.region}</span> : null}
          <ul role="list" className="quick-thread__names-list">
            {group.seats.map((seat) => (
              <li key={seat.nodeId} className="quick-thread__name-row" data-testid="quick-thread-name" data-seat={seat.nodeId}>
                {seat.running ? null : <Clock size={11} aria-hidden className="quick-thread__arrival" />}
                <AgentPortrait identity={seat.nodeId} size={18} frame="round" outline={false} badge={false} />
                <span className="quick-thread__name">{seat.name}</span>
                {seat.running ? null : <span className="sr-only">, gets it when back</span>}
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
  seats,
  regionOf,
  initiallyOpen = false,
  ink = false,
  testId,
  aside,
}: {
  readonly text: string;
  readonly seats: ReadonlyArray<BroadcastSeat>;
  readonly regionOf: (nodeId: string) => string | undefined;
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
        <button type="button" className="quick-thread__disclosure-toggle" aria-expanded={open} aria-controls={names} onClick={() => setOpen((was) => !was)}>
          {open ? <ChevronDown size={12} aria-hidden /> : <ChevronRight size={12} aria-hidden />}
          {text}
        </button>
        {aside}
      </div>
      <div id={names} hidden={!open}>
        {open ? <Names seats={seats} regionOf={regionOf} label={text} /> : null}
      </div>
    </div>
  );
}

/**
 * The confirm for any send with a region, in the frame's place. The set it
 * shows was read when it opened and is the set that is sent: it never counts
 * again. Seats left out of a doing limit (their machine cannot be read) are
 * said apart and are not in the send.
 */
export function BroadcastConfirm({
  seats,
  unread,
  regionOf,
  sending,
  onCancel,
  onConfirm,
  onAddThem,
}: {
  readonly seats: ReadonlyArray<BroadcastSeat>;
  readonly unread: ReadonlyArray<BroadcastSeat>;
  readonly regionOf: (nodeId: string) => string | undefined;
  readonly sending: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
  readonly onAddThem: () => void;
}) {
  const title = useId();
  const detail = useId();
  const later = seats.filter((seat) => !seat.running).length;
  return (
    <div className="quick-thread__confirm" data-testid="quick-thread-confirm" role="group" aria-labelledby={title} aria-describedby={detail}>
      <p id={title} className="quick-thread__confirm-title">
        {confirmQuestion(seats.length)}
      </p>
      <p id={detail} className="quick-thread__confirm-detail">
        {confirmDetail(later)}
      </p>
      <Disclosure text={`Show the ${seats.length}`} seats={seats} regionOf={regionOf} testId="quick-thread-confirm-names" />
      {unread.length > 0 ? (
        <div className="quick-thread__leftout" data-testid="quick-thread-leftout">
          <p className="quick-thread__leftout-text">{leftOutLine(unread.length)}</p>
          <Disclosure
            text={`Show the ${unread.length}`}
            seats={unread}
            regionOf={regionOf}
            testId="quick-thread-leftout-names"
            aside={
              <Button size="sm" variant="chrome" data-testid="quick-thread-add-them" disabled={sending} onClick={onAddThem}>
                {unread.length === 1 ? "Add it" : "Add them"}
              </Button>
            }
          />
        </div>
      ) : null}
      <div className="quick-thread__confirm-actions">
        <Button size="sm" variant="chrome" data-testid="quick-thread-confirm-cancel" disabled={sending} onClick={onCancel}>
          Cancel
        </Button>
        <Button
          ref={claimFocusOnMount}
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
 * when they are back. A line with none is not drawn.
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
  return (
    <div className="quick-thread__confirm" data-testid="quick-thread-broadcast-receipt">
      {receipt.notSent.length > 0 ? (
        <Disclosure
          text={`${receipt.notSent.length} not sent`}
          seats={receipt.notSent}
          regionOf={regionOf}
          // Open for up to five: the seats that need the operator are in sight without a press.
          initiallyOpen={receipt.notSent.length <= 5}
          ink
          testId="quick-thread-not-sent"
          aside={
            <Button size="sm" variant="chrome" data-testid="quick-thread-send-again" disabled={sending} onClick={onSendAgain}>
              {sending ? "Sending" : "Send again"}
            </Button>
          }
        />
      ) : null}
      {receipt.have.length > 0 ? <Disclosure text={`${receipt.have.length} have it`} seats={receipt.have} regionOf={regionOf} testId="quick-thread-have" /> : null}
      {receipt.later.length > 0 ? (
        <Disclosure text={`${receipt.later.length} get it when they are back`} seats={receipt.later} regionOf={regionOf} testId="quick-thread-later" />
      ) : null}
      <div className="quick-thread__done">
        <Button ref={claimFocusOnMount} size="sm" variant="chrome" data-testid="quick-thread-done" disabled={sending} onClick={onDone}>
          Done
        </Button>
      </div>
    </div>
  );
}
