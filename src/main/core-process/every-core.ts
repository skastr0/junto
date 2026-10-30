import { Effect, Fiber, Schedule, Schema } from "effect";

/**
 * What main asks of a core once and loses when that core stops: its watches,
 * and the reads main keeps from boot. Each core keeps its subscriptions in its
 * own memory, so a new core has none until it is asked (Wave 3). Main registers
 * each ask here once; every one runs again when a core says `core.ready`.
 * Asking is idempotent per core, as every watch guards itself.
 */

class CoreAskFailed extends Schema.TaggedError<CoreAskFailed>()("CoreAskFailed", {
  label: Schema.String,
  message: Schema.String,
}) {}

type Ask = () => Promise<unknown>;

const asks = new Map<string, Ask>();
let round: Fiber.Fiber<void> | undefined;

const asked = (label: string, ask: Ask): Effect.Effect<void> =>
  Effect.tryPromise({
    try: ask,
    catch: (cause) => new CoreAskFailed({ label, message: cause instanceof Error ? cause.message : String(cause) }),
  }).pipe(
    Effect.retry({ schedule: Schedule.exponential("1 second"), times: 5 }),
    Effect.catchTag("CoreAskFailed", (failure) => Effect.logWarning(`core: ${failure.label} was not answered: ${failure.message}`)),
    Effect.asVoid,
  );

/** Ask now, and again of every core after. One label holds one ask. */
export const askOnEveryCore = (label: string, ask: Ask): void => {
  asks.set(label, ask);
  Effect.runFork(asked(label, ask));
};

/** Ask of every core after this one, for a caller that asks this one itself. */
export const askOnLaterCores = (label: string, ask: Ask): void => {
  asks.set(label, ask);
};

/** A core is ready: ask it everything, then `then`. A newer core takes over from a round still running. */
export const askEveryCoreAsk = (then: () => void): void => {
  if (round !== undefined) Effect.runFork(Fiber.interrupt(round));
  round = Effect.runFork(
    Effect.forEach([...asks], ([label, ask]) => asked(label, ask), { concurrency: "unbounded", discard: true }).pipe(
      Effect.andThen(Effect.sync(then)),
    ),
  );
};
