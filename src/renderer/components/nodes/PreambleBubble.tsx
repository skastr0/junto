import { useLayoutEffect, useRef, type CSSProperties, type RefObject } from "react";
import { use$ } from "@legendapp/state/react";
import { useStore } from "@xyflow/react";
import {
  Activity,
  CircleCheck,
  CircleDot,
  Flag,
  Mail,
  MailWarning,
  PackageCheck,
  Send,
  X,
  type LucideIcon,
} from "lucide-react";
import type { PreambleAction, PreambleProvenance } from "@shared/preamble";
import type { PreambleItem, SeatBubble } from "../../lib/preamble-feed";
import { dismissPreamble } from "../../lib/preamble-state";
import { stopNodeGestureUnlessMultiSelect } from "../../lib/multi-select-gesture";
import { state$ } from "../../lib/state";
import "./preamble-bubble.css";

/**
 * Who is speaking, in a word. The agent's own voice needs none: the tail
 * already points at its portrait. Anyone else speaking about the seat names
 * itself before the sentence.
 */
const SPEAKER: Readonly<Record<PreambleProvenance, string | undefined>> = {
  agent: undefined,
  ai: "AI",
  system: "Junto",
  operator: "you",
};

/** What happened, as a glyph in the note's hue. The agent's plain words carry none. */
const KIND: Readonly<Record<PreambleAction, LucideIcon | undefined>> = {
  say: undefined,
  tool: PackageCheck,
  signal: Flag,
  "signal-clear": CircleCheck,
  health: Activity,
  "mail-in": Mail,
  "mail-out": Send,
  "mail-failed": MailWarning,
  state: CircleDot,
};

/** Keeps the bubble inside the canvas viewport; measured once per note. */
const EDGE = 8;
/** The tail's centre from the bubble's left edge (see preamble-bubble.css). */
const TAIL_X = 20.5;

/** NodeToolbar's offset above the node, and the air left between it and the bubble. */
const TOOLBAR_OFFSET = 8;
const TOOLBAR_AIR = 6;

/**
 * Lifts a lone selected seat's bubble just over its toolbar. The toolbar is
 * drawn at screen size while the bubble scales with the canvas, so the lift
 * is the toolbar's measured height turned into canvas units at this zoom.
 * Mounted only while lifted, so a resting seat never follows the zoom.
 */
function ToolbarLift({ target, nodeId }: { readonly target: RefObject<HTMLDivElement | null>; readonly nodeId: string }) {
  const zoom = useStore((store) => store.transform[2]);
  useLayoutEffect(() => {
    const el = target.current;
    if (!el) return;
    const bar = document.querySelector(`.react-flow__node-toolbar[data-id="${CSS.escape(nodeId)}"]`);
    const height = bar?.getBoundingClientRect().height ?? 42;
    el.style.setProperty("--pre-lift", `${String((TOOLBAR_OFFSET + height + TOOLBAR_AIR) / zoom)}px`);
    return () => {
      el.style.removeProperty("--pre-lift");
    };
  }, [target, nodeId, zoom]);
  return null;
}

function Note({ item, faded = false }: { readonly item: PreambleItem; readonly faded?: boolean }) {
  const Icon = KIND[item.action];
  const speaker = SPEAKER[item.provenance];
  return (
    <>
      {Icon ? (
        <span className="junto-preamble__glyph" aria-hidden>
          <Icon size={faded ? 10 : 12} strokeWidth={2} />
        </span>
      ) : null}
      <span className="junto-preamble__text">
        {speaker ? <span className="junto-preamble__who">{speaker}</span> : null}
        {item.text}
      </span>
    </>
  );
}

/**
 * A seat's preamble: what it is doing, said by whoever is speaking. It sits
 * above the seat with its tail on the portrait ring, flips below near the
 * top of the canvas, and slides in from the sides, so it is always readable.
 * One frame: the note it replaced lingers as a faded line above the current
 * one for a moment, inside the same bubble.
 */
export function PreambleBubble({
  nodeId,
  bubble,
  selected,
}: {
  readonly nodeId: string;
  readonly bubble: SeatBubble;
  readonly selected: boolean;
}) {
  const { current, previous } = bubble;
  const ref = useRef<HTMLDivElement>(null);
  // The floating toolbar shows only for a lone selected node (NodeShell); a
  // region, a shift set or a rubber band leaves the seat bare, so the bubble
  // stays on its ring.
  const lifted = use$(() => selected && state$.selectedNodeIds.get().length <= 1);

  useLayoutEffect(() => {
    const el = ref.current;
    const frame = el?.closest(".react-flow");
    if (!el || !frame) return;
    el.style.setProperty("--pre-dx", "0px");
    el.removeAttribute("data-flip");
    const box = el.getBoundingClientRect();
    const bounds = frame.getBoundingClientRect();
    // The canvas zoom scales the bubble; offsets are in its own units.
    const zoom = el.offsetWidth > 0 ? box.width / el.offsetWidth : 1;
    // Only a seat whose ring is on screen is clamped: sliding the bubble of a
    // seat that is itself off the edge would lay it over its neighbour's.
    const anchorX = box.left + TAIL_X * zoom;
    if (anchorX < bounds.left || anchorX > bounds.right) return;
    if (box.top < bounds.top + EDGE) el.setAttribute("data-flip", "below");
    let dx = 0;
    if (box.right > bounds.right - EDGE) dx = (bounds.right - EDGE - box.right) / zoom;
    if (box.left + dx * zoom < bounds.left + EDGE) dx = (bounds.left + EDGE - box.left) / zoom;
    if (dx !== 0) el.style.setProperty("--pre-dx", `${String(Math.round(dx))}px`);
  }, [current.shownAt, lifted]);

  return (
    <div
      ref={ref}
      className="junto-preamble nodrag nopan"
      data-testid="node-preamble"
      data-node-id={nodeId}
      data-preamble-id={current.id}
      data-provenance={current.provenance}
      data-action={current.action}
      data-tone={current.tone}
      data-lifted={lifted ? "true" : undefined}
      role="status"
      aria-live="polite"
      style={{ "--pre-dx": "0px" } as CSSProperties}
    >
      {lifted ? <ToolbarLift target={ref} nodeId={nodeId} /> : null}
      <div className="junto-preamble__card">
        {previous ? (
          <div
            className="junto-preamble__line junto-preamble__line--was"
            data-tone={previous.tone}
            aria-hidden
          >
            <Note item={previous} faded />
          </div>
        ) : null}
        <div className="junto-preamble__line" key={current.shownAt}>
          <Note item={current} />
          <button
            type="button"
            className="junto-preamble__close nodrag nopan"
            aria-label="Dismiss preamble"
            title="Dismiss"
            onPointerDown={(event) => {
              if (stopNodeGestureUnlessMultiSelect(event, { preventDefault: true })) return;
              event.preventDefault();
            }}
            onClick={(event) => {
              if (stopNodeGestureUnlessMultiSelect(event, { preventDefault: true })) return;
              event.preventDefault();
              dismissPreamble(nodeId, current.id);
            }}
          >
            <X size={10} strokeWidth={2.2} />
          </button>
        </div>
      </div>
    </div>
  );
}
