import { createHash } from "node:crypto";
import { constants, existsSync } from "node:fs";
import { open } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Clock, Effect, Scope } from "effect";
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
const failure = (cause: unknown): MachineInstallError => new MachineInstallError({
  message: cause instanceof Error ? cause.message : "Cannot download Junto. The machine has not changed",
  disposition: "staged", retryable: true,
});
const cancelled = (): Error => new Error("Junto's download was interrupted. The machine has not changed");

const download = async (input: {
  readonly archive: MachineReleaseArchive;
  readonly catalog: MachineReleaseCatalog;
  readonly cache: OwnedMachineBundleCache;
  readonly attempt: OwnedMachineBundleAttempt;
  readonly fetch: DownloadFetch;
  readonly signal: AbortSignal;
  readonly observe: (bytes: number) => void;
}): Promise<void> => {
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(10 * 60_000)]);
  let response: Response;
  try {
    response = await input.fetch(new URL(input.archive.archivePath, input.catalog.origin), {
      redirect: "error", signal, credentials: "omit", headers: { "Accept-Encoding": "identity" },
    });
  } catch (cause) {
    throw new Error(input.signal.aborted ? cancelled().message : "Cannot download Junto. Check your internet connection and send again. The machine has not changed", { cause });
  }
  if (!response.ok || response.redirected || !response.body) {
    await response.body?.cancel();
    throw new Error("Cannot download this Junto build from its release server. The machine has not changed");
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
      if (bytes > input.archive.archiveBytes) throw new Error("Junto's download exceeds this release's expected size. The machine has not changed");
      hash.update(chunk.value);
      let offset = 0;
      while (offset < chunk.value.length) {
        const wrote = await file.write(chunk.value, offset, chunk.value.length - offset, null);
        if (wrote.bytesWritten === 0) throw new Error("Cannot save Junto's download. The machine has not changed");
        offset += wrote.bytesWritten;
      }
      input.observe(bytes);
    }
    if (bytes !== input.archive.archiveBytes || hash.digest("hex") !== input.archive.archiveSha256) {
      throw new Error("Junto's download failed its check. Send Junto again. The machine has not changed");
    }
    await file.sync();
  } catch (cause) {
    if (signal.aborted) throw cancelled();
    if (cause instanceof Error && cause.message.includes("The machine has not changed")) throw cause;
    throw new Error("Junto's download was interrupted. Send Junto again. The machine has not changed", { cause });
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
}): MachineBundleAcquirer => {
  const catalog = decodeMachineReleaseCatalog(input.catalog);
  if (catalog.build !== input.build) throw new Error("The machine download catalog does not match this Junto build");
  return (target, onTransition) => Effect.gen(function* () {
    const archive = catalog.archives.find(entry => entry.target === target);
    if (archive === undefined) return yield* Effect.fail(failure(new Error("This Junto build has no download for that machine platform. The machine has not changed")));
    const cache = yield* Effect.acquireRelease(
      Effect.tryPromise({ try: () => acquireMachineBundleCache(input.home, catalog.build), catch: failure }),
      handle => Effect.sync(() => releaseMachineBundleCache(handle)),
    );
    const attempt = yield* Effect.acquireRelease(
      Effect.tryPromise({ try: () => createMachineBundleAttempt(cache), catch: failure }),
      handle => Effect.tryPromise({ try: () => discardMachineBundleAttempt(handle), catch: failure }).pipe(Effect.ignore),
    );
    const clock = yield* Clock.Clock;
    let progress: ReturnType<typeof makeDownloadProgress> | undefined;
    const cached = yield* Effect.tryPromise({ try: () => snapshotCachedMachineArchive(cache, attempt, archive), catch: failure }).pipe(Effect.uninterruptible);
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
      }, catch: failure }), selected => Effect.promise(async () => {
        selected.flight.observers.delete(selected.observe);
        if (--selected.flight.users === 0) {
          selected.flight.controller.abort();
          await selected.flight.promise.catch(() => undefined);
        }
      }));
      yield* Effect.tryPromise({ try: signal => waitForFlight(subscription.flight, signal), catch: failure });
      const published = yield* Effect.tryPromise({ try: () => snapshotCachedMachineArchive(cache, attempt, archive), catch: failure }).pipe(Effect.uninterruptible);
      if (!published) return yield* Effect.fail(failure(new Error("Junto's verified download disappeared. Send again. The machine has not changed")));
    }
    const bundle = yield* Effect.tryPromise({ try: () => unpackMachineReleaseArchive(attempt, archive, catalog), catch: failure }).pipe(Effect.uninterruptible);
    yield* Effect.sync(() => progress?.finish(clock.currentTimeMillisUnsafe()));
    yield* Effect.tryPromise({ try: () => pruneMachineBundleCache(cache), catch: failure });
    return bundle;
  });
};

/** Compiled release pins select downloading; source and Preview have local files only. */
export const makeMachineBundleSources = (input: {
  readonly home: string;
  readonly build: string;
  readonly catalog: MachineReleaseCatalog | undefined;
  readonly localRoot: () => string;
}): { readonly bundles: Readonly<Partial<Record<"darwin-arm64" | "linux-x64", string>>>; readonly acquireBundle?: MachineBundleAcquirer } => {
  if (input.catalog !== undefined) return { bundles: {}, acquireBundle: makeReleaseMachineBundleAcquirer({ ...input, catalog: input.catalog }) };
  const root = input.localRoot();
  return { bundles: Object.fromEntries(["darwin-arm64", "linux-x64"].flatMap(target => {
    const path = join(root, target);
    return existsSync(join(path, "manifest.json")) ? [[target, path]] : [];
  })) };
};
