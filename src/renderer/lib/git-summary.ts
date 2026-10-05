import { observable } from "@legendapp/state";
import { use$ } from "@legendapp/state/react";
import { useEffect } from "react";
import type { CanvasDoc, CanvasNode } from "@shared/canvas";
import type { GitSummary } from "@shared/git";
import { resolveRegionCwd } from "@shared/region-defaults";
import { LOCAL_HOST_ID } from "@shared/remote-hosts";
import { getJuntoApi } from "./junto-api";

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

/** How many folders are being read right now; zero when nothing shows git. */
export const watchedGitFolders = (): number => watches.size;

/** The live summary for a folder while this component is mounted. */
export const useGitSummary = (folder: string | undefined): GitSummary | undefined => {
  useEffect(() => (folder ? retainGitSummary(folder) : undefined), [folder]);
  const summary = use$(() => (folder ? summaries$[folder].get() : undefined));
  return summary ?? undefined;
};
