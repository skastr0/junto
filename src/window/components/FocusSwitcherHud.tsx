import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { use$ } from "@legendapp/state/react";
import { asNodeId, type Seat } from "@shared/model";
import { claimFocus } from "../lib/focus-ownership";
import {
  cancelFocusSwitcher,
  commitFocusSwitcher,
  focusSwitcher$,
  selectFocusSwitcherIndex,
  type FocusSwitcherEntry,
  type FocusSwitcherSession,
} from "../lib/focus-switcher";
import { useModalLayer } from "../lib/modal-stack";
import { regionTrails, type RegionStep } from "../lib/region-path";
import { seatSaying } from "../lib/seat-line";
import { state$ } from "../lib/state";
import { useCanvas } from "../lib/use-model";
import { accentColor } from "../lib/theme";
import { RegionCrumb } from "./RegionCrumb";
import { SeatRingView, useSeatGlanceOf } from "./SeatRing";
import { Kbd } from "./ui";

const optionId = (nodeId: string): string => `focus-switcher-${nodeId}`;

// The strip's choices, shared by every card so a selection move re-renders
// only the cards whose `selected` flipped: the entries, nodes and trails are
// frozen for the session, and these never change identity.
const selectEntry = (index: number): void => {
  selectFocusSwitcherIndex(index);
};
const commitEntry = (index: number): void => {
  selectFocusSwitcherIndex(index);
  commitFocusSwitcher();
};

/**
 * An agent's card: the seat's own ring and portrait, its name, the line its
 * seat is saying, and where it sits. Read aloud as agent, state, region: the
 * name comes from those three lines, not from a label, which the tooltip
 * layer would show over the card. Memoized: stepping the strip with Cmd+` on
 * a factory board must not repaint every card's ring.
 */
const SwitcherCard = memo(function SwitcherCard({
  entry,
  node,
  trail,
  selected,
  index,
  total,
  onSelect,
  onCommit,
}: {
  readonly entry: FocusSwitcherEntry;
  readonly node: Seat;
  readonly trail: ReadonlyArray<RegionStep> | undefined;
  readonly selected: boolean;
  readonly index: number;
  /** The catalog's size, for the option's place in the listbox. */
  readonly total: number;
  readonly onSelect: (index: number) => void;
  readonly onCommit: (index: number) => void;
}) {
  const glance = useSeatGlanceOf(node);
  const saying = seatSaying({
    activity: glance.activity,
    signal: glance.signal?.signal,
    failure: glance.failure,
    health: glance.health,
  });
  // An AI reading is named as one, as everywhere else: never the agent's own claim.
  const line =
    saying.kind === "signal" ? saying.word : saying.kind === "reading" ? `AI reads ${saying.text}` : saying.text;
  const id = optionId(entry.nodeId);
  return (
    <div
      id={id}
      role="option"
      aria-selected={selected}
      aria-setsize={total}
      aria-posinset={index + 1}
      aria-labelledby={`${id}-name ${id}-state${trail ? ` ${id}-region` : ""}`}
      data-node-id={entry.nodeId}
      data-testid={selected ? "focus-switcher-selected" : undefined}
      className={[
        "focus-switcher__card",
        selected ? "focus-switcher__card--selected" : "",
        entry.current ? "focus-switcher__card--current" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      // Only a pointer that really moved: a card scrolled under a resting pointer is not a choice.
      onPointerMove={() => onSelect(index)}
      onClick={() => onCommit(index)}
    >
      {entry.hotbarSlot !== null ? (
        <span className="focus-switcher__slot">{entry.hotbarSlot}</span>
      ) : null}
      <span className="focus-switcher__mark">
        <SeatRingView node={node} px={44} glance={glance} />
      </span>
      <span
        id={`${id}-name`}
        className="focus-switcher__title"
        style={node.color ? { color: accentColor(node.color) } : undefined}
      >
        {entry.title}
      </span>
      <span id={`${id}-state`} className="focus-switcher__line">
        {line}
      </span>
      {trail ? (
        <span id={`${id}-region`} className="focus-switcher__region">
          <RegionCrumb trail={trail} testId="focus-switcher-crumb" />
        </span>
      ) : null}
    </div>
  );
});

// One card's slot in the strip: the card's 124px plus the strip's 6px gap
// (styles.css .focus-switcher__card / .focus-switcher__strip). Every card is
// the same width, so a card's place is its index times this pitch.
const CARD_PITCH = 130;
const CARD_WIDTH = 124;
// Cards mounted past each edge of the viewport, so a scroll or a selection
// step finds its card already drawn well before it can be seen arriving.
const OVERSCAN = 8;
// The selection's window is sticky: it recentres only after the selection
// has drifted most of a viewport away, so a held-Cmd sweep does not mount
// and unmount a boundary card on every step. The radius covers the widest
// strip (920px ≈ 7 cards) plus overscan and margin; the drift bound keeps
// the whole post-scroll viewport inside it through the slide.
const SELECT_RADIUS = 24;
const SELECT_DRIFT = 8;

/**
 * The switcher's shell, an operator modal: the shared dim and frame, above
 * every working modal. The list holds the keyboard while it is up, so a
 * screen reader follows the chosen agent, and closing returns the keyboard
 * to where it was. The keys themselves are rows in the key table.
 */
function SwitcherShell({ session }: { readonly session: FocusSwitcherSession }) {
  const canvas = useCanvas(use$(state$.canvasName));
  const trails = useMemo(() => regionTrails(canvas), [canvas]);
  const frameRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // The strip's scroll window: which slice of the catalog is mounted. The
  // rest of the strip is two spacers the width of the unmounted cards, so the
  // scroll extent, the scrollbar and every card's place are exactly what they
  // were when all of them mounted — only the cards near the eye cost anything.
  const [view, setView] = useState({ left: 0, width: 0 });
  // The mounted range's centre on the selection, and the index the scroll
  // effect last served: while they disagree a scroll is still owed, and the
  // window is the selection's alone — the pre-scroll position is never
  // painted (the scroll lands in a layout effect), so it needs no cards.
  const [selCenter, setSelCenter] = useState(session.selectedIndex);
  const scrolledTo = useRef(-1);
  if (Math.abs(session.selectedIndex - selCenter) > SELECT_DRIFT) {
    setSelCenter(session.selectedIndex);
  }

  const layer = useModalLayer({
    layer: "operator",
    containerRef: frameRef,
    onEscape: cancelFocusSwitcher,
    onClose: cancelFocusSwitcher,
    // Nothing else in here takes the keyboard: Tab stays on the list.
    onKeyDown: (event) => {
      if (event.key === "Tab") event.preventDefault();
    },
  });

  useEffect(() => {
    claimFocus(listRef.current, "open", { preventScroll: true });
  }, []);

  // Measure before the first paint, then follow the strip's own box.
  useLayoutEffect(() => {
    const strip = listRef.current;
    if (!strip) return;
    const measure = (): void =>
      setView((current) =>
        current.width === strip.clientWidth && current.left === strip.scrollLeft
          ? current
          : { left: strip.scrollLeft, width: strip.clientWidth },
      );
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(strip);
    return () => observer.disconnect();
  }, []);

  const selected = session.entries[session.selectedIndex];
  const selectedId = selected ? optionId(selected.nodeId) : undefined;
  // Keep the chosen card in view exactly where scrollIntoView's "nearest"
  // would put it — the strip is the only thing that scrolls (body overflow is
  // hidden, the frame is not a scroller, and neither has padding or
  // scroll-padding) — but a card's place is its index times the pitch, so
  // this is arithmetic, not a layout read. A layout effect, so the scroll is
  // in place before the frame that shows the new selection is painted.
  useLayoutEffect(() => {
    const strip = listRef.current;
    scrolledTo.current = session.selectedIndex;
    if (!strip) return;
    const left = session.selectedIndex * CARD_PITCH;
    const right = left + CARD_WIDTH;
    const viewLeft = strip.scrollLeft;
    const viewRight = viewLeft + strip.clientWidth;
    if (left < viewLeft) strip.scrollLeft = left;
    else if (right > viewRight) strip.scrollLeft = right - strip.clientWidth;
  }, [session.selectedIndex]);

  const total = session.entries.length;
  // The strip's live box, not the last reported one: a scroll the layout
  // effect just made is already in scrollLeft, so the window never unions a
  // stale edge back in. The state above stays as the re-render trigger for
  // hand scrolls and resizes; these reads hit clean layout.
  const liveLeft = listRef.current?.scrollLeft ?? view.left;
  const liveWidth = listRef.current?.clientWidth || view.width;
  const firstVisible = Math.max(0, Math.floor(liveLeft / CARD_PITCH) - OVERSCAN);
  const lastVisible = Math.min(total, Math.ceil((liveLeft + liveWidth) / CARD_PITCH) + OVERSCAN);
  const selWindowStart = Math.max(0, selCenter - SELECT_RADIUS);
  const selWindowEnd = Math.min(total, selCenter + SELECT_RADIUS + 1);
  // While a scroll to the selection is still owed the window is the
  // selection's alone: the frame that paints next is already the scrolled
  // one, and its viewport sits inside the selection's window. Once the
  // scroll has landed the viewport's own overscan joins back in, so a
  // hand-scrolled strip keeps its cards too.
  const scrollOwed = session.selectedIndex !== scrolledTo.current;
  const windowStart = scrollOwed ? selWindowStart : Math.min(firstVisible, selWindowStart);
  const windowEnd = scrollOwed ? selWindowEnd : Math.max(lastVisible, selWindowEnd);

  return createPortal(
    <div className="focus-switcher" data-layer="operator" data-testid="focus-switcher" onKeyDown={layer.onKeyDown}>
      <button
        type="button"
        data-layer-backdrop
        // The dim is a pointer target only: Escape is the named way out.
        aria-hidden="true"
        tabIndex={-1}
        onClick={cancelFocusSwitcher}
      />
      <div ref={frameRef} className="layer-frame focus-switcher__frame">
        <div
          ref={listRef}
          className="focus-switcher__strip"
          role="listbox"
          aria-label="Agents, the ones that need you first"
          aria-orientation="horizontal"
          aria-activedescendant={selectedId}
          tabIndex={-1}
          onScroll={(event) => {
            const strip = event.currentTarget;
            setView((current) =>
              current.left === strip.scrollLeft && current.width === strip.clientWidth
                ? current
                : { left: strip.scrollLeft, width: strip.clientWidth },
            );
          }}
        >
          {windowStart > 0 ? (
            <div
              aria-hidden
              style={{ flex: "0 0 auto", width: windowStart * CARD_PITCH - 6 }}
            />
          ) : null}
          {session.entries.slice(windowStart, windowEnd).map((entry, offset) => {
            const index = windowStart + offset;
            const node = canvas.nodes.get(asNodeId(entry.nodeId));
            // Deleted while the switcher was up: nothing left to open.
            if (node?.kind !== "agent") return null;
            return (
              <SwitcherCard
                key={entry.nodeId}
                entry={entry}
                node={node}
                trail={trails.get(entry.nodeId)}
                selected={index === session.selectedIndex}
                index={index}
                total={total}
                onSelect={selectEntry}
                onCommit={commitEntry}
              />
            );
          })}
          {windowEnd < total ? (
            <div
              aria-hidden
              style={{ flex: "0 0 auto", width: (total - windowEnd) * CARD_PITCH - 6 }}
            />
          ) : null}
        </div>
        <div className="focus-switcher__footer">
          <span className="focus-switcher__hint">
            <Kbd>⌘</Kbd>
            <Kbd>`</Kbd>
            next
          </span>
          <span className="focus-switcher__hint">
            <Kbd>esc</Kbd>
            cancel
          </span>
          <span className="focus-switcher__hint">
            let go of <Kbd>⌘</Kbd> to open
          </span>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * The agent switcher, up while Cmd is held. The catalog is frozen for the
 * session; a click or letting go of Cmd opens the chosen agent; Escape or
 * the dim cancels.
 */
export function FocusSwitcherHud() {
  const session = use$(focusSwitcher$.session);
  return session ? <SwitcherShell session={session} /> : null;
}
