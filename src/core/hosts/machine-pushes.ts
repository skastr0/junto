/**
 * The window hears `machinesChanged` whenever anything `machine.list` answers
 * may have changed (machine-changes.ts): a machine added, sent, updated or
 * removed, a hello carrying a peer build this machine had not heard, or a
 * link that had opened closing (never a dial that fails before it opens, and
 * never a refused hello that repeats a build already heard). Notes in one turn
 * collapse to one push, so a burst of changes reads the list once. The push
 * carries nothing: the window reads the list again.
 */
import { Effect } from "effect";
import { IPC_CHANNELS } from "@shared/ipc";
import type { CorePushesShape } from "../push";
import { onMachinesChanged } from "./machine-changes";

/** Publishes one push per turn of notes; answers how to stop. */
export const publishMachinesChanged = (
  pushes: CorePushesShape,
  later: (run: () => void) => void = (run) => { setImmediate(run); },
): (() => void) => {
  let queued = false;
  let stopped = false;
  const stop = onMachinesChanged(() => {
    if (queued || stopped) return;
    queued = true;
    later(() => {
      queued = false;
      if (!stopped) Effect.runSync(pushes.publish(IPC_CHANNELS.machinesChanged, {}));
    });
  });
  return () => { stopped = true; stop(); };
};
