export type ShutdownIntent = "normal" | "signal" | "direct" | "relaunch";

export type ShutdownPhase = "open" | "draining" | "safe-to-force" | "complete" | "retryable";

export interface ShutdownCleanReceipt {
  readonly clean: boolean;
}

export interface ShutdownDocumentReceipt extends ShutdownCleanReceipt {
  readonly durable: boolean;
  readonly authoringCommitted: boolean;
}

export interface ShutdownRendererReceipt extends ShutdownCleanReceipt {
  readonly finalized: boolean;
}

export interface ShutdownCause {
  readonly stage: string;
  readonly error: unknown;
}

export interface ShutdownNamedReceipt {
  readonly name: string;
  readonly clean: boolean;
  readonly receipt?: unknown;
  readonly cause?: ShutdownCause;
}

export interface ShutdownSafeToForceReceipt {
  readonly generation: number;
  readonly attempt: number;
  readonly safeToForce: boolean;
  readonly intents: ReadonlyArray<ShutdownIntent>;
  readonly receipts: ReadonlyArray<ShutdownNamedReceipt>;
}

export interface ShutdownCompleteReceipt extends ShutdownSafeToForceReceipt {
  readonly complete: boolean;
}

export interface ShutdownCoordinatorSteps {
  /** Must close every ingress synchronously and monotonically. */
  readonly cutAdmission: () => void;
  /** Must attest both final document durability and committed authoring closure. */
  readonly drainDocument: () => ShutdownDocumentReceipt | Promise<ShutdownDocumentReceipt>;
  /** Must attest renderer/headless finalization. */
  readonly finalizeRenderer: () => ShutdownRendererReceipt | Promise<ShutdownRendererReceipt>;
  /** Every named local resource must return a clean receipt. */
  readonly drainLocalResources: () =>
    | Readonly<Record<string, ShutdownCleanReceipt | Promise<ShutdownCleanReceipt>>>
    | Promise<Readonly<Record<string, ShutdownCleanReceipt | Promise<ShutdownCleanReceipt>>>>;
  /** Destroy the renderer only after all pre-safe receipts are clean. */
  readonly destroyRenderer: () => void;
  /** Detach future runtime ingress before disposal begins. */
  readonly detachRuntimeIngress: () => void;
  /** Complete only if this disposal receipt is clean. */
  readonly disposeRuntime: () => ShutdownCleanReceipt | Promise<ShutdownCleanReceipt>;
}

export interface ShutdownCoordinatorSnapshot {
  readonly generation: number;
  readonly attempt: number;
  readonly admissionClosed: boolean;
  readonly forceRequested: boolean;
  readonly intents: ReadonlyArray<ShutdownIntent>;
  readonly phase: ShutdownPhase;
  readonly safeToForce: boolean;
  readonly complete: boolean;
}

export interface ShutdownTransaction {
  readonly generation: number;
  readonly safeToForce: Promise<ShutdownSafeToForceReceipt>;
  readonly complete: Promise<ShutdownCompleteReceipt>;
  readonly retry: () => ShutdownTransaction;
  readonly snapshot: () => ShutdownCoordinatorSnapshot;
}

export interface ShutdownCoordinator {
  /** Signals join the shared generation and record force intent; they never bypass its gates. */
  readonly request: (intent: ShutdownIntent) => ShutdownTransaction;
  readonly snapshot: () => ShutdownCoordinatorSnapshot;
}

interface Deferred<A> {
  readonly promise: Promise<A>;
  readonly resolve: (value: A) => void;
}

const deferred = <A>(): Deferred<A> => {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

const ownBoolean = (value: unknown, key: string): boolean | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && "value" in descriptor && typeof descriptor.value === "boolean"
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
};

const cleanReceipt = (value: unknown): boolean => ownBoolean(value, "clean") === true;

const settled = async <A>(
  stage: string,
  operation: () => A | Promise<A>,
): Promise<ShutdownNamedReceipt> => {
  try {
    const receipt = await Promise.resolve().then(operation);
    return Object.freeze({ name: stage, clean: cleanReceipt(receipt), receipt });
  } catch (error) {
    return Object.freeze({
      name: stage,
      clean: false,
      cause: Object.freeze({ stage, error }),
    });
  }
};

const performed = async (stage: string, operation: () => void): Promise<ShutdownNamedReceipt> => {
  try {
    operation();
    return Object.freeze({ name: stage, clean: true });
  } catch (error) {
    return Object.freeze({
      name: stage,
      clean: false,
      cause: Object.freeze({ stage, error }),
    });
  }
};

const documentReceipt = (receipt: ShutdownNamedReceipt): ShutdownNamedReceipt =>
  Object.freeze({
    ...receipt,
    clean:
      receipt.clean &&
      ownBoolean(receipt.receipt, "durable") === true &&
      ownBoolean(receipt.receipt, "authoringCommitted") === true,
  });

const rendererReceipt = (receipt: ShutdownNamedReceipt): ShutdownNamedReceipt =>
  Object.freeze({
    ...receipt,
    clean: receipt.clean && ownBoolean(receipt.receipt, "finalized") === true,
  });

/**
 * A pure, injected shutdown transaction. Admission closes once, synchronously;
 * every later request either joins that generation or retries its drains after
 * a pre-safe failure. No failed receipt can reopen admission or authorize exit.
 */
export const createShutdownCoordinator = (steps: ShutdownCoordinatorSteps): ShutdownCoordinator => {
  let generation = 0;
  let attempt = 0;
  let admissionClosed = false;
  let forceRequested = false;
  let phase: ShutdownPhase = "open";
  let safe = false;
  let completed = false;
  const intents = new Set<ShutdownIntent>();
  let transaction: ShutdownTransaction | undefined;
  let activeAttempt: number | undefined;
  let safeDeferred: Deferred<ShutdownSafeToForceReceipt> | undefined;
  let completeDeferred: Deferred<ShutdownCompleteReceipt> | undefined;

  const snapshot = (): ShutdownCoordinatorSnapshot =>
    Object.freeze({
      generation,
      attempt,
      admissionClosed,
      forceRequested,
      intents: Object.freeze([...intents]),
      phase,
      safeToForce: safe,
      complete: completed,
    });

  const currentSafe = (): ShutdownSafeToForceReceipt =>
    Object.freeze({
      generation,
      attempt,
      safeToForce: safe,
      intents: Object.freeze([...intents]),
      receipts: Object.freeze([]),
    });

  const beginAttempt = (): void => {
    if (activeAttempt !== undefined || completed) return;
    const thisAttempt = ++attempt;
    activeAttempt = thisAttempt;
    phase = "draining";
    safe = false;
    safeDeferred = deferred<ShutdownSafeToForceReceipt>();
    completeDeferred = deferred<ShutdownCompleteReceipt>();

    void (async () => {
      const receipts: ShutdownNamedReceipt[] = [];
      receipts.push(documentReceipt(await settled("document", steps.drainDocument)));
      if (!isCurrent(thisAttempt)) return;
      if (receipts[0].clean) {
        receipts.push(rendererReceipt(await settled("renderer", steps.finalizeRenderer)));
      }
      if (!isCurrent(thisAttempt)) return;
      if (receipts.every((receipt) => receipt.clean)) {
        let resources: Readonly<Record<string, ShutdownCleanReceipt | Promise<ShutdownCleanReceipt>>>;
        let resourceStartCause: ShutdownCause | undefined;
        try {
          resources = await Promise.resolve().then(steps.drainLocalResources);
        } catch (error) {
          resources = {};
          resourceStartCause = Object.freeze({ stage: "local resources", error });
        }
        if (!isCurrent(thisAttempt)) return;
        if (resourceStartCause !== undefined) {
          receipts.push(Object.freeze({
            name: "local resources",
            clean: false,
            cause: resourceStartCause,
          }));
        } else {
          const named = Object.entries(resources);
          const outcomes = await Promise.allSettled(
            named.map(([name, operation]) =>
              Promise.resolve(operation).then(
                (receipt) => Object.freeze({ name: `resource:${name}`, clean: cleanReceipt(receipt), receipt }),
              ),
            ),
          );
          if (!isCurrent(thisAttempt)) return;
          for (let index = 0; index < outcomes.length; index += 1) {
            const outcome = outcomes[index];
            if (outcome.status === "fulfilled") receipts.push(outcome.value);
            else {
              const name = named[index]?.[0] ?? "unknown";
              receipts.push(Object.freeze({
                name: `resource:${name}`,
                clean: false,
                cause: Object.freeze({ stage: `resource:${name}`, error: outcome.reason }),
              }));
            }
          }
        }
      }
      if (!isCurrent(thisAttempt)) return;
      if (receipts.every((receipt) => receipt.clean)) {
        receipts.push(await performed("renderer destruction", steps.destroyRenderer));
        if (!isCurrent(thisAttempt)) return;
      }
      if (receipts.every((receipt) => receipt.clean)) {
        receipts.push(await performed("runtime ingress detachment", steps.detachRuntimeIngress));
        if (!isCurrent(thisAttempt)) return;
      }

      if (!receipts.every((receipt) => receipt.clean)) {
        phase = "retryable";
        activeAttempt = undefined;
        const receipt = Object.freeze({
          generation,
          attempt: thisAttempt,
          safeToForce: false,
          intents: Object.freeze([...intents]),
          receipts: Object.freeze(receipts),
        });
        safeDeferred?.resolve(receipt);
        completeDeferred?.resolve(Object.freeze({ ...receipt, complete: false }));
        return;
      }

      safe = true;
      phase = "safe-to-force";
      const safeReceipt = Object.freeze({
        generation,
        attempt: thisAttempt,
        safeToForce: true,
        intents: Object.freeze([...intents]),
        receipts: Object.freeze(receipts),
      });
      safeDeferred?.resolve(safeReceipt);
      const disposal = await settled("runtime disposal", steps.disposeRuntime);
      if (!isCurrent(thisAttempt)) return;
      const completeReceipt = Object.freeze({
        ...safeReceipt,
        receipts: Object.freeze([...receipts, disposal]),
        complete: disposal.clean,
      });
      completed = disposal.clean;
      // Once safe-to-force is published, destruction/detachment are already
      // irreversible. An unclean runtime disposal is reported as incomplete,
      // never turned into a second pre-safe drain that could re-run teardown.
      phase = disposal.clean ? "complete" : "safe-to-force";
      activeAttempt = undefined;
      completeDeferred?.resolve(completeReceipt);
    })().catch((error) => {
      if (!isCurrent(thisAttempt)) return;
      const receipt = Object.freeze({
        generation,
        attempt: thisAttempt,
        safeToForce: false,
        intents: Object.freeze([...intents]),
        receipts: Object.freeze([
          { name: "coordinator", clean: false, cause: Object.freeze({ stage: "coordinator", error }) },
        ]),
      });
      safe = false;
      phase = "retryable";
      activeAttempt = undefined;
      safeDeferred?.resolve(receipt);
      completeDeferred?.resolve(Object.freeze({ ...receipt, complete: false }));
    });
  };

  const isCurrent = (candidate: number): boolean => activeAttempt === candidate;

  const request = (intent: ShutdownIntent): ShutdownTransaction => {
    intents.add(intent);
    if (intent === "signal") forceRequested = true;
    if (transaction !== undefined) {
      if (phase === "retryable" && activeAttempt === undefined) beginAttempt();
      return transaction;
    }

    generation += 1;
    admissionClosed = true;
    transaction = Object.freeze({
      generation,
      get safeToForce() {
        return safeDeferred?.promise ?? Promise.resolve(currentSafe());
      },
      get complete() {
        return completeDeferred?.promise ?? Promise.resolve(Object.freeze({ ...currentSafe(), complete: completed }));
      },
      retry: () => {
        if (phase === "retryable" && activeAttempt === undefined) beginAttempt();
        return transaction!;
      },
      snapshot,
    });

    try {
      steps.cutAdmission();
    } catch (error) {
      phase = "retryable";
      safeDeferred = deferred<ShutdownSafeToForceReceipt>();
      completeDeferred = deferred<ShutdownCompleteReceipt>();
      const receipt = Object.freeze({
        generation,
        attempt,
        safeToForce: false,
        intents: Object.freeze([...intents]),
        receipts: Object.freeze([
          { name: "admission cut", clean: false, cause: Object.freeze({ stage: "admission cut", error }) },
        ]),
      });
      safeDeferred.resolve(receipt);
      completeDeferred.resolve(Object.freeze({ ...receipt, complete: false }));
      return transaction;
    }
    beginAttempt();
    return transaction;
  };

  return Object.freeze({ request, snapshot });
};
