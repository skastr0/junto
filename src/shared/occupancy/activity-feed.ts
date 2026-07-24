import { Context, Layer } from "effect";
import type { OccupancyActivity, OccupancyFlags } from "./derive";

// Cut 1 seam (S5 — factory physics engineering plan): a typed producer
// contract for live occupancy inputs. Consumers (card chrome, RTS, digest)
// derive occupancy through `deriveOccupancy` (../derive) fed by whatever
// `ActivityFeed` is bound in scope — never by reaching into a specific
// runtime plane themselves. Producers plug in without touching consumers:
// this file ships the interface plus the shippable-today null producer
// (everything vacant); `src/renderer/lib/occupancy-feed.ts` binds the real
// ACP-chat-plane producer this cut also wires. The PTY/terminal lane and the
// fleet lane bind their own producers to this same Tag later — neither is
// touched here.

/**
 * Everything `deriveOccupancy` needs about one seat, minus the caller-owned
 * clock (`nowMs`) and stall threshold. A producer returns `undefined` for a
 * node it has no opinion about — the consumer then treats the seat as
 * vacant; a producer never invents occupancy for a node it cannot observe.
 */
export interface OccupancyClue {
  readonly hasOccupant: boolean;
  readonly activity?: OccupancyActivity;
  readonly lastSeenAtMs?: number;
  readonly flags?: OccupancyFlags;
}

export interface ActivityFeedService {
  /** Live occupancy clue for one node. Unknown node -> undefined (vacant). */
  readonly clueFor: (nodeId: string) => OccupancyClue | undefined;
}

export class ActivityFeed extends Context.Tag("@vellum/ActivityFeed")<
  ActivityFeed,
  ActivityFeedService
>() {}

/** Everything vacant — the shippable default before any producer binds. */
export const nullActivityFeed: ActivityFeedService = {
  clueFor: () => undefined,
};

export const ActivityFeedNull = Layer.succeed(ActivityFeed, nullActivityFeed);
