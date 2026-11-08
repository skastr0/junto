/**
 * Main's side of the Files shell group (`contract/host/files.ts`): Trash,
 * Open and Reveal are Electron's `shell`, and the Files service that asks for
 * them runs in the core (`core/ops/files.ts`).
 */
import { Context, Effect } from "effect";
import { FilesHostRpcs, FilesShellRefused } from "../../../contract/host/files";

/** What main uses of Electron's `shell` here, or a test's. */
export type FilesShellShape = {
  readonly trashItem: (absolute: string) => Promise<void>;
  /** Answers "" on success, else the reason. */
  readonly openPath: (absolute: string) => Promise<string>;
  readonly showItemInFolder: (absolute: string) => void;
};

export class FilesShell extends Context.Service<FilesShell, FilesShellShape>()("@junto/app/FilesShell") {}

const refused = (cause: unknown): FilesShellRefused =>
  new FilesShellRefused({ message: cause instanceof Error ? cause.message : String(cause) });

export const FilesHostHandlers = FilesHostRpcs.toLayer(
  Effect.gen(function* () {
    const shell = yield* FilesShell;
    return {
      FilesShellTrash: ({ absolute }) => Effect.tryPromise({ try: () => shell.trashItem(absolute), catch: refused }),
      FilesShellOpenPath: ({ absolute }) => Effect.promise(() => shell.openPath(absolute)),
      FilesShellReveal: ({ absolute }) => Effect.try({ try: () => shell.showItemInFolder(absolute), catch: refused }),
    };
  }),
);
