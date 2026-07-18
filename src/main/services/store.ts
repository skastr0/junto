import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { app } from "electron";
import { Context, Effect, Layer, Schema } from "effect";
import type { ServiceCheck } from "@shared/contracts";

export class StoreError extends Schema.TaggedError<StoreError>()("StoreError", {
  message: Schema.String,
}) {}

export class StoreService extends Context.Tag("@chassis/StoreService")<
  StoreService,
  {
    readonly doctor: Effect.Effect<ServiceCheck>;
    readonly get: <T>(key: string) => Effect.Effect<T | undefined, StoreError>;
    readonly set: <T>(key: string, value: T) => Effect.Effect<void, StoreError>;
  }
>() {}

const storePath = () => join(app.getPath("userData"), "store.json");
let temporarySequence = 0;

// A missing store is a legitimate empty store; an unreadable or corrupt one
// is NOT — treating it as empty would silently reset every operator-set
// durable state (e.g. kernel arming), which the durable-intent invariant
// forbids. Corruption fails loudly through StoreError, and because set()
// reads before writing, a corrupt file can never be clobbered by a write.
const readStore = async (): Promise<Record<string, unknown>> => {
  let raw: string;
  try {
    raw = await readFile(storePath(), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (error) {
    throw new Error(
      `store.json unreadable at ${storePath()} — refusing to treat as empty (${
        error instanceof Error ? error.message : String(error)
      })`,
    );
  }
};

const writeStore = async (data: Record<string, unknown>) => {
  const path = storePath();
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${temporarySequence++}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
};

const makeStoreService = (): Context.Tag.Service<typeof StoreService> => {
  // StoreService has one writer in the Electron main process. Keep the whole
  // read-modify-atomic-replace transaction on one promise chain so unrelated
  // keys cannot last-writer-clobber each other. A rejected write is consumed
  // only by the chain itself; the caller still receives StoreError and later
  // writes remain able to repair a transient failure.
  let writeChain: Promise<unknown> = Promise.resolve();

  const withWriteLock = <A>(write: () => Promise<A>): Promise<A> => {
    const run = writeChain.then(write, write);
    writeChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  const readAfterWrites = async (): Promise<Record<string, unknown>> => {
    await writeChain;
    return readStore();
  };

  return StoreService.of({
    // Effect.sync (not Effect.succeed) — storePath() touches Electron's
    // `app`, which must stay unevaluated until this Effect actually runs.
    // StoreLive itself (Layer.succeed) is built eagerly at module-import
    // time, so an Effect.succeed here would call app.getPath() the instant
    // anything imports runtime.ts (e.g. a test importing an adapter that
    // now reaches AppRuntime) — before Electron's `app` is ready, or under
    // vitest where it never will be.
    doctor: Effect.sync(() => ({
      id: "store",
      label: "Local Store",
      status: "ok" as const,
      detail: storePath(),
    })),
    get: <T>(key: string) =>
      Effect.tryPromise({
        try: async () => (await readAfterWrites())[key] as T | undefined,
        catch: (error) =>
          new StoreError({
            message: error instanceof Error ? error.message : String(error),
          }),
      }),
    set: <T>(key: string, value: T) =>
      Effect.tryPromise({
        try: () => withWriteLock(async () => {
          const current = await readStore();
          current[key] = value;
          await writeStore(current);
        }),
        catch: (error) =>
          new StoreError({
            message: error instanceof Error ? error.message : String(error),
          }),
      }),
  });
};

export const StoreLive = Layer.succeed(StoreService, makeStoreService());
