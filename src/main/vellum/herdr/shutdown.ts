export interface HerdrShutdownCause {
  readonly code: string;
  readonly message: string;
}

export interface HerdrComponentShutdownReceipt {
  readonly clean: boolean;
  readonly retained: number;
  readonly causes: ReadonlyArray<HerdrShutdownCause>;
}

export const cleanHerdrComponentReceipt = (): HerdrComponentShutdownReceipt =>
  Object.freeze({ clean: true, retained: 0, causes: Object.freeze([]) });

export const herdrShutdownMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const herdrComponentReceipt = (
  retained: number,
  causes: ReadonlyArray<HerdrShutdownCause>,
): HerdrComponentShutdownReceipt => Object.freeze({
  clean: retained === 0 && causes.length === 0,
  retained,
  causes: Object.freeze([...causes]),
});

/**
 * Wait for a changing promise registry to reach a fixed point. A timeout is
 * only an observation: the caller must keep the exact promises strongly held
 * and report them as retained. Nothing is canceled or declared settled.
 */
export const awaitHerdrPromiseFixedPoint = async (
  pending: () => ReadonlyArray<Promise<unknown>>,
  timeoutMs: number,
): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (pending().length > 0) {
    const snapshot = pending();
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), remaining);
      (timer as unknown as { unref?: () => void }).unref?.();
    });
    const settled = await Promise.race([
      Promise.allSettled(snapshot).then(() => true as const),
      timedOut,
    ]);
    if (timer !== undefined) clearTimeout(timer);
    if (!settled) return false;
    // Promise reactions that retire the tracked records run in the same
    // checkpoint, but yield once so a settlement that admitted follow-up work
    // cannot escape the fixed-point observation.
    await Promise.resolve();
  }
  return true;
};

export const validateHerdrShutdownTimeout = (
  value: number | undefined,
  fallback: number,
): number => {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected <= 0 || selected > 30_000) {
    throw new RangeError("Herdr shutdown timeout must be a bounded positive integer");
  }
  return selected;
};
