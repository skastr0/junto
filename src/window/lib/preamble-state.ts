import { observable } from "@legendapp/state";
import type { PreambleEvent } from "@shared/preamble";
import {
  dismissSeat,
  feedPreamble,
  nextDeadline,
  tickFeed,
  type FeedState,
  type SeatBubble,
} from "./preamble-feed";

/**
 * App-local, non-durable preamble bubbles keyed by agent node. The feed
 * (preamble-feed.ts) decides what each seat shows; this module owns its one
 * clock and projects only the seats that changed, so a busy seat never
 * re-renders its neighbours.
 */
export const preambleByNodeId$ = observable<Record<string, SeatBubble>>({});

let feed: FeedState = new Map();
let timer: ReturnType<typeof setTimeout> | undefined;
let armedFor: number | undefined;

const project = (before: FeedState, after: FeedState): void => {
  const touched = new Set<string>([...before.keys(), ...after.keys()]);
  for (const nodeId of touched) {
    const was = before.get(nodeId)?.bubble;
    const now = after.get(nodeId)?.bubble;
    if (was === now) continue;
    if (now === undefined) preambleByNodeId$[nodeId].delete();
    else preambleByNodeId$[nodeId].set(now);
  }
};

const commit = (next: FeedState): void => {
  if (next === feed) return;
  const before = feed;
  feed = next;
  project(before, next);
  arm();
};

/** One timer for every seat, armed for the soonest deadline. */
const arm = (): void => {
  const at = nextDeadline(feed);
  if (at === armedFor) return;
  if (timer !== undefined) clearTimeout(timer);
  timer = undefined;
  armedFor = at;
  if (at === undefined) return;
  timer = setTimeout(() => {
    timer = undefined;
    armedFor = undefined;
    commit(tickFeed(feed, Date.now()));
    arm();
  }, Math.max(0, at - Date.now()));
};

/** Feed one note from any source; the feed coalesces, paces and expires it. */
export const showPreamble = (event: PreambleEvent): void => {
  commit(feedPreamble(feed, event, Date.now()));
};

/** Dismiss a seat's bubble, ignoring a stale id from a replaced note. */
export const dismissPreamble = (nodeId: string, preambleId?: string): void => {
  commit(dismissSeat(feed, nodeId, preambleId));
};

/** Clear all app-local preambles when the active canvas changes. */
export const clearPreambles = (): void => {
  if (timer !== undefined) clearTimeout(timer);
  timer = undefined;
  armedFor = undefined;
  feed = new Map();
  preambleByNodeId$.set({});
};
