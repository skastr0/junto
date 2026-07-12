import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { Context, Effect, Layer, Schema } from "effect";
import type { DirectoryEntry, ServiceCheck } from "@shared/contracts";

export class FolderError extends Schema.TaggedError<FolderError>()("FolderError", {
  message: Schema.String,
}) {}

export class FolderService extends Context.Tag("@chassis/FolderService")<
  FolderService,
  {
    readonly doctor: Effect.Effect<ServiceCheck>;
    readonly readDirectory: (path: string) => Effect.Effect<ReadonlyArray<DirectoryEntry>, FolderError>;
  }
>() {}

export const FolderLive = Layer.succeed(
  FolderService,
  FolderService.of({
    doctor: Effect.succeed({
      id: "folder",
      label: "Folder Service",
      status: "ok",
      detail: "filesystem reader is ready",
    }),
    readDirectory: (path) =>
      Effect.tryPromise({
        try: async () => {
          const names = await readdir(path);
          const entries = await Promise.all(
            names.slice(0, 400).map(async (name): Promise<DirectoryEntry | null> => {
              const entryPath = join(path, name);
              try {
                const info = await stat(entryPath);
                return {
                  name,
                  path: entryPath,
                  kind: info.isDirectory() ? "directory" : "file",
                  size: info.size,
                  modifiedAt: info.mtime.toISOString(),
                };
              } catch {
                return null;
              }
            }),
          );

          return entries
            .filter((entry): entry is DirectoryEntry => entry !== null)
            .sort((a, b) =>
              a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "directory" ? -1 : 1,
            );
        },
        catch: (error) =>
          new FolderError({
            message: error instanceof Error ? error.message : String(error),
          }),
      }),
  }),
);
