import { useMemo, useState } from "react";
import { use$ } from "@legendapp/state/react";
import { Layers, Plus } from "lucide-react";
import { state$ } from "../../lib/state";
import { summarizeSlots, type SlotSummary } from "../../lib/command-groups";
import { modKeyGlyph } from "../../lib/platform";
import { nodeTitle } from "../../lib/presentation";
import "./RtsBottomBar.css";

const slotLine = (slot: SlotSummary): string =>
  slot.taken ? `${slot.index + 1}: ${slot.detail}, replaced on save` : `${slot.index + 1}: empty`;

/**
 * "save to group" for the multi-select menu: slots 1 to 9, each showing
 * whether it is taken and what it holds, then a new group. Picking a slot
 * saves the selection there (same as ⌘N) and replaces what was in it; a new
 * group takes the next free slot, or joins the groups past nine, which have
 * no key.
 */
export function SaveToGroupPicker({
  count,
  onPick,
}: {
  /** Selected node count, for the hint line. */
  readonly count: number;
  readonly onPick: (target: number | "new") => void;
}) {
  const hotbarSlots = use$(state$.hotbarSlots);
  const doc = use$(state$.doc);
  const [hovered, setHovered] = useState<number | "new" | null>(null);
  const summaries = useMemo(() => {
    const byId = new Map(doc.nodes.map((node) => [node.id, node] as const));
    return summarizeSlots(hotbarSlots, (id) => {
      const node = byId.get(id);
      return node ? nodeTitle(node) : id.slice(0, 8);
    });
  }, [hotbarSlots, doc]);

  const nodes = `${count} node${count === 1 ? "" : "s"}`;
  const hoveredSlot = hovered === null || hovered === "new" ? undefined : summaries[hovered];
  const hint =
    hovered === "new"
      ? "new group: the next free slot, else past nine without a key"
      : hoveredSlot
        ? slotLine(hoveredSlot)
        : `${nodes}, ${modKeyGlyph()}1 to 9 does the same`;

  return (
    <div className="save-group" role="group" aria-label={`Save ${nodes} to a command group`}>
      <div className="save-group__head">
        <span className="canvas-action-menu__icon" aria-hidden>
          <Layers size={14} />
        </span>
        <span className="save-group__text">
          <strong>save to group</strong>
          <small aria-live="polite">{hint}</small>
        </span>
      </div>
      <div className="save-group__slots" onMouseLeave={() => setHovered(null)}>
        {summaries.map((slot) => (
          <button
            key={slot.index}
            type="button"
            className="save-group__slot"
            data-taken={slot.taken ? (slot.held ? "held" : "lease") : undefined}
            aria-label={`Save ${nodes} to group ${slot.index + 1}, ${
              slot.taken ? `replaces ${slot.detail}` : "empty"
            }`}
            title={slotLine(slot)}
            onMouseEnter={() => setHovered(slot.index)}
            onFocus={() => setHovered(slot.index)}
            onBlur={() => setHovered(null)}
            onClick={() => onPick(slot.index)}
          >
            {slot.index + 1}
          </button>
        ))}
        <button
          type="button"
          className="save-group__slot"
          data-new="true"
          aria-label={`Save ${nodes} as a new group`}
          title="A new group: the next free slot, else past nine without a key"
          onMouseEnter={() => setHovered("new")}
          onFocus={() => setHovered("new")}
          onBlur={() => setHovered(null)}
          onClick={() => onPick("new")}
        >
          <Plus size={11} strokeWidth={2} aria-hidden />
        </button>
      </div>
    </div>
  );
}
