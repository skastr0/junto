import { performance } from "node:perf_hooks";

/**
 * Process-global lifetime authority for host registry and remote-host work.
 *
 * Renderer IPC completion is not an operation lifetime: a renderer may close
 * while an Effect-backed SSH deploy is still running. This gate retains the
 * exact promise returned by the operation factory until that promise actually
 * settles. Shutdown only races its own bounded wait; it never substitutes or
 * forgets the underlying operation.
 */

export type HostOperationKind =
  | "registry-read"
  | "registry-mutation"
  | "remote-probe"
  | "remote-mutation"
  | "bounded-read";

export interface HostOperationAdmission {
  readonly label:
    | "hosts.list"
    | "hosts.upsert"
    | "hosts.remove"
    | "hosts.test"
    | "hosts.configure-remote"
    | "hosts.deploy-remote"
    | "box.availability"
    | "box.list-owned"
    | "box.create"
    | "box.refresh"
    | "box.prepare-ssh"
    | "box.stop"
    | "box.resume";
  readonly kind: HostOperationKind;
}

export const HOST_OPERATION_ADMISSIONS = Object.freeze({
  list: Object.freeze({
    label: "hosts.list",
    kind: "registry-read",
  } satisfies HostOperationAdmission),
  upsert: Object.freeze({
    label: "hosts.upsert",
    kind: "registry-mutation",
  } satisfies HostOperationAdmission),
  remove: Object.freeze({
    label: "hosts.remove",
    kind: "registry-mutation",
  } satisfies HostOperationAdmission),
  test: Object.freeze({
    label: "hosts.test",
    kind: "remote-probe",
  } satisfies HostOperationAdmission),
  configureRemote: Object.freeze({
    label: "hosts.configure-remote",
    kind: "remote-mutation",
  } satisfies HostOperationAdmission),
  deployRemote: Object.freeze({
    label: "hosts.deploy-remote",
    kind: "remote-mutation",
  } satisfies HostOperationAdmission),
  boxAvailability: Object.freeze({
    label: "box.availability",
    kind: "remote-probe",
  } satisfies HostOperationAdmission),
  boxListOwned: Object.freeze({
    label: "box.list-owned",
    kind: "registry-read",
  } satisfies HostOperationAdmission),
  boxCreate: Object.freeze({
    label: "box.create",
    kind: "remote-mutation",
  } satisfies HostOperationAdmission),
  boxRefresh: Object.freeze({
    label: "box.refresh",
    kind: "remote-probe",
  } satisfies HostOperationAdmission),
  boxPrepareSsh: Object.freeze({
    label: "box.prepare-ssh",
    kind: "remote-mutation",
  } satisfies HostOperationAdmission),
  boxStop: Object.freeze({
    label: "box.stop",
    kind: "remote-mutation",
  } satisfies HostOperationAdmission),
  boxResume: Object.freeze({
    label: "box.resume",
    kind: "remote-mutation",
  } satisfies HostOperationAdmission),
});

export class HostOperationShutdownRefused extends Error {
  readonly code = "shutdown" as const;

  constructor(
    readonly operation: HostOperationAdmission,
    readonly closedAt: number,
  ) {
    super(`host operation ${operation.label} refused: application shutdown is active`);
    this.name = "HostOperationShutdownRefused";
  }
}

export interface HostOperationShutdownPrecommitReceipt {
  readonly phase: "closed";
  readonly closedAt: number;
  readonly activeLabels: ReadonlyArray<HostOperationAdmission["label"]>;
}

export interface HostOperationShutdownReceipt {
  readonly phase: "closed";
  readonly clean: boolean;
  readonly timedOut: boolean;
  readonly rounds: number;
  readonly settled: number;
  readonly fulfilled: number;
  readonly rejected: number;
  readonly retained: number;
  readonly retainedLabels: ReadonlyArray<HostOperationAdmission["label"]>;
  readonly causes: ReadonlyArray<HostOperationShutdownCause>;
}

export interface HostOperationShutdownCause {
  readonly label: HostOperationAdmission["label"];
  readonly message: string;
}

export interface HostOperationsShutdownPort {
  /** Close host operation admission synchronously and irreversibly. */
  readonly beginShutdown: () => HostOperationShutdownPrecommitReceipt;
  /** Bounded, retryable, allSettled fixed-point drain of admitted operations. */
  readonly drainOnQuit: () => Promise<HostOperationShutdownReceipt>;
}

export interface HostOperationGate extends HostOperationsShutdownPort {
  /**
   * Admit and retain the exact promise returned by `operation`.
   *
   * `bounded-read` is reserved for a genuinely bounded, side-effect-free
   * snapshot read. No current host IPC operation qualifies: even list performs
   * an ordered registry reload and routing-snapshot publication.
   */
  readonly run: <A>(
    admission: HostOperationAdmission,
    operation: () => Promise<A>,
  ) => Promise<A>;
  readonly snapshot: () => Readonly<{
    phase: "open" | "closed";
    activeLabels: ReadonlyArray<HostOperationAdmission["label"]>;
  }>;
}

export interface HostOperationGateOptions {
  /** Tests may lower, never raise, the complete host-operation drain deadline. */
  readonly shutdownDeadlineMs?: number;
}

interface HostOperationFlight {
  readonly id: number;
  readonly admission: HostOperationAdmission;
  /** Always updated to the exact promise returned by the operation factory. */
  promise: Promise<unknown>;
  status: "pending" | "fulfilled" | "rejected";
}

const HOST_OPERATION_SHUTDOWN_DEADLINE_MS = 2_000;

const boundedDeadline = (value: number | undefined): number =>
  value === undefined || !Number.isFinite(value) || value <= 0
    ? HOST_OPERATION_SHUTDOWN_DEADLINE_MS
    : Math.min(Math.floor(value), HOST_OPERATION_SHUTDOWN_DEADLINE_MS);

const allSettledBefore = async (
  promises: ReadonlyArray<Promise<unknown>>,
  deadline: number,
): Promise<
  | { readonly timedOut: true }
  | {
      readonly timedOut: false;
      readonly outcomes: ReadonlyArray<PromiseSettledResult<unknown>>;
    }
> => {
  const remainingMs = Math.max(0, deadline - performance.now());
  if (remainingMs === 0) return { timedOut: true };

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.allSettled(promises).then((outcomes) => ({
        timedOut: false as const,
        outcomes,
      })),
      new Promise<{ readonly timedOut: true }>((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout({ timedOut: true }), remainingMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

const nextNativeTurn = (): Promise<void> =>
  new Promise((resolveTurn) => setImmediate(resolveTurn));

export const createHostOperationGate = (
  options: HostOperationGateOptions = {},
): HostOperationGate => {
  const shutdownDeadlineMs = boundedDeadline(options.shutdownDeadlineMs);
  let phase: "open" | "closed" = "open";
  let closedAt = 0;
  let nextFlightId = 0;
  const active = new Map<number, HostOperationFlight>();
  // A closed-epoch journal retains settled operations until a drain explicitly
  // observes them. This prevents a fast settlement between drain rounds from
  // disappearing from the receipt.
  const shutdownJournal = new Map<number, HostOperationFlight>();
  // Unexpected runtime rejection is not a normal host-domain failure (those
  // resolve as typed ok:false results). Preserve it across retries so a caller
  // disappearing cannot erase shutdown failure evidence.
  const shutdownCauses = new Map<number, HostOperationShutdownCause>();
  let drainFlight: Promise<HostOperationShutdownReceipt> | undefined;

  const sortedLabels = (
    flights: Iterable<HostOperationFlight>,
  ): ReadonlyArray<HostOperationAdmission["label"]> =>
    [...flights]
      .sort((left, right) => left.id - right.id)
      .map((flight) => flight.admission.label);

  const run = <A>(
    admission: HostOperationAdmission,
    operation: () => Promise<A>,
  ): Promise<A> => {
    if (phase === "closed") {
      return Promise.reject(new HostOperationShutdownRefused(admission, closedAt));
    }

    const id = ++nextFlightId;
    let resolvePublished!: (value: A) => void;
    let rejectPublished!: (error: unknown) => void;
    const published = new Promise<A>((resolve, reject) => {
      resolvePublished = resolve;
      rejectPublished = reject;
    });
    // This promise is only the pre-publication witness for synchronous
    // reentrancy. The exact operation promise replaces it on the record below.
    void published.catch(() => undefined);
    const flight: HostOperationFlight = {
      id,
      admission,
      promise: published,
      status: "pending",
    };
    active.set(id, flight);

    let exact: Promise<A>;
    try {
      // IPC callers pass the exact AppRuntime.runPromise result here. Do not
      // wrap it: identity is part of the lifetime authority.
      exact = operation();
    } catch (error) {
      exact = Promise.reject(error);
    }
    flight.promise = exact;

    // Bridge a drain that re-entered synchronously from the operation factory
    // and captured the pre-publication witness.
    void exact.then(resolvePublished, rejectPublished);

    const retireFulfilled = (): void => {
      flight.status = "fulfilled";
      if (active.get(id) === flight) active.delete(id);
    };
    const retireRejected = (error: unknown): void => {
      flight.status = "rejected";
      if (active.get(id) === flight) active.delete(id);
      if (phase === "closed") {
        shutdownCauses.set(
          id,
          Object.freeze({
            label: admission.label,
            message: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    };
    // Two handlers avoid the rejected promise manufactured by ignored finally.
    void exact.then(retireFulfilled, retireRejected);
    return exact;
  };

  const beginShutdown = (): HostOperationShutdownPrecommitReceipt => {
    if (phase === "open") {
      phase = "closed";
      closedAt = Date.now();
      for (const [id, flight] of active) shutdownJournal.set(id, flight);
    }
    return Object.freeze({
      phase: "closed",
      closedAt,
      activeLabels: Object.freeze([...sortedLabels(active.values())]),
    });
  };

  const retainedReceipt = (counts: {
    readonly rounds: number;
    readonly settled: number;
    readonly fulfilled: number;
    readonly rejected: number;
    readonly timedOut: boolean;
  }): HostOperationShutdownReceipt => {
    // Defensive fixed-point closure: every pre-cut active operation must remain
    // visible even if a future refactor changes beginShutdown sequencing.
    for (const [id, flight] of active) shutdownJournal.set(id, flight);
    const retainedLabels = sortedLabels(shutdownJournal.values());
    const causes = [...shutdownCauses.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, cause]) => cause);
    return Object.freeze({
      phase: "closed",
      clean:
        !counts.timedOut &&
        retainedLabels.length === 0 &&
        active.size === 0 &&
        counts.rejected === 0 &&
        causes.length === 0,
      timedOut: counts.timedOut,
      rounds: counts.rounds,
      settled: counts.settled,
      fulfilled: counts.fulfilled,
      rejected: counts.rejected,
      retained: retainedLabels.length,
      retainedLabels: Object.freeze([...retainedLabels]),
      causes: Object.freeze(causes),
    });
  };

  const drainOnQuit = (): Promise<HostOperationShutdownReceipt> => {
    beginShutdown();
    if (drainFlight !== undefined) return drainFlight;

    const currentDrain = (async (): Promise<HostOperationShutdownReceipt> => {
      const deadline = performance.now() + shutdownDeadlineMs;
      let rounds = 0;
      let settled = 0;
      let fulfilled = 0;
      let rejected = 0;

      for (;;) {
        for (const [id, flight] of active) shutdownJournal.set(id, flight);
        const round = [...shutdownJournal.values()].sort(
          (left, right) => left.id - right.id,
        );
        if (round.length === 0) {
          // Promise settlement continuations may update the active registry in
          // adjacent turns. Require a true fixed point before claiming clean.
          await nextNativeTurn();
          for (const [id, flight] of active) shutdownJournal.set(id, flight);
          if (shutdownJournal.size === 0 && active.size === 0) {
            return retainedReceipt({
              rounds,
              settled,
              fulfilled,
              rejected,
              timedOut: false,
            });
          }
          continue;
        }

        const outcome = await allSettledBefore(
          round.map((flight) => flight.promise),
          deadline,
        );
        if (outcome.timedOut) {
          return retainedReceipt({
            rounds,
            settled,
            fulfilled,
            rejected,
            timedOut: true,
          });
        }

        rounds += 1;
        settled += outcome.outcomes.length;
        fulfilled += outcome.outcomes.filter(
          (entry) => entry.status === "fulfilled",
        ).length;
        rejected += outcome.outcomes.filter(
          (entry) => entry.status === "rejected",
        ).length;
        for (const [index, entry] of outcome.outcomes.entries()) {
          if (entry.status !== "rejected") continue;
          const flight = round[index];
          if (flight === undefined || shutdownCauses.has(flight.id)) continue;
          shutdownCauses.set(
            flight.id,
            Object.freeze({
              label: flight.admission.label,
              message:
                entry.reason instanceof Error
                  ? entry.reason.message
                  : String(entry.reason),
            }),
          );
        }
        for (const flight of round) shutdownJournal.delete(flight.id);
        await nextNativeTurn();
      }
    })();

    drainFlight = currentDrain;
    void currentDrain.then(
      () => {
        if (drainFlight === currentDrain) drainFlight = undefined;
      },
      () => {
        if (drainFlight === currentDrain) drainFlight = undefined;
      },
    );
    return currentDrain;
  };

  return Object.freeze({
    run,
    beginShutdown,
    drainOnQuit,
    snapshot: () =>
      Object.freeze({
        phase,
        activeLabels: Object.freeze([...sortedLabels(active.values())]),
      }),
  });
};

/** One admission authority for every host IPC operation in this process. */
export const hostOperationGate = createHostOperationGate();

/** Narrow port consumed by the aggregate main-process shutdown coordinator. */
export const hostOperationsShutdown: HostOperationsShutdownPort = Object.freeze({
  beginShutdown: hostOperationGate.beginShutdown,
  drainOnQuit: hostOperationGate.drainOnQuit,
});
