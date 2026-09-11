// Per-operation abort helpers for provider access.
//
// Revoking one source must cancel that source's admitted work without
// flipping the global adapter process-plane shutdown switch.

export const ACCESS_CANCELLED_ERROR = "provider access cancelled";

export const timeoutSignal = (timeoutMs: number, signal?: AbortSignal): AbortSignal =>
  signal === undefined
    ? AbortSignal.timeout(timeoutMs)
    : AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);

export const isAborted = (signal?: AbortSignal): boolean => signal?.aborted === true;

export const throwIfAborted = (signal?: AbortSignal): void => {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new DOMException(ACCESS_CANCELLED_ERROR, "AbortError");
};

export const isCancelled = (error: unknown, signal?: AbortSignal): boolean => {
  if (signal?.aborted) return true;
  if (error instanceof DOMException && error.name === "AbortError") return true;
  return error instanceof Error && (error.name === "AbortError" || error.message === ACCESS_CANCELLED_ERROR);
};

export const rethrowIfCancelled = (error: unknown, signal?: AbortSignal): void => {
  if (isCancelled(error, signal)) throw error;
};
