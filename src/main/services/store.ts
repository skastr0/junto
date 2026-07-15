import { mkdir, readFile, writeFile } from "node:fs/promises";
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
  await mkdir(dirname(storePath()), { recursive: true });
  await writeFile(storePath(), `${JSON.stringify(data, null, 2)}\n`, "utf8");
};

export const StoreLive = Layer.succeed(
  StoreService,
  StoreService.of({
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
        try: async () => (await readStore())[key] as T | undefined,
        catch: (error) =>
          new StoreError({
            message: error instanceof Error ? error.message : String(error),
          }),
      }),
    set: <T>(key: string, value: T) =>
      Effect.tryPromise({
        try: async () => {
          const current = await readStore();
          current[key] = value;
          await writeStore(current);
        },
        catch: (error) =>
          new StoreError({
            message: error instanceof Error ? error.message : String(error),
          }),
      }),
  }),
);
