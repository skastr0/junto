import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { use$ } from "@legendapp/state/react";
import { Check, Clock, Plus, X } from "lucide-react";
import { claimFocus, claimFocusOnMount, recentGestureKind } from "../../lib/focus-ownership";
import { keyAria, keyCaps, keyIs } from "../../lib/key-match";
import { isMac } from "../../lib/platform";
import {
  keepQuickThread,
  quickThreadCatalog,
  quickThreadDraft,
  quickThreadKept,
  quickThreadOptionKey,
  quickThreadOptions,
  setQuickThreadSeats,
  useQuickThreadKept,
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
import type { NewThread, NewThreadsOutcome, ThreadRecipient } from "../../lib/seat-threads";
import { state$ } from "../../lib/state";
import { useCanvas } from "../../lib/use-model";
import { AgentPortrait } from "../AgentPortrait";
import { ThreadComposer } from "../threads/ThreadComposer";
import { Button, Combobox, IconButton, Kbd, ResourceChip } from "../ui";
// The thread input's own rules and the region dot live with the screens that drew them first.
import "../threads/seat-threads.css";
import "../feed/feed-region-strip.css";
import "./quick-thread.css";

/** The threads a send started, one per seat, each with whether its seat has the mail yet. */
export type QuickThreadSent = ReadonlyArray<NewThread>;

/** A seat that has its thread, with the name it had when it was sent. */
type Settled = NewThread & { readonly name: string };

/** Who the mail has not reached yet, in one sentence about the seat. */
const waitingLine = (waiting: ReadonlyArray<Settled>): string =>
  waiting.length === 1
    ? `Waiting for ${waiting[0]!.name}. It arrives when the seat is back.`
    : `Waiting for ${waiting.length} seats. Each gets it when it is back.`;

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
 * - Mail that is sent but has not reached its seat (the seat is stopped, or
 *   out of reach) is never sent again. With `receipt`, a send that leaves a
 *   seat waiting turns into a receipt that says which, until Done.
 */
export function QuickThread({
  canvasName,
  onSent,
  receipt = false,
  backOut,
}: {
  readonly canvasName: string;
  /** Every chosen seat has its thread: the threads started, in the order chosen. With a receipt up, on Done. */
  readonly onSent?: (sent: QuickThreadSent) => void;
  /**
   * Stay after a send that leaves a seat waiting, to say which (the canvas
   * home, which would otherwise close without a word). Without it the host
   * shows the new thread, where each mail says its own state.
   */
  readonly receipt?: boolean;
  /**
   * For the host's Escape to ask first: true when Escape only put the picker
   * away (it had been brought back to add a seat), so the host stays open.
   */
  readonly backOut?: RefObject<(() => boolean) | null>;
}) {
  const canvas = useCanvas(canvasName);
  const recent = use$(state$.seatVisitOrder);
  const catalog = useMemo(() => quickThreadCatalog(canvas, recent), [canvas, recent]);
  // The reasons are kept with the draft: closed and opened again, it still says why a seat got nothing.
  const { seats: seatIds, unsent } = useQuickThreadKept(canvasName);
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
  // The seats that have their thread, across the tries of one send.
  const [settled, setSettled] = useState<ReadonlyArray<Settled>>([]);
  // Every seat sent, at least one waiting: the result, in place of the input.
  const [receiptOf, setReceiptOf] = useState<ReadonlyArray<Settled>>();
  // A send is on its way: the row takes no change until it ends.
  const [busy, setBusy] = useState(false);
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

  const root = useRef<HTMLDivElement | null>(null);
  const picker = useRef<HTMLDivElement | null>(null);
  const seatField = useRef<HTMLInputElement | null>(null);
  const message = useRef<HTMLTextAreaElement | null>(null);
  // The seat whose remove control takes the keyboard once the row has redrawn.
  const removeNext = useRef<string | null>(null);
  useEffect(() => {
    const id = removeNext.current;
    if (id === null) return;
    removeNext.current = null;
    const holder = [...(root.current?.querySelectorAll<HTMLElement>('[data-testid="quick-thread-seat"]') ?? [])].find(
      (entry) => entry.dataset.seat === id,
    );
    claimFocus(holder?.querySelector("button"), "gesture");
  }, [chosen]);
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
    if (busy) return;
    setSeats([...chosen.map((held) => held.id), seat.id]);
    speak({ kind: "added", seat: seat.name, chosen: chosen.length + 1 });
  };

  const remove = (seat: QuickThreadSeat): void => {
    if (busy) return;
    setSeats(chosen.filter((held) => held.id !== seat.id).map((held) => held.id));
    const { [seat.id]: _gone, ...rest } = unsent;
    keepQuickThread(canvasName, { unsent: rest });
    // With the last seat off, a send that reached only some is over: nothing of it is carried into the next.
    if (chosen.length === 1) setSettled([]);
    speak({ kind: "removed", seat: seat.name, chosen: chosen.length - 1 });
  };

  const narrow = (region: QuickThreadRegion): void => {
    setRegionId(region.id);
    setQuery("");
    setExplicit(undefined);
    speak({ kind: "narrowed", region: region.name, seats: region.seats });
  };

  const widen = (): void => {
    if (narrowed !== undefined) speak({ kind: "widened", region: narrowed.name });
    setRegionId(undefined);
    setExplicit(undefined);
  };

  /** Pick an option: a region narrows, a chosen seat comes off, a new seat is chipped. */
  const pick = (option: QuickThreadOption, stay: boolean): void => {
    if (busy) return;
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
      { query, active: active !== undefined, chosen: chosen.length, narrowed: narrowed !== undefined },
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
      case "widen":
        widen();
        break;
      case "unpick": {
        const last = chosen.at(-1);
        if (last) remove(last);
        break;
      }
    }
    return true;
  };

  const handOver = (all: ReadonlyArray<Settled>): void => {
    setReceiptOf(undefined);
    onSent?.(all.map(({ seatId, threadId, arrival }) => ({ seatId, threadId, arrival })));
  };

  const onSentAll = (outcome: NewThreadsOutcome): void => {
    const all = [
      ...settled,
      ...outcome.sent.map((entry) => ({ ...entry, name: chosen.find((seat) => seat.id === entry.seatId)?.name ?? "" })),
    ];
    // The seats that have their thread leave the row as it is now: one added while this was on its way stays.
    const gone = new Set(outcome.sent.map((entry) => entry.seatId));
    const seats = quickThreadKept(canvasName).seats.filter((id) => !gone.has(id));
    const waiting = all.filter((entry) => entry.arrival === "waiting");
    if (outcome.failed.length === 0) {
      keepQuickThread(canvasName, { seats, unsent: {} });
      setSettled([]);
      if (!receipt || waiting.length === 0) return handOver(all);
      setReceiptOf(all);
      say(`Sent to ${seatCount(all.length)}. ${waitingLine(waiting)}`);
      return;
    }
    // The seats that got nothing stay, each with its reason: Send goes to them alone.
    keepQuickThread(canvasName, {
      seats,
      unsent: Object.fromEntries(outcome.failed.map((entry) => [entry.seatId, entry.message])),
    });
    setSettled(all);
    const notSent = `Not sent to ${seatCount(outcome.failed.length)}`;
    say(waiting.length === 0 ? notSent : `${notSent}. ${waitingLine(waiting)}`);
  };

  // While seats are sent again, the ones still waiting stay in sight; the ones that have it have left.
  const waitingMeanwhile = settled.filter((entry) => entry.arrival === "waiting");

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
    // Anywhere in the picker counts: its field, or a control beside it.
    if (!adding || chosen.length === 0 || picker.current?.contains(document.activeElement) !== true) return false;
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
  // The same key in words, for the line a screen reader hears: caps are drawn as symbols.
  const anotherSpoken = keyAria("inQuickThread.another")?.split(" ")[0];

  const row = (
    <div className="quick-thread__to" inert={busy} data-busy={busy ? "true" : undefined}>
      {picking ? (
        <div ref={picker} className="quick-thread__picker" data-testid="quick-thread-picker">
          <Combobox<QuickThreadOption>
            value={query}
            onValueChange={setQuery}
            options={options}
            optionKey={quickThreadOptionKey}
            activeKey={activeKey}
            onActiveKeyChange={setExplicit}
            selectedKeys={selectedKeys}
            onFieldKeyDown={onSeatKey}
            // Every Enter in this field is the key table's (onFieldKeyDown): nothing is left to commit.
            onCommit={() => {}}
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
                // Drawn for the eye; the field's description says the same in words.
                <span className="quick-thread__hint" aria-hidden="true">
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
                  {/* Heard as "Design System, region, 6 seats": Enter on it narrows, it adds nobody. */}
                  <span className="sr-only">, region, </span>
                  <span className="quick-thread__option-count">{seatCount(option.seats)}</span>
                </div>
              )
            }
          />
          <span id={describedBy} className="sr-only">
            {anotherSpoken === undefined
              ? chosenSeatsSpoken(chosen.length)
              : `${chosenSeatsSpoken(chosen.length)}. ${anotherSpoken} adds another`}
          </span>
        </div>
      ) : null}
      {chosen.length > 0 ? (
        <div className="quick-thread__chosen" data-testid="quick-thread-chosen">
          {waitingMeanwhile.length > 0 ? (
            <ul role="list" aria-label="Sent, waiting for the seat" className="quick-thread__seats">
              {waitingMeanwhile.map((entry) => (
                <li
                  key={entry.seatId}
                  className="quick-thread__seat"
                  data-testid="quick-thread-waiting"
                  data-seat={entry.seatId}
                  data-arrival="waiting"
                >
                  <Clock size={11} aria-hidden className="quick-thread__arrival" />
                  <ResourceChip kind="seat" seat={entry.seatId} label={entry.name} />
                </li>
              ))}
            </ul>
          ) : null}
          <ul role="list" aria-label="Chosen seats" className="quick-thread__seats">
            {chosen.map((seat) => (
              <li key={seat.id} className="quick-thread__seat" data-testid="quick-thread-seat" data-seat={seat.id}>
                <ResourceChip kind="seat" seat={seat.id} label={seat.name} />
                <IconButton
                  size="xs"
                  aria-label={unpickSpoken(seat.name)}
                  title={unpickSpoken(seat.name)}
                  onClick={() => {
                    if (busy) return;
                    const at = chosen.indexOf(seat);
                    const neighbour = chosen[at + 1] ?? chosen[at - 1];
                    const byPointer = recentGestureKind() === "pointer";
                    remove(seat);
                    // The control leaves with its seat. By keyboard the next seat's control takes its place
                    // (else the one before), so several come off in a row; the last one off, the seat field,
                    // which takes the keyboard as it appears. A pointer goes on to where it was headed.
                    if (neighbour === undefined) claimFocus(seatField.current, "gesture");
                    else if (byPointer) claimFocus(picking ? seatField.current : message.current, "gesture");
                    else removeNext.current = neighbour.id;
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

  const live = (
    <div className="sr-only" role="status" aria-live="polite" data-testid="quick-thread-spoken">
      {/* The same line twice in a row is still said: the second differs by a space no one hears. */}
      {spoken.turn % 2 === 0 ? spoken.text : `${spoken.text}\u00a0`}
    </div>
  );

  if (receiptOf !== undefined) {
    const waiting = receiptOf.filter((entry) => entry.arrival === "waiting");
    return (
      <div className="quick-thread quick-thread--receipt" data-testid="quick-thread-receipt">
        <p className="quick-thread__sent">Sent to {seatCount(receiptOf.length)}</p>
        <ul role="list" aria-label="Sent to" className="quick-thread__seats">
          {receiptOf.map((entry) => (
            <li
              key={entry.seatId}
              className="quick-thread__seat"
              data-testid="quick-thread-sent-seat"
              data-seat={entry.seatId}
              data-arrival={entry.arrival}
            >
              {entry.arrival === "waiting" ? (
                <Clock size={11} aria-hidden className="quick-thread__arrival" />
              ) : (
                <Check size={11} aria-hidden className="quick-thread__arrival" />
              )}
              <ResourceChip kind="seat" seat={entry.seatId} label={entry.name} />
              <span className="sr-only">{entry.arrival === "waiting" ? "waiting" : "has it"}</span>
            </li>
          ))}
        </ul>
        <p className="quick-thread__waiting" data-testid="quick-thread-waiting-line">
          {waitingLine(waiting)}
        </p>
        <div className="quick-thread__done">
          <Button ref={claimFocusOnMount} size="sm" variant="chrome" data-testid="quick-thread-done" onClick={() => handOver(receiptOf)}>
            Done
          </Button>
        </div>
        {live}
      </div>
    );
  }

  return (
    <div
      ref={root}
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
        onSending={setBusy}
        held={held}
        fieldRef={message}
        // With the picker up the keyboard starts in it; with seats already chosen, in the message.
        yields={() => pickingNow.current}
      />
      {live}
    </div>
  );
}
