import { createPortal } from "react-dom";
import { use$ } from "@legendapp/state/react";
import {
  cancelFocusSwitcher,
  commitFocusSwitcher,
  focusSwitcher$,
  selectFocusSwitcherIndex,
  type FocusSwitcherEntry,
} from "../lib/focus-switcher";
import type { CanvasNode } from "@shared/canvas";
import { nodeTypeLabel } from "../lib/presentation";
import { seatSaying } from "../lib/seat-line";
import { state$ } from "../lib/state";
import { accentColor } from "../lib/theme";
import { NodeKindMark } from "./NodeKindMark";
import { SeatRingView, useSeatGlance } from "./SeatRing";
import { Kbd } from "./ui";

/** An agent's card: the seat's own ring and portrait, its name, the line its seat is saying. */
function AgentFace({ node, title }: { readonly node: CanvasNode; readonly title: string }) {
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
  return (
    <>
      <span className="focus-switcher__mark">
        <SeatRingView node={node} px={44} glance={glance} />
      </span>
      <span
        className="focus-switcher__title"
        style={node.color ? { color: accentColor(node.color) } : undefined}
      >
        {title}
      </span>
      <span className="focus-switcher__line">{line}</span>
    </>
  );
}

function SwitcherCard({
  entry,
  node,
  selected,
  onSelect,
  onCommit,
}: {
  readonly entry: FocusSwitcherEntry;
  readonly node: CanvasNode | undefined;
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
      {entry.hotbarSlot !== null ? (
        <span className="focus-switcher__slot">{entry.hotbarSlot}</span>
      ) : null}
      {node?.ether?.entity?.kind === "agent" ? (
        <AgentFace node={node} title={entry.title} />
      ) : (
        <>
          {node ? <NodeKindMark node={node} className="focus-switcher__mark focus-switcher__mark--kind" iconSize={20} /> : null}
          <span className="focus-switcher__title">{entry.title}</span>
          <span className="focus-switcher__line">{node ? nodeTypeLabel(node) : entry.kindLabel}</span>
        </>
      )}
    </button>
  );
}

/**
 * The switcher, up while Cmd is held over the live focus modal. Catalog is
 * frozen for the session; a click or letting go of Cmd opens the selected
 * card; Escape or the backdrop cancels.
 */
export function FocusSwitcherHud() {
  const session = use$(focusSwitcher$.session);
  const nodes = use$(state$.doc.nodes);
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
        <div className="focus-switcher__strip">
          {session.entries.map((entry, index) => (
            <SwitcherCard
              key={entry.nodeId}
              entry={entry}
              node={nodes.find((candidate) => candidate.id === entry.nodeId)}
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
