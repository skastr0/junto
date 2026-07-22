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
  readonly pending?: boolean;
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
  /**
   * Every ingress cut. The coordinator invokes every named function
   * synchronously before it returns the shared transaction. A failed cut is
   * terminal for the generation: partial closure cannot be retried safely.
   */
  readonly cutAdmission: Readonly<Record<string, () => ShutdownCleanReceipt>>;
  /** Must attest both final document durability and committed authoring closure. */
  readonly drainDocument: () => ShutdownDocumentReceipt | Promise<ShutdownDocumentReceipt>;
  /** Must attest renderer/headless finalization. */
  readonly finalizeRenderer: () => ShutdownRendererReceipt | Promise<ShutdownRendererReceipt>;
  /** Every named local resource must return a clean receipt. */
  readonly drainLocalResources: () =>
    | Readonly<Record<string, ShutdownCleanReceipt | Promise<ShutdownCleanReceipt>>>
    | Promise<Readonly<Record<string, ShutdownCleanReceipt | Promise<ShutdownCleanReceipt>>>>;
  /** Destroy the renderer only after all pre-safe receipts are clean. */
  readonly destroyRenderer: () => ShutdownCleanReceipt;
  /** Detach future runtime ingress before disposal begins. */
  readonly detachRuntimeIngress: () => ShutdownCleanReceipt;
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
  readonly lastAttempt?: ShutdownSafeToForceReceipt;
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

const snapshotValue = (value: unknown, seen = new WeakMap<object, unknown>()): unknown => {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return seen.get(value);
  if (value instanceof Error) return Object.freeze({ name: value.name, message: value.message });
  const copy: Record<string, unknown> = {};
  seen.set(value, copy);
  try {
    for (const key of Object.keys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor !== undefined && "value" in descriptor) copy[key] = snapshotValue(descriptor.value, seen);
    }
  } catch {
    copy.unreadable = true;
  }
  return Object.freeze(copy);
};

const frozenReceipt = (receipt: ShutdownNamedReceipt): ShutdownNamedReceipt =>
  Object.freeze({
    ...receipt,
    receipt: receipt.receipt === undefined ? undefined : snapshotValue(receipt.receipt),
    cause: receipt.cause === undefined
      ? undefined
      : Object.freeze({ ...receipt.cause, error: snapshotValue(receipt.cause.error) }),
  });

const settled = async <A>(
  stage: string,
  operation: () => A | Promise<A>,
): Promise<ShutdownNamedReceipt> => {
  try {
    const receipt = await Promise.resolve().then(operation);
    return frozenReceipt({ name: stage, clean: cleanReceipt(receipt), receipt });
  } catch (error) {
    return frozenReceipt({
      name: stage,
      clean: false,
      cause: Object.freeze({ stage, error }),
    });
  }
};

const synchronousBarrier = (stage: string, operation: () => unknown): ShutdownNamedReceipt => {
  try {
    const receipt = operation();
    if (typeof receipt === "object" && receipt !== null && "then" in receipt) {
      if (receipt instanceof Promise) void receipt.catch(() => undefined);
      return frozenReceipt({ name: stage, clean: false, receipt });
    }
    return frozenReceipt({ name: stage, clean: cleanReceipt(receipt), receipt });
  } catch (error) {
    return frozenReceipt({
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

const admissionCutReceipts = (
  cuts: ShutdownCoordinatorSteps["cutAdmission"],
): ReadonlyArray<ShutdownNamedReceipt> => {
  let names: string[];
  try {
    names = Object.keys(cuts);
  } catch (error) {
    return Object.freeze([
      Object.freeze({
        name: "admission cuts",
        clean: false,
        cause: Object.freeze({ stage: "admission cuts", error }),
      }),
    ]);
  }
  if (names.length === 0) {
    return Object.freeze([Object.freeze({ name: "admission cuts", clean: false })]);
  }
  return Object.freeze(names.map((name) => {
    const stage = `admission cut:${name}`;
    if (name.length === 0) return Object.freeze({ name: stage, clean: false });
    let cut: unknown;
    try {
      const descriptor = Object.getOwnPropertyDescriptor(cuts, name);
      cut = descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
    } catch (error) {
      return Object.freeze({
        name: stage,
        clean: false,
        cause: Object.freeze({ stage, error }),
      });
    }
    if (typeof cut !== "function") return Object.freeze({ name: stage, clean: false });
    try {
      const receipt = cut();
      // A cut is synchronous. Thenables are malformed even if they also carry
      // a `clean` field, because they leave an unbounded admission interval.
      if (typeof receipt === "object" && receipt !== null && "then" in receipt) {
        if (receipt instanceof Promise) void receipt.catch(() => undefined);
        return Object.freeze({ name: stage, clean: false, receipt });
      }
      return Object.freeze({ name: stage, clean: cleanReceipt(receipt), receipt });
    } catch (error) {
      return Object.freeze({
        name: stage,
        clean: false,
        cause: Object.freeze({ stage, error }),
      });
    }
  }));
};

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
  let lastAttempt: ShutdownSafeToForceReceipt | undefined;
  let rendererDestroyed = false;
  let runtimeIngressDetached = false;

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
      lastAttempt,
    });

  const resourceReceipts = async (): Promise<ReadonlyArray<ShutdownNamedReceipt>> => {
    try {
      const resources = await Promise.resolve().then(steps.drainLocalResources);
      const named = Object.entries(resources);
      if (named.length === 0) return Object.freeze([Object.freeze({ name: "local resources", clean: false })]);
      const pending = new Set(named.map(([name]) => name));
      const outcomes = named.map(([name, operation]) =>
        Promise.resolve(operation).then(
          (receipt) => frozenReceipt({ name: `resource:${name}`, clean: cleanReceipt(receipt), receipt }),
          (error) => frozenReceipt({ name: `resource:${name}`, clean: false, cause: { stage: `resource:${name}`, error } }),
        ).then((receipt) => ({ name, receipt })),
      );
      // Observe every started resource forever; an early bad receipt must not
      // await an unrelated hung sibling or leak its later rejection.
      void Promise.allSettled(outcomes);
      return await new Promise<ReadonlyArray<ShutdownNamedReceipt>>((resolve) => {
        const known: ShutdownNamedReceipt[] = [];
        for (const outcome of outcomes) {
          void outcome.then(({ name, receipt }) => {
            pending.delete(name);
            known.push(receipt);
            if (!receipt.clean) {
              resolve(Object.freeze([
                ...known,
                ...[...pending].map((pendingName) => Object.freeze({ name: `resource:${pendingName}`, clean: false, pending: true })),
              ]));
            } else if (pending.size === 0) resolve(Object.freeze(known));
          });
        }
      });
    } catch (error) {
      return Object.freeze([frozenReceipt({ name: "local resources", clean: false, cause: { stage: "local resources", error } })]);
    }
  };

  const beginAttempt = (): void => {
    if (activeAttempt !== undefined || completed) return;
    const thisAttempt = ++attempt;
    activeAttempt = thisAttempt;
    phase = "draining";
    safe = false;

    void (async () => {
      const receipts: ShutdownNamedReceipt[] = [];
      receipts.push(documentReceipt(await settled("document", steps.drainDocument)));
      if (!isCurrent(thisAttempt)) return;
      if (receipts[0].clean) {
        receipts.push(rendererReceipt(await settled("renderer", steps.finalizeRenderer)));
      }
      if (!isCurrent(thisAttempt)) return;
      if (receipts.every((receipt) => receipt.clean)) {
        const resources = await resourceReceipts();
        if (!isCurrent(thisAttempt)) return;
        receipts.push(...resources);
      }
      if (!isCurrent(thisAttempt)) return;
      if (receipts.every((receipt) => receipt.clean)) {
        receipts.push(rendererDestroyed
          ? Object.freeze({ name: "renderer destruction", clean: true, receipt: Object.freeze({ checkpoint: true }) })
          : synchronousBarrier("renderer destruction", steps.destroyRenderer));
        if (receipts.at(-1)?.clean) rendererDestroyed = true;
        if (!isCurrent(thisAttempt)) return;
      }
      if (receipts.every((receipt) => receipt.clean)) {
        receipts.push(runtimeIngressDetached
          ? Object.freeze({ name: "runtime ingress detachment", clean: true, receipt: Object.freeze({ checkpoint: true }) })
          : synchronousBarrier("runtime ingress detachment", steps.detachRuntimeIngress));
        if (receipts.at(-1)?.clean) runtimeIngressDetached = true;
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
        lastAttempt = receipt;
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
      safeDeferred!.resolve(safeReceipt);
      const disposal = await settled("runtime disposal", steps.disposeRuntime);
      if (!isCurrent(thisAttempt)) return;
      const completeReceipt = Object.freeze({
        ...safeReceipt,
        intents: Object.freeze([...intents]),
        receipts: Object.freeze([...receipts, disposal]),
        complete: disposal.clean,
      });
      completed = disposal.clean;
      // Once safe-to-force is published, destruction/detachment are already
      // irreversible. An unclean runtime disposal is reported as incomplete,
      // never turned into a second pre-safe drain that could re-run teardown.
      phase = disposal.clean ? "complete" : "safe-to-force";
      activeAttempt = undefined;
      completeDeferred!.resolve(completeReceipt);
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
      lastAttempt = receipt;
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
      get safeToForce() { return safeDeferred!.promise; },
      get complete() { return completeDeferred!.promise; },
      retry: () => {
        if (phase === "retryable" && activeAttempt === undefined) beginAttempt();
        return transaction!;
      },
      snapshot,
    });

    // Publish the exact generation promises before any cut callback can
    // synchronously re-enter `request`.
    safeDeferred = deferred<ShutdownSafeToForceReceipt>();
    completeDeferred = deferred<ShutdownCompleteReceipt>();
    const cutReceipts = admissionCutReceipts(steps.cutAdmission);
    if (!cutReceipts.every((receipt) => receipt.clean)) {
      // A cut may have closed only part of the ingress set. Retrying the
      // downstream drains would convert that unknown partial boundary into
      // exit authority, so this generation can only report failure and join.
      phase = "complete";
      const receipt = Object.freeze({
        generation,
        attempt,
        safeToForce: false,
        intents: Object.freeze([...intents]),
        receipts: cutReceipts,
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
