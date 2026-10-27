import { useCallback, useEffect, useMemo } from "react";
import { ViewportPortal } from "@xyflow/react";
import { observable } from "@legendapp/state";
import { use$ } from "@legendapp/state/react";
import type { TaskPathVerb } from "@shared/physics";
import { canvasTier$ } from "../../lib/canvas-tier";
import {
  TRACK_BREATH_MS,
  TRACK_PERIOD,
  TRACK_PERIOD_MS,
  TRACK_SCALE,
  trackClearances,
  trackHeight,
  trackFit,
  trackRuns,
  trackTile,
  type TrackRun,
} from "../../lib/flow-track";
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
 *
 * A derives wire draws the same track with filled arrowheads that hold
 * their place and breathe (flow-track.css), never sliding.
 *
 * Tracks that lie side by side closer than a chevron is tall (two task
 * wires on one side of a board, pulled back to far) draw their chevrons
 * smaller to fit the room between them rather than cross: every track publishes its
 * runs, and each run reads the room beside it from all of them.
 */
export function FlowTrack({
  id,
  path,
  selected,
  verb,
}: {
  readonly id: string;
  readonly path: string;
  readonly selected: boolean;
  readonly verb: TaskPathVerb;
}) {
  const scale = TRACK_SCALE[use$(canvasTier$)];
  const period = TRACK_PERIOD * scale;
  // A lane stitch narrower than half a chevron is ridden straight through.
  const runs = useMemo(() => trackRuns(path, period, trackHeight(scale) / 2), [path, period, scale]);
  useEffect(() => {
    tracks$[id]!.set(runs);
  }, [id, runs]);
  useEffect(
    () => () => {
      tracks$[id]!.delete();
    },
    [id],
  );
  const room = (use$(() => room$[id]!.get()) ?? "").split(",").map(Number);
  const watch = useCallback((el: HTMLDivElement | null) => (el ? watchRun(el) : undefined), []);

  return (
    <ViewportPortal>
      <div className="junto-flow-track" data-edge-id={id} data-verb={verb} data-selected={selected ? "" : undefined}>
        {runs.map((run, index) => {
          const fit = trackFit(scale, room[index]);
          const height = trackHeight(fit);
          return (
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
                ["--flow-track-tile" as string]: tileOf(scale, fit, verb),
                ["--flow-track-size" as string]: `${period}px ${height}px`,
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
          );
        })}
      </div>
    </ViewportPortal>
  );
}

// --- room: every track's runs, and the room beside each ---------------------

const tracks$ = observable<Record<string, ReadonlyArray<TrackRun>>>({});
/** Per track, the room beside each of its runs, comma-joined so a track re-renders only when its own changes. */
const room$ = observable((): Record<string, string> =>
  Object.fromEntries(Object.entries(trackClearances(tracks$.get())).map(([id, room]) => [id, room.join(",")])),
);

const tiles = new Map<string, string>();
const tileOf = (scale: number, fit: number, verb: TaskPathVerb): string => {
  const key = `${verb}:${scale}:${fit.toFixed(3)}`;
  let tile = tiles.get(key);
  if (tile === undefined) {
    tile = trackTile(scale, fit, verb);
    tiles.set(key, tile);
  }
  return tile;
};

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
 * Every run slides, or breathes, on one clock, wall time, so a run that
 * comes into view lines up with the runs already moving and the period
 * carries on round every corner.
 */
const syncPhase = (el: HTMLElement): void => {
  const now = Date.now();
  el.style.setProperty("--flow-track-t0", `${String(-Math.round(now % TRACK_PERIOD_MS))}ms`);
  el.style.setProperty("--flow-track-breath-t0", `${String(-Math.round(now % TRACK_BREATH_MS))}ms`);
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
