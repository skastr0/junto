/**
 * The far-zoom badge's hover list: when it opens and when it closes.
 *
 * A badge stands for a region's seats; resting the pointer on it opens a list
 * of those seats beside it, and a seat picked there flies the camera to it.
 * This is the timing and the rules, with no DOM and no clock of its own, so a
 * test steps it by hand:
 *
 * - It opens after a short steady hover on one badge (`openMs`). Moving to a
 *   different badge starts the wait again.
 * - It stays open while the pointer is on the badge or on the list. Leaving
 *   both closes it after a short grace (`graceMs`), so crossing the gap
 *   between the badge and the list does not close it.
 * - A dismissal (Escape, a press outside the list, a press on the badge, a
 *   camera move) closes it at once, and that badge does not open again until
 *   the pointer has left it.
 *
 * The two delays are design values, not measured ones: long enough that a
 * pointer sweeping across the far board opens nothing, short enough that a
 * pointer that stops feels answered.
 */
import { observable } from "@legendapp/state";
import type { Rect } from "../contract";

export const CLUSTER_HOVER = { openMs: 220, graceMs: 160 } as const;

/** The badge the pointer is on. */
export type ClusterTarget = {
  readonly key: string;
  readonly memberIds: ReadonlyArray<string>;
};

/** The open list: its badge, and where the badge is drawn in page pixels. */
export type ClusterHoverState = ClusterTarget & { readonly rect: Rect };

export type HoverTimers = {
  readonly set: (run: () => void, ms: number) => unknown;
  readonly clear: (handle: unknown) => void;
};

export type ClusterHoverController = {
  /** The pointer is on a badge, or on none. */
  readonly pointer: (target: ClusterTarget | null) => void;
  /** The pointer entered or left the open list. */
  readonly panel: (inside: boolean) => void;
  /** Escape, a press outside, a press on the badge, a camera move. */
  readonly dismiss: () => void;
  readonly dispose: () => void;
};

export const createClusterHoverController = (host: {
  readonly timers: HoverTimers;
  /** Show the list for a badge, or close it. */
  readonly show: (target: ClusterTarget | null) => void;
  readonly openMs?: number;
  readonly graceMs?: number;
}): ClusterHoverController => {
  const openMs = host.openMs ?? CLUSTER_HOVER.openMs;
  const graceMs = host.graceMs ?? CLUSTER_HOVER.graceMs;
  let open: ClusterTarget | null = null;
  let pending: { readonly target: ClusterTarget; readonly handle: unknown } | null = null;
  let closing: unknown = null;
  /** The badge a dismissal closed or pre-empted: it stays shut until the pointer leaves it. */
  let suppressed: string | null = null;
  let overBadge: string | null = null;
  let overPanel = false;

  const cancelPending = (): void => {
    if (pending !== null) host.timers.clear(pending.handle);
    pending = null;
  };
  const cancelClosing = (): void => {
    if (closing !== null) host.timers.clear(closing);
    closing = null;
  };
  const close = (): void => {
    cancelClosing();
    if (open === null) return;
    open = null;
    host.show(null);
  };
  const scheduleClose = (): void => {
    if (open === null || closing !== null) return;
    closing = host.timers.set(() => {
      closing = null;
      if (open !== null && !overPanel && overBadge !== open.key) close();
    }, graceMs);
  };

  return {
    pointer: (target) => {
      overBadge = target?.key ?? null;
      if (suppressed !== null && overBadge !== suppressed) suppressed = null;
      if (target === null) {
        cancelPending();
        if (!overPanel) scheduleClose();
        return;
      }
      cancelClosing();
      if (suppressed === target.key || open?.key === target.key) {
        cancelPending();
        return;
      }
      // Another badge: the old list goes at once, the new one waits for a steady hover.
      if (open !== null) close();
      if (pending?.target.key === target.key) return;
      cancelPending();
      pending = {
        target,
        handle: host.timers.set(() => {
          pending = null;
          if (overBadge !== target.key || suppressed === target.key) return;
          open = target;
          host.show(target);
        }, openMs),
      };
    },
    panel: (inside) => {
      overPanel = inside;
      if (inside) cancelClosing();
      else if (overBadge === null || overBadge !== open?.key) scheduleClose();
    },
    dismiss: () => {
      cancelPending();
      suppressed = open?.key ?? overBadge;
      close();
    },
    dispose: () => {
      cancelPending();
      cancelClosing();
      open = null;
    },
  };
};

/** The open list, read by `ClusterHoverList`; null when closed. */
export const clusterHover$ = observable<ClusterHoverState | null>(null);

/** The controller of the mounted canvas, so the list can tell it about its own pointer and dismissals. */
let active: ClusterHoverController | undefined;
export const bindClusterHover = (controller: ClusterHoverController | undefined): void => {
  active = controller;
};
export const clusterHoverPanel = {
  enter: (): void => active?.panel(true),
  leave: (): void => active?.panel(false),
  dismiss: (): void => active?.dismiss(),
};
