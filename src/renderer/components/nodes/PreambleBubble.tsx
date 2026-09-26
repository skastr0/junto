import { useLayoutEffect, useRef, type CSSProperties } from "react";
import { MessageSquareText, Radio, Sparkles, UserRound, X } from "lucide-react";
import type { PreambleProvenance } from "@shared/preamble";
import type { PreambleItem, SeatBubble } from "../../lib/preamble-feed";
import { dismissPreamble } from "../../lib/preamble-state";
import { stopNodeGestureUnlessMultiSelect } from "../../lib/multi-select-gesture";
import "./preamble-bubble.css";

/** Provenance reads at a glance: a glyph, and a word for everyone but the agent. */
const WHO: Readonly<Record<PreambleProvenance, { readonly Icon: typeof Sparkles; readonly word?: string }>> = {
  agent: { Icon: MessageSquareText },
  ai: { Icon: Sparkles, word: "AI" },
  system: { Icon: Radio, word: "Junto" },
  operator: { Icon: UserRound, word: "you" },
};

/** Keeps the bubble inside the canvas viewport; measured once per note. */
const EDGE = 8;
/** The tail's centre from the bubble's left edge (see preamble-bubble.css). */
const TAIL_X = 20.5;

function Note({ item, trail = false }: { readonly item: PreambleItem; readonly trail?: boolean }) {
  const { Icon, word } = WHO[item.provenance];
  return (
    <>
      <span className="junto-preamble__glyph" aria-hidden>
        <Icon size={trail ? 9 : 11} strokeWidth={2.2} />
      </span>
      {word ? <span className="junto-preamble__who">{word}</span> : null}
      <span className="junto-preamble__text">{item.text}</span>
      {item.count > 1 ? <span className="junto-preamble__count">x{item.count}</span> : null}
      {item.more > 0 && !trail ? <span className="junto-preamble__more">+{item.more} more</span> : null}
    </>
  );
}

/**
 * A seat's preamble: what it is doing, said by whoever is speaking. It sits
 * above the seat with its tail on the portrait ring, flips below near the
 * top of the canvas, and slides in from the sides, so it is always readable.
 * The note it replaced lingers faded above it for a moment.
 */
export function PreambleBubble({ nodeId, bubble }: { readonly nodeId: string; readonly bubble: SeatBubble }) {
  const { current, previous } = bubble;
  const ref = useRef<HTMLDivElement>(null);

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
  }, [current.shownAt]);

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
      role="status"
      aria-live="polite"
      style={{ "--pre-dx": "0px" } as CSSProperties}
    >
      {previous ? (
        <div
          className="junto-preamble__trail"
          data-provenance={previous.provenance}
          data-tone={previous.tone}
          aria-hidden
        >
          <Note item={previous} trail />
        </div>
      ) : null}
      <div className="junto-preamble__card" key={current.shownAt}>
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
          <X size={10} />
        </button>
      </div>
    </div>
  );
}
