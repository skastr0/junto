/**
 * Apply DesiredFile[] to the local filesystem.
 *
 * - Creates parent directories
 * - Writes with optional mode
 * - Idempotent: skip when on-disk content hash matches desired
 * - Path safety via admitDesiredTargetPath
 */

import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { dirname } from "node:path";
import { Effect, Schema } from "effect";
import type { ApplyOperation, ApplyReceipt, DesiredFile } from "./desired";
import { admitDesiredTargetPath, contentHash, PathSafetyError } from "./paths";

export class LocalApplyError extends Schema.TaggedError<LocalApplyError>()("LocalApplyError", {
  path: Schema.String,
  message: Schema.String,
}) {}

export type LocalApplyErrorUnion = LocalApplyError | PathSafetyError;

export type ApplyLocalOptions = {
  readonly files: ReadonlyArray<DesiredFile>;
  /** When set, all writes must resolve under this root. */
  readonly root?: string;
};

const DEFAULT_FILE_MODE = 0o644;

const readIfPresent = (
  path: string,
): Effect.Effect<string | null, LocalApplyError> =>
  Effect.tryPromise({
    try: async () => {
      try {
        return await readFile(path, "utf8");
      } catch (error) {
        const code =
          error && typeof error === "object" && "code" in error
            ? String((error as { code: unknown }).code)
            : "";
        if (code === "ENOENT") return null;
        throw error;
      }
    },
    catch: (cause) =>
      new LocalApplyError({
        path,
        message: cause instanceof Error ? cause.message : String(cause),
      }),
  });

const applyOne = (
  file: DesiredFile,
  root: string | undefined,
): Effect.Effect<ApplyOperation, LocalApplyErrorUnion> =>
  Effect.gen(function* () {
    const path = yield* admitDesiredTargetPath(file.targetPath, { root });
    const desiredHash = contentHash(file.content);
    const onDisk = yield* readIfPresent(path);

    if (onDisk !== null && contentHash(onDisk) === desiredHash) {
      return { type: "skip" as const, path, reason: "unchanged" };
    }

    yield* Effect.tryPromise({
      try: async () => {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, file.content, "utf8");
        await chmod(path, file.mode ?? DEFAULT_FILE_MODE);
      },
      catch: (cause) =>
        new LocalApplyError({
          path,
          message: cause instanceof Error ? cause.message : String(cause),
        }),
    });

    return {
      type: "write" as const,
      path,
      reason: onDisk === null ? "created" : "updated",
    };
  });

export const applyDesiredFilesLocal = (
  options: ApplyLocalOptions,
): Effect.Effect<ApplyReceipt, LocalApplyErrorUnion> =>
  Effect.gen(function* () {
    const operations: ApplyOperation[] = [];
    let applied = 0;
    let skipped = 0;

    for (const file of options.files) {
      const op = yield* applyOne(file, options.root);
      operations.push(op);
      if (op.type === "write") applied += 1;
      else skipped += 1;
    }

    return { operations, applied, skipped } satisfies ApplyReceipt;
  });
