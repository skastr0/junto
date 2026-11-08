/**
 * This machine's harness config, read and written one declared key at a time
 * by this machine's own Junto (docs/machines.md, Harness inventory: native
 * config). Every machine's core runs one; another machine reaches it over
 * the link, never by touching these files itself.
 *
 * A write is admitted against the native catalogue and this machine's
 * installed version before any file is read. It changes only the named key,
 * keeps the rest of the file, backs the file up beside itself, replaces it in
 * one step with its mode kept, and answers the value read back. A file that
 * changed since this machine last read it answers a conflict and is left
 * alone.
 */
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rename, stat, writeFile, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Context, Effect, Layer, Result, Semaphore } from "effect";
import type { HarnessId } from "@shared/managed-terminal-templates";
import { NATIVE_SETTINGS } from "@shared/harness-domain/native-catalogue";
import {
  checkNativeSetting,
  type NativeSettingRefusedError,
  type NativeSettingSpec,
  type NativeSettingWrite,
} from "@shared/harness-domain/native-config";
import { NativeConfigWriteError } from "@shared/harness-domain/native-config-write";
import type { InventoryUnavailableError } from "@shared/harness-domain/inventory";
import { HarnessInventory } from "../term/templates/harness-inventory";
import { readConfigKey, writeConfigKey, type ScalarValue } from "./edit";

export type NativeSettingsRead = Readonly<Record<string, ScalarValue>>;

export class NativeConfig extends Context.Service<NativeConfig, {
  /** The declared keys' current values; a key absent from the file is absent here. */
  readonly read: (
    harness: HarnessId,
    keys: readonly string[],
  ) => Effect.Effect<NativeSettingsRead, NativeConfigWriteError | InventoryUnavailableError>;
  readonly write: (
    write: NativeSettingWrite,
  ) => Effect.Effect<ScalarValue, NativeSettingRefusedError | NativeConfigWriteError | InventoryUnavailableError>;
}>()("@junto/NativeConfig") {}

const digest = (text: string | undefined): string =>
  text === undefined ? "absent" : createHash("sha256").update(text).digest("hex");

const readText = (path: string): Promise<string | undefined> =>
  readFile(path, "utf8").catch((cause: NodeJS.ErrnoException) => {
    if (cause.code === "ENOENT") return undefined;
    throw cause;
  });

export const makeNativeConfig = (options: {
  readonly home: string;
  readonly catalogue?: readonly NativeSettingSpec[];
}) => Effect.gen(function* () {
  const inventory = yield* HarnessInventory;
  const catalogue = options.catalogue ?? NATIVE_SETTINGS;
  // What this machine last read of each file; a write against anything else is a conflict.
  const lastRead = new Map<string, string>();
  const writePermit = yield* Semaphore.make(1);

  const failure = (
    machine: string,
    harness: string,
    key: string,
    reason: NativeConfigWriteError["reason"],
    message: string,
  ) => new NativeConfigWriteError({ machine, harness, key, reason, message });

  const machineName = inventory.machine.pipe(Effect.map((snapshot) => snapshot.machine));

  const read = Effect.fn("NativeConfig.read")(function* (harness: HarnessId, keys: readonly string[]) {
    const machine = yield* machineName;
    const specs = catalogue.filter((spec) => spec.harness === harness && keys.includes(spec.key));
    const values: Record<string, ScalarValue> = {};
    for (const file of new Set(specs.map((spec) => spec.file))) {
      const path = join(options.home, file);
      const text = yield* Effect.tryPromise({
        try: () => readText(path),
        catch: (cause) => failure(machine, harness, file, "io", `Could not read ${file}: ${String(cause)}`),
      });
      lastRead.set(path, digest(text));
      for (const spec of specs.filter((entry) => entry.file === file)) {
        const outcome = readConfigKey(file, text ?? "", spec.key);
        if (!outcome.ok) return yield* Effect.fail(failure(machine, harness, spec.key, "unsupported", outcome.message));
        if (outcome.value !== undefined) values[spec.key] = outcome.value;
      }
    }
    return values;
  });

  const write = Effect.fn("NativeConfig.write")(function* (request: NativeSettingWrite) {
    const snapshot = yield* inventory.machine;
    const installed = snapshot.harnesses.find((row) => row.harness === request.harness);
    const spec = yield* Result.match(checkNativeSetting(catalogue, request, installed?.version), {
      onSuccess: Effect.succeed,
      onFailure: Effect.fail,
    });
    const machine = snapshot.machine;
    const path = join(options.home, spec.file);
    const fail = (reason: NativeConfigWriteError["reason"], message: string) =>
      Effect.fail(failure(machine, request.harness, request.key, reason, message));

    return yield* writePermit.withPermits(1)(Effect.gen(function* () {
      const text = yield* Effect.tryPromise({
        try: () => readText(path),
        catch: (cause) => failure(machine, request.harness, request.key, "io", `Could not read ${spec.file}: ${String(cause)}`),
      });
      const seen = lastRead.get(path);
      if (seen === undefined || seen !== digest(text)) {
        return yield* fail("conflict", `${spec.file} changed since this machine last read it; read it again first`);
      }
      const edited = writeConfigKey(spec.file, text ?? "", spec.key, request.value);
      if (!edited.ok) return yield* fail("unsupported", edited.message);

      yield* Effect.tryPromise({
        try: async () => {
          await mkdir(dirname(path), { recursive: true });
          const mode = text === undefined ? 0o600 : (await stat(path)).mode & 0o777;
          if (text !== undefined) {
            await copyFile(path, `${path}.junto-backup`);
            await chmod(`${path}.junto-backup`, mode);
          }
          const temp = `${path}.${process.pid}.junto-tmp`;
          await writeFile(temp, edited.text, { encoding: "utf8", mode });
          await rename(temp, path);
        },
        catch: (cause) => failure(machine, request.harness, request.key, "io", `Could not write ${spec.file}: ${String(cause)}`),
      });

      const after = yield* Effect.tryPromise({
        try: () => readText(path),
        catch: (cause) => failure(machine, request.harness, request.key, "io", `Could not read ${spec.file} back: ${String(cause)}`),
      });
      lastRead.set(path, digest(after));
      const readBack = readConfigKey(spec.file, after ?? "", spec.key);
      if (!readBack.ok || readBack.value === undefined) {
        return yield* fail("io", `${spec.key} did not read back after the write`);
      }
      return readBack.value;
    }));
  });

  return NativeConfig.of({ read, write });
});

export const NativeConfigLive = Layer.effect(NativeConfig, makeNativeConfig({ home: homedir() }));
