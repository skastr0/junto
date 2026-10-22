import { useMemo, type ReactNode } from "react";
import { use$ } from "@legendapp/state/react";
import { kindIconSrc, type KindIconKind } from "@shared/kind-icon";
import type { ActivitySpec } from "../../lib/activity";
import { bandBackground, kindBandLayers, type BandMotion, type KindLedger, type KindState } from "../../lib/kind-band";
import { themeMode$ } from "../../lib/theme-mode";
import { ActivityMarkFromSpec } from "../ActivityMark";
import { SEAT_PORTRAIT_PX, SeatName } from "./AgentSeat";
import "./kind-seat.css";

/** The seat's ring grammar for a kind's state: the same tones and motion a seat's ring uses. */
export const KIND_RING: Readonly<Record<KindState, ActivitySpec>> = {
  idle: { mode: "static", tone: "steel", label: "idle" },
  off: { mode: "static", tone: "steel", glyph: "off", label: "off" },
  working: { mode: "wave", tone: "cyan", label: "working" },
  needs: { mode: "wave", tone: "amber", label: "needs you" },
  blocked: { mode: "wave", tone: "crimson", pattern: "arrow-up", label: "blocked" },
  done: { mode: "pulse", tone: "green", label: "done" },
};

/** Words take a hue's text form, as a seat's line does. */
const LINE_TONE: Readonly<Record<KindState, string>> = {
  idle: "text-dim",
  off: "text-faint",
  working: "text-cyan-fg",
  needs: "text-amber-fg",
  blocked: "text-crimson-fg",
  done: "text-green",
};

/** A node status as the seat's states say it; `done` is for a kind that finished (a board with nothing left, a live session). */
export const kindStateOf = (
  status: "blocked" | "needs-you" | "working" | "failed" | "off" | "retired" | undefined,
  done = false,
): KindState => {
  switch (status) {
    case "blocked":
    case "failed":
      return "blocked";
    case "needs-you":
      return "needs";
    case "working":
      return "working";
    case "off":
    case "retired":
      return "off";
    default:
      return done ? "done" : "idle";
  }
};

export type KindSeatProps = {
  readonly kind: KindIconKind;
  /** The name, or its rename input. */
  readonly name: ReactNode;
  /** The one line beneath the name: what the kind says it holds or is doing. */
  readonly line: string;
  readonly state?: KindState;
  /** What the kind holds, as counts the card already reads; draws the ledger band. */
  readonly ledger?: KindLedger;
  /** The one on-card instrument, at the end of the name row (a board's enqueue). */
  readonly trailing?: ReactNode;
  /** Full text of the line when it truncates. */
  readonly lineTitle?: string;
};

const MOTION_NAMES: ReadonlySet<BandMotion> = new Set(["chase", "shimmer", "hand", "scan", "orbit", "blink", "blink-fast", "pulse", "breathe", "ripple", "glint", "shake"]);

/**
 * A non-seat canvas kind in the seat's language: the seat's own ring (52 seat cell), a plain icon
 * where the portrait would be, a ledger band outside the ring that says what the kind holds, and
 * the name and one line beside it. The ring says the state; the band says the contents; the icon
 * stays the icon. Rows, notes and settings live in the detail view, not on the canvas. Pure: a
 * card hands it data, and the same props draw the same node.
 */
export function KindSeat({ kind, name, line, state = "idle", ledger, trailing, lineTitle }: KindSeatProps) {
  const mode = use$(themeMode$);
  const layers = useMemo(() => kindBandLayers(kind, state, mode, ledger).map((layer) => ({ ...layer, background: bandBackground(layer.svg) })), [kind, state, mode, ledger]);
  return (
    <div className="junto-seat kind-seat flex h-full w-full items-center gap-2" data-testid="kind-seat" data-kind={kind} data-state={state}>
      <ActivityMarkFromSpec spec={KIND_RING[state]} size="seat">
        <span className="kind-band" aria-hidden>
          {layers.map((layer, index) => (
            <i
              // A layer's identity is its place in the band; a moving one is named by its motion.
              key={`${index}-${layer.motion ?? "still"}`}
              className="kind-band__layer"
              data-motion={layer.motion !== undefined && MOTION_NAMES.has(layer.motion) ? layer.motion : undefined}
              style={{ backgroundImage: layer.background }}
            />
          ))}
        </span>
        <img className="kind-icon" alt="" width={SEAT_PORTRAIT_PX} height={SEAT_PORTRAIT_PX} draggable={false} src={kindIconSrc(kind, mode, SEAT_PORTRAIT_PX)} />
      </ActivityMarkFromSpec>
      <div className="junto-seat__text min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1">
          {typeof name === "string" ? <SeatName name={name} color="var(--color-ink)" /> : name}
          {trailing}
        </div>
        <div className="junto-seat__line max-h-[1lh] overflow-hidden text-label leading-snug">
          <span className={`block truncate ${LINE_TONE[state]}`} title={lineTitle} data-testid="kind-seat-line">
            {line}
          </span>
        </div>
      </div>
    </div>
  );
}
