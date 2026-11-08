import { randomUUID } from "node:crypto";
import type { FilesDraftsSettleResult, FilesDraftsSettleStarted } from "@shared/ipc";

/**
 * Before a quit or a window close, main asks the renderer to settle its
 * unsaved Files drafts: Save all, Discard, or Cancel. `true` lets leaving go
 * on, `false` is the operator's Cancel. A renderer that never says it started
 * asking, or that goes away, means go on: its drafts are out of reach and
 * holding the window changes nothing. Once it has started asking there is no
 * deadline: the operator may be choosing again after a refused save.
 */

/** How long a renderer gets to say it started asking. */
export const FILES_DRAFTS_START_TIMEOUT_MS = 5_000;

export type DraftsSettleTarget = {
  readonly id: number;
  readonly send: (request: { readonly requestId: string }) => void;
};

export type DraftsSettleTimers = {
  readonly set: (fn: () => void, ms: number) => unknown;
  readonly clear: (handle: unknown) => void;
};

const realTimers: DraftsSettleTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

const isRecord = (payload: unknown): payload is Record<string, unknown> =>
  typeof payload === "object" && payload !== null && !Array.isArray(payload);

export const decodeDraftsSettleStarted = (payload: unknown): FilesDraftsSettleStarted | undefined =>
  isRecord(payload) && Object.keys(payload).join(",") === "requestId" && typeof payload.requestId === "string"
    ? { requestId: payload.requestId }
    : undefined;

export const decodeDraftsSettleResult = (payload: unknown): FilesDraftsSettleResult | undefined =>
  isRecord(payload) &&
  Object.keys(payload).sort().join(",") === "proceed,requestId" &&
  typeof payload.requestId === "string" &&
  typeof payload.proceed === "boolean"
    ? { requestId: payload.requestId, proceed: payload.proceed }
    : undefined;

export const makeFilesDraftsSettle = (timers: DraftsSettleTimers = realTimers) => {
  const pending = new Map<
    number,
    { readonly requestId: string; readonly promise: Promise<boolean>; readonly resolve: (proceed: boolean) => void; timer: unknown }
  >();

  const finish = (id: number, proceed: boolean): void => {
    const waiting = pending.get(id);
    if (waiting === undefined) return;
    pending.delete(id);
    if (waiting.timer !== undefined) timers.clear(waiting.timer);
    waiting.resolve(proceed);
  };

  return {
    /** Ask the renderer; a second ask while one is out joins it. */
    request: (target: DraftsSettleTarget): Promise<boolean> => {
      const existing = pending.get(target.id);
      if (existing !== undefined) return existing.promise;
      const requestId = randomUUID();
      let resolve!: (proceed: boolean) => void;
      const promise = new Promise<boolean>((resolvePromise) => {
        resolve = resolvePromise;
      });
      const entry = { requestId, promise, resolve, timer: undefined as unknown };
      pending.set(target.id, entry);
      entry.timer = timers.set(() => {
        if (pending.get(target.id) !== entry) return;
        console.error("[files] renderer did not start settling drafts; leaving anyway");
        finish(target.id, true);
      }, FILES_DRAFTS_START_TIMEOUT_MS);
      try {
        target.send({ requestId });
      } catch (cause) {
        console.error("[files] drafts settle request not sent; leaving anyway", cause);
        finish(target.id, true);
      }
      return promise;
    },
    /** The renderer is asking the operator: no deadline from here. */
    started: (id: number, payload: unknown): void => {
      const started = decodeDraftsSettleStarted(payload);
      const waiting = pending.get(id);
      if (started === undefined || waiting?.requestId !== started.requestId || waiting.timer === undefined) return;
      timers.clear(waiting.timer);
      waiting.timer = undefined;
    },
    complete: (id: number, payload: unknown): void => {
      const result = decodeDraftsSettleResult(payload);
      if (result === undefined || pending.get(id)?.requestId !== result.requestId) return;
      finish(id, result.proceed);
    },
    /** The renderer crashed or its window closed: nothing is left to settle. */
    gone: (id: number): void => finish(id, true),
  };
};

export type FilesDraftsSettle = ReturnType<typeof makeFilesDraftsSettle>;
