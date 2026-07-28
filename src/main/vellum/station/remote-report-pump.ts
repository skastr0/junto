import { Effect, Either } from "effect";
import { StationApiService } from "./api";
import { StationRepository } from "./repository";
import {
  StationControlReportError,
  type StationControlServer,
} from "./control-server";
import { WorkRepository } from "../work/repository";

const MAX_REPORT_ROUNDS_PER_WAKE = 32;
const REPORT_RETRY_INITIAL_DELAY_MS = 100;
const REPORT_RETRY_MAX_DELAY_MS = 5_000;

type StationApiShape = Pick<
  typeof StationApiService.Service,
  "prepareReport" | "acceptReportResponse"
>;
type StationRepositoryShape = Pick<
  typeof StationRepository.Service,
  "configuration" | "pairing"
>;
type WorkRepositoryShape = Pick<
  typeof WorkRepository.Service,
  "subscribeChanges"
>;

export type StationRemoteReportPumpStatus = {
  readonly running: boolean;
  readonly pending: boolean;
  readonly lastCompletedAt?: string;
  readonly lastFailure?: string;
};

export interface StationRemoteReportPump {
  /** Coalesce one durable-work invalidation into the current report drain. */
  readonly request: () => void;
  readonly status: () => StationRemoteReportPumpStatus;
  readonly close: () => Promise<void>;
}

export type StationRemoteReportPumpInput = {
  readonly api: StationApiShape;
  readonly stations: StationRepositoryShape;
  readonly work: WorkRepositoryShape;
  readonly control: Pick<
    StationControlServer,
    "report" | "sessionReady" | "subscribeSession"
  >;
  readonly reportRoundLimit?: number;
  /** Tests may lower the retry delay; production callers use the protocol policy. */
  readonly retryPolicy?: Partial<StationRemoteReportRetryPolicy>;
};

export type StationRemoteReportRetryPolicy = {
  readonly initialDelayMs: number;
  readonly maxDelayMs: number;
};

export const STATION_REMOTE_REPORT_RETRY_POLICY: StationRemoteReportRetryPolicy =
  Object.freeze({
    initialDelayMs: REPORT_RETRY_INITIAL_DELAY_MS,
    maxDelayMs: REPORT_RETRY_MAX_DELAY_MS,
  });

const describeFailure = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const boundedRoundLimit = (requested: number | undefined): number =>
  requested !== undefined &&
    Number.isSafeInteger(requested) &&
    requested > 0 &&
    requested <= MAX_REPORT_ROUNDS_PER_WAKE
    ? requested
    : MAX_REPORT_ROUNDS_PER_WAKE;

const boundedRetryDelay = (
  requested: number | undefined,
  fallback: number,
): number =>
  requested !== undefined &&
    Number.isSafeInteger(requested) &&
    requested >= 0
    ? requested
    : fallback;

const retryPolicy = (
  requested: Partial<StationRemoteReportRetryPolicy> | undefined,
): StationRemoteReportRetryPolicy => {
  const initialDelayMs = boundedRetryDelay(
    requested?.initialDelayMs,
    STATION_REMOTE_REPORT_RETRY_POLICY.initialDelayMs,
  );
  const maxDelayMs = Math.max(
    initialDelayMs,
    boundedRetryDelay(
      requested?.maxDelayMs,
      STATION_REMOTE_REPORT_RETRY_POLICY.maxDelayMs,
    ),
  );
  return Object.freeze({ initialDelayMs, maxDelayMs });
};

const reportRetryDelay = (
  attempt: number,
  policy: StationRemoteReportRetryPolicy,
): number =>
  Math.min(
    policy.maxDelayMs,
    policy.initialDelayMs * 2 ** Math.min(attempt, 16),
  );

/**
 * Only failures whose typed Station boundary says that the same live session
 * can make progress qualify. Session loss is recovered by session replacement;
 * malformed, unauthorized, and state-conflicting traffic parks until state
 * changes instead of becoming an autonomous retry loop.
 */
const retryableOnSameSession = (error: unknown): boolean => {
  if (!(error instanceof StationControlReportError)) return false;
  if (error.failure === "capacity-exceeded") return true;
  return (
    error.failure === "remote-rejected" &&
    error.envelope?.ok === false &&
    error.envelope.error.retryable
  );
};

/**
 * Drain Remote-owned facts and Remote→CC commands over the already admitted
 * Command Center session.
 *
 * This is a wake-driven process-local coordinator. SQLite records and cursors
 * remain the durable truth; losing this object loses no work. It never opens a
 * route, polls, retries a disconnected peer, or changes authority.
 */
export const startStationRemoteReportPump = (
  input: StationRemoteReportPumpInput,
): StationRemoteReportPump => {
  const roundLimit = boundedRoundLimit(input.reportRoundLimit);
  const retry = retryPolicy(input.retryPolicy);
  let closed = false;
  let pending = false;
  let running = false;
  let sessionGeneration = 0;
  let retryAttempt = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let lastCompletedAt: string | undefined;
  let lastFailure: string | undefined;
  let currentDrain: Promise<void> = Promise.resolve();

  const reconcile = Effect.gen(function* () {
    const configuration = yield* input.stations.configuration;
    if (configuration?.configuration.role !== "remote") return;
    const pairing = yield* input.stations.pairing;
    if (pairing === undefined || !input.control.sessionReady()) return;

    for (let round = 0; round < roundLimit; round += 1) {
      const request = yield* input.api.prepareReport(
        pairing.commandCenterInstallationId,
      );
      const response = yield* Effect.tryPromise({
        try: () => input.control.report(request),
        // Preserve StationControlReportError: its retryability is protocol
        // policy, not text for this coordinator to reinterpret.
        catch: (cause) => cause,
      });
      const integrated = yield* input.api.acceptReportResponse(
        pairing.commandCenterInstallationId,
        request,
        response,
      );
      if (!request.batch.hasMore && !integrated.peerHasMore) return;
    }

    // Yield a bounded page window to the event loop, then keep the same
    // durable cursor drain pending. This is backlog convergence, not polling.
    pending = true;
  });

  const clearRetryTimer = (): void => {
    if (retryTimer === undefined) return;
    clearTimeout(retryTimer);
    retryTimer = undefined;
  };

  const scheduleRetry = (
    expectedSessionGeneration: number,
    delayMs: number,
  ): void => {
    clearRetryTimer();
    const timer = setTimeout(() => {
      if (retryTimer !== timer) return;
      retryTimer = undefined;
      if (
        closed ||
        expectedSessionGeneration !== sessionGeneration ||
        !input.control.sessionReady()
      ) {
        return;
      }
      beginDrain();
    }, delayMs);
    timer.unref();
    retryTimer = timer;
  };

  const beginDrain = (): void => {
    if (closed || running || !pending || retryTimer !== undefined) return;
    running = true;
    currentDrain = (async () => {
      try {
        while (!closed && pending) {
          pending = false;
          const attemptedSessionGeneration = sessionGeneration;
          try {
            const attempted = await Effect.runPromise(
              Effect.either(reconcile),
            );
            if (Either.isRight(attempted)) {
              lastCompletedAt = new Date().toISOString();
              lastFailure = undefined;
              retryAttempt = 0;
            } else {
              const error = attempted.left;
              lastFailure = describeFailure(error);
              if (
                retryableOnSameSession(error) &&
                attemptedSessionGeneration === sessionGeneration &&
                input.control.sessionReady()
              ) {
                // Durable rows remain after the peer ACK. Keep their drain
                // pending and give the same admitted session bounded
                // exponential backoff. The capped counter prevents overflow;
                // the timer remains a protocol wake until success or session
                // replacement, not a general polling fallback.
                pending = true;
                const delayMs = reportRetryDelay(retryAttempt, retry);
                retryAttempt = Math.min(retryAttempt + 1, 16);
                scheduleRetry(attemptedSessionGeneration, delayMs);
              }
              break;
            }
          } catch (defect) {
            lastFailure = describeFailure(defect);
            break;
          }
          if (pending) await Promise.resolve();
        }
      } finally {
        running = false;
        if (!closed && pending && retryTimer === undefined) {
          queueMicrotask(beginDrain);
        }
      }
    })();
  };

  const request = (): void => {
    if (closed) return;
    pending = true;
    beginDrain();
  };

  const unsubscribeWork = input.work.subscribeChanges(() => request());
  const unsubscribeSession = input.control.subscribeSession((ready) => {
    sessionGeneration += 1;
    retryAttempt = 0;
    clearRetryTimer();
    if (ready) request();
  });

  const status = (): StationRemoteReportPumpStatus => ({
    running,
    pending,
    ...(lastCompletedAt === undefined ? {} : { lastCompletedAt }),
    ...(lastFailure === undefined ? {} : { lastFailure }),
  });

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    pending = false;
    clearRetryTimer();
    unsubscribeWork();
    unsubscribeSession();
    await currentDrain;
  };

  return Object.freeze({ request, status, close });
};
