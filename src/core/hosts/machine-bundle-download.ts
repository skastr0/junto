import { createHash } from "node:crypto";
import { constants, existsSync } from "node:fs";
import { open } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Clock, Effect, Schema, Scope } from "effect";
import { MachineInstallError } from "@shared/machine-install";
import { decodeMachineReleaseCatalog, type MachineReleaseArchive, type MachineReleaseCatalog } from "@shared/machine-release";
import type { MachineSendEvent } from "@shared/machine-progress";
import { unpackMachineReleaseArchive } from "./machine-bundle-archive";
import {
  acquireMachineBundleCache, releaseMachineBundleCache, createMachineBundleAttempt,
  discardMachineBundleAttempt, machineBundleAttemptPath, snapshotCachedMachineArchive,
  publishMachineArchive, pruneMachineBundleCache,
  type OwnedMachineBundleCache, type OwnedMachineBundleAttempt,
} from "./machine-bundle-cache";
import { makeDownloadProgress } from "./download-progress";
import { defaultMachineName } from "@shared/machine-name";
import { failureHere } from "./failure-here";
import { MACHINE_BUNDLE_DOWNLOAD_TIMEOUT_MS } from "@shared/machine-command-bounds";

export type MachineBundleAcquirer = (target: string, onTransition?: (event: MachineSendEvent) => void) => Effect.Effect<string, MachineInstallError, Scope.Scope>;
type DownloadFetch = (url: URL, init: RequestInit) => Promise<Response>;
interface Flight {
  readonly controller: AbortController;
  promise: Promise<void>;
  readonly observers: Set<(bytes: number) => void>;
  bytes: number;
  users: number;
}
const flights = new Map<string, Flight>();
// Compiled code bounds the one redirect; response headers cannot widen this list.
const releaseRedirectHosts: ReadonlySet<string> = new Set(["junto-releases.skastr052.workers.dev"]);
const redirectStatuses = new Set([301, 302, 303, 307, 308]);
/** Which download step failed; a fetch, parse or write failure stays as the cause. */
export const MachineBundleDownloadCheck = Schema.Literals(["release-server", "cancelled", "unreachable", "too-large", "save-failed", "check-failed",
  "interrupted", "catalog-mismatch", "no-platform", "disappeared"]);
export class MachineBundleDownloadFailed extends Schema.TaggedError<MachineBundleDownloadFailed>()("MachineBundleDownloadFailed", {
  check: MachineBundleDownloadCheck,
  message: Schema.String,
  /** HTTP status from the allow-listed release host, when it answered. */
  status: Schema.optionalKey(Schema.Number),
  /** Allow-listed host that answered or failed (never an untrusted Location header). */
  host: Schema.optionalKey(Schema.String),
  /** Compiled catalog archive path (/machines/<build>/<target>.tar.gz). */
  archivePath: Schema.optionalKey(Schema.String),
  /** Compiled catalog 64-hex build id. */
  build: Schema.optionalKey(Schema.String),
  /** Target platform requested from the catalog. */
  target: Schema.optionalKey(Schema.String),
  /** True when a redirect failed allow-list or single-hop checks. */
  redirectRefused: Schema.optionalKey(Schema.Boolean),
  cause: Schema.optionalKey(Schema.Defect()),
}) {}
type DownloadFailureMeta = {
  readonly status?: number;
  readonly host?: string;
  readonly archivePath?: string;
  readonly build?: string;
  readonly target?: string;
  readonly redirectRefused?: boolean;
};
const downloadFailed = (
  check: typeof MachineBundleDownloadCheck.Type,
  message: string,
  cause?: unknown,
  meta?: DownloadFailureMeta,
): MachineBundleDownloadFailed =>
  new MachineBundleDownloadFailed({
    check,
    message,
    ...(meta?.status === undefined ? {} : { status: meta.status }),
    ...(meta?.host === undefined ? {} : { host: meta.host }),
    ...(meta?.archivePath === undefined ? {} : { archivePath: meta.archivePath }),
    ...(meta?.build === undefined ? {} : { build: meta.build }),
    ...(meta?.target === undefined ? {} : { target: meta.target }),
    ...(meta?.redirectRefused === undefined ? {} : { redirectRefused: meta.redirectRefused }),
    ...(cause === undefined ? {} : { cause }),
  });
const releaseServerFailure = (cause?: unknown, meta?: DownloadFailureMeta): MachineBundleDownloadFailed =>
  downloadFailed(
    "release-server",
    meta?.status === 404 && meta.redirectRefused !== true
      ? "This Junto build is not on its release server. The machine has not changed"
      : "Cannot download this Junto build from its release server. The machine has not changed",
    cause,
    meta,
  );
const cancelled = (meta?: DownloadFailureMeta): MachineBundleDownloadFailed =>
  downloadFailed("cancelled", "Junto's download was interrupted. The machine has not changed", undefined, meta);

const download = async (input: {
  readonly archive: MachineReleaseArchive;
  readonly catalog: MachineReleaseCatalog;
  readonly cache: OwnedMachineBundleCache;
  readonly attempt: OwnedMachineBundleAttempt;
  readonly fetch: DownloadFetch;
  readonly signal: AbortSignal;
  readonly observe: (bytes: number) => void;
}): Promise<void> => {
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(MACHINE_BUNDLE_DOWNLOAD_TIMEOUT_MS)]);
  const original = new URL(input.archive.archivePath, input.catalog.origin);
  const baseMeta = {
    archivePath: input.archive.archivePath,
    build: input.catalog.build,
    target: input.archive.target,
  } as const;
  let host = original.host;
  const request: RequestInit = { redirect: "manual", signal, credentials: "omit", headers: { "Accept-Encoding": "identity" } };
  const get = async (url: URL): Promise<Response> => {
    try { return await input.fetch(url, request); }
    catch (cause) {
      throw input.signal.aborted
        ? downloadFailed("cancelled", cancelled().message, cause, { ...baseMeta, host: url.host })
        : downloadFailed("unreachable", "Cannot download Junto. Check your internet connection and send again. The machine has not changed", cause, { ...baseMeta, host: url.host });
    }
  };
  let response = await get(original);
  if (!response.redirected && redirectStatuses.has(response.status)) {
    const location = response.headers.get("location");
    await response.body?.cancel().catch(() => undefined);
    let destination: URL;
    try { destination = new URL(location ?? "", original); }
    catch (cause) {
      throw releaseServerFailure(cause, { ...baseMeta, status: response.status, host, redirectRefused: true });
    }
    if (!location || destination.protocol !== "https:" || !releaseRedirectHosts.has(destination.host) ||
      destination.pathname !== original.pathname || destination.search !== original.search || destination.hash ||
      destination.username || destination.password) {
      throw releaseServerFailure(undefined, { ...baseMeta, status: response.status, host, redirectRefused: true });
    }
    host = destination.host;
    response = await get(destination);
  }
  if (!response.ok || response.redirected || !response.body) {
    await response.body?.cancel().catch(() => undefined);
    const redirectRefused = response.redirected || redirectStatuses.has(response.status);
    throw releaseServerFailure(undefined, {
      ...baseMeta,
      status: response.status,
      host,
      ...(redirectRefused ? { redirectRefused: true } : {}),
    });
  }
  const file = await open(join(await machineBundleAttemptPath(input.attempt), "download.tar.gz"),
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  const reader = response.body.getReader();
  const abortReader = (): void => { void reader.cancel(cancelled()).catch(() => undefined); };
  signal.addEventListener("abort", abortReader, { once: true });
  try {
    const hash = createHash("sha256");
    let bytes = 0;
    for (;;) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) break;
      bytes += chunk.value.length;
      if (bytes > input.archive.archiveBytes) throw downloadFailed("too-large", "Junto's download exceeds this release's expected size. The machine has not changed");
      hash.update(chunk.value);
      let offset = 0;
      while (offset < chunk.value.length) {
        const wrote = await file.write(chunk.value, offset, chunk.value.length - offset, null);
        if (wrote.bytesWritten === 0) throw downloadFailed("save-failed", "Cannot save Junto's download. The machine has not changed");
        offset += wrote.bytesWritten;
      }
      input.observe(bytes);
    }
    if (bytes !== input.archive.archiveBytes || hash.digest("hex") !== input.archive.archiveSha256) {
      throw downloadFailed("check-failed", "Junto's download failed its check. Send Junto again. The machine has not changed");
    }
    await file.sync();
  } catch (cause) {
    if (signal.aborted) throw cancelled();
    if (cause instanceof MachineBundleDownloadFailed) throw cause;
    throw downloadFailed("interrupted", "Junto's download was interrupted. Send Junto again. The machine has not changed", cause);
  } finally {
    signal.removeEventListener("abort", abortReader);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
    await file.close();
  }
  await publishMachineArchive(input.cache, input.attempt, input.archive.target);
};

const waitForFlight = async (flight: Flight, signal: AbortSignal): Promise<void> => {
  signal.throwIfAborted();
  let abort!: () => void;
  const interrupted = new Promise<never>((_resolve, reject) => { abort = () => reject(cancelled()); signal.addEventListener("abort", abort, { once: true }); });
  try { await Promise.race([flight.promise, interrupted]); } finally { signal.removeEventListener("abort", abort); }
};

/** One download per admitted build/target. Each user still authenticates its own snapshot. */
export const makeReleaseMachineBundleAcquirer = (input: {
  readonly home: string;
  readonly build: string;
  readonly catalog: MachineReleaseCatalog;
  readonly fetch?: DownloadFetch;
  /** This machine's name for a failed download's encoded failure; the host name when a boot passes none. */
  readonly machine?: () => string;
}): MachineBundleAcquirer => {
  const machine = input.machine ?? defaultMachineName;
  const failure = (cause: unknown): MachineInstallError => new MachineInstallError({
    message: cause instanceof Error ? cause.message : "Cannot download Junto. The machine has not changed",
    disposition: "staged", retryable: true,
    ...(cause instanceof MachineBundleDownloadFailed || !(cause instanceof Error) ? { ownWords: true as const } : {}),
    ...failureHere(cause, machine()),
  });
  const catalog = decodeMachineReleaseCatalog(input.catalog);
  if (catalog.build !== input.build) throw downloadFailed("catalog-mismatch", "The machine download catalog does not match this Junto build");
  const failWithLog = (cause: unknown, targetName: string, archivePath?: string) => {
    const info = cause instanceof MachineBundleDownloadFailed ? cause : undefined;
    const path = info?.archivePath ?? archivePath;
    return Effect.logWarning(
      info?.check === "release-server" ? "machine bundle release-server download failed" : "machine bundle download failed",
      cause,
    ).pipe(
      Effect.annotateLogs({
        area: "machines",
        operation: "download",
        build: info?.build ?? catalog.build,
        target: info?.target ?? targetName,
        ...(path === undefined ? {} : { archivePath: path }),
        ...(info === undefined ? {} : { check: info.check }),
        ...(info?.status === undefined ? {} : { status: info.status }),
        ...(info?.host === undefined ? {} : { host: info.host }),
        ...(info?.redirectRefused === true ? { redirectRefused: true } : {}),
      }),
      Effect.andThen(Effect.fail(failure(cause))),
    );
  };
  return (target, onTransition) => Effect.gen(function* () {
    const archive = catalog.archives.find(entry => entry.target === target);
    if (archive === undefined) {
      return yield* failWithLog(
        downloadFailed("no-platform", "This Junto build has no download for that machine platform. The machine has not changed", undefined, {
          build: catalog.build,
          target,
        }),
        target,
      );
    }
    const failHere = (cause: unknown) => failWithLog(cause, archive.target, archive.archivePath);
    const cache = yield* Effect.acquireRelease(
      Effect.tryPromise({ try: () => acquireMachineBundleCache(input.home, catalog.build), catch: cause => cause }).pipe(Effect.catch(failHere)),
      handle => Effect.sync(() => releaseMachineBundleCache(handle)),
    );
    const attempt = yield* Effect.acquireRelease(
      Effect.tryPromise({ try: () => createMachineBundleAttempt(cache), catch: cause => cause }).pipe(Effect.catch(failHere)),
      // The attempt is private and retried fresh next send; a cleanup failure is logged, never the send's result.
      handle => Effect.tryPromise(() => discardMachineBundleAttempt(handle)).pipe(
        Effect.catch(cause => Effect.logWarning("a machine download attempt could not be removed", cause)),
        Effect.annotateLogs({ area: "machines", operation: "download-cleanup", target: archive.target })),
    );
    const clock = yield* Clock.Clock;
    let progress: ReturnType<typeof makeDownloadProgress> | undefined;
    const cached = yield* Effect.tryPromise({ try: () => snapshotCachedMachineArchive(cache, attempt, archive), catch: cause => cause }).pipe(
      Effect.catch(failHere),
      Effect.uninterruptible,
    );
    if (!cached) {
      yield* Effect.forkScoped(Effect.forever(Effect.sleep("1 second").pipe(
        Effect.andThen(Effect.sync(() => progress?.check(clock.currentTimeMillisUnsafe()))),
      )));
      const subscription = yield* Effect.acquireRelease(Effect.tryPromise({ try: async () => {
        const root = await machineBundleAttemptPath(attempt);
        // Attempts share a canonical cache parent; pins participate in the key.
        const key = `${dirname(root)}:${catalog.build}:${archive.target}:${archive.archiveSha256}`;
        let flight = flights.get(key);
        if (flight === undefined) {
          const controller = new AbortController(), observers = new Set<(bytes: number) => void>();
          const created: Flight = { controller, observers, bytes: 0, users: 0, promise: Promise.resolve() };
          created.promise = (async () => {
            const heldCache = await acquireMachineBundleCache(input.home, catalog.build);
            let heldAttempt: OwnedMachineBundleAttempt | undefined;
            try {
              heldAttempt = await createMachineBundleAttempt(heldCache);
              await download({ archive, catalog, cache: heldCache, attempt: heldAttempt, fetch: input.fetch ?? fetch, signal: controller.signal,
                observe: bytes => { created.bytes = bytes; for (const observe of observers) observe(bytes); },
              });
            } finally {
              try { if (heldAttempt !== undefined) await discardMachineBundleAttempt(heldAttempt); } finally { releaseMachineBundleCache(heldCache); }
            }
          })();
          flight = created;
          flights.set(key, flight);
          const selected = flight;
          void created.promise.finally(() => { if (flights.get(key) === selected) flights.delete(key); }).catch(() => undefined);
        }
        progress = makeDownloadProgress(archive.archiveBytes, clock.currentTimeMillisUnsafe(), event => onTransition?.(event));
        const observe = (bytes: number): void => progress?.advance(bytes, clock.currentTimeMillisUnsafe());
        flight.users++; flight.observers.add(observe); observe(flight.bytes);
        return { flight, observe };
      }, catch: cause => cause }).pipe(Effect.catch(failHere)), selected => Effect.promise(async () => {
        selected.flight.observers.delete(selected.observe);
        if (--selected.flight.users === 0) {
          selected.flight.controller.abort();
          await selected.flight.promise.catch(() => undefined);
        }
      }));
      yield* Effect.tryPromise({ try: signal => waitForFlight(subscription.flight, signal), catch: cause => cause }).pipe(Effect.catch(failHere));
      const published = yield* Effect.tryPromise({ try: () => snapshotCachedMachineArchive(cache, attempt, archive), catch: cause => cause }).pipe(
        Effect.catch(failHere),
        Effect.uninterruptible,
      );
      if (!published) {
        return yield* failHere(downloadFailed("disappeared", "Junto's verified download disappeared. Send again. The machine has not changed", undefined, {
          archivePath: archive.archivePath,
          build: catalog.build,
          target: archive.target,
        }));
      }
    }
    const bundle = yield* Effect.tryPromise({ try: () => unpackMachineReleaseArchive(attempt, archive, catalog), catch: cause => cause }).pipe(
      Effect.catch(failHere),
      Effect.uninterruptible,
    );
    yield* Effect.sync(() => progress?.finish(clock.currentTimeMillisUnsafe()));
    yield* Effect.tryPromise({ try: () => pruneMachineBundleCache(cache), catch: cause => cause }).pipe(Effect.catch(failHere));
    return bundle;
  });
};

/** Compiled release pins select downloading; source and Preview have local files only. */
export const makeMachineBundleSources = (input: {
  readonly home: string;
  readonly build: string;
  readonly catalog: MachineReleaseCatalog | undefined;
  readonly localRoot: () => string;
  readonly machine?: () => string;
}): { readonly bundles: Readonly<Partial<Record<"darwin-arm64" | "linux-x64", string>>>; readonly acquireBundle?: MachineBundleAcquirer } => {
  if (input.catalog !== undefined) return { bundles: {}, acquireBundle: makeReleaseMachineBundleAcquirer({ ...input, catalog: input.catalog }) };
  const root = input.localRoot();
  return { bundles: Object.fromEntries(["darwin-arm64", "linux-x64"].flatMap(target => {
    const path = join(root, target);
    return existsSync(join(path, "manifest.json")) ? [[target, path]] : [];
  })) };
};
