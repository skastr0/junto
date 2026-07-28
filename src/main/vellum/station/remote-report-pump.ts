import { Effect } from "effect";
import { StationApiService } from "./api";
import {
  StationRepository,
  type StationRepositoryError,
} from "./repository";
import type { StationControlServer } from "./control-server";
import { WorkRepository } from "../work/repository";

const MAX_REPORT_ROUNDS_PER_WAKE = 32;

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
};

const describeFailure = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const boundedRoundLimit = (requested: number | undefined): number =>
  requested !== undefined &&
    Number.isSafeInteger(requested) &&
    requested > 0 &&
    requested <= MAX_REPORT_ROUNDS_PER_WAKE
    ? requested
    : MAX_REPORT_ROUNDS_PER_WAKE;

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
  let closed = false;
  let pending = false;
  let running = false;
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
        catch: (cause) => new Error(describeFailure(cause)),
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
  }).pipe(
    Effect.mapError((error: StationRepositoryError | unknown) => error),
  );

  const beginDrain = (): void => {
    if (closed || running || !pending) return;
    running = true;
    currentDrain = (async () => {
      try {
        while (!closed && pending) {
          pending = false;
          try {
            await Effect.runPromise(reconcile);
            lastCompletedAt = new Date().toISOString();
            lastFailure = undefined;
          } catch (error) {
            // A failed exchange remains fully recoverable from SQLite. Do not
            // spin; a work change or the next admitted session wakes it.
            lastFailure = describeFailure(error);
            break;
          }
          if (pending) await Promise.resolve();
        }
      } finally {
        running = false;
        if (!closed && pending) queueMicrotask(beginDrain);
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
    unsubscribeWork();
    unsubscribeSession();
    await currentDrain;
  };

  return Object.freeze({ request, status, close });
};
