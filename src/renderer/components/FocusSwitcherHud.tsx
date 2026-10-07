import { useEffect, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import { use$ } from "@legendapp/state/react";
import type { CanvasNode } from "@shared/canvas";
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
import { accentColor } from "../lib/theme";
import { RegionCrumb } from "./RegionCrumb";
import { SeatRingView, useSeatGlance } from "./SeatRing";
import { Kbd } from "./ui";

const optionId = (nodeId: string): string => `focus-switcher-${nodeId}`;

/**
 * An agent's card: the seat's own ring and portrait, its name, the line its
 * seat is saying, and where it sits. Read aloud as agent, state, region: the
 * name comes from those three lines, not from a label, which the tooltip
 * layer would show over the card.
 */
function SwitcherCard({
  entry,
  node,
  trail,
  selected,
  onSelect,
  onCommit,
}: {
  readonly entry: FocusSwitcherEntry;
  readonly node: CanvasNode;
  readonly trail: ReadonlyArray<RegionStep> | undefined;
  readonly selected: boolean;
  readonly onSelect: () => void;
  readonly onCommit: () => void;
}) {
  const glance = useSeatGlance(node);
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
      onPointerMove={onSelect}
      onClick={onCommit}
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
}

/**
 * The switcher's shell, an operator modal: the shared dim and frame, above
 * every working modal. The list holds the keyboard while it is up, so a
 * screen reader follows the chosen agent, and closing returns the keyboard
 * to where it was. The keys themselves are rows in the key table.
 */
function SwitcherShell({ session }: { readonly session: FocusSwitcherSession }) {
  const doc = use$(state$.doc);
  const trails = useMemo(() => regionTrails(doc), [doc]);
  const frameRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

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

  const selected = session.entries[session.selectedIndex];
  const selectedId = selected ? optionId(selected.nodeId) : undefined;
  useEffect(() => {
    if (selectedId) document.getElementById(selectedId)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [selectedId]);

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
        >
          {session.entries.map((entry, index) => {
            const node = doc.nodes.find((candidate) => candidate.id === entry.nodeId);
            // Deleted while the switcher was up: nothing left to open.
            if (!node) return null;
            return (
              <SwitcherCard
                key={entry.nodeId}
                entry={entry}
                node={node}
                trail={trails.get(entry.nodeId)}
                selected={index === session.selectedIndex}
                onSelect={() => {
                  selectFocusSwitcherIndex(index);
                }}
                onCommit={() => {
                  selectFocusSwitcherIndex(index);
                  commitFocusSwitcher();
                }}
              />
            );
          })}
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
