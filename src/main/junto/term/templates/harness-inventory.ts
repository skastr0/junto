/**
 * Which agent CLIs this machine has and which models each one offers.
 *
 * Install discovery is cheap and already shared for a minute. Model lists are
 * not: each one is a CLI call that takes seconds, and the answer only changes
 * when the CLI changes. So model lists live on disk for six hours, keyed by
 * the executable they came from, and every reader gets the stored answer at
 * once. A list older than six hours is still served while a fresh scan runs
 * behind it; a changed executable is scanned before it is served.
 *
 * Scans run as fibers of this service, never of the caller: a closed settings
 * page does not cancel a scan another reader is waiting on, and closing the
 * runtime interrupts every scan, which aborts the CLI and kills its process
 * group. At most a few CLIs run at once, each under a hard deadline.
 */
import { mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Context, Deferred, Duration, Effect, Layer, Schema, Semaphore } from "effect";
import type { ManagedTerminalModelsResult } from "@shared/ipc";
import { resolveJuntoHome } from "@shared/junto-home";
import { isHarnessId, templateFor } from "@shared/managed-terminal-templates";
import { enumerateManagedModels } from "./enumerate-dispatch";
import { probeManagedHarnessInstalls, type HarnessInstallProbe } from "./harness-install";

export const MODEL_LIST_TTL = Duration.hours(6);
const FAILED_SCAN_RETRY = Duration.minutes(1);
// The CLI call carries its own 8s deadline; this bounds everything around it.
const SCAN_DEADLINE = Duration.seconds(12);
const SCAN_CONCURRENCY = 4;
const WARM_DELAY = Duration.seconds(15);
const CACHE_FILE_VERSION = 1;

export class HarnessModelScanError extends Schema.TaggedError<HarnessModelScanError>()(
  "HarnessModelScanError",
  {
    harness: Schema.String,
    reason: Schema.Literals(["timeout", "failed"]),
    message: Schema.String,
  },
) {}

const ModelOption = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  description: Schema.optionalKey(Schema.String),
  efforts: Schema.optionalKey(Schema.Array(Schema.String)),
});

const ModelsResult = Schema.Struct({
  models: Schema.Array(ModelOption),
  source: Schema.Literals(["cache", "aliases", "command", "empty"]),
  error: Schema.optionalKey(Schema.String),
  efforts: Schema.Array(Schema.String),
});

const StoredModels = Schema.Struct({
  fingerprint: Schema.String,
  scannedAt: Schema.Number,
  result: ModelsResult,
});
type StoredModels = typeof StoredModels.Type;

const CacheFile = Schema.Struct({
  version: Schema.Literal(CACHE_FILE_VERSION),
  harnesses: Schema.Record(Schema.String, StoredModels),
});

const decodeCacheFile = Schema.decodeUnknownEffect(Schema.fromJsonString(CacheFile));

type Entry = StoredModels & {
  /** Failed scans are remembered briefly and never written to disk. */
  readonly failed: boolean;
};

export interface ModelsOptions {
  /** Scan now and wait for it, whatever the cache holds. */
  readonly refresh?: boolean;
}

export class HarnessInventory extends Context.Service<HarnessInventory, {
  readonly harnesses: (
    options?: { readonly refresh?: boolean },
  ) => Effect.Effect<readonly HarnessInstallProbe[]>;
  readonly models: (
    harness: string,
    options?: ModelsOptions,
  ) => Effect.Effect<ManagedTerminalModelsResult>;
}>()("@junto/HarnessInventory") {}

export const harnessModelCachePath = (): string =>
  join(resolveJuntoHome(), ".junto", "state", "harness-models.json");

const emptyResult = (harness: string, error?: string): ManagedTerminalModelsResult => ({
  models: [],
  source: "empty",
  efforts: isHarnessId(harness) ? [...templateFor(harness).efforts] : [],
  ...(error === undefined ? {} : { error }),
});

// Identity of the executable on disk: an upgrade replaces the file, so its
// resolved path, size or mtime moves and the stored list no longer applies.
const fingerprintOf = (executable: string): Effect.Effect<string> =>
  Effect.tryPromise(async () => {
    const real = await realpath(executable);
    const info = await stat(real);
    return `${real}:${info.size}:${Math.trunc(info.mtimeMs)}`;
  }).pipe(Effect.orElseSucceed(() => executable));

export const makeHarnessInventory = (options: {
  readonly cachePath: string;
  readonly warm: boolean;
}) => Effect.gen(function* () {
  const scope = yield* Effect.scope;
  const scanPermits = yield* Semaphore.make(SCAN_CONCURRENCY);
  const writePermit = yield* Semaphore.make(1);
  const entries = new Map<string, Entry>();
  const inFlight = new Map<string, Deferred.Deferred<ManagedTerminalModelsResult>>();

  const stored = yield* Effect.tryPromise(() => readFile(options.cachePath, "utf8")).pipe(
    Effect.flatMap(decodeCacheFile),
    Effect.orElseSucceed(() => undefined),
  );
  for (const [harness, entry] of Object.entries(stored?.harnesses ?? {})) {
    entries.set(harness, { ...entry, failed: false });
  }

  const persist = writePermit.withPermits(1)(Effect.gen(function* () {
    const harnesses: Record<string, StoredModels> = {};
    for (const [harness, { fingerprint, scannedAt, result, failed }] of entries) {
      if (!failed) harnesses[harness] = { fingerprint, scannedAt, result };
    }
    const text = `${JSON.stringify({ version: CACHE_FILE_VERSION, harnesses }, null, 2)}\n`;
    const temp = `${options.cachePath}.${process.pid}.tmp`;
    yield* Effect.tryPromise(async () => {
      await mkdir(dirname(options.cachePath), { recursive: true });
      await writeFile(temp, text, "utf8");
      await rename(temp, options.cachePath);
    });
  })).pipe(
    Effect.catch((error) => Effect.logWarning("harness model cache write failed", error)),
  );

  const enumerate = (harness: string): Effect.Effect<ManagedTerminalModelsResult, HarnessModelScanError> =>
    Effect.tryPromise({
      try: (signal) => enumerateManagedModels(harness, signal),
      catch: (cause) => new HarnessModelScanError({
        harness,
        reason: "failed",
        message: cause instanceof Error ? cause.message : String(cause),
      }),
    }).pipe(
      Effect.timeoutOrElse({
        duration: SCAN_DEADLINE,
        orElse: () => Effect.fail(new HarnessModelScanError({
          harness,
          reason: "timeout",
          message: `${harness} did not list its models within ${Duration.format(SCAN_DEADLINE)}`,
        })),
      }),
    );

  const scan = (harness: string, fingerprint: string): Effect.Effect<ManagedTerminalModelsResult> =>
    scanPermits.withPermits(1)(enumerate(harness)).pipe(
      Effect.map((result) => ({ result, failed: result.error !== undefined })),
      Effect.catchTag("HarnessModelScanError", (error) =>
        Effect.succeed({ result: emptyResult(harness, error.message), failed: true })),
      Effect.tap(({ result, failed }) => Effect.gen(function* () {
        entries.set(harness, { fingerprint, scannedAt: Date.now(), result, failed });
        if (!failed) yield* persist;
      })),
      Effect.map(({ result }) => result),
    );

  // One scan per harness at a time, owned by this service's scope.
  const scanShared = (harness: string, fingerprint: string) => Effect.gen(function* () {
    const running = inFlight.get(harness);
    if (running) return running;
    const done = Deferred.makeUnsafe<ManagedTerminalModelsResult>();
    inFlight.set(harness, done);
    yield* scan(harness, fingerprint).pipe(
      Effect.exit,
      Effect.flatMap((exit) => Deferred.done(done, exit)),
      Effect.ensuring(Effect.sync(() => inFlight.delete(harness))),
      Effect.forkIn(scope),
    );
    return done;
  });

  const harnesses = (opts?: { readonly refresh?: boolean }) =>
    Effect.promise(() => probeManagedHarnessInstalls(opts?.refresh ? { refresh: true } : {}));

  const models = Effect.fn("HarnessInventory.models")(function* (
    harness: string,
    opts?: ModelsOptions,
  ) {
    if (!isHarnessId(harness)) {
      return yield* Effect.promise(() => enumerateManagedModels(harness));
    }
    const probe = (yield* harnesses()).find((row) => row.harness === harness);
    if (!probe?.installed || probe.executable === undefined) return emptyResult(harness);
    const fingerprint = yield* fingerprintOf(probe.executable);
    const entry = entries.get(harness);
    const age = entry ? Duration.millis(Date.now() - entry.scannedAt) : undefined;
    const usable = entry !== undefined && age !== undefined && entry.fingerprint === fingerprint
      && (!entry.failed || Duration.isLessThan(age, FAILED_SCAN_RETRY));
    if (usable && opts?.refresh !== true) {
      if (!entry.failed && Duration.isGreaterThanOrEqualTo(age, MODEL_LIST_TTL)) {
        yield* scanShared(harness, fingerprint);
      }
      return entry.result;
    }
    return yield* Deferred.await(yield* scanShared(harness, fingerprint));
  });

  if (options.warm) {
    // Fill the cache in the background so pickers open on stored answers.
    yield* Effect.gen(function* () {
      yield* Effect.sleep(WARM_DELAY);
      const installed = (yield* harnesses()).filter((row) => row.installed);
      yield* Effect.forEach(installed, (row) => models(row.harness), {
        concurrency: SCAN_CONCURRENCY,
        discard: true,
      });
    }).pipe(Effect.forkIn(scope));
  }

  return HarnessInventory.of({ harnesses, models });
});

export const HarnessInventoryLive = Layer.effect(
  HarnessInventory,
  Effect.suspend(() => makeHarnessInventory({
    cachePath: harnessModelCachePath(),
    warm: process.env.JUNTO_E2E !== "1",
  })),
);

