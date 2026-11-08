export interface RendererSurfaceRecoveryOptions {
  readonly maxRetries: number;
  readonly windowMs: number;
  readonly now?: () => number;
}

export const resolveRendererSurfaceTimeoutMs = (input: {
  readonly packaged: boolean;
  readonly testHarness: boolean;
  readonly override: string | undefined;
  readonly fallbackMs: number;
}): number => {
  if (input.packaged || !input.testHarness || input.override === undefined) {
    return input.fallbackMs;
  }
  if (!/^[0-9]+$/.test(input.override)) return input.fallbackMs;
  const parsed = Number(input.override);
  return Number.isSafeInteger(parsed) && parsed >= 1_000 && parsed <= input.fallbackMs
    ? parsed
    : input.fallbackMs;
};

/**
 * Renderer bootstrap recovery is deliberately separate from app shutdown.
 * A failed surface must not close process admission or abandon owned terminal
 * children merely to escape a black window.
 */
export const createRendererSurfaceRecovery = (
  options: RendererSurfaceRecoveryOptions,
) => {
  const now = options.now ?? (() => performance.now());
  let windowStartedAt = now();
  let retries = 0;

  return {
    failed(input: { readonly admissionClosed: boolean }): "retry" | "diagnostic" {
      // Once shutdown admission closes, a replacement authoring renderer is
      // forbidden. Keep a visible, non-authoring diagnostic surface instead,
      // even when retry budget remains.
      if (input.admissionClosed) return "diagnostic";
      const observedAt = now();
      if (observedAt - windowStartedAt > options.windowMs) {
        windowStartedAt = observedAt;
        retries = 0;
      }
      if (retries >= options.maxRetries) return "diagnostic";
      retries += 1;
      return "retry";
    },

    succeeded(): void {
      windowStartedAt = now();
      retries = 0;
    },
  } as const;
};
