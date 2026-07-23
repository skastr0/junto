import { randomUUID } from "node:crypto";

type RendererSurfaceTimer = ReturnType<typeof setTimeout> | number;

export interface RendererSurfaceReadinessOptions {
  readonly timeoutMs: number;
  readonly loadTimeoutMs?: number;
  readonly onTimeout: (phase: "load" | "mount") => void;
  readonly schedule?: (callback: () => void, timeoutMs: number) => RendererSurfaceTimer;
  readonly cancel?: (timer: RendererSurfaceTimer) => void;
  readonly createChallenge?: () => string;
  readonly now?: () => number;
}

/**
 * One readiness generation per committed renderer document. A receipt may
 * arrive just before Electron emits did-finish-load, but can never survive the
 * next main-document navigation.
 */
export const createRendererSurfaceReadiness = (
  options: RendererSurfaceReadinessOptions,
) => {
  const schedule = options.schedule ?? ((callback, timeoutMs) => setTimeout(callback, timeoutMs));
  const cancel = options.cancel ?? ((active) => clearTimeout(active));
  const createChallenge = options.createChallenge ?? randomUUID;
  const now = options.now ?? (() => performance.now());
  const loadTimeoutMs = options.loadTimeoutMs ?? options.timeoutMs;
  let generation = 0;
  let phase: "loading" | "committed" | undefined;
  let challenge: string | undefined;
  let acknowledged = false;
  let deadlineAt: number | undefined;
  let previous:
    | {
        readonly generation: number;
        readonly phase: "loading" | "committed" | undefined;
        readonly challenge: string | undefined;
        readonly acknowledged: boolean;
        readonly deadlineAt: number | undefined;
      }
    | undefined;
  let timer: RendererSurfaceTimer | undefined;

  const clearTimer = (): void => {
    if (timer === undefined) return;
    cancel(timer);
    timer = undefined;
  };

  const armTimeout = (): void => {
    clearTimer();
    if (phase === undefined || acknowledged || deadlineAt === undefined) return;
    const armedGeneration = generation;
    const armedChallenge = challenge;
    const armedPhase = phase;
    const armedDeadline = deadlineAt;
    timer = schedule(() => {
      timer = undefined;
      if (now() < armedDeadline) {
        armTimeout();
        return;
      }
      if (
        generation === armedGeneration &&
        phase === armedPhase &&
        !acknowledged &&
        challenge === armedChallenge &&
        deadlineAt === armedDeadline
      ) {
        options.onTimeout(armedPhase === "loading" ? "load" : "mount");
      }
    }, Math.max(0, armedDeadline - now()));
  };

  return {
    documentStarted(): void {
      // Electron may emit more than one start event while following a single
      // provisional navigation. Never let those events extend the absolute
      // load deadline.
      if (phase === "loading") return;
      clearTimer();
      if (phase === "committed") {
        previous ??= { generation, phase, challenge, acknowledged, deadlineAt };
      }
      generation += 1;
      phase = "loading";
      challenge = undefined;
      acknowledged = false;
      deadlineAt = now() + loadTimeoutMs;
      armTimeout();
    },

    committedDocumentRestored(): string | undefined {
      if (previous === undefined) return undefined;
      clearTimer();
      generation = previous.generation;
      phase = previous.phase;
      challenge = previous.challenge;
      acknowledged = previous.acknowledged;
      deadlineAt = previous.deadlineAt;
      previous = undefined;
      armTimeout();
      return acknowledged ? undefined : challenge;
    },

    acknowledge(candidate: unknown): boolean {
      if (phase !== "committed" || typeof candidate !== "string" || candidate !== challenge) {
        return false;
      }
      acknowledged = true;
      deadlineAt = undefined;
      clearTimer();
      return true;
    },

    trustedDocumentCommitted(): string {
      clearTimer();
      previous = undefined;
      phase = "committed";
      acknowledged = false;
      challenge = createChallenge();
      deadlineAt = now() + options.timeoutMs;
      armTimeout();
      return challenge;
    },

    ready(): boolean {
      return phase === "committed" && acknowledged;
    },

    dispose(): void {
      clearTimer();
      phase = undefined;
      challenge = undefined;
      acknowledged = false;
      deadlineAt = undefined;
      previous = undefined;
    },
  } as const;
};
