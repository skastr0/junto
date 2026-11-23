/**
 * The filter parts the needs-you feed and Threads share: the Seats toggle,
 * the chosen seat's chip, the seat row, and the empty state. Each takes its
 * chips and its words from the modal that draws it, so one look serves rows
 * of either kind.
 */
import type { ReactNode, Ref } from "react";
import { Check, ChevronDown, Inbox, X } from "lucide-react";
import type { FeedSeatChip } from "@shared/operator-feed";
import { regionChipStyle } from "../../lib/region-chip-style";

/** The Seats toggle: folds and unfolds the seat row, and says how many seats it holds. */
export function FeedSeatsToggle({
  ref,
  count,
  open,
  controls,
  onToggle,
}: {
  readonly ref?: Ref<HTMLButtonElement>;
  readonly count: number;
  readonly open: boolean;
  /** The seat row's id. */
  readonly controls: string;
  readonly onToggle: () => void;
}) {
  return (
    <button
      ref={ref}
      type="button"
      className="operator-feed__filter-chip operator-feed__seats-toggle"
      data-testid="feed-seats-toggle"
      aria-expanded={open}
      aria-controls={controls}
      onClick={onToggle}
    >
      Seats
      <span className="operator-feed__filter-count" aria-hidden>
        {count}
      </span>
      <ChevronDown size={12} strokeWidth={2} aria-hidden className="operator-feed__seats-chevron" />
    </button>
  );
}

/**
 * The seat kept, whether the row below is folded or open, so a filter the
 * operator set never leaves the bar without a sign.
 */
export function FeedSeatChosen({ seat, onClear }: { readonly seat: FeedSeatChip; readonly onClear: () => void }) {
  return (
    <span
      className="feed-region-chip operator-feed__seat-chip operator-feed__seat-chip--chosen"
      data-testid="feed-seat-chosen"
      data-seat={seat.seatId}
      style={regionChipStyle(seat)}
      title={seat.regionLabel ? `${seat.name} in ${seat.regionLabel}` : seat.name}
    >
      <span className="feed-region-chip__swatch" aria-hidden />
      <span className="feed-region-chip__label">{seat.name}</span>
      <button type="button" className="operator-feed__seat-clear" aria-label={`Clear seat ${seat.name}`} onClick={onClear}>
        <X size={11} strokeWidth={2} aria-hidden />
      </button>
    </span>
  );
}

/**
 * The seat row: its own line under the chips, at most two chips tall, so a
 * busy canvas costs the list two lines and never five.
 */
export function FeedSeatsRow({
  id,
  chips,
  chosen,
  open,
  countWord,
  onPick,
}: {
  readonly id: string;
  readonly chips: ReadonlyArray<FeedSeatChip>;
  /** The kept seat's id; undefined keeps every seat. */
  readonly chosen: string | undefined;
  readonly open: boolean;
  /** What a chip's count counts, as its name says it ("2 waiting", "1 thread"). */
  readonly countWord: string | ((count: number) => string);
  readonly onPick: (seatId: string) => void;
}) {
  return (
    <div className="operator-feed__seats" id={id} role="group" aria-label="Seats" data-testid="feed-seats-row" hidden={!open}>
      {chips.map((chip) => (
        <button
          key={chip.seatId}
          type="button"
          className="feed-region-chip operator-feed__seat-chip"
          data-testid="feed-seat-chip"
          data-seat={chip.seatId}
          aria-pressed={chosen === chip.seatId}
          aria-label={`${chip.name}${chip.count > 0 ? `, ${chip.count} ${typeof countWord === "string" ? countWord : countWord(chip.count)}` : ""}`}
          style={regionChipStyle(chip)}
          title={chip.regionLabel ? `${chip.name} in ${chip.regionLabel}` : chip.name}
          onClick={() => onPick(chip.seatId)}
        >
          {chosen === chip.seatId ? <Check size={11} strokeWidth={2} aria-hidden /> : null}
          <span className="feed-region-chip__swatch" aria-hidden />
          <span className="feed-region-chip__label">{chip.name}</span>
          <span className="feed-region-chip__count" aria-hidden>
            {chip.count > 99 ? "99+" : chip.count}
          </span>
        </button>
      ))}
    </div>
  );
}

/** An empty list, in the feed's form: the Inbox mark, a title, one line, and at most one way on. */
export function FeedEmpty({
  title,
  copy,
  action,
  testId,
  status = true,
}: {
  readonly title: ReactNode;
  readonly copy: ReactNode;
  readonly action?: ReactNode;
  readonly testId?: string;
  /** Said as it appears; a no-matches state is said by the live line instead. */
  readonly status?: boolean;
}) {
  return (
    <div className="operator-feed__empty" role={status ? "status" : undefined} data-testid={testId}>
      <span className="operator-feed__empty-mark" aria-hidden>
        <Inbox size={22} strokeWidth={1.4} />
      </span>
      <p className="operator-feed__empty-title">{title}</p>
      <p className="operator-feed__empty-copy">{copy}</p>
      {action}
    </div>
  );
}
