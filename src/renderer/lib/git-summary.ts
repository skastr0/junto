import { observable } from "@legendapp/state";
import { use$ } from "@legendapp/state/react";
import { useEffect } from "react";
import type { CanvasDoc, CanvasNode } from "@shared/canvas";
import type { GitSummary } from "@shared/git";
import { resolveRegionCwd } from "@shared/region-defaults";
import { LOCAL_HOST_ID } from "@shared/remote-hosts";
import { getJuntoApi } from "./junto-api";
import { openOperatorModalFrom, type OperatorModalPlaces } from "./operator-modal";
import { state$ } from "./state";

/**
 * Git at a glance for the folder a seat runs in.
 *
 * The cost rule: git is read per folder, never per seat, and only while
 * something on screen shows that folder. Every viewer of a folder retains
 * one shared poll; the last to leave stops it and drops what was read. Main
 * keys its own read by repository, so two folders of one repository still
 * cost one read between them (adapters/git.ts readGitSummary).
 */

/** How often a watched folder is read again. */
export const GIT_SUMMARY_POLL_MS = 10_000;

/**
 * The folder whose repository speaks for a seat: where it was launched,
 * else its region's folder for its host (innermost region that names one).
 * Undefined for a seat on another host: its folder is not on this machine,
 * and nothing is read there.
 */
export const seatGitFolder = (doc: CanvasDoc, node: CanvasNode): string | undefined => {
  const host = (typeof node.ether?.host === "string" && node.ether.host.trim()) || LOCAL_HOST_ID;
  if (host !== LOCAL_HOST_ID) return undefined;
  const launched = node.ether?.terminal?.launch?.cwd?.trim();
  if (launched) return launched;
  return resolveRegionCwd(doc, node.x, node.y, host);
};

/** A folder's summary; absent while unread, null when it has nothing to show. */
const summaries$ = observable<Record<string, GitSummary | null | undefined>>({});

type Watch = { refs: number; timer: ReturnType<typeof setInterval>; reading: boolean };
const watches = new Map<string, Watch>();

const read = (folder: string): void => {
  const watch = watches.get(folder);
  const api = getJuntoApi();
  if (!watch || watch.reading || !api?.gitSummary) return;
  // A window nobody is looking at reads nothing; it catches up when seen again.
  if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
  watch.reading = true;
  void api
    .gitSummary(folder)
    .then((result) => {
      if (watches.get(folder) === watch) summaries$[folder].set(result.ok ? result.summary : null);
    })
    .catch(() => {
      if (watches.get(folder) === watch) summaries$[folder].set(null);
    })
    .finally(() => {
      watch.reading = false;
    });
};

const onSeenAgain = (): void => {
  if (document.visibilityState !== "hidden") for (const folder of watches.keys()) read(folder);
};

/** Watch a folder while it is shown. Returns the release. */
export const retainGitSummary = (folder: string): (() => void) => {
  let watch = watches.get(folder);
  if (watch === undefined) {
    if (watches.size === 0 && typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onSeenAgain);
    }
    watch = { refs: 0, timer: setInterval(() => read(folder), GIT_SUMMARY_POLL_MS), reading: false };
    watches.set(folder, watch);
    read(folder);
  }
  watch.refs += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const held = watches.get(folder);
    if (held === undefined) return;
    held.refs -= 1;
    if (held.refs > 0) return;
    clearInterval(held.timer);
    watches.delete(folder);
    summaries$[folder].delete();
    if (watches.size === 0 && typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", onSeenAgain);
    }
  };
};

/** The seat whose git detail is open, by canvas node id. One at a time. */
const detailSeat$ = observable<string | null>(null);

/**
 * Open the git detail for the session a seat runs, or close it when it is
 * already open for that seat. The one entry for anything that is not the git
 * line's own press (a shortcut, a command): it opens the same surface the
 * line opens. Returns false, and does nothing, when the seat has no
 * repository on screen to show: no folder, not a repository, or its git line
 * is not mounted (the agent's modal is closed).
 */
export const toggleSeatGitDetail = (node: CanvasNode): boolean => {
  if (detailSeat$.peek() === node.id) {
    detailSeat$.set(null);
    return true;
  }
  const folder = seatGitFolder(state$.doc.peek(), node);
  if (!folder || !summaries$[folder].peek()) return false;
  detailSeat$.set(node.id);
  return true;
};

/** Close the git detail if it is open for this seat. */
export const closeSeatGitDetail = (nodeId: string): void => {
  if (detailSeat$.peek() === nodeId) detailSeat$.set(null);
};

/** Whether the git detail is open for this seat. */
export const useSeatGitDetailOpen = (nodeId: string): boolean => use$(() => detailSeat$.get() === nodeId);

/** How many folders are being read right now; zero when nothing shows git. */
export const watchedGitFolders = (): number => watches.size;

/** The live summary for a folder while this component is mounted. */
export const useGitSummary = (folder: string | undefined): GitSummary | undefined => {
  useEffect(() => (folder ? retainGitSummary(folder) : undefined), [folder]);
  const summary = use$(() => (folder ? summaries$[folder].get() : undefined));
  return summary ?? undefined;
};

/**
 * The commit under review in the operator layer: one an agent sent with a
 * needs-you card. Set as the review opens from the card, cleared as it
 * closes. The slot remembers the way back to the card; this is only what to
 * show.
 */
const commitReview$ = observable<{ readonly nodeId: string; readonly sha: string } | null>(null);

/**
 * Whether a commit on a card can be reviewed: its sender is an agent on the
 * open canvas with a folder of its own. Otherwise the action is not offered.
 */
export const canReviewCommit = (canvasName: string, nodeId: string): boolean => {
  if (state$.canvasName.peek() !== canvasName) return false;
  const doc = state$.doc.peek();
  const node = doc.nodes.find((candidate) => candidate.id === nodeId);
  return node !== undefined && seatGitFolder(doc, node) !== undefined;
};

/**
 * Open the full review of a commit in place of the feed, to return to
 * `place` when it closes. Called by the feed, which owns its place.
 */
export const openCommitReview = (input: {
  readonly nodeId: string;
  readonly sha: string;
  readonly place: OperatorModalPlaces["feed"];
}): void => {
  commitReview$.set({ nodeId: input.nodeId, sha: input.sha });
  openOperatorModalFrom("feed", "git", input.place);
};

export const useCommitReview = (): { readonly nodeId: string; readonly sha: string } | null => use$(commitReview$);

export const clearCommitReview = (): void => commitReview$.set(null);
