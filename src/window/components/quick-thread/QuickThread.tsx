import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { use$ } from "@legendapp/state/react";
import { Check, ChevronRight, Clock, Plus, X } from "lucide-react";
import type { BroadcastSeat } from "@shared/broadcast";
import { picksOf, useBroadcastReader } from "../../lib/broadcast-set";
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
  setQuickThreadRegions,
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
import {
  broadcastReceipt,
  broadcastReceiptSpoken,
  chooseRegion,
  confirmSpoken,
  limitedRegionOptions,
  limitWord,
  regionTokenSpoken,
  regionTokenText,
  toggleLimit,
  type BroadcastReceipt,
  type Limit,
  type RegionPick,
} from "../../lib/quick-thread-broadcast";
import { regionChipStyle } from "../../lib/region-chip-style";
import { waitingForSeats, type NewThread, type NewThreadsOutcome, type ThreadRecipient } from "../../lib/seat-threads";
import { state$ } from "../../lib/state";
import { useCanvas } from "../../lib/use-model";
import { AgentPortrait } from "../AgentPortrait";
import { ThreadComposer } from "../threads/ThreadComposer";
import { Button, Combobox, IconButton, Kbd, ResourceChip } from "../ui";
import { BroadcastConfirm, BroadcastReceiptView, RegionToken } from "./BroadcastParts";
// The thread input's own rules and the region dot live with the screens that drew them first.
import "../threads/seat-threads.css";
import "../feed/feed-region-strip.css";
import "./quick-thread.css";

/** The threads a send started, one per seat, each with whether its seat has the mail yet. */
export type QuickThreadSent = ReadonlyArray<NewThread>;

/** A seat that has its thread, with the name it had when it was sent. */
type Settled = NewThread & { readonly name: string };

const waitingLine = (waiting: ReadonlyArray<Settled>): string => waitingForSeats(waiting.map((entry) => entry.name));

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
 *   list. A region picked is a recipient, as wide as the seats it holds now,
 *   narrowed by limits (what its seats are doing, what they need from the
 *   operator; "junto working" offers the region with that limit on it). Its
 *   trailing control, or the narrow key, shows only its seats instead.
 *   Picking a seat chips it and moves the keyboard to the message; picking
 *   it again takes it off. Its keys come from the key table
 *   (lib/quick-thread-keys).
 * - The chosen seats sit in a row over the message, each with its portrait
 *   and a control that takes it off, a region as one token with its count
 *   whose press opens its limits; the control at the end brings the picker
 *   back.
 * - A send with a region asks first (BroadcastConfirm) and sends to the seats
 *   the confirm showed; it comes back as three counted lines
 *   (BroadcastReceiptView). Seats picked one by one never ask.
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
  const { seats: seatIds, regions: regionPicks, unsent } = useQuickThreadKept(canvasName);
  // A seat taken off the canvas since it was chosen is no longer a recipient.
  const chosen = useMemo(() => {
    const byId = new Map(catalog.seats.map((seat) => [seat.id, seat]));
    return seatIds.flatMap((id) => byId.get(id) ?? []);
  }, [catalog, seatIds]);
  // A region taken off the canvas, or emptied of seats, is no longer a recipient.
  const regionsChosen = useMemo(
    () => regionPicks.flatMap((pick) => (catalog.regions.some((region) => region.id === pick.regionId) ? [pick] : [])),
    [catalog, regionPicks],
  );
  const regionOfId = useMemo(() => new Map(catalog.regions.map((region) => [region.id, region])), [catalog]);
  // The seats the choice reaches, read as seats change state: a region is the seats it holds now.
  const read = useBroadcastReader(canvasName);
  const choice = useMemo(() => picksOf(chosen.map((seat) => seat.id), regionsChosen), [chosen, regionsChosen]);
  const set = useMemo(() => read(choice), [read, choice]);
  const withRegion = regionsChosen.length > 0;
  const recipients = useMemo<ReadonlyArray<ThreadRecipient>>(
    () =>
      withRegion
        ? set.seats.map((seat) => ({ seatId: seat.nodeId, name: seat.name }))
        : chosen.map((seat) => ({ seatId: seat.id, name: seat.name })),
    [withRegion, set, chosen],
  );
  const seatByNode = useMemo(() => new Map(catalog.seats.map((seat) => [seat.id, seat])), [catalog]);
  /** The region a seat sits in, innermost, for the lists of names. */
  const regionOf = useCallback((nodeId: string): string | undefined => seatByNode.get(nodeId)?.region, [seatByNode]);
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
  // A send with a region asks first. What it asks about is read once when it opens and is what is sent.
  const [confirming, setConfirming] = useState<{ readonly seats: ReadonlyArray<BroadcastSeat>; readonly unread: ReadonlyArray<BroadcastSeat> }>();
  // What a send with a region came to, until Done.
  const [broadcastResult, setBroadcastResult] = useState<BroadcastReceipt>();
  // The set a send with a region fixed and what has reached it so far, across tries. A ref: the send reads it after it awaits.
  const fixed = useRef<{ seats: ReadonlyArray<BroadcastSeat>; sent: ReadonlyArray<NewThread> } | undefined>(undefined);
  const sendTo = useRef<((to: ReadonlyArray<ThreadRecipient>) => Promise<boolean>) | null>(null);
  const awaiting = useRef(false);

  const narrowed = regionId === undefined ? undefined : catalog.regions.find((region) => region.id === regionId);
  const listed = useMemo(() => quickThreadOptions(catalog, query, narrowed?.id), [catalog, query, narrowed]);
  // "junto working": the region with that limit on it comes first, with the count it alone reaches.
  const options = useMemo(
    () =>
      narrowed !== undefined
        ? listed
        : [
            ...limitedRegionOptions(catalog.regions, query, (regionId, limit) => read(picksOf([], [chooseRegion([], regionId, limit)[0]!])).count),
            ...listed,
          ],
    [listed, narrowed, catalog, query, read],
  );
  // Typing puts the keyboard on the best match, so Enter takes it; the arrows move it from there.
  const activeKey =
    explicit !== undefined && options.some((option) => quickThreadOptionKey(option) === explicit)
      ? explicit
      : query.trim() !== "" && options[0] !== undefined
        ? quickThreadOptionKey(options[0])
        : undefined;
  const active = options.find((option) => quickThreadOptionKey(option) === activeKey);
  const picking = chosen.length + regionsChosen.length === 0 || adding;
  const selectedKeys = useMemo(() => new Set(chosen.map((seat) => quickThreadOptionKey(seat))), [chosen]);

  const root = useRef<HTMLDivElement | null>(null);
  const picker = useRef<HTMLDivElement | null>(null);
  const seatField = useRef<HTMLInputElement | null>(null);
  const message = useRef<HTMLTextAreaElement | null>(null);
  // The seat whose remove control takes the keyboard once the row has redrawn.
  const removeNext = useRef<{ readonly kind: "seat" | "region"; readonly id: string } | null>(null);
  useEffect(() => {
    const next = removeNext.current;
    if (next === null) return;
    removeNext.current = null;
    const holder = [...(root.current?.querySelectorAll<HTMLElement>(`[data-testid="quick-thread-${next.kind}"]`) ?? [])].find(
      (entry) => (next.kind === "seat" ? entry.dataset.seat : entry.dataset.region) === next.id,
    );
    claimFocus(holder?.querySelector("button"), "gesture");
  }, [chosen, regionsChosen]);
  // Cancel on the confirm gives the keyboard to the message once the input is drawn again: while it is hidden a focus is ignored.
  const messageNext = useRef(false);
  const pickingNow = useRef(picking);
  pickingNow.current = picking;
  // The seat field takes the keyboard as it appears: on open with no seat chosen, and when it is brought back.
  const setSeatField = useCallback((element: HTMLInputElement | null) => {
    seatField.current = element;
    if (element) claimFocus(element, "open");
  }, []);
  const describedBy = useId();
  const sentLine = useId();
  const waitingText = useId();

  const say = (text: string): void => setSpoken((last) => ({ text, turn: last.turn + 1 }));
  const speak = (change: QuickThreadChange): void => say(quickThreadSpoken(change));
  const setSeats = (ids: ReadonlyArray<string>): void => setQuickThreadSeats(canvasName, ids);
  const setRegions = (next: ReadonlyArray<RegionPick>): void => setQuickThreadRegions(canvasName, next);

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
    speak({ kind: "added", seat: seat.name, chosen: chosen.length + 1 + regionsChosen.length, regions: regionsChosen.length });
  };

  /** A region becomes a recipient; chosen again, it takes the new limit on its own token. */
  const addRegion = (region: QuickThreadRegion): void => {
    if (busy) return;
    const next = chooseRegion(regionsChosen, region.id, region.limit);
    setRegions(next);
    const held = next.find((entry) => entry.regionId === region.id);
    if (held === undefined) return;
    const reached = read(picksOf([], [held])).count;
    speak({ kind: "added", seat: regionTokenSpoken(region.name, held, reached), chosen: chosen.length + next.length, regions: next.length });
  };

  const removeRegion = (held: RegionPick): void => {
    if (busy) return;
    const name = regionOfId.get(held.regionId)?.name ?? "Region";
    const next = regionsChosen.filter((entry) => entry !== held);
    setRegions(next);
    if (chosen.length === 0 && next.length === 0) setSettled([]);
    speak({ kind: "removed", seat: name, chosen: chosen.length + next.length, regions: next.length });
  };

  const toggleRegionLimit = (held: RegionPick, limit: Limit): void => {
    if (busy) return;
    setRegions(regionsChosen.map((entry) => (entry === held ? toggleLimit(entry, limit) : entry)));
  };

  const remove = (seat: QuickThreadSeat): void => {
    if (busy) return;
    setSeats(chosen.filter((held) => held.id !== seat.id).map((held) => held.id));
    const { [seat.id]: _gone, ...rest } = unsent;
    keepQuickThread(canvasName, { unsent: rest });
    // With the last seat off, a send that reached only some is over: nothing of it is carried into the next.
    if (chosen.length === 1 && regionsChosen.length === 0) setSettled([]);
    speak({ kind: "removed", seat: seat.name, chosen: chosen.length - 1 + regionsChosen.length, regions: regionsChosen.length });
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

  /** Pick an option: a region becomes a recipient, a chosen seat comes off, a new seat is chipped. */
  const pick = (option: QuickThreadOption, stay: boolean): void => {
    if (busy) return;
    if (option.kind === "region") {
      addRegion(option);
      if (!stay) return toMessage();
      setAdding(true);
      if (query !== "") {
        setQuery("");
        setExplicit(undefined);
      }
      return;
    }
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
      {
        query,
        active: active !== undefined,
        ...(active === undefined ? {} : { activeKind: active.kind }),
        chosen: chosen.length + regionsChosen.length,
        narrowed: narrowed !== undefined,
      },
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
      case "narrow":
        if (active?.kind === "region") {
          const whole = regionOfId.get(active.id);
          if (whole !== undefined) narrow(whole);
        }
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
        // The last token in the row: a region, which sits after the seats, else the last seat.
        const lastRegion = regionsChosen.at(-1);
        const last = chosen.at(-1);
        if (lastRegion) removeRegion(lastRegion);
        else if (last) remove(last);
        break;
      }
    }
    return true;
  };

  const handOver = (all: ReadonlyArray<Settled>): void => {
    setReceiptOf(undefined);
    onSent?.(all.map(({ seatId, threadId, arrival }) => ({ seatId, threadId, arrival })));
  };

  // A send with a region is over: nothing of its choice is kept, the words stay.
  const finishBroadcast = (sent: ReadonlyArray<NewThread>): void => {
    fixed.current = undefined;
    awaiting.current = false;
    setBroadcastResult(undefined);
    setConfirming(undefined);
    keepQuickThread(canvasName, { seats: [], regions: [], unsent: {} });
    setSettled([]);
    onSent?.(sent);
  };

  const onBroadcastSent = (outcome: NewThreadsOutcome): void => {
    const held = fixed.current;
    if (held === undefined) return;
    awaiting.current = false;
    // Seats sent again leave the failures; the ones that already had it stay counted.
    const sent = [...held.sent, ...outcome.sent];
    fixed.current = { seats: held.seats, sent };
    setConfirming(undefined);
    const receiptNow = broadcastReceipt(held.seats, { sent, failed: outcome.failed });
    // Every seat has it, none waiting where a receipt would say so: it closes.
    if (outcome.failed.length === 0 && (!receipt || receiptNow.later.length === 0)) return finishBroadcast(sent);
    setBroadcastResult(receiptNow);
    say(broadcastReceiptSpoken(receiptNow));
  };

  /**
   * Hand a fixed set to the input's send. One at a time: a second press before the
   * first has rendered busy is ignored, so a double press cannot send twice or
   * reset the tally. If the input says it did not start, nothing is awaited and
   * the operator is told, instead of a button that looks pressable and does nothing.
   */
  const sendFixed = (to: ReadonlyArray<BroadcastSeat>): void => {
    if (awaiting.current || sendTo.current === null) return;
    awaiting.current = true;
    void sendTo.current(to.map((seat) => ({ seatId: seat.nodeId, name: seat.name })))
      .then((started) => {
        if (started) return;
        awaiting.current = false;
        say("Nothing was sent. The message is not ready to send.");
      })
      .catch((error: unknown) => {
        // The send itself threw (a link failure): nothing is awaited, and the confirm or receipt gives the press back.
        awaiting.current = false;
        say(`Nothing was sent. ${error instanceof Error ? error.message : String(error)}`);
      });
  };

  /**
   * Send goes to the seats the confirm fixed, whatever the choice reads by now.
   * The seats are fixed, not the mail: the draft is read as it is sent, and it
   * cannot change meanwhile, since the input is hidden under the confirm and
   * the receipt and the draft belongs to this window alone.
   */
  const confirmSend = (): void => {
    if (confirming === undefined || awaiting.current) return;
    fixed.current = { seats: confirming.seats, sent: [] };
    sendFixed(confirming.seats);
  };

  const sendAgain = (): void => {
    if (fixed.current === undefined || broadcastResult === undefined) return;
    sendFixed(broadcastResult.notSent);
  };

  const cancelConfirm = (): void => {
    fixed.current = undefined;
    messageNext.current = true;
    setConfirming(undefined);
  };
  useEffect(() => {
    if (confirming !== undefined || !messageNext.current) return;
    messageNext.current = false;
    claimFocus(message.current, "gesture");
  }, [confirming]);

  // Back to the draft with the seats that were left out as seats of their own: Send asks again with them counted.
  const addLeftOut = (): void => {
    if (confirming === undefined) return;
    const ids = confirming.unread.map((seat) => seat.nodeId);
    setSeats([...chosen.map((held) => held.id), ...ids]);
    speak({ kind: "added", seat: seatCount(ids.length), chosen: chosen.length + ids.length + regionsChosen.length, regions: regionsChosen.length });
    cancelConfirm();
  };

  // A send that ended with no word of its outcome (the draft could not be carried): the confirm gives the draft back, where the failure is said.
  useEffect(() => {
    if (busy || !awaiting.current) return;
    awaiting.current = false;
    if (confirming === undefined) return;
    fixed.current = undefined;
    setConfirming(undefined);
  }, [busy, confirming, broadcastResult]);

  const onSentAll = (outcome: NewThreadsOutcome): void => {
    if (fixed.current !== undefined) return onBroadcastSent(outcome);
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
    // Escape on the confirm is Cancel: the draft as it was.
    if (confirming !== undefined) {
      if (!busy) cancelConfirm();
      return true;
    }
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
  const narrowSpoken = keyAria("inQuickThread.narrow")?.split(" ")[0];

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
                  {option.limit !== undefined ? (
                    <span className="quick-thread__option-region">, {limitWord(option.limit)}</span>
                  ) : null}
                  {/* Heard as "Design System, region, 6 seats": Enter on it chooses the region; the narrow key takes its seats one by one. */}
                  <span className="sr-only">, region, </span>
                  <span className="quick-thread__option-count">{seatCount(option.seats)}</span>
                  {/* Said as the option becomes active: a field's description is read once, on focus. */}
                  {narrowSpoken === undefined ? null : (
                    <span className="sr-only">. Enter chooses the whole region, {narrowSpoken} picks its seats</span>
                  )}
                  {/* The pointer's way to the region's seats; the keyboard has its own key, so this is not a stop. */}
                  <IconButton
                    size="xs"
                    tabIndex={-1}
                    aria-hidden
                    className="quick-thread__option-narrow"
                    data-testid="quick-thread-narrow"
                    title={`Pick seats in ${option.name}`}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                    }}
                    onClick={(event) => {
                      event.stopPropagation();
                      const whole = regionOfId.get(option.id);
                      if (whole !== undefined) narrow(whole);
                    }}
                  >
                    <ChevronRight size={12} strokeWidth={2} />
                  </IconButton>
                </div>
              )
            }
          />
          <span id={describedBy} className="sr-only">
            {[
              chosenSeatsSpoken(chosen.length, regionsChosen.length),
              anotherSpoken === undefined ? undefined : `${anotherSpoken} adds another`,
              // The narrow key is said where a region is the active option; its chevron is for the pointer.
              active?.kind === "region" && narrowSpoken !== undefined ? `Enter chooses the whole region, ${narrowSpoken} picks its seats` : undefined,
            ]
              .filter((line) => line !== undefined)
              .join(". ")}
          </span>
        </div>
      ) : null}
      {chosen.length + regionsChosen.length > 0 ? (
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
          <ul role="list" aria-label={regionsChosen.length > 0 ? "Chosen seats and regions" : "Chosen seats"} className="quick-thread__seats">
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
                    else removeNext.current = { kind: "seat", id: neighbour.id };
                  }}
                >
                  <X size={10} strokeWidth={2} />
                </IconButton>
              </li>
            ))}
            {regionsChosen.map((held) => {
              const region = regionOfId.get(held.regionId);
              if (region === undefined) return null;
              return (
                <RegionToken
                  key={held.regionId}
                  region={region}
                  pick={held}
                  count={read(picksOf([], [held])).count}
                  total={read(picksOf([], [{ regionId: held.regionId, doing: [], needs: [] }])).count}
                  countAlone={(limit) => read(picksOf([], [chooseRegion([], held.regionId, limit)[0]!])).count}
                  onToggle={(limit) => toggleRegionLimit(held, limit)}
                  onRemove={() => {
                    if (busy) return;
                    // As a seat's control: the keyboard goes to the next token, else the one before, else the seat field.
                    const at = regionsChosen.indexOf(held);
                    const next = regionsChosen[at + 1];
                    const before = regionsChosen[at - 1];
                    const lastSeat = chosen.at(-1);
                    const byPointer = recentGestureKind() === "pointer";
                    removeRegion(held);
                    if (next === undefined && before === undefined && lastSeat === undefined) claimFocus(seatField.current, "gesture");
                    else if (byPointer) claimFocus(picking ? seatField.current : message.current, "gesture");
                    else if (next !== undefined) removeNext.current = { kind: "region", id: next.regionId };
                    else if (before !== undefined) removeNext.current = { kind: "region", id: before.regionId };
                    else if (lastSeat !== undefined) removeNext.current = { kind: "seat", id: lastSeat.id };
                  }}
                />
              );
            })}
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

  // One frame for the input and for the receipt, and the live region first in it: it stays the same element
  // when the receipt takes the input's place, so the line is said. A region that arrives with its text is not.
  if (receiptOf !== undefined) {
    const waiting = receiptOf.filter((entry) => entry.arrival === "waiting");
    return (
      <div ref={root} className="quick-thread quick-thread--receipt" data-testid="quick-thread-receipt">
        {live}
        <p id={sentLine} className="quick-thread__sent">
          Sent to {seatCount(receiptOf.length)}
        </p>
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
              <span className="sr-only">{entry.arrival === "waiting" ? ", waiting" : ", has it"}</span>
            </li>
          ))}
        </ul>
        <p id={waitingText} className="quick-thread__waiting" data-testid="quick-thread-waiting-line">
          {waitingLine(waiting)}
        </p>
        <div className="quick-thread__done">
          {/* It takes the keyboard as the input goes, and is read with the result it closes. */}
          <Button
            ref={claimFocusOnMount}
            size="sm"
            variant="chrome"
            data-testid="quick-thread-done"
            aria-describedby={`${sentLine} ${waitingText}`}
            onClick={() => handOver(receiptOf)}
          >
            Done
          </Button>
        </div>
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
        if (event.target === message.current && chosen.length === 0 && regionsChosen.length === 0 && keyIs(event, "inThread.send")) speak({ kind: "noSeat" });
      }}
    >
      {live}
      {confirming !== undefined ? (
        <BroadcastConfirm
          seats={confirming.seats}
          unread={confirming.unread}
          regionOf={regionOf}
          sending={busy}
          onCancel={cancelConfirm}
          onConfirm={confirmSend}
          onAddThem={addLeftOut}
        />
      ) : null}
      {broadcastResult !== undefined ? (
        <BroadcastReceiptView
          receipt={broadcastResult}
          regionOf={regionOf}
          sending={busy}
          onSendAgain={sendAgain}
          onDone={() => finishBroadcast(fixed.current?.sent ?? [])}
        />
      ) : null}
      {/* Kept mounted under the confirm and the receipt, so Cancel gives the draft back as it was and a send can go again. */}
      <div className="quick-thread__composer" hidden={confirming !== undefined || broadcastResult !== undefined}>
        <ThreadComposer
          mode="new"
          canvasName={canvasName}
          recipients={recipients}
          recipientsRow={row}
          onSentAll={onSentAll}
          onSending={setBusy}
          // A send with a region asks first, and sends to the seats the confirm showed.
          holds={() => {
            if (!withRegion) return false;
            setConfirming({ seats: set.seats, unread: set.unread });
            // The confirm is said as it opens, through the live line that stays mounted.
            say(confirmSpoken(set.seats.length, set.seats.filter((seat) => !seat.running).length, set.unread.length));
            return true;
          }}
          sender={sendTo}
          held={held}
          fieldRef={message}
          // With the picker up the keyboard starts in it; with seats already chosen, in the message.
          yields={() => pickingNow.current}
        />
      </div>
    </div>
  );
}
