import { useEffect, useRef, type CSSProperties, type MouseEvent, type PointerEvent, type ReactNode } from "react";
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
import { MARK_PHASE_MS, ensureMarkAtlas, ringCells, type RingParts } from "../lib/activity-atlas";
import { canvasPerformance } from "../lib/performance/canvas-performance";
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
 * A looping mark's parts show only while it intersects the window, so an
 * offscreen mark holds no compositor layer and runs nothing. Toggled
 * straight on the DOM: visibility never re-renders React.
 */
const watched = new WeakSet<Element>();
const visible = new Set<HTMLElement>();
let observer: IntersectionObserver | undefined;
let unsubMotion: (() => void) | undefined;

const now = (): number => (typeof performance === "undefined" ? Date.now() : performance.now());

/**
 * Every ring runs on one clock: a part starts its animation when it shows,
 * so its delay is set to where that clock stands, as the live painter did.
 */
const syncPhase = (el: HTMLElement): void => {
  el.style.setProperty("--mark-t0", `${String(-Math.round(now() % MARK_PHASE_MS))}ms`);
};

/** Motion back on (window shown again): the parts restart, so resync them. */
const onMotion = (): void => {
  if (surfaceMotionLive$.peek()) for (const el of visible) syncPhase(el);
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

const visibilityObserver = (): IntersectionObserver | undefined => {
  if (observer) return observer;
  if (typeof IntersectionObserver !== "function") return undefined;
  observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) setVisible(entry.target, entry.isIntersecting);
    },
    { rootMargin: "48px" },
  );
  return observer;
};

const watchLoop = (el: Element): (() => void) => {
  const io = visibilityObserver();
  watched.add(el);
  if (io) io.observe(el);
  // No observer (tests, old engines): treat as visible so it still animates.
  else setVisible(el, true);
  return () => {
    io?.unobserve(el);
    setVisible(el, false);
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
  unit,
  crest = false,
}: ActivityMarkProps) {
  const theme = use$(themeMode$);
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
      {parts ? <RingPartsView parts={parts} /> : null}
      {children !== undefined ? <span className="junto-mark__seat">{children}</span> : null}
      {crest ? <SeatCrest /> : null}
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
    </span>
  );
}
