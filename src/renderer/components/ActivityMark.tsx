import { useEffect, useLayoutEffect, useRef, type CSSProperties, type MouseEvent, type PointerEvent, type ReactNode } from "react";
import { use$ } from "@legendapp/state/react";
import type { AgentSignalKind } from "@shared/agent-signals";
import type { ThreadHealthTone, ThreadHealthValue } from "@shared/thread-health";
import {
  ACTIVITY_TONE_HEX,
  resolveActivityGlyph,
  type ActivityGlyph,
  type ActivityMode,
  type ActivitySize,
  type ActivitySpec,
  type ActivityTone,
} from "../lib/activity";
import { MARK_PHASE_MS } from "@shared/rings";
import { ensureMarkAtlas, ringCells, type RingParts } from "../lib/activity-atlas";
import { canvasPerformance } from "../lib/performance/canvas-performance";
import { canvasTier$ } from "../lib/canvas-tier";
import { isCovered, onCoverChange, watchCoverable } from "../lib/mark-occlusion";
import { surfaceMotionLive$ } from "../lib/surface-motion";
import { themeMode$ } from "../lib/theme-mode";

export type ActivityMarkProps = {
  readonly mode: ActivityMode;
  readonly tone: ActivityTone;
  /** Accessible name only. */
  readonly label: string;
  readonly size?: ActivitySize;
  readonly className?: string;
  /** When false, never animate (caller may also pass mode=static). */
  readonly active?: boolean;
  /** Drawn form; derived from mode and tone when absent. */
  readonly glyph?: ActivityGlyph;
  /** Advisory thread health: trouble bends the ring, waiting glows, good haloes. */
  readonly health?: ThreadHealthTone;
  /** The reading's value: splits trouble into stuck (reverse) and snaking. */
  readonly healthValue?: ThreadHealthValue;
  /** Past its freshness window: the band draws faded. */
  readonly healthStale?: boolean;
  /** "AI reads: ..." — joins the accessible name, never drawn as text. */
  readonly healthLabel?: string;
  /** Worst open declared signal: the flag, and the glow for blocked/escalate. */
  readonly signal?: AgentSignalKind;
  readonly signalCount?: number;
  /** Makes the flag the click target (opens the seat at its signals). */
  readonly onSignalOpen?: () => void;
  /** Seat size: the portrait that sits in the ring's hole (replaces the hub). */
  readonly children?: ReactNode;
  /** What rides over the ring, painted after its parts: the portrait's harness badge. */
  readonly over?: ReactNode;
  /** Exact box in px, overriding the size's default (ringed portraits fit their slot). */
  readonly unit?: number;
  /** An overseer seat wears a crest at the top of its ring. */
  readonly crest?: boolean;
};

export type MarkOverlayProps = Pick<
  ActivityMarkProps,
  | "health"
  | "healthValue"
  | "healthStale"
  | "healthLabel"
  | "signal"
  | "signalCount"
  | "onSignalOpen"
  | "children"
  | "over"
  | "unit"
  | "crest"
>;

/** Convenience: pass a full ActivitySpec. */
export function ActivityMarkFromSpec({
  spec,
  size = "node",
  className,
  ...overlay
}: {
  readonly spec: ActivitySpec;
  readonly size?: ActivitySize;
  readonly className?: string;
} & MarkOverlayProps) {
  return (
    <ActivityMark
      mode={spec.mode}
      tone={spec.tone}
      glyph={spec.glyph}
      label={spec.label}
      size={size}
      className={className}
      {...overlay}
    />
  );
}

// --- visibility: one observer for every looping mark -------------------------

/**
 * A looping mark's parts show only while it intersects the window and no
 * opaque surface wholly covers it (mark-occlusion.ts), so a mark no one can
 * see holds no compositor layer and runs nothing. Toggled straight on the
 * DOM: visibility never re-renders React.
 *
 * The observer has no margin. A ring just off screen is culled from paint,
 * and Blink ticks an animation with nothing to show on the main thread,
 * re-layerizing the board every frame (canvas-scale lab, 2026-10-29: one
 * such ring, 115 full updates/s). A ring coming on screen may show its rest
 * pose for one frame (operator signal 01M63W6RQY1YT2Q65MCM0N3YQ8).
 */
const watched = new WeakSet<Element>();
const intersecting = new Set<HTMLElement>();
const visible = new Set<HTMLElement>();
let observer: IntersectionObserver | undefined;
let unsubMotion: (() => void) | undefined;

/**
 * Every ring runs on one clock: a part starts its animation when it shows,
 * so its delay is set to where that clock stands. The clock is wall time,
 * so every screen showing a seat (the phone too) is in the same phase.
 */
const syncPhase = (el: HTMLElement): void => {
  el.style.setProperty("--mark-t0", `${String(-Math.round(Date.now() % MARK_PHASE_MS))}ms`);
};

/** Motion back on (window shown again): the parts restart, so resync them. */
const onMotion = (): void => {
  if (surfaceMotionLive$.peek()) for (const el of visible) syncPhase(el);
};

/**
 * A ring's parts that were taken off the page and put back restart from
 * zero: put the visible marks under `root` back on the shared clock. Call it
 * in the same task that shows them.
 */
export const resyncMarks = (root: ParentNode): void => {
  for (const el of root.querySelectorAll<HTMLElement>(".junto-mark[data-mark-visible]")) syncPhase(el);
};

const setVisible = (el: Element, on: boolean): void => {
  if (!watched.has(el) || !(el instanceof HTMLElement)) return;
  if (on && !visible.has(el)) {
    syncPhase(el);
    el.setAttribute("data-mark-visible", "");
    visible.add(el);
    unsubMotion ??= surfaceMotionLive$.onChange(onMotion);
  } else if (!on && visible.has(el)) {
    el.removeAttribute("data-mark-visible");
    visible.delete(el);
  }
};

/** Shows a mark when it is on screen and uncovered; showing puts it on the shared clock. */
const showIfSeen = (el: HTMLElement): void => setVisible(el, intersecting.has(el) && !isCovered(el));

const setIntersecting = (el: Element, on: boolean): void => {
  if (!watched.has(el) || !(el instanceof HTMLElement)) return;
  if (on) intersecting.add(el);
  else intersecting.delete(el);
  showIfSeen(el);
};

const visibilityObserver = (): IntersectionObserver | undefined => {
  if (observer) return observer;
  if (typeof IntersectionObserver !== "function") return undefined;
  observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) setIntersecting(entry.target, entry.isIntersecting);
    },
    { rootMargin: "0px" },
  );
  return observer;
};

let coverWatched = false;

const watchLoop = (el: HTMLElement): (() => void) => {
  if (!coverWatched) {
    onCoverChange(showIfSeen);
    coverWatched = true;
  }
  const io = visibilityObserver();
  watched.add(el);
  const uncover = watchCoverable(el);
  if (io) io.observe(el);
  // No observer (tests, old engines): treat as visible so it still animates.
  else setIntersecting(el, true);
  return () => {
    io?.unobserve(el);
    uncover();
    setVisible(el, false);
    intersecting.delete(el);
    watched.delete(el);
  };
};

export const signalPhrase = (signal: AgentSignalKind, count: number | undefined): string => {
  const n = Math.max(1, count ?? 1);
  return n === 1 ? `1 open signal, ${signal}` : `${String(n)} open signals, worst ${signal}`;
};

const accessibleName = (
  label: string,
  healthLabel: string | undefined,
  signal: AgentSignalKind | undefined,
  signalCount: number | undefined,
): string => {
  const parts = [label];
  if (healthLabel) parts.push(healthLabel);
  if (signal) parts.push(signalPhrase(signal, signalCount));
  return parts.join(", ");
};

/**
 * The overseer's crest: a small crown seated on the top of the ring, cut
 * out of it by a ground-coloured rim. Identity, not state, so it never moves.
 */
function SeatCrest() {
  return (
    <span className="junto-mark__crest" data-testid="overseer-crest" aria-hidden>
      <svg viewBox="0 0 16 11" width="100%" height="100%">
        <path d="M2 9.5V3.2l3.3 2.6L8 1.2l2.7 4.6L14 3.2v6.3Z" />
      </svg>
    </span>
  );
}

const stop = (event: PointerEvent | MouseEvent): void => {
  event.stopPropagation();
};

/** Hub strength per drawn ring: work reads lit, rest reads quiet, off has none. */
const HUB_MIX: Readonly<Record<string, number>> = {
  work: 100,
  reverse: 100,
  snake: 100,
  call: 100,
  wait: 100,
  halt: 100,
  done: 100,
  live: 70,
  dot: 100,
  rest: 45,
  fracture: 45,
};

const hubTone = (ring: string, tone: ActivityTone): ActivityTone => {
  if (ring === "done") return "green";
  if (ring === "reverse" || ring === "snake" || ring === "call" || ring === "fracture") return "amber";
  if (ring === "halt") return "crimson";
  return tone;
};

/** A moving ring's still parts over its base; the compositor runs them. */
function RingPartsView({ parts }: { readonly parts: RingParts }) {
  const { spin, pulse, land } = parts;
  return (
    <>
      {land ? (
        <span
          className="junto-mark__part"
          data-part="land"
          aria-hidden
          style={{ "--part-col": land.col, "--part-row": land.row } as CSSProperties}
          // Once landed the mark keeps its seal; set on the DOM, never a render.
          onAnimationEnd={(event) => event.currentTarget.parentElement?.setAttribute("data-mark-landed", "")}
        />
      ) : null}
      {spin ? (
        <span
          className="junto-mark__part"
          data-part="spin"
          data-spin={spin.ccw ? "ccw" : "cw"}
          data-fade={spin.fade ? "" : undefined}
          aria-hidden
          style={{ "--part-col": spin.col, "--part-row": spin.row, "--part-ms": `${String(spin.ms)}ms` } as CSSProperties}
        />
      ) : null}
      {pulse ? (
        <span
          className="junto-mark__part"
          data-part="pulse"
          data-pulse={pulse.kind}
          aria-hidden
          style={{ "--part-col": pulse.col, "--part-row": pulse.row, "--part-ms": `${String(pulse.ms)}ms` } as CSSProperties}
        />
      ) : null}
    </>
  );
}

/**
 * The status instrument every seat, card, chip and glance shares: a ring.
 *
 * One element. Its background is a cell of the theme's sprite atlas
 * (activity-atlas.ts): the ring carries control state (bent by a trouble
 * reading), a ::after band carries the waiting glow, the good halo and the
 * declared-signal flag. Standalone it has a hub; at seat size a portrait sits
 * in the ring. A moving ring's base is its background and the part that
 * turns or pulses is a child the compositor animates at the display's rate
 * (activity-atlas.ts); done lands once and then glints until read; only
 * resting and stopped rings are still. No visible text: the label is the
 * accessible name.
 */
export function ActivityMark({
  mode,
  tone,
  label,
  size = "node",
  className,
  active = true,
  glyph,
  health,
  healthValue,
  healthStale = false,
  healthLabel,
  signal,
  signalCount,
  onSignalOpen,
  children,
  over,
  unit,
  crest = false,
}: ActivityMarkProps) {
  const theme = use$(themeMode$);
  const tier = use$(canvasTier$);
  const ref = useRef<HTMLSpanElement>(null);
  const drawn = resolveActivityGlyph(mode, tone, glyph);
  const { core, band, ring } = ringCells({
    glyph: drawn,
    tone,
    // Every ring but resting and stopped moves, whatever the control mode:
    // a still seat that waits on you orbits. Only `active` freezes it.
    animate: active,
    health,
    healthValue,
    healthStale,
    signal,
  });
  const looping = core.motion === "loop";
  const parts = core.parts;
  // Idempotent: paints the theme's atlas on first use so the very first
  // frame already has pixels; afterwards a map lookup.
  ensureMarkAtlas(theme);

  useEffect(() => {
    const renderedMode: ActivityMode = looping ? "wave" : "static";
    const animated = renderedMode !== "static";
    canvasPerformance.recordActivityMount(animated, renderedMode);
    const el = ref.current;
    const unwatch = looping && el ? watchLoop(el) : undefined;
    return () => {
      unwatch?.();
      canvasPerformance.recordActivityUnmount(animated, renderedMode);
    };
  }, [looping]);

  // The parts are made anew at each tier (keyed below): cc keeps a turning
  // layer at the raster scale it started with, so a part made at near would
  // stay rastered at near zoomed out. The new parts start on the shared
  // clock, where the old ones stood, so the swap does not show.
  useLayoutEffect(() => {
    const el = ref.current;
    if (el?.hasAttribute("data-mark-visible")) syncPhase(el);
  }, [tier]);

  const named = accessibleName(label, healthLabel, signal, signalCount);
  const name = crest ? `Overseer, ${named}` : named;
  const hubMix = children === undefined ? HUB_MIX[ring] : undefined;
  const style = {
    ...(unit !== undefined ? { "--mark-u": `${String(unit)}px` } : {}),
    "--mark-col": core.col,
    "--mark-row": core.row,
    ...(parts ? { "--mark-lcol": parts.base.col, "--mark-lrow": parts.base.row } : {}),
    ...(band ? { "--mark-bcol": band.col, "--mark-brow": band.row } : {}),
    ...(hubMix !== undefined
      ? {
          "--mark-hub": `color-mix(in oklab, ${ACTIVITY_TONE_HEX[hubTone(ring, tone)]} ${String(hubMix)}%, transparent)`,
        }
      : {}),
  } as CSSProperties;

  return (
    <span
      ref={ref}
      // A picture whose name is the state. Not a live region: a board of
      // seats would be a board of empty announcements. With its signal
      // button the mark is a group, since an image hides what it holds.
      role={signal && onSignalOpen ? "group" : "img"}
      aria-label={name}
      title={name}
      className={["junto-mark", className].filter(Boolean).join(" ")}
      data-activity-mode={mode}
      data-activity-tone={tone}
      data-activity-size={size}
      data-mark-size={size}
      data-mark-ring={ring}
      data-mark-motion={core.motion}
      data-mark-land={core.land !== undefined ? "" : undefined}
      data-mark-parts={parts ? "" : undefined}
      data-mark-band={band ? "" : undefined}
      data-mark-hub={hubMix !== undefined ? "" : undefined}
      data-mark-health={health}
      data-mark-signal={signal}
      style={style}
    >
      {/* The portrait paints under the parts: over them it would cost the
          pan a compositor layer of its own for every turning ring. */}
      {children !== undefined ? <span className="junto-mark__seat">{children}</span> : null}
      {/* The signal button is a clear hit target (its glyph is in the
          atlas), so it paints under the parts too: over a turning ring it
          cost a compositor layer for every seat with a signal. The parts
          take no pointer events, so a click still lands on it. */}
      {signal && onSignalOpen ? (
        <button
          type="button"
          className="junto-mark__flag nodrag nopan"
          aria-label={`${signalPhrase(signal, signalCount)}, open signals`}
          title={`${signalPhrase(signal, signalCount)}, open signals`}
          onPointerDown={stop}
          onDoubleClick={stop}
          onClick={(event) => {
            event.stopPropagation();
            onSignalOpen();
          }}
        />
      ) : null}
      {parts ? <RingPartsView key={tier} parts={parts} /> : null}
      {/* The badge paints over the parts, so a turning ring gives it a layer
          of its own: a badge's worth, where the canvas shows badges. */}
      {over !== undefined ? <span className="junto-mark__over">{over}</span> : null}
      {crest ? <SeatCrest /> : null}
    </span>
  );
}
