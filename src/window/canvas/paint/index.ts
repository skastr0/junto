/**
 * The card painter: one function from a card's facts to its quads, for every
 * kind (architecture section 4, "paint/"). Pure data in and out: the engine
 * hands it facts, the card's view and an environment, and packs the result.
 */

import { KIND_SEAT_KINDS, isImageFile } from "@shared/node-geometry";
import type { CardFact, CardPaint, CardView, PaintEnv, SeatLive } from "../contract";
import { paintDefaultCard } from "./card";
import { paintKindSeat } from "./kind-seat";
import { paintLabel } from "./label";
import { paintNote } from "./note";
import { handleQuads, takesHandles } from "./handles";
import { dimOf } from "./overlays";
import { paintRegion } from "./region";
import { paintSeat } from "./seat";
import { paintSpine } from "./spine";

const NO_GLANCE = { region: 0, sub: 0 } as const;

export const paintCard = (fact: CardFact, live: SeatLive | undefined, view: CardView, env: PaintEnv): CardPaint => {
  const row = fact.row;
  const base = ((): CardPaint => {
    switch (row.kind) {
      case "agent":
        return paintSeat(fact, live, view, env);
      case "peer":
      case "stub":
        return paintSpine(fact, view, env);
      case "note":
        return paintNote(fact, view, env);
      case "label":
        return paintLabel(fact, view, env);
      case "region":
        return paintRegion(fact, view, env, view.glance ?? NO_GLANCE);
      case "file":
        return isImageFile(row.path) ? paintDefaultCard(fact, view, env) : paintKindSeat(fact, view, env);
      default:
        return KIND_SEAT_KINDS.has(row.kind) ? paintKindSeat(fact, view, env) : { quads: [], dim: dimOf(view), lift: 0 };
    }
  })();
  const handles = takesHandles(fact) && (view.hovered || view.connecting === true)
    ? handleQuads(fact, view)
    : [];
  return handles.length === 0 ? base : { ...base, quads: [...base.quads, ...handles] };
};

export { paintClusters, gatheredIds, planClusters } from "./cluster";
export { sampleMotion } from "./motion";
