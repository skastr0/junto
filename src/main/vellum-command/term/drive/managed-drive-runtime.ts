/**
 * Single shared drive-runtime ownership.
 *
 * The drive needs lifecycle feeds to stay correct: turn-start
 * acknowledgements, idle drains, composer-clear releases, and binding
 * generation cuts. Both Command Center and the packaged Remote attach the
 * same four feeds from their own local planes — one subscriber set per
 * drive, with explicit cleanup. Product supervisory layers (injection
 * supervisor, session capture, pulses, first-typed doctrine, board and
 * message delivery) stay at their own callsites and are not part of this
 * runtime.
 */

import {
  GROK_MIN_POST_SPAWN_MS,
  ManagedTerminalDrive,
  type SeatHarnessLookup,
} from "./managed-terminal-drive";
import { isClaudeCompactNoop } from "./claude-startup";

export type ManagedDriveHostEvent =
  | {
      readonly kind: "session";
      readonly bindingId: string;
      readonly exited: boolean;
      readonly running: boolean;
    }
  | { readonly kind: "output"; readonly bindingId: string };

export type ManagedDriveSeatEvent = {
  readonly bindingId: string;
  readonly state: string;
};

export type ManagedDriveRuntimeSources = {
  readonly subscribeHostEvents: (
    listener: (event: ManagedDriveHostEvent) => void,
    options: { readonly replayCurrentSessions: boolean },
  ) => () => void;
  readonly subscribeSeatState: (
    listener: (event: ManagedDriveSeatEvent) => void,
  ) => () => void;
  readonly subscribeComposerEmpty: (
    listener: (bindingId: string) => void,
  ) => () => void;
  readonly harnessFor: SeatHarnessLookup;
  readonly snapshotText: (bindingId: string) => string | undefined;
  /**
   * Pre-idle hook, invoked before the drive's own idle drain. Lets
   * Command Center initiate firstTyped doctrine before a previously queued
   * prompt drains (restoring prior invocation order). It starts first; no
   * stronger lock priority is claimed — the clipboard preflight awaits even
   * on a synchronous pass. Omitted on Remote, which has no doctrine layer.
   */
  readonly beforeSeatIdle?: (bindingId: string) => void;
};

/**
 * Attach the four drive lifecycle feeds. Returns one cleanup closing all
 * three subscriptions; callers also suspend the drive itself on shutdown.
 */
export const attachManagedTerminalDriveRuntime = (
  drive: ManagedTerminalDrive,
  sources: ManagedDriveRuntimeSources,
): (() => void) => {
  const unsubHost = sources.subscribeHostEvents(
    (event) => {
      if (event.kind === "output") {
        if (sources.harnessFor(event.bindingId) === "claude") {
          const text = sources.snapshotText(event.bindingId);
          if (text !== undefined && isClaudeCompactNoop(text)) {
            drive.onCompactNoop(event.bindingId);
          }
        }
        return;
      }
      if (event.exited || event.running) {
        drive.invalidateBinding(event.bindingId);
      }
      if (event.running && sources.harnessFor(event.bindingId) === "grok") {
        drive.markSpawned(event.bindingId, GROK_MIN_POST_SPAWN_MS);
      }
    },
    { replayCurrentSessions: true },
  );
  const unsubSeat = sources.subscribeSeatState((event) => {
    if (event.state === "idle") {
      sources.beforeSeatIdle?.(event.bindingId);
      drive.onSeatIdle(event.bindingId);
    } else if (event.state === "working") {
      drive.onTurnStart(event.bindingId);
    }
  });
  const unsubComposer = sources.subscribeComposerEmpty((bindingId) => {
    drive.onComposerClear(bindingId);
  });
  return () => {
    unsubHost();
    unsubSeat();
    unsubComposer();
  };
};
