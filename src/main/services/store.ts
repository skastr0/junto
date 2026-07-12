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

const readStore = async (): Promise<Record<string, unknown>> => {
  try {
    return JSON.parse(await readFile(storePath(), "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
};

const writeStore = async (data: Record<string, unknown>) => {
  await mkdir(dirname(storePath()), { recursive: true });
  await writeFile(storePath(), `${JSON.stringify(data, null, 2)}\n`, "utf8");
};

export const StoreLive = Layer.succeed(
  StoreService,
  StoreService.of({
    doctor: Effect.succeed({
      id: "store",
      label: "Local Store",
      status: "ok",
      detail: storePath(),
    }),
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
