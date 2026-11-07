import { useLayoutEffect, useRef, type CSSProperties, type MouseEvent, type PointerEvent, type ReactNode, type RefObject } from "react";
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
import "./preamble-bubble.css";

// The bubble as drawn, from props alone: no store, no canvas camera. The
// canvas feeds it through `PreambleBubble`; the tour and the kit feed it
// scripted.

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
  "mail-held": MailWarning,
  state: CircleDot,
};

/** Keeps the bubble inside the canvas viewport; measured per note and again when the camera rests. */
const EDGE = 8;
/** The tail's centre from the bubble's left edge (see preamble-bubble.css). */
const TAIL_X = 20.5;

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
 *
 * `tail="right"` is for a seat in a column, where a tail underneath would
 * point between two seats: the bubble sits to the left of its anchor, level
 * with it, and the tail leaves the card's right edge.
 *
 * Pure: `lifted` (a lone selected seat, its bubble over the toolbar) and
 * `settled` (bumps each time the camera rests, to place it again) come in
 * as props; `lift` draws what raises it, `onDismiss` closes a note.
 */
export function PreambleBubbleView({
  nodeId,
  bubble,
  tail = "ring",
  lifted = false,
  settled = 0,
  lift,
  onDismiss,
  onClosePointerDown,
}: {
  readonly nodeId: string;
  readonly bubble: SeatBubble;
  readonly tail?: "ring" | "right";
  readonly lifted?: boolean;
  readonly settled?: number;
  /** While lifted, what measures the lift onto the bubble. */
  readonly lift?: (target: RefObject<HTMLDivElement | null>) => ReactNode;
  readonly onDismiss?: (preambleId: string) => void;
  /** A press on the close button; true when the canvas took it as its own gesture. */
  readonly onClosePointerDown?: (event: PointerEvent | MouseEvent) => boolean;
}) {
  const { current, previous } = bubble;
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    // A side bubble is placed by its anchor and neither flips nor slides.
    if (tail === "right") return;
    // The canvas, or whatever surface a seat outside it names as its frame.
    const frame = el?.closest(".react-flow, [data-preamble-frame]");
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
  }, [current.shownAt, lifted, tail, settled]);

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
      data-tail={tail === "right" ? "right" : undefined}
      role="status"
      aria-live="polite"
      style={{ "--pre-dx": "0px" } as CSSProperties}
    >
      {lifted ? lift?.(ref) : null}
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
              if (onClosePointerDown?.(event)) return;
              event.preventDefault();
            }}
            onClick={(event) => {
              if (onClosePointerDown?.(event)) return;
              event.preventDefault();
              onDismiss?.(current.id);
            }}
          >
            <X size={10} strokeWidth={2.2} />
          </button>
        </div>
      </div>
    </div>
  );
}
