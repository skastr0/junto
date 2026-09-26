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
import { ensureMarkAtlas, ringCells } from "../lib/activity-atlas";
import { retainAttentionClock } from "../lib/attention-clock";
import { canvasPerformance } from "../lib/performance/canvas-performance";
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
 * A looping mark only steps while it intersects the window. Offscreen marks
 * drop `data-mark-visible` (their frame rules stop matching) and release the
 * clock, so a canvas whose working seats are all out of view ticks nothing.
 * Toggled straight on the DOM: visibility never re-renders React.
 */
type Watch = { release?: () => void };
const watched = new WeakMap<Element, Watch>();
let observer: IntersectionObserver | undefined;

const setVisible = (el: Element, visible: boolean): void => {
  const watch = watched.get(el);
  if (!watch) return;
  if (visible && !watch.release) {
    el.setAttribute("data-mark-visible", "");
    watch.release = retainAttentionClock();
  } else if (!visible && watch.release) {
    el.removeAttribute("data-mark-visible");
    watch.release();
    watch.release = undefined;
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
  watched.set(el, {});
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

const stop = (event: PointerEvent | MouseEvent): void => {
  event.stopPropagation();
};

/** Hub strength per drawn ring: work reads lit, rest reads quiet, off has none. */
const HUB_MIX: Readonly<Record<string, number>> = {
  work: 100,
  reverse: 100,
  snake: 100,
  call: 100,
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

/**
 * The status instrument every seat, card, chip and glance shares: a ring.
  wait: 100,
 *
 * One element. Its background is a cell of the theme's sprite atlas
 * (activity-atlas.ts): the ring carries control state (bent by a trouble
 * reading), a ::after band carries the waiting glow, the good halo and the
 * declared-signal flag. Standalone it has a hub; at seat size a portrait sits
 * in the ring. Loops step on the shared 90 ms clock only while visible and
 * motion is live; done draws itself once and then glints until read; only
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

  const name = accessibleName(label, healthLabel, signal, signalCount);
  const hubMix = children === undefined ? HUB_MIX[ring] : undefined;
  const style = {
    ...(unit !== undefined ? { "--mark-u": `${String(unit)}px` } : {}),
    "--mark-col": core.col,
    "--mark-row": core.row,
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
      role="status"
      aria-label={name}
      title={name}
      className={["junto-mark", className].filter(Boolean).join(" ")}
      data-activity-mode={mode}
      data-activity-tone={tone}
      data-activity-size={size}
      data-mark-size={size}
    ...(core.land !== undefined ? { "--mark-lrow": core.land } : {}),
      data-mark-ring={ring}
      data-mark-motion={core.motion}
      data-mark-band={band ? "" : undefined}
      data-mark-hub={hubMix !== undefined ? "" : undefined}
      data-mark-health={health}
      data-mark-signal={signal}
      style={style}
    >
      {children !== undefined ? <span className="junto-mark__seat">{children}</span> : null}
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
      data-mark-land={core.land !== undefined ? "" : undefined}
        />
      ) : null}
    </span>
  );
}
