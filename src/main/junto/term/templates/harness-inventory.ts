/**
 * Which agent CLIs this machine has and which models each one offers.
 *
 * Install discovery is cheap and already shared for a minute. Model lists are
 * not: each one is a CLI call that takes seconds, and the answer only changes
 * when the CLI changes. So model lists are kept in junto.db for six hours
 * (`harness_model_cache`), keyed by the executable they came from, and every
 * reader gets the stored answer at once. A list older than six hours is still
 * served while a fresh scan runs behind it; a changed executable is scanned
 * before it is served. Nothing is written under the Junto home.
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
import { realpath, stat } from "node:fs/promises";
import { Context, Deferred, Duration, Effect, Layer, Option, Schema, Semaphore } from "effect";
import { SqlClient } from "effect/unstable/sql";
import type { ManagedTerminalModelsResult } from "@shared/ipc";
import { isHarnessId, templateFor } from "@shared/managed-terminal-templates";
import {
  InventoryProfile as InventoryProfileSchema,
  InventoryUnavailableError,
  type InventoryProfile,
  type HarnessInventory as HarnessSnapshot,
  type InventoryScanFailure,
  type MachineInventory,
  verifyVersion,
} from "@shared/harness-domain/inventory";
import { harnessRecordFor } from "@shared/harness-records";
import { type CliResult, runCli } from "../../adapters/exec";
import { scrubMessage } from "../../credentials/scrub";
import { MachineRepository } from "../../machines/repository";
import { StateTransactionOperation } from "../../state/service";
import { isModelId } from "@shared/model-id";
import { isProfileName, MAX_PROFILES } from "@shared/profile-name";
import { enumerateManagedModels, listManagedProfiles } from "./enumerate-dispatch";
import { probeManagedHarnessInstalls, type HarnessInstallProbe } from "./harness-install";

export const MODEL_LIST_TTL = Duration.hours(6);
const FAILED_SCAN_RETRY = Duration.minutes(1);
// The CLI call carries its own 8s deadline; this bounds everything around it.
const SCAN_DEADLINE = Duration.seconds(12);
const SCAN_CONCURRENCY = 4;
const WARM_DELAY = Duration.seconds(15);
const VERSION_COMMAND_TIMEOUT_MS = 5_000;

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
  /** Named profiles the harness listed, for a harness that keeps them. */
  profiles: Schema.optionalKey(Schema.Array(InventoryProfileSchema)),
});
export type StoredModels = typeof StoredModels.Type;

/** Where model lists are kept between runs. Losing one costs a scan, never an answer. */
export interface HarnessModelCache {
  readonly load: Effect.Effect<ReadonlyMap<string, StoredModels>>;
  readonly save: (harness: string, stored: StoredModels) => Effect.Effect<void>;
}

const CacheRow = Schema.Struct({
  harness: Schema.String,
  fingerprint: Schema.String,
  scanned_at: Schema.Number,
  version: Schema.NullOr(Schema.String),
  result: Schema.fromJsonString(ModelsResult),
  profiles: Schema.NullOr(Schema.fromJsonString(Schema.Array(InventoryProfileSchema))),
});

const decodeCacheRow = Schema.decodeUnknownOption(CacheRow);

/** The model cache as `harness_model_cache` rows in junto.db. */
export const harnessModelCacheIn = (sql: SqlClient.SqlClient): HarnessModelCache => ({
  load: sql`SELECT harness, fingerprint, scanned_at, version, result, profiles FROM harness_model_cache`.pipe(
    Effect.map((rows) => {
      const stored = new Map<string, StoredModels>();
      for (const raw of rows) {
        // A row that no longer reads is one scan away from a fresh one.
        const row = decodeCacheRow(raw);
        if (Option.isNone(row)) continue;
        const { harness, fingerprint, scanned_at, version, result, profiles } = row.value;
        stored.set(harness, {
          fingerprint, scannedAt: scanned_at, ...(version === null ? {} : { version }), result, ...(profiles === null ? {} : { profiles }),
        });
      }
      return stored;
    }),
    Effect.catch((error) => Effect.logWarning("harness model cache read failed", error).pipe(Effect.as(new Map()))),
  ),
  save: (harness, stored) => sql`
    INSERT INTO harness_model_cache(harness, fingerprint, scanned_at, version, result, profiles)
    VALUES (
      ${harness}, ${stored.fingerprint}, ${stored.scannedAt}, ${stored.version ?? null},
      ${JSON.stringify(stored.result)}, ${stored.profiles === undefined ? null : JSON.stringify(stored.profiles)}
    )
    ON CONFLICT(harness) DO UPDATE SET
      fingerprint = excluded.fingerprint,
      scanned_at = excluded.scanned_at,
      version = excluded.version,
      result = excluded.result,
      profiles = excluded.profiles
  `.pipe(
    Effect.asVoid,
    sql.withTransaction,
    Effect.provideService(StateTransactionOperation, "harness-models.save"),
    Effect.catch((error) => Effect.logWarning("harness model cache write failed", error)),
  ),
});

type Entry = StoredModels & {
  /** Failed scans are remembered briefly and never stored. */
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

/** Why `--version` gave no version: it timed out, could not start or exited, or printed none. */
export type VersionProbeMiss = {
  readonly reason: "timeout" | "spawn" | "exited" | "unparsed";
  readonly detail: string;
};

/** A `--version` run as its version, or as why it has none, with a short scrubbed detail for the log. */
export const versionProbeOutcome = (result: CliResult): { readonly version: string } | VersionProbeMiss => {
  if (result.ok) {
    const version = parseHarnessVersion(`${result.stdout}\n${result.stderr ?? ""}`);
    if (version !== undefined) return { version };
    return { reason: "unparsed", detail: clip(scrubMessage(`${result.stdout} ${result.stderr ?? ""}`.trim()), 160) };
  }
  const error = result.error ?? "";
  const reason = /^adapter command timed out\b/u.test(error)
    ? "timeout"
    : /\b(?:ENOENT|EACCES|ENOEXEC)\b|spawn failed/u.test(error) ? "spawn" : "exited";
  return { reason, detail: clip(scrubMessage(error), 160) };
};

// A miss is logged, so the machine's own log says why its version is absent.
const readVersion = (harness: string, executable: string): Effect.Effect<string | undefined> =>
  Effect.tryPromise({
    try: (signal) => runCli(executable, ["--version"], VERSION_COMMAND_TIMEOUT_MS, signal),
    catch: (cause) => cause,
  }).pipe(
    Effect.map(versionProbeOutcome),
    Effect.orElseSucceed((): VersionProbeMiss => ({ reason: "spawn", detail: "the version command did not run" })),
    Effect.flatMap((outcome) => "version" in outcome
      ? Effect.succeed(outcome.version)
      : Effect.logWarning("harness version not read", { harness, reason: outcome.reason, detail: outcome.detail, timeoutMs: VERSION_COMMAND_TIMEOUT_MS }).pipe(
        Effect.as(undefined),
      )),
    Effect.annotateLogs({ area: "inventory" }),
  );

/**
 * Profiles whose name fits the profile shape, each once, at most MAX_PROFILES;
 * a pinned model outside the model id shape is dropped, the profile kept.
 */
export const fittingProfiles = (profiles: readonly InventoryProfile[]): readonly InventoryProfile[] => {
  const seen = new Set<string>();
  const kept: InventoryProfile[] = [];
  for (const profile of profiles) {
    if (kept.length >= MAX_PROFILES || !isProfileName(profile.name) || seen.has(profile.name)) continue;
    seen.add(profile.name);
    kept.push({ name: profile.name, ...(profile.model !== undefined && isModelId(profile.model) ? { model: profile.model } : {}) });
  }
  return kept;
};

const fingerprintOf = (executable: string): Effect.Effect<string> =>
  Effect.tryPromise(async () => {
    const real = await realpath(executable);
    const info = await stat(real);
    return `${real}:${info.size}:${Math.trunc(info.mtimeMs)}`;
  }).pipe(Effect.orElseSucceed(() => executable));

export const makeHarnessInventory = (options: {
  readonly cache: HarnessModelCache;
  readonly warm: boolean;
  /** This machine's name, as canvases and peers know it. */
  readonly machineName: Effect.Effect<string, unknown>;
}) => Effect.gen(function* () {
  const scope = yield* Effect.scope;
  const scanPermits = yield* Semaphore.make(SCAN_CONCURRENCY);
  const entries = new Map<string, Entry>();
  const inFlight = new Map<string, Deferred.Deferred<ManagedTerminalModelsResult>>();

  for (const [harness, entry] of yield* options.cache.load) {
    entries.set(harness, { ...entry, failed: false });
  }

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

  // A list that cannot be read is no list.
  const readProfiles = (harness: string): Effect.Effect<readonly InventoryProfile[] | undefined> =>
    isHarnessId(harness)
      ? Effect.tryPromise((signal) => listManagedProfiles(harness, signal)).pipe(
        Effect.map((profiles) => profiles === undefined ? undefined : fittingProfiles(profiles)),
        Effect.orElseSucceed(() => undefined),
      )
      : Effect.succeed(undefined);

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
      readVersion(harness, executable),
      readProfiles(harness),
    ], { concurrency: 3 })).pipe(
      Effect.tap(([{ result, failure }, version, profiles]) => Effect.gen(function* () {
        const stored: StoredModels = {
          fingerprint,
          scannedAt: Date.now(),
          ...(version === undefined ? {} : { version }),
          ...(profiles === undefined ? {} : { profiles }),
          result,
        };
        entries.set(harness, { ...stored, failed: failure !== undefined, ...(failure === undefined ? {} : { failure }) });
        if (failure === undefined) yield* options.cache.save(harness, stored);
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
    const verified = harnessRecordFor(probe.harness)?.verified;
    const row: HarnessSnapshot = {
      harness: probe.harness,
      machine,
      installed: true,
      ...(current?.version === undefined ? {} : { version: current.version }),
      // An installed harness whose record names verified versions says where
      // this install sits; unknown until a version has been read.
      ...(verified === undefined ? {} : { verification: verifyVersion(current?.version, verified) }),
      models: (result?.models ?? []).slice(0, MAX_MODELS).map((model) => ({
        id: clip(model.id, MAX_ID),
        label: clip(model.label, MAX_ID),
        ...(model.description === undefined ? {} : { description: clip(model.description, MAX_TEXT) }),
        ...(model.efforts === undefined ? {} : { efforts: model.efforts.slice(0, MAX_EFFORTS).map((effort) => clip(effort, MAX_ID)) }),
      })),
      efforts: (result?.efforts ?? efforts).slice(0, MAX_EFFORTS).map((effort) => clip(effort, MAX_ID)),
      ...(current?.profiles === undefined ? {} : { profiles: fittingProfiles(current.profiles) }),
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
      cache: harnessModelCacheIn(yield* SqlClient.SqlClient),
      warm: process.env.JUNTO_E2E !== "1",
      machineName: machines.machineName,
    });
  }),
);

