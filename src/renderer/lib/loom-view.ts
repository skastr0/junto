/**
 * Loom view state — the canvas computes one obstacle field and one lane plan
 * per geometry tick; every edge reads its own slice. Sibling of
 * `edge-sparks.ts`: a module-level keyed observable, consumed with `use$`.
 *
 * Paint and geometry only. Nothing here reads or writes grants, ports,
 * physics, or ether fields.
 */
import { observable } from "@legendapp/state";
import type { LoomObstacle, LoomStrand } from "./wire-loom";
import type { WireRect } from "./wire-route";

/** edgeId -> planned strand. Absent means the edge routes on its own. */
export const loomStrands$ = observable<Record<string, LoomStrand>>({});

/**
 * Every routable node rect, collected once per geometry tick. Published even
 * when the loom is off — this is the per-edge router's obstacle field, hoisted
 * out of N independent store walks into one.
 */
export const loomObstacles$ = observable<LoomObstacle[]>([]);

/** Trunk and comb bounds. Obstacles for ejected (stoppage) wires only. */
export const loomCorridors$ = observable<WireRect[]>([]);

/**
 * Read once at module scope, default ON. Flippable without a rebuild:
 * `localStorage.setItem("vellum-command:loom", "off")` then reload. One code
 * path then serves off, cannot-route, and not-planned-yet.
 */
export const LOOM_ENABLED: boolean = (() => {
  try {
    return localStorage.getItem("vellum-command:loom") !== "off";
  } catch {
    return true;
  }
})();
