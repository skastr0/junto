import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { use$ } from "@legendapp/state/react";
import { Check, Plus, X } from "lucide-react";
import { claimFocus } from "../../lib/focus-ownership";
import { keyAria, keyCaps, keyIs } from "../../lib/key-match";
import { isMac } from "../../lib/platform";
import {
  quickThreadCatalog,
  quickThreadDraft,
  quickThreadOptionKey,
  quickThreadOptions,
  setQuickThreadSeats,
  useQuickThreadSeats,
  type QuickThreadOption,
  type QuickThreadRegion,
  type QuickThreadSeat,
} from "../../lib/quick-thread";
import {
  chosenSeatsSpoken,
  quickThreadIntentOf,
  quickThreadSpoken,
  unpickSpoken,
  type QuickThreadChange,
} from "../../lib/quick-thread-keys";
import { regionChipStyle } from "../../lib/region-chip-style";
import type { NewThreadsOutcome, ThreadRecipient } from "../../lib/seat-threads";
import { state$ } from "../../lib/state";
import { useCanvas } from "../../lib/use-model";
import { AgentPortrait } from "../AgentPortrait";
import { ThreadComposer } from "../threads/ThreadComposer";
import { Combobox, IconButton, Kbd, ResourceChip } from "../ui";
// The thread input's own rules and the region dot live with the screens that drew them first.
import "../threads/seat-threads.css";
import "../feed/feed-region-strip.css";
import "./quick-thread.css";

/** The threads a send started, one per seat. */
export type QuickThreadSent = ReadonlyArray<{ readonly seatId: string; readonly threadId: string }>;

const seatCount = (seats: number): string => (seats === 1 ? "1 seat" : `${seats} seats`);

/**
 * Quick thread: a new thread to a seat, or the same one to several. The
 * operator types a seat or a region, picks seats, and writes once in the
 * thread input; each seat gets its own thread with the same text and files.
 *
 * One component, two homes: a frame of its own on the canvas
 * (QuickThreadModal), and New thread inside Global threads, where it fills
 * the pane it is given. It draws no frame.
 *
 * - The picker is the house combobox over seats and regions in one ranked
 *   list. A region is never a recipient: picking one narrows the list to its
 *   seats. Picking a seat chips it and moves the keyboard to the message;
 *   picking it again takes it off. Its keys come from the key table
 *   (lib/quick-thread-keys).
 * - The chosen seats sit in a row over the message, each with its portrait
 *   and a control that takes it off; the control at the end brings the
 *   picker back.
 * - The draft (seats, text, files) is kept until it is sent.
 * - A seat that got nothing stays in the row with the reason under it; the
 *   seats that were sent leave, so Send goes to the rest alone.
 */
export function QuickThread({
  canvasName,
  onSent,
  backOut,
}: {
  readonly canvasName: string;
  /** Every chosen seat has its thread: the threads started, in the order chosen. */
  readonly onSent?: (sent: QuickThreadSent) => void;
  /**
   * For the host's Escape to ask first: true when Escape only put the picker
   * away (it had been brought back to add a seat), so the host stays open.
   */
  readonly backOut?: RefObject<(() => boolean) | null>;
}) {
  const canvas = useCanvas(canvasName);
  const recent = use$(state$.seatVisitOrder);
  const catalog = useMemo(() => quickThreadCatalog(canvas, recent), [canvas, recent]);
  const seatIds = useQuickThreadSeats(canvasName);
  // A seat taken off the canvas since it was chosen is no longer a recipient.
  const chosen = useMemo(() => {
    const byId = new Map(catalog.seats.map((seat) => [seat.id, seat]));
    return seatIds.flatMap((id) => byId.get(id) ?? []);
  }, [catalog, seatIds]);
  const recipients = useMemo<ReadonlyArray<ThreadRecipient>>(
    () => chosen.map((seat) => ({ seatId: seat.id, name: seat.name })),
    [chosen],
  );
  const held = quickThreadDraft(canvasName);

  const [query, setQuery] = useState("");
  const [regionId, setRegionId] = useState<string>();
  const [explicit, setExplicit] = useState<string>();
  // The picker, brought back while seats are chosen.
  const [adding, setAdding] = useState(false);
  const [unsent, setUnsent] = useState<Readonly<Record<string, string>>>({});
  const [spoken, setSpoken] = useState({ text: "", turn: 0 });

  const narrowed = regionId === undefined ? undefined : catalog.regions.find((region) => region.id === regionId);
  const options = useMemo(() => quickThreadOptions(catalog, query, narrowed?.id), [catalog, query, narrowed]);
  // Typing puts the keyboard on the best match, so Enter takes it; the arrows move it from there.
  const activeKey =
    explicit !== undefined && options.some((option) => quickThreadOptionKey(option) === explicit)
      ? explicit
      : query.trim() !== "" && options[0] !== undefined
        ? quickThreadOptionKey(options[0])
        : undefined;
  const active = options.find((option) => quickThreadOptionKey(option) === activeKey);
  const picking = chosen.length === 0 || adding;
  const selectedKeys = useMemo(() => new Set(chosen.map((seat) => quickThreadOptionKey(seat))), [chosen]);

  const seatField = useRef<HTMLInputElement | null>(null);
  const message = useRef<HTMLTextAreaElement | null>(null);
  const sentSoFar = useRef<QuickThreadSent>([]);
  const pickingNow = useRef(picking);
  pickingNow.current = picking;
  // The seat field takes the keyboard as it appears: on open with no seat chosen, and when it is brought back.
  const setSeatField = useCallback((element: HTMLInputElement | null) => {
    seatField.current = element;
    if (element) claimFocus(element, "open");
  }, []);
  const describedBy = useId();

  const say = (text: string): void => setSpoken((last) => ({ text, turn: last.turn + 1 }));
  const speak = (change: QuickThreadChange): void => say(quickThreadSpoken(change));
  const setSeats = (ids: ReadonlyArray<string>): void => setQuickThreadSeats(canvasName, ids);

  /** The picker goes away and the keyboard is in the message. */
  const toMessage = (): void => {
    setAdding(false);
    setQuery("");
    setRegionId(undefined);
    setExplicit(undefined);
    claimFocus(message.current, "gesture");
  };

  const add = (seat: QuickThreadSeat): void => {
    setSeats([...chosen.map((held) => held.id), seat.id]);
    speak({ kind: "added", seat: seat.name, chosen: chosen.length + 1 });
  };

  const remove = (seat: QuickThreadSeat): void => {
    setSeats(chosen.filter((held) => held.id !== seat.id).map((held) => held.id));
    setUnsent(({ [seat.id]: _gone, ...rest }) => rest);
    speak({ kind: "removed", seat: seat.name, chosen: chosen.length - 1 });
  };

  const narrow = (region: QuickThreadRegion): void => {
    setRegionId(region.id);
    setQuery("");
    setExplicit(undefined);
    speak({ kind: "narrowed", region: region.name, seats: region.seats });
  };

  const widen = (): void => {
    setRegionId(undefined);
    setExplicit(undefined);
  };

  /** Pick an option: a region narrows, a chosen seat comes off, a new seat is chipped. */
  const pick = (option: QuickThreadOption, stay: boolean): void => {
    if (option.kind === "region") return narrow(option);
    if (selectedKeys.has(quickThreadOptionKey(option))) return remove(option);
    add(option);
    if (!stay) return toMessage();
    setAdding(true);
    // What was typed found its seat; a list walked with the arrows stays where it is, for the next one.
    if (query !== "") {
      setQuery("");
      setExplicit(undefined);
    }
  };

  const move = (step: 1 | -1): void => {
    if (options.length === 0) return;
    const at = options.findIndex((option) => quickThreadOptionKey(option) === activeKey);
    const next = at === -1 ? (step === 1 ? 0 : options.length - 1) : (at + step + options.length) % options.length;
    setExplicit(quickThreadOptionKey(options[next]!));
  };

  const onSeatKey = (event: KeyboardEvent<HTMLInputElement>): boolean | void => {
    // The surface's: the list keeps its place and the key goes on.
    if (event.key === "Escape") return true;
    const bare = !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
    // The region the list is narrowed to goes before any seat does.
    if (event.key === "Backspace" && bare && query === "" && narrowed !== undefined) {
      event.preventDefault();
      widen();
      return true;
    }
    const intent = quickThreadIntentOf(
      {
        key: event.key,
        code: event.code,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
        defaultPrevented: event.defaultPrevented,
        isComposing: event.nativeEvent.isComposing,
      },
      { query, active: active !== undefined, chosen: chosen.length },
    );
    if (intent === null) return;
    event.preventDefault();
    event.stopPropagation();
    switch (intent) {
      case "next":
        move(1);
        break;
      case "previous":
        move(-1);
        break;
      case "pick":
        if (active) pick(active, false);
        break;
      case "pickAnother":
        if (active) pick(active, true);
        break;
      case "write":
        toMessage();
        break;
      case "nothing":
        speak({ kind: "nothing", query: query.trim() });
        break;
      case "unpick": {
        const last = chosen.at(-1);
        if (last) remove(last);
        break;
      }
    }
    return true;
  };

  const onSentAll = (outcome: NewThreadsOutcome): void => {
    sentSoFar.current = [...sentSoFar.current, ...outcome.sent];
    if (outcome.failed.length === 0) {
      const all = sentSoFar.current;
      sentSoFar.current = [];
      setSeats([]);
      setUnsent({});
      onSent?.(all);
      return;
    }
    // Only the seats that got nothing stay: Send goes to them alone.
    setSeats(outcome.failed.map((entry) => entry.seatId));
    setUnsent(Object.fromEntries(outcome.failed.map((entry) => [entry.seatId, entry.message])));
    say(`Not sent to ${seatCount(outcome.failed.length)}`);
  };

  // The reasons, one line for the seats that share one.
  const reasons = useMemo(() => {
    const lines = new Map<string, string[]>();
    for (const seat of chosen) {
      const reason = unsent[seat.id];
      if (reason === undefined) continue;
      lines.set(reason, [...(lines.get(reason) ?? []), `@${seat.name}`]);
    }
    return [...lines].map(([reason, names]) => ({ reason, names: names.join(", ") }));
  }, [chosen, unsent]);

  // Escape, when the picker was brought back to add a seat: back to the message, the row as it was.
  const backOutNow = useRef<() => boolean>(() => false);
  backOutNow.current = () => {
    if (!adding || chosen.length === 0 || document.activeElement !== seatField.current) return false;
    toMessage();
    return true;
  };
  useEffect(() => {
    if (!backOut) return;
    backOut.current = () => backOutNow.current();
    return () => {
      backOut.current = null;
    };
  }, [backOut]);

  const another = keyCaps("inQuickThread.another")?.join(isMac() ? "" : "+");

  const row = (
    <div className="quick-thread__to">
      {picking ? (
        <div className="quick-thread__picker" data-testid="quick-thread-picker">
          <Combobox<QuickThreadOption>
            value={query}
            onValueChange={setQuery}
            options={options}
            optionKey={quickThreadOptionKey}
            activeKey={activeKey}
            onActiveKeyChange={setExplicit}
            selectedKeys={selectedKeys}
            onFieldKeyDown={onSeatKey}
            // Enter the key table left alone: something is typed and nothing matches it.
            onCommit={(option) => {
              if (option === undefined && query.trim() !== "" && options.length === 0) speak({ kind: "nothing", query: query.trim() });
            }}
            onOptionClick={(option) => pick(option, false)}
            aria-label="Seat or region"
            aria-describedby={describedBy}
            aria-keyshortcuts={keyAria("inQuickThread.another")}
            listLabel={narrowed ? `Seats in ${narrowed.name}` : "Seats and regions"}
            placeholder="Seat or region"
            fieldRef={setSeatField}
            listClassName="quick-thread__list"
            leading={
              narrowed ? (
                <span
                  className="quick-thread__narrowed"
                  data-testid="quick-thread-narrowed"
                  style={regionChipStyle({ open: false, color: narrowed.color })}
                >
                  <span className="feed-region-chip__swatch" aria-hidden />
                  <span className="quick-thread__narrowed-name">in {narrowed.name}</span>
                  <IconButton
                    size="xs"
                    aria-label="Show every seat"
                    title="Show every seat"
                    onClick={() => {
                      widen();
                      claimFocus(seatField.current, "gesture");
                    }}
                  >
                    <X size={10} strokeWidth={2} />
                  </IconButton>
                </span>
              ) : undefined
            }
            trailing={
              another ? (
                <span className="quick-thread__hint">
                  <Kbd>{another}</Kbd> adds another
                </span>
              ) : undefined
            }
            empty={
              <p className="quick-thread__empty" data-testid="quick-thread-empty">
                {query.trim() === "" ? "No seats here yet" : "No seat or region matches"}
              </p>
            }
            renderOption={(option, { selected }) =>
              option.kind === "seat" ? (
                <div className="quick-thread__option" data-testid="quick-thread-option" data-kind="seat" data-seat={option.id}>
                  <AgentPortrait identity={option.id} size={18} frame="round" outline={false} badge={false} />
                  <span className="quick-thread__option-name">{option.name}</span>
                  {option.region ? <span className="quick-thread__option-region">{option.region}</span> : null}
                  {selected ? <Check size={12} aria-hidden className="quick-thread__option-check" /> : null}
                </div>
              ) : (
                <div
                  className="quick-thread__option"
                  data-testid="quick-thread-option"
                  data-kind="region"
                  data-region={option.id}
                  style={regionChipStyle({ open: false, color: option.color })}
                >
                  <span className="quick-thread__option-dot">
                    <span className="feed-region-chip__swatch" aria-hidden />
                  </span>
                  <span className="quick-thread__option-name">{option.name}</span>
                  <span className="quick-thread__option-count">{seatCount(option.seats)}</span>
                </div>
              )
            }
          />
          <span id={describedBy} className="sr-only">
            {chosenSeatsSpoken(chosen.length)}
          </span>
        </div>
      ) : null}
      {chosen.length > 0 ? (
        <div className="quick-thread__chosen" data-testid="quick-thread-chosen">
          <ul role="list" aria-label="Chosen seats" className="quick-thread__seats">
            {chosen.map((seat) => (
              <li key={seat.id} className="quick-thread__seat" data-testid="quick-thread-seat" data-seat={seat.id}>
                <ResourceChip kind="seat" seat={seat.id} label={seat.name} />
                <IconButton
                  size="xs"
                  aria-label={unpickSpoken(seat.name)}
                  title={unpickSpoken(seat.name)}
                  onClick={() => {
                    remove(seat);
                    // The control leaves with its seat: the keyboard goes on to where the operator was headed.
                    if (picking || chosen.length === 1) claimFocus(seatField.current, "gesture");
                    else claimFocus(message.current, "gesture");
                  }}
                >
                  <X size={10} strokeWidth={2} />
                </IconButton>
              </li>
            ))}
          </ul>
          <IconButton
            size="xs"
            aria-label="Add a seat"
            title="Add a seat"
            data-testid="quick-thread-add"
            onClick={() => {
              setAdding(true);
              claimFocus(seatField.current, "gesture");
            }}
          >
            <Plus size={12} strokeWidth={2} />
          </IconButton>
        </div>
      ) : null}
      {reasons.length > 0 ? (
        <div className="quick-thread__unsent" data-testid="quick-thread-unsent">
          {reasons.map(({ reason, names }) => (
            <p key={reason}>
              Not sent to {names}. {reason}
            </p>
          ))}
        </div>
      ) : null}
    </div>
  );

  return (
    <div
      className="quick-thread"
      data-testid="quick-thread"
      onKeyDown={(event) => {
        // Send with nobody chosen does nothing; say why.
        if (event.target === message.current && chosen.length === 0 && keyIs(event, "inThread.send")) speak({ kind: "noSeat" });
      }}
    >
      <ThreadComposer
        mode="new"
        canvasName={canvasName}
        recipients={recipients}
        recipientsRow={row}
        onSentAll={onSentAll}
        held={held}
        fieldRef={message}
        // With the picker up the keyboard starts in it; with seats already chosen, in the message.
        yields={() => pickingNow.current}
      />
      <div className="sr-only" role="status" aria-live="polite" data-testid="quick-thread-spoken">
        {/* The same line twice in a row is still said: the second differs by a space no one hears. */}
        {spoken.turn % 2 === 0 ? spoken.text : `${spoken.text} `}
      </div>
    </div>
  );
}
