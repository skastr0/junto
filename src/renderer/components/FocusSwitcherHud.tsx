import { createPortal } from "react-dom";
import { use$ } from "@legendapp/state/react";
import {
  cancelFocusSwitcher,
  commitFocusSwitcher,
  focusSwitcher$,
  selectFocusSwitcherIndex,
  type FocusSwitcherEntry,
} from "../lib/focus-switcher";
import { Chip, Eyebrow, Kbd } from "./ui";

const kindTone = (
  kind: string,
): "amber" | "cyan" | "violet" | "steel" | "green" => {
  if (kind === "agent") return "amber";
  if (kind === "terminal" || kind === "page" || kind === "pad") return "cyan";
  if (kind === "task" || kind === "note") return "steel";
  if (kind === "requests" || kind === "board") return "violet";
  if (kind === "artifacts" || kind === "sheet") return "green";
  return "steel";
};

function SwitcherCard({
  entry,
  selected,
  onSelect,
  onCommit,
}: {
  readonly entry: FocusSwitcherEntry;
  readonly selected: boolean;
  readonly onSelect: () => void;
  readonly onCommit: () => void;
}) {
  return (
    <button
      type="button"
      id={`focus-switcher-${entry.nodeId}`}
      role="option"
      aria-selected={selected}
      data-node-id={entry.nodeId}
      data-testid={selected ? "focus-switcher-selected" : undefined}
      className={[
        "focus-switcher__card",
        selected ? "focus-switcher__card--selected" : "",
        entry.current ? "focus-switcher__card--current" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      onMouseEnter={onSelect}
      onClick={onCommit}
    >
      <div className="focus-switcher__card-meta">
        <Chip tone={kindTone(entry.kindLabel)}>{entry.kindLabel}</Chip>
        {entry.hotbarSlot !== null ? (
          <span className="focus-switcher__slot">{entry.hotbarSlot}</span>
        ) : null}
        {entry.parked && !entry.current ? (
          <span className="focus-switcher__parked">open</span>
        ) : null}
      </div>
      <span className="focus-switcher__title">{entry.title}</span>
    </button>
  );
}

/**
 * Hold-Control HUD over the live focus modal. Catalog is frozen for the
 * session; click or Control-release commits; Escape / backdrop cancels.
 */
export function FocusSwitcherHud() {
  const session = use$(focusSwitcher$.session);
  if (!session) return null;

  const selected = session.entries[session.selectedIndex];

  return createPortal(
    <div
      className="focus-switcher"
      role="listbox"
      aria-label="Switch focus model"
      aria-activedescendant={selected ? `focus-switcher-${selected.nodeId}` : undefined}
      data-testid="focus-switcher"
    >
      <button
        type="button"
        className="focus-switcher__backdrop"
        aria-label="Cancel switcher"
        tabIndex={-1}
        onClick={cancelFocusSwitcher}
      />
      <div className="focus-switcher__panel">
        <div className="focus-switcher__header">
          <Eyebrow tone="amber">switch</Eyebrow>
          <span className="focus-switcher__count">
            {session.entries.length} models
          </span>
        </div>
        <div className="focus-switcher__strip">
          {session.entries.map((entry, index) => (
            <SwitcherCard
              key={entry.nodeId}
              entry={entry}
              selected={index === session.selectedIndex}
              onSelect={() => {
                selectFocusSwitcherIndex(index);
              }}
              onCommit={() => {
                selectFocusSwitcherIndex(index);
                commitFocusSwitcher();
              }}
            />
          ))}
        </div>
        <div className="focus-switcher__footer">
          <span className="focus-switcher__hint">
            <Kbd>ctrl</Kbd>
            <Kbd>tab</Kbd>
            cycle
          </span>
          <span className="focus-switcher__hint">
            <Kbd>1–9</Kbd>
            hotbar
          </span>
          <span className="focus-switcher__hint">
            <Kbd>esc</Kbd>
            cancel
          </span>
          <span className="focus-switcher__hint">
            release <Kbd>ctrl</Kbd> to open
          </span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
