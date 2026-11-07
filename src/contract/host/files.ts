/**
 * The shell the core's Files service asks main for: Trash, Open and Reveal
 * are Electron's (`src/app/core-process/main-side/files.ts`), the service
 * that wants them is the core's (`src/core/ops/files.ts`).
 *
 * `OpenPath` answers "" on success, else the reason, as `shell.openPath` does.
 * A Trash or Reveal the shell refuses fails with `FilesShellRefused`.
 */
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";

/** The shell refused the path; the message is its own. */
export class FilesShellRefused extends Schema.TaggedError<FilesShellRefused>()("FilesShellRefused", {
  message: Schema.String,
}) {}

const Absolute = { absolute: Schema.String };

export const FilesHostRpcs = RpcGroup.make(
  Rpc.make("FilesShellTrash", { payload: Absolute, success: Schema.Void, error: FilesShellRefused }),
  Rpc.make("FilesShellOpenPath", { payload: Absolute, success: Schema.String }),
  Rpc.make("FilesShellReveal", { payload: Absolute, success: Schema.Void, error: FilesShellRefused }),
).annotate(Rpc.ParseOptions, { onExcessProperty: "error" });
