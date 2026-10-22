import { useCallback, useMemo } from "react";
import { ViewportPortal } from "@xyflow/react";
import { use$ } from "@legendapp/state/react";
import { canvasTier$ } from "../../lib/canvas-tier";
import { TRACK_PERIOD, TRACK_PERIOD_MS, TRACK_SCALE, trackHeight, trackRuns, trackTile } from "../../lib/flow-track";
import { surfaceMotionLive$ } from "../../lib/surface-motion";
import "./flow-track.css";

/**
 * A flows wire's track (lib/flow-track.ts): one clipped strip per straight
 * run, its chevrons sliding toward the dependent board on the compositor.
 *
 * It is drawn in the viewport portal, above the cards and outside the wire's
 * own SVG group, for two reasons. Nothing that fades or dims a wire (rest,
 * impact, connection focus, the pulled-back tiers) reaches it, so a track is
 * opaque in every state. And nothing paints over a sliding run, so no card,
 * region or wire is lifted into a layer of its own for overlapping one. It
 * takes no pointer; the wire's own path stays the hit target.
 */
export function FlowTrack({ id, path, selected }: { readonly id: string; readonly path: string; readonly selected: boolean }) {
  const scale = TRACK_SCALE[use$(canvasTier$)];
  const period = TRACK_PERIOD * scale;
  const height = trackHeight(scale);
  const runs = useMemo(() => trackRuns(path, period), [path, period]);
  const tile = useMemo(() => trackTile(scale), [scale]);
  const watch = useCallback((el: HTMLDivElement | null) => (el ? watchRun(el) : undefined), []);

  return (
    <ViewportPortal>
      <div
        className="junto-flow-track"
        data-edge-id={id}
        data-selected={selected ? "" : undefined}
        style={{ ["--flow-track-tile" as string]: tile, ["--flow-track-size" as string]: `${period}px ${height}px` }}
      >
        {runs.map((run) => (
          <div
            // A new tier lays new runs, so each slides from a raster at its own scale.
            key={`${run.x},${run.y},${run.angle},${scale}`}
            ref={watch}
            className="junto-flow-track__run"
            style={{
              left: run.x,
              top: run.y - height / 2,
              width: run.length,
              height,
              transform: `rotate(${run.angle}deg)`,
            }}
          >
            {/* One period wide, so its translate of 100% is one period; the
                marks hang off it, starting a period back and phased by the
                distance walked, so every chevron sits a whole number of
                periods along the wire. */}
            <div className="junto-flow-track__mover" style={{ left: -(run.at % period) - period, width: period }}>
              <div className="junto-flow-track__marks" style={{ width: run.length + 2 * period }} />
            </div>
          </div>
        ))}
      </div>
    </ViewportPortal>
  );
}

// --- visibility: one observer for every run ----------------------------------

/**
 * A run slides only while it intersects the window, as a seat's ring turns
 * only on screen (ActivityMark), so a run out of view holds no compositor
 * layer. Toggled straight on the DOM: visibility never re-renders React.
 */
const visible = new Set<HTMLElement>();
let observer: IntersectionObserver | undefined;
let unsubMotion: (() => void) | undefined;

/**
 * Every run slides on one clock, wall time, so a run that comes into view
 * lines up with the runs already sliding and the period carries on round
 * every corner.
 */
const syncPhase = (el: HTMLElement): void => {
  el.style.setProperty("--flow-track-t0", `${String(-Math.round(Date.now() % TRACK_PERIOD_MS))}ms`);
};

/** Motion back on (window shown again): the runs restart, so resync them. */
const onMotion = (): void => {
  if (surfaceMotionLive$.peek()) for (const el of visible) syncPhase(el);
};

const setVisible = (el: HTMLElement, on: boolean): void => {
  if (on && !visible.has(el)) {
    syncPhase(el);
    el.setAttribute("data-track-visible", "");
    visible.add(el);
    unsubMotion ??= surfaceMotionLive$.onChange(onMotion);
  } else if (!on && visible.has(el)) {
    el.removeAttribute("data-track-visible");
    visible.delete(el);
  }
};

const visibilityObserver = (): IntersectionObserver | undefined => {
  if (observer) return observer;
  if (typeof IntersectionObserver !== "function") return undefined;
  observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) setVisible(entry.target as HTMLElement, entry.isIntersecting);
    },
    { rootMargin: "48px" },
  );
  return observer;
};

const watchRun = (el: HTMLElement): (() => void) => {
  const io = visibilityObserver();
  if (io) io.observe(el);
  // No observer (tests, old engines): treat as visible so it still slides.
  else setVisible(el, true);
  return () => {
    io?.unobserve(el);
    setVisible(el, false);
  };
};
