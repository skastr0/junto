import type { JuntoTerminalApi } from "@shared/ipc";
import { getJuntoApi } from "./junto-api";

type TerminalEventListener = (event: unknown) => void;

export type TerminalEventOptions = {
  /**
   * Observe only this terminal binding. Omit to observe the whole channel,
   * which is what every caller did before the index existed.
   */
  readonly bindingId?: string;
};

/** Listeners that declared a binding, bucketed by it. */
const byBindingId = new Map<string, Set<TerminalEventListener>>();
/** Listeners that declared none — they still see every event. */
const unkeyed = new Set<TerminalEventListener>();
let listenerCount = 0;
let unsubscribeIpc: (() => void) | undefined;

const deliver = (listener: TerminalEventListener, event: unknown): void => {
  try {
    listener(event);
  } catch {
    // One card or surface must not interrupt delivery to the others.
  }
};

const addressOf = (event: unknown): string | undefined => {
  if (typeof event !== "object" || event === null) return undefined;
  const bindingId = (event as { readonly bindingId?: unknown }).bindingId;
  return typeof bindingId === "string" && bindingId !== "" ? bindingId : undefined;
};

const dispatch = (event: unknown): void => {
  const bindingId = addressOf(event);
  if (bindingId === undefined) {
    // Unaddressed payload — fall back to a broadcast rather than drop it.
    // A swallowed "exit" latches a dead terminal card in the UI.
    for (const bucket of [...byBindingId.values()]) {
      for (const listener of [...bucket]) deliver(listener, event);
    }
  } else {
    const bucket = byBindingId.get(bindingId);
    if (bucket) for (const listener of [...bucket]) deliver(listener, event);
  }
  for (const listener of [...unkeyed]) deliver(listener, event);
};

const ensureIpcSubscription = (): void => {
  if (unsubscribeIpc || listenerCount === 0) return;
  const api = getJuntoApi() as JuntoTerminalApi | undefined;
  if (!api?.onTerminalEvent) return;
  unsubscribeIpc = api.onTerminalEvent(dispatch);
};

/**
 * Renderer-wide terminal event fan-out, indexed by binding.
 *
 * Canvas cards and the open xterm surface all observe the same Electron IPC
 * channel. Keeping exactly one bridge subscription prevents a large crew
 * canvas from tripping EventEmitter's listener limit.
 *
 * Raw PTY output rides this channel, so a flat listener set charged every
 * output chunk of the one terminal being scrolled a call per terminal node on
 * the canvas — on a 48-terminal canvas, 47 of them reading a property and
 * comparing a string purely to discard it. Cost scaled with canvas size, a
 * property no standalone terminal has. Callers that name their `bindingId` are
 * now reached only by their own terminal's events; callers that name none keep
 * observing everything.
 */
export const onTerminalEvent = (
  listener: TerminalEventListener,
  options?: TerminalEventOptions,
): (() => void) => {
  // Captured once at registration and never re-read. Release must empty the
  // bucket this call filled, even after the caller re-keyed by resubscribing.
  const bindingId = options?.bindingId;
  let bucket = unkeyed;
  if (bindingId !== undefined) {
    bucket = byBindingId.get(bindingId) ?? new Set<TerminalEventListener>();
    byBindingId.set(bindingId, bucket);
  }
  const before = bucket.size;
  bucket.add(listener);
  // Same listener twice under the same key collapses in the Set; only count
  // what the Set actually took, so the teardown check cannot drift.
  if (bucket.size !== before) listenerCount += 1;
  ensureIpcSubscription();

  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (!bucket.delete(listener)) return;
    listenerCount -= 1;
    if (
      bindingId !== undefined &&
      bucket.size === 0 &&
      byBindingId.get(bindingId) === bucket
    ) {
      byBindingId.delete(bindingId);
    }
    if (listenerCount === 0 && unsubscribeIpc) {
      unsubscribeIpc();
      unsubscribeIpc = undefined;
    }
  };
};
