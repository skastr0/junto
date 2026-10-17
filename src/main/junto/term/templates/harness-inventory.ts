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
 *
 * Every machine's core runs one of these over its own CLIs. `machine` answers
 * that machine's snapshot in the harness domain's shape at once and never
 * waits on a scan: what a peer receives over the link (docs/machines.md,
 * Harness inventory). It carries no paths, and every list and string is cut
 * to a bound.
 */
import { mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Context, Deferred, Duration, Effect, Layer, Schema, Semaphore } from "effect";
import type { ManagedTerminalModelsResult } from "@shared/ipc";
import { resolveJuntoHome } from "@shared/junto-home";
import { isHarnessId, templateFor } from "@shared/managed-terminal-templates";
import {
  InventoryUnavailableError,
  type HarnessInventory as HarnessSnapshot,
  type InventoryScanFailure,
  type MachineInventory,
} from "@shared/harness-domain/inventory";
import { runCli } from "../../adapters/exec";
import { MachineRepository } from "../../machines/repository";
import { enumerateManagedModels } from "./enumerate-dispatch";
import { probeManagedHarnessInstalls, type HarnessInstallProbe } from "./harness-install";

export const MODEL_LIST_TTL = Duration.hours(6);
const FAILED_SCAN_RETRY = Duration.minutes(1);
// The CLI call carries its own 8s deadline; this bounds everything around it.
const SCAN_DEADLINE = Duration.seconds(12);
const SCAN_CONCURRENCY = 4;
const WARM_DELAY = Duration.seconds(15);
const VERSION_COMMAND_TIMEOUT_MS = 5_000;
const CACHE_FILE_VERSION = 2;

// Bounds on what a snapshot carries, so a peer's answer has a fixed maximum size.
const MAX_MODELS = 200;
const MAX_EFFORTS = 16;
const MAX_ID = 200;
const MAX_TEXT = 500;
const MAX_VERSION = 64;

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
  version: Schema.optionalKey(Schema.String),
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
  readonly failure?: { readonly reason: "timeout" | "failed"; readonly message: string };
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
  /** This machine's snapshot, answered at once; stale or missing lists start a scan behind it. */
  readonly machine: Effect.Effect<MachineInventory, InventoryUnavailableError>;
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
const clip = (text: string, max: number): string => text.length <= max ? text : text.slice(0, max);

// First version-shaped token of `--version`, e.g. "2.1.300" from "2.1.300 (Claude Code)".
export const parseHarnessVersion = (output: string): string | undefined => {
  const match = /\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?/.exec(output);
  return match ? clip(match[0], MAX_VERSION) : undefined;
};

const readVersion = (executable: string): Effect.Effect<string | undefined> =>
  Effect.tryPromise({
    try: (signal) => runCli(executable, ["--version"], VERSION_COMMAND_TIMEOUT_MS, signal),
    catch: () => undefined,
  }).pipe(
    Effect.map((result) => result.ok ? parseHarnessVersion(`${result.stdout}\n${result.stderr ?? ""}`) : undefined),
    Effect.orElseSucceed(() => undefined),
  );

const fingerprintOf = (executable: string): Effect.Effect<string> =>
  Effect.tryPromise(async () => {
    const real = await realpath(executable);
    const info = await stat(real);
    return `${real}:${info.size}:${Math.trunc(info.mtimeMs)}`;
  }).pipe(Effect.orElseSucceed(() => executable));

export const makeHarnessInventory = (options: {
  readonly cachePath: string;
  readonly warm: boolean;
  /** This machine's name, as canvases and peers know it. */
  readonly machineName: Effect.Effect<string, unknown>;
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
    for (const [harness, { fingerprint, scannedAt, version, result, failed }] of entries) {
      if (!failed) harnesses[harness] = { fingerprint, scannedAt, ...(version === undefined ? {} : { version }), result };
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

  const scan = (harness: string, executable: string, fingerprint: string): Effect.Effect<ManagedTerminalModelsResult> =>
    scanPermits.withPermits(1)(Effect.all([
      enumerate(harness).pipe(
        Effect.map((result): { readonly result: ManagedTerminalModelsResult; readonly failure: Entry["failure"] } => ({
          result,
          failure: result.error === undefined ? undefined : { reason: "failed", message: result.error },
        })),
        Effect.catch((error: HarnessModelScanError) => Effect.succeed({
          result: emptyResult(harness, error.message),
          failure: { reason: error.reason, message: error.message },
        })),
      ),
      readVersion(executable),
    ], { concurrency: 2 })).pipe(
      Effect.tap(([{ result, failure }, version]) => Effect.gen(function* () {
        entries.set(harness, {
          fingerprint,
          scannedAt: Date.now(),
          ...(version === undefined ? {} : { version }),
          result,
          failed: failure !== undefined,
          ...(failure === undefined ? {} : { failure }),
        });
        if (failure === undefined) yield* persist;
      })),
      Effect.map(([{ result }]) => result),
    );

  // One scan per harness at a time, owned by this service's scope.
  const scanShared = (harness: string, executable: string, fingerprint: string) => Effect.gen(function* () {
    const running = inFlight.get(harness);
    if (running) return running;
    const done = Deferred.makeUnsafe<ManagedTerminalModelsResult>();
    inFlight.set(harness, done);
    yield* scan(harness, executable, fingerprint).pipe(
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
        yield* scanShared(harness, probe.executable, fingerprint);
      }
      return entry.result;
    }
    return yield* Deferred.await(yield* scanShared(harness, probe.executable, fingerprint));
  });

  // One harness as a peer may see it: the last good answer at once, a scan
  // started behind it when that answer is missing, stale or from another
  // executable. No executable path leaves this function.
  const snapshotOf = (probe: HarnessInstallProbe, machine: string) => Effect.gen(function* () {
    const efforts = templateFor(probe.harness).efforts.slice(0, MAX_EFFORTS);
    if (!probe.installed || probe.executable === undefined) {
      const row: HarnessSnapshot = { harness: probe.harness, machine, installed: false, models: [], efforts, refreshing: false };
      return row;
    }
    const fingerprint = yield* fingerprintOf(probe.executable);
    const entry = entries.get(probe.harness);
    const current = entry !== undefined && entry.fingerprint === fingerprint ? entry : undefined;
    const age = current === undefined ? undefined : Duration.millis(Date.now() - current.scannedAt);
    const due = current === undefined || age === undefined
      || (current.failed ? !Duration.isLessThan(age, FAILED_SCAN_RETRY) : Duration.isGreaterThanOrEqualTo(age, MODEL_LIST_TTL));
    if (due) yield* scanShared(probe.harness, probe.executable, fingerprint);
    const result = current?.result;
    const failure: InventoryScanFailure | undefined = current?.failure === undefined
      ? undefined
      : { reason: current.failure.reason, message: clip(current.failure.message, MAX_TEXT), at: current.scannedAt };
    const row: HarnessSnapshot = {
      harness: probe.harness,
      machine,
      installed: true,
      ...(current?.version === undefined ? {} : { version: current.version }),
      models: (result?.models ?? []).slice(0, MAX_MODELS).map((model) => ({
        id: clip(model.id, MAX_ID),
        label: clip(model.label, MAX_ID),
        ...(model.description === undefined ? {} : { description: clip(model.description, MAX_TEXT) }),
        ...(model.efforts === undefined ? {} : { efforts: model.efforts.slice(0, MAX_EFFORTS).map((effort) => clip(effort, MAX_ID)) }),
      })),
      efforts: (result?.efforts ?? efforts).slice(0, MAX_EFFORTS).map((effort) => clip(effort, MAX_ID)),
      ...(current === undefined || current.failed ? {} : { scannedAt: current.scannedAt }),
      refreshing: inFlight.has(probe.harness),
      ...(failure === undefined ? {} : { lastFailure: failure }),
    };
    return row;
  });

  const machine = Effect.gen(function* () {
    const name = yield* options.machineName.pipe(
      Effect.mapError((cause) => new InventoryUnavailableError({
        machine: "",
        reason: "failed",
        message: `This machine's name could not be read: ${cause instanceof Error ? cause.message : String(cause)}`,
      })),
    );
    const probes = (yield* harnesses()).filter((probe) => isHarnessId(probe.harness));
    const rows = yield* Effect.forEach(probes, (probe) => snapshotOf(probe, name));
    const snapshot: MachineInventory = { machine: name, harnesses: rows };
    return snapshot;
  }).pipe(Effect.withSpan("HarnessInventory.machine"));

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

  return HarnessInventory.of({ harnesses, models, machine });
});

export const HarnessInventoryLive = Layer.effect(
  HarnessInventory,
  Effect.gen(function* () {
    const machines = yield* MachineRepository;
    return yield* makeHarnessInventory({
      cachePath: harnessModelCachePath(),
      warm: process.env.JUNTO_E2E !== "1",
      machineName: machines.machineName,
    });
  }),
);

